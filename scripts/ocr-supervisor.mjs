#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, appendFile, copyFile, mkdir, open, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyHealth,
  continuousDrainDecision,
  missingCompletedWitnessPages,
  nextPageRetry,
  ocrExecutionPolicy,
  pageRetryKey,
  retryBlocksPage,
  retriesForPage,
  selectPendingPages,
  witnessRecordValid,
} from './lib/ocr-supervisor-state.mjs';

const root = path.resolve(new URL('../', import.meta.url).pathname);
const queue = JSON.parse(await readFile(path.join(root, 'data/ocr-queue.json'), 'utf8'));
const supervisorRoot = path.join(root, '.cache/ocr-supervisor');
const productionRoot = path.join(root, '.cache/ocr-production');
const witnessRoot = path.join(root, '.cache/ocr-witness');
const lockDir = path.join(supervisorRoot, 'lock');
const drainLockDir = path.join(supervisorRoot, 'drain-lock');
const statusPath = path.join(supervisorRoot, 'status.json');
const currentRunPath = path.join(supervisorRoot, 'current-run.json');
const cursorPath = path.join(supervisorRoot, 'cursor.json');
const retriesPath = path.join(supervisorRoot, 'retries.json');
const pageRetriesPath = path.join(supervisorRoot, 'page-retries.json');
const historyPath = path.join(supervisorRoot, 'history.jsonl');
const runtimeIntegrityPath = path.join(supervisorRoot, 'runtime-integrity.json');
const drainStatePath = path.join(supervisorRoot, 'drain-state.json');
const candidateManifestPath = path.join(supervisorRoot, 'concept-candidate-manifest.json');
const candidateRunsRoot = path.join(supervisorRoot, 'concept-runs');
const llamaBinary = path.join(root, '.cache/tools/llama.cpp/build/bin/llama-server');
const llamaRepository = path.join(root, '.cache/tools/llama.cpp');
const modelPath = path.join(root, '.cache/ocr-runtime/PaddleOCR-VL-1.6-GGUF.gguf');
const mmprojPath = path.join(root, '.cache/ocr-runtime/PaddleOCR-VL-1.6-GGUF-mmproj.gguf');
const pythonPath = path.join(root, '.cache/venv-paddleocr/bin/python');
const expected = {
  llama_commit: '12127defda4f41b7679cb2477a4b0d65ee6a0c8f',
  model_sha256: 'f3ae46ec885050acf4b3d31944431e1fd90d50664fb09126af4a3c050ba14ee8',
  mmproj_sha256: '204d757d7610d9b3faab10d506d69e5b244e32bf765e2bab2d0167e65e0a058a',
};
const visionRenderDpi = 240;
const maxBatchPages = 64;
const conceptFingerprintFiles = Object.freeze({
  catalog_sha256: 'data/catalog.json',
  queue_sha256: 'data/ocr-queue.json',
  concept_model_sha256: 'data/concept-model-v2.json',
  lexicon_sha256: 'data/concept-lexicon.json',
  builder_sha256: 'scripts/build-concept-evolution.mjs',
  validator_sha256: 'scripts/validate-concept-evolution.mjs',
});
const conceptCoreArtifactProfile = 'curriculum-concept-evolution-core-v1';
const conceptQualityArtifactProfile = 'curriculum-concept-evolution-quality-v1';
const conceptAcademicSchema = 'curriculum-concept-evolution-academic-v2';

const [command = 'status', ...rawArgs] = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = rawArgs.indexOf(name);
  return index >= 0 && rawArgs[index + 1] ? rawArgs[index + 1] : fallback;
};
const batchPages = Math.max(1, Math.min(maxBatchPages, Number(option('--batch-pages', String(maxBatchPages))) || maxBatchPages));
const requestedDocument = option('--document');
const retryFailed = rawArgs.includes('--retry-failed');
const forceImmediateRecovery = rawArgs.includes('--force-immediate');
const recoveryMode = command === 'recover';
const nowIso = () => new Date().toISOString();
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let activeStageChild = null;
let activeOwnedLlamaChild = null;
let activeOwnedDrainId = null;
let shutdownRequested = false;

function interruptedError() {
  return Object.assign(new Error('OCR supervisor interrupted by signal'), { code: 'RUN_INTERRUPTED', exitCode: 130, scope: 'run' });
}

function throwIfInterrupted() {
  if (shutdownRequested) throw interruptedError();
}

async function interruptibleSleep(milliseconds) {
  const step = 100;
  let remaining = milliseconds;
  while (remaining > 0) {
    throwIfInterrupted();
    const duration = Math.min(step, remaining);
    await sleep(duration);
    remaining -= duration;
  }
  throwIfInterrupted();
}

async function exists(value) {
  try { await access(value); return true; } catch { return false; }
}

async function readJson(value, fallback = null) {
  try { return JSON.parse(await readFile(value, 'utf8')); } catch { return fallback; }
}

function fingerprintsMatch(left, right) {
  if (!left || !right) return false;
  return Object.keys(conceptFingerprintFiles).every((key) => /^[a-f0-9]{64}$/i.test(String(left[key] || ''))
    && left[key] === right[key]);
}

export function conceptCandidateCompatible({ graph, quality, manifest, currentFingerprints }) {
  if (!graph || !quality || !manifest || quality.passed !== true) return false;
  const revision = graph.build_revision;
  if (!/^[a-f0-9]{64}$/i.test(String(revision || ''))
    || quality.build_revision !== revision
    || manifest.build_revision !== revision) return false;
  if (graph.schema_version !== 1
    || quality.schema_version !== 1
    || manifest.schema_version !== 2
    || graph.academic_schema_version !== 2
    || quality.academic_schema_version !== 2
    || manifest.academic_schema_version !== 2
    || graph.artifact_profile !== conceptCoreArtifactProfile
    || quality.artifact_profile !== conceptQualityArtifactProfile
    || manifest.artifact_profile !== conceptCoreArtifactProfile
    || graph.academic_schema !== conceptAcademicSchema
    || quality.academic_schema !== conceptAcademicSchema
    || manifest.academic_schema !== conceptAcademicSchema
    || typeof graph.model_kind !== 'string'
    || !graph.model_kind
    || quality.model_kind !== graph.model_kind
    || manifest.model_kind !== graph.model_kind) return false;
  const academicRef = graph.academic_model_ref;
  if (!academicRef
    || academicRef.build_revision !== revision
    || typeof academicRef.path !== 'string'
    || !academicRef.path
    || !/^[a-f0-9]{64}$/i.test(String(academicRef.sha256 || ''))
    || quality.academic_sha256 !== academicRef.sha256
    || manifest.academic_model_ref?.build_revision !== revision
    || manifest.academic_model_ref?.path !== academicRef.path
    || manifest.academic_model_ref?.sha256 !== academicRef.sha256) return false;
  return fingerprintsMatch(graph.input_fingerprints, currentFingerprints)
    && fingerprintsMatch(quality.input_fingerprints, currentFingerprints)
    && fingerprintsMatch(manifest.input_fingerprints, currentFingerprints);
}

export async function currentConceptInputFingerprints(projectRoot = root) {
  return Object.fromEntries(await Promise.all(Object.entries(conceptFingerprintFiles)
    .map(async ([key, relativePath]) => [key, await sha256File(path.join(projectRoot, relativePath))])));
}

async function readConceptGraph() {
  const formalGraph = await readJson(path.join(root, 'public/data/concept-evolution.json'), {});
  const manifest = await readJson(candidateManifestPath, null);
  if (!manifest?.graph_path || !manifest?.quality_path) return formalGraph;
  const graphPath = path.resolve(root, manifest.graph_path);
  const qualityPath = path.resolve(root, manifest.quality_path);
  const candidateRootPrefix = `${path.resolve(candidateRunsRoot)}${path.sep}`;
  if (!graphPath.startsWith(candidateRootPrefix) || !qualityPath.startsWith(candidateRootPrefix)) return formalGraph;
  const [graph, quality, currentFingerprints] = await Promise.all([
    readJson(graphPath, null),
    readJson(qualityPath, null),
    currentConceptInputFingerprints().catch(() => null),
  ]);
  return conceptCandidateCompatible({ graph, quality, manifest, currentFingerprints }) ? graph : formalGraph;
}

