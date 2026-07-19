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

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
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
  const ontologyPath = ontologyReport?.manifest_path;
  const ontologySha256 = ontologyReport?.manifest_sha256;
  const manifestOntology = manifest?.source_tree?.files?.find((entry) => entry.path === ontologyPath);
  if (ontologyPath !== ONTOLOGY_MANIFEST_PATH || !EXACT_SHA256.test(String(ontologySha256 || ''))
    || manifestOntology?.sha256 !== ontologySha256) {
    throw new Error('ontology validation bytes differ from the release manifest source tree');
  }
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

export async function deployWorker({
  environment,
  ontologyPromotion = false,
  previewAcceptanceReceipt = null,
  root = DEFAULT_ROOT,
  runCommand = spawnSync,
  inspectReleaseSource = assertCleanReleaseSource,
  validateOntology = validateOntologyReleaseFile,
  buildManifest = buildReleaseManifest,
  readPreviewAcceptanceReceipt = readOntologyPreviewAcceptanceReceipt,
} = {}) {
  const initialGit = inspectReleaseSource({ root, requireUpstream: true, runCommand });
  const ontologyReport = await validateOntology({
    root,
    requirePublishable: ontologyPromotion,
  });
  assertOntologyReleaseDeploymentGate(ontologyReport, { ontologyPromotion });
  const manifest = await buildManifest({ root, runCommand });
  assertDeploymentSnapshot({
    initialGit,
    manifest,
    ontologyReport,
    finalGit: initialGit,
  });
  assertManifestSourceGates(manifest);
  let acceptanceReceipt = null;
  if (environment === 'production' && ontologyPromotion) {
    if (!previewAcceptanceReceipt) {
      throw new Error('production ontology promotion preview acceptance receipt is required');
    }
    acceptanceReceipt = await readPreviewAcceptanceReceipt({
      root,
      receiptPath: previewAcceptanceReceipt,
      gitHead: initialGit.head,
      ontologyManifestSha256: ontologyReport.manifest_sha256,
    });
  }
  const finalGit = inspectReleaseSource({ root, requireUpstream: true, runCommand });
  assertDeploymentSnapshot({ initialGit, manifest, ontologyReport, finalGit });
  const arguments_ = wranglerDeployArgs(environment, initialGit.head);
  const result = runCommand('npx', arguments_, { cwd: root, encoding: 'utf8', stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Wrangler deployment failed with exit ${result.status ?? 'unknown'}`);
  return {
    environment,
    git_head: initialGit.head,
    ontology_promotion: ontologyPromotion,
    ontology_release_publishable: ontologyReport.publishable,
    preview_acceptance_receipt_sha256: acceptanceReceipt?.receipt_sha256 || null,
  };
}

export function parseArgs(argv) {
  const usage = 'usage: node scripts/deploy-worker.mjs --environment <preview|production> [--ontology-promotion [--preview-acceptance-receipt <PATH>]]';
  if (argv[0] !== '--environment' || !argv[1]) throw new Error(usage);
  if (!['preview', 'production'].includes(argv[1])) {
    throw new Error(`unsupported deployment environment: ${argv[1] || '<unset>'}`);
  }
  let ontologyPromotion = false;
  let previewAcceptanceReceipt = null;
  let index = 2;
  if (argv[index] === '--ontology-promotion') {
    ontologyPromotion = true;
    index += 1;
  }
  if (argv[index] === '--preview-acceptance-receipt') {
    previewAcceptanceReceipt = argv[index + 1];
    if (!previewAcceptanceReceipt || previewAcceptanceReceipt.startsWith('--')) throw new Error(usage);
    index += 2;
  }
  if (index !== argv.length || (previewAcceptanceReceipt && (!ontologyPromotion || argv[1] !== 'production'))) {
    throw new Error(usage);
  }
  return { environment: argv[1], ontologyPromotion, previewAcceptanceReceipt };
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
