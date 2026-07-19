import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { assertCleanReleaseSource } from '../scripts/assert-clean-release-source.mjs';
import {
  assertDeploymentSnapshot,
  assertManifestSourceGates,
  assertOntologyReleaseDeploymentGate,
  deployWorker,
  parseArgs,
  validateOntologyPreviewAcceptanceReceipt,
  wranglerDeployArgs,
} from '../scripts/deploy-worker.mjs';

const projectRoot = new URL('../', import.meta.url);

function fakeGit(outputs) {
  return (_command, arguments_) => {
    const key = arguments_.join(' ');
    const value = outputs[key];
    if (value instanceof Error) return { status: 1, stdout: '', stderr: value.message };
    return { status: 0, stdout: `${value ?? ''}\n`, stderr: '' };
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function acceptedPreviewReceipt({
  gitHead = 'a'.repeat(40),
  ontologyManifestSha256 = 'b'.repeat(64),
  status = 'accepted',
} = {}) {
  const body = {
    $schema: './ontology-preview-acceptance-receipt.schema.json',
    schema_version: 1,
    receipt_id: 'ontology-preview-acceptance:fixture-v1',
    policy: 'immutable_preview_ontology_acceptance_v1',
    source: {
      git_head: gitHead,
      ontology_manifest: {
        path: 'data/ontology-release-manifest.json',
        sha256: ontologyManifestSha256,
      },
    },
    preview: {
      worker_name: 'bdfz-curriculum-atlas-preview',
      environment: 'preview',
      deployment_id: '11111111-1111-4111-8111-111111111111',
      version_id: '22222222-2222-4222-8222-222222222222',
    },
    acceptance: {
      status,
      accepted_by: 'fixture-reviewer',
      accepted_at: '2026-07-18T20:00:00.000Z',
    },
  };
  return {
    ...body,
    receipt_sha256: createHash('sha256').update(stableStringify(body)).digest('hex'),
  };
}

function deploymentFixture({
  environment = 'production',
  ontologyPromotion = false,
  initialHead = 'a'.repeat(40),
  manifestHead = initialHead,
  manifestDirty = false,
  finalHead = initialHead,
  ontologyManifestSha256 = 'b'.repeat(64),
  receipt = null,
} = {}) {
  const sourceSnapshots = [
    { head: initialHead, upstream: initialHead, clean: true },
    { head: finalHead, upstream: finalHead, clean: true },
  ];
  let sourceIndex = 0;
  let wranglerCalls = 0;
  return {
    options: {
      environment,
      ontologyPromotion,
      root: '.',
      previewAcceptanceReceipt: receipt ? 'fixture-receipt.json' : null,
      inspectReleaseSource: () => sourceSnapshots[sourceIndex++],
      validateOntology: async () => ({
        valid: true,
        publishable: ontologyPromotion,
        errors: [],
        manifest_path: 'data/ontology-release-manifest.json',
        manifest_sha256: ontologyManifestSha256,
      }),
      buildManifest: async () => ({
        git: { head: manifestHead, dirty: manifestDirty },
        release_blockers: manifestDirty
          ? [{ environment: 'source', code: 'dirty_git_tree' }]
          : [],
        source_tree: {
          files: [{
            path: 'data/ontology-release-manifest.json',
            sha256: ontologyManifestSha256,
          }],
        },
      }),
      readPreviewAcceptanceReceipt: async () => receipt,
      runCommand: (command) => {
        if (command === 'npx') wranglerCalls += 1;
        return { status: 0, stdout: '', stderr: '' };
      },
    },
    wranglerCalls: () => wranglerCalls,
  };
}

test('clean release source requires exact HEAD, empty status, and optional exact upstream', () => {
  const head = 'a'.repeat(40);
  const clean = assertCleanReleaseSource({
    root: '.',
    requireUpstream: true,
    runCommand: fakeGit({
      'rev-parse HEAD': head,
      'status --porcelain=v1 --untracked-files=all': '',
      'rev-parse @{upstream}': head,
    }),
  });
  assert.deepEqual(clean, { head, upstream: head, clean: true });
  assert.throws(() => assertCleanReleaseSource({
    root: '.',
    runCommand: fakeGit({
      'rev-parse HEAD': head,
      'status --porcelain=v1 --untracked-files=all': ' M src/index.ts',
    }),
  }), /release source is dirty/);
  assert.throws(() => assertCleanReleaseSource({
    root: '.',
    requireUpstream: true,
    runCommand: fakeGit({
      'rev-parse HEAD': head,
      'status --porcelain=v1 --untracked-files=all': '',
      'rev-parse @{upstream}': 'b'.repeat(40),
    }),
  }), /not exactly pushed/);
});

test('Worker deploy wrapper injects Git provenance and refuses source blockers', () => {
  const head = 'a'.repeat(40);
  assert.deepEqual(wranglerDeployArgs('preview', head), [
    '--no-install', 'wrangler', 'deploy', '--env', 'preview', '--keep-vars', '--var', `RELEASE_GIT_COMMIT:${head}`,
  ]);
  assert.deepEqual(wranglerDeployArgs('production', head), [
    '--no-install', 'wrangler', 'deploy', '--keep-vars', '--var', `RELEASE_GIT_COMMIT:${head}`,
  ]);
  assert.throws(() => assertManifestSourceGates({
    release_blockers: [{ environment: 'source', code: 'downloads_audit_stale' }],
  }), /downloads_audit_stale/);
  assert.equal(assertManifestSourceGates({ release_blockers: [] }), true);
});

test('deployment snapshot gate binds manifest and final source to the initial clean upstream HEAD', () => {
  const head = 'a'.repeat(40);
  const ontologyManifestSha256 = 'b'.repeat(64);
  const manifest = {
    git: { head, dirty: false },
    source_tree: {
      files: [{ path: 'data/ontology-release-manifest.json', sha256: ontologyManifestSha256 }],
    },
  };
  const ontology = {
    manifest_path: 'data/ontology-release-manifest.json',
    manifest_sha256: ontologyManifestSha256,
  };
  assert.equal(assertDeploymentSnapshot({
    initialGit: { head, upstream: head, clean: true },
    manifest,
    ontologyReport: ontology,
    finalGit: { head, upstream: head, clean: true },
  }), true);
  assert.throws(() => assertDeploymentSnapshot({
    initialGit: { head, upstream: head, clean: true },
    manifest: { ...manifest, git: { head: 'c'.repeat(40), dirty: false } },
    ontologyReport: ontology,
    finalGit: { head, upstream: head, clean: true },
  }), /release manifest Git HEAD.*initial deployment HEAD/);
  assert.throws(() => assertDeploymentSnapshot({
    initialGit: { head, upstream: head, clean: true },
    manifest: { ...manifest, git: { head, dirty: true } },
    ontologyReport: ontology,
    finalGit: { head, upstream: head, clean: true },
  }), /release manifest reports a dirty source/);
  assert.throws(() => assertDeploymentSnapshot({
    initialGit: { head, upstream: head, clean: true },
    manifest,
    ontologyReport: ontology,
    finalGit: { head: 'd'.repeat(40), upstream: 'd'.repeat(40), clean: true },
  }), /final release source HEAD.*initial deployment HEAD/);
  assert.throws(() => assertDeploymentSnapshot({
    initialGit: { head, upstream: head, clean: true },
    manifest,
    ontologyReport: { ...ontology, manifest_sha256: 'e'.repeat(64) },
    finalGit: { head, upstream: head, clean: true },
  }), /ontology validation bytes.*release manifest source tree/);
});

test('deployWorker refuses mixed initial, ontology, manifest, and final snapshots before Wrangler', async () => {
  for (const fixture of [
    deploymentFixture({ manifestHead: 'c'.repeat(40) }),
    deploymentFixture({ manifestDirty: true }),
    deploymentFixture({ finalHead: 'd'.repeat(40) }),
  ]) {
    await assert.rejects(() => deployWorker(fixture.options), /deployment snapshot|release manifest|final release source/);
    assert.equal(fixture.wranglerCalls(), 0);
  }
});

test('immutable preview acceptance receipt is exact-source, exact-preview, and accepted-status bound', async () => {
  const expected = { gitHead: 'a'.repeat(40), ontologyManifestSha256: 'b'.repeat(64) };
  const accepted = acceptedPreviewReceipt();
  assert.equal(validateOntologyPreviewAcceptanceReceipt(accepted, expected).acceptance.status, 'accepted');
  const fixture = JSON.parse(await readFile(
    new URL('tests/fixtures/ontology-preview-acceptance/accepted.json', projectRoot),
    'utf8',
  ));
  assert.deepEqual(validateOntologyPreviewAcceptanceReceipt(fixture, expected), accepted);
  assert.throws(
    () => validateOntologyPreviewAcceptanceReceipt(acceptedPreviewReceipt({ gitHead: 'c'.repeat(40) }), expected),
    /Git HEAD/,
  );
  assert.throws(
    () => validateOntologyPreviewAcceptanceReceipt(
      acceptedPreviewReceipt({ ontologyManifestSha256: 'd'.repeat(64) }),
      expected,
    ),
    /ontology manifest SHA/,
  );
  assert.throws(
    () => validateOntologyPreviewAcceptanceReceipt(acceptedPreviewReceipt({ status: 'rejected' }), expected),
    /acceptance status must be accepted/,
  );
  const missingVersion = structuredClone(accepted);
  missingVersion.preview.version_id = '';
  assert.throws(
    () => validateOntologyPreviewAcceptanceReceipt(missingVersion, expected),
    /preview version_id/,
  );
  const forged = structuredClone(accepted);
  forged.preview.deployment_id = '33333333-3333-4333-8333-333333333333';
  assert.throws(
    () => validateOntologyPreviewAcceptanceReceipt(forged, expected),
    /receipt SHA-256/,
  );
});

test('preview receipt gates only production ontology promotion', async () => {
  const ordinary = deploymentFixture();
  await deployWorker(ordinary.options);
  assert.equal(ordinary.wranglerCalls(), 1);

  const previewPromotion = deploymentFixture({ environment: 'preview', ontologyPromotion: true });
  await deployWorker(previewPromotion.options);
  assert.equal(previewPromotion.wranglerCalls(), 1);

  const missingReceipt = deploymentFixture({ ontologyPromotion: true });
  await assert.rejects(() => deployWorker(missingReceipt.options), /preview acceptance receipt is required/);
  assert.equal(missingReceipt.wranglerCalls(), 0);

  const acceptedReceipt = acceptedPreviewReceipt();
  const productionPromotion = deploymentFixture({ ontologyPromotion: true, receipt: acceptedReceipt });
  await deployWorker(productionPromotion.options);
  assert.equal(productionPromotion.wranglerCalls(), 1);
});

test('ordinary deploy validates only a closed bridge while ontology promotion requires publishable review', () => {
  const closed = { valid: true, publishable: false, errors: [] };
  const publishable = { valid: true, publishable: true, errors: [] };
  const invalid = { valid: false, publishable: false, errors: ['synthetic invalid bridge'] };

  assert.equal(assertOntologyReleaseDeploymentGate(closed), true);
  assert.throws(
    () => assertOntologyReleaseDeploymentGate(closed, { ontologyPromotion: true }),
    /valid but not publishable/,
  );
  assert.throws(() => assertOntologyReleaseDeploymentGate(invalid), /synthetic invalid bridge/);
  assert.throws(
    () => assertOntologyReleaseDeploymentGate(publishable),
    /dedicated ontology-promotion transaction/,
  );
  assert.equal(assertOntologyReleaseDeploymentGate(publishable, { ontologyPromotion: true }), true);
});

test('deploy CLI exposes exactly two audited modes and cannot bypass the bridge gate', async () => {
  assert.deepEqual(parseArgs(['--environment', 'preview']), {
    environment: 'preview',
    ontologyPromotion: false,
    previewAcceptanceReceipt: null,
  });
  assert.deepEqual(parseArgs(['--environment', 'production', '--ontology-promotion']), {
    environment: 'production',
    ontologyPromotion: true,
    previewAcceptanceReceipt: null,
  });
  assert.deepEqual(parseArgs([
    '--environment', 'production', '--ontology-promotion',
    '--preview-acceptance-receipt', '/private/tmp/ontology-preview-acceptance.json',
  ]), {
    environment: 'production',
    ontologyPromotion: true,
    previewAcceptanceReceipt: '/private/tmp/ontology-preview-acceptance.json',
  });
  assert.throws(() => parseArgs(['--environment', 'production', '--skip-ontology-gate']), /usage/);
  assert.throws(() => parseArgs(['--ontology-promotion', '--environment', 'production']), /usage/);

  const source = await readFile(new URL('scripts/deploy-worker.mjs', projectRoot), 'utf8');
  const ontologyValidator = await readFile(
    new URL('scripts/validate-ontology-release.mjs', projectRoot),
    'utf8',
  );
  const validation = source.indexOf('await validateOntology({');
  const releaseManifest = source.indexOf('await buildManifest({ root, runCommand })');
  const finalSource = source.indexOf('const finalGit = inspectReleaseSource({');
  const wrangler = source.indexOf("runCommand('npx'");
  assert.ok(validation >= 0
    && validation < releaseManifest
    && releaseManifest < finalSource
    && finalSource < wrangler);
  assert.match(source, /requirePublishable: ontologyPromotion/);
  assert.match(ontologyValidator, /public_baseline: loadImmutablePublicBaseline\(root\)/);
  assert.match(ontologyValidator, /promotion_baseline: promotionBaseline/);
  assert.match(ontologyValidator, /runGit\(root, \['show', `\$\{anchorCommit\}:/);
  assert.match(ontologyValidator, /loadImmutablePromotionBaseline\(root\)/);
  assert.doesNotMatch(
    ontologyValidator,
    /0d14b71f56d6ec70fea1840a4f1068a8cef04e8a26b0467bc512c928e6e88ee8/,
  );
  assert.doesNotMatch(
    ontologyValidator,
    /44c18519873482bd34dced32830994ea15b52589789ffa648a16c812ba881dcf/,
  );

  const packageJson = JSON.parse(await readFile(new URL('package.json', projectRoot), 'utf8'));
  assert.equal(packageJson.scripts['deploy:preview'], 'node scripts/deploy-worker.mjs --environment preview');
  assert.equal(packageJson.scripts['deploy:production'], 'node scripts/deploy-worker.mjs --environment production');
  assert.equal(
    packageJson.scripts['deploy:preview:ontology-promotion'],
    'node scripts/deploy-worker.mjs --environment preview --ontology-promotion',
  );
  assert.equal(
    packageJson.scripts['deploy:production:ontology-promotion'],
    'node scripts/deploy-worker.mjs --environment production --ontology-promotion',
  );
});
