#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertCleanReleaseSource } from './assert-clean-release-source.mjs';
import { buildReleaseManifest } from './build-release-manifest.mjs';
import { validatePageEvidenceForRelease } from './page-evidence-release-hook.mjs';
import { createImmutableTreeSnapshot } from './lib/immutable-release-snapshot.mjs';
import { immutableVersionedManifestArtifact } from './publish-metadata.mjs';
import { prepareRelease } from './prepare-release.mjs';
import { validateDualSchemaBootstrapReceipt } from './verify-dual-schema-bootstrap.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_MANIFEST = '.wrangler/release-manifest.json';

function exactSha256(value, label) {
  const text = String(value || '');
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${label} must be an exact SHA-256`);
  return text;
}

export function wranglerDeployArgs(environment, proof) {
  if (!['preview', 'production'].includes(environment)) {
    throw new Error(`unsupported deployment environment: ${environment || '<unset>'}`);
  }
  const gitHead = String(proof?.git_head || '');
  if (!/^[0-9a-f]{40}$/.test(String(gitHead || ''))) throw new Error('deployment requires an exact Git HEAD');
  const snapshotRoot = String(proof?.snapshot_root || '');
  if (!snapshotRoot.startsWith('/')) throw new Error('deployment requires an absolute private snapshot root');
  const variables = {
    RELEASE_GIT_COMMIT: gitHead,
    RELEASE_ID: String(proof?.release_id || ''),
    RELEASE_MANIFEST_SHA256: exactSha256(proof?.release_manifest_sha256, 'release manifest SHA-256'),
    RELEASE_SOURCE_TREE_SHA256: exactSha256(proof?.source_tree_sha256, 'release source tree SHA-256'),
    CORPUS_RELEASE_ID: String(proof?.corpus_release_id || ''),
    CORPUS_MANIFEST_SHA256: exactSha256(proof?.corpus_manifest_sha256, 'corpus manifest SHA-256'),
  };
  if (!/^release-[a-f0-9]{32}$/.test(variables.RELEASE_ID)) throw new Error('deployment requires a release ID');
  if (!/^corpus-[a-f0-9]{24}$/.test(variables.CORPUS_RELEASE_ID)) throw new Error('deployment requires a corpus release ID');
  const arguments_ = ['--no-install', 'wrangler', 'deploy', '--cwd', snapshotRoot];
  if (environment === 'preview') arguments_.push('--env', 'preview');
  arguments_.push('--keep-vars');
  for (const [key, value] of Object.entries(variables)) arguments_.push('--var', `${key}:${value}`);
  return arguments_;
}

export function assertManifestSourceGates(manifest) {
  const blockers = (manifest.release_blockers || []).filter((blocker) => blocker.environment === 'source');
  if (blockers.length) {
    throw new Error(`Worker deployment source is blocked: ${blockers.map((blocker) => blocker.code).join(', ')}`);
  }
  return true;
}

export function assertManifestDeploymentGates(manifest, environment, { phase = 'steady', root = DEFAULT_ROOT } = {}) {
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
    const requiredMigrations = manifest.environment_snapshot?.required_migrations
      || [manifest.environment_snapshot?.required_migration || target.required_migration].filter(Boolean);
    if (!requiredMigrations.length) codes.push('required_d1_migration_missing');
    if (!Array.isArray(target.pending_migrations)
      || JSON.stringify(target.pending_migrations) !== JSON.stringify(requiredMigrations)) {
      codes.push('undeclared_pending_d1_migration');
    }
    const evidenceFresh = target.evidence_fresh === true || target.evidence_status === 'fresh';
    if (!evidenceFresh) codes.push('environment_evidence_not_fresh');
    try {
      validateDualSchemaBootstrapReceipt(
        target.dual_schema_bootstrap_receipt || manifest.environment_snapshot?.dual_schema_bootstrap_receipt,
        { root },
      );
    } catch {
      codes.push('dual_schema_bootstrap_not_verified');
    }
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
  pageEvidencePromotion = false,
  rendererPath = null,
  pageEvidenceValidator = validatePageEvidenceForRelease,
  cleanSourceValidator = assertCleanReleaseSource,
  manifestBuilder = buildReleaseManifest,
  releasePreparer = prepareRelease,
} = {}) {
  let prepared = null;
  let sourceRoot = root;
  let git;
  let manifest;
  if (manifestBuilder === buildReleaseManifest) {
    prepared = await releasePreparer({
      root,
      output: DEFAULT_MANIFEST,
      pageEvidencePromotion,
      rendererPath,
      runCommand,
      pageEvidenceValidator,
      cleanSourceValidator,
    });
    sourceRoot = prepared.source.root;
    git = { head: prepared.manifest.git.head };
    manifest = prepared.manifest;
  } else {
    pageEvidenceValidator({ root, pageEvidencePromotion, rendererPath });
    git = cleanSourceValidator({ root, requireUpstream: true, runCommand });
    manifest = await manifestBuilder({ root, pageEvidencePromotion, rendererPath });
  }
  assertManifestSourceGates(manifest);
  assertManifestDeploymentGates(manifest, environment, { phase, root: sourceRoot });
  if (manifest.git?.head !== git.head) throw new Error('release manifest Git HEAD differs from the clean source gate');

  const inventory = new Map();
  const add = (entry, pathKey = 'path') => {
    const path = String(entry?.[pathKey] || '');
    const current = inventory.get(path);
    const normalized = { path, sha256: entry?.sha256, bytes: entry?.bytes };
    if (current && (current.sha256 !== normalized.sha256 || current.bytes !== normalized.bytes)) {
      throw new Error(`deployment snapshot inventory has conflicting bytes for ${path}`);
    }
    inventory.set(path, normalized);
  };
  for (const file of manifest.source_tree?.files || []) add(file);
  for (const file of manifest.static_assets?.files || []) add(file, 'deploy_path');
  for (const file of manifest.graph_assets || []) add(file, 'deploy_path');
  if (!inventory.size) throw new Error('release manifest has no deployment snapshot inventory');
  const sourceTreeDigest = createHash('sha256').update(
    [...(manifest.source_tree?.files || [])]
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      .map((file) => `${file.path}\0${file.sha256}\0${file.bytes}\n`)
      .join(''),
  ).digest('hex');
  if (sourceTreeDigest !== manifest.source_tree?.sha256) {
    throw new Error('release manifest source tree digest is internally inconsistent');
  }

  let snapshot = null;
  try {
    snapshot = await createImmutableTreeSnapshot({
      root: sourceRoot,
      files: [...inventory.values()],
      label: 'Worker deployment source',
    });
    await snapshot.verify();
    const manifestArtifact = prepared?.artifact || immutableVersionedManifestArtifact(manifest);
    const arguments_ = wranglerDeployArgs(environment, {
      git_head: git.head,
      snapshot_root: snapshot.root,
      release_id: manifest.release_id,
      release_manifest_sha256: manifestArtifact.sha256,
      source_tree_sha256: manifest.source_tree.sha256,
      corpus_release_id: manifest.corpus_release.release_id,
      corpus_manifest_sha256: manifest.corpus_release.manifest_sha256,
    });
    const result = runCommand('npx', arguments_, { cwd: root, encoding: 'utf8', stdio: 'inherit' });
    await snapshot.verify();
    if (result.status !== 0) throw new Error(`Wrangler deployment failed with exit ${result.status ?? 'unknown'}`);
    return {
      environment,
      git_head: git.head,
      release_id: manifest.release_id,
      source_tree_sha256: manifest.source_tree.sha256,
      release_manifest_sha256: manifestArtifact.sha256,
      deployment_snapshot_sha256: snapshot.sha256,
    };
  } finally {
    await snapshot?.cleanup();
    await prepared?.cleanup();
  }
}

function parseArgs(argv) {
  let environment = null;
  let pageEvidencePromotion = false;
  let rendererPath = null;
  let phase = 'steady';
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
    if (argument === '--renderer') {
      if (rendererPath !== null) throw new Error('--renderer may be specified only once');
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('missing value for --renderer');
      rendererPath = value;
      index += 1;
      continue;
    }
    if (argument === '--phase') {
      if (phase !== 'steady') throw new Error('--phase may be specified only once');
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('missing value for --phase');
      phase = value;
      index += 1;
      continue;
    }
    throw new Error(`unexpected argument: ${argument}`);
  }
  if (!environment) {
    throw new Error('usage: node scripts/deploy-worker.mjs --environment <preview|production> [--page-evidence-promotion] [--renderer <MUTOOL_PATH>]');
  }
  return { environment, pageEvidencePromotion, rendererPath, phase };
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
