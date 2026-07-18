#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson,
  copyTreeStrict,
  inspectTree,
  LOCAL_REPROCESS_SNAPSHOT_MODE,
  validateLocalReprocessSnapshot,
} from './lib/remote-ocr-local-snapshot.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const sha256Pattern = /^[a-f0-9]{64}$/;
const gitCommitPattern = /^[a-f0-9]{40}$/;
const documentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const systemdUnitPattern = /^[A-Za-z0-9][A-Za-z0-9_.@:-]*\.service$/;
const expectedManifestType = 'curriculum_remote_whole_document_ocr_offload_plan';
const maxDocumentAttempts = 5;
const documentRetryBackoffMilliseconds = Object.freeze([2_000, 10_000, 30_000, 60_000]);
const quarantineExitCode = 12;
const seedReceiptType = 'curriculum_remote_ocr_hash_bound_output_seed';
const seedMode = 'hash_bound_output_seed';
const seedConfigurationScope = 'active_writer_with_hash_bound_seed_exceptions';
const seedPredecessorEvidenceDirectory = 'seed-predecessor-evidence';
const seedPredecessorEvidenceType = 'curriculum_remote_ocr_seed_predecessor_controls';
const seedAllowedPredecessorStatuses = new Set(['complete', 'interrupted', 'pending', 'retry_wait', 'quarantined']);
const timeoutRecoveryGrantFilename = 'timeout-recovery-grant.json';
const timeoutRecoveryGrantType = 'curriculum_remote_ocr_timeout_recovery_grant';
const timeoutRecoveryGrantMode = 'one_additional_attempt_per_document';
const timeoutRecoveryGrantedAttempt = maxDocumentAttempts + 1;
const timeoutRecoveryClassification = 'child_idle_timeout_only';
const timeoutRecoveryLedgerIdentityFilename = 'timeout-recovery-ledger-identity.json';
const timeoutRecoveryLedgerType = 'curriculum_remote_ocr_timeout_recovery_consumption_ledger';
const timeoutRecoveryClaimFilename = 'timeout-recovery-consumption-claim.json';
const timeoutRecoveryClaimType = 'curriculum_remote_ocr_timeout_recovery_consumption_claim';
const timeoutRecoveryClaimMode = 'atomic_single_claim';
const legacyB1RunnerScriptSha256 = 'b08c3f7aa3da6e44dd9fffeecaf20b2a020df4d604c9b957399abaf886d15a55';
const llamaHealthTimeoutMilliseconds = 10_000;
const pythonRuntimeProbeTimeoutMilliseconds = 15 * 60 * 1_000;
const requiredPythonPackages = Object.freeze([
  'paddlepaddle',
  'paddleocr',
  'paddlex',
  'pypdfium2',
]);
export const defaultChildMonitoringPolicy = Object.freeze({
  startup_timeout_seconds: 180,
  idle_timeout_seconds: 300,
  wall_floor_seconds: 20 * 60,
  wall_seconds_per_page: 25,
  terminate_grace_seconds: 15,
  poll_interval_seconds: 5,
});

class RetryableOcrFailure extends Error {
  constructor(message) {
    super(message);
    this.name = 'RetryableOcrFailure';
  }
}

export class SharedRuntimeConfigurationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'SharedRuntimeConfigurationError';
  }
}

