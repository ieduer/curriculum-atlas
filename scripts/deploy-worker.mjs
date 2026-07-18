#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertCleanReleaseSource } from './assert-clean-release-source.mjs';
import { buildReleaseManifest } from './build-release-manifest.mjs';
import {
  assertOntologyReleaseGate,
  validateOntologyReleaseFile,
} from './validate-ontology-release.mjs';

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

export function assertOntologyReleaseDeploymentGate(report, { ontologyPromotion = false } = {}) {
  assertOntologyReleaseGate(report, { requirePublishable: ontologyPromotion });
  if (!ontologyPromotion && report.publishable) {
    throw new Error('publishable ontology release requires the dedicated ontology-promotion transaction');
  }
  return true;
}

export async function deployWorker({
  environment,
  ontologyPromotion = false,
  root = DEFAULT_ROOT,
  runCommand = spawnSync,
} = {}) {
  const git = assertCleanReleaseSource({ root, requireUpstream: true, runCommand });
  const ontologyReport = await validateOntologyReleaseFile({
    root,
    requirePublishable: ontologyPromotion,
  });
  assertOntologyReleaseDeploymentGate(ontologyReport, { ontologyPromotion });
  const manifest = await buildReleaseManifest({ root });
  assertManifestSourceGates(manifest);
  const arguments_ = wranglerDeployArgs(environment, git.head);
  const result = runCommand('npx', arguments_, { cwd: root, encoding: 'utf8', stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Wrangler deployment failed with exit ${result.status ?? 'unknown'}`);
  return {
    environment,
    git_head: git.head,
    ontology_promotion: ontologyPromotion,
    ontology_release_publishable: ontologyReport.publishable,
  };
}

export function parseArgs(argv) {
  const promotion = argv.length === 3 && argv[2] === '--ontology-promotion';
  if ((argv.length !== 2 && !promotion) || argv[0] !== '--environment') {
    throw new Error('usage: node scripts/deploy-worker.mjs --environment <preview|production> [--ontology-promotion]');
  }
  if (!['preview', 'production'].includes(argv[1])) {
    throw new Error(`unsupported deployment environment: ${argv[1] || '<unset>'}`);
  }
  return { environment: argv[1], ontologyPromotion: promotion };
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
