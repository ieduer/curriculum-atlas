#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertCleanReleaseSource } from './assert-clean-release-source.mjs';
import { buildReleaseManifest } from './build-release-manifest.mjs';
import {
  assertOntologyReleaseGate,
  validateOntologyReleaseFile,
} from './validate-ontology-release.mjs';
import { validatePageEvidenceForRelease } from './page-evidence-release-hook.mjs';
import { createImmutableTreeSnapshot } from './lib/immutable-release-snapshot.mjs';
import { immutableVersionedManifestArtifact } from './publish-metadata.mjs';
import { prepareRelease } from './prepare-release.mjs';
import { validateDualSchemaBootstrapReceipt } from './verify-dual-schema-bootstrap.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_MANIFEST = '.wrangler/release-manifest.json';
const ONTOLOGY_MANIFEST_PATH = 'data/ontology-release-manifest.json';
const RECEIPT_SCHEMA = './ontology-preview-acceptance-receipt.schema.json';
const EXACT_SHA256 = /^[0-9a-f]{64}$/;
const EXACT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

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

function assertOntologyManifestSourceBinding(manifest, ontologyReport) {
  const ontologyPath = ontologyReport?.manifest_path;
  const ontologySha256 = ontologyReport?.manifest_sha256;
  const manifestOntology = manifest?.source_tree?.files?.find((entry) => entry.path === ontologyPath);
  if (ontologyPath !== ONTOLOGY_MANIFEST_PATH || !EXACT_SHA256.test(String(ontologySha256 || ''))
    || manifestOntology?.sha256 !== ontologySha256) {
    throw new Error('ontology validation bytes differ from the release manifest source tree');
  }
  return true;
}

export function assertDeploymentSnapshot({ initialGit, manifest, ontologyReport, finalGit }) {
  if (!initialGit?.clean || initialGit.upstream !== initialGit.head) {
    throw new Error('initial deployment source is not clean and exact-upstream bound');
  }
  if (manifest?.git?.dirty !== false) {
    throw new Error('release manifest reports a dirty source');
  }
  if (manifest?.git?.head !== initialGit.head) {
    throw new Error(`release manifest Git HEAD ${manifest?.git?.head || '<unset>'} differs from initial deployment HEAD ${initialGit.head}`);
  }
  assertOntologyManifestSourceBinding(manifest, ontologyReport);
  if (finalGit.head !== initialGit.head) {
    throw new Error(`final release source HEAD ${finalGit.head || '<unset>'} differs from initial deployment HEAD ${initialGit.head}`);
  }
  if (!finalGit?.clean || finalGit.upstream !== initialGit.head) {
    throw new Error('final release source is not clean and exact-upstream bound to the initial deployment HEAD');
  }
  return true;
}

export function validateOntologyPreviewAcceptanceReceipt(
  receipt,
  { gitHead, ontologyManifestSha256 } = {},
) {
  if (!exactKeys(receipt, [
    '$schema', 'schema_version', 'receipt_id', 'policy', 'source', 'preview',
    'acceptance', 'receipt_sha256',
  ])
    || receipt.$schema !== RECEIPT_SCHEMA
    || receipt.schema_version !== 1
    || !/^ontology-preview-acceptance:[a-z0-9][a-z0-9:-]*$/.test(receipt.receipt_id || '')
    || receipt.policy !== 'immutable_preview_ontology_acceptance_v1') {
    throw new Error('preview acceptance receipt contract is invalid');
  }
  if (!exactKeys(receipt.source, ['git_head', 'ontology_manifest'])
    || !/^[0-9a-f]{40}$/.test(receipt.source.git_head || '')
    || !exactKeys(receipt.source.ontology_manifest, ['path', 'sha256'])
    || receipt.source.ontology_manifest.path !== ONTOLOGY_MANIFEST_PATH
    || !EXACT_SHA256.test(receipt.source.ontology_manifest.sha256 || '')) {
    throw new Error('preview acceptance receipt source binding is invalid');
  }
  if (receipt.source.git_head !== gitHead) {
    throw new Error(`preview acceptance receipt Git HEAD ${receipt.source.git_head} differs from deployment HEAD ${gitHead || '<unset>'}`);
  }
  if (receipt.source.ontology_manifest.sha256 !== ontologyManifestSha256) {
    throw new Error('preview acceptance receipt ontology manifest SHA differs from the validated deployment manifest');
  }
  if (!exactKeys(receipt.preview, ['worker_name', 'environment', 'deployment_id', 'version_id'])
    || receipt.preview.worker_name !== 'bdfz-curriculum-atlas-preview'
    || receipt.preview.environment !== 'preview'
    || !EXACT_UUID.test(receipt.preview.deployment_id || '')) {
    throw new Error('preview acceptance receipt deployment identity is invalid');
  }
  if (!EXACT_UUID.test(receipt.preview.version_id || '')) {
    throw new Error('preview version_id must be an exact UUID');
  }
  if (!exactKeys(receipt.acceptance, ['status', 'accepted_by', 'accepted_at'])
    || typeof receipt.acceptance.accepted_by !== 'string'
    || receipt.acceptance.accepted_by.trim().length === 0
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(receipt.acceptance.accepted_at || '')
    || Number.isNaN(Date.parse(receipt.acceptance.accepted_at))) {
    throw new Error('preview acceptance receipt review identity or time is invalid');
  }
  if (receipt.acceptance.status !== 'accepted') {
    throw new Error('preview acceptance status must be accepted');
  }
  const { receipt_sha256: declared, ...body } = receipt;
  const actual = createHash('sha256').update(stableStringify(body)).digest('hex');
  if (!EXACT_SHA256.test(declared || '') || declared !== actual) {
    throw new Error('preview acceptance receipt SHA-256 is invalid');
  }
  return receipt;
}