async function readValidWitnessSidecar(value, expectedIdentity = {}) {
  const record = await readJson(value, null);
  if (!witnessRecordValid(record, expectedIdentity)) return null;
  if (!expectedIdentity.imagePath) return record;
  const imageInfo = await stat(expectedIdentity.imagePath).catch(() => null);
  if (!imageInfo?.isFile()) return null;
  const imageMtimeMs = Math.trunc(imageInfo.mtimeMs);
  if (Number(record.rendered_image_bytes) === imageInfo.size && Number(record.rendered_image_mtime_ms) === imageMtimeMs) return record;
  const actualSha = await sha256File(expectedIdentity.imagePath);
  if (record.rendered_image_sha256 !== actualSha) return null;
  const refreshed = { ...record, rendered_image_bytes: imageInfo.size, rendered_image_mtime_ms: imageMtimeMs };
  await atomicJson(value, refreshed);
  return refreshed;
}

async function validWitnessSidecar(value, expectedIdentity = {}) {
  return Boolean(await readValidWitnessSidecar(value, expectedIdentity));
}

async function atomicJson(value, body) {
  await mkdir(path.dirname(value), { recursive: true });
  const temporary = `${value}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`);
  await rename(temporary, value);
}

async function sha256File(value) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(value);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function primaryPageValid(state, documentId, page, deep = false, primaryRoot = productionRoot) {
  const pageState = state?.pages?.[String(page)];
  if (!(state?.completed_pages || []).map(Number).includes(Number(page)) || !pageState) return false;
  if (!/^[a-f0-9]{64}$/i.test(String(pageState.content_markdown_sha256 || ''))
    || !/^[a-f0-9]{64}$/i.test(String(pageState.result_json_sha256 || ''))) return false;
  const pageRoot = path.join(primaryRoot, documentId, 'pages', String(page).padStart(4, '0'));
  const contentPath = path.join(pageRoot, 'content.md');
  const resultPath = path.join(pageRoot, 'result.json');
  if (!(await exists(contentPath)) || !(await exists(resultPath))) return false;
  if (!deep) return true;
  const [contentSha, resultSha] = await Promise.all([sha256File(contentPath), sha256File(resultPath)]);
  return contentSha === pageState.content_markdown_sha256 && resultSha === pageState.result_json_sha256;
}

export async function selectPrimaryRecoveryPages(document, state, {
  limit = Number.POSITIVE_INFINITY,
  primaryRoot = productionRoot,
  eligible = () => true,
} = {}) {
  const completedPages = [...new Set((state?.completed_pages || []).map(Number))]
    .filter((page) => Number.isInteger(page) && page >= 1 && page <= document.page_count)
    .sort((left, right) => left - right);
  const selected = [];
  for (const page of completedPages) {
    if (selected.length >= limit) break;
    if (!(await eligible(page))) continue;
    if (!(await primaryPageValid(state, document.id, page, true, primaryRoot))) selected.push(page);
  }
  return selected;
}

const auditGates = new Set([
  'automatic_witness_pass',
  'manual_image_review_required',
  'blank_page_visual_confirmation_required',
  'unresolved_fail_closed',
]);

function primaryStateHashesValid(state, page) {
  const pageState = state?.pages?.[String(page)];
  return Boolean(pageState
    && /^[a-f0-9]{64}$/i.test(String(pageState.content_markdown_sha256 || ''))
    && /^[a-f0-9]{64}$/i.test(String(pageState.result_json_sha256 || '')));
}

async function readFastAuditInputs(document, state, page, {
  witnessBaseRoot = witnessRoot,
} = {}) {
  if (!primaryStateHashesValid(state, page)) return { valid: false, reason: 'primary' };
  const visionDir = path.join(witnessBaseRoot, document.id, 'vision');
  const witnessPath = path.join(visionDir, `page-${String(page).padStart(3, '0')}.json`);
  const witnessRecord = await readJson(witnessPath, null);
  const { imagePath: _imagePath, ...identity } = await witnessIdentity(document, page, witnessBaseRoot);
  if (!witnessRecordValid(witnessRecord, identity)) return { valid: false, reason: 'witness', visionDir };
  const witnessText = witnessRecord.lines.map((line) => line.text).join('\n');
  return {
    valid: true,
    visionDir,
    primarySha: state.pages[String(page)].content_markdown_sha256,
    witnessSha: createHash('sha256').update(witnessText).digest('hex'),
  };
}

async function readAuditInputs(document, state, page, {
  primaryRoot = productionRoot,
  witnessBaseRoot = witnessRoot,
} = {}) {
  if (!(await primaryPageValid(state, document.id, page, true, primaryRoot))) {
    return { valid: false, reason: 'primary' };
  }
  const visionDir = path.join(witnessBaseRoot, document.id, 'vision');
  const witnessPath = path.join(visionDir, `page-${String(page).padStart(3, '0')}.json`);
  const witnessRecord = await readValidWitnessSidecar(witnessPath, await witnessIdentity(document, page, witnessBaseRoot));
  if (!witnessRecord) return { valid: false, reason: 'witness', visionDir };
  const witnessText = witnessRecord.lines.map((line) => line.text).join('\n');
  return {
    valid: true,
    visionDir,
    primarySha: state.pages[String(page)].content_markdown_sha256,
    witnessSha: createHash('sha256').update(witnessText).digest('hex'),
  };
}

async function inspectAuditPage(document, state, page, options = {}) {
  const primaryRoot = options.primaryRoot || productionRoot;
  const witnessBaseRoot = options.witnessBaseRoot || witnessRoot;
  const inputs = await readFastAuditInputs(document, state, page, { witnessBaseRoot });
  const auditName = `audit-${String(page).padStart(4, '0')}-${String(page).padStart(4, '0')}.json`;
  const auditPaths = [
    path.join(witnessBaseRoot, document.id, 'audits', auditName),
    path.join(primaryRoot, document.id, auditName),
  ];
  const reports = await Promise.all(auditPaths.map((auditPath) => readJson(auditPath, null)));
  const records = reports.flatMap((report) => report?.schema_version === 1 && Array.isArray(report.pages)
    ? report.pages.filter((record) => Number(record?.page) === Number(page))
    : []);
  const current = inputs.valid
    ? records.find((record) => auditGates.has(record.gate)
      && record.primary_sha256 === inputs.primarySha
      && record.witness_sha256 === inputs.witnessSha)
    : null;
  return {
    ...inputs,
    auditPresent: records.length > 0,
    current: Boolean(current),
    gate: current?.gate || 'unresolved_fail_closed',
  };
}

export async function selectAuditBackfillPages(document, state, {
  limit = Number.POSITIVE_INFINITY,
  primaryRoot = productionRoot,
  witnessBaseRoot = witnessRoot,
  eligible = () => true,
} = {}) {
  const completedPages = [...new Set((state?.completed_pages || []).map(Number))]
    .filter((page) => Number.isInteger(page) && page >= 1 && page <= document.page_count)
    .sort((left, right) => left - right);
  const selected = [];
  for (const page of completedPages) {
    if (selected.length >= limit) break;
    if (!(await eligible(page))) continue;
    const audit = await inspectAuditPage(document, state, page, { primaryRoot, witnessBaseRoot });
    if (audit.current) continue;
    const inputs = await readAuditInputs(document, state, page, { primaryRoot, witnessBaseRoot });
    if (inputs.valid) selected.push(page);
  }
  return selected;
}

