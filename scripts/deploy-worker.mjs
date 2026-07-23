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

export function releaseGateScripts(environment) {
  if (!['preview', 'production'].includes(environment)) {
    throw new Error(`unsupported deployment environment: ${environment || '<unset>'}`);
  }
  return environment === 'production'
    ? ['release:gates:check', 'performance:runtime:check']
    : ['release:gates:check'];
}

export async function deployWorker({
  environment,
  root = DEFAULT_ROOT,
  runCommand = spawnSync,
} = {}) {
  for (const script of releaseGateScripts(environment)) {
    const gate = runCommand('npm', ['run', script], { cwd: root, encoding: 'utf8', stdio: 'inherit' });
    if (gate.status !== 0) throw new Error(`deployment quality gate failed: ${script}`);
  }
  const git = assertCleanReleaseSource({ root, requireUpstream: true, runCommand });
  const manifest = await buildReleaseManifest({ root });
  assertManifestSourceGates(manifest);
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
