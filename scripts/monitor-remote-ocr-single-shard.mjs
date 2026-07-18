#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  statfs,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  parseMeminfo,
  parseNvidiaSmi,
  parseSystemdShow,
} from './monitor-remote-ocr-reprocess.mjs';
import { fingerprintPaddlexLayoutModelCache } from './run-remote-ocr-offload.mjs';

const execFile = promisify(execFileCallback);
const gib = 1024 ** 3;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const documentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const unitPattern = /^[A-Za-z0-9][A-Za-z0-9_.@:-]*\.service$/u;
const seedMode = 'hash_bound_output_seed';
const seedReceiptType = 'curriculum_remote_ocr_hash_bound_output_seed';
const legacyB1RunnerScriptSha256 = 'b08c3f7aa3da6e44dd9fffeecaf20b2a020df4d604c9b957399abaf886d15a55';
const maxDocumentAttempts = 5;
const documentRetryBackoffMilliseconds = Object.freeze([2_000, 10_000, 30_000, 60_000]);
const allowedStatuses = new Set([
  'pending',
  'running',
  'retry_wait',
  'complete',
  'failed',
  'interrupted',
  'quarantined',
]);
const seedablePredecessorStatuses = new Set(['pending', 'retry_wait', 'complete', 'interrupted']);
const installedItemSpecifications = Object.freeze([
  { name: 'documents', type: 'directory' },
  { name: 'status', type: 'directory' },
  { name: 'seed-predecessor-evidence', type: 'directory' },
  { name: 'seed-receipt.json', type: 'file' },
  { name: 'seed-receipt.json.sha256', type: 'file' },
  { name: 'run-identity.json', type: 'file' },
  { name: 'run-status.json', type: 'file' },
  { name: 'run-status.json.sha256', type: 'file' },
]);
const immutableInstalledItems = new Set([
  'seed-predecessor-evidence',
  'seed-receipt.json',
  'seed-receipt.json.sha256',
  'run-identity.json',
]);
const defaultThresholds = Object.freeze({
  stall_seconds: 1500,
  disk_min_gib: 50,
  memory_min_gib: 2,
  gpu_max_c: 85,
});

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const iso = (milliseconds) => new Date(milliseconds).toISOString();

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireSha256(value, label) {
  if (!sha256Pattern.test(String(value || ''))) throw new Error(`${label} must be a lowercase SHA-256`);
  return value;
}

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function requireNonnegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a nonnegative integer`);
  return parsed;
}

function requirePositiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be greater than zero`);
  return parsed;
}

