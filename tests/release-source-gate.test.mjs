import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { assertCleanReleaseSource } from '../scripts/assert-clean-release-source.mjs';
import {
  assertManifestSourceGates,
  assertOntologyReleaseDeploymentGate,
  parseArgs,
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
  });
  assert.deepEqual(parseArgs(['--environment', 'production', '--ontology-promotion']), {
    environment: 'production',
    ontologyPromotion: true,
  });
  assert.throws(() => parseArgs(['--environment', 'production', '--skip-ontology-gate']), /usage/);
  assert.throws(() => parseArgs(['--ontology-promotion', '--environment', 'production']), /usage/);

  const source = await readFile(new URL('scripts/deploy-worker.mjs', projectRoot), 'utf8');
  const validation = source.indexOf('await validateOntologyReleaseFile({');
  const releaseManifest = source.indexOf('await buildReleaseManifest({ root })');
  const wrangler = source.indexOf("runCommand('npx'");
  assert.ok(validation >= 0 && validation < releaseManifest && releaseManifest < wrangler);
  assert.match(source, /requirePublishable: ontologyPromotion/);

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