export async function readOntologyPreviewAcceptanceReceipt({
  root = DEFAULT_ROOT,
  receiptPath,
  gitHead,
  ontologyManifestSha256,
} = {}) {
  if (typeof receiptPath !== 'string' || receiptPath.length === 0) {
    throw new Error('production ontology promotion preview acceptance receipt is required');
  }
  const absolute = isAbsolute(receiptPath) ? receiptPath : resolve(root, receiptPath);
  const receipt = JSON.parse(await readFile(absolute, 'utf8'));
  return validateOntologyPreviewAcceptanceReceipt(receipt, { gitHead, ontologyManifestSha256 });
}

export function assertOntologyReleaseDeploymentGate(report, { ontologyPromotion = false } = {}) {
  assertOntologyReleaseGate(report, { requirePublishable: ontologyPromotion });
  if (!ontologyPromotion && report.publishable) {
    throw new Error('publishable ontology release requires the dedicated ontology-promotion transaction');
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
      'versioned_r2_reader_required',
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
  ontologyPromotion = false,
  previewAcceptanceReceipt = null,
  pageEvidenceValidator = validatePageEvidenceForRelease,
  cleanSourceValidator = assertCleanReleaseSource,
  manifestBuilder = buildReleaseManifest,
  releasePreparer = prepareRelease,
  validateOntology = validateOntologyReleaseFile,
  readPreviewAcceptanceReceipt = readOntologyPreviewAcceptanceReceipt,
  snapshotBuilder = createImmutableTreeSnapshot,
} = {}) {
  if (previewAcceptanceReceipt && (!ontologyPromotion || environment !== 'production')) {
    throw new Error('preview acceptance receipt is valid only for production ontology promotion');
  }
  if (environment === 'production' && ontologyPromotion && !previewAcceptanceReceipt) {
    throw new Error('production ontology promotion preview acceptance receipt is required');
  }
  let prepared = null;
  let snapshot = null;
  let sourceRoot = root;
  let git;
  let manifest;
  try {
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
    manifest = await manifestBuilder({
      root,
      repositoryRoot: root,
      pageEvidencePromotion,
      rendererPath,
      runCommand,
    });
  }
  assertManifestSourceGates(manifest);
  assertManifestDeploymentGates(manifest, environment, { phase, root: sourceRoot });
  if (manifest.git?.head !== git.head) throw new Error('release manifest Git HEAD differs from the clean source gate');
  if (manifest.git?.dirty !== false) throw new Error('release manifest reports a dirty source');
  const ontologyReport = await validateOntology({
    root,
    requirePublishable: ontologyPromotion,
  });
  assertOntologyReleaseDeploymentGate(ontologyReport, { ontologyPromotion });
  assertOntologyManifestSourceBinding(manifest, ontologyReport);

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
  for (const file of manifest.graph_shards || []) add(file, 'deploy_path');
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

  snapshot = await snapshotBuilder({
      root: sourceRoot,
      files: [...inventory.values()],
      label: 'Worker deployment source',
    });
    await snapshot.verify();
    let acceptanceReceipt = null;
    if (environment === 'production' && ontologyPromotion) {
      acceptanceReceipt = await readPreviewAcceptanceReceipt({
        root,
        receiptPath: previewAcceptanceReceipt,
        gitHead: git.head,
        ontologyManifestSha256: ontologyReport.manifest_sha256,
      });
    }
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
      page_evidence_promotion: pageEvidencePromotion,
      ontology_promotion: ontologyPromotion,
      ontology_release_publishable: ontologyReport.publishable,
      preview_acceptance_receipt_sha256: acceptanceReceipt?.receipt_sha256 || null,
    };
  } finally {
    await snapshot?.cleanup();
    await prepared?.cleanup();
  }
}

export function parseArgs(argv) {
  const options = {
    environment: null,
    phase: 'steady',
    pageEvidencePromotion: false,
    rendererPath: null,
    ontologyPromotion: false,
    previewAcceptanceReceipt: null,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`);
    if (seen.has(argument)) throw new Error(`${argument} may be specified only once`);
    seen.add(argument);
    if (argument === '--page-evidence-promotion') {
      options.pageEvidencePromotion = true;
      continue;
    }
    if (argument === '--ontology-promotion') {
      options.ontologyPromotion = true;
      continue;
    }
    if (['--environment', '--renderer', '--phase', '--preview-acceptance-receipt'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${argument}`);
      if (argument === '--environment') options.environment = value;
      else if (argument === '--renderer') options.rendererPath = value;
      else if (argument === '--phase') options.phase = value;
      else options.previewAcceptanceReceipt = value;
      index += 1;
      continue;
    }
    throw new Error(`unexpected argument: ${argument}`);
  }
  if (!options.environment) {
    throw new Error('usage: node scripts/deploy-worker.mjs --environment <preview|production> [--phase <prepare|steady>] [--page-evidence-promotion] [--ontology-promotion] [--preview-acceptance-receipt <PATH>] [--renderer <MUTOOL_PATH>]');
  }
  if (!['preview', 'production'].includes(options.environment)) {
    throw new Error(`unsupported deployment environment: ${options.environment}`);
  }
  if (!['prepare', 'steady'].includes(options.phase)) {
    throw new Error(`unsupported deployment phase: ${options.phase}`);
  }
  if (options.previewAcceptanceReceipt
    && (!options.ontologyPromotion || options.environment !== 'production')) {
    throw new Error('preview acceptance receipt is valid only for production ontology promotion');
  }
  return options;
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