export class IncompleteOcrDocumentError extends Error {
  constructor(documentId, missingPages, failedPages) {
    super(`${documentId}: valid OCR state remains incomplete; missing pages ${missingPages.join(',') || 'none'}, failed pages ${failedPages.join(',') || 'none'}`);
    this.name = 'IncompleteOcrDocumentError';
    this.missingPages = missingPages;
    this.failedPages = failedPages;
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function requireSha256(value, label) {
  if (!sha256Pattern.test(String(value || ''))) throw new Error(`${label} must be lowercase SHA-256`);
  return value;
}

function requireGitCommit(value, label) {
  if (!gitCommitPattern.test(String(value || ''))) throw new Error(`${label} must be a lowercase 40-character Git commit`);
  return value;
}

export function validateLlamaSystemdUnitName(value) {
  if (
    typeof value !== 'string'
    || value.length > 255
    || !systemdUnitPattern.test(value)
    || value.includes('..')
  ) {
    throw new Error('--llama-systemd-unit must be a safe explicit .service unit name');
  }
  return value;
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isoNow() {
  return new Date().toISOString();
}

function requireLoopbackLlamaUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('--llama-url must be a valid URL');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    throw new Error('--llama-url must be an unauthenticated http://127.0.0.1 URL');
  }
  if (!/^\/v1\/?$/.test(url.pathname) || url.search || url.hash) throw new Error('--llama-url must target the loopback /v1 endpoint');
  if (!url.port || !Number.isSafeInteger(Number(url.port)) || Number(url.port) < 1 || Number(url.port) > 65_535) {
    throw new Error('--llama-url must include an explicit TCP port');
  }
  return url;
}

function parseArguments(argv) {
  const options = {
    llamaUrl: 'http://127.0.0.1:8112/v1',
    vlRecMaxConcurrency: 1,
    serverParallel: 1,
    microBatch: 1,
    useQueues: false,
    childStartupTimeoutSeconds: defaultChildMonitoringPolicy.startup_timeout_seconds,
    childIdleTimeoutSeconds: defaultChildMonitoringPolicy.idle_timeout_seconds,
    childWallFloorSeconds: defaultChildMonitoringPolicy.wall_floor_seconds,
    childWallSecondsPerPage: defaultChildMonitoringPolicy.wall_seconds_per_page,
    childTerminateGraceSeconds: defaultChildMonitoringPolicy.terminate_grace_seconds,
    childPollIntervalSeconds: defaultChildMonitoringPolicy.poll_interval_seconds,
    help: false,
  };
  const stringOptions = new Map([
    ['--manifest', 'manifest'],
    ['--input-root', 'inputRoot'],
    ['--output-root', 'outputRoot'],
    ['--python', 'python'],
    ['--ocr-script', 'ocrScript'],
    ['--model', 'model'],
    ['--mmproj', 'mmproj'],
    ['--llama-repo', 'llamaRepo'],
    ['--llama-server-bin', 'llamaServerBin'],
    ['--llama-systemd-unit', 'llamaSystemdUnit'],
    ['--llama-url', 'llamaUrl'],
    ['--runtime-device', 'runtimeDevice'],
    ['--paddlex-cache-home', 'paddlexCacheHome'],
    ['--seed-from-output-root', 'seedFromOutputRoot'],
    ['--timeout-recovery-ledger', 'timeoutRecoveryLedger'],
  ]);
  const integerOptions = new Map([
    ['--vl-rec-max-concurrency', 'vlRecMaxConcurrency'],
    ['--server-parallel', 'serverParallel'],
    ['--micro-batch', 'microBatch'],
    ['--child-startup-timeout-seconds', 'childStartupTimeoutSeconds'],
    ['--child-idle-timeout-seconds', 'childIdleTimeoutSeconds'],
    ['--child-wall-floor-seconds', 'childWallFloorSeconds'],
    ['--child-wall-seconds-per-page', 'childWallSecondsPerPage'],
    ['--child-terminate-grace-seconds', 'childTerminateGraceSeconds'],
    ['--child-poll-interval-seconds', 'childPollIntervalSeconds'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--use-queues') {
      options.useQueues = true;
      continue;
    }
    if (argument === '--seed-dry-run') {
      options.seedDryRun = true;
      continue;
    }
    if (argument === '--seed-only') {
      options.seedOnly = true;
      continue;
    }
    const target = stringOptions.get(argument) || integerOptions.get(argument);
    if (!target) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    if (integerOptions.has(argument)) options[target] = requirePositiveInteger(Number(value), argument);
    else options[target] = value;
    index += 1;
  }
  if (options.help) return options;
  for (const key of [
    'manifest',
    'inputRoot',
    'outputRoot',
    'python',
    'ocrScript',
    'model',
    'mmproj',
    'llamaRepo',
    'llamaServerBin',
    'llamaSystemdUnit',
    'runtimeDevice',
  ]) {
    if (!options[key]) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  if (options.microBatch > 16) throw new Error('--micro-batch must be between 1 and 16');
  if (options.microBatch > 1 && !options.useQueues) {
    throw new Error('--micro-batch greater than 1 requires --use-queues');
  }
  if ((options.seedDryRun || options.seedOnly) && !options.seedFromOutputRoot) {
    throw new Error('--seed-dry-run and --seed-only require --seed-from-output-root');
  }
  if (options.seedDryRun) options.seedOnly = true;
  requireLoopbackLlamaUrl(options.llamaUrl);
  validateLlamaSystemdUnitName(options.llamaSystemdUnit);
  return options;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function validateExecutableInvocationPath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute executable path`);
  }
  const invocationPath = path.normalize(value);
  const [targetPath, targetStats] = await Promise.all([
    realpath(invocationPath),
    stat(invocationPath),
  ]);
  if (!targetStats.isFile()) throw new Error(`${label} target is not a regular file`);
  if ((targetStats.mode & 0o111) === 0) throw new Error(`${label} target is not executable`);
  try {
    await access(invocationPath, constants.X_OK);
  } catch (error) {
    throw new Error(`${label} target is not executable: ${error.message}`);
  }
  return { invocationPath, targetPath };
}

function sha256Value(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function atomicWrite(pathname, contents) {
  await mkdir(path.dirname(pathname), { recursive: true });
  const temporary = `${pathname}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, pathname);
}

async function syncDirectory(pathname) {
  const handle = await open(pathname, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function durableAtomicWrite(pathname, contents) {
  await atomicWrite(pathname, contents);
  const handle = await open(pathname, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(pathname));
}

async function atomicJson(pathname, value) {
  await atomicWrite(pathname, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(pathname, label = pathname) {
  let value;
  try {
    value = JSON.parse(await readFile(pathname, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw error;
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  return value;
}

export function validateRemoteOcrManifest(manifest) {
  requireObject(manifest, 'manifest');
  if (manifest.schema_version !== 1) throw new Error('manifest schema_version must equal 1');
  if (manifest.manifest_type !== expectedManifestType) throw new Error(`manifest_type must equal ${expectedManifestType}`);
  const policy = requireObject(manifest.quality_policy, 'quality_policy');
  if (policy.stage !== 'remote_primary_ocr_staging_only') throw new Error('manifest stage is not remote OCR staging');
  if (policy.whole_document_atomic !== true) throw new Error('whole_document_atomic must equal true');
  if (policy.citation_allowed !== false) throw new Error('manifest citation_allowed must equal false');
  if (policy.remote_results_require_local_witness_and_exact_audit_before_publication !== true) {
    throw new Error('remote results must require local witness and exact audit');
  }
  const importGates = requireObject(manifest.import_hard_gates, 'import_hard_gates');
  if (importGates.decision !== 'reject_entire_document_if_any_gate_fails') {
    throw new Error('manifest must reject an entire document when any import gate fails');
  }
  const remoteGates = requireObject(importGates.remote_document_revalidation, 'remote_document_revalidation');
  if (remoteGates.citation_allowed_must_equal !== false) {
    throw new Error('remote document citation gate must equal false');
  }
  const requiredHashes = remoteGates.every_page_requires_valid_lowercase_sha256;
  const expectedHashes = ['result_json_sha256', 'content_markdown_sha256', 'rendered_image_sha256'];
  if (!Array.isArray(requiredHashes) || JSON.stringify(requiredHashes) !== JSON.stringify(expectedHashes)) {
    throw new Error('remote page hash gates differ from the audited contract');
  }

  const runtime = requireObject(manifest.runtime, 'runtime');
  if (runtime.pipeline !== 'PaddleOCR-VL' || runtime.pipeline_version !== 'v1.6') {
    throw new Error('runtime must pin PaddleOCR-VL v1.6');
  }
  requireSha256(runtime.model_sha256, 'runtime.model_sha256');
  requireSha256(runtime.mmproj_sha256, 'runtime.mmproj_sha256');
  requireGitCommit(runtime.llama_commit, 'runtime.llama_commit');
  if (runtime.render_dpi !== 240) throw new Error('runtime.render_dpi must equal 240');

  if (!Array.isArray(manifest.documents) || manifest.documents.length === 0) {
    throw new Error('manifest.documents must be a non-empty array');
  }
  const identifiers = new Set();
  const sourcePaths = new Set();
  let pages = 0;
  let bytes = 0;
  for (const document of manifest.documents) {
    requireObject(document, 'manifest document');
    if (!documentIdPattern.test(String(document.id || '')) || document.id === '.' || document.id === '..') {
      throw new Error(`unsafe document id: ${document.id}`);
    }
    if (identifiers.has(document.id)) throw new Error(`duplicate document id: ${document.id}`);
    identifiers.add(document.id);
    if (!document.source_path || path.isAbsolute(document.source_path)) {
      throw new Error(`${document.id}: source_path must be relative`);
    }
    const normalizedSource = path.normalize(document.source_path);
    if (normalizedSource === '..' || normalizedSource.startsWith(`..${path.sep}`)) {
      throw new Error(`${document.id}: source_path escapes input root`);
    }
    if (sourcePaths.has(normalizedSource)) throw new Error(`${document.id}: duplicate source_path`);
    sourcePaths.add(normalizedSource);
    requireSha256(document.source_sha256, `${document.id}.source_sha256`);
    requirePositiveInteger(document.source_bytes, `${document.id}.source_bytes`);
    requirePositiveInteger(document.page_count, `${document.id}.page_count`);
    const pageRange = requireObject(document.required_page_range, `${document.id}.required_page_range`);
    if (pageRange.first !== 1 || pageRange.last !== document.page_count || pageRange.count !== document.page_count) {
      throw new Error(`${document.id}: required page range is not the whole document`);
    }
    const snapshot = requireObject(document.planning_snapshot, `${document.id}.planning_snapshot`);
    if (snapshot.mode === LOCAL_REPROCESS_SNAPSHOT_MODE) {
      validateLocalReprocessSnapshot(document, snapshot);
    } else {
      for (const key of [
        'local_completed_pages',
        'local_failed_pages',
        'local_retry_conflicts',
        'local_production_artifact_conflicts',
      ]) {
        if (snapshot[key] !== 0) throw new Error(`${document.id}: planning snapshot ${key} must equal 0`);
      }
    }
    if (document.citation_allowed !== false) throw new Error(`${document.id}: citation_allowed must equal false`);
    pages += document.page_count;
    bytes += document.source_bytes;
  }
  const counts = requireObject(manifest.counts, 'manifest.counts');
  if (counts.selected_documents !== manifest.documents.length || counts.selected_pages !== pages || counts.selected_source_bytes !== bytes) {
    throw new Error('manifest selected counts do not match manifest.documents');
  }
  return manifest;
}

export async function verifyPinnedRuntime(manifestRuntime, { model, mmproj, llamaRepo }) {
  const [modelPath, mmprojPath, llamaRepoPath] = await Promise.all([
    realpath(model),
    realpath(mmproj),
    realpath(llamaRepo),
  ]);
  const [modelStats, mmprojStats] = await Promise.all([stat(modelPath), stat(mmprojPath)]);
  if (!modelStats.isFile()) throw new Error('model is not a regular file');
  if (!mmprojStats.isFile()) throw new Error('mmproj is not a regular file');
  const [modelSha256, mmprojSha256] = await Promise.all([sha256File(modelPath), sha256File(mmprojPath)]);
  const git = spawnSync('git', ['-C', llamaRepoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (git.status !== 0) throw new Error(`cannot read llama.cpp commit: ${(git.stderr || '').trim() || `exit ${git.status}`}`);
  const llamaCommit = git.stdout.trim();
  requireGitCommit(llamaCommit, 'actual llama.cpp commit');
  const gitStatus = spawnSync('git', ['-C', llamaRepoPath, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
  if (gitStatus.status !== 0) throw new Error(`cannot inspect llama.cpp worktree: ${(gitStatus.stderr || '').trim() || `exit ${gitStatus.status}`}`);
  if (gitStatus.stdout.trim()) throw new Error('llama.cpp has tracked worktree changes; runtime commit is not reproducible');
  const actual = {
    pipeline: 'PaddleOCR-VL',
    pipeline_version: 'v1.6',
    model_sha256: modelSha256,
    mmproj_sha256: mmprojSha256,
    llama_commit: llamaCommit,
    render_dpi: manifestRuntime.render_dpi,
  };
  if (JSON.stringify(actual) !== JSON.stringify(manifestRuntime)) {
    throw new Error(`runtime fingerprint mismatch: expected ${JSON.stringify(manifestRuntime)}, received ${JSON.stringify(actual)}`);
  }
  return actual;
}

function validatePythonRuntimeIdentity(value) {
  const runtime = requireObject(value, 'Python OCR runtime');
  if (runtime.schema_version !== 1) throw new Error('Python OCR runtime schema_version must equal 1');
  for (const key of ['implementation', 'python_version']) {
    if (typeof runtime[key] !== 'string' || !runtime[key].trim()) {
      throw new Error(`Python OCR runtime ${key} must be a non-empty string`);
    }
  }
  const packages = requireObject(runtime.packages, 'Python OCR runtime packages');
  if (JSON.stringify(Object.keys(packages).sort()) !== JSON.stringify([...requiredPythonPackages].sort())) {
    throw new Error('Python OCR runtime package set differs from the pinned contract');
  }
  for (const packageName of requiredPythonPackages) {
    if (typeof packages[packageName] !== 'string' || !packages[packageName].trim()) {
      throw new Error(`Python OCR runtime package ${packageName} has no version`);
    }
  }
  return runtime;
}

export function probePythonOcrRuntime(
  python,
  {
    llamaUrl,
    vlRecMaxConcurrency,
    paddlexCacheHome,
  },
  { runCommand = spawnSync } = {},
) {
  const probe = [
    'import importlib.metadata as metadata',
    'import json',
    'import platform',
    'import sys',
    'import paddle',
    'import paddlex',
    'import pypdfium2',
    'from paddleocr import PaddleOCRVL',
    'PaddleOCRVL(',
    '    pipeline_version="v1.6",',
    '    vl_rec_backend="llama-cpp-server",',
    '    vl_rec_server_url=sys.argv[1],',
    '    vl_rec_max_concurrency=int(sys.argv[2]),',
    '    device="cpu",',
    ')',
    `packages = {name: metadata.version(name) for name in ${JSON.stringify(requiredPythonPackages)}}`,
    'value = {',
    '    "schema_version": 1,',
    '    "implementation": platform.python_implementation(),',
    '    "python_version": platform.python_version(),',
    '    "packages": packages,',
    '}',
    'print("REMOTE_OCR_RUNTIME_JSON=" + json.dumps(value, sort_keys=True))',
  ].join('\n');
  const result = runCommand(python, ['-c', probe, llamaUrl, String(vlRecMaxConcurrency)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PADDLE_PDX_CACHE_HOME: paddlexCacheHome,
      PYTHONUNBUFFERED: '1',
    },
    maxBuffer: 16 * 1024 * 1024,
    timeout: pythonRuntimeProbeTimeoutMilliseconds,
  });
  return parsePythonRuntimeProbeResult(result);
}

function parsePythonRuntimeProbeResult(result) {
  if (result?.error) throw new Error(`Python OCR runtime probe failed: ${result.error.message}`);
  if (result?.status !== 0) {
    throw new Error(`Python OCR runtime probe failed: ${String(result?.stderr || '').trim() || `exit ${result?.status ?? 'unknown'}`}`);
  }
  const marker = String(result.stdout || '')
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.startsWith('REMOTE_OCR_RUNTIME_JSON='));
  if (!marker) throw new Error('Python OCR runtime probe did not return its version identity');
  let parsed;
  try {
    parsed = JSON.parse(marker.slice('REMOTE_OCR_RUNTIME_JSON='.length));
  } catch (error) {
    throw new Error(`Python OCR runtime probe returned invalid JSON: ${error.message}`);
  }
  return validatePythonRuntimeIdentity(parsed);
}

export function probePythonPackageRuntime(
  python,
  { paddlexCacheHome },
  { runCommand = spawnSync } = {},
) {
  const probe = [
    'import importlib.metadata as metadata',
    'import json',
    'import platform',
    `packages = {name: metadata.version(name) for name in ${JSON.stringify(requiredPythonPackages)}}`,
    'value = {',
    '    "schema_version": 1,',
    '    "implementation": platform.python_implementation(),',
    '    "python_version": platform.python_version(),',
    '    "packages": packages,',
    '}',
    'print("REMOTE_OCR_RUNTIME_JSON=" + json.dumps(value, sort_keys=True))',
  ].join('\n');
  const result = runCommand(python, ['-c', probe], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PADDLE_PDX_CACHE_HOME: paddlexCacheHome,
      PYTHONUNBUFFERED: '1',
    },
    maxBuffer: 1024 * 1024,
    timeout: 60_000,
  });
  return parsePythonRuntimeProbeResult(result);
}

function excludedCacheEntry(relativePath) {
  const parts = relativePath.split(path.sep);
  const basename = parts.at(-1);
  return (
    parts.includes('locks')
    || parts.some((part) => part.startsWith('._'))
    || basename === '.cache'
    || basename.endsWith('.lock')
    || basename.endsWith('.part')
    || basename.includes('.tmp')
    || basename.startsWith('.nfs')
  );
}

async function cacheTreeEntries(root, current = root) {
  const entries = [];
  for (const directoryEntry of await readdir(current, { withFileTypes: true })) {
    const absolutePath = path.join(current, directoryEntry.name);
    const relativePath = path.relative(root, absolutePath);
    if (excludedCacheEntry(relativePath)) continue;
    if (directoryEntry.isSymbolicLink()) throw new Error(`PaddleX model cache contains a symlink: ${relativePath}`);
    if (directoryEntry.isDirectory()) {
      entries.push(...await cacheTreeEntries(root, absolutePath));
      continue;
    }
    if (!directoryEntry.isFile()) throw new Error(`PaddleX model cache contains a non-regular entry: ${relativePath}`);
    const fileStats = await lstat(absolutePath);
    entries.push({
      path: relativePath.split(path.sep).join('/'),
      bytes: fileStats.size,
      sha256: await sha256File(absolutePath),
    });
  }
  return entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function validatePaddlexLayoutModelCacheIdentity(value) {
  const identity = requireObject(value, 'PaddleX layout model cache identity');
  if (identity.schema_version !== 1) throw new Error('PaddleX layout model cache schema_version must equal 1');
  if (identity.model_name !== 'PP-DocLayoutV3') throw new Error('PaddleX layout model cache must identify PP-DocLayoutV3');
  if (identity.relative_root !== 'official_models') {
    throw new Error('PaddleX layout model cache relative root mismatch');
  }
  requirePositiveInteger(identity.file_count, 'PaddleX layout model cache file_count');
  requirePositiveInteger(identity.total_bytes, 'PaddleX layout model cache total_bytes');
  requireSha256(identity.tree_sha256, 'PaddleX layout model cache tree_sha256');
  return identity;
}

export async function fingerprintPaddlexLayoutModelCache(paddlexCacheHome) {
  const cacheRoot = await realpath(paddlexCacheHome);
  const relativeRoot = 'official_models';
  const modelRoot = await realpath(path.join(cacheRoot, relativeRoot)).catch((error) => {
    throw new Error(`PP-DocLayoutV3 cache is unavailable after runtime initialization: ${error.message}`);
  });
  if (!isWithin(cacheRoot, modelRoot)) throw new Error('PP-DocLayoutV3 cache escapes PADDLE_PDX_CACHE_HOME');
  const entries = await cacheTreeEntries(modelRoot);
  const requiredFiles = [
    'PP-DocLayoutV3/inference.json',
    'PP-DocLayoutV3/inference.pdiparams',
    'PP-DocLayoutV3/inference.yml',
  ];
  for (const requiredFile of requiredFiles) {
    if (!entries.some((entry) => entry.path === requiredFile && entry.bytes > 0)) {
      throw new Error(`PP-DocLayoutV3 cache is incomplete: missing ${requiredFile}`);
    }
  }
  return validatePaddlexLayoutModelCacheIdentity({
    schema_version: 1,
    model_name: 'PP-DocLayoutV3',
    relative_root: relativeRoot.split(path.sep).join('/'),
    file_count: entries.length,
    total_bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    tree_sha256: sha256Value(`${JSON.stringify(entries)}\n`),
  });
}

function defaultRunCommand(command, arguments_) {
  return spawnSync(command, arguments_, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: llamaHealthTimeoutMilliseconds,
  });
}

function requireSuccessfulCommand(result, label, { includeStderr = false } = {}) {
  if (result?.error) throw new Error(`${label} failed: ${result.error.message}`);
  if (result?.status !== 0) {
    throw new Error(`${label} failed: ${String(result?.stderr || '').trim() || `exit ${result?.status ?? 'unknown'}`}`);
  }
  return `${String(result.stdout || '')}${includeStderr ? String(result.stderr || '') : ''}`;
}

function parseSystemdShow(value) {
  const properties = {};
  for (const line of value.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`unexpected systemctl show row: ${line}`);
    properties[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return properties;
}

function decodeProcCmdline(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const arguments_ = bytes.toString('utf8').split('\0').filter(Boolean);
  if (arguments_.length === 0) throw new Error('llama-server /proc cmdline is empty');
  return { arguments: arguments_, sha256: sha256Value(bytes) };
}

function singleCommandOption(arguments_, names, label) {
  const values = [];
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    for (const name of names) {
      if (argument === name) {
        if (index + 1 >= arguments_.length) throw new Error(`llama-server ${label} option has no value`);
        values.push(arguments_[index + 1]);
      } else if (argument.startsWith(`${name}=`)) {
        values.push(argument.slice(name.length + 1));
      }
    }
  }
  if (values.length !== 1) throw new Error(`llama-server must set ${label} exactly once`);
  return values[0];
}

function requireCommandFlag(arguments_, name) {
  if (arguments_.filter((argument) => argument === name).length !== 1) {
    throw new Error(`llama-server must set ${name} exactly once`);
  }
}

function requireCommandValue(arguments_, name, expected) {
  const actual = singleCommandOption(arguments_, [name], name);
  if (actual !== String(expected)) {
    throw new Error(`llama-server ${name} must equal ${expected}, received ${actual}`);
  }
  return actual;
}

function productionLlamaCommandContract(serverParallel, port) {
  return {
    values: {
      '--host': '127.0.0.1',
      '--port': String(port),
      '--parallel': String(serverParallel),
      '--temp': '0',
      '--ctx-size': String(8_192 * serverParallel),
      '--n-gpu-layers': 'all',
      '--flash-attn': 'auto',
      '--cache-type-k': 'f16',
      '--cache-type-v': 'f16',
      '--batch-size': '2048',
      '--ubatch-size': '512',
      '--fit': 'off',
      '--timeout': '3600',
      '--threads': '8',
      '--threads-batch': '16',
    },
    flags: [
      '--mmproj-offload',
      '--cont-batching',
      '--no-webui',
      '--metrics',
    ],
  };
}

async function defaultLlamaHealthProbe(healthUrl) {
  let response;
  try {
    response = await fetch(healthUrl, { signal: AbortSignal.timeout(llamaHealthTimeoutMilliseconds) });
  } catch (error) {
    throw new Error(`llama-server health probe failed: ${error.message}`);
  }
  const body = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    // llama.cpp normally returns JSON; a plain "ok" response is accepted as ready too.
  }
  const status = typeof parsed?.status === 'string'
    ? parsed.status.toLowerCase()
    : parsed?.ready === true
      ? 'ready'
      : body.trim().toLowerCase();
  if (!response.ok || !['ok', 'ready'].includes(status)) {
    throw new Error(`llama-server health probe is not ready: HTTP ${response.status}, status ${status || 'unknown'}`);
  }
  return {
    statusCode: response.status,
    status,
    bodySha256: sha256Value(body),
  };
}

export async function verifyLlamaServerAttestation(manifestRuntime, options, dependencies = {}) {
  const runCommand = dependencies.runCommand || defaultRunCommand;
  const resolveProcExe = dependencies.resolveProcExe || ((pid) => realpath(`/proc/${pid}/exe`));
  const readProcCmdline = dependencies.readProcCmdline || ((pid) => readFile(`/proc/${pid}/cmdline`));
  const healthProbe = dependencies.healthProbe || defaultLlamaHealthProbe;
  const unit = validateLlamaSystemdUnitName(options.llamaSystemdUnit);
  const llamaUrl = requireLoopbackLlamaUrl(options.llamaUrl);
  requirePositiveInteger(options.serverParallel, '--server-parallel');

  const [llamaRepo, serverBinary, model, mmproj] = await Promise.all([
    realpath(options.llamaRepo),
    realpath(options.llamaServerBin),
    realpath(options.model),
    realpath(options.mmproj),
  ]);
  if (!isWithin(llamaRepo, serverBinary)) {
    throw new Error('llama-server binary must resolve inside the pinned llama.cpp repository');
  }
  const binaryStats = await stat(serverBinary);
  if (!binaryStats.isFile()) throw new Error('llama-server binary is not a regular file');
  if ((binaryStats.mode & 0o111) === 0) throw new Error('llama-server binary is not executable');

  const systemdOutput = requireSuccessfulCommand(
    runCommand('systemctl', [
      '--user',
      'show',
      unit,
      '--property=ActiveState',
      '--property=SubState',
      '--property=MainPID',
    ]),
    `systemctl --user show ${unit}`,
  );
  const systemd = parseSystemdShow(systemdOutput);
  if (systemd.ActiveState !== 'active' || systemd.SubState !== 'running') {
    throw new Error(`${unit} must be active/running, received ${systemd.ActiveState || 'unknown'}/${systemd.SubState || 'unknown'}`);
  }
  const mainPid = Number(systemd.MainPID);
  requirePositiveInteger(mainPid, `${unit} MainPID`);

  const procExe = await resolveProcExe(mainPid);
  if (procExe !== serverBinary) {
    throw new Error(`${unit} MainPID executable mismatch: expected ${serverBinary}, received ${procExe}`);
  }
  const rawCmdline = await readProcCmdline(mainPid);
  const cmdline = decodeProcCmdline(rawCmdline);
  const modelArgument = singleCommandOption(cmdline.arguments, ['--model', '-m'], 'model');
  const mmprojArgument = singleCommandOption(cmdline.arguments, ['--mmproj'], '--mmproj');
  if (!path.isAbsolute(modelArgument) || await realpath(modelArgument) !== model) {
    throw new Error('llama-server model argument does not resolve to the pinned model');
  }
  if (!path.isAbsolute(mmprojArgument) || await realpath(mmprojArgument) !== mmproj) {
    throw new Error('llama-server --mmproj does not resolve to the pinned mmproj');
  }
  const commandContract = productionLlamaCommandContract(options.serverParallel, Number(llamaUrl.port));
  for (const [name, expected] of Object.entries(commandContract.values)) {
    requireCommandValue(cmdline.arguments, name, expected);
  }
  for (const flag of commandContract.flags) requireCommandFlag(cmdline.arguments, flag);

  const binarySha256 = await sha256File(serverBinary);
  const versionOutput = requireSuccessfulCommand(
    runCommand(serverBinary, ['--version']),
    'llama-server --version',
    { includeStderr: true },
  ).trim();
  const commitPrefix = manifestRuntime.llama_commit.slice(0, 8);
  if (!versionOutput.includes(commitPrefix)) {
    throw new Error(`llama-server --version does not contain pinned commit prefix ${commitPrefix}`);
  }

  const healthUrl = `${llamaUrl.origin}/health`;
  const health = requireObject(await healthProbe(healthUrl), 'llama-server health result');
  if (
    !Number.isSafeInteger(health.statusCode)
    || health.statusCode < 200
    || health.statusCode >= 300
    || !['ok', 'ready'].includes(health.status)
  ) {
    throw new Error('llama-server health result is not ready');
  }
  requireSha256(health.bodySha256, 'llama-server health body SHA-256');

  return {
    schema_version: 1,
    systemd_unit: unit,
    active_state: systemd.ActiveState,
    sub_state: systemd.SubState,
    binary_path: serverBinary,
    binary_sha256: binarySha256,
    version_sha256: sha256Value(versionOutput),
    llama_commit_prefix: commitPrefix,
    proc_cmdline_sha256: cmdline.sha256,
    model_path: model,
    model_sha256: manifestRuntime.model_sha256,
    mmproj_path: mmproj,
    mmproj_sha256: manifestRuntime.mmproj_sha256,
    host: '127.0.0.1',
    port: Number(llamaUrl.port),
    parallel: options.serverParallel,
    production_command_contract: commandContract,
    health_url: healthUrl,
    health_status_code: health.statusCode,
    health_status: health.status,
    health_body_sha256: health.bodySha256,
  };
}

export function pdfPageCount(python, inputPdf) {
  const code = 'import pypdfium2 as p,sys; d=p.PdfDocument(sys.argv[1]); print(len(d))';
  const result = spawnSync(python, ['-c', code, inputPdf], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`PDF page-count probe failed: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
  }
  const value = Number(result.stdout.trim());
  return requirePositiveInteger(value, 'actual PDF page count');
}

export async function preflightDocument(document, { inputRoot, python, pageCounter = pdfPageCount }) {
  const inputRootPath = await realpath(inputRoot);
  const lexicalPath = path.resolve(inputRootPath, document.source_path);
  if (!isWithin(inputRootPath, lexicalPath)) throw new Error(`${document.id}: source_path escapes input root`);
  const sourcePath = await realpath(lexicalPath).catch((error) => {
    throw new Error(`${document.id}: source unavailable: ${error.message}`);
  });
  if (!isWithin(inputRootPath, sourcePath)) throw new Error(`${document.id}: source symlink escapes input root`);
  const sourceStats = await stat(sourcePath);
  if (!sourceStats.isFile()) throw new Error(`${document.id}: source is not a regular file`);
  if (sourceStats.size !== document.source_bytes) throw new Error(`${document.id}: source byte count differs from manifest`);
  const sourceSha256 = await sha256File(sourcePath);
  if (sourceSha256 !== document.source_sha256) throw new Error(`${document.id}: source SHA-256 differs from manifest`);
  let pageCount;
  try {
    pageCount = pageCounter(python, sourcePath);
  } catch (error) {
    throw new SharedRuntimeConfigurationError(
      `${document.id}: shared PDF page-count probe runtime failed: ${error.message}`,
      { cause: error },
    );
  }
  if (pageCount !== document.page_count) throw new Error(`${document.id}: PDF page count differs from manifest`);
  return { sourcePath, sourceSha256, pageCount };
}

function pageNumbers(pageCount) {
  return Array.from({ length: pageCount }, (_, index) => index + 1);
}

function exactIntegerSet(values, pageCount, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const unique = [...new Set(values)];
  if (unique.length !== values.length || unique.some((page) => !Number.isSafeInteger(page) || page < 1 || page > pageCount)) {
    throw new Error(`${label} contains duplicate or invalid page numbers`);
  }
  return [...unique].sort((left, right) => left - right);
}

function stateConfigurationContract(runtime, workerConfiguration) {
  validatePythonRuntimeIdentity(workerConfiguration.python_runtime);
  return {
    pipeline: runtime.pipeline,
    pipeline_version: runtime.pipeline_version,
    layout_model: 'PP-DocLayoutV3',
    recognizer: 'PaddleOCR-VL-1.6-0.9B official GGUF',
    recognizer_backend: 'llama-cpp-server',
    recognizer_server_url: workerConfiguration.llama_url,
    dpi: runtime.render_dpi,
    device: workerConfiguration.runtime_device,
    python: workerConfiguration.python_runtime.python_version,
    paddlepaddle: workerConfiguration.python_runtime.packages.paddlepaddle,
    paddleocr: workerConfiguration.python_runtime.packages.paddleocr,
    paddlex: workerConfiguration.python_runtime.packages.paddlex,
    vl_rec_max_concurrency: workerConfiguration.vl_rec_max_concurrency,
    server_parallel: workerConfiguration.server_parallel,
    micro_batch: workerConfiguration.micro_batch,
    use_queues: workerConfiguration.use_queues,
  };
}

function validateStateSeedLineage(document, state, completedPages) {
  if (state.seed_lineage === undefined) {
    if (state.configuration_scope !== undefined) {
      throw new Error(`${document.id}: OCR configuration scope exists without seed lineage`);
    }
    for (const page of completedPages) {
      if (state.pages[String(page)]?.seed_provenance !== undefined) {
        throw new Error(`${document.id}: unseeded OCR page ${page} contains seed provenance`);
      }
    }
    return null;
  }
  const lineage = requireObject(state.seed_lineage, `${document.id} seed_lineage`);
  if (state.configuration_scope !== seedConfigurationScope
    || lineage.schema_version !== 1
    || lineage.mode !== seedMode
    || lineage.citation_allowed !== false) {
    throw new Error(`${document.id}: seeded OCR state scope or lineage identity is invalid`);
  }
  requireSha256(lineage.seed_id, `${document.id} seed_lineage.seed_id`);
  requireSha256(
    lineage.predecessor_run_identity_sha256,
    `${document.id} seed_lineage.predecessor_run_identity_sha256`,
  );
  requireSha256(
    lineage.predecessor_configuration_sha256,
    `${document.id} seed_lineage.predecessor_configuration_sha256`,
  );
  const inheritedPages = exactIntegerSet(
    lineage.inherited_completed_pages,
    document.page_count,
    `${document.id}.seed_lineage.inherited_completed_pages`,
  );
  if (!sameJsonValue(inheritedPages, lineage.inherited_completed_pages)
    || inheritedPages.some((page) => !completedPages.includes(page))) {
    throw new Error(`${document.id}: seeded OCR inherited page set is invalid`);
  }
  const inherited = new Set(inheritedPages);
  for (const page of completedPages) {
    const provenance = state.pages[String(page)]?.seed_provenance;
    if (!inherited.has(page)) {
      if (provenance !== undefined) {
        throw new Error(`${document.id}: newly written page ${page} must not carry seed provenance`);
      }
      continue;
    }
    if (!provenance
      || provenance.seed_id !== lineage.seed_id
      || provenance.predecessor_run_identity_sha256 !== lineage.predecessor_run_identity_sha256
      || provenance.predecessor_configuration_sha256 !== lineage.predecessor_configuration_sha256) {
      throw new Error(`${document.id}: inherited page ${page} seed provenance mismatch`);
    }
  }
  return lineage;
}

function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function validateOcrDocumentOutput(
  document,
  documentRoot,
  runtime,
  { requireComplete = true, workerConfiguration } = {},
) {
  const statePath = path.join(documentRoot, 'state.json');
  const state = requireObject(await readJson(statePath, `${document.id} OCR state`), `${document.id} OCR state`);
  if (state.document_id !== document.id) throw new Error(`${document.id}: OCR state document id mismatch`);
  if (state.source_sha256 !== document.source_sha256) throw new Error(`${document.id}: OCR state source SHA-256 mismatch`);
  if (state.page_count !== document.page_count) throw new Error(`${document.id}: OCR state page count mismatch`);
  const configuration = requireObject(state.configuration, `${document.id} OCR configuration`);
  if (configuration.pipeline !== runtime.pipeline || configuration.pipeline_version !== runtime.pipeline_version) {
    throw new Error(`${document.id}: OCR pipeline fingerprint mismatch`);
  }
  if (configuration.layout_model !== 'PP-DocLayoutV3' || configuration.recognizer !== 'PaddleOCR-VL-1.6-0.9B official GGUF') {
    throw new Error(`${document.id}: OCR model fingerprint mismatch`);
  }
  if (configuration.dpi !== runtime.render_dpi) throw new Error(`${document.id}: OCR render DPI mismatch`);
  if (configuration.recognizer_backend !== 'llama-cpp-server') throw new Error(`${document.id}: OCR recognizer backend mismatch`);
  requireObject(workerConfiguration, `${document.id} expected worker configuration`);
  const configurationContract = stateConfigurationContract(runtime, workerConfiguration);
  for (const [key, expected] of Object.entries(configurationContract)) {
    if (configuration[key] !== expected) throw new Error(`${document.id}: OCR worker configuration mismatch for ${key}`);
  }
  const completedPages = exactIntegerSet(state.completed_pages, document.page_count, `${document.id}.completed_pages`);
  const failedPages = requireObject(state.failed_pages, `${document.id}.failed_pages`);
  const failedPageNumbers = Object.keys(failedPages).map(Number);
  if (failedPageNumbers.some((page) => !Number.isSafeInteger(page) || page < 1 || page > document.page_count)) {
    throw new Error(`${document.id}: failed_pages contains an invalid page number`);
  }
  if (failedPageNumbers.some((page) => completedPages.includes(page))) {
    throw new Error(`${document.id}: a page cannot be both completed and failed`);
  }
  const pages = requireObject(state.pages, `${document.id}.pages`);
  const pageKeys = Object.keys(pages).sort((left, right) => Number(left) - Number(right));
  if (JSON.stringify(pageKeys) !== JSON.stringify(completedPages.map(String))) {
    throw new Error(`${document.id}: OCR page metadata set differs from completed_pages`);
  }
  validateStateSeedLineage(document, state, completedPages);

  const pageArtifacts = [];
  for (const pageNumber of completedPages) {
    const pageKey = String(pageNumber);
    const page = requireObject(pages[pageKey], `${document.id} page ${pageNumber}`);
    if (page.status !== 'ocr_complete_pending_audit' || page.physical_pdf_page !== pageNumber) {
      throw new Error(`${document.id}: page ${pageNumber} status or physical page mismatch`);
    }
    if (page.citation_eligible !== false) throw new Error(`${document.id}: page ${pageNumber} is not citation-fail-closed`);
    requireSha256(page.rendered_image_sha256, `${document.id} page ${pageNumber} rendered image SHA-256`);
    requireSha256(page.result_json_sha256, `${document.id} page ${pageNumber} result SHA-256`);
    requireSha256(page.content_markdown_sha256, `${document.id} page ${pageNumber} Markdown SHA-256`);
    const pageRoot = path.join(documentRoot, 'pages', String(pageNumber).padStart(4, '0'));
    const resultPath = path.join(pageRoot, 'result.json');
    const markdownPath = path.join(pageRoot, 'content.md');
    await readJson(resultPath, `${document.id} page ${pageNumber} result`);
    const [resultJsonSha256, contentMarkdownSha256] = await Promise.all([
      sha256File(resultPath),
      sha256File(markdownPath),
    ]);
    if (resultJsonSha256 !== page.result_json_sha256 || contentMarkdownSha256 !== page.content_markdown_sha256) {
      throw new Error(`${document.id}: page ${pageNumber} artifact hash mismatch`);
    }
    pageArtifacts.push({
      page_number: pageNumber,
      rendered_image_sha256: page.rendered_image_sha256,
      result_json_sha256: resultJsonSha256,
      content_markdown_sha256: contentMarkdownSha256,
      citation_eligible: false,
    });
  }

  if (requireComplete) {
    const expected = pageNumbers(document.page_count);
    if (JSON.stringify(state.selected_pages) !== JSON.stringify(expected)) {
      throw new Error(`${document.id}: selected page set is not the whole document`);
    }
    const missingPages = expected.filter((page) => !completedPages.includes(page));
    if (missingPages.length > 0) {
      if (state.selected_pages_complete !== false) {
        throw new Error(`${document.id}: incomplete page set is marked complete`);
      }
      throw new IncompleteOcrDocumentError(document.id, missingPages, failedPageNumbers.sort((left, right) => left - right));
    }
    if (Object.keys(failedPages).length !== 0) throw new Error(`${document.id}: failed_pages is not empty after complete page coverage`);
    if (state.selected_pages_complete !== true) {
      throw new Error(`${document.id}: complete page set is not marked complete`);
    }
  }

  return {
    state_sha256: await sha256File(statePath),
    page_artifacts_sha256: sha256Value(`${JSON.stringify(pageArtifacts)}\n`),
    page_artifacts: pageArtifacts,
  };
}

async function writeStatus(outputRoot, documentId, value) {
  const statusPath = path.join(outputRoot, 'status', `${documentId}.json`);
  await atomicJson(statusPath, value);
  const digest = await sha256File(statusPath);
  await atomicWrite(`${statusPath}.sha256`, `${digest}  ${path.basename(statusPath)}\n`);
  return digest;
}

async function writeRunStatus(outputRoot, value) {
  const statusPath = path.join(outputRoot, 'run-status.json');
  await atomicJson(statusPath, value);
  const digest = await sha256File(statusPath);
  await atomicWrite(`${statusPath}.sha256`, `${digest}  ${path.basename(statusPath)}\n`);
  return digest;
}

async function verifySha256Sidecar(pathname, label) {
  const sidecarPath = `${pathname}.sha256`;
  let sidecar;
  try {
    sidecar = await readFile(sidecarPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${label} SHA-256 sidecar is missing`);
    throw error;
  }
  const expectedLine = /^([a-f0-9]{64})  ([^\r\n]+)\n$/u.exec(sidecar);
  if (!expectedLine || expectedLine[2] !== path.basename(pathname)) {
    throw new Error(`${label} SHA-256 sidecar has an invalid format`);
  }
  const actual = await sha256File(pathname);
  if (actual !== expectedLine[1]) throw new Error(`${label} SHA-256 sidecar mismatch`);
  return actual;
}

function jsonContents(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeJsonWithSidecar(pathname, value) {
  const contents = jsonContents(value);
  await atomicWrite(pathname, contents);
  const digest = sha256Value(contents);
  await atomicWrite(`${pathname}.sha256`, `${digest}  ${path.basename(pathname)}\n`);
  return digest;
}

async function requireRealDirectory(pathname, label) {
  const info = await lstat(pathname).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing`);
    throw error;
  });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  return realpath(pathname);
}

async function requireRegularFile(pathname, label) {
  const info = await lstat(pathname).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing`);
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  return info;
}

async function requireContainedRealDirectory(root, pathname, label) {
  const resolved = await requireRealDirectory(pathname, label);
  if (resolved !== path.resolve(pathname) || !isWithin(root, resolved)) {
    throw new Error(`${label} must resolve directly inside its owned root`);
  }
  return resolved;
}

async function readStrictFile(root, pathname, label) {
  await requireRegularFile(pathname, label);
  const resolved = await realpath(pathname);
  if (resolved !== path.resolve(pathname) || !isWithin(root, resolved)) {
    throw new Error(`${label} must resolve directly inside its owned root`);
  }
  return readFile(resolved);
}

function parseSha256Sidecar(raw, pathname, label) {
  const sidecar = raw.toString('utf8');
  const expectedLine = /^([a-f0-9]{64})  ([^\r\n]+)\n$/u.exec(sidecar);
  if (!expectedLine || expectedLine[2] !== path.basename(pathname)) {
    throw new Error(`${label} SHA-256 sidecar has an invalid format`);
  }
  return expectedLine[1];
}

async function readStrictFileWithSidecar(root, pathname, label) {
  const [raw, sidecarRaw] = await Promise.all([
    readStrictFile(root, pathname, label),
    readStrictFile(root, `${pathname}.sha256`, `${label} SHA-256 sidecar`),
  ]);
  const expected = parseSha256Sidecar(sidecarRaw, pathname, label);
  const digest = sha256Value(raw);
  if (digest !== expected) throw new Error(`${label} SHA-256 sidecar mismatch`);
  return { raw, sidecarRaw, digest };
}

function seedProgressRecord(progress, document) {
  requireObject(progress, `${document.id} predecessor run status`);
  if (!seedAllowedPredecessorStatuses.has(progress.status)) {
    throw new Error(`${document.id}: predecessor status ${progress.status} is not seedable`);
  }
  if (!Number.isSafeInteger(progress.attempts)
    || progress.attempts < 0
    || progress.attempts > maxDocumentAttempts
    || progress.page_count !== document.page_count) {
    throw new Error(`${document.id}: predecessor attempt or page-count identity is invalid`);
  }
  if (progress.status === 'pending' && progress.attempts !== 0) {
    throw new Error(`${document.id}: pending predecessor cannot have attempts`);
  }
  if (progress.status !== 'pending' && progress.attempts < 1) {
    throw new Error(`${document.id}: attempted predecessor status requires a positive attempt floor`);
  }
  return progress;
}

function classifySeedPredecessorStatus(identity, progress, status, statusSha256, document) {
  if (progress.status_json_sha256 !== statusSha256
    || status.schema_version !== 1
    || status.document_id !== document.id
    || status.status !== progress.status
    || status.citation_allowed !== false) {
    throw new Error(`${document.id}: predecessor document status identity mismatch`);
  }
  const keys = Object.keys(status).sort();
  const retryWaitKeys = [
    'attempt',
    'citation_allowed',
    'document_id',
    'error',
    'failed_at',
    'max_attempts',
    'next_retry_at',
    'page_count',
    'retry_delay_seconds',
    'runtime_fingerprint_sha256',
    'schema_version',
    'status',
  ].sort();
  if (progress.status === 'retry_wait'
    && sameJsonValue(keys, retryWaitKeys)
    && status.attempt === progress.attempts
    && status.max_attempts === maxDocumentAttempts
    && status.page_count === document.page_count
    && status.runtime_fingerprint_sha256 === identity.runtime_fingerprint_sha256
    && status.next_retry_at === progress.next_retry_at
    && status.error === progress.error
    && status.failed_at === progress.failed_at
    && documentRetryBackoffMilliseconds.includes(status.retry_delay_seconds * 1_000)) {
    return 'complete_identity_v1';
  }
  if (identity.runner_script_sha256 !== legacyB1RunnerScriptSha256) {
    throw new Error(`${document.id}: incomplete predecessor status identity is not from the exact B-r1 runner`);
  }
  const legacyCompleteKeys = [
    'artifacts',
    'citation_allowed',
    'document_id',
    'page_count',
    'runtime_fingerprint_sha256',
    'schema_version',
    'source_sha256',
    'status',
    'verified_at',
    'whole_document_atomic',
  ].sort();
  if (progress.status === 'complete'
    && sameJsonValue(keys, legacyCompleteKeys)
    && status.attempt === undefined
    && status.max_attempts === undefined
    && status.page_count === document.page_count
    && status.runtime_fingerprint_sha256 === identity.runtime_fingerprint_sha256
    && status.source_sha256 === document.source_sha256
    && status.whole_document_atomic === true
    && typeof status.verified_at === 'string'
    && status.verified_at === progress.verified_at) {
    return 'legacy_b1_complete_reverified';
  }
  const legacyInterruptedKeys = [
    'attempt',
    'citation_allowed',
    'document_id',
    'interrupted_at',
    'max_attempts',
    'schema_version',
    'status',
  ].sort();
  if (progress.status === 'interrupted'
    && sameJsonValue(keys, legacyInterruptedKeys)
    && status.attempt === progress.attempts
    && status.max_attempts === maxDocumentAttempts
    && status.page_count === undefined
    && status.runtime_fingerprint_sha256 === undefined
    && typeof status.interrupted_at === 'string'
    && status.interrupted_at === progress.interrupted_at) {
    return 'legacy_b1_interrupted';
  }
  const timeoutQuarantineKeys = [
    'attempt',
    'citation_allowed',
    'document_id',
    'error',
    'max_attempts',
    'page_count',
    'quarantine_reason',
    'quarantined_at',
    'runtime_fingerprint_sha256',
    'schema_version',
    'status',
  ].sort();
  if (progress.status === 'quarantined'
    && sameJsonValue(keys, timeoutQuarantineKeys)
    && progress.attempts === maxDocumentAttempts
    && status.attempt === maxDocumentAttempts
    && status.max_attempts === maxDocumentAttempts
    && status.page_count === document.page_count
    && status.runtime_fingerprint_sha256 === identity.runtime_fingerprint_sha256
    && status.quarantine_reason === 'attempt_budget_exhausted'
    && progress.quarantine_reason === status.quarantine_reason
    && progress.quarantined_at === status.quarantined_at
    && progress.error === status.error
    && typeof status.quarantined_at === 'string'
    && Number.isFinite(Date.parse(status.quarantined_at))
    && /^OCR child idle_timeout after [1-9]\d*s; terminated with SIGTERM(?: then SIGKILL)?$/u.test(status.error)) {
    return 'timeout_only_quarantine_granted_v1';
  }
  throw new Error(`${document.id}: predecessor document status identity mismatch`);
}

function firstMissingPhysicalPage(completedPages, pageCount) {
  const completed = new Set(completedPages);
  for (let page = 1; page <= pageCount; page += 1) {
    if (!completed.has(page)) return page;
  }
  return null;
}

function exactObjectKeys(value, expectedKeys, label) {
  requireObject(value, label);
  if (!sameJsonValue(Object.keys(value).sort(), [...expectedKeys].sort())) {
    throw new Error(`${label} has an invalid field set`);
  }
  return value;
}

async function captureTimeoutRecoveryGrant({
  root,
  manifest,
  manifestSha256,
  identityRaw,
  runStatusSha256,
  documents,
}) {
  const quarantinedDocuments = documents.filter(
    (document) => document.predecessor_status === 'quarantined',
  );
  const grantPath = path.join(root, timeoutRecoveryGrantFilename);
  const sidecarPath = `${grantPath}.sha256`;
  const [grantPresent, sidecarPresent] = await Promise.all([
    lstat(grantPath).then(() => true, (error) => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }),
    lstat(sidecarPath).then(() => true, (error) => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }),
  ]);
  if (quarantinedDocuments.length === 0) {
    if (grantPresent || sidecarPresent) {
      throw new Error('timeout recovery grant is forbidden when the predecessor has no quarantined documents');
    }
    return null;
  }
  if (!grantPresent || !sidecarPresent) {
    throw new Error('quarantined predecessor requires timeout-recovery-grant.json and its SHA-256 sidecar');
  }
  const grantEvidence = await readStrictFileWithSidecar(root, grantPath, 'timeout recovery grant');
  let grant;
  try {
    grant = JSON.parse(grantEvidence.raw);
  } catch (error) {
    throw new Error(`timeout recovery grant JSON is invalid: ${error.message}`);
  }
  exactObjectKeys(grant, [
    'schema_version',
    'grant_type',
    'mode',
    'grant_id',
    'predecessor',
    'policy',
    'consumption',
    'documents',
    'citation_allowed',
  ], 'timeout recovery grant');
  if (grant.schema_version !== 1
    || grant.grant_type !== timeoutRecoveryGrantType
    || grant.mode !== timeoutRecoveryGrantMode
    || grant.citation_allowed !== false) {
    throw new Error('timeout recovery grant type, mode, or fail-closed policy is invalid');
  }
  requireSha256(grant.grant_id, 'timeout recovery grant ID');
  const grantBasis = structuredClone(grant);
  delete grantBasis.grant_id;
  if (grant.grant_id !== sha256Value(canonicalJson(grantBasis))) {
    throw new Error('timeout recovery grant ID does not match its canonical contents');
  }
  const predecessor = exactObjectKeys(
    grant.predecessor,
    ['manifest_sha256', 'run_identity_sha256', 'run_status_sha256'],
    'timeout recovery grant predecessor',
  );
  if (predecessor.manifest_sha256 !== manifestSha256
    || predecessor.run_identity_sha256 !== sha256Value(identityRaw)
    || predecessor.run_status_sha256 !== runStatusSha256) {
    throw new Error('timeout recovery grant predecessor identity mismatch');
  }
  const expectedPolicy = {
    required_status: 'quarantined',
    required_inherited_attempts: maxDocumentAttempts,
    granted_attempt: timeoutRecoveryGrantedAttempt,
    additional_attempts_per_document: 1,
    automatic_attempt_7: false,
    scope: 'all_timeout_quarantined_documents',
  };
  if (canonicalJson(grant.policy) !== canonicalJson(expectedPolicy)) {
    throw new Error('timeout recovery grant policy is not the exact one-attempt fail-closed policy');
  }
  const consumption = exactObjectKeys(
    grant.consumption,
    [
      'ledger_id',
      'ledger_root',
      'ledger_device',
      'ledger_inode',
      'claim_mode',
    ],
    'timeout recovery grant consumption policy',
  );
  requireSha256(consumption.ledger_id, 'timeout recovery consumption ledger ID');
  if (consumption.claim_mode !== timeoutRecoveryClaimMode
    || typeof consumption.ledger_root !== 'string'
    || !path.isAbsolute(consumption.ledger_root)
    || !/^\d+$/u.test(consumption.ledger_device)
    || !/^\d+$/u.test(consumption.ledger_inode)) {
    throw new Error('timeout recovery grant consumption mode is not atomic single-claim');
  }
  if (!Array.isArray(grant.documents)) {
    throw new Error('timeout recovery grant documents must be an ordered array');
  }
  const expectedDocumentIds = manifest.documents
    .filter((manifestDocument) => quarantinedDocuments.some(
      (document) => document.document_id === manifestDocument.id,
    ))
    .map((document) => document.id);
  if (!sameJsonValue(grant.documents.map((document) => document?.document_id), expectedDocumentIds)) {
    throw new Error('timeout recovery grant must cover the exact quarantined document set in manifest order');
  }

  for (const grantDocument of grant.documents) {
    exactObjectKeys(grantDocument, [
      'document_id',
      'predecessor_status_sha256',
      'predecessor_state_sha256',
      'inherited_attempts',
      'granted_attempt',
      'first_missing_page',
      'completed_pages_sha256',
      'failed_pages_sha256',
      'quarantine_reason',
      'error_sha256',
      'classification',
      'timeout_log',
    ], `${grantDocument.document_id || 'unknown'} timeout recovery grant document`);
    const predecessorDocument = quarantinedDocuments.find(
      (document) => document.document_id === grantDocument.document_id,
    );
    const firstMissingPage = firstMissingPhysicalPage(
      predecessorDocument.completed_pages,
      predecessorDocument.page_count,
    );
    if (firstMissingPage === null) {
      throw new Error(`${grantDocument.document_id}: a complete document cannot receive timeout recovery`);
    }
    const expectedCompletedPages = Array.from(
      { length: firstMissingPage - 1 },
      (_, index) => index + 1,
    );
    if (!sameJsonValue(predecessorDocument.completed_pages, expectedCompletedPages)) {
      throw new Error(`${grantDocument.document_id}: timeout recovery requires a contiguous completed-page frontier`);
    }
    if (grantDocument.predecessor_status_sha256 !== predecessorDocument.predecessor_status_sha256
      || grantDocument.predecessor_state_sha256 !== predecessorDocument.predecessor_state_sha256
      || grantDocument.inherited_attempts !== maxDocumentAttempts
      || grantDocument.granted_attempt !== timeoutRecoveryGrantedAttempt
      || grantDocument.first_missing_page !== firstMissingPage
      || grantDocument.completed_pages_sha256 !== sha256Value(canonicalJson(predecessorDocument.completed_pages))
      || grantDocument.failed_pages_sha256 !== sha256Value(canonicalJson(predecessorDocument.state.failed_pages))
      || grantDocument.quarantine_reason !== 'attempt_budget_exhausted'
      || grantDocument.error_sha256 !== sha256Value(predecessorDocument.status.error)
      || grantDocument.classification !== timeoutRecoveryClassification) {
      throw new Error(`${grantDocument.document_id}: timeout recovery grant document identity mismatch`);
    }
    const timeoutLog = exactObjectKeys(
      grantDocument.timeout_log,
      ['path', 'bytes', 'sha256'],
      `${grantDocument.document_id} timeout recovery log`,
    );
    const expectedLogPath = `logs/${grantDocument.document_id}.log`;
    if (timeoutLog.path !== expectedLogPath
      || !Number.isSafeInteger(timeoutLog.bytes)
      || timeoutLog.bytes < 0) {
      throw new Error(`${grantDocument.document_id}: timeout recovery log path or size is invalid`);
    }
    requireSha256(timeoutLog.sha256, `${grantDocument.document_id} timeout recovery log SHA-256`);
    const timeoutLogRaw = await readStrictFile(
      root,
      path.join(root, timeoutLog.path),
      `${grantDocument.document_id} timeout recovery log`,
    );
    if (timeoutLogRaw.byteLength !== timeoutLog.bytes
      || sha256Value(timeoutLogRaw) !== timeoutLog.sha256) {
      throw new Error(`${grantDocument.document_id}: timeout recovery log identity mismatch`);
    }
    predecessorDocument.timeout_log = structuredClone(timeoutLog);
    predecessorDocument.timeout_log_raw = timeoutLogRaw;
  }
  return {
    grant,
    raw: grantEvidence.raw,
    sidecarRaw: grantEvidence.sidecarRaw,
    rawSha256: grantEvidence.digest,
    sidecarSha256: sha256Value(grantEvidence.sidecarRaw),
  };
}

async function loadTimeoutRecoveryLedger(ledgerPath, grant) {
  if (!ledgerPath) {
    throw new Error('timeout recovery grant requires --timeout-recovery-ledger');
  }
  const root = await requireRealDirectory(ledgerPath, 'timeout recovery consumption ledger');
  const identityPath = path.join(root, 'ledger-identity.json');
  const evidence = await readStrictFileWithSidecar(
    root,
    identityPath,
    'timeout recovery consumption ledger identity',
  );
  let identity;
  try {
    identity = JSON.parse(evidence.raw);
  } catch (error) {
    throw new Error(`timeout recovery consumption ledger identity JSON is invalid: ${error.message}`);
  }
  exactObjectKeys(identity, [
    'schema_version',
    'ledger_type',
    'ledger_nonce',
    'ledger_id',
    'citation_allowed',
  ], 'timeout recovery consumption ledger identity');
  requireSha256(identity.ledger_nonce, 'timeout recovery consumption ledger nonce');
  requireSha256(identity.ledger_id, 'timeout recovery consumption ledger ID');
  const identityBasis = structuredClone(identity);
  delete identityBasis.ledger_id;
  if (identity.schema_version !== 1
    || identity.ledger_type !== timeoutRecoveryLedgerType
    || identity.citation_allowed !== false
    || identity.ledger_id !== sha256Value(canonicalJson(identityBasis))) {
    throw new Error('timeout recovery consumption ledger identity is invalid');
  }
  if (identity.ledger_id !== grant.consumption.ledger_id) {
    throw new Error('timeout recovery grant is bound to a different consumption ledger');
  }
  const ledgerInfo = await stat(root, { bigint: true });
  if (grant.consumption.ledger_root !== root
    || grant.consumption.ledger_device !== String(ledgerInfo.dev)
    || grant.consumption.ledger_inode !== String(ledgerInfo.ino)) {
    throw new Error('timeout recovery grant is bound to a different ledger authority');
  }
  return {
    root,
    claimsRoot: root,
    identity,
    identityRaw: evidence.raw,
    identitySidecarRaw: evidence.sidecarRaw,
    identitySha256: evidence.digest,
    identitySidecarSha256: sha256Value(evidence.sidecarRaw),
  };
}

async function claimTimeoutRecoveryGrant({
  prepared,
  outputRoot,
  ledgerPath,
  dryRun,
}) {
  const grantEvidence = prepared.predecessor.timeoutRecoveryGrant;
  if (!grantEvidence) {
    if (ledgerPath) {
      throw new Error('--timeout-recovery-ledger is forbidden without a timeout recovery grant');
    }
    return null;
  }
  const ledger = await loadTimeoutRecoveryLedger(ledgerPath, grantEvidence.grant);
  const protectedRoots = [
    prepared.predecessor.root,
    outputRoot,
    prepared.predecessor.identity.input_root,
  ];
  if (protectedRoots.some((protectedRoot) => (
    isWithin(protectedRoot, ledger.root) || isWithin(ledger.root, protectedRoot)
  ))) {
    throw new Error('timeout recovery ledger must be disjoint from predecessor, successor, and input roots');
  }
  const outputInfo = await stat(outputRoot, { bigint: true });
  const grantedDocuments = grantEvidence.grant.documents.map((document) => ({
    document_id: document.document_id,
    predecessor_status_sha256: document.predecessor_status_sha256,
    predecessor_state_sha256: document.predecessor_state_sha256,
    inherited_attempts: document.inherited_attempts,
    granted_attempt: document.granted_attempt,
  }));
  const claim = {
    schema_version: 1,
    claim_type: timeoutRecoveryClaimType,
    claim_mode: timeoutRecoveryClaimMode,
    ledger_id: ledger.identity.ledger_id,
    ledger_root: ledger.root,
    ledger_device: grantEvidence.grant.consumption.ledger_device,
    ledger_inode: grantEvidence.grant.consumption.ledger_inode,
    grant_id: grantEvidence.grant.grant_id,
    grant_raw_sha256: grantEvidence.rawSha256,
    predecessor: structuredClone(grantEvidence.grant.predecessor),
    granted_documents: grantedDocuments,
    successor: {
      seed_id: prepared.seedId,
      output_root: outputRoot,
      output_device: String(outputInfo.dev),
      output_inode: String(outputInfo.ino),
    },
    citation_allowed: false,
  };
  const claimRaw = jsonContents(claim);
  const claimSha256 = sha256Value(claimRaw);
  const claimPath = path.join(
    ledger.claimsRoot,
    `${grantEvidence.grant.grant_id}.claim.json`,
  );
  const claimSidecarPath = `${claimPath}.sha256`;
  const ledgerClaimSidecarRaw = `${claimSha256}  ${path.basename(claimPath)}\n`;
  const claimSidecarRaw = `${claimSha256}  ${timeoutRecoveryClaimFilename}\n`;
  const validateExistingClaim = async () => {
    const raw = await readStrictFile(ledger.root, claimPath, 'timeout recovery consumption claim');
    if (raw.toString('utf8') !== claimRaw) {
      throw new Error('timeout recovery grant was already consumed by a different successor');
    }
    const sidecarPresent = await lstat(claimSidecarPath).then(() => true, (error) => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    });
    if (sidecarPresent) {
      await readStrictFileWithSidecar(
        ledger.root,
        claimPath,
        'timeout recovery consumption claim',
      );
    } else if (!dryRun) {
      await durableAtomicWrite(claimSidecarPath, ledgerClaimSidecarRaw);
    } else {
      throw new Error('timeout recovery consumption claim SHA-256 sidecar is missing');
    }
  };
  const claimPresent = await lstat(claimPath).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  const sidecarPresent = await lstat(claimSidecarPath).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (!claimPresent && sidecarPresent) {
    throw new Error('timeout recovery consumption ledger has an orphan claim sidecar');
  }
  if (claimPresent) {
    await validateExistingClaim();
  } else if (!dryRun) {
    try {
      const handle = await open(claimPath, 'wx', 0o600);
      try {
        await handle.writeFile(claimRaw, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(ledger.claimsRoot);
      await durableAtomicWrite(claimSidecarPath, ledgerClaimSidecarRaw);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await validateExistingClaim();
    }
  }
  return {
    ledger,
    claim,
    claimRaw,
    claimSidecarRaw,
    claimSha256,
    claimSidecarSha256: sha256Value(claimSidecarRaw),
  };
}

async function bindTimeoutRecoveryConsumption(prepared, consumption, dryRun) {
  if (!consumption) return;
  const stagedLedgerSidecarRaw = `${consumption.ledger.identitySha256}  ${timeoutRecoveryLedgerIdentityFilename}\n`;
  const summary = {
    ledger_id: consumption.ledger.identity.ledger_id,
    ledger_identity_sha256: consumption.ledger.identitySha256,
    ledger_identity_sidecar_sha256: sha256Value(stagedLedgerSidecarRaw),
    claim_mode: timeoutRecoveryClaimMode,
    claim_sha256: consumption.claimSha256,
    claim_sidecar_sha256: consumption.claimSidecarSha256,
  };
  prepared.receipt.timeout_recovery_consumption = summary;
  prepared.runStatus.seed_lineage.timeout_recovery_ledger_id = summary.ledger_id;
  prepared.runStatus.seed_lineage.timeout_recovery_claim_sha256 = summary.claim_sha256;
  prepared.receipt.successor.initial_run_status_sha256 = sha256Value(jsonContents(prepared.runStatus));
  prepared.receiptSha256 = await writeJsonWithSidecar(
    path.join(prepared.stageRoot, 'seed-receipt.json'),
    prepared.receipt,
  );
  if (!dryRun) {
    await atomicWrite(
      path.join(prepared.stageRoot, timeoutRecoveryLedgerIdentityFilename),
      consumption.ledger.identityRaw,
    );
    await atomicWrite(
      path.join(prepared.stageRoot, `${timeoutRecoveryLedgerIdentityFilename}.sha256`),
      stagedLedgerSidecarRaw,
    );
    await atomicWrite(
      path.join(prepared.stageRoot, timeoutRecoveryClaimFilename),
      consumption.claimRaw,
    );
    await atomicWrite(
      path.join(prepared.stageRoot, `${timeoutRecoveryClaimFilename}.sha256`),
      consumption.claimSidecarRaw,
    );
  }
  prepared.timeoutRecoveryConsumption = consumption;
}

async function captureSeedPredecessor(
  predecessorRoot,
  manifest,
  manifestSha256,
  { captureTimeoutRecoveryGrantEvidence = true } = {},
) {
  const root = await requireRealDirectory(predecessorRoot, 'seed predecessor output root');
  const [documentsRoot, statusRoot] = await Promise.all([
    requireContainedRealDirectory(root, path.join(root, 'documents'), 'seed predecessor documents root'),
    requireContainedRealDirectory(root, path.join(root, 'status'), 'seed predecessor status root'),
  ]);
  const identityPath = path.join(root, 'run-identity.json');
  const runStatusPath = path.join(root, 'run-status.json');
  const [identityRaw, runStatusEvidence] = await Promise.all([
    readStrictFile(root, identityPath, 'seed predecessor run identity'),
    readStrictFileWithSidecar(root, runStatusPath, 'seed predecessor run status'),
  ]);
  const runStatusRaw = runStatusEvidence.raw;
  const runStatusSidecarRaw = runStatusEvidence.sidecarRaw;
  const runStatusSha256 = runStatusEvidence.digest;
  let identity;
  let runStatus;
  try {
    identity = JSON.parse(identityRaw);
    runStatus = JSON.parse(runStatusRaw);
  } catch (error) {
    throw new Error(`seed predecessor control JSON is invalid: ${error.message}`);
  }
  requireObject(identity, 'seed predecessor run identity');
  requireObject(runStatus, 'seed predecessor run status');
  if (identity.schema_version !== 1
    || identity.manifest_sha256 !== manifestSha256
    || !sameJsonValue(identity.runtime, manifest.runtime)
    || identity.citation_allowed !== false
    || identity.whole_document_atomic !== true) {
    throw new Error('seed predecessor run identity differs from the exact manifest or fail-closed contract');
  }
  if (identity.seed_lineage !== undefined || runStatus.seed_lineage !== undefined) {
    throw new Error('seed predecessor must be an unseeded first-generation run');
  }
  requireSha256(identity.runtime_fingerprint_sha256, 'seed predecessor runtime fingerprint SHA-256');
  requireSha256(identity.runner_script_sha256, 'seed predecessor runner script SHA-256');
  requireSha256(identity.ocr_script_sha256, 'seed predecessor OCR script SHA-256');
  if (identity.runner_script_sha256 !== legacyB1RunnerScriptSha256) {
    throw new Error('seed predecessor is not bound to the exact B-r1 runner');
  }
  if (identity.runtime_fingerprint_sha256 !== sha256Value(`${JSON.stringify(identity.runtime_fingerprint)}\n`)) {
    throw new Error('seed predecessor runtime fingerprint SHA-256 mismatch');
  }
  requireObject(identity.worker_configuration, 'seed predecessor worker configuration');
  requireObject(identity.document_recovery, 'seed predecessor recovery policy');
  if (runStatus.schema_version !== 1
    || runStatus.manifest_sha256 !== manifestSha256
    || runStatus.runtime_fingerprint_sha256 !== identity.runtime_fingerprint_sha256
    || !sameJsonValue(runStatus.document_recovery, identity.document_recovery)
    || runStatus.citation_allowed !== false) {
    throw new Error('seed predecessor run status differs from its run identity');
  }
  const statusDocuments = requireObject(runStatus.documents, 'seed predecessor run status documents');
  const expectedIds = manifest.documents.map((document) => document.id).sort();
  if (!sameJsonValue(Object.keys(statusDocuments).sort(), expectedIds)) {
    throw new Error('seed predecessor document set differs from the exact manifest');
  }
  const expectedRunCounts = seedRunCounts(runStatus);
  if (!sameJsonValue(runStatus.counts, expectedRunCounts)
    || runStatus.finished !== (expectedRunCounts.complete === expectedRunCounts.total)
    || runStatus.settled !== (expectedRunCounts.complete + expectedRunCounts.quarantined === expectedRunCounts.total)) {
    throw new Error('seed predecessor run counts or terminal flags differ from document states');
  }

  const documents = [];
  const artifactRecords = [];
  let completedPages = 0;
  for (const document of manifest.documents) {
    const progress = seedProgressRecord(statusDocuments[document.id], document);
    const documentRoot = path.join(documentsRoot, document.id);
    const statusPath = path.join(statusRoot, `${document.id}.json`);
    if (progress.status === 'pending') {
      if (await lstat(documentRoot).then(() => true, (error) => {
        if (error?.code === 'ENOENT') return false;
        throw error;
      })) {
        throw new Error(`${document.id}: pending predecessor unexpectedly has a document tree`);
      }
      if (await lstat(statusPath).then(() => true, (error) => {
        if (error?.code === 'ENOENT') return false;
        throw error;
      })) {
        throw new Error(`${document.id}: pending predecessor unexpectedly has a status file`);
      }
      documents.push({
        document_id: document.id,
        page_count: document.page_count,
        predecessor_status: progress.status,
        predecessor_status_format: 'pending_no_status',
        inherited_attempts: progress.attempts,
        completed_pages: [],
        failed_pages: [],
        predecessor_document_tree: null,
        predecessor_pages_tree: null,
        predecessor_state_sha256: null,
        predecessor_configuration_sha256: sha256Value(canonicalJson(identity.worker_configuration)),
        predecessor_status_sha256: null,
        predecessor_status_sidecar_sha256: null,
        inherited_page_artifacts: [],
        inherited_page_artifacts_sha256: sha256Value(canonicalJson([])),
        state_raw: null,
        status_raw: null,
        status_sidecar_raw: null,
      });
      continue;
    }

    await requireContainedRealDirectory(documentsRoot, documentRoot, `${document.id} predecessor document tree`);
    const validation = await validateOcrDocumentOutput(
      document,
      documentRoot,
      manifest.runtime,
      {
        requireComplete: progress.status === 'complete',
        workerConfiguration: identity.worker_configuration,
      },
    );
    const statePath = path.join(documentRoot, 'state.json');
    const stateRaw = await readStrictFile(documentRoot, statePath, `${document.id} predecessor state`);
    const state = JSON.parse(stateRaw);
    if (Object.keys(requireObject(state.failed_pages, `${document.id} predecessor failed_pages`)).length !== 0) {
      throw new Error(`${document.id}: predecessor failed_pages must be empty before seed`);
    }
    const completed = exactIntegerSet(
      state.completed_pages,
      document.page_count,
      `${document.id} predecessor completed_pages`,
    );
    const documentRootEntries = (await readdir(documentRoot, { withFileTypes: true }))
      .map((entry) => {
        if (entry.isSymbolicLink()) throw new Error(`${document.id}: predecessor document root contains a symlink`);
        return `${entry.isDirectory() ? 'D' : entry.isFile() ? 'F' : 'X'}:${entry.name}`;
      })
      .sort();
    if (!sameJsonValue(documentRootEntries, ['D:pages', 'F:state.json'])) {
      throw new Error(`${document.id}: predecessor document root contains unexpected entries`);
    }
    const physicalPageEntries = (await readdir(path.join(documentRoot, 'pages'), { withFileTypes: true }))
      .map((entry) => {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^\d{4}$/u.test(entry.name)) {
          throw new Error(`${document.id}: predecessor pages tree contains an invalid entry: ${entry.name}`);
        }
        return Number(entry.name);
      })
      .sort((left, right) => left - right);
    if (!sameJsonValue(physicalPageEntries, completed)) {
      throw new Error(`${document.id}: predecessor physical page directories differ from completed_pages`);
    }
    const pageArtifacts = [];
    for (const page of completed) {
      const statePage = state.pages[String(page)];
      const pageRoot = path.join(documentRoot, 'pages', String(page).padStart(4, '0'));
      const pageTree = await inspectTree(pageRoot);
      const record = {
        physical_pdf_page: page,
        rendered_image_sha256: statePage.rendered_image_sha256,
        result_json_sha256: statePage.result_json_sha256,
        content_markdown_sha256: statePage.content_markdown_sha256,
        page_tree_sha256: pageTree.tree_sha256,
        page_tree_files: pageTree.files,
        page_tree_bytes: pageTree.bytes,
        citation_allowed: false,
      };
      pageArtifacts.push(record);
      artifactRecords.push({ document_id: document.id, ...record });
    }
    completedPages += completed.length;
    const [documentTree, pagesTree, statusEvidence] = await Promise.all([
      inspectTree(documentRoot),
      inspectTree(path.join(documentRoot, 'pages')),
      readStrictFileWithSidecar(statusRoot, statusPath, `${document.id} predecessor status`),
    ]);
    const statusRaw = statusEvidence.raw;
    const statusSidecarRaw = statusEvidence.sidecarRaw;
    const statusSha256 = statusEvidence.digest;
    const status = JSON.parse(statusRaw);
    const predecessorStatusFormat = classifySeedPredecessorStatus(
      identity,
      progress,
      status,
      statusSha256,
      document,
    );
    if (progress.status === 'complete') {
      const artifacts = requireObject(status.artifacts, `${document.id} predecessor complete artifacts`);
      if (artifacts.state_sha256 !== validation.state_sha256
        || artifacts.page_artifacts_sha256 !== validation.page_artifacts_sha256) {
        throw new Error(`${document.id}: predecessor complete status artifacts mismatch`);
      }
    }
    documents.push({
      document_id: document.id,
      page_count: document.page_count,
      predecessor_status: progress.status,
      predecessor_status_format: predecessorStatusFormat,
      inherited_attempts: progress.attempts,
      completed_pages: completed,
      failed_pages: [],
      predecessor_document_tree: documentTree,
      predecessor_pages_tree: pagesTree,
      predecessor_state_sha256: sha256Value(stateRaw),
      predecessor_configuration_sha256: sha256Value(canonicalJson(state.configuration)),
      predecessor_status_sha256: statusSha256,
      predecessor_status_sidecar_sha256: sha256Value(statusSidecarRaw),
      inherited_page_artifacts: pageArtifacts,
      inherited_page_artifacts_sha256: sha256Value(canonicalJson(pageArtifacts)),
      state,
      status,
      state_raw: stateRaw,
      status_raw: statusRaw,
      status_sidecar_raw: statusSidecarRaw,
    });
  }
  const timeoutRecoveryGrant = captureTimeoutRecoveryGrantEvidence
    ? await captureTimeoutRecoveryGrant({
      root,
      manifest,
      manifestSha256,
      identityRaw,
      runStatusSha256,
      documents,
    })
    : null;
  const evidence = {
    root,
    manifest_sha256: manifestSha256,
    run_identity_sha256: sha256Value(identityRaw),
    run_status_sha256: runStatusSha256,
    run_status_sidecar_sha256: sha256Value(runStatusSidecarRaw),
    runtime_fingerprint_sha256: identity.runtime_fingerprint_sha256,
    worker_configuration_sha256: sha256Value(canonicalJson(identity.worker_configuration)),
    document_recovery_sha256: sha256Value(canonicalJson(identity.document_recovery)),
    completed_pages: completedPages,
    failed_pages: 0,
    quarantined_documents: documents.filter(
      (document) => document.predecessor_status === 'quarantined',
    ).length,
    page_artifacts_sha256: sha256Value(canonicalJson(artifactRecords)),
    ...(timeoutRecoveryGrant ? {
      timeout_recovery_grant_id: timeoutRecoveryGrant.grant.grant_id,
      timeout_recovery_grant_raw_sha256: timeoutRecoveryGrant.rawSha256,
      timeout_recovery_grant_sidecar_sha256: timeoutRecoveryGrant.sidecarSha256,
    } : {}),
    documents,
    identity,
    runStatus,
    identityRaw,
    runStatusRaw,
    runStatusSidecarRaw,
    timeoutRecoveryGrant,
  };
  evidence.snapshot_sha256 = sha256Value(canonicalJson({
    manifest_sha256: evidence.manifest_sha256,
    run_identity_sha256: evidence.run_identity_sha256,
    run_status_sha256: evidence.run_status_sha256,
    run_status_sidecar_sha256: evidence.run_status_sidecar_sha256,
    runtime_fingerprint_sha256: evidence.runtime_fingerprint_sha256,
    worker_configuration_sha256: evidence.worker_configuration_sha256,
    document_recovery_sha256: evidence.document_recovery_sha256,
    completed_pages: evidence.completed_pages,
    failed_pages: evidence.failed_pages,
    quarantined_documents: evidence.quarantined_documents,
    page_artifacts_sha256: evidence.page_artifacts_sha256,
    ...(timeoutRecoveryGrant ? {
      timeout_recovery_grant_id: evidence.timeout_recovery_grant_id,
      timeout_recovery_grant_raw_sha256: evidence.timeout_recovery_grant_raw_sha256,
      timeout_recovery_grant_sidecar_sha256: evidence.timeout_recovery_grant_sidecar_sha256,
    } : {}),
    documents: documents.map(publicPredecessorDocument),
  }));
  return evidence;
}

export async function inspectTimeoutRecoveryPredecessorForGrant({
  manifestPath: manifestOption,
  predecessorRoot: predecessorOption,
}) {
  if (typeof manifestOption !== 'string' || manifestOption.length === 0) {
    throw new Error('--manifest is required');
  }
  if (typeof predecessorOption !== 'string' || predecessorOption.length === 0) {
    throw new Error('--predecessor-root is required');
  }
  const manifestPath = path.resolve(manifestOption);
  const predecessorRoot = path.resolve(predecessorOption);
  await requireRegularFile(manifestPath, 'timeout recovery manifest');
  if (await realpath(manifestPath) !== manifestPath) {
    throw new Error('timeout recovery manifest must not resolve through a symlink');
  }
  const manifestRaw = await readFile(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (error) {
    throw new Error(`timeout recovery manifest is not valid JSON: ${error.message}`);
  }
  validateRemoteOcrManifest(manifest);
  const manifestSha256 = sha256Value(manifestRaw);
  const predecessor = await captureSeedPredecessor(
    predecessorRoot,
    manifest,
    manifestSha256,
    { captureTimeoutRecoveryGrantEvidence: false },
  );
  if (predecessor.root !== predecessorRoot) {
    throw new Error('timeout recovery predecessor root must not resolve through a symlink');
  }
  const inputRoot = await requireRealDirectory(
    predecessor.identity.input_root,
    'timeout recovery predecessor input root',
  );
  if (inputRoot !== path.resolve(predecessor.identity.input_root)) {
    throw new Error('timeout recovery predecessor input root must not resolve through a symlink');
  }
  const logsRoot = await requireContainedRealDirectory(
    predecessor.root,
    path.join(predecessor.root, 'logs'),
    'timeout recovery predecessor logs root',
  );
  const nonTerminalDocuments = predecessor.documents.filter(
    (document) => !['complete', 'quarantined'].includes(document.predecessor_status),
  );
  if (nonTerminalDocuments.length > 0 || predecessor.runStatus.settled !== true) {
    throw new Error('timeout recovery predecessor must be settled with only complete or quarantined documents');
  }
  const quarantinedDocuments = predecessor.documents.filter(
    (document) => document.predecessor_status === 'quarantined',
  );
  if (quarantinedDocuments.length === 0) {
    throw new Error('timeout recovery predecessor has no quarantined documents');
  }
  const documents = [];
  for (const document of quarantinedDocuments) {
    if (document.predecessor_status_format !== 'timeout_only_quarantine_granted_v1') {
      throw new Error(`${document.document_id}: predecessor quarantine is not an exact child idle timeout`);
    }
    const firstMissingPage = firstMissingPhysicalPage(
      document.completed_pages,
      document.page_count,
    );
    if (firstMissingPage === null) {
      throw new Error(`${document.document_id}: a complete document cannot receive timeout recovery`);
    }
    const expectedCompletedPages = Array.from(
      { length: firstMissingPage - 1 },
      (_, index) => index + 1,
    );
    if (!sameJsonValue(document.completed_pages, expectedCompletedPages)) {
      throw new Error(`${document.document_id}: timeout recovery requires a contiguous completed-page frontier`);
    }
    const timeoutLogPath = path.join(logsRoot, `${document.document_id}.log`);
    const timeoutLogInfo = await requireRegularFile(
      timeoutLogPath,
      `${document.document_id} timeout recovery log`,
    );
    if ((timeoutLogInfo.mode & 0o777) !== 0o600) {
      throw new Error(`${document.document_id}: timeout recovery log mode must equal 0600`);
    }
    const timeoutLogRaw = await readStrictFile(
      predecessor.root,
      timeoutLogPath,
      `${document.document_id} timeout recovery log`,
    );
    documents.push({
      document_id: document.document_id,
      predecessor_status_sha256: document.predecessor_status_sha256,
      predecessor_state_sha256: document.predecessor_state_sha256,
      inherited_attempts: maxDocumentAttempts,
      granted_attempt: timeoutRecoveryGrantedAttempt,
      first_missing_page: firstMissingPage,
      completed_pages_sha256: sha256Value(canonicalJson(document.completed_pages)),
      failed_pages_sha256: sha256Value(canonicalJson(document.state.failed_pages)),
      quarantine_reason: 'attempt_budget_exhausted',
      error_sha256: sha256Value(document.status.error),
      classification: timeoutRecoveryClassification,
      timeout_log: {
        path: `logs/${document.document_id}.log`,
        bytes: timeoutLogRaw.byteLength,
        sha256: sha256Value(timeoutLogRaw),
      },
    });
  }
  return {
    schema_version: 1,
    manifest_path: manifestPath,
    manifest_sha256: manifestSha256,
    predecessor_root: predecessor.root,
    predecessor_input_root: inputRoot,
    run_identity_sha256: predecessor.run_identity_sha256,
    run_status_sha256: predecessor.run_status_sha256,
    documents,
    citation_allowed: false,
  };
}

function validateSeedConfigurationDelta(predecessor, successor) {
  const predecessorWorker = requireObject(predecessor.identity.worker_configuration, 'predecessor worker configuration');
  const successorWorker = requireObject(successor.workerConfiguration, 'successor worker configuration');
  if (predecessor.identity.runtime_fingerprint_sha256 !== successor.runtimeFingerprintSha256
    || !sameJsonValue(predecessor.identity.runtime_fingerprint, successor.runtimeFingerprint)
    || !sameJsonValue(predecessor.identity.runtime, successor.runtime)
    || !sameJsonValue(predecessor.identity.llama_server_attestation, successor.llamaServerAttestation)
    || predecessor.identity.input_root !== successor.inputRoot
    || predecessor.identity.python_invocation_path !== successor.pythonInvocationPath
    || predecessor.identity.python_resolved_target !== successor.pythonResolvedTarget) {
    throw new Error('seed predecessor runtime, model, Python, device, input, or llama attestation differs from successor');
  }
  const expectedKeys = [
    'llama_url',
    'vl_rec_max_concurrency',
    'server_parallel',
    'micro_batch',
    'use_queues',
    'runtime_device',
    'paddlex_cache_home',
    'python_runtime',
    'paddlex_layout_model_cache_sha256',
  ].sort();
  if (!sameJsonValue(Object.keys(predecessorWorker).sort(), expectedKeys)
    || !sameJsonValue(Object.keys(successorWorker).sort(), expectedKeys)) {
    throw new Error('seed worker configuration field set differs from the audited contract');
  }
  if (predecessorWorker.vl_rec_max_concurrency !== 4 || successorWorker.vl_rec_max_concurrency !== 1) {
    throw new Error('seed permits only vl_rec_max_concurrency 4 to 1');
  }
  if (predecessorWorker.server_parallel !== 4
    || successorWorker.server_parallel !== 4
    || predecessorWorker.micro_batch !== 16
    || successorWorker.micro_batch !== 16
    || predecessorWorker.use_queues !== true
    || successorWorker.use_queues !== true) {
    throw new Error('seed must preserve server_parallel=4, micro_batch=16, and use_queues=true');
  }
  for (const key of expectedKeys.filter((key) => !['vl_rec_max_concurrency', 'paddlex_cache_home'].includes(key))) {
    if (!sameJsonValue(predecessorWorker[key], successorWorker[key])) {
      throw new Error(`seed worker configuration delta is forbidden for ${key}`);
    }
  }
  if (predecessorWorker.paddlex_cache_home !== successorWorker.paddlex_cache_home
    && predecessorWorker.paddlex_layout_model_cache_sha256 !== successorWorker.paddlex_layout_model_cache_sha256) {
    throw new Error('seed cache path may differ only when the cache tree SHA-256 is identical');
  }
  const predecessorRecovery = structuredClone(predecessor.identity.document_recovery);
  const successorRecovery = structuredClone(successor.documentRecovery);
  const predecessorIdle = predecessorRecovery.child_monitoring?.idle_timeout_seconds;
  const successorIdle = successorRecovery.child_monitoring?.idle_timeout_seconds;
  if (predecessorIdle !== 300 || successorIdle !== 1200) {
    throw new Error('seed permits only child idle timeout 300 to 1200 seconds');
  }
  delete predecessorRecovery.child_monitoring.idle_timeout_seconds;
  delete successorRecovery.child_monitoring.idle_timeout_seconds;
  if (!sameJsonValue(predecessorRecovery, successorRecovery)) {
    throw new Error('seed document recovery delta exceeds the audited idle-timeout exception');
  }
  return {
    schema_version: 1,
    vl_rec_max_concurrency: { predecessor: 4, successor: 1 },
    paddlex_cache_home: {
      predecessor: predecessorWorker.paddlex_cache_home,
      successor: successorWorker.paddlex_cache_home,
      tree_sha256: successorWorker.paddlex_layout_model_cache_sha256,
    },
    child_idle_timeout_seconds: { predecessor: 300, successor: 1200 },
  };
}

function seedRunCounts(runStatus) {
  const statuses = Object.values(runStatus.documents).map((document) => document.status);
  return {
    total: statuses.length,
    complete: statuses.filter((status) => status === 'complete').length,
    failed: statuses.filter((status) => status === 'failed').length,
    interrupted: statuses.filter((status) => status === 'interrupted').length,
    pending: statuses.filter((status) => status === 'pending').length,
    running: statuses.filter((status) => status === 'running').length,
    retry_wait: statuses.filter((status) => status === 'retry_wait').length,
    quarantined: statuses.filter((status) => status === 'quarantined').length,
  };
}

function publicPredecessorDocument(document) {
  const {
    state,
    status,
    state_raw: _stateRaw,
    status_raw: _statusRaw,
    status_sidecar_raw: _statusSidecarRaw,
    timeout_log_raw: _timeoutLogRaw,
    ...value
  } = document;
  return value;
}

function seedEvidenceFileRecord(relativePath, raw) {
  if (!Buffer.isBuffer(raw)) throw new Error(`seed predecessor evidence ${relativePath} is not raw bytes`);
  return {
    path: relativePath,
    bytes: raw.byteLength,
    sha256: sha256Value(raw),
  };
}

function seedEvidenceDocumentInventory(document) {
  const statePath = `documents/${document.document_id}/state.json`;
  const statusPath = `status/${document.document_id}.json`;
  const statusSidecarPath = `${statusPath}.sha256`;
  if (document.predecessor_status === 'pending') {
    return {
      document_id: document.document_id,
      predecessor_status: 'pending',
      state: { present: false, path: statePath },
      status: { present: false, path: statusPath, sidecar_path: statusSidecarPath },
    };
  }
  return {
    document_id: document.document_id,
    predecessor_status: document.predecessor_status,
    state: {
      present: true,
      ...seedEvidenceFileRecord(statePath, document.state_raw),
    },
    status: {
      present: true,
      ...seedEvidenceFileRecord(statusPath, document.status_raw),
      sidecar: seedEvidenceFileRecord(statusSidecarPath, document.status_sidecar_raw),
    },
    ...(document.timeout_log ? {
      timeout_log: seedEvidenceFileRecord(
        document.timeout_log.path,
        document.timeout_log_raw,
      ),
    } : {}),
  };
}

async function stageSeedPredecessorEvidence(outputRoot, predecessor, manifest) {
  const evidenceRoot = path.join(
    outputRoot,
    `.seed-predecessor-evidence-candidate-${randomUUID()}`,
  );
  await mkdir(evidenceRoot, { mode: 0o700 });
  try {
    const rawFiles = [
      ['run-identity.json', predecessor.identityRaw],
      ['run-status.json', predecessor.runStatusRaw],
      ['run-status.json.sha256', predecessor.runStatusSidecarRaw],
    ];
    for (const document of predecessor.documents) {
      if (document.predecessor_status === 'pending') continue;
      rawFiles.push(
        [`documents/${document.document_id}/state.json`, document.state_raw],
        [`status/${document.document_id}.json`, document.status_raw],
        [`status/${document.document_id}.json.sha256`, document.status_sidecar_raw],
      );
      if (document.timeout_log) {
        rawFiles.push([document.timeout_log.path, document.timeout_log_raw]);
      }
    }
    rawFiles.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    for (const [relativePath, raw] of rawFiles) {
      await atomicWrite(path.join(evidenceRoot, relativePath), raw);
    }
    const documents = manifest.documents.map((document) => {
      const predecessorDocument = predecessor.documents.find(
        (item) => item.document_id === document.id,
      );
      return seedEvidenceDocumentInventory(predecessorDocument);
    });
    const inventory = {
      schema_version: 1,
      evidence_type: seedPredecessorEvidenceType,
      manifest_sha256: predecessor.manifest_sha256,
      runner_script_sha256: predecessor.identity.runner_script_sha256,
      files: rawFiles.map(([relativePath, raw]) => seedEvidenceFileRecord(relativePath, raw)),
      documents,
      citation_allowed: false,
    };
    const inventoryPath = path.join(evidenceRoot, 'inventory.json');
    await atomicJson(inventoryPath, inventory);
    const fingerprint = await inspectTree(evidenceRoot);
    return {
      root: evidenceRoot,
      contract: {
        schema_version: 1,
        directory: seedPredecessorEvidenceDirectory,
        inventory_sha256: await sha256File(inventoryPath),
        tree_sha256: fingerprint.tree_sha256,
        files: fingerprint.files,
        bytes: fingerprint.bytes,
      },
    };
  } catch (error) {
    await rm(evidenceRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function timeoutRecoveryGrantSummary(predecessor) {
  const evidence = predecessor.timeoutRecoveryGrant;
  if (!evidence) return null;
  return {
    grant_id: evidence.grant.grant_id,
    raw_sha256: evidence.rawSha256,
    sidecar_sha256: evidence.sidecarSha256,
    policy: structuredClone(evidence.grant.policy),
    documents: structuredClone(evidence.grant.documents),
  };
}

async function prepareHashBoundSeed({
  predecessorRoot,
  outputRoot,
  manifest,
  manifestSha256,
  successor,
  dryRun = false,
}) {
  const predecessor = await captureSeedPredecessor(predecessorRoot, manifest, manifestSha256);
  if (isWithin(predecessor.root, outputRoot) || isWithin(outputRoot, predecessor.root)) {
    throw new Error('seed predecessor and successor output roots must be disjoint and non-nested');
  }
  const allowedConfigurationDelta = validateSeedConfigurationDelta(predecessor, successor);
  const predecessorEvidence = await stageSeedPredecessorEvidence(outputRoot, predecessor, manifest);
  const predecessorContract = {
    manifest_sha256: predecessor.manifest_sha256,
    run_identity_sha256: predecessor.run_identity_sha256,
    run_status_sha256: predecessor.run_status_sha256,
    run_status_sidecar_sha256: predecessor.run_status_sidecar_sha256,
    runtime: predecessor.identity.runtime,
    runtime_fingerprint: predecessor.identity.runtime_fingerprint,
    runtime_fingerprint_sha256: predecessor.runtime_fingerprint_sha256,
    runner_script_sha256: predecessor.identity.runner_script_sha256,
    ocr_script_sha256: predecessor.identity.ocr_script_sha256,
    worker_configuration: predecessor.identity.worker_configuration,
    worker_configuration_sha256: predecessor.worker_configuration_sha256,
    document_recovery: predecessor.identity.document_recovery,
    document_recovery_sha256: predecessor.document_recovery_sha256,
    snapshot_sha256: predecessor.snapshot_sha256,
    completed_pages: predecessor.completed_pages,
    failed_pages: predecessor.failed_pages,
    quarantined_documents: predecessor.quarantined_documents,
    page_artifacts_sha256: predecessor.page_artifacts_sha256,
    control_evidence: predecessorEvidence.contract,
  };
  const successorContract = {
    runtime: successor.runtime,
    runtime_fingerprint: successor.runtimeFingerprint,
    runtime_fingerprint_sha256: successor.runtimeFingerprintSha256,
    worker_configuration: successor.workerConfiguration,
    worker_configuration_sha256: sha256Value(canonicalJson(successor.workerConfiguration)),
    document_recovery: successor.documentRecovery,
    document_recovery_sha256: sha256Value(canonicalJson(successor.documentRecovery)),
    runner_script_sha256: successor.runnerScriptSha256,
    ocr_script_sha256: successor.ocrScriptSha256,
    citation_allowed: false,
  };
  const recoveryGrantSummary = timeoutRecoveryGrantSummary(predecessor);
  const seedBasis = {
    schema_version: 1,
    mode: seedMode,
    manifest_sha256: manifestSha256,
    predecessor: predecessorContract,
    successor_contract: successorContract,
    allowed_configuration_delta: allowedConfigurationDelta,
    documents: predecessor.documents.map(publicPredecessorDocument),
    ...(recoveryGrantSummary ? { timeout_recovery_grant: recoveryGrantSummary } : {}),
    citation_allowed: false,
  };
  const seedId = sha256Value(canonicalJson(seedBasis));
  const canonicalStageRoot = path.join(outputRoot, `.seed-stage-${seedId}`);
  const canonicalStageExists = await lstat(canonicalStageRoot).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  const stageRoot = canonicalStageExists
    ? `${canonicalStageRoot}.candidate-${randomUUID()}`
    : canonicalStageRoot;
  try {
    await mkdir(path.join(stageRoot, 'documents'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(stageRoot, 'status'), { recursive: true, mode: 0o700 });
    await rename(
      predecessorEvidence.root,
      path.join(stageRoot, seedPredecessorEvidenceDirectory),
    );
    if (predecessor.timeoutRecoveryGrant) {
      await atomicWrite(
        path.join(stageRoot, timeoutRecoveryGrantFilename),
        predecessor.timeoutRecoveryGrant.raw,
      );
      await atomicWrite(
        path.join(stageRoot, `${timeoutRecoveryGrantFilename}.sha256`),
        predecessor.timeoutRecoveryGrant.sidecarRaw,
      );
    }
  } catch (error) {
    await rm(predecessorEvidence.root, { recursive: true, force: true }).catch(() => {});
    await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  try {
    const recoveryGrantDocumentById = new Map(
      (predecessor.timeoutRecoveryGrant?.grant.documents || []).map(
        (document) => [document.document_id, document],
      ),
    );
    const recoveryDocumentIds = manifest.documents
      .map((document) => document.id)
      .filter((documentId) => recoveryGrantDocumentById.has(documentId));
    const runStatus = structuredClone(predecessor.runStatus);
    runStatus.runtime_fingerprint_sha256 = successor.runtimeFingerprintSha256;
    runStatus.document_recovery = successor.documentRecovery;
    runStatus.citation_allowed = false;
    runStatus.seed_lineage = {
      schema_version: 1,
      mode: seedMode,
      seed_id: seedId,
      predecessor_run_identity_sha256: predecessor.run_identity_sha256,
      predecessor_run_status_sha256: predecessor.run_status_sha256,
      ...(recoveryGrantSummary ? {
        timeout_recovery_grant_id: recoveryGrantSummary.grant_id,
        timeout_recovery_grant_sha256: recoveryGrantSummary.raw_sha256,
        timeout_recovery_documents: recoveryDocumentIds,
      } : {}),
      citation_allowed: false,
    };
    const receiptDocuments = [];

    for (const document of manifest.documents) {
      const predecessorDocument = predecessor.documents.find((item) => item.document_id === document.id);
      const predecessorProgress = predecessor.runStatus.documents[document.id];
      const recoveryGrantDocument = recoveryGrantDocumentById.get(document.id) || null;
      const progress = structuredClone(predecessorProgress);
      progress.predecessor_status = predecessorProgress.status;
      progress.inherited_attempts = predecessorProgress.attempts;
      progress.seed_id = seedId;
      if (recoveryGrantDocument) {
        progress.status = 'retry_wait';
        progress.next_retry_at = predecessorProgress.quarantined_at;
        progress.attempt_ceiling = timeoutRecoveryGrantedAttempt;
        progress.timeout_recovery_grant_id = recoveryGrantSummary.grant_id;
        progress.timeout_recovery_grant_sha256 = recoveryGrantSummary.raw_sha256;
        progress.timeout_recovery_first_missing_page = recoveryGrantDocument.first_missing_page;
        delete progress.quarantined_at;
        delete progress.quarantine_reason;
      }
      runStatus.documents[document.id] = progress;
      const receiptDocument = {
        ...publicPredecessorDocument(predecessorDocument),
        successor_document_tree: null,
        successor_state_sha256: null,
        successor_status_sha256: null,
        ...(recoveryGrantDocument ? {
          timeout_recovery: {
            grant_id: recoveryGrantSummary.grant_id,
            grant_raw_sha256: recoveryGrantSummary.raw_sha256,
            granted_attempt: timeoutRecoveryGrantedAttempt,
            first_missing_page: recoveryGrantDocument.first_missing_page,
            predecessor_log: {
              ...structuredClone(recoveryGrantDocument.timeout_log),
              path: `${seedPredecessorEvidenceDirectory}/${recoveryGrantDocument.timeout_log.path}`,
            },
          },
        } : {}),
      };
      if (predecessorProgress.status === 'pending') {
        receiptDocuments.push(receiptDocument);
        continue;
      }

      const sourceDocumentRoot = path.join(predecessor.root, 'documents', document.id);
      const stagedDocumentRoot = path.join(stageRoot, 'documents', document.id);
      await copyTreeStrict(sourceDocumentRoot, stagedDocumentRoot);
      const copiedPagesTree = await inspectTree(path.join(stagedDocumentRoot, 'pages'));
      if (!sameJsonValue(copiedPagesTree, predecessorDocument.predecessor_pages_tree)) {
        throw new Error(`${document.id}: seeded page bytes differ from predecessor before state tagging`);
      }
      const statePath = path.join(stagedDocumentRoot, 'state.json');
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      state.configuration = stateConfigurationContract(successor.runtime, successor.workerConfiguration);
      state.configuration_scope = seedConfigurationScope;
      state.seed_lineage = {
        schema_version: 1,
        mode: seedMode,
        seed_id: seedId,
        predecessor_run_identity_sha256: predecessor.run_identity_sha256,
        predecessor_configuration_sha256: predecessorDocument.predecessor_configuration_sha256,
        inherited_completed_pages: predecessorDocument.completed_pages,
        ...(recoveryGrantDocument ? {
          timeout_recovery_grant_id: recoveryGrantSummary.grant_id,
          timeout_recovery_grant_sha256: recoveryGrantSummary.raw_sha256,
          timeout_recovery_first_missing_page: recoveryGrantDocument.first_missing_page,
        } : {}),
        citation_allowed: false,
      };
      for (const page of predecessorDocument.completed_pages) {
        state.pages[String(page)].seed_provenance = {
          seed_id: seedId,
          predecessor_run_identity_sha256: predecessor.run_identity_sha256,
          predecessor_configuration_sha256: predecessorDocument.predecessor_configuration_sha256,
        };
      }
      await atomicJson(statePath, state);
      const pagesTreeAfter = await inspectTree(path.join(stagedDocumentRoot, 'pages'));
      if (!sameJsonValue(pagesTreeAfter, predecessorDocument.predecessor_pages_tree)) {
        throw new Error(`${document.id}: seed state tagging changed inherited page bytes`);
      }
      const validation = await validateOcrDocumentOutput(
        document,
        stagedDocumentRoot,
        successor.runtime,
        {
          requireComplete: predecessorProgress.status === 'complete',
          workerConfiguration: successor.workerConfiguration,
        },
      );
      const successorDocumentTree = await inspectTree(stagedDocumentRoot);

      const successorStatus = recoveryGrantDocument ? {
        schema_version: 1,
        document_id: document.id,
        status: 'retry_wait',
        attempt: predecessorDocument.inherited_attempts,
        max_attempts: timeoutRecoveryGrantedAttempt,
        next_retry_at: predecessorProgress.quarantined_at,
        page_count: document.page_count,
        runtime_fingerprint_sha256: successor.runtimeFingerprintSha256,
        citation_allowed: false,
        error: predecessorProgress.error,
        failed_at: predecessorProgress.failed_at,
      } : structuredClone(predecessorDocument.status);
      successorStatus.runtime_fingerprint_sha256 = successor.runtimeFingerprintSha256;
      successorStatus.seed_lineage = {
        schema_version: 1,
        seed_id: seedId,
        predecessor_status_sha256: predecessorDocument.predecessor_status_sha256,
        inherited_attempts: predecessorDocument.inherited_attempts,
        ...(recoveryGrantDocument ? {
          timeout_recovery_grant_id: recoveryGrantSummary.grant_id,
          timeout_recovery_grant_sha256: recoveryGrantSummary.raw_sha256,
          timeout_recovery_first_missing_page: recoveryGrantDocument.first_missing_page,
          granted_attempt: timeoutRecoveryGrantedAttempt,
        } : {}),
        citation_allowed: false,
      };
      if (successorStatus.status === 'complete') successorStatus.artifacts = validation;
      const stagedStatusPath = path.join(stageRoot, 'status', `${document.id}.json`);
      const successorStatusSha256 = await writeJsonWithSidecar(stagedStatusPath, successorStatus);
      progress.status_json_sha256 = successorStatusSha256;
      receiptDocument.successor_document_tree = successorDocumentTree;
      receiptDocument.successor_state_sha256 = validation.state_sha256;
      receiptDocument.successor_status_sha256 = successorStatusSha256;
      receiptDocuments.push(receiptDocument);
    }

    runStatus.counts = seedRunCounts(runStatus);
    runStatus.finished = runStatus.counts.complete === runStatus.counts.total;
    runStatus.settled = runStatus.counts.complete + runStatus.counts.quarantined === runStatus.counts.total;
    const initialRunStatusSha256 = sha256Value(jsonContents(runStatus));
    const predecessorAfter = await captureSeedPredecessor(predecessorRoot, manifest, manifestSha256);
    if (predecessorAfter.snapshot_sha256 !== predecessor.snapshot_sha256) {
      throw new Error('seed predecessor changed while the successor stage was copied');
    }
    const inheritedPageCount = receiptDocuments.reduce(
      (sum, document) => sum + document.completed_pages.length,
      0,
    );
    const receipt = {
      schema_version: 1,
      receipt_type: seedReceiptType,
      status: 'prepared_commit_marker_required',
      seed_id: seedId,
      seed_basis_sha256: sha256Value(canonicalJson(seedBasis)),
      manifest_sha256: manifestSha256,
      predecessor: predecessorContract,
      successor: {
        ...successorContract,
        initial_run_status_sha256: initialRunStatusSha256,
      },
      allowed_configuration_delta: allowedConfigurationDelta,
      ...(recoveryGrantSummary ? { timeout_recovery_grant: recoveryGrantSummary } : {}),
      counts: {
        documents: manifest.documents.length,
        inherited_documents: receiptDocuments.filter((document) => document.completed_pages.length > 0).length,
        inherited_pages: inheritedPageCount,
        failed_pages: 0,
        quarantined_documents: 0,
        ...(recoveryGrantSummary ? {
          predecessor_complete_documents: predecessor.runStatus.counts.complete,
          predecessor_quarantined_documents: predecessor.quarantined_documents,
          recovery_granted_documents: recoveryDocumentIds.length,
        } : {}),
      },
      documents: receiptDocuments,
      citation_allowed: false,
    };
    const receiptPath = path.join(stageRoot, 'seed-receipt.json');
    const receiptSha256 = await writeJsonWithSidecar(receiptPath, receipt);
    return {
      dryRun,
      stageRoot,
      canonicalStageRoot,
      seedId,
      receipt,
      receiptSha256,
      runStatus,
      predecessor,
    };
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function seedInstallItemFingerprint(pathname, type) {
  if (type === 'directory') return inspectTree(pathname);
  await requireRegularFile(pathname, `seed install item ${pathname}`);
  const info = await stat(pathname);
  return { sha256: await sha256File(pathname), bytes: info.size };
}

async function verifyOrRepairExactJsonSidecar(root, pathname, expected, label) {
  const expectedContents = jsonContents(expected);
  const actualContents = (await readStrictFile(root, pathname, label)).toString('utf8');
  if (actualContents !== expectedContents) {
    throw new Error(`${label} differs from the exact prepared seed transaction`);
  }
  const expectedSha256 = sha256Value(expectedContents);
  const sidecarPath = `${pathname}.sha256`;
  const sidecarExists = await lstat(sidecarPath).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (!sidecarExists) {
    await atomicWrite(sidecarPath, `${expectedSha256}  ${path.basename(pathname)}\n`);
    return expectedSha256;
  }
  const actualSha256 = (await readStrictFileWithSidecar(root, pathname, label)).digest;
  if (actualSha256 !== expectedSha256) {
    throw new Error(`${label} SHA-256 differs from the exact prepared seed transaction`);
  }
  return actualSha256;
}

async function installHashBoundSeed(prepared, identity, outputRoot, dependencies = {}) {
  const identityPath = path.join(prepared.stageRoot, 'run-identity.json');
  await atomicJson(identityPath, identity);
  const runStatusPath = path.join(prepared.stageRoot, 'run-status.json');
  const runStatusSha256 = await writeJsonWithSidecar(runStatusPath, prepared.runStatus);
  if (runStatusSha256 !== prepared.receipt.successor.initial_run_status_sha256) {
    throw new Error('seed initial run status hash differs from its receipt');
  }
  const specifications = [
    { name: 'documents', type: 'directory' },
    { name: 'status', type: 'directory' },
    { name: seedPredecessorEvidenceDirectory, type: 'directory' },
    { name: 'seed-receipt.json', type: 'file' },
    { name: 'seed-receipt.json.sha256', type: 'file' },
    ...(prepared.predecessor.timeoutRecoveryGrant ? [
      { name: timeoutRecoveryGrantFilename, type: 'file' },
      { name: `${timeoutRecoveryGrantFilename}.sha256`, type: 'file' },
      { name: timeoutRecoveryLedgerIdentityFilename, type: 'file' },
      { name: `${timeoutRecoveryLedgerIdentityFilename}.sha256`, type: 'file' },
      { name: timeoutRecoveryClaimFilename, type: 'file' },
      { name: `${timeoutRecoveryClaimFilename}.sha256`, type: 'file' },
    ] : []),
    { name: 'run-identity.json', type: 'file' },
    { name: 'run-status.json', type: 'file' },
    { name: 'run-status.json.sha256', type: 'file' },
  ];
  const items = [];
  for (const specification of specifications) {
    const source = path.join(prepared.stageRoot, specification.name);
    items.push({
      ...specification,
      fingerprint: await seedInstallItemFingerprint(source, specification.type),
    });
  }
  const identitySha256 = items.find((item) => item.name === 'run-identity.json').fingerprint.sha256;
  const journalPath = path.join(outputRoot, '.seed-journal.json');
  const markerPath = path.join(outputRoot, 'seed-commit.json');
  const journal = {
    schema_version: 1,
    journal_type: 'curriculum_remote_ocr_hash_bound_seed_install',
    seed_id: prepared.seedId,
    seed_receipt_sha256: prepared.receiptSha256,
    run_identity_sha256: identitySha256,
    initial_run_status_sha256: runStatusSha256,
    items,
    citation_allowed: false,
  };
  const marker = {
    schema_version: 1,
    marker_type: 'curriculum_remote_ocr_hash_bound_seed_commit',
    seed_id: prepared.seedId,
    seed_receipt_sha256: prepared.receiptSha256,
    run_identity_sha256: identitySha256,
    initial_run_status_sha256: runStatusSha256,
    installed_items: items,
    installed_items_sha256: sha256Value(canonicalJson(items)),
    citation_allowed: false,
  };

  const markerExists = await lstat(markerPath).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (markerExists) {
    await verifyOrRepairExactJsonSidecar(outputRoot, markerPath, marker, 'seed commit marker');
    for (const item of items) {
      if (![
        seedPredecessorEvidenceDirectory,
        timeoutRecoveryGrantFilename,
        `${timeoutRecoveryGrantFilename}.sha256`,
        timeoutRecoveryLedgerIdentityFilename,
        `${timeoutRecoveryLedgerIdentityFilename}.sha256`,
        timeoutRecoveryClaimFilename,
        `${timeoutRecoveryClaimFilename}.sha256`,
        'seed-receipt.json',
        'seed-receipt.json.sha256',
        'run-identity.json',
      ].includes(item.name)) continue;
      const installedFingerprint = await seedInstallItemFingerprint(
        path.join(outputRoot, item.name),
        item.type,
      );
      if (!sameJsonValue(installedFingerprint, item.fingerprint)) {
        throw new Error(`committed seed item ${item.name} differs from the exact prepared receipt`);
      }
    }
    await rm(prepared.stageRoot, { recursive: true, force: true });
    return { marker, runStatus: await readJson(path.join(outputRoot, 'run-status.json'), 'seeded run status') };
  }

  const journalExists = await lstat(journalPath).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (journalExists) {
    await verifyOrRepairExactJsonSidecar(outputRoot, journalPath, journal, 'seed install journal');
  } else {
    for (const item of items) {
      const destination = path.join(outputRoot, item.name);
      const existsAlready = await lstat(destination).then(() => true, (error) => {
        if (error?.code === 'ENOENT') return false;
        throw error;
      });
      if (existsAlready) {
        throw new Error(`fresh seed output root already contains ${item.name}`);
      }
    }
    await writeJsonWithSidecar(journalPath, journal);
  }

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    await dependencies.beforeSeedInstallItem?.(item.name, index);
    const source = path.join(prepared.stageRoot, item.name);
    const destination = path.join(outputRoot, item.name);
    const destinationExists = await lstat(destination).then(() => true, (error) => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    });
    if (destinationExists) {
      const existingFingerprint = await seedInstallItemFingerprint(destination, item.type);
      if (!sameJsonValue(existingFingerprint, item.fingerprint)) {
        throw new Error(`partially installed seed item ${item.name} differs from the exact receipt`);
      }
      await rm(source, { recursive: item.type === 'directory', force: true });
      continue;
    }
    await rename(source, destination);
    const installedFingerprint = await seedInstallItemFingerprint(destination, item.type);
    if (!sameJsonValue(installedFingerprint, item.fingerprint)) {
      throw new Error(`installed seed item ${item.name} hash mismatch`);
    }
  }
  await writeJsonWithSidecar(markerPath, marker);
  await rm(prepared.stageRoot, { recursive: true, force: true });
  for (const entry of await readdir(outputRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(`.seed-stage-${prepared.seedId}`)) {
      await rm(path.join(outputRoot, entry.name), { recursive: true, force: true });
    }
  }
  return { marker, runStatus: prepared.runStatus };
}

async function acquireLock(outputRoot) {
  const lockPath = path.join(outputRoot, '.remote-ocr-orchestrator.lock');
  const owner = { pid: process.pid, token: randomUUID(), created_at: isoNow() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          const current = JSON.parse(await readFile(lockPath, 'utf8'));
          if (current.token === owner.token) await rm(lockPath, { force: true });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let existing;
      try {
        existing = JSON.parse(await readFile(lockPath, 'utf8'));
      } catch {
        const lockStats = await stat(lockPath);
        if (Date.now() - lockStats.mtimeMs < 60_000) throw new Error('orchestrator lock exists but is not yet readable');
        await rename(lockPath, `${lockPath}.stale-${randomUUID()}`);
        continue;
      }
      if (Number.isSafeInteger(existing.pid) && existing.pid > 0) {
        try {
          process.kill(existing.pid, 0);
          throw new Error(`orchestrator is already running as PID ${existing.pid}`);
        } catch (probeError) {
          if (probeError?.code !== 'ESRCH') throw probeError;
        }
      }
      await rename(lockPath, `${lockPath}.stale-${randomUUID()}`);
    }
  }
  throw new Error('could not acquire orchestrator lock');
}

function effectiveDocumentAttemptCeiling(seedDocument) {
  return seedDocument?.timeout_recovery ? timeoutRecoveryGrantedAttempt : maxDocumentAttempts;
}

function timeoutRecoveryStatusSeedLineage(identity, progress, seedDocument) {
  const recovery = seedDocument?.timeout_recovery;
  if (!recovery) return {};
  return {
    seed_lineage: {
      schema_version: 1,
      seed_id: identity.seed_lineage.seed_id,
      predecessor_status_sha256: seedDocument.predecessor_status_sha256,
      inherited_attempts: progress.inherited_attempts,
      timeout_recovery_grant_id: recovery.grant_id,
      timeout_recovery_grant_sha256: recovery.grant_raw_sha256,
      timeout_recovery_first_missing_page: recovery.first_missing_page,
      granted_attempt: recovery.granted_attempt,
      citation_allowed: false,
    },
  };
}

function validateExistingRunStatus(runStatus, identity, documents, seedDocumentById = null) {
  requireObject(runStatus, 'run status');
  if (runStatus.schema_version !== 1) throw new Error('run status schema_version must equal 1');
  if (runStatus.manifest_sha256 !== identity.manifest_sha256) throw new Error('run status manifest fingerprint mismatch');
  if (runStatus.runtime_fingerprint_sha256 !== identity.runtime_fingerprint_sha256) {
    throw new Error('run status runtime fingerprint mismatch');
  }
  if (JSON.stringify(runStatus.document_recovery) !== JSON.stringify(identity.document_recovery)) {
    throw new Error('run status document recovery policy mismatch');
  }
  if (runStatus.citation_allowed !== false) throw new Error('run status citation_allowed must equal false');
  const seedLineage = identity.seed_lineage === undefined
    ? null
    : requireObject(identity.seed_lineage, 'run identity seed_lineage');
  if (seedLineage) {
    const grantedDocumentIds = documents
      .map((document) => document.id)
      .filter((documentId) => seedDocumentById?.get(documentId)?.timeout_recovery);
    if (seedLineage.schema_version !== 1
      || seedLineage.mode !== seedMode
      || seedLineage.citation_allowed !== false
      || runStatus.seed_lineage?.seed_id !== seedLineage.seed_id
      || runStatus.seed_lineage?.predecessor_run_identity_sha256 !== seedLineage.predecessor_run_identity_sha256
      || !sameJsonValue(seedLineage.timeout_recovery_documents || [], grantedDocumentIds)
      || !sameJsonValue(runStatus.seed_lineage?.timeout_recovery_documents || [], grantedDocumentIds)
      || runStatus.seed_lineage?.timeout_recovery_grant_id !== seedLineage.timeout_recovery_grant_id
      || runStatus.seed_lineage?.timeout_recovery_grant_sha256 !== seedLineage.timeout_recovery_grant_sha256
      || runStatus.seed_lineage?.timeout_recovery_ledger_id !== seedLineage.timeout_recovery_ledger_id
      || runStatus.seed_lineage?.timeout_recovery_claim_sha256 !== seedLineage.timeout_recovery_claim_sha256) {
      throw new Error('run status seed lineage differs from run identity');
    }
    if (grantedDocumentIds.length > 0) {
      requireSha256(seedLineage.timeout_recovery_grant_id, 'run identity timeout recovery grant ID');
      requireSha256(seedLineage.timeout_recovery_grant_sha256, 'run identity timeout recovery grant SHA-256');
      requireSha256(seedLineage.timeout_recovery_ledger_id, 'run identity timeout recovery ledger ID');
      requireSha256(seedLineage.timeout_recovery_claim_sha256, 'run identity timeout recovery claim SHA-256');
    } else if (seedLineage.timeout_recovery_grant_id !== undefined
      || seedLineage.timeout_recovery_grant_sha256 !== undefined
      || seedLineage.timeout_recovery_ledger_id !== undefined
      || seedLineage.timeout_recovery_claim_sha256 !== undefined
      || seedLineage.timeout_recovery_documents !== undefined
      || runStatus.seed_lineage?.timeout_recovery_grant_id !== undefined
      || runStatus.seed_lineage?.timeout_recovery_grant_sha256 !== undefined
      || runStatus.seed_lineage?.timeout_recovery_ledger_id !== undefined
      || runStatus.seed_lineage?.timeout_recovery_claim_sha256 !== undefined
      || runStatus.seed_lineage?.timeout_recovery_documents !== undefined) {
      throw new Error('seed lineage unexpectedly contains timeout recovery fields');
    }
  } else if (runStatus.seed_lineage !== undefined) {
    throw new Error('unseeded run status unexpectedly contains seed lineage');
  }
  const statuses = requireObject(runStatus.documents, 'run status documents');
  const expectedIds = documents.map((document) => document.id).sort();
  if (JSON.stringify(Object.keys(statuses).sort()) !== JSON.stringify(expectedIds)) {
    throw new Error('run status document set differs from the manifest');
  }
  const allowedStatuses = new Set(['pending', 'running', 'retry_wait', 'complete', 'failed', 'interrupted', 'quarantined']);
  for (const document of documents) {
    const progress = requireObject(statuses[document.id], `${document.id} run status`);
    const seedDocument = seedDocumentById?.get(document.id) || null;
    const timeoutRecovery = seedDocument?.timeout_recovery || null;
    const attemptCeiling = effectiveDocumentAttemptCeiling(seedDocument);
    if (!allowedStatuses.has(progress.status)) throw new Error(`${document.id}: invalid run status`);
    if (!Number.isSafeInteger(progress.attempts) || progress.attempts < 0 || progress.attempts > attemptCeiling) {
      throw new Error(`${document.id}: invalid attempt count`);
    }
    if (progress.status === 'pending' && progress.attempts !== 0) throw new Error(`${document.id}: pending status cannot have attempts`);
    const sharedRuntimeFailure = progress.status === 'failed'
      && progress.failure_class === 'shared_runtime_configuration';
    if (['running', 'interrupted'].includes(progress.status) && progress.attempts < 1) {
      throw new Error(`${document.id}: ${progress.status} status requires an attempt`);
    }
    if (progress.status === 'failed' && !sharedRuntimeFailure && progress.attempts < 1) {
      throw new Error(`${document.id}: failed status requires an attempt unless it is a shared runtime failure`);
    }
    if (progress.failure_class !== undefined && !sharedRuntimeFailure) {
      throw new Error(`${document.id}: invalid failure class`);
    }
    if (progress.status === 'retry_wait') {
      if (progress.attempts < 1 || progress.attempts >= attemptCeiling) {
        throw new Error(`${document.id}: retry_wait attempt count is outside the recoverable range`);
      }
      if (!Number.isFinite(Date.parse(progress.next_retry_at))) {
        throw new Error(`${document.id}: retry_wait requires a valid next_retry_at`);
      }
    }
    if (progress.page_count !== document.page_count) throw new Error(`${document.id}: run status page count mismatch`);
    if (seedLineage) {
      if (!seedDocument
        || !seedAllowedPredecessorStatuses.has(progress.predecessor_status)
        || !Number.isSafeInteger(progress.inherited_attempts)
        || progress.inherited_attempts < 0
        || progress.inherited_attempts !== seedDocument.inherited_attempts
        || progress.predecessor_status !== seedDocument.predecessor_status
        || progress.attempts < progress.inherited_attempts
        || progress.seed_id !== seedLineage.seed_id) {
        throw new Error(`${document.id}: seeded attempt floor or predecessor status is invalid`);
      }
      if (timeoutRecovery) {
        if (seedDocument.predecessor_status !== 'quarantined'
          || seedDocument.inherited_attempts !== maxDocumentAttempts
          || timeoutRecovery.granted_attempt !== timeoutRecoveryGrantedAttempt
          || timeoutRecovery.grant_id !== seedLineage.timeout_recovery_grant_id
          || timeoutRecovery.grant_raw_sha256 !== seedLineage.timeout_recovery_grant_sha256
          || progress.attempt_ceiling !== timeoutRecoveryGrantedAttempt
          || progress.timeout_recovery_grant_id !== timeoutRecovery.grant_id
          || progress.timeout_recovery_grant_sha256 !== timeoutRecovery.grant_raw_sha256
          || progress.timeout_recovery_first_missing_page !== timeoutRecovery.first_missing_page) {
          throw new Error(`${document.id}: timeout recovery attempt-6 grant binding is invalid`);
        }
      } else if (progress.predecessor_status === 'quarantined'
        || progress.attempt_ceiling !== undefined
        || progress.timeout_recovery_grant_id !== undefined
        || progress.timeout_recovery_grant_sha256 !== undefined
        || progress.timeout_recovery_first_missing_page !== undefined) {
        throw new Error(`${document.id}: timeout recovery fields require an exact document grant`);
      }
    } else if (progress.predecessor_status !== undefined
      || progress.inherited_attempts !== undefined
      || progress.seed_id !== undefined
      || progress.attempt_ceiling !== undefined
      || progress.timeout_recovery_grant_id !== undefined
      || progress.timeout_recovery_grant_sha256 !== undefined
      || progress.timeout_recovery_first_missing_page !== undefined) {
      throw new Error(`${document.id}: unseeded progress unexpectedly contains seed fields`);
    }
  }
  return runStatus;
}

function childMonitoringPolicy(options, pageCount) {
  const values = {
    startup_timeout_seconds: options.childStartupTimeoutSeconds ?? defaultChildMonitoringPolicy.startup_timeout_seconds,
    idle_timeout_seconds: options.childIdleTimeoutSeconds ?? defaultChildMonitoringPolicy.idle_timeout_seconds,
    wall_floor_seconds: options.childWallFloorSeconds ?? defaultChildMonitoringPolicy.wall_floor_seconds,
    wall_seconds_per_page: options.childWallSecondsPerPage ?? defaultChildMonitoringPolicy.wall_seconds_per_page,
    terminate_grace_seconds: options.childTerminateGraceSeconds ?? defaultChildMonitoringPolicy.terminate_grace_seconds,
    poll_interval_seconds: options.childPollIntervalSeconds ?? defaultChildMonitoringPolicy.poll_interval_seconds,
  };
  for (const [key, value] of Object.entries(values)) requirePositiveInteger(value, `child monitoring ${key}`);
  return {
    ...values,
    wall_timeout_seconds: Math.max(values.wall_floor_seconds, values.wall_seconds_per_page * pageCount),
  };
}

async function progressSignature(pathname) {
  try {
    const fileStats = await stat(pathname);
    return `${fileStats.dev}:${fileStats.ino}:${fileStats.size}:${fileStats.mtimeMs}:${fileStats.ctimeMs}`;
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
}

export function invokeOcrChild(command, commandArguments, {
  env,
  logPath,
  documentRoot,
  monitoring,
  onChild,
}) {
  return new Promise((resolve, reject) => {
    (async () => {
      const initialStateSignature = await progressSignature(path.join(documentRoot, 'state.json'));
      const log = await open(logPath, 'a', 0o600);
      const initialLogSignature = await progressSignature(logPath);
      let child;
      try {
        child = spawn(command, commandArguments, {
          env,
          stdio: ['ignore', log.fd, log.fd],
          shell: false,
        });
      } catch (error) {
        log.close().finally(() => reject(error));
        return;
      }
      onChild?.(child);
      let settled = false;
      let monitorTimer = null;
      let killTimer = null;
      let monitorIncident = null;
      let monitorError = null;
      let lastLogSignature = initialLogSignature;
      let lastStateSignature = initialStateSignature;
      const startedAt = performance.now();
      let lastProgressAt = startedAt;
      let sawProgress = false;
      let monitorRunning = false;
      const finish = async (callback) => {
        if (settled) return;
        settled = true;
        if (monitorTimer) clearInterval(monitorTimer);
        if (killTimer) clearTimeout(killTimer);
        await log.close().catch(() => {});
        callback();
      };
      child.once('error', (error) => finish(() => reject(error)));
      child.once('close', (code, signal) => finish(() => {
        if (monitorError) reject(monitorError);
        else resolve({ code, signal, monitorIncident });
      }));

      const terminateFor = (type, elapsedMilliseconds, idleMilliseconds) => {
        if (monitorIncident || settled) return;
        monitorIncident = {
          type,
          detected_at: isoNow(),
          elapsed_seconds: Math.floor(elapsedMilliseconds / 1_000),
          idle_seconds: Math.floor(idleMilliseconds / 1_000),
          termination_signals: ['SIGTERM'],
        };
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (settled || child.exitCode !== null || child.signalCode !== null) return;
          monitorIncident.termination_signals.push('SIGKILL');
          child.kill('SIGKILL');
        }, monitoring.terminate_grace_seconds * 1_000);
      };

      const inspectProgress = async () => {
        if (settled || monitorIncident || monitorRunning) return;
        monitorRunning = true;
        try {
          const [logSignature, stateSignature] = await Promise.all([
            progressSignature(logPath),
            progressSignature(path.join(documentRoot, 'state.json')),
          ]);
          const now = performance.now();
          if (logSignature !== lastLogSignature || stateSignature !== lastStateSignature) {
            lastLogSignature = logSignature;
            lastStateSignature = stateSignature;
            sawProgress = true;
            lastProgressAt = now;
          }
          const elapsed = now - startedAt;
          const idle = now - lastProgressAt;
          if (elapsed >= monitoring.wall_timeout_seconds * 1_000) {
            terminateFor('wall_timeout', elapsed, idle);
          } else if (!sawProgress && elapsed >= monitoring.startup_timeout_seconds * 1_000) {
            terminateFor('startup_timeout', elapsed, idle);
          } else if (sawProgress && idle >= monitoring.idle_timeout_seconds * 1_000) {
            terminateFor('idle_timeout', elapsed, idle);
          }
        } catch (error) {
          monitorError = new Error(`OCR child progress monitor failed: ${error.message}`, { cause: error });
          const now = performance.now();
          terminateFor('monitor_error', now - startedAt, now - lastProgressAt);
          monitorError.monitorIncident = monitorIncident;
        } finally {
          monitorRunning = false;
        }
      };
      monitorTimer = setInterval(inspectProgress, monitoring.poll_interval_seconds * 1_000);
      monitorTimer.unref?.();
    })().catch(reject);
  });
}

const defaultInvokeOcr = invokeOcrChild;

export function terminateOwnedChild(child, graceMilliseconds, dependencies = {}) {
  if (!Number.isFinite(graceMilliseconds) || graceMilliseconds <= 0) {
    throw new Error('owned child termination grace must be a positive number of milliseconds');
  }
  const schedule = dependencies.setTimeout || setTimeout;
  const cancelSchedule = dependencies.clearTimeout || clearTimeout;
  const signals = [];
  let timer = null;
  if (child && child.exitCode === null && child.signalCode === null) {
    signals.push('SIGTERM');
    child.kill('SIGTERM');
    timer = schedule(() => {
      timer = null;
      if (child.exitCode !== null || child.signalCode !== null) return;
      signals.push('SIGKILL');
      child.kill('SIGKILL');
    }, graceMilliseconds);
    timer?.unref?.();
  }
  return {
    signals,
    cancel: () => {
      if (timer !== null) cancelSchedule(timer);
      timer = null;
    },
  };
}

export async function runRemoteOcrOffload(options, dependencies = {}) {
  const invokeOcr = dependencies.invokeOcr || defaultInvokeOcr;
  const pageCounter = dependencies.pageCounter || pdfPageCount;
  if (typeof options.runtimeDevice !== 'string' || !options.runtimeDevice.trim()) throw new Error('--runtime-device is required');
  if (options.runtimeDevice !== options.runtimeDevice.trim()) throw new Error('--runtime-device cannot have leading or trailing whitespace');
  if (typeof options.llamaServerBin !== 'string' || !options.llamaServerBin) throw new Error('--llama-server-bin is required');
  validateLlamaSystemdUnitName(options.llamaSystemdUnit);
  requirePositiveInteger(options.vlRecMaxConcurrency, '--vl-rec-max-concurrency');
  requirePositiveInteger(options.serverParallel, '--server-parallel');
  requirePositiveInteger(options.microBatch, '--micro-batch');
  if (options.microBatch > 16) throw new Error('--micro-batch must be between 1 and 16');
  if (options.microBatch > 1 && !options.useQueues) throw new Error('--micro-batch greater than 1 requires --use-queues');
  if ((options.seedDryRun || options.seedOnly) && !options.seedFromOutputRoot) {
    throw new Error('--seed-dry-run and --seed-only require --seed-from-output-root');
  }
  const monitoringContract = childMonitoringPolicy(options, 1);
  delete monitoringContract.wall_timeout_seconds;
  const manifestPath = await realpath(options.manifest);
  const manifestRaw = await readFile(manifestPath);
  const manifest = validateRemoteOcrManifest(JSON.parse(manifestRaw));
  const manifestSha256 = sha256Value(manifestRaw);
  const inputRoot = await realpath(options.inputRoot);
  const requestedOutputRoot = path.resolve(options.outputRoot);
  let seedPredecessorRoot = null;
  if (options.seedFromOutputRoot) {
    seedPredecessorRoot = await requireRealDirectory(
      options.seedFromOutputRoot,
      'seed predecessor output root',
    );
    const outputParent = await requireRealDirectory(
      path.dirname(requestedOutputRoot),
      'successor output parent',
    );
    const prospectiveOutputRoot = path.join(outputParent, path.basename(requestedOutputRoot));
    if (isWithin(seedPredecessorRoot, prospectiveOutputRoot)
      || isWithin(prospectiveOutputRoot, seedPredecessorRoot)) {
      throw new Error('seed predecessor and successor output roots must be disjoint and non-nested');
    }
  }
  if (seedPredecessorRoot) {
    await mkdir(requestedOutputRoot, { recursive: false, mode: 0o700 }).catch(async (error) => {
      if (error?.code !== 'EEXIST') throw error;
      await requireRealDirectory(requestedOutputRoot, 'successor output root');
    });
  } else {
    await mkdir(requestedOutputRoot, { recursive: true, mode: 0o700 });
  }
  const outputRoot = await requireRealDirectory(requestedOutputRoot, 'successor output root');
  if (isWithin(inputRoot, outputRoot) || isWithin(outputRoot, inputRoot)) {
    throw new Error('input and output roots must be disjoint');
  }
  if (seedPredecessorRoot
    && (isWithin(seedPredecessorRoot, outputRoot) || isWithin(outputRoot, seedPredecessorRoot))) {
    throw new Error('seed predecessor and successor output roots must be disjoint and non-nested');
  }
  const releaseLock = await acquireLock(outputRoot);
  try {
  const [pythonExecutable, ocrScript] = await Promise.all([
    validateExecutableInvocationPath(options.python, '--python'),
    realpath(options.ocrScript),
  ]);
  const python = pythonExecutable.invocationPath;
  const requestedPaddlexCacheHome = path.resolve(
    options.paddlexCacheHome || path.join(outputRoot, 'paddlex-cache'),
  );
  if (!isWithin(outputRoot, requestedPaddlexCacheHome)) {
    throw new Error('--paddlex-cache-home must stay inside the isolated output root');
  }
  const paddlexCacheParent = await requireContainedRealDirectory(
    outputRoot,
    path.dirname(requestedPaddlexCacheHome),
    'PaddleX cache parent',
  );
  if (path.join(paddlexCacheParent, path.basename(requestedPaddlexCacheHome))
    !== requestedPaddlexCacheHome) {
    throw new Error('--paddlex-cache-home cannot traverse a symbolic-link ancestor');
  }
  await mkdir(requestedPaddlexCacheHome, { recursive: false, mode: 0o700 }).catch(async (error) => {
    if (error?.code !== 'EEXIST') throw error;
    await requireContainedRealDirectory(
      outputRoot,
      requestedPaddlexCacheHome,
      'PaddleX cache root',
    );
  });
  const paddlexCacheHome = await requireContainedRealDirectory(
    outputRoot,
    requestedPaddlexCacheHome,
    'PaddleX cache root',
  );
  const runtime = dependencies.runtime || await verifyPinnedRuntime(manifest.runtime, options);
  if (JSON.stringify(runtime) !== JSON.stringify(manifest.runtime)) throw new Error('injected runtime differs from manifest runtime');
  requireLoopbackLlamaUrl(options.llamaUrl);
  const llamaServerAttestation = dependencies.llamaServerAttestation
    || await verifyLlamaServerAttestation(manifest.runtime, options, dependencies.llamaServerAttestationDependencies);
  requireObject(llamaServerAttestation, 'llama-server attestation');
  const llamaServerAttestationSha256 = sha256Value(`${JSON.stringify(llamaServerAttestation)}\n`);
  const [ocrScriptSha256, actualRunnerScriptSha256] = await Promise.all([
    sha256File(ocrScript),
    sha256File(scriptPath),
  ]);
  const runnerScriptSha256 = requireSha256(
    dependencies.runnerScriptSha256 || actualRunnerScriptSha256,
    'runner script SHA-256',
  );
  const verifyInvocationProvenance = async () => {
    const [currentPythonExecutable, currentOcrScript, currentRunnerScriptSha256] = await Promise.all([
      validateExecutableInvocationPath(options.python, '--python'),
      realpath(options.ocrScript),
      sha256File(scriptPath),
    ]);
    if (currentPythonExecutable.invocationPath !== pythonExecutable.invocationPath) {
      throw new Error('Python OCR lexical invocation path drifted');
    }
    if (currentPythonExecutable.targetPath !== pythonExecutable.targetPath) {
      throw new Error('Python OCR resolved target drifted');
    }
    if (currentOcrScript !== ocrScript) throw new Error('OCR script resolved path drifted');
    if (await sha256File(currentOcrScript) !== ocrScriptSha256) throw new Error('OCR script SHA-256 drifted');
    if (currentRunnerScriptSha256 !== actualRunnerScriptSha256) throw new Error('runner script SHA-256 drifted');
    return {
      pythonExecutable: currentPythonExecutable,
      ocrScript: currentOcrScript,
      runnerScriptSha256: currentRunnerScriptSha256,
    };
  };
  const pythonRuntime = validatePythonRuntimeIdentity(
    dependencies.pythonRuntime || (options.seedOnly
      ? probePythonPackageRuntime(python, { paddlexCacheHome })
      : probePythonOcrRuntime(python, {
        llamaUrl: options.llamaUrl,
        vlRecMaxConcurrency: options.vlRecMaxConcurrency,
        paddlexCacheHome,
      })),
  );
  const paddlexLayoutModelCache = validatePaddlexLayoutModelCacheIdentity(
    dependencies.paddlexLayoutModelCache || await fingerprintPaddlexLayoutModelCache(paddlexCacheHome),
  );
  const runtimeFingerprint = {
    ...runtime,
    runtime_device: options.runtimeDevice,
    llama_server_attestation_sha256: llamaServerAttestationSha256,
    python_runtime: pythonRuntime,
    paddlex_layout_model_cache: paddlexLayoutModelCache,
  };
  const workerConfiguration = {
    llama_url: options.llamaUrl,
    vl_rec_max_concurrency: options.vlRecMaxConcurrency,
    server_parallel: options.serverParallel,
    micro_batch: options.microBatch,
    use_queues: options.useQueues,
    runtime_device: options.runtimeDevice,
    paddlex_cache_home: paddlexCacheHome,
    python_runtime: pythonRuntime,
    paddlex_layout_model_cache_sha256: paddlexLayoutModelCache.tree_sha256,
  };
  const runtimeFingerprintSha256 = sha256Value(`${JSON.stringify(runtimeFingerprint)}\n`);
  const documentRecovery = {
    max_attempts: maxDocumentAttempts,
    backoff_seconds: documentRetryBackoffMilliseconds.map((milliseconds) => milliseconds / 1_000),
    terminal_status: 'quarantined',
    terminal_exit_code: quarantineExitCode,
    child_monitoring: monitoringContract,
  };
  const revalidateSharedRuntime = async () => {
    try {
      const current = dependencies.revalidateSharedRuntime
        ? await dependencies.revalidateSharedRuntime({
          manifestRuntime: manifest.runtime,
          options,
          expected: {
            runtime,
            llamaServerAttestation,
            pythonRuntime,
            paddlexLayoutModelCache,
          },
        })
        : {
          runtime: await verifyPinnedRuntime(manifest.runtime, options),
          llamaServerAttestation: await verifyLlamaServerAttestation(
            manifest.runtime,
            options,
            dependencies.llamaServerAttestationDependencies,
          ),
          pythonRuntime: probePythonOcrRuntime(python, {
            llamaUrl: options.llamaUrl,
            vlRecMaxConcurrency: options.vlRecMaxConcurrency,
            paddlexCacheHome,
          }),
          paddlexLayoutModelCache: await fingerprintPaddlexLayoutModelCache(paddlexCacheHome),
        };
      await verifyInvocationProvenance();
      requireObject(current, 'shared runtime revalidation');
      requireObject(current.runtime, 'revalidated pinned runtime');
      requireObject(current.llamaServerAttestation, 'revalidated llama-server attestation');
      validatePythonRuntimeIdentity(current.pythonRuntime);
      validatePaddlexLayoutModelCacheIdentity(current.paddlexLayoutModelCache);
      if (JSON.stringify(current.runtime) !== JSON.stringify(runtime)) {
        throw new Error('pinned model, mmproj, or llama.cpp runtime drifted after child failure');
      }
      if (JSON.stringify(current.llamaServerAttestation) !== JSON.stringify(llamaServerAttestation)) {
        throw new Error('llama-server attestation drifted after child failure');
      }
      if (JSON.stringify(current.pythonRuntime) !== JSON.stringify(pythonRuntime)) {
        throw new Error('Python OCR runtime identity drifted after child failure');
      }
      if (JSON.stringify(current.paddlexLayoutModelCache) !== JSON.stringify(paddlexLayoutModelCache)) {
        throw new Error('PaddleX layout model cache identity drifted after child failure');
      }
    } catch (error) {
      throw new SharedRuntimeConfigurationError(
        `shared runtime revalidation failed after OCR child failure: ${error.message}`,
        { cause: error },
      );
    }
  };
  let identity = {
    schema_version: 1,
    manifest_sha256: manifestSha256,
    runtime,
    runtime_fingerprint: runtimeFingerprint,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    llama_server_attestation: llamaServerAttestation,
    llama_server_attestation_sha256: llamaServerAttestationSha256,
    runner_script_sha256: runnerScriptSha256,
    ocr_script_sha256: ocrScriptSha256,
    input_root: inputRoot,
    python_invocation_path: python,
    python_resolved_target: pythonExecutable.targetPath,
    worker_configuration: workerConfiguration,
    document_recovery: documentRecovery,
    whole_document_atomic: true,
    citation_allowed: false,
  };
  let preparedSeed = null;
  let seededRunStatus = null;
  let seedDocumentById = null;
  if (options.seedFromOutputRoot) {
    preparedSeed = await prepareHashBoundSeed({
      predecessorRoot: seedPredecessorRoot,
      outputRoot,
      manifest,
      manifestSha256,
      successor: {
        runtime,
        runtimeFingerprint,
        runtimeFingerprintSha256,
        workerConfiguration,
        documentRecovery,
        runnerScriptSha256,
        ocrScriptSha256,
        llamaServerAttestation,
        inputRoot,
        pythonInvocationPath: python,
        pythonResolvedTarget: pythonExecutable.targetPath,
      },
      dryRun: options.seedDryRun === true,
    });
    try {
      const timeoutRecoveryConsumption = await claimTimeoutRecoveryGrant({
        prepared: preparedSeed,
        outputRoot,
        ledgerPath: options.timeoutRecoveryLedger,
        dryRun: options.seedDryRun === true,
      });
      await bindTimeoutRecoveryConsumption(
        preparedSeed,
        timeoutRecoveryConsumption,
        options.seedDryRun === true,
      );
    } catch (error) {
      await rm(preparedSeed.stageRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    identity = {
      ...identity,
      seed_lineage: {
        schema_version: 1,
        mode: seedMode,
        seed_id: preparedSeed.seedId,
        seed_receipt_sha256: preparedSeed.receiptSha256,
        predecessor_run_identity_sha256: preparedSeed.predecessor.run_identity_sha256,
        predecessor_run_status_sha256: preparedSeed.predecessor.run_status_sha256,
        predecessor_snapshot_sha256: preparedSeed.predecessor.snapshot_sha256,
        inherited_pages: preparedSeed.receipt.counts.inherited_pages,
        ...(preparedSeed.receipt.timeout_recovery_grant ? {
          timeout_recovery_grant_id: preparedSeed.receipt.timeout_recovery_grant.grant_id,
          timeout_recovery_grant_sha256: preparedSeed.receipt.timeout_recovery_grant.raw_sha256,
          timeout_recovery_ledger_id: preparedSeed.receipt.timeout_recovery_consumption.ledger_id,
          timeout_recovery_claim_sha256: preparedSeed.receipt.timeout_recovery_consumption.claim_sha256,
          timeout_recovery_documents: manifest.documents
            .map((document) => document.id)
            .filter((documentId) => preparedSeed.receipt.timeout_recovery_grant.documents.some(
              (document) => document.document_id === documentId,
            )),
        } : {}),
        citation_allowed: false,
      },
    };
    seedDocumentById = new Map(
      preparedSeed.receipt.documents.map((document) => [document.document_id, document]),
    );
    if (options.seedDryRun) {
      await rm(preparedSeed.stageRoot, { recursive: true, force: true });
      return {
        exitCode: 0,
        seedDryRun: true,
        seedReceipt: preparedSeed.receipt,
        seedReceiptSha256: preparedSeed.receiptSha256,
        runStatus: preparedSeed.runStatus,
        runStatusSha256: preparedSeed.receipt.successor.initial_run_status_sha256,
      };
    }
    const installed = await installHashBoundSeed(preparedSeed, identity, outputRoot, dependencies);
    seededRunStatus = installed.runStatus;
  } else {
    const identityPath = path.join(outputRoot, 'run-identity.json');
    try {
      await access(identityPath);
      const existingIdentity = await readJson(identityPath, 'run identity');
      if (JSON.stringify(existingIdentity) !== JSON.stringify(identity)) {
        throw new Error('run identity differs from the existing output root; use a new output root');
      }
    } catch (error) {
      if (error?.code === 'ENOENT') await atomicJson(identityPath, identity);
      else throw error;
    }
  }
  await mkdir(path.join(outputRoot, 'logs'), { recursive: true, mode: 0o700 });

  if (options.seedOnly) {
    const runStatusSha256 = await verifySha256Sidecar(path.join(outputRoot, 'run-status.json'), 'seeded run status');
    const runStatus = validateExistingRunStatus(
      seededRunStatus || await readJson(path.join(outputRoot, 'run-status.json'), 'seeded run status'),
      identity,
      manifest.documents,
      seedDocumentById,
    );
    return {
      exitCode: 0,
      seedOnly: true,
      seedReceipt: preparedSeed.receipt,
      seedReceiptSha256: preparedSeed.receiptSha256,
      runStatus,
      runStatusSha256,
    };
  }

  let activeChild = null;
  let externalTermination = null;
  let wakeRetryWait = null;
  let stopRequested = false;
  const nowMilliseconds = dependencies.nowMilliseconds || Date.now;
  const waitForRetry = dependencies.sleep || ((milliseconds) => new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeRetryWait = null;
      resolve();
    }, milliseconds);
    wakeRetryWait = () => {
      clearTimeout(timer);
      wakeRetryWait = null;
      resolve();
    };
  }));
  const requestStop = () => {
    stopRequested = true;
    wakeRetryWait?.();
    externalTermination?.cancel();
    externalTermination = terminateOwnedChild(
      activeChild,
      monitoringContract.terminate_grace_seconds * 1_000,
    );
  };
  const handleSignal = dependencies.handleSignals !== false;
  if (handleSignal) {
    process.once('SIGTERM', requestStop);
    process.once('SIGINT', requestStop);
  }

  let runStatus;
  try {
    const runStatusPath = path.join(outputRoot, 'run-status.json');
    try {
      await access(runStatusPath);
      await verifySha256Sidecar(runStatusPath, 'run status');
      runStatus = validateExistingRunStatus(
        await readJson(runStatusPath, 'run status'),
        identity,
        manifest.documents,
        seedDocumentById,
      );
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      runStatus = {
        schema_version: 1,
        manifest_sha256: identity.manifest_sha256,
        runtime_fingerprint_sha256: identity.runtime_fingerprint_sha256,
        document_recovery: identity.document_recovery,
        citation_allowed: false,
        started_at: isoNow(),
        documents: Object.fromEntries(manifest.documents.map((document) => [document.id, {
          status: 'pending',
          attempts: 0,
          page_count: document.page_count,
        }])),
      };
      await writeRunStatus(outputRoot, runStatus);
    }

    let normalizedRecoveryState = false;
    for (const document of manifest.documents) {
      const progress = runStatus.documents[document.id];
      const seedDocument = seedDocumentById?.get(document.id) || null;
      const attemptCeiling = effectiveDocumentAttemptCeiling(seedDocument);
      if (progress.status === 'failed' && progress.failure_class === 'shared_runtime_configuration') {
        delete progress.next_retry_at;
        continue;
      }
      if (!['running', 'failed', 'interrupted'].includes(progress.status) || progress.attempts < 1 || progress.attempts >= attemptCeiling) {
        continue;
      }
      const recordedAt = Date.parse(progress.interrupted_at || progress.failed_at || progress.started_at);
      const base = Number.isFinite(recordedAt) ? recordedAt : nowMilliseconds();
      const delayIndex = Math.min(progress.attempts - 1, documentRetryBackoffMilliseconds.length - 1);
      progress.status = 'retry_wait';
      progress.next_retry_at = new Date(base + documentRetryBackoffMilliseconds[delayIndex]).toISOString();
      normalizedRecoveryState = true;
    }
    if (normalizedRecoveryState) await writeRunStatus(outputRoot, runStatus);

    const workQueue = [...manifest.documents];
    const quarantine = async (document, progress, error, reason) => {
      const seedDocument = seedDocumentById?.get(document.id) || null;
      const attemptCeiling = effectiveDocumentAttemptCeiling(seedDocument);
      progress.status = 'quarantined';
      progress.quarantined_at = isoNow();
      progress.quarantine_reason = reason;
      progress.error = error.message;
      delete progress.next_retry_at;
      progress.status_json_sha256 = await writeStatus(outputRoot, document.id, {
        schema_version: 1,
        document_id: document.id,
        status: 'quarantined',
        attempt: progress.attempts,
        max_attempts: attemptCeiling,
        page_count: document.page_count,
        runtime_fingerprint_sha256: identity.runtime_fingerprint_sha256,
        citation_allowed: false,
        quarantine_reason: reason,
        error: error.message,
        quarantined_at: progress.quarantined_at,
        ...timeoutRecoveryStatusSeedLineage(identity, progress, seedDocument),
      });
      await writeRunStatus(outputRoot, runStatus);
    };
    const abortSharedRuntime = async (document, progress, error, { releaseAttempt = false } = {}) => {
      const seedDocument = seedDocumentById?.get(document.id) || null;
      const attemptCeiling = effectiveDocumentAttemptCeiling(seedDocument);
      const sharedError = error instanceof SharedRuntimeConfigurationError
        ? error
        : new SharedRuntimeConfigurationError(error.message, { cause: error });
      if (releaseAttempt) {
        if (progress.attempts < 1) throw new Error(`${document.id}: cannot release an absent OCR content attempt`);
        progress.attempts -= 1;
        if (progress.attempts < (progress.inherited_attempts || 0)) {
          throw new Error(`${document.id}: shared runtime release would cross the inherited attempt floor`);
        }
      }
      progress.status = 'failed';
      progress.failure_class = 'shared_runtime_configuration';
      progress.failed_at = isoNow();
      progress.error = sharedError.message;
      delete progress.next_retry_at;
      progress.status_json_sha256 = await writeStatus(outputRoot, document.id, {
        schema_version: 1,
        document_id: document.id,
        status: 'failed',
        failure_class: 'shared_runtime_configuration',
        attempt: progress.attempts,
        max_attempts: attemptCeiling,
        page_count: document.page_count,
        runtime_fingerprint_sha256: identity.runtime_fingerprint_sha256,
        citation_allowed: false,
        error: progress.error,
        failed_at: progress.failed_at,
        ...timeoutRecoveryStatusSeedLineage(identity, progress, seedDocument),
      });
      await writeRunStatus(outputRoot, runStatus);
      throw sharedError;
    };

    while (workQueue.length > 0 && !stopRequested) {
      const now = nowMilliseconds();
      const readyIndex = workQueue.findIndex((document) => {
        const progress = runStatus.documents[document.id];
        return progress.status !== 'retry_wait' || Date.parse(progress.next_retry_at) <= now;
      });
      if (readyIndex === -1) {
        const earliestRetry = Math.min(...workQueue.map((document) => Date.parse(runStatus.documents[document.id].next_retry_at)));
        await waitForRetry(Math.max(0, earliestRetry - now));
        continue;
      }

      const [document] = workQueue.splice(readyIndex, 1);
      const progress = requireObject(runStatus.documents[document.id], `${document.id} run status`);
      const seedDocument = seedDocumentById?.get(document.id) || null;
      const attemptCeiling = effectiveDocumentAttemptCeiling(seedDocument);
      if (progress.status === 'quarantined') continue;
      const documentRoot = path.join(outputRoot, 'documents', document.id);
      try {
        if (progress.attempts >= attemptCeiling && progress.status !== 'complete') {
          await quarantine(
            document,
            progress,
            new Error(progress.error || `OCR attempt budget exhausted after ${progress.attempts} attempts`),
            'attempt_budget_exhausted_after_restart',
          );
          continue;
        }

        const source = await preflightDocument(document, { inputRoot, python, pageCounter });
        if (stopRequested) break;
        if (progress.status === 'complete') {
          const artifacts = await validateOcrDocumentOutput(document, documentRoot, runtime, {
            workerConfiguration,
          });
          progress.verified_at = isoNow();
          progress.status_json_sha256 = await writeStatus(outputRoot, document.id, {
            schema_version: 1,
            document_id: document.id,
            status: 'complete',
            attempt: progress.attempts,
            max_attempts: attemptCeiling,
            source_sha256: source.sourceSha256,
            page_count: source.pageCount,
            runtime_fingerprint_sha256: identity.runtime_fingerprint_sha256,
            citation_allowed: false,
            whole_document_atomic: true,
            artifacts,
            verified_at: progress.verified_at,
            ...timeoutRecoveryStatusSeedLineage(identity, progress, seedDocument),
          });
          await writeRunStatus(outputRoot, runStatus);
          continue;
        }

        try {
          await access(path.join(documentRoot, 'state.json'));
          await validateOcrDocumentOutput(document, documentRoot, runtime, {
            requireComplete: false,
            workerConfiguration,
          });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }

        try {
          await verifyInvocationProvenance();
        } catch (error) {
          await abortSharedRuntime(
            document,
            progress,
            new SharedRuntimeConfigurationError(
              `OCR child spawn provenance validation failed: ${error.message}`,
              { cause: error },
            ),
          );
        }

        progress.status = 'running';
        progress.attempts += 1;
        progress.started_at = isoNow();
        delete progress.failure_class;
        delete progress.error;
        delete progress.next_retry_at;
        await writeRunStatus(outputRoot, runStatus);
        await writeStatus(outputRoot, document.id, {
          schema_version: 1,
          document_id: document.id,
          status: 'running',
          attempt: progress.attempts,
          max_attempts: attemptCeiling,
          page_count: document.page_count,
          runtime_fingerprint_sha256: identity.runtime_fingerprint_sha256,
          citation_allowed: false,
          started_at: progress.started_at,
          ...timeoutRecoveryStatusSeedLineage(identity, progress, seedDocument),
        });

        const commandArguments = [
          ocrScript,
          document.id,
          source.sourcePath,
          path.join(outputRoot, 'documents'),
          '--llama-url', options.llamaUrl,
          '--dpi', String(runtime.render_dpi),
          '--vl-rec-max-concurrency', String(options.vlRecMaxConcurrency),
          '--server-parallel', String(options.serverParallel),
          '--micro-batch', String(options.microBatch),
          '--runtime-device', options.runtimeDevice,
        ];
        if (options.useQueues) commandArguments.push('--use-queues');
        if (identity.seed_lineage) {
          const seedDocument = seedDocumentById.get(document.id);
          commandArguments.push(
            '--seed-id', identity.seed_lineage.seed_id,
            '--seed-predecessor-run-identity-sha256', identity.seed_lineage.predecessor_run_identity_sha256,
            '--seed-predecessor-configuration-sha256', seedDocument.predecessor_configuration_sha256,
          );
        }
        let childResult;
        let invocationError;
        try {
          childResult = await invokeOcr(python, commandArguments, {
            env: { ...process.env, PADDLE_PDX_CACHE_HOME: workerConfiguration.paddlex_cache_home },
            logPath: path.join(outputRoot, 'logs', `${document.id}.log`),
            documentRoot,
            monitoring: childMonitoringPolicy(options, document.page_count),
            onChild: (child) => {
              activeChild = child;
              if (stopRequested) {
                externalTermination?.cancel();
                externalTermination = terminateOwnedChild(
                  child,
                  monitoringContract.terminate_grace_seconds * 1_000,
                );
              }
            },
          });
        } catch (error) {
          invocationError = error;
        } finally {
          externalTermination?.cancel();
          externalTermination = null;
          activeChild = null;
        }
        if (stopRequested) {
          progress.status = 'interrupted';
          progress.interrupted_at = isoNow();
          progress.signal = childResult?.signal || 'SIGTERM';
          progress.status_json_sha256 = await writeStatus(outputRoot, document.id, {
            schema_version: 1,
            document_id: document.id,
            status: 'interrupted',
            attempt: progress.attempts,
            max_attempts: attemptCeiling,
            page_count: document.page_count,
            runtime_fingerprint_sha256: identity.runtime_fingerprint_sha256,
            citation_allowed: false,
            interrupted_at: progress.interrupted_at,
            ...timeoutRecoveryStatusSeedLineage(identity, progress, seedDocument),
          });
          await writeRunStatus(outputRoot, runStatus);
          break;
        }
        const monitorIncident = childResult?.monitorIncident || invocationError?.monitorIncident;
        const childFailureRequiresRuntimeRevalidation = Boolean(
          invocationError
          || monitorIncident
          || childResult?.signal
          || (childResult && childResult.code !== 0),
        );
        if (childFailureRequiresRuntimeRevalidation) {
          try {
            await revalidateSharedRuntime();
          } catch (error) {
            await abortSharedRuntime(document, progress, error, { releaseAttempt: true });
          }
        }
        if (monitorIncident) {
          try {
            await access(path.join(documentRoot, 'state.json'));
            await validateOcrDocumentOutput(document, documentRoot, runtime, {
              requireComplete: false,
              workerConfiguration,
            });
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
          throw new RetryableOcrFailure(
            `OCR child ${monitorIncident.type} after ${monitorIncident.elapsed_seconds}s; `
            + `terminated with ${monitorIncident.termination_signals.join(' then ')}`,
          );
        }
        if (invocationError) throw new RetryableOcrFailure(`OCR child invocation failed: ${invocationError.message}`);
        if (childResult.code === 2) {
          await abortSharedRuntime(
            document,
            progress,
            new SharedRuntimeConfigurationError('OCR child exited 2 (shared runtime/configuration fault)'),
            { releaseAttempt: true },
          );
        }
        if (childResult.signal) throw new RetryableOcrFailure(`OCR child terminated by ${childResult.signal}`);
        if (childResult.code !== 0) throw new RetryableOcrFailure(`OCR child exited ${childResult.code}`);
        let artifacts;
        try {
          artifacts = await validateOcrDocumentOutput(document, documentRoot, runtime, {
            workerConfiguration,
          });
        } catch (error) {
          if (error instanceof IncompleteOcrDocumentError) throw new RetryableOcrFailure(error.message);
          throw error;
        }
        progress.status = 'complete';
        progress.completed_at = isoNow();
        delete progress.next_retry_at;
        progress.status_json_sha256 = await writeStatus(outputRoot, document.id, {
          schema_version: 1,
          document_id: document.id,
          status: 'complete',
          attempt: progress.attempts,
          max_attempts: attemptCeiling,
          source_sha256: source.sourceSha256,
          page_count: source.pageCount,
          runtime_fingerprint_sha256: identity.runtime_fingerprint_sha256,
          citation_allowed: false,
          whole_document_atomic: true,
          artifacts,
          completed_at: progress.completed_at,
          ...timeoutRecoveryStatusSeedLineage(identity, progress, seedDocument),
        });
        await writeRunStatus(outputRoot, runStatus);
      } catch (error) {
        if (error instanceof SharedRuntimeConfigurationError) throw error;
        if (!(error instanceof RetryableOcrFailure)) {
          await quarantine(document, progress, error, 'integrity_or_preflight_failure');
          continue;
        }
        if (progress.attempts >= attemptCeiling) {
          await quarantine(document, progress, error, 'attempt_budget_exhausted');
          continue;
        }
        const delayMilliseconds = documentRetryBackoffMilliseconds[progress.attempts - 1];
        progress.status = 'retry_wait';
        progress.failed_at = isoNow();
        progress.next_retry_at = new Date(nowMilliseconds() + delayMilliseconds).toISOString();
        progress.error = error.message;
        progress.status_json_sha256 = await writeStatus(outputRoot, document.id, {
          schema_version: 1,
          document_id: document.id,
          status: 'retry_wait',
          attempt: progress.attempts,
          max_attempts: attemptCeiling,
          retry_delay_seconds: delayMilliseconds / 1_000,
          next_retry_at: progress.next_retry_at,
          page_count: document.page_count,
          runtime_fingerprint_sha256: identity.runtime_fingerprint_sha256,
          citation_allowed: false,
          error: error.message,
          failed_at: progress.failed_at,
          ...timeoutRecoveryStatusSeedLineage(identity, progress, seedDocument),
        });
        await writeRunStatus(outputRoot, runStatus);
        workQueue.push(document);
      }
    }
    const statuses = Object.values(runStatus.documents).map((document) => document.status);
    runStatus.updated_at = isoNow();
    runStatus.counts = {
      total: statuses.length,
      complete: statuses.filter((status) => status === 'complete').length,
      failed: statuses.filter((status) => status === 'failed').length,
      interrupted: statuses.filter((status) => status === 'interrupted').length,
      pending: statuses.filter((status) => status === 'pending').length,
      running: statuses.filter((status) => status === 'running').length,
      retry_wait: statuses.filter((status) => status === 'retry_wait').length,
      quarantined: statuses.filter((status) => status === 'quarantined').length,
    };
    runStatus.finished = runStatus.counts.complete === runStatus.counts.total;
    runStatus.settled = runStatus.counts.complete + runStatus.counts.quarantined === runStatus.counts.total;
    const runStatusSha256 = await writeRunStatus(outputRoot, runStatus);
    const exitCode = stopRequested
      ? 75
      : runStatus.counts.quarantined > 0
        ? quarantineExitCode
        : runStatus.finished
          ? 0
          : 1;
    return { exitCode, runStatus, runStatusSha256 };
  } finally {
    externalTermination?.cancel();
    if (handleSignal) {
      process.removeListener('SIGTERM', requestStop);
      process.removeListener('SIGINT', requestStop);
    }
  }
  } finally {
    await releaseLock();
  }
}

function usage() {
  return [
    'Usage: node scripts/run-remote-ocr-offload.mjs --manifest PATH --input-root DIR --output-root DIR \\',
    '  --python PATH --ocr-script PATH --model PATH --mmproj PATH --llama-repo DIR \\',
    '  --llama-server-bin PATH --llama-systemd-unit UNIT --runtime-device LABEL [options]',
    '',
    'Options:',
    '  --llama-url URL                 Default: http://127.0.0.1:8112/v1',
    '  --vl-rec-max-concurrency N      Must match the llama-server parallelism policy.',
    '  --server-parallel N             Recorded in every OCR state.',
    '  --micro-batch N                 1-16; values above 1 require --use-queues.',
    '  --use-queues                    Enable Paddle queued list prediction.',
    '  --runtime-device LABEL          Exact device label written into OCR state and runtime identity.',
    '  --paddlex-cache-home DIR        Default: OUTPUT_ROOT/paddlex-cache.',
    '  --seed-from-output-root DIR      Hash-verify and stage an immutable predecessor into this new output root.',
    '  --timeout-recovery-ledger DIR    Existing grant-bound append-only ledger; required for timeout recovery.',
    '  --seed-dry-run                   Validate the exact seed receipt without installing it; implies --seed-only.',
    '  --seed-only                      Commit the seed transaction and exit before starting OCR.',
    '  --llama-server-bin PATH         Running pinned llama-server executable under --llama-repo.',
    '  --llama-systemd-unit UNIT       Active user .service unit whose MainPID owns the server.',
    '  --child-startup-timeout-seconds N  Default: 180.',
    '  --child-idle-timeout-seconds N     Default: 300 after state/log progress.',
    '  --child-wall-floor-seconds N       Default: 1200.',
    '  --child-wall-seconds-per-page N    Default: 25; wall limit is max(floor, N × pages).',
    '  --child-terminate-grace-seconds N  Default: 15 before SIGKILL.',
    '  --child-poll-interval-seconds N    Default: 5.',
    '',
    'Document recovery is capped at 5 attempts with 2/10/30/60-second backoff.',
    'Timed-out OCR children receive SIGTERM, then SIGKILL after the configured grace period.',
    'systemd must set RestartPreventExitStatus=2 12 75 and a bounded StartLimitIntervalSec/StartLimitBurst.',
    'Exit 2 is a permanent startup/configuration fault, 12 is terminal quarantine, and 75 is an interrupted run.',
    'The runner stages remote primary OCR only. It never imports local OCR state or makes results citation-eligible.',
  ].join('\n');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await runRemoteOcrOffload(options);
  process.stdout.write(`${JSON.stringify({
    finished: result.runStatus.finished,
    counts: result.runStatus.counts,
    run_status_sha256: result.runStatusSha256,
    seed_id: result.seedReceipt?.seed_id || null,
    seed_receipt_sha256: result.seedReceiptSha256 || null,
    seed_only: result.seedOnly === true,
    seed_dry_run: result.seedDryRun === true,
  })}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`run-remote-ocr-offload: ${error.message}\n`);
    process.exitCode = 2;
  });
}
