import assert from 'node:assert/strict';
import test from 'node:test';

import { assertCleanReleaseSource } from '../scripts/assert-clean-release-source.mjs';
import {
  assertManifestDeploymentGates,
  assertManifestSourceGates,
  wranglerDeployArgs,
} from '../scripts/deploy-worker.mjs';

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
        preview: { ...readyState, pending_migrations: ['0008_compendium_embedded_items.sql'] },
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

test('Worker prepare gate permits only the declared migration while the current release stays healthy', () => {
  const requiredMigration = '0008_compendium_embedded_items.sql';
  const target = {
    release_ready: false,
    pending_migrations: [requiredMigration],
    required_migration: requiredMigration,
    asset_git_commit_deployment_parity: false,
    corpus_release_matches_local: false,
    health: { http_status: 200, ok: true },
    corpus_release: { ready: true, release_id: `corpus-${'a'.repeat(24)}` },
    evidence_status: 'fresh',
    dual_schema_bootstrap_verified: true,
  };
  const manifest = {
    release_blockers: [
      { environment: 'preview', code: 'pending_d1_migration' },
      { environment: 'preview', code: 'worker_graph_shard_git_parity_required' },
      { environment: 'preview', code: 'corpus_release_mismatch' },
    ],
    environment_snapshot: { environments: { preview: target } },
  };
  assert.equal(assertManifestDeploymentGates(manifest, 'preview', { phase: 'prepare' }), true);
  assert.throws(() => assertManifestDeploymentGates({
    ...manifest,
    environment_snapshot: { environments: { preview: {
      ...target, pending_migrations: [requiredMigration, '0009_unreviewed.sql'],
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
      ...target, dual_schema_bootstrap_verified: false,
    } } },
  }, 'preview', { phase: 'prepare' }), /dual_schema_bootstrap_not_verified/);
  assert.throws(() => assertManifestDeploymentGates(manifest, 'preview', { phase: 'steady' }),
    /pending_d1_migration/);
});