function requireDocumentId(value, label = 'document id') {
  if (!documentIdPattern.test(String(value || ''))) throw new Error(`${label} is unsafe`);
  return value;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function disjoint(left, right) {
  return !inside(left, right) && !inside(right, left);
}

function parsePair(value, label) {
  const separator = value.indexOf('=');
  if (separator < 1 || separator === value.length - 1) throw new Error(`${label} must use LABEL=VALUE`);
  return [value.slice(0, separator), value.slice(separator + 1)];
}

export function parseSingleShardMonitorArgs(argv) {
  const values = {
    oldWorkerUnits: new Map(),
    llamaUnit: 'curriculum-ocr-llama.service',
    llamaHealthUrl: 'http://127.0.0.1:8112/health',
    thresholds: { ...defaultThresholds },
    predecessorAnchors: {},
  };
  const anchorArguments = new Map([
    ['--b1-identity-sha256', 'identity_sha256'],
    ['--b1-run-status-sha256', 'run_status_sha256'],
    ['--b1-state-hashset-sha256', 'state_hashset_sha256'],
    ['--b1-status-hashset-sha256', 'status_hashset_sha256'],
    ['--b1-artifact-hashset-sha256', 'artifact_hashset_sha256'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      index += 1;
      return value;
    };
    if (argument === '--run-root') values.runRoot = path.resolve(next());
    else if (argument === '--predecessor-output') values.predecessorOutput = next();
    else if (argument === '--successor-output') values.successorOutput = next();
    else if (argument === '--output-dir') values.outputDir = path.resolve(next());
    else if (argument === '--worker-unit') values.workerUnit = next();
    else if (argument === '--old-worker-unit') {
      const [label, unit] = parsePair(next(), '--old-worker-unit');
      values.oldWorkerUnits.set(label, unit);
    } else if (argument === '--llama-unit') values.llamaUnit = next();
    else if (argument === '--llama-health-url') values.llamaHealthUrl = next();
    else if (argument === '--stall-seconds') values.thresholds.stall_seconds = requirePositiveInteger(next(), argument);
    else if (argument === '--disk-min-gib') values.thresholds.disk_min_gib = requirePositiveNumber(next(), argument);
    else if (argument === '--memory-min-gib') values.thresholds.memory_min_gib = requirePositiveNumber(next(), argument);
    else if (argument === '--gpu-max-c') values.thresholds.gpu_max_c = requirePositiveNumber(next(), argument);
    else if (anchorArguments.has(argument)) values.predecessorAnchors[anchorArguments.get(argument)] = next();
    else if (argument === '--help') values.help = true;
    else throw new Error(`unexpected argument: ${argument}`);
  }

  if (values.help) return values;
  if (!values.runRoot) throw new Error('--run-root is required');
  if (!values.predecessorOutput) throw new Error('--predecessor-output is required');
  if (!values.successorOutput) throw new Error('--successor-output is required');
  if (!values.outputDir) throw new Error('--output-dir is required');
  for (const [label, relative] of [
    ['predecessor', values.predecessorOutput],
    ['successor', values.successorOutput],
  ]) {
    if (path.isAbsolute(relative)) throw new Error(`${label} output must be relative to --run-root`);
    const resolved = path.resolve(values.runRoot, relative);
    if (!inside(values.runRoot, resolved)) throw new Error(`${label} output escapes --run-root`);
  }
  const predecessorRoot = path.resolve(values.runRoot, values.predecessorOutput);
  const successorRoot = path.resolve(values.runRoot, values.successorOutput);
  if (!disjoint(predecessorRoot, successorRoot)) throw new Error('predecessor and successor outputs must be disjoint and non-nested');
  if (!inside(values.runRoot, values.outputDir)) throw new Error('--output-dir must be inside --run-root');
  if (!disjoint(values.outputDir, predecessorRoot) || !disjoint(values.outputDir, successorRoot)) {
    throw new Error('--output-dir must be disjoint from both OCR output roots');
  }
  for (const [label, unit] of [
    ['worker', values.workerUnit],
    ['llama', values.llamaUnit],
  ]) {
    if (!unitPattern.test(String(unit || ''))) throw new Error(`${label} unit is invalid`);
  }
  for (const label of ['a', 'b']) {
    const unit = values.oldWorkerUnits.get(label);
    if (!unitPattern.test(String(unit || ''))) throw new Error(`old worker ${label} unit is invalid`);
  }
  if ([...values.oldWorkerUnits.keys()].some((label) => !['a', 'b'].includes(label))) {
    throw new Error('only old worker labels a and b are allowed');
  }
  if (new Set([values.workerUnit, values.llamaUnit, ...values.oldWorkerUnits.values()]).size !== 4) {
    throw new Error('worker, old-worker, and llama units must be distinct');
  }
  if (!/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9/_-]*$/u.test(values.llamaHealthUrl)) {
    throw new Error('--llama-health-url must be an explicit 127.0.0.1 HTTP endpoint');
  }
  for (const name of anchorArguments.values()) requireSha256(values.predecessorAnchors[name], name);
  return values;
}

async function requireRealDirectory(pathname, label) {
  const info = await lstat(pathname).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing`);
    throw error;
  });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  return realpath(pathname);
}

async function inspectBoundPaddlexCache(root, identity, label) {
  const expectedCacheHome = path.join(root, 'paddlex-cache');
  const cacheHome = await requireRealDirectory(expectedCacheHome, `${label} PaddleX cache root`);
  if (cacheHome !== expectedCacheHome) throw new Error(`${label} PaddleX cache root is not canonical`);
  const worker = requireObject(identity.worker_configuration, `${label} worker configuration`);
  if (worker.paddlex_cache_home !== cacheHome) {
    throw new Error(`${label} worker paddlex_cache_home must equal its real output cache root`);
  }
  const expectedOfficialModels = path.join(cacheHome, 'official_models');
  const officialModels = await requireRealDirectory(
    expectedOfficialModels,
    `${label} PaddleX official_models root`,
  );
  if (officialModels !== expectedOfficialModels) {
    throw new Error(`${label} PaddleX official_models root is not canonical`);
  }
  const fingerprint = await fingerprintPaddlexLayoutModelCache(cacheHome);
  if (worker.paddlex_layout_model_cache_sha256 !== fingerprint.tree_sha256) {
    throw new Error(`${label} PaddleX cache tree hash differs from its worker identity`);
  }
  const runtimeFingerprint = requireObject(identity.runtime_fingerprint, `${label} runtime fingerprint`);
  if (!sameJson(runtimeFingerprint.paddlex_layout_model_cache, fingerprint)) {
    throw new Error(`${label} PaddleX cache fingerprint differs from its runtime identity`);
  }
  return fingerprint;
}

async function readStableRaw(root, pathname, label, attempts = 3) {
  if (!inside(root, pathname)) throw new Error(`${label} escapes its root`);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const before = await lstat(pathname);
      if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
      const resolved = await realpath(pathname);
      if (!inside(root, resolved) || resolved !== path.resolve(pathname)) throw new Error(`${label} traverses a symbolic link`);
      const raw = await readFile(pathname);
      const after = await stat(pathname);
      if (before.dev !== after.dev
        || before.ino !== after.ino
        || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs) {
        throw new Error(`${label} changed while it was read`);
      }
      return { raw, sha256: sha256(raw), bytes: raw.byteLength, metadata: after };
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(75);
    }
  }
  throw lastError;
}

async function readStableJson(root, pathname, label) {
  const record = await readStableRaw(root, pathname, label);
  try {
    return { ...record, value: JSON.parse(record.raw.toString('utf8')) };
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function parseSidecar(raw, basename, label) {
  const match = /^([a-f0-9]{64})  ([^\r\n]+)\n$/u.exec(raw.toString('utf8'));
  if (!match || match[2] !== basename) throw new Error(`${label} SHA-256 sidecar format is invalid`);
  return match[1];
}

async function readHashBoundJson(root, pathname, label) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const [body, sidecar] = await Promise.all([
        readStableJson(root, pathname, label),
        readStableRaw(root, `${pathname}.sha256`, `${label} SHA-256 sidecar`, 1),
      ]);
      const expected = parseSidecar(sidecar.raw, path.basename(pathname), label);
      if (body.sha256 !== expected) throw new Error(`${label} SHA-256 sidecar mismatch`);
      return { ...body, sidecar_sha256: sidecar.sha256, sidecar_raw: sidecar.raw };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(75);
    }
  }
  throw lastError;
}

function normalizedPages(value, pageCount, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const pages = value.map(Number).sort((left, right) => left - right);
  if (new Set(pages).size !== pages.length
    || pages.some((page) => !Number.isSafeInteger(page) || page < 1 || page > pageCount)) {
    throw new Error(`${label} contains duplicate or invalid pages`);
  }
  return pages;
}

function exactCounts(documents) {
  const counts = {
    total: documents.length,
    complete: 0,
    failed: 0,
    interrupted: 0,
    pending: 0,
    running: 0,
    retry_wait: 0,
    quarantined: 0,
  };
  for (const document of documents) counts[document.status] += 1;
  return counts;
}

function assertRunCounts(runStatus, documents, label) {
  const { counts, declaredCountsMatch } = deriveRunCounts(runStatus, documents, label);
  if (!declaredCountsMatch) throw new Error(`${label} counts differ from document statuses`);
  return counts;
}

function deriveRunCounts(runStatus, documents, label) {
  const counts = exactCounts(documents);
  const declared = requireObject(runStatus.counts, `${label} counts`);
  const keys = Object.keys(counts).sort();
  if (!sameJson(Object.keys(declared).sort(), keys)) throw new Error(`${label} counts schema is invalid`);
  if (keys.some((key) => !Number.isSafeInteger(declared[key]) || declared[key] < 0)) {
    throw new Error(`${label} counts values are invalid`);
  }
  if (declared.total !== counts.total
    || keys.filter((key) => key !== 'total').reduce((sum, key) => sum + declared[key], 0) !== declared.total) {
    throw new Error(`${label} declared counts total is invalid`);
  }
  if (runStatus.finished !== (counts.complete === counts.total)) throw new Error(`${label} finished flag is inconsistent`);
  if (runStatus.settled !== (counts.complete + counts.quarantined === counts.total)) {
    throw new Error(`${label} settled flag is inconsistent`);
  }
  return { counts, declaredCountsMatch: sameJson(declared, counts) };
}

function fingerprintRecords(records) {
  return sha256(canonicalJson(records));
}

function posixRelative(root, pathname) {
  return path.relative(root, pathname).split(path.sep).join('/');
}

export async function inspectTreeStrict(root) {
  const canonicalRoot = await requireRealDirectory(root, 'tree root');
  const entries = [];
  let files = 0;
  let bytes = 0;
  async function walk(directory, relativeDirectory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareText(left.name, right.name));
    if (relativeDirectory && children.length === 0) entries.push(`D\0${relativeDirectory}\n`);
    for (const child of children) {
      const pathname = path.join(directory, child.name);
      const info = await lstat(pathname);
      if (info.isSymbolicLink()) throw new Error('tree contains a symbolic link');
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      if (info.isDirectory()) {
        entries.push(`D\0${relative}\n`);
        await walk(pathname, relative);
      } else if (info.isFile()) {
        const record = await readStableRaw(canonicalRoot, pathname, 'tree file');
        entries.push(`F\0${relative}\0${record.bytes}\0${record.sha256}\n`);
        files += 1;
        bytes += record.bytes;
      } else {
        throw new Error('tree contains a non-regular entry');
      }
    }
  }
  await walk(canonicalRoot, '');
  return { tree_sha256: sha256(entries.join('')), files, bytes, entries };
}

async function exactDirectoryEntries(root, expectedNames, label) {
  const entries = await readdir(root, { withFileTypes: true });
  const actualNames = entries.map((entry) => entry.name).sort();
  const expected = [...expectedNames].sort();
  if (!sameJson(actualNames, expected)) throw new Error(`${label} contains missing or unexpected entries`);
  for (const entry of entries) {
    const info = await lstat(path.join(root, entry.name));
    if (info.isSymbolicLink()) throw new Error(`${label} contains a symbolic link`);
  }
  return entries;
}

function predecessorStatusFormat(progress, status) {
  if (progress.status === 'pending') return 'pending_no_status';
  if (progress.status === 'complete' && status.attempt === undefined && status.max_attempts === undefined) {
    return 'legacy_b1_complete_reverified';
  }
  if (progress.status === 'interrupted'
    && status.page_count === undefined
    && status.runtime_fingerprint_sha256 === undefined) {
    return 'legacy_b1_interrupted';
  }
  return 'complete_identity_v1';
}

async function inspectPageTree(root, documentId, page, statePage) {
  const pageRoot = path.join(root, 'documents', documentId, 'pages', String(page).padStart(4, '0'));
  const tree = await inspectTreeStrict(pageRoot);
  const result = await readStableRaw(root, path.join(pageRoot, 'result.json'), 'OCR result JSON');
  const markdown = await readStableRaw(root, path.join(pageRoot, 'content.md'), 'OCR content Markdown');
  JSON.parse(result.raw.toString('utf8'));
  if (result.sha256 !== requireSha256(statePage.result_json_sha256, 'result JSON SHA-256')
    || markdown.sha256 !== requireSha256(statePage.content_markdown_sha256, 'content Markdown SHA-256')) {
    throw new Error('OCR page artifact hash differs from state');
  }
  requireSha256(statePage.rendered_image_sha256, 'rendered image SHA-256');
  if (statePage.status !== 'ocr_complete_pending_audit'
    || statePage.physical_pdf_page !== page
    || statePage.citation_eligible !== false) {
    throw new Error('OCR page state is not fail-closed or has the wrong physical page');
  }
  return {
    physical_pdf_page: page,
    rendered_image_sha256: statePage.rendered_image_sha256,
    result_json_sha256: result.sha256,
    content_markdown_sha256: markdown.sha256,
    page_tree_sha256: tree.tree_sha256,
    page_tree_files: tree.files,
    page_tree_bytes: tree.bytes,
    citation_allowed: false,
    tree,
  };
}

function validateBaseState(state, documentId, pageCount, label) {
  requireObject(state, label);
  if (state.schema_version !== 1 || state.document_id !== documentId || state.page_count !== pageCount) {
    throw new Error(`${label} identity is invalid`);
  }
  requireSha256(state.source_sha256, `${label} source SHA-256`);
  const completedPages = normalizedPages(state.completed_pages, pageCount, `${label} completed_pages`);
  const failedPages = requireObject(state.failed_pages, `${label} failed_pages`);
  const failedPageNumbers = normalizedPages(Object.keys(failedPages).map(Number), pageCount, `${label} failed_pages keys`);
  if (completedPages.some((page) => failedPageNumbers.includes(page))) throw new Error(`${label} page is complete and failed`);
  const pages = requireObject(state.pages, `${label} pages`);
  const pageKeys = normalizedPages(Object.keys(pages).map(Number), pageCount, `${label} pages keys`);
  if (!sameJson(pageKeys, completedPages)) throw new Error(`${label} page metadata differs from completed_pages`);
  if (state.selected_pages !== undefined) {
    const selected = normalizedPages(state.selected_pages, pageCount, `${label} selected_pages`);
    const expected = Array.from({ length: pageCount }, (_, index) => index + 1);
    if (!sameJson(selected, expected)) throw new Error(`${label} is not whole-document OCR`);
    if (state.selected_pages_complete !== (completedPages.length === pageCount && failedPageNumbers.length === 0)) {
      throw new Error(`${label} selected_pages_complete is inconsistent`);
    }
  } else if (state.selected_pages_complete !== undefined) {
    throw new Error(`${label} selected_pages_complete exists without selected_pages`);
  }
  return { completedPages, failedPages, failedPageNumbers, pages };
}

function validateProgress(progress, pageCount, label, predecessor = false) {
  requireObject(progress, label);
  if (!allowedStatuses.has(progress.status)) throw new Error(`${label} status is invalid`);
  if (progress.page_count !== pageCount) throw new Error(`${label} page_count is invalid`);
  if (!Number.isSafeInteger(progress.attempts) || progress.attempts < 0 || progress.attempts > maxDocumentAttempts) {
    throw new Error(`${label} attempts are invalid`);
  }
  if (progress.status === 'pending' && progress.attempts !== 0) throw new Error(`${label} pending status has attempts`);
  if (['running', 'retry_wait', 'complete', 'interrupted', 'quarantined'].includes(progress.status)
    && progress.attempts < 1) throw new Error(`${label} attempted status has no attempt`);
  if (progress.status === 'retry_wait' && progress.attempts >= maxDocumentAttempts) {
    throw new Error(`${label} retry_wait exhausted its attempts`);
  }
  if (predecessor && !seedablePredecessorStatuses.has(progress.status)) {
    throw new Error(`${label} is not seedable`);
  }
  return progress;
}

export async function inspectPredecessorB1(predecessorRoot) {
  const root = await requireRealDirectory(predecessorRoot, 'B1 predecessor output');
  const rootEntries = (await readdir(root, { withFileTypes: true })).map((entry) => entry.name);
  const requiredRootEntries = [
    'documents',
    'paddlex-cache',
    'status',
    'run-identity.json',
    'run-status.json',
    'run-status.json.sha256',
  ];
  const allowedRootEntries = new Set([...requiredRootEntries, 'logs']);
  if (requiredRootEntries.some((name) => !rootEntries.includes(name))
    || rootEntries.some((name) => !allowedRootEntries.has(name))) {
    throw new Error('B1 predecessor root contains missing or unexpected entries');
  }
  for (const name of rootEntries) {
    const info = await lstat(path.join(root, name));
    if (info.isSymbolicLink()) throw new Error('B1 predecessor root contains a symbolic link');
  }
  const [documentsRoot, statusRoot] = await Promise.all([
    requireRealDirectory(path.join(root, 'documents'), 'B1 documents root'),
    requireRealDirectory(path.join(root, 'status'), 'B1 status root'),
  ]);
  const [identityRecord, runStatusRecord] = await Promise.all([
    readStableJson(root, path.join(root, 'run-identity.json'), 'B1 run identity'),
    readHashBoundJson(root, path.join(root, 'run-status.json'), 'B1 run status'),
  ]);
  const identity = requireObject(identityRecord.value, 'B1 run identity');
  const runStatus = requireObject(runStatusRecord.value, 'B1 run status');
  if (identity.schema_version !== 1
    || identity.citation_allowed !== false
    || identity.whole_document_atomic !== true
    || identity.seed_lineage !== undefined
    || identity.runner_script_sha256 !== legacyB1RunnerScriptSha256) {
    throw new Error('B1 run identity is not the exact unseeded fail-closed lineage');
  }
  requireSha256(identity.manifest_sha256, 'B1 manifest SHA-256');
  requireSha256(identity.runtime_fingerprint_sha256, 'B1 runtime fingerprint SHA-256');
  requireSha256(identity.ocr_script_sha256, 'B1 OCR script SHA-256');
  if (identity.runtime_fingerprint_sha256 !== sha256(`${JSON.stringify(identity.runtime_fingerprint)}\n`)) {
    throw new Error('B1 runtime fingerprint hash mismatch');
  }
  if (runStatus.schema_version !== 1
    || runStatus.citation_allowed !== false
    || runStatus.seed_lineage !== undefined
    || runStatus.manifest_sha256 !== identity.manifest_sha256
    || runStatus.runtime_fingerprint_sha256 !== identity.runtime_fingerprint_sha256
    || !sameJson(runStatus.document_recovery, identity.document_recovery)) {
    throw new Error('B1 run status differs from its run identity');
  }
  requireObject(identity.worker_configuration, 'B1 worker configuration');
  requireObject(identity.document_recovery, 'B1 document recovery');
  const paddlexLayoutModelCache = await inspectBoundPaddlexCache(root, identity, 'B1');
  const statusDocuments = Object.entries(requireObject(runStatus.documents, 'B1 run status documents'));
  if (statusDocuments.length === 0) throw new Error('B1 run status has no documents');
  const documents = statusDocuments.map(([documentId, progress]) => {
    requireDocumentId(documentId);
    return [documentId, validateProgress(progress, requirePositiveInteger(progress.page_count, 'B1 page_count'), `B1 ${documentId}`, true)];
  });
  const counts = assertRunCounts(runStatus, documents.map(([, progress]) => progress), 'B1 run status');
  const expectedDocumentRoots = documents.filter(([, progress]) => progress.status !== 'pending').map(([id]) => id);
  const expectedStatusFiles = expectedDocumentRoots.flatMap((id) => [`${id}.json`, `${id}.json.sha256`]);
  await exactDirectoryEntries(documentsRoot, expectedDocumentRoots, 'B1 documents root');
  await exactDirectoryEntries(statusRoot, expectedStatusFiles, 'B1 status root');
  if (rootEntries.includes('logs')) {
    const logsRoot = await requireRealDirectory(path.join(root, 'logs'), 'B1 logs root');
    const logEntries = await readdir(logsRoot, { withFileTypes: true });
    for (const entry of logEntries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.log')) throw new Error('B1 logs contain an unexpected entry');
      requireDocumentId(entry.name.slice(0, -4), 'B1 log document id');
      if (!runStatus.documents[entry.name.slice(0, -4)]) throw new Error('B1 logs contain an unknown document');
    }
  }

  const stateHashRecords = [];
  const statusHashRecords = [];
  const artifactHashRecords = [];
  const publicDocuments = [];
  const aggregatePageArtifacts = [];
  let completedPages = 0;
  let latestProgressMilliseconds = runStatusRecord.metadata.mtimeMs;

  for (const [documentId, progress] of documents) {
    if (progress.status === 'pending') {
      publicDocuments.push({
        document_id: documentId,
        page_count: progress.page_count,
        predecessor_status: 'pending',
        predecessor_status_format: 'pending_no_status',
        inherited_attempts: 0,
        completed_pages: [],
        failed_pages: [],
        predecessor_document_tree: null,
        predecessor_pages_tree: null,
        predecessor_state_sha256: null,
        predecessor_configuration_sha256: sha256(canonicalJson(identity.worker_configuration)),
        predecessor_status_sha256: null,
        predecessor_status_sidecar_sha256: null,
        inherited_page_artifacts: [],
        inherited_page_artifacts_sha256: sha256(canonicalJson([])),
      });
      continue;
    }
    const documentRoot = await requireRealDirectory(path.join(documentsRoot, documentId), 'B1 document root');
    await exactDirectoryEntries(documentRoot, ['pages', 'state.json'], 'B1 document root');
    const pagesRoot = await requireRealDirectory(path.join(documentRoot, 'pages'), 'B1 pages root');
    const [stateRecord, statusRecord] = await Promise.all([
      readStableJson(root, path.join(documentRoot, 'state.json'), 'B1 state'),
      readHashBoundJson(root, path.join(statusRoot, `${documentId}.json`), 'B1 document status'),
    ]);
    latestProgressMilliseconds = Math.max(latestProgressMilliseconds, stateRecord.metadata.mtimeMs, statusRecord.metadata.mtimeMs);
    const state = stateRecord.value;
    const stateSummary = validateBaseState(state, documentId, progress.page_count, 'B1 state');
    if (stateSummary.failedPageNumbers.length !== 0) throw new Error('B1 predecessor contains failed pages');
    const physicalPages = (await readdir(pagesRoot, { withFileTypes: true })).map((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^\d{4}$/u.test(entry.name)) {
        throw new Error('B1 pages root contains an unexpected entry');
      }
      return Number(entry.name);
    }).sort((left, right) => left - right);
    if (!sameJson(physicalPages, stateSummary.completedPages)) throw new Error('B1 physical pages differ from state');
    const status = requireObject(statusRecord.value, 'B1 document status');
    if (status.schema_version !== 1
      || status.document_id !== documentId
      || status.status !== progress.status
      || status.citation_allowed !== false
      || progress.status_json_sha256 !== statusRecord.sha256) {
      throw new Error('B1 document status differs from run status');
    }
    if (status.attempt !== undefined && status.attempt !== progress.attempts) throw new Error('B1 status attempt mismatch');
    if (status.page_count !== undefined && status.page_count !== progress.page_count) throw new Error('B1 status page_count mismatch');
    if (status.runtime_fingerprint_sha256 !== undefined
      && status.runtime_fingerprint_sha256 !== identity.runtime_fingerprint_sha256) {
      throw new Error('B1 status runtime fingerprint mismatch');
    }
    const pageArtifacts = [];
    for (const page of stateSummary.completedPages) {
      const artifact = await inspectPageTree(root, documentId, page, stateSummary.pages[String(page)]);
      const { tree, ...publicArtifact } = artifact;
      pageArtifacts.push(publicArtifact);
      aggregatePageArtifacts.push({ document_id: documentId, ...publicArtifact });
      for (const entry of tree.entries.filter((value) => value.startsWith('F\0'))) {
        const [, relative, bytes, digest] = entry.trimEnd().split('\0');
        artifactHashRecords.push({
          path: `documents/${documentId}/pages/${String(page).padStart(4, '0')}/${relative}`,
          bytes: Number(bytes),
          sha256: digest,
        });
      }
    }
    const [documentTree, pagesTree] = await Promise.all([
      inspectTreeStrict(documentRoot),
      inspectTreeStrict(pagesRoot),
    ]);
    stateHashRecords.push({ document_id: documentId, bytes: stateRecord.bytes, sha256: stateRecord.sha256 });
    statusHashRecords.push({
      document_id: documentId,
      body_sha256: statusRecord.sha256,
      sidecar_sha256: statusRecord.sidecar_sha256,
    });
    completedPages += stateSummary.completedPages.length;
    publicDocuments.push({
      document_id: documentId,
      page_count: progress.page_count,
      predecessor_status: progress.status,
      predecessor_status_format: predecessorStatusFormat(progress, status),
      inherited_attempts: progress.attempts,
      completed_pages: stateSummary.completedPages,
      failed_pages: [],
      predecessor_document_tree: {
        tree_sha256: documentTree.tree_sha256,
        files: documentTree.files,
        bytes: documentTree.bytes,
      },
      predecessor_pages_tree: {
        tree_sha256: pagesTree.tree_sha256,
        files: pagesTree.files,
        bytes: pagesTree.bytes,
      },
      predecessor_state_sha256: stateRecord.sha256,
      predecessor_configuration_sha256: sha256(canonicalJson(state.configuration)),
      predecessor_status_sha256: statusRecord.sha256,
      predecessor_status_sidecar_sha256: statusRecord.sidecar_sha256,
      inherited_page_artifacts: pageArtifacts,
      inherited_page_artifacts_sha256: sha256(canonicalJson(pageArtifacts)),
    });
  }

  const anchors = {
    identity_sha256: identityRecord.sha256,
    run_status_sha256: runStatusRecord.sha256,
    state_hashset_sha256: fingerprintRecords(stateHashRecords.sort((left, right) => compareText(left.document_id, right.document_id))),
    status_hashset_sha256: fingerprintRecords(statusHashRecords.sort((left, right) => compareText(left.document_id, right.document_id))),
    artifact_hashset_sha256: fingerprintRecords(artifactHashRecords.sort((left, right) => compareText(left.path, right.path))),
  };
  const pageArtifactsSha256 = sha256(canonicalJson(aggregatePageArtifacts));
  const snapshotBasis = {
    manifest_sha256: identity.manifest_sha256,
    run_identity_sha256: identityRecord.sha256,
    run_status_sha256: runStatusRecord.sha256,
    run_status_sidecar_sha256: runStatusRecord.sidecar_sha256,
    runtime_fingerprint_sha256: identity.runtime_fingerprint_sha256,
    worker_configuration_sha256: sha256(canonicalJson(identity.worker_configuration)),
    document_recovery_sha256: sha256(canonicalJson(identity.document_recovery)),
    completed_pages: completedPages,
    failed_pages: 0,
    quarantined_documents: 0,
    page_artifacts_sha256: pageArtifactsSha256,
    documents: publicDocuments,
  };
  return {
    root,
    identity,
    identity_record: identityRecord,
    run_status: runStatus,
    run_status_record: runStatusRecord,
    counts,
    documents: publicDocuments,
    completed_pages: completedPages,
    failed_pages: 0,
    quarantined_documents: 0,
    page_artifacts_sha256: pageArtifactsSha256,
    snapshot_sha256: sha256(canonicalJson(snapshotBasis)),
    anchors,
    paddlex_layout_model_cache: paddlexLayoutModelCache,
    latest_progress_at: iso(latestProgressMilliseconds),
    _snapshot_basis: snapshotBasis,
  };
}

function compareReceiptDocument(receiptDocument, predecessorDocument) {
  const predecessorKeys = Object.keys(predecessorDocument).sort();
  const stripped = Object.fromEntries(
    Object.entries(receiptDocument).filter(([key]) => !['successor_document_tree', 'successor_state_sha256', 'successor_status_sha256'].includes(key)),
  );
  if (!sameJson(Object.keys(stripped).sort(), predecessorKeys) || !sameJson(stripped, predecessorDocument)) {
    throw new Error('seed receipt document differs from the exact B1 snapshot');
  }
}

async function validatePredecessorEvidence(successorRoot, receipt, predecessor) {
  const evidenceRoot = await requireRealDirectory(
    path.join(successorRoot, 'seed-predecessor-evidence'),
    'seed predecessor evidence root',
  );
  const tree = await inspectTreeStrict(evidenceRoot);
  const contract = requireObject(receipt.predecessor.control_evidence, 'seed predecessor evidence contract');
  if (contract.directory !== 'seed-predecessor-evidence'
    || contract.tree_sha256 !== tree.tree_sha256
    || contract.files !== tree.files
    || contract.bytes !== tree.bytes) {
    throw new Error('seed predecessor evidence tree differs from receipt');
  }
  const inventoryRecord = await readStableJson(evidenceRoot, path.join(evidenceRoot, 'inventory.json'), 'seed predecessor inventory');
  if (inventoryRecord.sha256 !== contract.inventory_sha256) throw new Error('seed predecessor inventory differs from receipt');
  const inventory = requireObject(inventoryRecord.value, 'seed predecessor inventory');
  if (inventory.schema_version !== 1
    || inventory.evidence_type !== 'curriculum_remote_ocr_seed_predecessor_controls'
    || inventory.manifest_sha256 !== predecessor.identity.manifest_sha256
    || inventory.runner_script_sha256 !== legacyB1RunnerScriptSha256
    || inventory.citation_allowed !== false) {
    throw new Error('seed predecessor inventory identity is invalid');
  }
  const expectedFiles = [
    ['run-identity.json', predecessor.identity_record],
    ['run-status.json', predecessor.run_status_record],
    ['run-status.json.sha256', {
      raw: predecessor.run_status_record.sidecar_raw,
      sha256: predecessor.run_status_record.sidecar_sha256,
      bytes: predecessor.run_status_record.sidecar_raw.byteLength,
    }],
  ];
  const expectedInventoryDocuments = [];
  for (const document of predecessor.documents) {
    const statePath = `documents/${document.document_id}/state.json`;
    const statusPath = `status/${document.document_id}.json`;
    if (document.predecessor_status === 'pending') {
      expectedInventoryDocuments.push({
        document_id: document.document_id,
        predecessor_status: 'pending',
        state: { present: false, path: statePath },
        status: { present: false, path: statusPath, sidecar_path: `${statusPath}.sha256` },
      });
      continue;
    }
    const stateRecord = await readStableRaw(predecessor.root, path.join(predecessor.root, statePath), 'B1 evidence state');
    const statusRecord = await readStableRaw(predecessor.root, path.join(predecessor.root, statusPath), 'B1 evidence status');
    const sidecarRecord = await readStableRaw(predecessor.root, path.join(predecessor.root, `${statusPath}.sha256`), 'B1 evidence status sidecar');
    expectedFiles.push([statePath, stateRecord], [statusPath, statusRecord], [`${statusPath}.sha256`, sidecarRecord]);
    expectedInventoryDocuments.push({
      document_id: document.document_id,
      predecessor_status: document.predecessor_status,
      state: { present: true, path: statePath, bytes: stateRecord.bytes, sha256: stateRecord.sha256 },
      status: {
        present: true,
        path: statusPath,
        bytes: statusRecord.bytes,
        sha256: statusRecord.sha256,
        sidecar: {
          path: `${statusPath}.sha256`,
          bytes: sidecarRecord.bytes,
          sha256: sidecarRecord.sha256,
        },
      },
    });
  }
  expectedFiles.sort(([left], [right]) => compareText(left, right));
  const expectedFileRecords = expectedFiles.map(([relativePath, record]) => ({
    path: relativePath,
    bytes: record.bytes,
    sha256: record.sha256,
  }));
  if (!sameJson(inventory.files, expectedFileRecords) || !sameJson(inventory.documents, expectedInventoryDocuments)) {
    throw new Error('seed predecessor inventory differs from B1 controls');
  }
  const expectedTreePaths = new Set(['inventory.json', ...expectedFiles.map(([relativePath]) => relativePath)]);
  const actualFilePaths = tree.entries.filter((entry) => entry.startsWith('F\0')).map((entry) => entry.split('\0')[1]);
  if (actualFilePaths.some((relativePath) => !expectedTreePaths.has(relativePath))
    || expectedTreePaths.size !== actualFilePaths.length) {
    throw new Error('seed predecessor evidence contains missing or unexpected files');
  }
  for (const [relativePath, sourceRecord] of expectedFiles) {
    const copied = await readStableRaw(evidenceRoot, path.join(evidenceRoot, relativePath), 'seed predecessor evidence file');
    if (copied.sha256 !== sourceRecord.sha256 || copied.bytes !== sourceRecord.bytes) {
      throw new Error('seed predecessor evidence bytes differ from B1');
    }
  }
  return { tree, inventory_sha256: inventoryRecord.sha256 };
}

function validateReceiptPredecessor(receipt, predecessor) {
  const contract = requireObject(receipt.predecessor, 'seed receipt predecessor');
  const expected = predecessor._snapshot_basis;
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'documents') continue;
    if (!sameJson(contract[key], value)) throw new Error(`seed receipt predecessor ${key} differs from B1`);
  }
  if (contract.runner_script_sha256 !== predecessor.identity.runner_script_sha256
    || contract.ocr_script_sha256 !== predecessor.identity.ocr_script_sha256
    || !sameJson(contract.runtime, predecessor.identity.runtime)
    || !sameJson(contract.runtime_fingerprint, predecessor.identity.runtime_fingerprint)
    || !sameJson(contract.worker_configuration, predecessor.identity.worker_configuration)
    || !sameJson(contract.document_recovery, predecessor.identity.document_recovery)) {
    throw new Error('seed receipt predecessor runtime controls differ from B1');
  }
  if (receipt.documents.length !== predecessor.documents.length) throw new Error('seed receipt document count differs from B1');
  for (let index = 0; index < predecessor.documents.length; index += 1) {
    compareReceiptDocument(receipt.documents[index], predecessor.documents[index]);
  }
}

function expectedStateConfiguration(identity) {
  const runtime = requireObject(identity.runtime, 'B2 runtime');
  const worker = requireObject(identity.worker_configuration, 'B2 worker configuration');
  const python = requireObject(worker.python_runtime, 'B2 Python runtime');
  const packages = requireObject(python.packages, 'B2 Python packages');
  return {
    pipeline: runtime.pipeline,
    pipeline_version: runtime.pipeline_version,
    layout_model: 'PP-DocLayoutV3',
    recognizer: 'PaddleOCR-VL-1.6-0.9B official GGUF',
    recognizer_backend: 'llama-cpp-server',
    recognizer_server_url: worker.llama_url,
    dpi: runtime.render_dpi,
    device: worker.runtime_device,
    python: python.python_version,
    paddlepaddle: packages.paddlepaddle,
    paddleocr: packages.paddleocr,
    paddlex: packages.paddlex,
    vl_rec_max_concurrency: worker.vl_rec_max_concurrency,
    server_parallel: worker.server_parallel,
    micro_batch: worker.micro_batch,
    use_queues: worker.use_queues,
  };
}

function validateNormalizedRecoveryStatus(receiptDocument, progress, status, statusSha256, identity) {
  if (progress.status !== 'retry_wait' || !['running', 'failed', 'interrupted'].includes(status.status)) {
    return false;
  }
  if (!Number.isSafeInteger(progress.attempts)
    || progress.attempts < 1
    || progress.attempts >= maxDocumentAttempts
    || status.attempt !== progress.attempts
    || status.max_attempts !== maxDocumentAttempts
    || progress.status_json_sha256 !== statusSha256) {
    throw new Error('B2 normalized recovery attempt or status hash is invalid');
  }
  const timestampField = {
    running: 'started_at',
    failed: 'failed_at',
    interrupted: 'interrupted_at',
  }[status.status];
  const rawStatusRecordedAt = status[timestampField];
  if (typeof rawStatusRecordedAt !== 'string'
    || !Number.isFinite(Date.parse(rawStatusRecordedAt))
    || new Date(Date.parse(rawStatusRecordedAt)).toISOString() !== rawStatusRecordedAt
    || progress[timestampField] !== rawStatusRecordedAt) {
    throw new Error('B2 normalized recovery timestamp is invalid');
  }
  const recoveryRecordedAt = progress.interrupted_at || progress.failed_at || progress.started_at;
  if (typeof recoveryRecordedAt !== 'string'
    || !Number.isFinite(Date.parse(recoveryRecordedAt))
    || new Date(Date.parse(recoveryRecordedAt)).toISOString() !== recoveryRecordedAt) {
    throw new Error('B2 normalized recovery source timestamp is invalid');
  }
  const expectedNextRetry = new Date(
    Date.parse(recoveryRecordedAt) + documentRetryBackoffMilliseconds[progress.attempts - 1],
  ).toISOString();
  if (progress.next_retry_at !== expectedNextRetry) {
    throw new Error('B2 normalized recovery backoff is invalid');
  }

  const keys = Object.keys(status).sort();
  const legacyInterruptedKeys = [
    'attempt',
    'citation_allowed',
    'document_id',
    'interrupted_at',
    'max_attempts',
    'runtime_fingerprint_sha256',
    'schema_version',
    'seed_lineage',
    'status',
  ].sort();
  const legacyInterrupted = status.status === 'interrupted'
    && receiptDocument.predecessor_status_format === 'legacy_b1_interrupted'
    && progress.attempts === receiptDocument.inherited_attempts
    && statusSha256 === receiptDocument.successor_status_sha256
    && status.page_count === undefined
    && sameJson(keys, legacyInterruptedKeys);
  if (legacyInterrupted) {
    const lineage = requireObject(status.seed_lineage, 'B2 normalized legacy status seed lineage');
    if (!sameJson(Object.keys(lineage).sort(), [
      'citation_allowed',
      'inherited_attempts',
      'predecessor_status_sha256',
      'schema_version',
      'seed_id',
    ].sort()) || lineage.schema_version !== 1) {
      throw new Error('B2 normalized legacy status seed lineage shape is invalid');
    }
  }
  if (!legacyInterrupted) {
    const statusSpecificKeys = {
      running: ['started_at'],
      failed: ['error', 'failed_at'],
      interrupted: ['interrupted_at'],
    }[status.status];
    const fullKeys = [
      'attempt',
      'citation_allowed',
      'document_id',
      'max_attempts',
      'page_count',
      'runtime_fingerprint_sha256',
      'schema_version',
      'status',
      ...statusSpecificKeys,
    ].sort();
    if (!sameJson(keys, fullKeys) || status.page_count !== receiptDocument.page_count) {
      throw new Error('B2 normalized recovery raw status shape is invalid');
    }
  }
  if (status.runtime_fingerprint_sha256 !== identity.runtime_fingerprint_sha256
    || status.citation_allowed !== false
    || (status.status === 'failed'
      && (typeof status.error !== 'string' || !status.error || status.error !== progress.error))) {
    throw new Error('B2 normalized recovery raw status identity is invalid');
  }
  return true;
}

function validateAllowedSeedDelta(receipt, predecessor, identity) {
  if (!sameJson(predecessor.identity.runtime, identity.runtime)
    || !sameJson(predecessor.identity.runtime_fingerprint, identity.runtime_fingerprint)
    || predecessor.identity.runtime_fingerprint_sha256 !== identity.runtime_fingerprint_sha256
    || !sameJson(predecessor.identity.llama_server_attestation, identity.llama_server_attestation)
    || predecessor.identity.input_root !== identity.input_root
    || predecessor.identity.python_invocation_path !== identity.python_invocation_path
    || predecessor.identity.python_resolved_target !== identity.python_resolved_target) {
    throw new Error('B2 changes a forbidden B1 runtime, input, Python, or llama identity');
  }
  const predecessorWorker = requireObject(predecessor.identity.worker_configuration, 'B1 worker configuration');
  const successorWorker = requireObject(identity.worker_configuration, 'B2 worker configuration');
  const workerKeys = [
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
  if (!sameJson(Object.keys(predecessorWorker).sort(), workerKeys)
    || !sameJson(Object.keys(successorWorker).sort(), workerKeys)
    || predecessorWorker.vl_rec_max_concurrency !== 4
    || successorWorker.vl_rec_max_concurrency !== 1
    || predecessorWorker.server_parallel !== 4
    || successorWorker.server_parallel !== 4
    || predecessorWorker.micro_batch !== 16
    || successorWorker.micro_batch !== 16
    || predecessorWorker.use_queues !== true
    || successorWorker.use_queues !== true) {
    throw new Error('B2 worker configuration is outside the audited concurrency delta');
  }
  for (const key of workerKeys.filter((value) => !['vl_rec_max_concurrency', 'paddlex_cache_home'].includes(value))) {
    if (!sameJson(predecessorWorker[key], successorWorker[key])) throw new Error(`B2 changes forbidden worker field ${key}`);
  }
  if (predecessorWorker.paddlex_cache_home !== successorWorker.paddlex_cache_home
    && predecessorWorker.paddlex_layout_model_cache_sha256 !== successorWorker.paddlex_layout_model_cache_sha256) {
    throw new Error('B2 cache path changed without an identical cache tree hash');
  }
  const predecessorRecovery = structuredClone(predecessor.identity.document_recovery);
  const successorRecovery = structuredClone(identity.document_recovery);
  const predecessorIdle = predecessorRecovery.child_monitoring?.idle_timeout_seconds;
  const successorIdle = successorRecovery.child_monitoring?.idle_timeout_seconds;
  if (predecessorIdle !== 300 || successorIdle !== 1200) {
    throw new Error('B2 child idle timeout is outside the audited 300 to 1200 second delta');
  }
  delete predecessorRecovery.child_monitoring.idle_timeout_seconds;
  delete successorRecovery.child_monitoring.idle_timeout_seconds;
  if (!sameJson(predecessorRecovery, successorRecovery)) throw new Error('B2 changes a forbidden recovery field');
  const expectedDelta = {
    schema_version: 1,
    vl_rec_max_concurrency: { predecessor: 4, successor: 1 },
    paddlex_cache_home: {
      predecessor: predecessorWorker.paddlex_cache_home,
      successor: successorWorker.paddlex_cache_home,
      tree_sha256: successorWorker.paddlex_layout_model_cache_sha256,
    },
    child_idle_timeout_seconds: { predecessor: 300, successor: 1200 },
  };
  if (!sameJson(receipt.allowed_configuration_delta, expectedDelta)) {
    throw new Error('B2 receipt allowed configuration delta is invalid');
  }
}

function markerItemsByName(marker) {
  const items = marker.installed_items;
  if (!Array.isArray(items) || items.length !== installedItemSpecifications.length) {
    throw new Error('seed marker installed item inventory is invalid');
  }
  if (!sameJson(items.map(({ name, type }) => ({ name, type })), installedItemSpecifications)) {
    throw new Error('seed marker installed item names or types differ from the contract');
  }
  if (marker.installed_items_sha256 !== sha256(canonicalJson(items))) {
    throw new Error('seed marker installed item inventory hash mismatch');
  }
  return new Map(items.map((item) => [item.name, item]));
}

async function inspectInstalledItem(successorRoot, specification) {
  const pathname = path.join(successorRoot, specification.name);
  if (specification.type === 'directory') {
    const { entries: _entries, ...fingerprint } = await inspectTreeStrict(pathname);
    return fingerprint;
  }
  const record = await readStableRaw(successorRoot, pathname, `seed item ${specification.name}`);
  return { sha256: record.sha256, bytes: record.bytes };
}

export async function inspectSuccessorB2(successorRoot, predecessor, nowMilliseconds = Date.now()) {
  const root = await requireRealDirectory(successorRoot, 'B2 successor output');
  const requiredRootEntries = [
    '.seed-journal.json',
    '.seed-journal.json.sha256',
    'documents',
    'logs',
    'paddlex-cache',
    'run-identity.json',
    'run-status.json',
    'run-status.json.sha256',
    'seed-commit.json',
    'seed-commit.json.sha256',
    'seed-predecessor-evidence',
    'seed-receipt.json',
    'seed-receipt.json.sha256',
    'status',
  ];
  const allowedRootEntries = new Set([...requiredRootEntries, '.remote-ocr-orchestrator.lock']);
  const rootEntries = await readdir(root, { withFileTypes: true });
  const names = rootEntries.map((entry) => entry.name);
  if (requiredRootEntries.some((name) => !names.includes(name)) || names.some((name) => !allowedRootEntries.has(name))) {
    throw new Error('B2 successor root contains missing or unexpected entries');
  }
  for (const entry of rootEntries) {
    const info = await lstat(path.join(root, entry.name));
    if (info.isSymbolicLink()) throw new Error('B2 successor root contains a symbolic link');
    if (entry.name === '.remote-ocr-orchestrator.lock' && !info.isFile()) throw new Error('B2 orchestrator lock is not regular');
  }
  const [documentsRoot, statusRoot, logsRoot] = await Promise.all([
    requireRealDirectory(path.join(root, 'documents'), 'B2 documents root'),
    requireRealDirectory(path.join(root, 'status'), 'B2 status root'),
    requireRealDirectory(path.join(root, 'logs'), 'B2 logs root'),
  ]);
  const [identityRecord, runStatusRecord, receiptRecord, markerRecord, journalRecord] = await Promise.all([
    readStableJson(root, path.join(root, 'run-identity.json'), 'B2 run identity'),
    readHashBoundJson(root, path.join(root, 'run-status.json'), 'B2 run status'),
    readHashBoundJson(root, path.join(root, 'seed-receipt.json'), 'B2 seed receipt'),
    readHashBoundJson(root, path.join(root, 'seed-commit.json'), 'B2 seed commit marker'),
    readHashBoundJson(root, path.join(root, '.seed-journal.json'), 'B2 seed journal'),
  ]);
  const identity = requireObject(identityRecord.value, 'B2 run identity');
  const runStatus = requireObject(runStatusRecord.value, 'B2 run status');
  const receipt = requireObject(receiptRecord.value, 'B2 seed receipt');
  const marker = requireObject(markerRecord.value, 'B2 seed marker');
  const journal = requireObject(journalRecord.value, 'B2 seed journal');
  for (const [label, value] of [['identity', identity], ['run status', runStatus], ['receipt', receipt], ['marker', marker], ['journal', journal]]) {
    if (value.schema_version !== 1 || value.citation_allowed !== false) throw new Error(`B2 ${label} is not fail-closed`);
  }
  if (receipt.receipt_type !== seedReceiptType || receipt.status !== 'prepared_commit_marker_required') {
    throw new Error('B2 seed receipt type or status is invalid');
  }
  if (marker.marker_type !== 'curriculum_remote_ocr_hash_bound_seed_commit'
    || journal.journal_type !== 'curriculum_remote_ocr_hash_bound_seed_install') {
    throw new Error('B2 seed transaction control type is invalid');
  }
  const seedId = requireSha256(receipt.seed_id, 'B2 seed id');
  const receiptDocuments = Array.isArray(receipt.documents) ? receipt.documents : null;
  if (!receiptDocuments || receiptDocuments.length === 0) throw new Error('B2 seed receipt has no documents');
  const successorContract = requireObject(receipt.successor, 'B2 seed successor contract');
  const successorContractWithoutInitial = structuredClone(successorContract);
  delete successorContractWithoutInitial.initial_run_status_sha256;
  const seedBasis = {
    schema_version: 1,
    mode: seedMode,
    manifest_sha256: receipt.manifest_sha256,
    predecessor: receipt.predecessor,
    successor_contract: successorContractWithoutInitial,
    allowed_configuration_delta: receipt.allowed_configuration_delta,
    documents: receiptDocuments.map((document) => {
      const value = structuredClone(document);
      delete value.successor_document_tree;
      delete value.successor_state_sha256;
      delete value.successor_status_sha256;
      return value;
    }),
    citation_allowed: false,
  };
  if (receipt.seed_basis_sha256 !== sha256(canonicalJson(seedBasis))
    || seedId !== receipt.seed_basis_sha256) {
    throw new Error('B2 seed id or seed basis hash is invalid');
  }
  validateReceiptPredecessor(receipt, predecessor);
  if (identity.schema_version !== 1
    || identity.whole_document_atomic !== true
    || identity.manifest_sha256 !== receipt.manifest_sha256
    || identity.runtime_fingerprint_sha256 !== sha256(`${JSON.stringify(identity.runtime_fingerprint)}\n`)) {
    throw new Error('B2 run identity contract is invalid');
  }
  const lineage = requireObject(identity.seed_lineage, 'B2 run identity seed lineage');
  if (lineage.schema_version !== 1
    || lineage.mode !== seedMode
    || lineage.seed_id !== seedId
    || lineage.seed_receipt_sha256 !== receiptRecord.sha256
    || lineage.predecessor_run_identity_sha256 !== predecessor.anchors.identity_sha256
    || lineage.predecessor_run_status_sha256 !== predecessor.anchors.run_status_sha256
    || lineage.predecessor_snapshot_sha256 !== predecessor.snapshot_sha256
    || lineage.inherited_pages !== receipt.counts?.inherited_pages
    || lineage.citation_allowed !== false) {
    throw new Error('B2 run identity is not bound to the exact seed receipt and B1');
  }
  if (!sameJson(successorContract.runtime, identity.runtime)
    || !sameJson(successorContract.runtime_fingerprint, identity.runtime_fingerprint)
    || successorContract.runtime_fingerprint_sha256 !== identity.runtime_fingerprint_sha256
    || !sameJson(successorContract.worker_configuration, identity.worker_configuration)
    || successorContract.worker_configuration_sha256 !== sha256(canonicalJson(identity.worker_configuration))
    || !sameJson(successorContract.document_recovery, identity.document_recovery)
    || successorContract.document_recovery_sha256 !== sha256(canonicalJson(identity.document_recovery))
    || successorContract.runner_script_sha256 !== identity.runner_script_sha256
    || successorContract.ocr_script_sha256 !== identity.ocr_script_sha256
    || successorContract.citation_allowed !== false) {
    throw new Error('B2 run identity differs from the receipt successor contract');
  }
  const paddlexLayoutModelCache = await inspectBoundPaddlexCache(root, identity, 'B2');
  if (!sameJson(paddlexLayoutModelCache, predecessor.paddlex_layout_model_cache)) {
    throw new Error('B2 PaddleX cache fingerprint differs from B1');
  }
  validateAllowedSeedDelta(receipt, predecessor, identity);
  const markerItems = markerItemsByName(marker);
  if (marker.seed_id !== seedId
    || marker.seed_receipt_sha256 !== receiptRecord.sha256
    || marker.run_identity_sha256 !== identityRecord.sha256
    || marker.initial_run_status_sha256 !== successorContract.initial_run_status_sha256) {
    throw new Error('B2 seed marker is not bound to receipt, identity, and initial run status');
  }
  if (journal.seed_id !== seedId
    || journal.seed_receipt_sha256 !== receiptRecord.sha256
    || journal.run_identity_sha256 !== identityRecord.sha256
    || journal.initial_run_status_sha256 !== successorContract.initial_run_status_sha256
    || !sameJson(journal.items, marker.installed_items)) {
    throw new Error('B2 seed journal differs from the commit marker');
  }
  const initialRunStatusItem = markerItems.get('run-status.json');
  const expectedInitialSidecar = Buffer.from(`${successorContract.initial_run_status_sha256}  run-status.json\n`);
  if (initialRunStatusItem?.fingerprint?.sha256 !== successorContract.initial_run_status_sha256
    || !sameJson(markerItems.get('run-status.json.sha256')?.fingerprint, {
      sha256: sha256(expectedInitialSidecar),
      bytes: expectedInitialSidecar.byteLength,
    })) {
    throw new Error('B2 marker does not bind the initial run status');
  }
  for (const specification of installedItemSpecifications.filter(({ name }) => immutableInstalledItems.has(name))) {
    const actual = await inspectInstalledItem(root, specification);
    if (!sameJson(actual, markerItems.get(specification.name)?.fingerprint)) {
      throw new Error(`B2 immutable seed item ${specification.name} drifted`);
    }
  }
  await validatePredecessorEvidence(root, receipt, predecessor);

  if (runStatus.schema_version !== 1
    || runStatus.manifest_sha256 !== identity.manifest_sha256
    || runStatus.runtime_fingerprint_sha256 !== identity.runtime_fingerprint_sha256
    || !sameJson(runStatus.document_recovery, identity.document_recovery)) {
    throw new Error('B2 run status differs from its run identity');
  }
  const runLineage = requireObject(runStatus.seed_lineage, 'B2 run status seed lineage');
  if (runLineage.schema_version !== 1
    || runLineage.mode !== seedMode
    || runLineage.seed_id !== seedId
    || runLineage.predecessor_run_identity_sha256 !== predecessor.anchors.identity_sha256
    || runLineage.predecessor_run_status_sha256 !== predecessor.anchors.run_status_sha256
    || runLineage.citation_allowed !== false) {
    throw new Error('B2 run status seed lineage differs from identity');
  }
  const runDocumentsObject = requireObject(runStatus.documents, 'B2 run status documents');
  const receiptIds = receiptDocuments.map((document) => requireDocumentId(document.document_id, 'B2 receipt document id'));
  if (new Set(receiptIds).size !== receiptIds.length
    || !sameJson(Object.keys(runDocumentsObject).sort(), [...receiptIds].sort())) {
    throw new Error('B2 document set differs from the receipt');
  }
  const currentDocuments = receiptDocuments.map((document) => {
    const progress = validateProgress(
      runDocumentsObject[document.document_id],
      document.page_count,
      `B2 ${document.document_id}`,
    );
    if (progress.seed_id !== seedId
      || progress.predecessor_status !== document.predecessor_status
      || progress.inherited_attempts !== document.inherited_attempts
      || progress.attempts < document.inherited_attempts) {
      throw new Error('B2 progress violates its inherited attempt floor or predecessor status');
    }
    return [document, progress];
  });
  const { counts, declaredCountsMatch } = deriveRunCounts(
    runStatus,
    currentDocuments.map(([, progress]) => progress),
    'B2 run status',
  );
  const expectedDocumentRoots = currentDocuments.filter(([, progress]) => progress.status !== 'pending').map(([document]) => document.document_id);
  const expectedStatusFiles = expectedDocumentRoots.flatMap((id) => [`${id}.json`, `${id}.json.sha256`]);
  await exactDirectoryEntries(documentsRoot, expectedDocumentRoots, 'B2 documents root');
  await exactDirectoryEntries(statusRoot, expectedStatusFiles, 'B2 status root');
  const logEntries = await readdir(logsRoot, { withFileTypes: true });
  for (const entry of logEntries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.log')) throw new Error('B2 logs contain an unexpected entry');
    const documentId = requireDocumentId(entry.name.slice(0, -4), 'B2 log document id');
    if (!runDocumentsObject[documentId]) throw new Error('B2 logs contain an unknown document');
  }

  let expectedPages = 0;
  let completedPages = 0;
  let failedPages = 0;
  let latestProgressMilliseconds = runStatusRecord.metadata.mtimeMs;
  const expectedConfiguration = expectedStateConfiguration(identity);
  for (const [receiptDocument, progress] of currentDocuments) {
    expectedPages += receiptDocument.page_count;
    if (progress.status === 'pending') continue;
    const documentId = receiptDocument.document_id;
    const documentRoot = await requireRealDirectory(path.join(documentsRoot, documentId), 'B2 document root');
    await exactDirectoryEntries(documentRoot, ['pages', 'state.json'], 'B2 document root');
    const pagesRoot = await requireRealDirectory(path.join(documentRoot, 'pages'), 'B2 pages root');
    const [stateRecord, statusRecord] = await Promise.all([
      readStableJson(root, path.join(documentRoot, 'state.json'), 'B2 state'),
      readHashBoundJson(root, path.join(statusRoot, `${documentId}.json`), 'B2 document status'),
    ]);
    latestProgressMilliseconds = Math.max(latestProgressMilliseconds, stateRecord.metadata.mtimeMs, statusRecord.metadata.mtimeMs);
    const state = stateRecord.value;
    const stateSummary = validateBaseState(state, documentId, receiptDocument.page_count, 'B2 state');
    if (!sameJson(state.configuration, expectedConfiguration)
      || state.configuration_scope !== 'active_writer_with_hash_bound_seed_exceptions') {
      throw new Error('B2 state configuration differs from the successor identity');
    }
    const stateLineage = requireObject(state.seed_lineage, 'B2 state seed lineage');
    if (stateLineage.schema_version !== 1
      || stateLineage.mode !== seedMode
      || stateLineage.seed_id !== seedId
      || stateLineage.predecessor_run_identity_sha256 !== predecessor.anchors.identity_sha256
      || stateLineage.predecessor_configuration_sha256 !== receiptDocument.predecessor_configuration_sha256
      || !sameJson(stateLineage.inherited_completed_pages, receiptDocument.completed_pages)
      || stateLineage.citation_allowed !== false) {
      throw new Error('B2 state seed lineage differs from the receipt');
    }
    const inherited = new Set(receiptDocument.completed_pages);
    const physicalPages = (await readdir(pagesRoot, { withFileTypes: true })).map((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^\d{4}$/u.test(entry.name)) {
        throw new Error('B2 pages root contains an unexpected entry');
      }
      return Number(entry.name);
    }).sort((left, right) => left - right);
    if (!sameJson(physicalPages, stateSummary.completedPages)) throw new Error('B2 physical pages differ from state');
    for (const page of stateSummary.completedPages) {
      const statePage = stateSummary.pages[String(page)];
      const provenance = statePage.seed_provenance;
      if (inherited.has(page)) {
        if (!provenance
          || provenance.seed_id !== seedId
          || provenance.predecessor_run_identity_sha256 !== predecessor.anchors.identity_sha256
          || provenance.predecessor_configuration_sha256 !== receiptDocument.predecessor_configuration_sha256) {
          throw new Error('B2 inherited page seed provenance mismatch');
        }
      } else if (provenance !== undefined) {
        throw new Error('B2 newly written page incorrectly carries seed provenance');
      }
      const artifact = await inspectPageTree(root, documentId, page, statePage);
      if (inherited.has(page)) {
        const expectedArtifact = receiptDocument.inherited_page_artifacts.find(
          (value) => value.physical_pdf_page === page,
        );
        const { tree: _tree, ...publicArtifact } = artifact;
        if (!sameJson(publicArtifact, expectedArtifact)) throw new Error('B2 inherited page artifact identity drifted');
      }
    }
    const status = requireObject(statusRecord.value, 'B2 document status');
    const legacyCompleteInitial = receiptDocument.predecessor_status_format === 'legacy_b1_complete_reverified'
      && progress.status === 'complete'
      && progress.attempts === receiptDocument.inherited_attempts
      && status.attempt === undefined
      && status.max_attempts === undefined
      && status.page_count === receiptDocument.page_count;
    const legacyInterruptedInitial = receiptDocument.predecessor_status_format === 'legacy_b1_interrupted'
      && progress.status === 'interrupted'
      && progress.attempts === receiptDocument.inherited_attempts
      && status.attempt === progress.attempts
      && status.max_attempts === maxDocumentAttempts
      && status.page_count === undefined;
    const fullSuccessorStatus = status.attempt === progress.attempts
      && status.max_attempts === maxDocumentAttempts
      && status.page_count === receiptDocument.page_count;
    const normalizedRecoveryStatus = validateNormalizedRecoveryStatus(
      receiptDocument,
      progress,
      status,
      statusRecord.sha256,
      identity,
    );
    const rawStatusMatchesProgress = status.status === progress.status;
    if (status.schema_version !== 1
      || status.document_id !== documentId
      || status.citation_allowed !== false
      || !((rawStatusMatchesProgress
        && (fullSuccessorStatus || legacyCompleteInitial || legacyInterruptedInitial))
        || normalizedRecoveryStatus)
      || status.runtime_fingerprint_sha256 !== identity.runtime_fingerprint_sha256) {
      throw new Error('B2 document status differs from run status or identity');
    }
    if (progress.status !== 'running' && progress.status_json_sha256 !== statusRecord.sha256) {
      throw new Error('B2 terminal document status hash differs from run status');
    }
    if (status.seed_lineage !== undefined) {
      if (status.seed_lineage.seed_id !== seedId
        || status.seed_lineage.predecessor_status_sha256 !== receiptDocument.predecessor_status_sha256
        || status.seed_lineage.inherited_attempts !== receiptDocument.inherited_attempts
        || status.seed_lineage.citation_allowed !== false) {
        throw new Error('B2 document status seed lineage is invalid');
      }
    }
    const pageArtifacts = stateSummary.completedPages.map((page) => ({
      page_number: page,
      rendered_image_sha256: stateSummary.pages[String(page)].rendered_image_sha256,
      result_json_sha256: stateSummary.pages[String(page)].result_json_sha256,
      content_markdown_sha256: stateSummary.pages[String(page)].content_markdown_sha256,
      citation_eligible: false,
    }));
    if (progress.status === 'complete') {
      if (stateSummary.completedPages.length !== receiptDocument.page_count
        || stateSummary.failedPageNumbers.length !== 0
        || state.selected_pages_complete !== true
        || status.whole_document_atomic !== true
        || status.artifacts?.state_sha256 !== stateRecord.sha256
        || status.artifacts?.page_artifacts_sha256 !== sha256(`${JSON.stringify(pageArtifacts)}\n`)) {
        throw new Error('B2 complete document is not whole-document atomic');
      }
    }
    completedPages += stateSummary.completedPages.length;
    failedPages += stateSummary.failedPageNumbers.length;
  }
  for (const entry of logEntries) {
    const info = await stat(path.join(logsRoot, entry.name));
    latestProgressMilliseconds = Math.max(latestProgressMilliseconds, info.mtimeMs);
  }
  const receiptCounts = requireObject(receipt.counts, 'B2 receipt counts');
  if (receiptCounts.documents !== receiptDocuments.length
    || receiptCounts.inherited_documents !== receiptDocuments.filter((document) => document.completed_pages.length > 0).length
    || receiptCounts.inherited_pages !== receiptDocuments.reduce((sum, document) => sum + document.completed_pages.length, 0)
    || receiptCounts.failed_pages !== 0
    || receiptCounts.quarantined_documents !== 0) {
    throw new Error('B2 receipt counts differ from its documents');
  }
  const complete = counts.complete === counts.total
    && completedPages === expectedPages
    && failedPages === 0
    && runStatus.finished === true
    && runStatus.settled === true;
  return {
    read_ok: true,
    seed_id_sha256: sha256(seedId),
    receipt_sha256: receiptRecord.sha256,
    marker_sha256: markerRecord.sha256,
    identity_sha256: identityRecord.sha256,
    run_status_sha256: runStatusRecord.sha256,
    documents: receiptDocuments.length,
    expected_pages: expectedPages,
    completed_pages: completedPages,
    failed_pages: failedPages,
    status_counts: counts,
    declared_counts_match: declaredCountsMatch,
    complete,
    inconsistent_completion: runStatus.finished === true && !complete,
    latest_progress_at: iso(latestProgressMilliseconds),
    progress_age_seconds: Math.max(0, Math.floor((nowMilliseconds - latestProgressMilliseconds) / 1000)),
    paddlex_layout_model_cache: paddlexLayoutModelCache,
  };
}

async function probeSystemd(unit, runExecFile = execFile) {
  const { stdout } = await runExecFile('/usr/bin/systemctl', [
    '--user',
    'show',
    unit,
    '--no-pager',
    '--property=LoadState',
    '--property=ActiveState',
    '--property=SubState',
    '--property=NRestarts',
    '--property=ExecMainStatus',
    '--property=MainPID',
    '--property=Result',
  ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
  return parseSystemdShow(stdout);
}

async function readBoundedResponse(response, byteLimit = 64 * 1024) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > byteLimit) {
      await reader.cancel();
      throw new Error('llama health response is oversized');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function probeLlamaHealth(url, runFetch = fetch) {
  try {
    const response = await runFetch(url, { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    const raw = await readBoundedResponse(response);
    let value = null;
    try { value = raw ? JSON.parse(raw) : null; } catch { value = null; }
    return {
      healthy: response.status === 200 && (value?.status === 'ok' || value?.status === 'ready' || value?.ok === true),
      http_status: response.status,
    };
  } catch {
    return { healthy: false, http_status: null };
  }
}

export async function collectSingleShardResources(runRoot, {
  runExecFile = execFile,
  read = readFile,
  filesystemStat = statfs,
} = {}) {
  const results = await Promise.allSettled([
    filesystemStat(runRoot, { bigint: true }),
    read('/proc/meminfo', 'utf8'),
    runExecFile('/usr/bin/nvidia-smi', [
      '--query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total',
      '--format=csv,noheader,nounits',
    ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 }),
  ]);
  const errors = [];
  let disk = null;
  let memory = null;
  let gpu = null;
  if (results[0].status === 'fulfilled') {
    const value = results[0].value;
    const availableBytes = Number(value.bavail * value.bsize);
    if (Number.isSafeInteger(availableBytes) && availableBytes >= 0) {
      disk = { available_gib: Number((availableBytes / gib).toFixed(3)) };
    } else errors.push('DISK_PROBE_FAILED');
  } else errors.push('DISK_PROBE_FAILED');
  if (results[1].status === 'fulfilled') {
    try {
      const availableBytes = parseMeminfo(results[1].value);
      memory = { available_gib: Number((availableBytes / gib).toFixed(3)) };
    } catch { errors.push('MEMORY_PROBE_FAILED'); }
  } else errors.push('MEMORY_PROBE_FAILED');
  if (results[2].status === 'fulfilled') {
    try { gpu = parseNvidiaSmi(results[2].value.stdout); } catch { errors.push('GPU_PROBE_FAILED'); }
  } else errors.push('GPU_PROBE_FAILED');
  return { resources: { disk, memory, gpu }, errors };
}

function failedPredecessor() {
  return { read_ok: false, anchors_match: false, anchors: null };
}

function failedSuccessor() {
  return { read_ok: false, complete: false };
}

async function retryConsistentInspection(action, attempts = 5) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await action(); } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(150);
    }
  }
  throw lastError;
}

export async function collectSingleShardMonitorSnapshot(config, dependencies = {}) {
  const nowMilliseconds = dependencies.nowMilliseconds ?? Date.now();
  const collectionErrors = [];
  const capture = async (code, action, fallback) => {
    try { return await action(); } catch { collectionErrors.push(code); return fallback; }
  };
  const canonicalRunRoot = await requireRealDirectory(config.runRoot, 'monitor run root');
  const predecessorRoot = path.resolve(canonicalRunRoot, config.predecessorOutput);
  const successorRoot = path.resolve(canonicalRunRoot, config.successorOutput);
  const runExecFile = dependencies.execFile || execFile;
  const runFetch = dependencies.fetch || fetch;
  const predecessor = await capture(
    'B1_READ_FAILED',
    () => inspectPredecessorB1(predecessorRoot),
    null,
  );
  const [successor, worker, oldWorkerA, oldWorkerB, llamaSystemd, llamaHealth, resourceResult] = await Promise.all([
    predecessor
      ? capture(
          'B2_READ_FAILED',
          () => retryConsistentInspection(() => inspectSuccessorB2(successorRoot, predecessor, nowMilliseconds)),
          failedSuccessor(),
        )
      : Promise.resolve(failedSuccessor()),
    capture('B2_WORKER_PROBE_FAILED', () => probeSystemd(config.workerUnit, runExecFile), null),
    capture('OLD_WORKER_A_PROBE_FAILED', () => probeSystemd(config.oldWorkerUnits.get('a'), runExecFile), null),
    capture('OLD_WORKER_B_PROBE_FAILED', () => probeSystemd(config.oldWorkerUnits.get('b'), runExecFile), null),
    capture('LLAMA_SYSTEMD_PROBE_FAILED', () => probeSystemd(config.llamaUnit, runExecFile), null),
    probeLlamaHealth(config.llamaHealthUrl, runFetch),
    collectSingleShardResources(canonicalRunRoot, {
      runExecFile,
      read: dependencies.readFile || readFile,
      filesystemStat: dependencies.statfs || statfs,
    }),
  ]);
  collectionErrors.push(...resourceResult.errors);
  const anchorsMatch = predecessor
    ? Object.entries(config.predecessorAnchors).every(([name, expected]) => predecessor.anchors[name] === expected)
    : false;
  return {
    schema_version: 1,
    monitor_type: 'curriculum_remote_ocr_single_shard_b2',
    run_id: path.basename(canonicalRunRoot),
    observed_at: iso(nowMilliseconds),
    thresholds: { ...config.thresholds },
    collection_errors: [...new Set(collectionErrors)].sort(),
    predecessor: predecessor ? {
      read_ok: true,
      anchors: predecessor.anchors,
      anchors_match: anchorsMatch,
      documents: predecessor.counts.total,
      completed_pages: predecessor.completed_pages,
      failed_pages: predecessor.failed_pages,
      quarantined_documents: predecessor.quarantined_documents,
    } : failedPredecessor(),
    successor,
    services: {
      worker,
      old_workers: { a: oldWorkerA, b: oldWorkerB },
      llama: { systemd: llamaSystemd, health: llamaHealth },
    },
    resources: resourceResult.resources,
  };
}

function issue(code) {
  return { code, severity: 'critical' };
}

function serviceActive(service) {
  return Boolean(service
    && (service.active_state === 'active' || service.sub_state === 'running' || service.main_pid > 0));
}

function serviceStrictlyRunning(service) {
  return Boolean(service
    && service.active_state === 'active'
    && service.sub_state === 'running'
    && Number.isSafeInteger(service.main_pid)
    && service.main_pid > 0);
}

export function classifySingleShardSnapshot(snapshot) {
  const issues = (snapshot.collection_errors || []).map(issue);
  const predecessor = snapshot.predecessor || failedPredecessor();
  const successor = snapshot.successor || failedSuccessor();
  const thresholds = snapshot.thresholds || defaultThresholds;
  const worker = snapshot.services?.worker;
  const workerStrictlyRunning = serviceStrictlyRunning(worker);
  if (predecessor.read_ok && predecessor.anchors_match !== true) issues.push(issue('B1_HASH_DRIFT'));
  if (successor.read_ok) {
    if (successor.inconsistent_completion) issues.push(issue('B2_COMPLETION_INCONSISTENT'));
    if (successor.declared_counts_match !== true
      && (!workerStrictlyRunning || successor.complete)) issues.push(issue('B2_RUN_COUNTS_DRIFT'));
    if ((successor.status_counts?.failed || 0) > 0) issues.push(issue('B2_FAILED'));
    if ((successor.status_counts?.quarantined || 0) > 0) issues.push(issue('B2_QUARANTINED'));
    if (!successor.complete
      && (successor.status_counts?.interrupted || 0) > 0
      && !workerStrictlyRunning) issues.push(issue('B2_INTERRUPTED'));
    if ((successor.failed_pages || 0) > 0) issues.push(issue('B2_PAGE_FAILURE'));
    if (!successor.complete
      && workerStrictlyRunning
      && successor.progress_age_seconds > thresholds.stall_seconds) issues.push(issue('B2_NO_PROGRESS'));
  }
  for (const label of ['a', 'b']) {
    if (serviceActive(snapshot.services?.old_workers?.[label])) issues.push(issue(`OLD_WORKER_${label.toUpperCase()}_ACTIVE`));
  }
  if (worker?.n_restarts > 0) issues.push(issue('B2_WORKER_RESTARTED'));
  if (successor.read_ok && !successor.complete) {
    if (!workerStrictlyRunning) issues.push(issue('B2_WORKER_NOT_ACTIVE'));
    if (worker?.exec_main_status !== 0) issues.push(issue('B2_WORKER_EXIT_STATUS'));
    const llama = snapshot.services?.llama;
    if (!llama?.systemd
      || llama.systemd.active_state !== 'active'
      || llama.systemd.sub_state !== 'running'
      || llama.systemd.main_pid < 1
      || llama.systemd.exec_main_status !== 0) {
      issues.push(issue('LLAMA_NOT_ACTIVE'));
    }
    if (!llama?.health?.healthy) issues.push(issue('LLAMA_HEALTH_FAILED'));
    if (llama?.systemd?.n_restarts > 0) issues.push(issue('LLAMA_RESTARTED'));
  }
  if (snapshot.resources?.disk?.available_gib < thresholds.disk_min_gib) issues.push(issue('DISK_BELOW_MINIMUM'));
  if (snapshot.resources?.memory?.available_gib < thresholds.memory_min_gib) issues.push(issue('MEMORY_BELOW_MINIMUM'));
  if (snapshot.resources?.gpu?.max_temperature_c > thresholds.gpu_max_c) issues.push(issue('GPU_OVER_TEMPERATURE'));
  const deduplicated = [...new Map(issues.map((value) => [value.code, value])).values()]
    .sort((left, right) => compareText(left.code, right.code));
  if (deduplicated.length > 0) return { state: 'blocked', exit_code: 12, issues: deduplicated };
  if (successor.read_ok && successor.complete) return { state: 'completed', exit_code: 0, issues: [] };
  return { state: 'healthy_running', exit_code: 10, issues: [] };
}

function safeService(service) {
  return service && {
    active_state: service.active_state,
    sub_state: service.sub_state,
    n_restarts: service.n_restarts,
    exec_main_status: service.exec_main_status,
  };
}

export function privacySafeSingleShardEvent(snapshot, health) {
  return {
    schema_version: 1,
    timestamp: snapshot.observed_at,
    run_id: snapshot.run_id,
    state: health.state,
    exit_code: health.exit_code,
    issue_codes: health.issues.map((value) => value.code),
    predecessor: {
      read_ok: snapshot.predecessor?.read_ok ?? false,
      anchors_match: snapshot.predecessor?.anchors_match ?? false,
      documents: snapshot.predecessor?.documents ?? null,
      completed_pages: snapshot.predecessor?.completed_pages ?? null,
    },
    successor: {
      read_ok: snapshot.successor?.read_ok ?? false,
      complete: snapshot.successor?.complete ?? false,
      documents: snapshot.successor?.documents ?? null,
      expected_pages: snapshot.successor?.expected_pages ?? null,
      completed_pages: snapshot.successor?.completed_pages ?? null,
      failed_pages: snapshot.successor?.failed_pages ?? null,
      status_counts: snapshot.successor?.status_counts ?? null,
      declared_counts_match: snapshot.successor?.declared_counts_match ?? null,
      progress_age_seconds: snapshot.successor?.progress_age_seconds ?? null,
    },
    services: {
      worker: safeService(snapshot.services?.worker),
      old_workers: {
        a: safeService(snapshot.services?.old_workers?.a),
        b: safeService(snapshot.services?.old_workers?.b),
      },
      llama: {
        ...safeService(snapshot.services?.llama?.systemd),
        healthy: snapshot.services?.llama?.health?.healthy ?? false,
        http_status: snapshot.services?.llama?.health?.http_status ?? null,
      },
    },
    resources: snapshot.resources && {
      disk_available_gib: snapshot.resources.disk?.available_gib ?? null,
      memory_available_gib: snapshot.resources.memory?.available_gib ?? null,
      gpu_max_temperature_c: snapshot.resources.gpu?.max_temperature_c ?? null,
      gpu_max_utilization_percent: snapshot.resources.gpu?.max_utilization_percent ?? null,
    },
  };
}

async function atomicWrite(pathname, contents) {
  const temporary = `${pathname}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, pathname);
  await chmod(pathname, 0o600);
}

