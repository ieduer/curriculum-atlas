import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertCleanReleaseSource } from '../scripts/assert-clean-release-source.mjs';
import {
  assertDeploymentSnapshot,
  assertManifestDeploymentGates,
  assertManifestSourceGates,
  assertOntologyReleaseDeploymentGate,
  deployWorker,
  parseArgs,
  validateOntologyPreviewAcceptanceReceipt,
  wranglerDeployArgs,
} from '../scripts/deploy-worker.mjs';
import { verifyDualSchemaBootstrap } from '../scripts/verify-dual-schema-bootstrap.mjs';

const projectRoot = new URL('../', import.meta.url);
const FIXTURE_RELEASE_ID = `release-${'f'.repeat(32)}`;
const dualSchemaBootstrapReceipt = verifyDualSchemaBootstrap();

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
  phase = 'steady',
  ontologyPromotion = false,
  initialHead = 'a'.repeat(40),
  manifestHead = initialHead,
  manifestDirty = false,
  ontologyManifestSha256 = 'b'.repeat(64),
  sourceOntologyManifestSha256 = ontologyManifestSha256,
  receipt = null,
  releaseBlockers = [],
  graphShards = [],
  snapshotBuilder = null,
} = {}) {
  let wranglerCalls = 0;
  let preparedCleanupCalls = 0;
  let snapshotCleanupCalls = 0;
  let snapshotFiles = [];
  const sourceFiles = [{
    path: 'data/ontology-release-manifest.json',
    sha256: sourceOntologyManifestSha256,
    bytes: 1,
  }];
  const sourceTreeSha256 = createHash('sha256').update(
    sourceFiles.map((file) => `${file.path}\0${file.sha256}\0${file.bytes}\n`).join(''),
  ).digest('hex');
  const readyState = {
    release_ready: true,
    pending_migrations: [],
    asset_git_commit_deployment_parity: true,
    corpus_release_matches_local: true,
  };
  const manifest = {
    schema_version: 1,
    policy: 'fixture',
    release_id: FIXTURE_RELEASE_ID,
    git: { head: manifestHead, dirty: manifestDirty },
    release_blockers: manifestDirty
      ? [...releaseBlockers, { environment: 'source', code: 'dirty_git_tree' }]
      : releaseBlockers,
    source_tree: { sha256: sourceTreeSha256, files: sourceFiles },
    corpus_release: {
      release_id: `corpus-${'c'.repeat(24)}`,
      manifest_sha256: 'd'.repeat(64),
      sha256: 'e'.repeat(64),
    },
    environment_snapshot: {
      environments: {
        preview: readyState,
        production: readyState,
      },
    },
    graph_assets: [],
    graph_shards: graphShards,
    static_assets: { files: [] },
  };
  const defaultSnapshotBuilder = async ({ files }) => {
    snapshotFiles = files;
    return {
      root: '/private/tmp/fixture-worker-snapshot',
      sha256: 'f'.repeat(64),
      verify: async () => true,
      cleanup: async () => { snapshotCleanupCalls += 1; },
    };
  };
  return {
    options: {
      environment,
      phase,
      ontologyPromotion,
      root: '.',
      previewAcceptanceReceipt: receipt ? 'fixture-receipt.json' : null,
      releasePreparer: async () => ({
        source: { root: '/private/tmp/fixture-prepared-release' },
        manifest,
        artifact: { sha256: '1'.repeat(64) },
        cleanup: async () => { preparedCleanupCalls += 1; },
      }),
      validateOntology: async () => ({
        valid: true,
        publishable: ontologyPromotion,
        errors: [],
        manifest_path: 'data/ontology-release-manifest.json',
        manifest_sha256: ontologyManifestSha256,
      }),
      readPreviewAcceptanceReceipt: async () => receipt,
      snapshotBuilder: snapshotBuilder || defaultSnapshotBuilder,
      runCommand: (command) => {
        if (command === 'npx') wranglerCalls += 1;
        return { status: 0, stdout: '', stderr: '' };
      },
    },
    wranglerCalls: () => wranglerCalls,
    preparedCleanupCalls: () => preparedCleanupCalls,
    snapshotCleanupCalls: () => snapshotCleanupCalls,
    snapshotFiles: () => snapshotFiles,
    manifest,
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
  const proof = {
    git_head: head,
    snapshot_root: '/private/tmp/fixture-worker-snapshot',
    release_id: FIXTURE_RELEASE_ID,
    release_manifest_sha256: 'b'.repeat(64),
    source_tree_sha256: 'c'.repeat(64),
    corpus_release_id: `corpus-${'d'.repeat(24)}`,
    corpus_manifest_sha256: 'e'.repeat(64),
  };
  const expectedVars = [
    '--var', `RELEASE_GIT_COMMIT:${head}`,
    '--var', `RELEASE_ID:${FIXTURE_RELEASE_ID}`,
    '--var', `RELEASE_MANIFEST_SHA256:${'b'.repeat(64)}`,
    '--var', `RELEASE_SOURCE_TREE_SHA256:${'c'.repeat(64)}`,
    '--var', `CORPUS_RELEASE_ID:corpus-${'d'.repeat(24)}`,
    '--var', `CORPUS_MANIFEST_SHA256:${'e'.repeat(64)}`,
  ];
  assert.deepEqual(wranglerDeployArgs('preview', proof), [
    '--no-install', 'wrangler', 'deploy', '--cwd', proof.snapshot_root,
    '--env', 'preview', '--keep-vars', ...expectedVars,
  ]);
  assert.deepEqual(wranglerDeployArgs('production', proof), [
    '--no-install', 'wrangler', 'deploy', '--cwd', proof.snapshot_root,
    '--keep-vars', ...expectedVars,
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

test('deployWorker refuses manifest Git and ontology byte mismatches before Wrangler', async () => {
  for (const fixture of [
    deploymentFixture({ manifestDirty: true }),
    deploymentFixture({
      ontologyManifestSha256: '9'.repeat(64),
      sourceOntologyManifestSha256: 'b'.repeat(64),
    }),
  ]) {
    await assert.rejects(
      () => deployWorker(fixture.options),
      /dirty_git_tree|release manifest reports a dirty source|ontology validation bytes/,
    );
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

test('page-evidence and ontology promotions execute as one prepared preview transaction', async () => {
  const fixture = deploymentFixture({ environment: 'preview', ontologyPromotion: true });
  fixture.options.pageEvidencePromotion = true;
  const result = await deployWorker(fixture.options);
  assert.equal(result.page_evidence_promotion, true);
  assert.equal(result.ontology_promotion, true);
  assert.equal(fixture.wranglerCalls(), 1);
  assert.equal(fixture.preparedCleanupCalls(), 1);
  assert.equal(fixture.snapshotCleanupCalls(), 1);
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

test('deploy CLI combines audited phase, page, and ontology modes without order dependence', async () => {
  assert.deepEqual(parseArgs(['--environment', 'preview']), {
    environment: 'preview',
    phase: 'steady',
    pageEvidencePromotion: false,
    rendererPath: null,
    ontologyPromotion: false,
    previewAcceptanceReceipt: null,
  });
  assert.deepEqual(parseArgs(['--environment', 'production', '--ontology-promotion']), {
    environment: 'production',
    phase: 'steady',
    pageEvidencePromotion: false,
    rendererPath: null,
    ontologyPromotion: true,
    previewAcceptanceReceipt: null,
  });
  assert.deepEqual(parseArgs([
    '--environment', 'production', '--ontology-promotion',
    '--preview-acceptance-receipt', '/private/tmp/ontology-preview-acceptance.json',
  ]), {
    environment: 'production',
    phase: 'steady',
    pageEvidencePromotion: false,
    rendererPath: null,
    ontologyPromotion: true,
    previewAcceptanceReceipt: '/private/tmp/ontology-preview-acceptance.json',
  });
  assert.deepEqual(parseArgs([
    '--ontology-promotion', '--page-evidence-promotion', '--phase', 'prepare',
    '--preview-acceptance-receipt', '/private/tmp/ontology-preview-acceptance.json',
    '--environment', 'production', '--renderer', '/usr/local/bin/mutool',
  ]), {
    environment: 'production',
    phase: 'prepare',
    pageEvidencePromotion: true,
    rendererPath: '/usr/local/bin/mutool',
    ontologyPromotion: true,
    previewAcceptanceReceipt: '/private/tmp/ontology-preview-acceptance.json',
  });
  assert.throws(() => parseArgs(['--environment', 'production', '--skip-ontology-gate']), /unexpected argument/);
  assert.throws(
    () => parseArgs(['--environment', 'preview', '--environment', 'production']),
    /specified only once/,
  );
  assert.throws(
    () => parseArgs(['--page-evidence-promotion', '--page-evidence-promotion', '--environment', 'preview']),
    /specified only once/,
  );

  const source = await readFile(new URL('scripts/deploy-worker.mjs', projectRoot), 'utf8');
  const ontologyValidator = await readFile(
    new URL('scripts/validate-ontology-release.mjs', projectRoot),
    'utf8',
  );
  const releasePreparation = source.indexOf('await releasePreparer({');
  const validation = source.indexOf('await validateOntology({');
  const manifestGates = source.indexOf('  assertManifestDeploymentGates(manifest, environment, { phase');
  const wrangler = source.indexOf("runCommand('npx'");
  assert.ok(releasePreparation >= 0
    && releasePreparation < manifestGates
    && manifestGates < validation
    && validation < wrangler);
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

test('Worker deploy wrapper refuses exact target environment migration, graph, and corpus blockers', () => {
  const readyState = {
    release_ready: true,
    pending_migrations: [],
    asset_git_commit_deployment_parity: true,
    corpus_release_matches_local: true,
  };
  const readyManifest = {
    release_blockers: [],
    environment_snapshot: {
      environments: {
        preview: readyState,
        production: readyState,
      },
    },
  };
  assert.equal(assertManifestDeploymentGates(readyManifest, 'preview'), true);
  assert.equal(assertManifestDeploymentGates(readyManifest, 'production'), true);

  for (const code of [
    'pending_d1_migration',
    'worker_graph_shard_git_parity_required',
    'corpus_release_mismatch',
  ]) {
    assert.throws(() => assertManifestDeploymentGates({
      ...readyManifest,
      release_blockers: [{ environment: 'preview', code }],
    }, 'preview'), new RegExp(code));
  }

  assert.throws(() => assertManifestDeploymentGates({
    ...readyManifest,
    environment_snapshot: {
      environments: {
        ...readyManifest.environment_snapshot.environments,
        preview: { ...readyState, pending_migrations: ['0008_release_ownership_fences.sql'] },
      },
    },
  }, 'preview'), /pending_d1_migration/);
  assert.throws(() => assertManifestDeploymentGates({
    ...readyManifest,
    environment_snapshot: {
      environments: {
        ...readyManifest.environment_snapshot.environments,
        preview: { ...readyState, asset_git_commit_deployment_parity: false },
      },
    },
  }, 'preview'), /worker_graph_shard_git_parity_required/);
  assert.throws(() => assertManifestDeploymentGates({
    ...readyManifest,
    environment_snapshot: {
      environments: {
        ...readyManifest.environment_snapshot.environments,
        preview: { ...readyState, corpus_release_matches_local: false },
      },
    },
  }, 'preview'), /corpus_release_mismatch/);
  assert.throws(() => assertManifestDeploymentGates({ release_blockers: [] }, 'preview'), /target_environment_state_missing/);

  assert.equal(assertManifestDeploymentGates({
    ...readyManifest,
    release_blockers: [{ environment: 'production', code: 'corpus_release_mismatch' }],
  }, 'preview'), true, 'a blocker for the other target must not contaminate preview');
});

test('Worker prepare gate permits only the declared migrations while the current release stays healthy', () => {
  const requiredMigrations = [
    '0008_release_ownership_fences.sql',
    '0009_compendium_embedded_items.sql',
  ];
  const target = {
    release_ready: false,
    pending_migrations: requiredMigrations,
    asset_git_commit_deployment_parity: false,
    corpus_release_matches_local: false,
    health: { http_status: 200, ok: true },
    corpus_release: { ready: true, release_id: `corpus-${'a'.repeat(24)}` },
    evidence_status: 'fresh',
    dual_schema_bootstrap_receipt: dualSchemaBootstrapReceipt,
  };
  const manifest = {
    release_blockers: [
      { environment: 'preview', code: 'pending_d1_migration' },
      { environment: 'preview', code: 'worker_graph_shard_git_parity_required' },
      { environment: 'preview', code: 'corpus_release_mismatch' },
      { environment: 'preview', code: 'versioned_r2_reader_required' },
    ],
    environment_snapshot: { required_migrations: requiredMigrations, environments: { preview: target } },
  };
  assert.equal(assertManifestDeploymentGates(manifest, 'preview', { phase: 'prepare' }), true);
  assert.throws(() => assertManifestDeploymentGates({
    ...manifest,
    environment_snapshot: { environments: { preview: {
      ...target, pending_migrations: [...requiredMigrations, '0010_unreviewed.sql'],
    } } },
  }, 'preview', { phase: 'prepare' }), /undeclared_pending_d1_migration/);
  assert.throws(() => assertManifestDeploymentGates({
    ...manifest,
    environment_snapshot: { environments: { preview: {
      ...target, health: { http_status: 503, ok: false },
    } } },
  }, 'preview', { phase: 'prepare' }), /current_release_unhealthy/);
  assert.throws(() => assertManifestDeploymentGates({
    ...manifest,
    environment_snapshot: { environments: { preview: {
      ...target, evidence_status: 'stale',
    } } },
  }, 'preview', { phase: 'prepare' }), /environment_evidence_not_fresh/);
  assert.throws(() => assertManifestDeploymentGates({
    ...manifest,
    environment_snapshot: { environments: { preview: {
      ...target, dual_schema_bootstrap_receipt: {
        ...dualSchemaBootstrapReceipt,
        receipt_sha256: '0'.repeat(64),
      },
    } } },
  }, 'preview', { phase: 'prepare' }), /dual_schema_bootstrap_not_verified/);
  assert.throws(
    () => assertManifestDeploymentGates(manifest, 'preview', { phase: 'steady' }),
    /versioned_r2_reader_required/,
  );
});

test('Worker deployment inventory includes every graph shard deploy path', async () => {
  const shard = {
    deploy_path: 'dist/data/graph-shards/academic/concepts/fixture.json',
    sha256: '7'.repeat(64),
    bytes: 19,
  };
  const fixture = deploymentFixture({ environment: 'preview', graphShards: [shard] });
  await deployWorker(fixture.options);
  assert.ok(
    fixture.snapshotFiles().some((entry) => entry.path === shard.deploy_path),
    'immutable deployment snapshot must include graph shard bytes',
  );
  assert.equal(fixture.wranglerCalls(), 1);
});

test('prepared release cleanup runs exactly once when a pre-snapshot source gate fails', async () => {
  const fixture = deploymentFixture({
    environment: 'preview',
    releaseBlockers: [{ environment: 'source', code: 'synthetic_source_blocker' }],
  });
  await assert.rejects(() => deployWorker(fixture.options), /synthetic_source_blocker/);
  assert.equal(fixture.wranglerCalls(), 0);
  assert.equal(fixture.snapshotCleanupCalls(), 0);
  assert.equal(fixture.preparedCleanupCalls(), 1);
});

test('prepared and deployment snapshots clean exactly once when preview acceptance is rejected', async () => {
  const receipt = acceptedPreviewReceipt({ status: 'rejected' });
  const fixture = deploymentFixture({ ontologyPromotion: true, receipt });
  fixture.options.readPreviewAcceptanceReceipt = async ({ gitHead, ontologyManifestSha256 }) =>
    validateOntologyPreviewAcceptanceReceipt(receipt, { gitHead, ontologyManifestSha256 });
  await assert.rejects(() => deployWorker(fixture.options), /acceptance status must be accepted/);
  assert.equal(fixture.wranglerCalls(), 0);
  assert.equal(fixture.snapshotCleanupCalls(), 1);
  assert.equal(fixture.preparedCleanupCalls(), 1);
});

test('Worker deployment executes from the complete private source and dist snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worker-deploy-snapshot-fixture-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'dist'), { recursive: true });
    await mkdir(join(root, 'data'), { recursive: true });
    const [sourceRecoveryProof, sourceRecoveryReceipt] = await Promise.all([
      readFile(new URL('data/source-recovery-proofs.json', projectRoot)),
      readFile(new URL('data/source-recovery-online-receipt.json', projectRoot)),
    ]);
    const files = new Map([
      ['src/index.ts', Buffer.from('export default { fetch() { return new Response("ok"); } };\n')],
      ['src/z.ts', Buffer.from('export const z = true;\n')],
      ['src/é.ts', Buffer.from('export const accented = true;\n')],
      ['wrangler.jsonc', Buffer.from('{"name":"fixture","main":"src/index.ts","assets":{"directory":"./dist"}}\n')],
      ['data/ontology-release-manifest.json', Buffer.from('{"fixture":true}\n')],
      ['data/source-recovery-proofs.json', sourceRecoveryProof],
      ['data/source-recovery-online-receipt.json', sourceRecoveryReceipt],
      ['dist/index.html', Buffer.from('<!doctype html><title>fixture</title>\n')],
    ]);
    for (const [path, buffer] of files) await writeFile(join(root, path), buffer);
    const sourceFiles = [...files.entries()].filter(([path]) => !path.startsWith('dist/')).map(([path, buffer]) => ({
      path,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      bytes: buffer.length,
    })).sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const sourceTreeSha256 = createHash('sha256').update(
      sourceFiles.map((file) => `${file.path}\0${file.sha256}\0${file.bytes}\n`).join(''),
    ).digest('hex');
    const distBuffer = files.get('dist/index.html');
    const head = 'a'.repeat(40);
    const manifest = {
      schema_version: 1,
      policy: 'fixture',
      release_id: FIXTURE_RELEASE_ID,
      release_blockers: [],
      git: { head, dirty: false },
      source_tree: { sha256: sourceTreeSha256, files: sourceFiles },
      corpus_release: {
        release_id: `corpus-${'b'.repeat(24)}`,
        manifest_sha256: 'c'.repeat(64),
      },
      environment_snapshot: {
        environments: {
          preview: {
            release_ready: true,
            pending_migrations: [],
            asset_git_commit_deployment_parity: true,
            corpus_release_matches_local: true,
          },
        },
      },
      page_evidence: { valid: true, publishable: false },
      data_assets: [],
      graph_assets: [],
      graph_shards: [],
      static_assets: {
        files: [{
          deploy_path: 'dist/index.html',
          sha256: createHash('sha256').update(distBuffer).digest('hex'),
          bytes: distBuffer.length,
        }],
      },
      r2: { release_prefix: 'releases', release_manifest_key: `releases/${FIXTURE_RELEASE_ID}/manifest.json`, objects: [] },
    };
    let snapshotRoot = null;
    const runCommand = (_command, args) => {
      snapshotRoot = args[args.indexOf('--cwd') + 1];
      writeFileSync(join(root, 'src/index.ts'), 'export default { compromised: true };\n');
      assert.deepEqual(readFileSync(join(snapshotRoot, 'src/index.ts')), files.get('src/index.ts'));
      assert.deepEqual(readFileSync(join(snapshotRoot, 'dist/index.html')), distBuffer);
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = await deployWorker({
      environment: 'preview',
      root,
      runCommand,
      releasePreparer: async () => ({
        source: { root },
        manifest,
        artifact: { sha256: 'd'.repeat(64) },
        cleanup: async () => {},
      }),
      validateOntology: async () => ({
        valid: true,
        publishable: false,
        errors: [],
        manifest_path: 'data/ontology-release-manifest.json',
        manifest_sha256: sourceFiles.find(
          (entry) => entry.path === 'data/ontology-release-manifest.json',
        ).sha256,
      }),
    });
    assert.equal(result.git_head, head);
    assert.equal(result.source_tree_sha256, sourceTreeSha256);
    assert.ok(snapshotRoot);
    assert.equal(existsSync(snapshotRoot), false, 'deployment snapshot must be removed after Wrangler returns');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
