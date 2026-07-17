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
  validatePythonRuntimeIdentity(workerConfiguration.python_runtime);
  const configurationContract = {
    recognizer_server_url: workerConfiguration.llama_url,
    vl_rec_max_concurrency: workerConfiguration.vl_rec_max_concurrency,
    server_parallel: workerConfiguration.server_parallel,
    micro_batch: workerConfiguration.micro_batch,
    use_queues: workerConfiguration.use_queues,
    device: workerConfiguration.runtime_device,
    python: workerConfiguration.python_runtime.python_version,
    paddlepaddle: workerConfiguration.python_runtime.packages.paddlepaddle,
    paddleocr: workerConfiguration.python_runtime.packages.paddleocr,
    paddlex: workerConfiguration.python_runtime.packages.paddlex,
  };
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

function validateExistingRunStatus(runStatus, identity, documents) {
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
  const statuses = requireObject(runStatus.documents, 'run status documents');
  const expectedIds = documents.map((document) => document.id).sort();
  if (JSON.stringify(Object.keys(statuses).sort()) !== JSON.stringify(expectedIds)) {
    throw new Error('run status document set differs from the manifest');
  }
  const allowedStatuses = new Set(['pending', 'running', 'retry_wait', 'complete', 'failed', 'interrupted', 'quarantined']);
  for (const document of documents) {
    const progress = requireObject(statuses[document.id], `${document.id} run status`);
    if (!allowedStatuses.has(progress.status)) throw new Error(`${document.id}: invalid run status`);
    if (!Number.isSafeInteger(progress.attempts) || progress.attempts < 0 || progress.attempts > maxDocumentAttempts) {
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
      if (progress.attempts < 1 || progress.attempts >= maxDocumentAttempts) {
        throw new Error(`${document.id}: retry_wait attempt count is outside the recoverable range`);
      }
      if (!Number.isFinite(Date.parse(progress.next_retry_at))) {
        throw new Error(`${document.id}: retry_wait requires a valid next_retry_at`);
      }
    }
    if (progress.page_count !== document.page_count) throw new Error(`${document.id}: run status page count mismatch`);
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
  const monitoringContract = childMonitoringPolicy(options, 1);
  delete monitoringContract.wall_timeout_seconds;
  const manifestPath = await realpath(options.manifest);
  const manifestRaw = await readFile(manifestPath);
  const manifest = validateRemoteOcrManifest(JSON.parse(manifestRaw));
  const inputRoot = await realpath(options.inputRoot);
  await mkdir(options.outputRoot, { recursive: true, mode: 0o700 });
  const outputRoot = await realpath(options.outputRoot);
  if (isWithin(inputRoot, outputRoot) || isWithin(outputRoot, inputRoot)) {
    throw new Error('input and output roots must be disjoint');
  }
  const releaseLock = await acquireLock(outputRoot);
  try {
  const [pythonExecutable, ocrScript] = await Promise.all([
    validateExecutableInvocationPath(options.python, '--python'),
    realpath(options.ocrScript),
  ]);
  const python = pythonExecutable.invocationPath;
  const paddlexCacheHome = path.resolve(options.paddlexCacheHome || path.join(outputRoot, 'paddlex-cache'));
  if (!isWithin(outputRoot, paddlexCacheHome)) throw new Error('--paddlex-cache-home must stay inside the isolated output root');
  await mkdir(paddlexCacheHome, { recursive: true, mode: 0o700 });
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
    dependencies.pythonRuntime || probePythonOcrRuntime(python, {
      llamaUrl: options.llamaUrl,
      vlRecMaxConcurrency: options.vlRecMaxConcurrency,
      paddlexCacheHome,
    }),
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
  const identity = {
    schema_version: 1,
    manifest_sha256: sha256Value(manifestRaw),
    runtime,
    runtime_fingerprint: runtimeFingerprint,
    runtime_fingerprint_sha256: sha256Value(`${JSON.stringify(runtimeFingerprint)}\n`),
    llama_server_attestation: llamaServerAttestation,
    llama_server_attestation_sha256: llamaServerAttestationSha256,
    runner_script_sha256: runnerScriptSha256,
    ocr_script_sha256: ocrScriptSha256,
    input_root: inputRoot,
    python_invocation_path: python,
    python_resolved_target: pythonExecutable.targetPath,
    worker_configuration: workerConfiguration,
    document_recovery: {
      max_attempts: maxDocumentAttempts,
      backoff_seconds: documentRetryBackoffMilliseconds.map((milliseconds) => milliseconds / 1_000),
      terminal_status: 'quarantined',
      terminal_exit_code: quarantineExitCode,
      child_monitoring: monitoringContract,
    },
    whole_document_atomic: true,
    citation_allowed: false,
  };
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
  await mkdir(path.join(outputRoot, 'logs'), { recursive: true, mode: 0o700 });

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
      runStatus = validateExistingRunStatus(await readJson(runStatusPath, 'run status'), identity, manifest.documents);
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
      if (progress.status === 'failed' && progress.failure_class === 'shared_runtime_configuration') {
        delete progress.next_retry_at;
        continue;
      }
      if (!['running', 'failed', 'interrupted'].includes(progress.status) || progress.attempts < 1 || progress.attempts >= maxDocumentAttempts) {
        continue;
      }
      const recordedAt = Date.parse(progress.interrupted_at || progress.failed_at || progress.started_at);
      const base = Number.isFinite(recordedAt) ? recordedAt : nowMilliseconds();
      progress.status = 'retry_wait';
      progress.next_retry_at = new Date(base + documentRetryBackoffMilliseconds[progress.attempts - 1]).toISOString();
      normalizedRecoveryState = true;
    }
    if (normalizedRecoveryState) await writeRunStatus(outputRoot, runStatus);

    const workQueue = [...manifest.documents];
    const quarantine = async (document, progress, error, reason) => {
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
        max_attempts: maxDocumentAttempts,
        page_count: document.page_count,
        runtime_fingerprint_sha256: identity.runtime_fingerprint_sha256,
        citation_allowed: false,
        quarantine_reason: reason,
        error: error.message,
        quarantined_at: progress.quarantined_at,
      });
      await writeRunStatus(outputRoot, runStatus);
    };
    const abortSharedRuntime = async (document, progress, error, { releaseAttempt = false } = {}) => {
      const sharedError = error instanceof SharedRuntimeConfigurationError
        ? error
        : new SharedRuntimeConfigurationError(error.message, { cause: error });
      if (releaseAttempt) {
        if (progress.attempts < 1) throw new Error(`${document.id}: cannot release an absent OCR content attempt`);
        progress.attempts -= 1;
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
        max_attempts: maxDocumentAttempts,
        page_count: document.page_count,
        runtime_fingerprint_sha256: identity.runtime_fingerprint_sha256,
        citation_allowed: false,
        error: progress.error,
        failed_at: progress.failed_at,
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
      if (progress.status === 'quarantined') continue;
      const documentRoot = path.join(outputRoot, 'documents', document.id);
      try {
        if (progress.attempts >= maxDocumentAttempts && progress.status !== 'complete') {
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
            source_sha256: source.sourceSha256,
            page_count: source.pageCount,
            runtime_fingerprint_sha256: identity.runtime_fingerprint_sha256,
            citation_allowed: false,
            whole_document_atomic: true,
            artifacts,
            verified_at: progress.verified_at,
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
          max_attempts: maxDocumentAttempts,
          page_count: document.page_count,
          runtime_fingerprint_sha256: identity.runtime_fingerprint_sha256,
          citation_allowed: false,
          started_at: progress.started_at,
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
            max_attempts: maxDocumentAttempts,
            citation_allowed: false,
            interrupted_at: progress.interrupted_at,
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
          source_sha256: source.sourceSha256,
          page_count: source.pageCount,
          runtime_fingerprint_sha256: identity.runtime_fingerprint_sha256,
          citation_allowed: false,
          whole_document_atomic: true,
          artifacts,
          completed_at: progress.completed_at,
        });
        await writeRunStatus(outputRoot, runStatus);
      } catch (error) {
        if (error instanceof SharedRuntimeConfigurationError) throw error;
        if (!(error instanceof RetryableOcrFailure)) {
          await quarantine(document, progress, error, 'integrity_or_preflight_failure');
          continue;
        }
        if (progress.attempts >= maxDocumentAttempts) {
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
          max_attempts: maxDocumentAttempts,
          retry_delay_seconds: delayMilliseconds / 1_000,
          next_retry_at: progress.next_retry_at,
          page_count: document.page_count,
          runtime_fingerprint_sha256: identity.runtime_fingerprint_sha256,
          citation_allowed: false,
          error: error.message,
          failed_at: progress.failed_at,
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
  })}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`run-remote-ocr-offload: ${error.message}\n`);
    process.exitCode = 2;
  });
}