export async function writeSingleShardMonitorOutputs(outputDir, snapshot, health) {
  const parent = await requireRealDirectory(path.dirname(outputDir), 'monitor output parent');
  const canonicalOutput = path.join(parent, path.basename(outputDir));
  try {
    const info = await lstat(canonicalOutput);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('monitor output must be a real directory');
    const entries = await readdir(canonicalOutput, { withFileTypes: true });
    for (const entry of entries) {
      if (!['latest.json', 'events.jsonl'].includes(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('monitor output contains an unexpected entry');
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(canonicalOutput, { mode: 0o700 });
  }
  await chmod(canonicalOutput, 0o700);
  const safe = privacySafeSingleShardEvent(snapshot, health);
  await atomicWrite(path.join(canonicalOutput, 'latest.json'), `${JSON.stringify(safe, null, 2)}\n`);
  const eventPath = path.join(canonicalOutput, 'events.jsonl');
  const handle = await open(eventPath, 'a', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(safe)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(eventPath, 0o600);
  return safe;
}

function usage() {
  return [
    'Usage: node scripts/monitor-remote-ocr-single-shard.mjs \\',
    '  --run-root DIR --predecessor-output RELATIVE_B1 --successor-output RELATIVE_B2 \\',
    '  --output-dir DIR --worker-unit B2.service \\',
    '  --old-worker-unit a=OLD_A.service --old-worker-unit b=OLD_B.service \\',
    '  --b1-identity-sha256 HASH --b1-run-status-sha256 HASH \\',
    '  --b1-state-hashset-sha256 HASH --b1-status-hashset-sha256 HASH \\',
    '  --b1-artifact-hashset-sha256 HASH [options]',
    '',
    'Options:',
    '  --llama-unit UNIT.service       Default: curriculum-ocr-llama.service',
    '  --llama-health-url URL          Default: http://127.0.0.1:8112/health',
    '  --stall-seconds N               Default: 1500',
    '  --disk-min-gib N                Default: 50',
    '  --memory-min-gib N              Default: 2',
    '  --gpu-max-c N                   Default: 85',
    '',
    'Exit 0 means complete, 10 means healthy and running, and 12 means blocked.',
    'The monitor never changes OCR inputs, outputs, services, or retries. It writes',
    'only privacy-safe latest.json and events.jsonl under --output-dir.',
  ].join('\n');
}

async function main() {
  const config = parseSingleShardMonitorArgs(process.argv.slice(2));
  if (config.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const snapshot = await collectSingleShardMonitorSnapshot(config);
  const health = classifySingleShardSnapshot(snapshot);
  await writeSingleShardMonitorOutputs(config.outputDir, snapshot, health);
  process.stdout.write(`${JSON.stringify({
    timestamp: snapshot.observed_at,
    run_id: snapshot.run_id,
    state: health.state,
    exit_code: health.exit_code,
    issue_codes: health.issues.map((value) => value.code),
    completed_pages: snapshot.successor.completed_pages ?? null,
  })}\n`);
  process.exitCode = health.exit_code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`single-shard OCR monitor failed closed: ${error.name || 'Error'}\n`);
    process.exitCode = 12;
  });
}
