#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertCleanReleaseSource } from './assert-clean-release-source.mjs';
import { buildReleaseManifest } from './build-release-manifest.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));

export function wranglerDeployArgs(environment, gitHead) {
  if (!['preview', 'production'].includes(environment)) {
    throw new Error(`unsupported deployment environment: ${environment || '<unset>'}`);
  }
  if (!/^[0-9a-f]{40}$/.test(String(gitHead || ''))) throw new Error('deployment requires an exact Git HEAD');
  const arguments_ = ['--no-install', 'wrangler', 'deploy'];
  if (environment === 'preview') arguments_.push('--env', 'preview');
  arguments_.push('--keep-vars', '--var', `RELEASE_GIT_COMMIT:${gitHead}`);
  return arguments_;
}

export function assertManifestSourceGates(manifest) {
  const blockers = (manifest.release_blockers || []).filter((blocker) => blocker.environment === 'source');
  if (blockers.length) {
    throw new Error(`Worker deployment source is blocked: ${blockers.map((blocker) => blocker.code).join(', ')}`);
  }
  return true;
}

export function assertManifestDeploymentGates(manifest, environment, { phase = 'steady' } = {}) {
  if (!['preview', 'production'].includes(environment)) {
    throw new Error(`unsupported deployment environment: ${environment || '<unset>'}`);
  }
  if (!['prepare', 'steady'].includes(phase)) {
    throw new Error(`unsupported deployment phase: ${phase || '<unset>'}`);
  }
  assertManifestSourceGates(manifest);
  const target = manifest.environment_snapshot?.environments?.[environment];
  if (!target) throw new Error(`Worker deployment ${environment} is blocked: target_environment_state_missing`);
  if (phase === 'prepare') {
    const codes = [];
    const requiredMigration = manifest.environment_snapshot?.required_migration || target.required_migration;
    if (!requiredMigration) codes.push('required_d1_migration_missing');
    if (!Array.isArray(target.pending_migrations)
      || target.pending_migrations.length !== 1
      || target.pending_migrations[0] !== requiredMigration) {
      codes.push('undeclared_pending_d1_migration');
    }
    const evidenceFresh = target.evidence_fresh === true || target.evidence_status === 'fresh';
    if (!evidenceFresh) codes.push('environment_evidence_not_fresh');
    if (target.dual_schema_bootstrap_verified !== true) codes.push('dual_schema_bootstrap_not_verified');
    if (target.health?.http_status !== 200 || target.health?.ok !== true) {
      codes.push('current_release_unhealthy');
    }
    if (target.corpus_release?.ready !== true) codes.push('current_corpus_release_unhealthy');
    const allowedPostconditionBlockers = new Set([
      'pending_d1_migration',
      'worker_graph_shard_git_parity_required',
      'corpus_release_mismatch',
      'worker_health_release_provenance_required',
    ]);
    for (const blocker of manifest.release_blockers || []) {
      if (blocker.environment === environment && !allowedPostconditionBlockers.has(blocker.code)) {
        codes.push(blocker.code);
      }
    }
    const uniqueCodes = [...new Set(codes)];
    if (uniqueCodes.length) {
      throw new Error(`Worker deployment ${environment} prepare phase is blocked: ${uniqueCodes.join(', ')}`);
    }
    return true;
  }
  const blockers = (manifest.release_blockers || [])
    .filter((blocker) => blocker.environment === environment)
    .map((blocker) => blocker.code);
  if (!Array.isArray(target.pending_migrations) || target.pending_migrations.length > 0) {
    blockers.push('pending_d1_migration');
  }
  if (target.asset_git_commit_deployment_parity !== true) {
    blockers.push('worker_graph_shard_git_parity_required');
  }
  if (target.corpus_release_matches_local !== true) {
    blockers.push('corpus_release_mismatch');
  }
  if (target.release_ready !== true && blockers.length === 0) {
    blockers.push('target_environment_not_ready');
  }
  const codes = [...new Set(blockers)];
  if (codes.length) {
    throw new Error(`Worker deployment ${environment} is blocked: ${codes.join(', ')}`);
  }
  return true;
}

export async function deployWorker({
  environment,
  phase = 'steady',
  root = DEFAULT_ROOT,
  runCommand = spawnSync,
} = {}) {
  const git = assertCleanReleaseSource({ root, requireUpstream: true, runCommand });
  const manifest = await buildReleaseManifest({ root });
  assertManifestDeploymentGates(manifest, environment, { phase });
  const arguments_ = wranglerDeployArgs(environment, git.head);
  const result = runCommand('npx', arguments_, { cwd: root, encoding: 'utf8', stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Wrangler deployment failed with exit ${result.status ?? 'unknown'}`);
  return { environment, phase, git_head: git.head };
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--environment', '--phase'].includes(argv[index]) || !argv[index + 1]) {
      throw new Error('usage: node scripts/deploy-worker.mjs --environment <preview|production> [--phase <prepare|steady>]');
    }
    args.set(argv[index].slice(2), argv[index + 1]);
  }
  return { environment: args.get('environment'), phase: args.get('phase') || 'steady' };
}

async function main() {
  await deployWorker(parseArgs(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`deploy-worker: ${error.message}\n`);
    process.exitCode = 1;
  });
}
