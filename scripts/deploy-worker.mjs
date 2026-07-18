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

export function assertManifestDeploymentGates(manifest, environment) {
  if (!['preview', 'production'].includes(environment)) {
    throw new Error(`unsupported deployment environment: ${environment || '<unset>'}`);
  }
  assertManifestSourceGates(manifest);
  const target = manifest.environment_snapshot?.environments?.[environment];
  if (!target) throw new Error(`Worker deployment ${environment} is blocked: target_environment_state_missing`);
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
  root = DEFAULT_ROOT,
  runCommand = spawnSync,
} = {}) {
  const git = assertCleanReleaseSource({ root, requireUpstream: true, runCommand });
  const manifest = await buildReleaseManifest({ root });
  assertManifestDeploymentGates(manifest, environment);
  const arguments_ = wranglerDeployArgs(environment, git.head);
  const result = runCommand('npx', arguments_, { cwd: root, encoding: 'utf8', stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Wrangler deployment failed with exit ${result.status ?? 'unknown'}`);
  return { environment, git_head: git.head };
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--environment') {
    throw new Error('usage: node scripts/deploy-worker.mjs --environment <preview|production>');
  }
  return { environment: argv[1] };
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
