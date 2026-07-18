#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertCleanReleaseSource } from './assert-clean-release-source.mjs';
import { buildReleaseManifest } from './build-release-manifest.mjs';
import { validatePageEvidenceForRelease } from './page-evidence-release-hook.mjs';

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

export async function deployWorker({
  environment,
  root = DEFAULT_ROOT,
  runCommand = spawnSync,
  pageEvidencePromotion = false,
} = {}) {
  validatePageEvidenceForRelease({ root, pageEvidencePromotion });
  const git = assertCleanReleaseSource({ root, requireUpstream: true, runCommand });
  const manifest = await buildReleaseManifest({ root, pageEvidencePromotion });
  assertManifestSourceGates(manifest);
  const arguments_ = wranglerDeployArgs(environment, git.head);
  const result = runCommand('npx', arguments_, { cwd: root, encoding: 'utf8', stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Wrangler deployment failed with exit ${result.status ?? 'unknown'}`);
  return { environment, git_head: git.head };
}

function parseArgs(argv) {
  let environment = null;
  let pageEvidencePromotion = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--page-evidence-promotion') {
      if (pageEvidencePromotion) throw new Error('--page-evidence-promotion may be specified only once');
      pageEvidencePromotion = true;
      continue;
    }
    if (argument === '--environment') {
      if (environment !== null) throw new Error('--environment may be specified only once');
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('missing value for --environment');
      environment = value;
      index += 1;
      continue;
    }
    throw new Error(`unexpected argument: ${argument}`);
  }
  if (!environment) {
    throw new Error('usage: node scripts/deploy-worker.mjs --environment <preview|production> [--page-evidence-promotion]');
  }
  return { environment, pageEvidencePromotion };
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
