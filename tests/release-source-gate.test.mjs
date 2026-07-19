import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertCleanReleaseSource } from '../scripts/assert-clean-release-source.mjs';
import {
  assertManifestDeploymentGates,
  assertManifestSourceGates,
  deployWorker,
  wranglerDeployArgs,
} from '../scripts/deploy-worker.mjs';
import { verifyDualSchemaBootstrap } from '../scripts/verify-dual-schema-bootstrap.mjs';

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
  assert.throws(() => assertManifestDeploymentGates(manifest, 'preview', { phase: 'steady' }),
    /pending_d1_migration/);
});

test('Worker deployment executes from the complete private source and dist snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worker-deploy-snapshot-fixture-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'dist'), { recursive: true });
    const files = new Map([
      ['src/index.ts', Buffer.from('export default { fetch() { return new Response("ok"); } };\n')],
      ['src/z.ts', Buffer.from('export const z = true;\n')],
      ['src/é.ts', Buffer.from('export const accented = true;\n')],
      ['wrangler.jsonc', Buffer.from('{"name":"fixture","main":"src/index.ts","assets":{"directory":"./dist"}}\n')],
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
      git: { head },
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
      pageEvidenceValidator: () => ({ valid: true, publishable: false }),
      cleanSourceValidator: () => ({ head, upstream: head, clean: true }),
      manifestBuilder: async () => manifest,
    });
    assert.equal(result.git_head, head);
    assert.equal(result.source_tree_sha256, sourceTreeSha256);
    assert.ok(snapshotRoot);
    assert.equal(existsSync(snapshotRoot), false, 'deployment snapshot must be removed after Wrangler returns');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