export async function prepareAuditBackfillWitness(document, pages, state, {
  primaryRoot = productionRoot,
  witnessBaseRoot = witnessRoot,
} = {}) {
  const successPages = [];
  const failures = [];
  const visionDir = path.join(witnessBaseRoot, document.id, 'vision');
  for (const page of pages) {
    const inputs = await readAuditInputs(document, state, page, { primaryRoot, witnessBaseRoot });
    if (inputs.valid) {
      successPages.push(page);
      continue;
    }
    failures.push(inputs.reason === 'primary'
      ? { page, stage: 'audit', code: 'AUDIT_BACKFILL_PRIMARY_STALE', name: 'AuditBackfillInputError', message: 'Primary OCR artifacts changed after audit backfill scheduling' }
      : { page, stage: 'audit', code: 'AUDIT_BACKFILL_WITNESS_STALE', name: 'AuditBackfillInputError', message: 'Independent Vision witness changed after audit backfill scheduling' });
  }
  return { visionDir, successPages, failures };
}

async function runCapture(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env: { ...process.env, ...(options.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${executable} exited ${code ?? signal}: ${stderr.slice(-1200)}`)));
  });
}

async function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function serverHealthy() {
  try {
    const [healthResponse, propsResponse] = await Promise.all([
      fetch('http://127.0.0.1:8112/health', { signal: AbortSignal.timeout(1600) }),
      fetch('http://127.0.0.1:8112/props', { signal: AbortSignal.timeout(1600) }),
    ]);
    if (!healthResponse.ok || !propsResponse.ok) return false;
    const props = await propsResponse.json();
    return path.resolve(String(props.model_path || '')) === path.resolve(modelPath)
      && props.modalities?.vision === true;
  } catch { return false; }
}

async function portOpen() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: 8112 });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(1000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function witnessIdentity(document, page, baseRoot = witnessRoot) {
  return {
    documentId: document.id,
    page,
    pdfSha: document.source_sha256,
    file: `page-${String(page).padStart(3, '0')}.png`,
    imagePath: path.join(baseRoot, document.id, 'images', `page-${String(page).padStart(3, '0')}.png`),
  };
}

async function nextRecovery(limit = batchPages) {
  const pageRetries = await readJson(pageRetriesPath, {});
  const current = await readJson(currentRunPath, null);
  const orderedDocuments = [...queue.documents].sort((left, right) => {
    if (left.id === current?.document_id) return -1;
    if (right.id === current?.document_id) return 1;
    return left.priority - right.priority || left.id.localeCompare(right.id);
  });
  for (const document of orderedDocuments) {
    if (requestedDocument && document.id !== requestedDocument) continue;
    const state = await readJson(path.join(productionRoot, document.id, 'state.json'), {});
    const eligible = (page) => {
      const records = retriesForPage(pageRetries, document.id, page);
      if (records.some((record) => record?.quarantined) && !retryFailed) return false;
      return retryFailed || forceImmediateRecovery
        || !records.some((record) => record?.next_retry_at && Date.parse(record.next_retry_at) > Date.now());
    };
    const primaryRecovery = await selectPrimaryRecoveryPages(document, state, {
      limit,
      eligible,
    });
    const primaryRecoverySet = new Set(primaryRecovery);
    const candidates = [...primaryRecovery];
    const currentStage = String(current?.stage || '');
    const pageFailureStage = !/audit/i.test(currentStage)
      && (/vision|paddle/i.test(currentStage) || current?.error_scope === 'page');
    if ((current?.status === 'failed' || current?.status === 'partial_failed') && pageFailureStage && current.document_id === document.id) candidates.push(...(current.pages || []));
    const visionDir = path.join(witnessRoot, document.id, 'vision');
    if (await exists(visionDir)) {
      for (const file of (await readdir(visionDir)).filter((name) => /^page-\d+\.json$/.test(name)).sort()) {
        const page = Number(file.match(/\d+/)?.[0]);
        if (!Number.isInteger(page) || page < 1 || page > document.page_count) continue;
        if (!(await validWitnessSidecar(path.join(visionDir, file), await witnessIdentity(document, page)))) candidates.push(page);
      }
    }
    for (const [key, retry] of Object.entries(pageRetries)) {
      const match = key.match(/^(.+):(\d+):([^:]+)$/);
      if (match?.[1] !== document.id || match?.[3] === 'audit' || (retry?.quarantined && !retryFailed)) continue;
      candidates.push(Number(match[2]));
    }
    const pages = [...new Set(candidates.map(Number).filter((page) => Number.isInteger(page) && page >= 1 && page <= document.page_count))]
      .filter((page) => {
        const records = retriesForPage(pageRetries, document.id, page);
        if (records.some((record) => record?.quarantined) && !retryFailed) return false;
        if (!retryFailed && !forceImmediateRecovery && records.some((record) => record?.next_retry_at && Date.parse(record.next_retry_at) > Date.now())) return false;
        return true;
      })
      .slice(0, limit);
    if (pages.length) {
      const completed = new Set((state.completed_pages || []).map(Number));
      const mode = pages.every((page) => primaryRecoverySet.has(page))
        ? 'primary_recovery'
        : pages.every((page) => completed.has(page))
          ? 'witness_recovery'
          : 'full_recovery';
      return { document, pages, state, mode };
    }
    const auditBackfill = await selectAuditBackfillPages(document, state, { limit, eligible });
    if (auditBackfill.length) return { document, pages: auditBackfill, state, mode: 'audit_backfill' };
  }
  return null;
}

async function nextBatch(limit = batchPages) {
  if (recoveryMode) return nextRecovery(limit);
  const cursor = await readJson(cursorPath, {});
  const retries = await readJson(retriesPath, {});
  const pageRetries = await readJson(pageRetriesPath, {});
  for (const document of queue.documents) {
    if (requestedDocument && document.id !== requestedDocument) continue;
    const state = await readJson(path.join(productionRoot, document.id, 'state.json'), {});
    const primaryRecovery = await selectPrimaryRecoveryPages(document, state, {
      limit,
      eligible: (page) => !retryBlocksPage(pageRetries, document.id, page, Date.now(), retryFailed),
    });
    if (primaryRecovery.length) return { document, pages: primaryRecovery, state, mode: 'primary_recovery' };
    const visionDir = path.join(witnessRoot, document.id, 'vision');
    const missingWitness = [];
    for (const page of state.completed_pages || []) {
      const sidecar = path.join(visionDir, `page-${String(page).padStart(3, '0')}.json`);
      if (retryBlocksPage(pageRetries, document.id, page, Date.now(), retryFailed)) continue;
      if (!(await validWitnessSidecar(sidecar, await witnessIdentity(document, page)))) missingWitness.push(page);
      if (missingWitness.length >= limit) break;
    }
    if (missingWitness.length) return { document, pages: missingWitness, state, mode: 'witness_backfill' };
    const auditBackfill = await selectAuditBackfillPages(document, state, {
      limit,
      eligible: (page) => !retryBlocksPage(pageRetries, document.id, page, Date.now(), retryFailed),
    });
    if (auditBackfill.length) return { document, pages: auditBackfill, state, mode: 'audit_backfill' };
  }
  const candidates = [];
  for (const document of queue.documents) {
    if (requestedDocument && document.id !== requestedDocument) continue;
    const retry = retries[document.id];
    if (retry?.quarantined) continue;
    if (retry?.next_retry_at && Date.parse(retry.next_retry_at) > Date.now()) continue;
    const state = await readJson(path.join(productionRoot, document.id, 'state.json'), {});
    const pages = selectPendingPages({
      pageCount: document.page_count,
      completedPages: state.completed_pages || [],
      failedPages: state.failed_pages || {},
      pageRetries,
      documentId: document.id,
      limit,
      includeFailed: retryFailed,
    });
    if (pages.length) candidates.push({ document, pages, state, mode: 'new_ocr' });
  }
  if (!candidates.length) return null;
  const minimumPriority = Math.min(...candidates.map((item) => item.document.priority));
  const pool = candidates.filter((item) => item.document.priority === minimumPriority).sort((a, b) => a.document.id.localeCompare(b.document.id));
  const lastIndex = pool.findIndex((item) => item.document.id === cursor.last_document_id);
  return pool[(lastIndex + 1 + pool.length) % pool.length];
}

async function collectAuditMetrics() {
  const pageGates = new Map();
  const staleAuditPages = new Set();
  for (const document of queue.documents) {
    const state = await readJson(path.join(productionRoot, document.id, 'state.json'), {});
    const completedPages = [...new Set((state.completed_pages || []).map(Number))]
      .filter((page) => Number.isInteger(page) && page >= 1 && page <= document.page_count);
    for (const page of completedPages) {
      const key = `${document.id}:${page}`;
      const audit = await inspectAuditPage(document, state, page);
      if (audit.current) pageGates.set(key, audit.gate);
      else if (audit.auditPresent) staleAuditPages.add(key);
    }
  }
  const gates = { automatic_witness_pass: 0, manual_image_review_required: 0, blank_page_visual_confirmation_required: 0, unresolved_fail_closed: 0 };
  for (const gate of pageGates.values()) gates[gate] = (gates[gate] || 0) + 1;
  return { audited_pages: pageGates.size, stale_audit_pages: staleAuditPages.size, gates };
}

async function collectReviewMetrics() {
  const files = (await readdir(path.join(root, 'data'))).filter((file) => /^ocr-review-.*\.json$/.test(file));
  let reviewed = 0;
  let citationEligible = 0;
  const decisions = {};
  for (const file of files) {
    const report = await readJson(path.join(root, 'data', file), {});
    for (const page of report.pages || []) {
      reviewed += 1;
      citationEligible += page.citation_allowed ? 1 : 0;
      decisions[page.decision] = (decisions[page.decision] || 0) + 1;
    }
  }
  return { reviewed_pages: reviewed, citation_eligible_pages: citationEligible, decisions };
}

async function collectStatus(write = true) {
  await mkdir(supervisorRoot, { recursive: true });
  let completed = 0;
  let failures = 0;
  let witnessPages = 0;
  let witnessErrors = 0;
  let missingCompletedWitnesses = 0;
  const documents = [];
  const [documentRetries, pageRetries] = await Promise.all([
    readJson(retriesPath, {}),
    readJson(pageRetriesPath, {}),
  ]);
  for (const document of queue.documents) {
    const state = await readJson(path.join(productionRoot, document.id, 'state.json'), {});
    const completedPages = (state.completed_pages || []).filter((page) => Number.isInteger(page));
    const validCompleted = [];
    for (const page of completedPages) {
      if (await primaryPageValid(state, document.id, page, false)) validCompleted.push(page);
    }
    const visionDir = path.join(witnessRoot, document.id, 'vision');
    const visionFiles = await exists(visionDir) ? (await readdir(visionDir)).filter((file) => /^page-\d+\.json$/.test(file)) : [];
    let validWitnesses = 0;
    const validWitnessPageNumbers = [];
    for (const file of visionFiles) {
      const page = Number(file.match(/\d+/)?.[0]);
      if (await validWitnessSidecar(path.join(visionDir, file), await witnessIdentity(document, page))) {
        validWitnesses += 1;
        validWitnessPageNumbers.push(page);
      } else witnessErrors += 1;
    }
    const missingForDocument = missingCompletedWitnessPages(validCompleted, validWitnessPageNumbers);
    missingCompletedWitnesses += missingForDocument.length;
    completed += validCompleted.length;
    witnessPages += validWitnesses;
    failures += Object.keys(state.failed_pages || {}).length;
    const documentPageRetries = Object.keys(pageRetries).filter((key) => key.startsWith(`${document.id}:`));
    if (validCompleted.length || Object.keys(state.failed_pages || {}).length || visionFiles.length || documentPageRetries.length) {
      documents.push({
        id: document.id,
        priority: document.priority,
        pages: document.page_count,
        completed: validCompleted.length,
        failed: Object.keys(state.failed_pages || {}).length,
        witness: validWitnesses,
        witness_errors: visionFiles.length - validWitnesses,
        witness_missing_for_completed: missingForDocument,
        page_retry_records: documentPageRetries.length,
        document_retry: documentRetries[document.id] || null,
        updated_at: state.updated_at || null,
      });
    }
  }
  const [audit, review, disk, graph, next, owner, current, drainOwner, drainState] = await Promise.all([
    collectAuditMetrics(), collectReviewMetrics(), statfs(root), readConceptGraph(), nextBatch(),
    readJson(path.join(lockDir, 'owner.json'), null), readJson(currentRunPath, null),
    readJson(path.join(drainLockDir, 'owner.json'), null), readJson(drainStatePath, null),
  ]);
  const freeGiB = Number(disk.bavail * disk.bsize) / 1024 ** 3;
  const currentHeartbeatAge = current?.heartbeat_at ? (Date.now() - Date.parse(current.heartbeat_at)) / 60000 : null;
  const drainHeartbeatAge = drainState?.heartbeat_at ? (Date.now() - Date.parse(drainState.heartbeat_at)) / 60000 : null;
  const lockActive = Boolean(owner && await processAlive(owner.pid));
  const drainActive = Boolean(drainOwner && await processAlive(drainOwner.pid));
  const externalDrainActive = drainActive
    && !(drainOwner.pid === process.pid && drainOwner.drain_id === activeOwnedDrainId);
  const healthLockActive = lockActive || externalDrainActive;
  const heartbeatAge = lockActive ? currentHeartbeatAge : externalDrainActive ? drainHeartbeatAge : null;
  const stalled = Boolean(healthLockActive && heartbeatAge !== null && heartbeatAge > 20);
  const health = classifyHealth({
    lockActive: healthLockActive,
    stalled,
    diskHardStop: freeGiB < 25,
    witnessErrors,
    currentRun: current,
    documentRetries,
    pageRetries,
    hasEligibleWork: Boolean(next),
  });
  const pendingPages = Math.max(0, queue.counts.pages - completed);
  const schedulerState = next
    ? 'ready'
    : pendingPages === 0
      ? 'queue_complete'
      : health.earliest_retry_at
        ? 'backoff_active'
        : health.overall === 'blocked'
          ? 'blocked'
          : 'no_eligible_pages';
  const status = {
    schema_version: 2, generated_at: nowIso(),
    policy: { batch_pages: batchPages, max_batch_pages: maxBatchPages, vision_render_dpi: visionRenderDpi, vision_render_settle_seconds: 1.5, vision_immediate_retries_seconds: [2, 10, 30], page_retry_quarantine_after: 5, disk_warning_gib: 50, disk_hard_stop_gib: 25, stall_minutes: 20, candidates_never_citation_eligible: true, automatic_deploy: false },
    health,
    scheduler_state: schedulerState,
    queue: { documents: queue.counts.documents, pages: queue.counts.pages, completed_pages: completed, pending_pages: pendingPages, failed_pages: failures },
    evidence: { witness_pages: witnessPages, witness_error_sidecars: witnessErrors, witness_missing_for_completed: missingCompletedWitnesses, ...audit, ...review },
    retries: { documents: documentRetries, pages: pageRetries },
    runtime: {
      lock_active: lockActive,
      lock_owner: owner,
      drain_active: drainActive,
      drain_owner: drainOwner,
      drain_state: drainState,
      current_run: current,
      stalled,
      heartbeat_age_minutes: heartbeatAge === null ? null : Number(heartbeatAge.toFixed(2)),
      server_healthy: await serverHealthy(),
    },
    disk: { free_gib: Number(freeGiB.toFixed(2)), warning: freeGiB < 50, hard_stop: freeGiB < 25 },
    concept_graph: graph.coverage || null,
    next_batch: next ? { mode: next.mode, document_id: next.document.id, title: next.document.title, subject: next.document.subject, priority: next.document.priority, pages: next.pages } : null,
    documents,
  };
  if (write) await atomicJson(statusPath, status);
  return status;
}

async function assertNoExternalDrain() {
  const owner = await readJson(path.join(drainLockDir, 'owner.json'), null);
  if (!owner || owner.pid === process.pid) return;
  if (await processAlive(owner.pid)) {
    throw Object.assign(new Error(`Continuous OCR drain is already active under PID ${owner.pid}`), {
      exitCode: 75,
      code: 'DRAIN_ACTIVE',
    });
  }
}

async function acquireDrainLock(drainId) {
  await mkdir(supervisorRoot, { recursive: true });
  let ownsDirectory = false;
  try {
    await mkdir(drainLockDir);
    ownsDirectory = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await readJson(path.join(drainLockDir, 'owner.json'), {});
    if (await processAlive(owner.pid)) {
      throw Object.assign(new Error(`Continuous OCR drain is already active under PID ${owner.pid}`), {
        exitCode: 75,
        code: 'DRAIN_ACTIVE',
      });
    }
    if (!Number.isInteger(owner.pid) || !owner.drain_id) {
      const lockInfo = await stat(drainLockDir).catch(() => null);
      const ageMinutes = lockInfo ? (Date.now() - lockInfo.mtimeMs) / 60000 : 0;
      if (ageMinutes < 20) {
        throw Object.assign(new Error('Continuous drain lock owner is incomplete; treating it as busy'), {
          exitCode: 75,
          code: 'DRAIN_LOCK_OWNER_PENDING',
        });
      }
    }
    const stale = path.join(supervisorRoot, `drain-lock-stale-${Date.now()}`);
    try {
      await rename(drainLockDir, stale);
      await mkdir(drainLockDir);
      ownsDirectory = true;
    } catch {
      throw Object.assign(new Error('Continuous drain lock changed during stale-lock recovery; treating it as busy'), {
        exitCode: 75,
        code: 'DRAIN_LOCK_RACE',
      });
    }
  }
  try {
    await atomicJson(path.join(drainLockDir, 'owner.json'), {
      pid: process.pid,
      drain_id: drainId,
      started_at: nowIso(),
      argv: process.argv.slice(2),
    });
  } catch (error) {
    if (ownsDirectory) await rm(drainLockDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function releaseDrainLock(drainId) {
  const owner = await readJson(path.join(drainLockDir, 'owner.json'), null);
  if (owner?.drain_id === drainId && owner?.pid === process.pid) {
    await rm(drainLockDir, { recursive: true, force: true });
  }
}

async function acquireLock(runId) {
  await mkdir(supervisorRoot, { recursive: true });
  let ownsDirectory = false;
  try {
    await mkdir(lockDir);
    ownsDirectory = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await readJson(path.join(lockDir, 'owner.json'), {});
    if (await processAlive(owner.pid)) throw Object.assign(new Error(`OCR supervisor is already active under PID ${owner.pid}`), { exitCode: 75 });
    if (!Number.isInteger(owner.pid) || !owner.run_id) {
      const lockInfo = await stat(lockDir).catch(() => null);
      const ageMinutes = lockInfo ? (Date.now() - lockInfo.mtimeMs) / 60000 : 0;
      if (ageMinutes < 20) throw Object.assign(new Error('OCR supervisor lock exists but its owner record is not complete; treating it as busy'), { exitCode: 75, code: 'LOCK_OWNER_PENDING' });
    }
    const stale = path.join(supervisorRoot, `lock-stale-${Date.now()}`);
    try {
      await rename(lockDir, stale);
      await mkdir(lockDir);
      ownsDirectory = true;
    } catch {
      throw Object.assign(new Error('OCR supervisor lock changed during stale-lock recovery; treating it as busy'), { exitCode: 75, code: 'LOCK_RACE' });
    }
  }
  try {
    await atomicJson(path.join(lockDir, 'owner.json'), { pid: process.pid, run_id: runId, started_at: nowIso(), argv: process.argv.slice(2) });
  } catch (error) {
    if (ownsDirectory) await rm(lockDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function releaseLock(runId) {
  const owner = await readJson(path.join(lockDir, 'owner.json'), null);
  if (owner?.run_id === runId && owner?.pid === process.pid) await rm(lockDir, { recursive: true, force: true });
}

async function updateRun(run) {
  run.heartbeat_at = nowIso();
  await atomicJson(currentRunPath, run);
}

async function startLlama(logPath) {
  if (await portOpen()) throw Object.assign(new Error('Port 8112 is already occupied; quality-first mode refuses to reuse a server without this run\'s exact model/mmproj ownership fingerprint.'), { code: 'LLAMA_PORT_OWNERSHIP_UNKNOWN', scope: 'global' });
  const log = await open(logPath, 'a');
  const child = spawn(llamaBinary, [
    '-m', modelPath, '--mmproj', mmprojPath, '--host', '127.0.0.1', '--port', '8112', '--temp', '0',
    '--ctx-size', '8192', '--n-gpu-layers', 'all', '--parallel', '1', '--timeout', '3600', '--no-webui', '--metrics',
  ], { cwd: root, stdio: ['ignore', log.fd, log.fd] });
  activeOwnedLlamaChild = child;
  try {
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 120000;
      const poll = async () => {
        if (shutdownRequested) return reject(interruptedError());
        if (await serverHealthy()) return resolve();
        if (child.exitCode !== null) return reject(new Error(`llama-server exited before healthy: ${child.exitCode}`));
        if (Date.now() > deadline) return reject(new Error('llama-server did not become healthy within 120 seconds'));
        setTimeout(poll, 1000);
      };
      poll();
    });
    return { child, reused: false, log };
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(5000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); }),
    ]).catch(() => {});
    await log.close().catch(() => {});
    if (activeOwnedLlamaChild === child) activeOwnedLlamaChild = null;
    throw error;
  }
}

async function stopOwnedServer(server) {
  if (!server?.child || server.child.exitCode !== null) {
    if (activeOwnedLlamaChild === server?.child) activeOwnedLlamaChild = null;
    await server?.log?.close().catch(() => {});
    return;
  }
  server.child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.child.once('exit', resolve)),
    sleep(10000).then(() => { if (server.child.exitCode === null) server.child.kill('SIGKILL'); }),
  ]);
  if (activeOwnedLlamaChild === server.child) activeOwnedLlamaChild = null;
  await server.log?.close().catch(() => {});
}

async function runLogged(executable, args, logPath, run, stage, env = {}, acceptedExitCodes = [0]) {
  throwIfInterrupted();
  run.stage = stage;
  await updateRun(run);
  const log = await open(logPath, 'a');
  const child = spawn(executable, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', log.fd, log.fd] });
  activeStageChild = child;
  run.active_child_pid = child.pid || null;
  await updateRun(run);
  const heartbeat = setInterval(() => updateRun(run).catch(() => {}), 30000);
  const result = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => acceptedExitCodes.includes(code)
      ? resolve({ code, signal })
      : reject(Object.assign(new Error(`${stage} exited ${code ?? signal}`), { stage, code, signal })));
  }).finally(async () => {
    clearInterval(heartbeat);
    if (activeStageChild === child) activeStageChild = null;
    run.active_child_pid = null;
    await log.close().catch(() => {});
  });
  await updateRun(run);
  throwIfInterrupted();
  return result;
}

async function renderVision(document, pages, pdfSha, logPath, run) {
  throwIfInterrupted();
  const base = path.join(witnessRoot, document.id);
  const imageDir = path.join(base, 'images');
  const visionDir = path.join(base, 'vision');
  await Promise.all([mkdir(imageDir, { recursive: true }), mkdir(visionDir, { recursive: true })]);
  const images = [];
  run.stage = 'render_and_independent_vision';
  await updateRun(run);
  for (const page of pages) {
    throwIfInterrupted();
    const stem = `page-${String(page).padStart(3, '0')}`;
    const prefix = path.join(imageDir, stem);
    const imagePath = `${prefix}.png`;
    await runCapture('/opt/homebrew/bin/pdftoppm', ['-f', String(page), '-l', String(page), '-r', String(visionRenderDpi), '-png', '-singlefile', path.join(root, document.local_cache_path), prefix]);
    throwIfInterrupted();
    images.push(imagePath);
  }
  // Vision intermittently returns Foundation._GenericObjCError when invoked in
  // the same instant that Poppler closes a newly rendered PNG. A short bounded
  // settle keeps the independent witness deterministic without weakening it.
  await interruptibleSleep(1500);
  const attempts = new Map(pages.map((page) => [page, 1]));
  await runLogged('/usr/bin/swift', [path.join(root, 'scripts/vision-ocr-batch.swift'), '--output-dir', visionDir, ...images], logPath, run, 'independent_apple_vision');
  throwIfInterrupted();

  const failedIndexes = async () => {
    const failed = [];
    for (let index = 0; index < images.length; index += 1) {
      const page = pages[index];
      const sidecarPath = path.join(visionDir, `page-${String(page).padStart(3, '0')}.json`);
      const record = await readJson(sidecarPath, null);
      if (!record || record.error || !Array.isArray(record.lines)) failed.push(index);
    }
    return failed;
  };

  let failed = await failedIndexes();
  for (const delay of [2000, 10000, 30000]) {
    if (!failed.length) break;
    await interruptibleSleep(delay);
    for (const index of failed) {
      throwIfInterrupted();
      const page = pages[index];
      attempts.set(page, (attempts.get(page) || 1) + 1);
      await runLogged('/usr/bin/swift', [path.join(root, 'scripts/vision-ocr-batch.swift'), '--output-dir', visionDir, images[index]], logPath, run, 'independent_apple_vision_page_retry');
    }
    failed = await failedIndexes();
  }

  const successPages = [];
  const failures = [];
  for (let index = 0; index < images.length; index += 1) {
    const page = pages[index];
    const image = images[index];
    const sidecarPath = path.join(visionDir, `page-${String(page).padStart(3, '0')}.json`);
    const record = await readJson(sidecarPath, null);
    const imageSha = await sha256File(image);
    const imageInfo = await stat(image);
    if (!record || record.error || !Array.isArray(record.lines)) {
      failures.push({
        page,
        stage: 'vision',
        code: record?.errorCode ? `${record.errorDomain || 'Vision'}:${record.errorCode}` : 'VISION_WITNESS_FAILED',
        name: 'VisionWitnessError',
        message: record?.errorDescription || record?.error || 'missing sidecar',
        attempts: attempts.get(page),
      });
      continue;
    }
    const enriched = {
      ...record,
      schema_version: 2,
      document_id: document.id,
      physical_pdf_page: page,
      source_pdf_sha256: pdfSha,
      rendered_image_sha256: imageSha,
      rendered_image_bytes: imageInfo.size,
      rendered_image_mtime_ms: Math.trunc(imageInfo.mtimeMs),
      generated_at: nowIso(),
      attempt_count: attempts.get(page),
      recovered_after_retry: attempts.get(page) > 1,
      engine: 'Apple Vision VNRecognizeTextRequest accurate zh-Hans+en-US',
      engine_configuration: { recognition_level: 'accurate', languages: ['zh-Hans', 'en-US'], language_correction: true, minimum_text_height: 0.008, render_dpi: visionRenderDpi },
      critical_fields: [],
      citation_allowed: false,
    };
    if (!witnessRecordValid(enriched, { ...await witnessIdentity(document, page), imageSha })) {
      failures.push({ page, stage: 'vision', code: 'VISION_IDENTITY_MISMATCH', name: 'VisionWitnessError', message: 'sidecar identity failed strict validation', attempts: attempts.get(page) });
      continue;
    }
    await atomicJson(sidecarPath, enriched);
    successPages.push(page);
  }
  return { imageDir, visionDir, successPages, failures };
}

async function preflight(document, { requirePrimaryRuntime = true } = {}) {
  const disk = await statfs(root);
  const freeGiB = Number(disk.bavail * disk.bsize) / 1024 ** 3;
  if (freeGiB < 25) throw Object.assign(new Error(`Disk hard stop: ${freeGiB.toFixed(2)} GiB free`), { permanent: false, scope: 'global', code: 'DISK_HARD_STOP' });
  if (requirePrimaryRuntime) {
    const sharedRuntime = [llamaBinary, modelPath, mmprojPath, pythonPath];
    for (const value of sharedRuntime) if (!(await exists(value))) throw Object.assign(new Error(`Missing shared OCR runtime file: ${value}`), { permanent: true, scope: 'global', code: 'RUNTIME_SHARED_MISSING' });
  }
  const sourcePath = path.join(root, document.local_cache_path);
  if (!(await exists(sourcePath))) throw Object.assign(new Error(`Missing source PDF: ${sourcePath}`), { permanent: true, scope: 'document', code: 'SOURCE_FILE_MISSING' });
  const pdfSha = await sha256File(sourcePath);
  const commit = requirePrimaryRuntime
    ? await runCapture('git', ['-C', llamaRepository, 'rev-parse', 'HEAD']).then((result) => result.stdout.trim())
    : null;
  if (requirePrimaryRuntime && commit !== expected.llama_commit) throw Object.assign(new Error(`llama.cpp revision mismatch: ${commit}`), { permanent: true, scope: 'global', code: 'LLAMA_REVISION_MISMATCH' });
  if (pdfSha !== document.source_sha256) throw Object.assign(new Error(`Source PDF checksum mismatch for ${document.id}`), { permanent: true, scope: 'document', code: 'SOURCE_CHECKSUM_MISMATCH' });
  return {
    free_gib: freeGiB,
    model_sha256: null,
    mmproj_sha256: null,
    source_pdf_sha256: pdfSha,
    llama_commit: commit,
    runtime_model_integrity: requirePrimaryRuntime ? 'pending_until_witness_passes' : 'not_required_for_audit_backfill',
  };
}

async function validatePaddleRuntime() {
  const cache = await readJson(runtimeIntegrityPath, {});
  const verify = async (filePath, expectedSha, code, label) => {
    const info = await stat(filePath);
    const key = path.basename(filePath);
    const cached = cache[key];
    const mtimeMs = Math.trunc(info.mtimeMs);
    let actualSha = cached?.size === info.size && cached?.mtime_ms === mtimeMs && cached?.sha256 === expectedSha
      ? cached.sha256
      : await sha256File(filePath);
    if (actualSha !== expectedSha) throw Object.assign(new Error(`${label} checksum mismatch`), { permanent: true, scope: 'global', code });
    cache[key] = { size: info.size, mtime_ms: mtimeMs, sha256: actualSha, verified_at: nowIso() };
    return actualSha;
  };
  const [modelSha, mmprojSha] = await Promise.all([
    verify(modelPath, expected.model_sha256, 'MODEL_CHECKSUM_MISMATCH', 'PaddleOCR-VL model'),
    verify(mmprojPath, expected.mmproj_sha256, 'MMPROJ_CHECKSUM_MISMATCH', 'PaddleOCR-VL mmproj'),
  ]);
  await atomicJson(runtimeIntegrityPath, cache);
  return { model_sha256: modelSha, mmproj_sha256: mmprojSha, runtime_model_integrity: 'verified' };
}

async function recordFailure(documentId, error) {
  const retries = await readJson(retriesPath, {});
  const previous = retries[documentId] || { attempts: 0 };
  const attempts = previous.attempts + 1;
  const delays = [1, 6, 24];
  retries[documentId] = {
    attempts, last_error: `${error.name}: ${error.message}`.slice(0, 600), last_failed_at: nowIso(),
    quarantined: Boolean(error.permanent || attempts >= 3),
    next_retry_at: error.permanent || attempts >= 3 ? null : new Date(Date.now() + delays[attempts - 1] * 3600000).toISOString(),
  };
  await atomicJson(retriesPath, retries);
}

async function clearFailure(documentId) {
  const retries = await readJson(retriesPath, {});
  if (retries[documentId]) { delete retries[documentId]; await atomicJson(retriesPath, retries); }
}

async function recordPageFailure(documentId, failure) {
  const records = await readJson(pageRetriesPath, {});
  const key = pageRetryKey(documentId, failure.page, failure.stage);
  records[key] = nextPageRetry(records[key], failure);
  await atomicJson(pageRetriesPath, records);
  return records[key];
}

async function clearPageFailures(documentId, page) {
  const records = await readJson(pageRetriesPath, {});
  let changed = false;
  for (const key of Object.keys(records)) {
    if (key.startsWith(`${documentId}:${Number(page)}:`)) {
      delete records[key];
      changed = true;
    }
  }
  if (changed) await atomicJson(pageRetriesPath, records);
}

async function promoteConceptCandidate(runDirectory) {
  const graphPath = path.join(runDirectory, 'concept-evolution.json');
  const qualityPath = path.join(runDirectory, 'concept-evolution-quality.json');
  const [graph, quality] = await Promise.all([readJson(graphPath, null), readJson(qualityPath, null)]);
  const manifest = {
    schema_version: 2,
    promoted_at: nowIso(),
    run_directory: path.relative(root, runDirectory),
    build_revision: graph?.build_revision,
    artifact_profile: graph?.artifact_profile,
    academic_schema_version: graph?.academic_schema_version,
    academic_schema: graph?.academic_schema,
    model_kind: graph?.model_kind,
    input_fingerprints: graph?.input_fingerprints,
    academic_model_ref: graph?.academic_model_ref || null,
    graph_path: path.relative(root, graphPath),
    quality_path: path.relative(root, qualityPath),
  };
  const currentFingerprints = await currentConceptInputFingerprints();
  if (!conceptCandidateCompatible({ graph, quality, manifest, currentFingerprints })) {
    throw Object.assign(new Error('Concept candidate validation did not produce a matching passing graph and quality report'), { scope: 'derived', code: 'CONCEPT_CANDIDATE_INVALID' });
  }
  await atomicJson(candidateManifestPath, manifest);
  const currentName = path.basename(runDirectory);
  const previousNames = (await readdir(candidateRunsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== currentName)
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const staleName of previousNames.slice(1)) {
    await rm(path.join(candidateRunsRoot, staleName), { recursive: true, force: true });
  }
}

async function once() {
  shutdownRequested = false;
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  let lockAcquired = false;
  let selected = null;
  let run = null;
  let server = null;
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    shutdownRequested = true;
    if (activeStageChild?.exitCode === null) activeStageChild.kill('SIGTERM');
    if (activeOwnedLlamaChild?.exitCode === null) activeOwnedLlamaChild.kill('SIGTERM');
    if (server?.child && server.child.exitCode === null) server.child.kill('SIGTERM');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await assertNoExternalDrain();
    await acquireLock(runId);
    lockAcquired = true;
    throwIfInterrupted();
    selected = await nextBatch();
    if (!selected) {
      const status = await collectStatus();
      console.log(JSON.stringify({ status: status.scheduler_state, health: status.health }));
      return;
    }
    const { document, pages, mode } = selected;
    const logDir = path.join(supervisorRoot, 'logs', runId);
    await mkdir(logDir, { recursive: true });
    run = {
      schema_version: 2,
      run_id: runId,
      pid: process.pid,
      mode,
      document_id: document.id,
      pages,
      started_at: nowIso(),
      heartbeat_at: nowIso(),
      stage: 'preflight',
      status: 'running',
      owned_llama_pid: null,
      page_failures: [],
      audited_pages: [],
    };
    await updateRun(run);
    const executionPolicy = ocrExecutionPolicy(mode);
    const checks = await preflight(document, { requirePrimaryRuntime: executionPolicy.runPrimaryOcr });
    throwIfInterrupted();
    run.preflight = checks;
    let witness;
    if (executionPolicy.renderVision) {
      witness = await renderVision(document, pages, checks.source_pdf_sha256, path.join(logDir, 'vision.log'), run);
    } else {
      run.stage = 'audit_backfill_input_validation';
      await updateRun(run);
      const currentState = await readJson(path.join(productionRoot, document.id, 'state.json'), {});
      witness = await prepareAuditBackfillWitness(document, pages, currentState);
    }
    throwIfInterrupted();
    for (const failure of witness.failures) {
      await recordPageFailure(document.id, failure);
      run.page_failures.push(failure);
    }

    const beforePaddle = await readJson(path.join(productionRoot, document.id, 'state.json'), {});
    const paddlePages = [];
    if (executionPolicy.runPrimaryOcr) {
      for (const page of witness.successPages) {
        if (!(await primaryPageValid(beforePaddle, document.id, page, true))) paddlePages.push(page);
      }
    }
    let paddleExecutionError = null;
    if (paddlePages.length) {
      throwIfInterrupted();
      Object.assign(checks, await validatePaddleRuntime());
      run.preflight = checks;
      await updateRun(run);
      run.stage = 'start_llama';
      await updateRun(run);
      server = await startLlama(path.join(logDir, 'llama.log'));
      throwIfInterrupted();
      run.owned_llama_pid = server.child?.pid || null;
      run.reused_llama_server = server.reused;
      await updateRun(run);
      try {
        const paddleResult = await runLogged(pythonPath, [
          path.join(root, 'scripts/ocr-pdf-paddle.py'), document.id, path.join(root, document.local_cache_path), productionRoot,
          '--pages', paddlePages.join(','), '--save-visuals', '--force-reprocess',
        ], path.join(logDir, 'paddle.log'), run, 'paddle_ocr', {
          PADDLE_PDX_CACHE_HOME: path.join(root, '.cache/paddlex'), PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True',
        }, [0, 1]);
        run.paddle_exit_code = paddleResult.code;
      } catch (error) {
        paddleExecutionError = error;
        run.paddle_exit_code = error.code ?? error.signal ?? 'spawn_error';
        run.paddle_execution_error = error.message;
      }
    }

    const afterPaddle = await readJson(path.join(productionRoot, document.id, 'state.json'), {});
    const completedAfterPaddle = new Set((afterPaddle.completed_pages || []).map(Number));
    for (const page of paddlePages) {
      if (completedAfterPaddle.has(page) && await primaryPageValid(afterPaddle, document.id, page, true)) continue;
      const stateError = afterPaddle.failed_pages?.[String(page)]?.error || 'Paddle OCR did not produce complete page artifacts';
      const failure = { page, stage: 'paddle', code: 'PADDLE_PAGE_FAILED', name: 'PaddlePageError', message: stateError };
      await recordPageFailure(document.id, failure);
      run.page_failures.push(failure);
    }
    if (paddleExecutionError && interrupted) throw interruptedError();

    const auditDir = path.join(witnessRoot, document.id, 'audits');
    await mkdir(auditDir, { recursive: true });
    const auditablePages = [];
    for (const page of witness.successPages) {
      if (await primaryPageValid(afterPaddle, document.id, page, true)) auditablePages.push(page);
      else if (!run.page_failures.some((failure) => failure.page === page && failure.stage === 'paddle')) {
        const failure = { page, stage: 'paddle', code: 'PRIMARY_ARTIFACT_HASH_MISMATCH', name: 'PrimaryArtifactIntegrityError', message: 'Primary OCR page files do not match state hashes' };
        await recordPageFailure(document.id, failure);
        run.page_failures.push(failure);
      }
    }
    for (const page of auditablePages) {
      throwIfInterrupted();
      const auditName = `audit-${String(page).padStart(4, '0')}-${String(page).padStart(4, '0')}.json`;
      const auditPath = path.join(auditDir, auditName);
      try {
        await runLogged('node', [path.join(root, 'scripts/audit-ocr-witnesses.mjs'), path.join(productionRoot, document.id, 'pages'), witness.visionDir, auditPath, String(page), String(page)], path.join(logDir, 'audit.log'), run, 'witness_audit');
        await copyFile(auditPath, path.join(productionRoot, document.id, auditName));
        await clearPageFailures(document.id, page);
        run.audited_pages.push(page);
      } catch (error) {
        if (shutdownRequested) throw interruptedError();
        const failure = { page, stage: 'audit', code: 'WITNESS_AUDIT_FAILED', name: error.name, message: error.message };
        await recordPageFailure(document.id, failure);
        run.page_failures.push(failure);
      }
    }

    if (run.audited_pages.length) {
      throwIfInterrupted();
      const conceptRunDirectory = path.join(candidateRunsRoot, runId);
      await mkdir(conceptRunDirectory, { recursive: true });
      const conceptCandidateEnv = {
        CONCEPT_GRAPH_OUTPUT_PATH: path.join(conceptRunDirectory, 'concept-evolution.json'),
        CONCEPT_QUALITY_OUTPUT_PATH: path.join(conceptRunDirectory, 'concept-evolution-quality.json'),
      };
      try {
        await runLogged('node', [path.join(root, 'scripts/build-concept-evolution.mjs')], path.join(logDir, 'concept-build.log'), run, 'concept_graph_build', conceptCandidateEnv);
        await runLogged('node', [path.join(root, 'scripts/validate-concept-evolution.mjs')], path.join(logDir, 'concept-validate.log'), run, 'concept_graph_validate', conceptCandidateEnv);
        await promoteConceptCandidate(conceptRunDirectory);
      } catch (error) {
        if (shutdownRequested) throw interruptedError();
        error.scope = 'derived';
        error.code ||= 'CONCEPT_DERIVATION_FAILED';
        throw error;
      }
      if (mode === 'new_ocr' || mode === 'full_recovery') await atomicJson(cursorPath, { last_document_id: document.id, completed_at: nowIso(), pages: run.audited_pages });
      await clearFailure(document.id);
    }

    run.status = run.page_failures.length ? 'partial_failed' : 'completed';
    run.completed_at = nowIso();
    run.stage = run.page_failures.length ? 'complete_with_page_failures' : 'complete';
    await updateRun(run);
    await appendFile(historyPath, `${JSON.stringify({ ...run, preflight: { ...run.preflight, source_pdf_sha256: run.preflight.source_pdf_sha256 } })}\n`);
    console.log(JSON.stringify({ status: run.status, run_id: runId, mode, document_id: document.id, pages, audited_pages: run.audited_pages, page_failures: run.page_failures }));
    if (run.page_failures.length) process.exitCode = 10;
  } catch (error) {
    if (run) {
      run.status = interrupted ? 'interrupted' : 'failed';
      run.failed_at = nowIso();
      run.error_code = error.code || 'RUN_FAILED';
      run.error_scope = error.scope || 'run';
      run.error = `${error.name}: ${error.message}`.slice(0, 1000);
      await updateRun(run).catch(() => {});
      if (!interrupted && error.scope === 'document') await recordFailure(selected.document.id, error).catch(() => {});
      await appendFile(historyPath, `${JSON.stringify(run)}\n`).catch(() => {});
    }
    error.exitCode ||= interrupted ? 130 : 10;
    throw error;
  } finally {
    await stopOwnedServer(server);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (lockAcquired) await releaseLock(runId);
    await collectStatus().catch(() => {});
  }
}

async function drain() {
  shutdownRequested = false;
  const drainId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const stop = () => {
    shutdownRequested = true;
    if (activeStageChild?.exitCode === null) activeStageChild.kill('SIGTERM');
    if (activeOwnedLlamaChild?.exitCode === null) activeOwnedLlamaChild.kill('SIGTERM');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const state = {
    schema_version: 1,
    drain_id: drainId,
    pid: process.pid,
    batch_pages: batchPages,
    status: 'running',
    stage: 'starting',
    started_at: nowIso(),
    heartbeat_at: nowIso(),
  };
  const updateDrainState = async (changes = {}) => {
    Object.assign(state, changes, { heartbeat_at: nowIso() });
    await atomicJson(drainStatePath, state);
  };
  let drainLockAcquired = false;
  try {
    await acquireDrainLock(drainId);
    drainLockAcquired = true;
    activeOwnedDrainId = drainId;
    await updateDrainState();
    while (true) {
      await updateDrainState({ stage: 'acquiring_batch' });
      try {
        await once();
      } catch (error) {
        if (error.exitCode === 75) {
          const activeStatus = await collectStatus();
          await updateDrainState({
            stage: 'waiting_for_active_owner',
            queue: activeStatus.queue,
            health: activeStatus.health,
            disk: activeStatus.disk,
          });
          if (activeStatus.runtime.stalled) {
            throw Object.assign(new Error('Continuous drain found an active owner with a stale heartbeat'), {
              code: 'DRAIN_ACTIVE_OWNER_STALLED',
              exitCode: 11,
            });
          }
          if (activeStatus.disk.warning) {
            throw Object.assign(new Error(`Continuous drain stopped at the 50 GiB warning boundary: ${activeStatus.disk.free_gib} GiB free`), {
              code: 'DRAIN_DISK_WARNING',
              exitCode: 2,
            });
          }
          await interruptibleSleep(5000);
          continue;
        }
        throw error;
      }
      const status = await collectStatus();
      await updateDrainState({ stage: 'between_batches', queue: status.queue, health: status.health, disk: status.disk });
      console.log(JSON.stringify({
        status: 'drain_progress',
        generated_at: status.generated_at,
        queue: status.queue,
        health: status.health,
        disk: status.disk,
        next_batch: status.next_batch,
      }));
      const decision = continuousDrainDecision(status);
      if (decision.action === 'complete') {
        await updateDrainState({ status: 'completed', stage: 'complete', completed_at: nowIso() });
        console.log(JSON.stringify({ status: 'drain_complete', generated_at: status.generated_at, queue: status.queue }));
        return;
      }
      if (decision.action === 'stop') {
        throw Object.assign(new Error(`Continuous drain stopped: ${decision.reason}`), {
          code: decision.code,
          exitCode: decision.exitCode,
        });
      }
      await interruptibleSleep(1000);
    }
  } catch (error) {
    if (drainLockAcquired) {
      await updateDrainState({
        status: error.exitCode === 130 ? 'interrupted' : 'failed',
        stage: 'stopped',
        stopped_at: nowIso(),
        error_code: error.code || 'DRAIN_FAILED',
        error: error.message,
      }).catch(() => {});
    }
    throw error;
  } finally {
    if (drainLockAcquired) await releaseDrainLock(drainId).catch(() => {});
    if (activeOwnedDrainId === drainId) activeOwnedDrainId = null;
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mkdir(supervisorRoot, { recursive: true });
  try {
    if (command === 'status') {
      console.log(JSON.stringify(await collectStatus(), null, 2));
    } else if (command === 'check') {
      const status = await collectStatus();
      console.log(JSON.stringify({
        generated_at: status.generated_at,
        health: status.health,
        scheduler_state: status.scheduler_state,
        queue: status.queue,
        evidence: status.evidence,
        runtime: {
          lock_active: status.runtime.lock_active,
          stalled: status.runtime.stalled,
          current_run: status.runtime.current_run ? {
            run_id: status.runtime.current_run.run_id,
            status: status.runtime.current_run.status,
            stage: status.runtime.current_run.stage,
            document_id: status.runtime.current_run.document_id,
            pages: status.runtime.current_run.pages,
            heartbeat_at: status.runtime.current_run.heartbeat_at,
          } : null,
        },
      }, null, 2));
      process.exitCode = status.health.exit_code;
    } else if (command === 'once' || command === 'recover') {
      await once();
    } else if (command === 'drain') {
      await drain();
    } else {
      console.error(`usage: node scripts/ocr-supervisor.mjs <status|check|once|recover|drain> [--batch-pages 1-${maxBatchPages}] [--document ID] [--retry-failed]`);
      process.exitCode = 64;
    }
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: error.code || 'RUN_FAILED', message: error.message }));
    process.exitCode = error.exitCode || 1;
  }
}
