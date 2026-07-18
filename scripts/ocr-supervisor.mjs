#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, appendFile, copyFile, mkdir, open, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyHealth,
  continuousDrainDecision,
  missingCompletedWitnessPages,
  nextPageRetry,
  ocrExecutionPolicy,
  paddleLogIndicatesRuntimeFailure,
  paddleRuntimeFailure,
  pageRetryKey,
  retryBlocksPage,
  retriesForPage,
  selectPendingPages,
  visionWitnessPlan,
  visionWitnessProfileSha,
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
const watchdogStatePath = path.join(supervisorRoot, 'watchdog-state.json');
const watchdogControlPath = path.join(supervisorRoot, 'watchdog-control.json');
const candidateManifestPath = path.join(supervisorRoot, 'concept-candidate-manifest.json');
const candidateRunsRoot = path.join(supervisorRoot, 'concept-runs');
const llamaBinary = path.join(root, '.cache/tools/llama.cpp/build/bin/llama-server');
const llamaRepository = path.join(root, '.cache/tools/llama.cpp');
const modelPath = path.join(root, '.cache/ocr-runtime/PaddleOCR-VL-1.6-GGUF.gguf');
const mmprojPath = path.join(root, '.cache/ocr-runtime/PaddleOCR-VL-1.6-GGUF-mmproj.gguf');
const pythonPath = path.join(root, '.cache/venv-paddleocr/bin/python');
const visionLauncherPath = path.join(root, 'scripts/vision-ocr-launcher.mjs');
const rendererBinary = '/opt/homebrew/bin/mutool';
const expected = {
  llama_commit: '12127defda4f41b7679cb2477a4b0d65ee6a0c8f',
  model_sha256: 'f3ae46ec885050acf4b3d31944431e1fd90d50664fb09126af4a3c050ba14ee8',
  mmproj_sha256: '204d757d7610d9b3faab10d506d69e5b244e32bf765e2bab2d0167e65e0a058a',
  renderer_sha256: 'b7ee6e71e5453afd4d730bcc8ba38128a89a9b550f2e7dab8effacd46634e9c6',
};
const visionRenderDpi = 240;
const visionBatchLimits = Object.freeze({
  startupTimeoutMs: 180000,
  idleTimeoutMs: 300000,
  wallTimeoutMs: 3600000,
});
const visionPageRetryLimits = Object.freeze({
  startupTimeoutMs: 120000,
  idleTimeoutMs: 180000,
  wallTimeoutMs: 600000,
});
const visionPipeBufferLimitBytes = 8 * 1024 * 1024;
const maxBatchPages = 64;
const runtimeInteger = (name, fallback, minimum, maximum) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
};
const runtimeIntegerFromValue = (value, fallback, minimum, maximum) => {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
};
const llamaParallel = runtimeInteger('OCR_LLAMA_PARALLEL', 1, 1, 4);
const vlRecMaxConcurrency = runtimeInteger('OCR_VL_REC_MAX_CONCURRENCY', 1, 1, 8);
const conceptFingerprintFiles = Object.freeze({
  catalog_sha256: 'data/catalog.json',
  queue_sha256: 'data/ocr-queue.json',
  concept_model_sha256: 'data/concept-model-v2.json',
  lexicon_sha256: 'data/concept-lexicon.json',
  ontology_sha256: 'data/concept-ontology.json',
  builder_sha256: 'scripts/build-concept-evolution.mjs',
  graph_sharder_sha256: 'scripts/graph-shards.mjs',
  concept_publication_gate_sha256: 'scripts/concept-page-publication.mjs',
  page_publication_gate_sha256: 'scripts/page-publication-gate.mjs',
  semantic_publication_policy_sha256: 'data/semantic-publication-policy.json',
  semantic_publication_gate_sha256: 'scripts/semantic-publication-gate.mjs',
  compendium_item_boundaries_sha256: 'data/compendium-item-boundaries.json',
  compendium_item_boundary_gate_sha256: 'scripts/validate-compendium-item-boundaries.mjs',
  compendium_item_publication_gate_sha256: 'scripts/compendium-item-publication.mjs',
  online_verification_samples_sha256: 'data/online-verification-samples.json',
  corpus_manifest_gate_sha256: 'scripts/import-corpus.mjs',
  validator_sha256: 'scripts/validate-concept-evolution.mjs',
});
const conceptDerivedFingerprintFields = Object.freeze({
  corpus_manifest_sha256: 'manifest_sha256',
  corpus_release_fingerprint_sha256: 'release_fingerprint_sha256',
});
const conceptCoreArtifactProfile = 'curriculum-concept-evolution-core-index-v1';
const conceptQualityArtifactProfile = 'curriculum-concept-evolution-quality-v1';
const conceptAcademicSchema = 'curriculum-concept-evolution-academic-v2';
const conceptGraphTransport = 'immutable-content-addressed-graph-shards-v1';
const conceptGraphShardMaxBytes = 512 * 1024;

const [command = 'status', ...rawArgs] = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = rawArgs.indexOf(name);
  return index >= 0 && rawArgs[index + 1] ? rawArgs[index + 1] : fallback;
};
const options = (name) => rawArgs.flatMap((value, index) => value === name && rawArgs[index + 1]
  ? [rawArgs[index + 1]]
  : []);
const batchPages = Math.max(1, Math.min(maxBatchPages, Number(option('--batch-pages', String(maxBatchPages))) || maxBatchPages));
const requestedDocument = option('--document');
const requestedDocuments = [...new Set(options('--document'))];
const requestedManifest = option('--manifest');
const retryFailed = rawArgs.includes('--retry-failed');
const forceImmediateRecovery = rawArgs.includes('--force-immediate');
const recoveryMode = command === 'recover';
const evidenceOnlyModes = new Set(['witness_backfill', 'audit_backfill']);
const evidenceRetryStages = new Set(['vision', 'vision_render', 'audit']);
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

export async function discardVisionOutputs(sidecarPath) {
  const textPath = sidecarPath.replace(/\.json$/i, '.txt');
  await Promise.all([
    rm(sidecarPath, { force: true }),
    rm(textPath, { force: true }),
  ]);
}

export async function readFreshVisionOutput(sidecarPath, expected = {}) {
  const [record, sidecarInfo] = await Promise.all([
    readJson(sidecarPath, null),
    stat(sidecarPath).catch(() => null),
  ]);
  if (!sidecarInfo?.isFile() || !record || record.error || !Array.isArray(record.lines)) return null;
  if (Number.isFinite(expected.notBeforeMs) && sidecarInfo.mtimeMs + 1000 < expected.notBeforeMs) return null;
  if (expected.file && record.file !== expected.file) return null;
  if (record.document_id != null && expected.documentId && record.document_id !== expected.documentId) return null;
  if (record.physical_pdf_page != null && expected.page && Number(record.physical_pdf_page) !== Number(expected.page)) return null;
  if (record.source_pdf_sha256 != null && expected.pdfSha && record.source_pdf_sha256 !== expected.pdfSha) return null;
  if (record.rendered_image_sha256 != null && expected.imageSha && record.rendered_image_sha256 !== expected.imageSha) return null;
  return record;
}

export function visionInvocationArgs({
  outputDir,
  languages,
  imagePaths,
  scriptPath = path.join(root, 'scripts/vision-ocr-batch.swift'),
}) {
  if (typeof outputDir !== 'string' || !outputDir
    || !Array.isArray(languages) || languages.length === 0
    || languages.some((language) => typeof language !== 'string' || !language)
    || !Array.isArray(imagePaths) || imagePaths.length === 0
    || imagePaths.some((imagePath) => typeof imagePath !== 'string' || path.extname(imagePath).toLowerCase() !== '.png')) {
    throw Object.assign(new Error('Apple Vision invocation requires an output directory, languages, and PNG image paths'), {
      code: 'VISION_INVOCATION_INVALID',
    });
  }
  return [scriptPath, '--output-dir', outputDir, '--languages', languages.join(','), ...imagePaths];
}

export function visionLauncherInvocationArgs({
  outputDir,
  languages,
  imagePaths,
  launcherPath = visionLauncherPath,
  bufferLimitBytes = visionPipeBufferLimitBytes,
}) {
  const swiftArguments = visionInvocationArgs({ outputDir, languages, imagePaths });
  return [
    launcherPath,
    '--buffer-limit-bytes',
    String(bufferLimitBytes),
    '--',
    ...swiftArguments.slice(1),
  ];
}

export function buildVisionWitnessSidecar({
  document,
  page,
  pdfSha,
  imageSha,
  imageInfo,
  profile,
  passResults,
  provenance,
  generatedAt = nowIso(),
}) {
  const byPass = new Map((passResults || []).map((result) => [result.pass_id, result]));
  const witnessPasses = profile.passes.map((pass) => {
    const result = byPass.get(pass.pass_id);
    if (!result?.record || result.record.error || !Array.isArray(result.record.lines)
      || !/^[a-f0-9]{64}$/i.test(String(result.raw_sidecar_sha256 || ''))
      || !/^[a-f0-9]{64}$/i.test(String(result.raw_text_sha256 || ''))) {
      throw Object.assign(new Error(`Required Apple Vision pass is missing or invalid: ${pass.pass_id}`), {
        code: 'VISION_REQUIRED_PASS_MISSING',
        pass_id: pass.pass_id,
      });
    }
    return {
      pass_id: pass.pass_id,
      role: pass.role,
      languages: [...pass.languages],
      lines: result.record.lines,
      raw_sidecar_file: result.raw_sidecar_file,
      raw_sidecar_sha256: result.raw_sidecar_sha256,
      raw_text_file: result.raw_text_file,
      raw_text_sha256: result.raw_text_sha256,
      attempt_count: result.attempt_count,
      recovered_after_retry: result.attempt_count > 1,
    };
  });
  const canonical = witnessPasses.find((pass) => pass.pass_id === profile.canonical_pass_id);
  if (!canonical) {
    throw Object.assign(new Error(`Canonical Apple Vision pass is missing: ${profile.canonical_pass_id}`), {
      code: 'VISION_CANONICAL_PASS_MISSING',
    });
  }
  return {
    schema_version: 3,
    file: `page-${String(page).padStart(3, '0')}.png`,
    lines: canonical.lines,
    document_id: document.id,
    physical_pdf_page: page,
    source_pdf_sha256: pdfSha,
    rendered_image_sha256: imageSha,
    rendered_image_bytes: imageInfo.size,
    rendered_image_mtime_ms: Math.trunc(imageInfo.mtimeMs),
    generated_at: generatedAt,
    attempt_count: Math.max(...witnessPasses.map((pass) => pass.attempt_count)),
    recovered_after_retry: witnessPasses.some((pass) => pass.recovered_after_retry),
    engine: 'Apple Vision VNRecognizeTextRequest accurate language-profile-v1',
    engine_configuration: {
      recognition_level: 'accurate',
      languages: [...canonical.languages],
      language_passes: profile.passes,
      language_correction: true,
      minimum_text_height: 0.008,
      render_dpi: visionRenderDpi,
      renderer: 'MuPDF mutool 1.28.0',
    },
    engine_provenance: provenance,
    witness_profile: profile,
    witness_profile_sha256: visionWitnessProfileSha(profile),
    line_source_pass_id: profile.canonical_pass_id,
    witness_passes: witnessPasses,
    critical_fields: [],
    citation_allowed: false,
  };
}

export function classifyPaddleExitOne({ exitCode, logText = '', pages = [], beforeState = {}, afterState = {} }) {
  const beforeCompleted = new Set((beforeState.completed_pages || []).map(Number));
  const afterCompleted = new Set((afterState.completed_pages || []).map(Number));
  const newlyCompletedPages = [];
  const structuredFailurePages = [];
  for (const page of pages.map(Number)) {
    const key = String(page);
    const beforeFailure = beforeState.failed_pages?.[key] ?? null;
    const afterFailure = afterState.failed_pages?.[key] ?? null;
    if (!beforeCompleted.has(page) && afterCompleted.has(page) && primaryStateHashesValid(afterState, page)) {
      newlyCompletedPages.push(page);
    }
    if (afterFailure && JSON.stringify(beforeFailure) !== JSON.stringify(afterFailure)) structuredFailurePages.push(page);
  }
  const pageProgressObserved = newlyCompletedPages.length > 0 || structuredFailurePages.length > 0;
  return {
    runtimeFailure: exitCode === 1 && (paddleLogIndicatesRuntimeFailure(logText) || !pageProgressObserved),
    pageProgressObserved,
    newlyCompletedPages,
    structuredFailurePages,
  };
}

export function retryReconcileBusyReasons(status, ownerPid = process.pid) {
  const runtime = status?.runtime || {};
  const reasons = [];
  if (runtime.lock_active && runtime.lock_owner?.pid !== ownerPid) reasons.push('batch_owner_active');
  if (runtime.drain_active) reasons.push('drain_owner_active');
  if (runtime.watchdog_child_active) reasons.push('watchdog_child_active');
  return reasons;
}

function fingerprintsMatch(left, right) {
  if (!left || !right) return false;
  return [...Object.keys(conceptFingerprintFiles), ...Object.keys(conceptDerivedFingerprintFields)]
    .every((key) => /^[a-f0-9]{64}$/i.test(String(left[key] || '')) && left[key] === right[key]);
}

export function conceptCandidateCompatible({ graph, quality, manifest, currentFingerprints }) {
  if (!graph || !quality || !manifest || quality.passed !== true) return false;
  const revision = graph.build_revision;
  if (!/^[a-f0-9]{64}$/i.test(String(revision || ''))
    || quality.build_revision !== revision
    || manifest.build_revision !== revision) return false;
  if (graph.schema_version !== 1
    || quality.schema_version !== 1
    || manifest.schema_version !== 3
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
  const shardManifest = graph.shard_manifest;
  const shardAssets = shardManifest?.assets;
  if (graph.transport_profile !== conceptGraphTransport
    || shardManifest?.transport_profile !== conceptGraphTransport
    || shardManifest?.build_revision !== revision
    || shardManifest?.max_shard_bytes !== conceptGraphShardMaxBytes
    || !Array.isArray(shardAssets)
    || shardAssets.length < 1
    || shardAssets.some((asset) => asset?.build_revision !== revision
      || !String(asset?.path || '').startsWith('/data/graph-shards/')
      || !/^[a-f0-9]{64}$/i.test(String(asset?.sha256 || ''))
      || !Number.isInteger(asset?.bytes)
      || asset.bytes < 1
      || asset.bytes > conceptGraphShardMaxBytes)
    || quality.graph_transport?.profile !== conceptGraphTransport
    || quality.graph_transport?.max_shard_bytes !== conceptGraphShardMaxBytes
    || quality.graph_transport?.shard_count !== shardAssets.length
    || manifest.transport_profile !== conceptGraphTransport
    || manifest.graph_shard_max_bytes !== conceptGraphShardMaxBytes
    || manifest.graph_shard_count !== shardAssets.length
    || manifest.graph_shard_descriptors_sha256 !== createHash('sha256').update(JSON.stringify(shardAssets)).digest('hex')) return false;
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
  const fingerprints = Object.fromEntries(await Promise.all(Object.entries(conceptFingerprintFiles)
    .map(async ([key, relativePath]) => [key, await sha256File(path.join(projectRoot, relativePath))])));
  const corpusManifest = await readJson(path.join(projectRoot, 'data/corpus-chunks/manifest.json'), null);
  for (const [key, field] of Object.entries(conceptDerivedFingerprintFields)) {
    if (!/^[a-f0-9]{64}$/i.test(String(corpusManifest?.[field] || ''))) {
      throw new Error(`Corpus manifest is missing ${key}`);
    }
    fingerprints[key] = corpusManifest[field];
  }
  return fingerprints;
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

export function validateEvidenceManifestScope(manifest, queueDocuments = queue.documents) {
  if (!manifest || manifest.schema_version !== 1
    || manifest.manifest_type !== 'curriculum_remote_whole_document_ocr_offload_plan'
    || !Array.isArray(manifest.documents)
    || manifest.documents.length === 0) {
    throw Object.assign(new Error('Evidence backfill manifest must be a non-empty remote whole-document OCR plan'), {
      code: 'EVIDENCE_MANIFEST_INVALID',
      exitCode: 64,
    });
  }
  const queueById = new Map(queueDocuments.map((document) => [document.id, document]));
  const seen = new Set();
  const documents = [];
  for (const scoped of manifest.documents) {
    const document = queueById.get(scoped?.id);
    if (!document || seen.has(scoped.id)
      || scoped.page_count !== document.page_count
      || scoped.source_sha256 !== document.source_sha256
      || scoped.citation_allowed !== false) {
      throw Object.assign(new Error(`Evidence backfill manifest document identity is invalid: ${scoped?.id || '<missing>'}`), {
        code: 'EVIDENCE_MANIFEST_DOCUMENT_INVALID',
        exitCode: 64,
      });
    }
    seen.add(scoped.id);
    documents.push(document);
  }
  if (Number.isInteger(manifest.counts?.selected_documents)
    && manifest.counts.selected_documents !== documents.length) {
    throw Object.assign(new Error('Evidence backfill manifest selected document count does not match its document list'), {
      code: 'EVIDENCE_MANIFEST_COUNT_MISMATCH',
      exitCode: 64,
    });
  }
  return documents;
}

async function loadEvidenceScope() {
  if (!requestedManifest && requestedDocuments.length === 0) {
    throw Object.assign(new Error('backfill-evidence requires --manifest PATH or at least one --document ID'), {
      code: 'EVIDENCE_SCOPE_REQUIRED',
      exitCode: 64,
    });
  }
  let documents = queue.documents;
  let manifestPath = null;
  let manifestSha256 = null;
  if (requestedManifest) {
    manifestPath = path.resolve(requestedManifest);
    const manifest = await readJson(manifestPath, null);
    documents = validateEvidenceManifestScope(manifest);
    manifestSha256 = await sha256File(manifestPath);
  }
  if (requestedDocuments.length) {
    const byId = new Map(documents.map((document) => [document.id, document]));
    const selected = [];
    for (const id of requestedDocuments) {
      const document = byId.get(id);
      if (!document) {
        throw Object.assign(new Error(`Evidence backfill document is outside the selected scope: ${id}`), {
          code: 'EVIDENCE_DOCUMENT_OUT_OF_SCOPE',
          exitCode: 64,
        });
      }
      selected.push(document);
    }
    documents = selected;
  }
  return {
    documents,
    document_ids: documents.map((document) => document.id),
    manifest_path: manifestPath ? path.relative(root, manifestPath) : null,
    manifest_sha256: manifestSha256,
  };
}

export function evidenceExecutionPolicy(mode) {
  if (!evidenceOnlyModes.has(mode)) {
    throw Object.assign(new Error(`Evidence-only execution refuses OCR mode: ${mode || '<none>'}`), {
      code: 'EVIDENCE_PRIMARY_WORK_REQUIRED',
      exitCode: 12,
      mode,
    });
  }
  return {
    renderVision: mode === 'witness_backfill',
    runPrimaryOcr: false,
    buildDerivedArtifacts: false,
  };
}

export function evidenceDrainDecision({
  selection = null,
  freeGiB = Number.POSITIVE_INFINITY,
  interrupted = false,
  pageFailures = [],
} = {}) {
  if (interrupted) return { action: 'stop', status: 'interrupted', code: 'RUN_INTERRUPTED', exitCode: 130 };
  if (freeGiB < 50) return { action: 'stop', status: 'blocked', code: 'EVIDENCE_DISK_WARNING', exitCode: 2 };
  if (pageFailures.length) {
    const systematicVisionFailure = selection?.mode === 'witness_backfill'
      && pageFailures.length === selection.pages?.length
      && pageFailures.every((failure) => failure.stage === 'vision' || failure.stage === 'vision_render');
    return {
      action: 'stop',
      status: 'failed',
      code: systematicVisionFailure ? 'EVIDENCE_VISION_BATCH_FAILED' : 'EVIDENCE_PAGE_FAILED',
      exitCode: 10,
      systematic_vision_failure: systematicVisionFailure,
    };
  }
  if (!selection) return { action: 'complete', status: 'completed', code: 'EVIDENCE_SCOPE_COMPLETE', exitCode: 0 };
  if (!evidenceOnlyModes.has(selection.mode)) {
    return {
      action: 'stop',
      status: 'blocked',
      code: selection.mode === 'evidence_blocked' ? 'EVIDENCE_RETRY_BLOCKED' : 'EVIDENCE_PRIMARY_WORK_REQUIRED',
      exitCode: selection.mode === 'evidence_blocked' ? 10 : 12,
      blocked_mode: selection.mode,
    };
  }
  return { action: 'continue', status: 'ready', code: 'EVIDENCE_BATCH_READY', exitCode: 0 };
}

function scopedPageRetryRecords(records, documentId, page) {
  const prefix = `${documentId}:${Number(page)}:`;
  return Object.entries(records || {})
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, record]) => ({ key, stage: key.slice(prefix.length), record }));
}

function evidenceRetryBlocksPage(records, documentId, page, now = Date.now(), override = false) {
  if (override) return false;
  return scopedPageRetryRecords(records, documentId, page)
    .filter(({ stage }) => evidenceRetryStages.has(stage))
    .some(({ record }) => record?.quarantined
      || (record?.next_retry_at && Date.parse(record.next_retry_at) > now));
}

export async function inspectEvidenceScopePrimaryReadiness(documents, {
  primaryRoot = productionRoot,
  pageRetryRecords = {},
  deep = true,
} = {}) {
  for (const document of documents) {
    const state = await readJson(path.join(primaryRoot, document.id, 'state.json'), {});
    const completed = [...new Set((state.completed_pages || []).map(Number))]
      .filter((page) => Number.isInteger(page) && page >= 1 && page <= document.page_count)
      .sort((left, right) => left - right);
    if (completed.length !== document.page_count
      || completed.some((page, index) => page !== index + 1)) {
      const completedSet = new Set(completed);
      const firstMissing = Array.from({ length: document.page_count }, (_, index) => index + 1)
        .find((page) => !completedSet.has(page));
      return { document, pages: firstMissing ? [firstMissing] : [], state, mode: 'new_ocr', reason: 'scope_document_not_complete' };
    }
    if (Object.keys(state.failed_pages || {}).length) {
      return {
        document,
        pages: Object.keys(state.failed_pages).map(Number).filter(Number.isInteger).slice(0, 1),
        state,
        mode: 'full_recovery',
        reason: 'scope_document_has_failed_pages',
      };
    }
    const nonEvidenceRetry = Object.entries(pageRetryRecords || {}).find(([key, record]) => {
      const match = key.match(/^(.+):(\d+):([^:]+)$/);
      return match?.[1] === document.id
        && !evidenceRetryStages.has(match[3])
        && (record?.quarantined || record?.next_retry_at || Number(record?.attempts || 0) > 0);
    });
    if (nonEvidenceRetry) {
      return {
        document,
        pages: [Number(nonEvidenceRetry[0].match(/^.+:(\d+):[^:]+$/)?.[1])].filter(Number.isInteger),
        state,
        mode: 'primary_recovery',
        reason: 'scope_document_has_primary_retry',
      };
    }
    for (const page of completed) {
      if (!(await primaryPageValid(state, document.id, page, deep, primaryRoot))) {
        return { document, pages: [page], state, mode: 'primary_recovery', reason: 'completed_primary_artifact_invalid' };
      }
    }
  }
  return null;
}

export async function selectEvidenceBatch(documents, {
  limit = batchPages,
  primaryRoot = productionRoot,
  witnessBaseRoot = witnessRoot,
  pageRetryRecords = {},
  now = Date.now(),
  retryOverride = false,
  verifyPrimary = true,
} = {}) {
  if (verifyPrimary) {
    const unsafe = await inspectEvidenceScopePrimaryReadiness(documents, {
      primaryRoot,
      pageRetryRecords,
      deep: true,
    });
    if (unsafe) return unsafe;
  }
  for (const document of documents) {
    const state = await readJson(path.join(primaryRoot, document.id, 'state.json'), {});
    const completedPages = [...new Set((state.completed_pages || []).map(Number))]
      .filter((page) => Number.isInteger(page) && page >= 1 && page <= document.page_count)
      .sort((left, right) => left - right);
    const missingWitness = [];
    const visionDir = path.join(witnessBaseRoot, document.id, 'vision');
    for (const page of completedPages) {
      const sidecar = path.join(visionDir, `page-${String(page).padStart(3, '0')}.json`);
      if (await validWitnessSidecar(sidecar, await witnessIdentity(document, page, witnessBaseRoot))) continue;
      if (evidenceRetryBlocksPage(pageRetryRecords, document.id, page, now, retryOverride)) {
        return { document, pages: [page], state, mode: 'evidence_blocked', reason: 'witness_retry_blocked' };
      }
      if (!(await primaryPageValid(state, document.id, page, true, primaryRoot))) {
        return { document, pages: [page], state, mode: 'primary_recovery', reason: 'witness_candidate_primary_invalid' };
      }
      missingWitness.push(page);
      if (missingWitness.length >= limit) break;
    }
    if (missingWitness.length) return { document, pages: missingWitness, state, mode: 'witness_backfill' };
    const auditBackfill = [];
    for (const page of completedPages) {
      const audit = await inspectAuditPage(document, state, page, { primaryRoot, witnessBaseRoot });
      if (audit.current) continue;
      if (evidenceRetryBlocksPage(pageRetryRecords, document.id, page, now, retryOverride)) {
        return { document, pages: [page], state, mode: 'evidence_blocked', reason: 'audit_retry_blocked' };
      }
      const inputs = await readAuditInputs(document, state, page, { primaryRoot, witnessBaseRoot });
      if (!inputs.valid) {
        return {
          document,
          pages: [page],
          state,
          mode: inputs.reason === 'primary' ? 'primary_recovery' : 'witness_backfill',
          reason: `audit_input_${inputs.reason}_invalid`,
        };
      }
      auditBackfill.push(page);
      if (auditBackfill.length >= limit) break;
    }
    if (auditBackfill.length) return { document, pages: auditBackfill, state, mode: 'audit_backfill' };
  }
  return null;
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
    activeStageChild = child;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1000, options.timeoutMs) : 180000;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 5000);
    }, timeoutMs);
    const heartbeat = typeof options.heartbeat === 'function'
      ? setInterval(() => Promise.resolve(options.heartbeat()).catch(() => {}), 30000)
      : null;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (heartbeat) clearInterval(heartbeat);
      if (activeStageChild === child) activeStageChild = null;
      callback();
    };
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('exit', (code, signal) => finish(() => {
      if (timedOut) {
        reject(Object.assign(new Error(`${executable} exceeded ${timeoutMs} ms`), { code: 'CAPTURE_TIMEOUT', exitCode: 10 }));
      } else if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${executable} exited ${code ?? signal}: ${stderr.slice(-1200)}`));
      }
    }));
  });
}

async function collectVisionEngineProvenance() {
  const scriptPath = path.join(root, 'scripts/vision-ocr-batch.swift');
  try {
    const [scriptSha, launcherSha] = await Promise.all([
      sha256File(scriptPath),
      sha256File(visionLauncherPath),
    ]);
    const swift = await runCapture(process.execPath, [visionLauncherPath, '--probe-version'], { timeoutMs: 30000 });
    const productName = await runCapture('/usr/bin/sw_vers', ['-productName'], { timeoutMs: 30000 });
    const productVersion = await runCapture('/usr/bin/sw_vers', ['-productVersion'], { timeoutMs: 30000 });
    const buildVersion = await runCapture('/usr/bin/sw_vers', ['-buildVersion'], { timeoutMs: 30000 });
    return {
      schema_version: 1,
      framework: 'Apple Vision',
      request_api: 'VNRecognizeTextRequest',
      framework_distribution: 'macOS bundled',
      execution_binary: '/usr/bin/swift',
      swift_version: `${swift.stdout}\n${swift.stderr}`.trim().split('\n')[0],
      script_path: 'scripts/vision-ocr-batch.swift',
      script_sha256: scriptSha,
      launcher: {
        schema_version: 1,
        path: 'scripts/vision-ocr-launcher.mjs',
        sha256: launcherSha,
        node_binary: process.execPath,
        child_binary: '/usr/bin/swift',
        buffer_limit_bytes: visionPipeBufferLimitBytes,
      },
      renderer: {
        name: 'MuPDF mutool 1.28.0',
        binary: rendererBinary,
        sha256: expected.renderer_sha256,
      },
      os: {
        product_name: productName.stdout.trim(),
        product_version: productVersion.stdout.trim(),
        build_version: buildVersion.stdout.trim(),
        platform: process.platform,
        architecture: process.arch,
        kernel_type: os.type(),
        kernel_release: os.release(),
        kernel_version: os.version(),
      },
    };
  } catch (error) {
    throw Object.assign(error, {
      code: 'VISION_PROVENANCE_FAILED',
      scope: 'runtime',
      exitCode: 10,
    });
  }
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
  const witnessProfile = visionWitnessPlan(document);
  return {
    documentId: document.id,
    page,
    pdfSha: document.source_sha256,
    file: `page-${String(page).padStart(3, '0')}.png`,
    imagePath: path.join(baseRoot, document.id, 'images', `page-${String(page).padStart(3, '0')}.png`),
    witnessProfile,
    witnessProfileSha: visionWitnessProfileSha(witnessProfile),
    allowLegacyDefault: witnessProfile.profile_id === 'apple-vision-default-v1',
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
  const [audit, review, disk, graph, next, owner, current, drainOwner, drainState, watchdogState, watchdogControl] = await Promise.all([
    collectAuditMetrics(), collectReviewMetrics(), statfs(root), readConceptGraph(), nextBatch(),
    readJson(path.join(lockDir, 'owner.json'), null), readJson(currentRunPath, null),
    readJson(path.join(drainLockDir, 'owner.json'), null), readJson(drainStatePath, null),
    readJson(watchdogStatePath, null), readJson(watchdogControlPath, null),
  ]);
  const freeGiB = Number(disk.bavail * disk.bsize) / 1024 ** 3;
  const currentHeartbeatAge = current?.heartbeat_at ? (Date.now() - Date.parse(current.heartbeat_at)) / 60000 : null;
  const drainHeartbeatAge = drainState?.heartbeat_at ? (Date.now() - Date.parse(drainState.heartbeat_at)) / 60000 : null;
  const lockActive = Boolean(owner && await processAlive(owner.pid));
  const drainActive = Boolean(drainOwner && await processAlive(drainOwner.pid));
  const watchdogActive = Boolean(watchdogState?.watchdog_pid && await processAlive(watchdogState.watchdog_pid));
  const watchdogChildActive = Boolean(watchdogActive && watchdogState?.child_pid && await processAlive(watchdogState.child_pid));
  const watchdogOwnsDrain = watchdogActive && drainActive && watchdogState?.child_pid === drainOwner.pid;
  const activeRuntimePolicy = current?.runtime_policy || drainState?.runtime_policy || (watchdogOwnsDrain ? {
    llama_parallel: runtimeIntegerFromValue(watchdogControl?.llama_parallel, 3, 1, 4),
    llama_context_per_slot: 8192,
    vl_rec_max_concurrency: runtimeIntegerFromValue(watchdogControl?.vl_rec_max_concurrency, 3, 1, 8),
    source: 'watchdog_control',
  } : null);
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
    policy: { batch_pages: batchPages, max_batch_pages: maxBatchPages, vision_render_dpi: visionRenderDpi, vision_renderer: 'MuPDF mutool 1.28.0 pinned by SHA-256', vision_render_settle_seconds: 1.5, vision_immediate_retries_seconds: [2, 10, 30], page_retry_quarantine_after: 5, disk_warning_gib: 50, disk_hard_stop_gib: 25, stall_minutes: 20, llama_parallel: activeRuntimePolicy?.llama_parallel ?? llamaParallel, llama_context_per_slot: activeRuntimePolicy?.llama_context_per_slot ?? 8192, vl_rec_max_concurrency: activeRuntimePolicy?.vl_rec_max_concurrency ?? vlRecMaxConcurrency, runtime_policy_source: activeRuntimePolicy?.source || (current?.runtime_policy ? 'current_run' : drainState?.runtime_policy ? 'drain_state' : 'process_environment'), candidates_never_citation_eligible: true, automatic_deploy: false },
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
      watchdog_active: watchdogActive,
      watchdog_child_active: watchdogChildActive,
      watchdog_child_pid: watchdogChildActive ? watchdogState.child_pid : null,
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
    '--ctx-size', String(8192 * llamaParallel), '--n-gpu-layers', 'all', '--parallel', String(llamaParallel), '--timeout', '3600', '--no-webui', '--metrics',
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

function loggedChildStdio(logHandle, pipeOutput) {
  if (pipeOutput) return ['ignore', 'pipe', 'pipe'];
  if (!logHandle || !Number.isInteger(logHandle.fd)) {
    throw Object.assign(new Error('spawnLoggedProcess requires an open log file handle'), {
      code: 'LOG_HANDLE_REQUIRED',
    });
  }
  return ['ignore', logHandle.fd, logHandle.fd];
}

function attachLoggedChildOutput(child, pipeOutput, {
  bufferLimitBytes = visionPipeBufferLimitBytes,
  stage = 'child_process',
  logPath = null,
  openLog = open,
} = {}) {
  let outputEnded = Promise.resolve();
  let bufferedBytes = 0;
  let bufferedChunks = [];
  let captureError = null;
  let overflowKillTimer = null;
  if (pipeOutput) {
    if (!Number.isInteger(bufferLimitBytes) || bufferLimitBytes < 1) {
      throw Object.assign(new Error('Pipe output buffer limit must be a positive integer'), {
        code: 'CHILD_OUTPUT_BUFFER_LIMIT_INVALID',
        exitCode: 64,
        stage,
      });
    }
    const stopOverflowingChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      overflowKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 5000);
    };
    const buffer = (chunk) => {
      if (captureError) return;
      const value = Buffer.from(chunk);
      const remaining = bufferLimitBytes - bufferedBytes;
      if (value.length <= remaining) {
        bufferedChunks.push(value);
        bufferedBytes += value.length;
        return;
      }
      if (remaining > 0) {
        bufferedChunks.push(value.subarray(0, remaining));
        bufferedBytes += remaining;
      }
      captureError = Object.assign(new Error(`${stage} output exceeded the ${bufferLimitBytes}-byte in-memory capture limit`), {
        code: 'CHILD_OUTPUT_BUFFER_LIMIT',
        exitCode: 10,
        stage,
        buffer_limit_bytes: bufferLimitBytes,
      });
      stopOverflowingChild();
    };
    child.stdout.on('data', buffer);
    child.stderr.on('data', buffer);
    const finished = (stream) => new Promise((resolve) => {
      if (stream.readableEnded || stream.destroyed) {
        resolve();
        return;
      }
      const done = () => {
        stream.removeListener('end', done);
        stream.removeListener('close', done);
        stream.removeListener('error', done);
        resolve();
      };
      stream.once('end', done);
      stream.once('close', done);
      stream.once('error', done);
    });
    outputEnded = Promise.all([finished(child.stdout), finished(child.stderr)]);
  }
  return {
    bufferedBytes: () => bufferedBytes,
    captureError: () => captureError,
    flush: async () => {
      await outputEnded;
      if (overflowKillTimer) clearTimeout(overflowKillTimer);
      if (pipeOutput) {
        if (typeof logPath !== 'string' || !logPath) {
          throw Object.assign(new Error('Pipe output capture requires a lazy log path'), {
            code: 'LAZY_LOG_PATH_REQUIRED',
            exitCode: 64,
            stage,
          });
        }
        const marker = captureError
          ? Buffer.from(`\n[${captureError.code}: ${captureError.message}]\n`)
          : Buffer.alloc(0);
        if (bufferedBytes || marker.length) {
          const lazyLog = await openLog(logPath, 'a');
          try {
            await lazyLog.write(Buffer.concat([...bufferedChunks, marker], bufferedBytes + marker.length));
          } finally {
            await lazyLog.close().catch(() => {});
          }
        }
        bufferedChunks = [];
      }
      if (captureError) throw captureError;
    },
  };
}

export function spawnLoggedProcess(executable, args, {
  cwd = root,
  env = process.env,
  logHandle,
  logPath,
  openLog = open,
  pipeOutput = false,
  pipeBufferLimitBytes = visionPipeBufferLimitBytes,
  spawnImplementation = spawn,
} = {}) {
  const child = spawnImplementation(executable, args, {
    cwd,
    env,
    stdio: loggedChildStdio(logHandle, pipeOutput),
  });
  const capture = attachLoggedChildOutput(child, pipeOutput, {
    bufferLimitBytes: pipeBufferLimitBytes,
    stage: path.basename(executable),
    logPath,
    openLog,
  });
  return {
    child,
    pipeOutput,
    bufferedBytes: capture.bufferedBytes,
    captureError: capture.captureError,
    flushOutput: capture.flush,
  };
}

async function runLogged(executable, args, logPath, run, stage, env = {}, acceptedExitCodes = [0], limits = {}) {
  throwIfInterrupted();
  run.stage = stage;
  await updateRun(run);
  let timedOutError = null;
  const pipeOutput = limits.pipeOutput === true;
  const log = pipeOutput ? null : await open(logPath, 'a');
  const child = spawn(executable, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: loggedChildStdio(log, pipeOutput),
  });
  const outputCapture = attachLoggedChildOutput(child, pipeOutput, {
    bufferLimitBytes: limits.pipeBufferLimitBytes ?? visionPipeBufferLimitBytes,
    stage,
    logPath,
  });
  const exitPromise = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('exit', (code, signal) => resolve(timedOutError
      ? { error: timedOutError }
      : acceptedExitCodes.includes(code)
        ? { result: { code, signal } }
        : { error: Object.assign(new Error(`${stage} exited ${code ?? signal}`), { stage, code, signal }) }));
  });
  activeStageChild = child;
  run.active_child_pid = child.pid || null;
  await updateRun(run);
  const heartbeat = setInterval(() => updateRun(run).catch(() => {}), 30000);
  const watchPaths = [logPath, ...(limits.activityPaths || [])];
  const activitySignature = async () => Promise.all(watchPaths.map(async (target) => {
    const value = await stat(target).catch(() => null);
    return value ? `${target}:${value.size}:${value.mtimeMs}` : `${target}:missing`;
  })).then((parts) => parts.join('|'));
  let signature = await activitySignature();
  let lastActivityAt = Date.now();
  let activityObserved = false;
  let killTimer = null;
  const startedAt = Date.now();
  const startupTimeoutMs = Number.isFinite(limits.startupTimeoutMs) ? Math.max(30000, limits.startupTimeoutMs) : null;
  const idleTimeoutMs = Number.isFinite(limits.idleTimeoutMs) ? Math.max(60000, limits.idleTimeoutMs) : null;
  const wallTimeoutMs = Number.isFinite(limits.wallTimeoutMs) ? Math.max(60000, limits.wallTimeoutMs) : null;
  const activityMonitor = startupTimeoutMs || idleTimeoutMs || wallTimeoutMs ? setInterval(async () => {
    if (timedOutError || child.exitCode !== null) return;
    const now = Date.now();
    const nextSignature = await activitySignature();
    if (nextSignature !== signature) {
      signature = nextSignature;
      lastActivityAt = now;
      activityObserved = true;
    }
    const timeoutKind = wallTimeoutMs && now - startedAt > wallTimeoutMs ? 'wall'
      : !activityObserved && startupTimeoutMs && now - startedAt > startupTimeoutMs ? 'startup'
        : activityObserved && idleTimeoutMs && now - lastActivityAt > idleTimeoutMs ? 'idle'
          : null;
    if (!timeoutKind) return;
    timedOutError = Object.assign(new Error(`${stage} ${timeoutKind} timeout`), {
      code: `${stage.toUpperCase()}_${timeoutKind.toUpperCase()}_TIMEOUT`, exitCode: 10, stage,
    });
    if (child.exitCode === null) child.kill('SIGTERM');
    killTimer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5000);
  }, 5000) : null;
  const outcome = await exitPromise;
  let outputCaptureError = null;
  try {
    await outputCapture.flush();
  } catch (error) {
    outputCaptureError = error;
  } finally {
    clearInterval(heartbeat);
    if (activityMonitor) clearInterval(activityMonitor);
    if (killTimer) clearTimeout(killTimer);
    if (activeStageChild === child) activeStageChild = null;
    run.active_child_pid = null;
    await log?.close().catch(() => {});
  }
  if (outputCaptureError) throw outputCaptureError;
  if (outcome.error) throw outcome.error;
  const result = outcome.result;
  await updateRun(run);
  throwIfInterrupted();
  return result;
}

async function renderVision(document, pages, pdfSha, logPath, run) {
  throwIfInterrupted();
  const base = path.join(witnessRoot, document.id);
  const imageDir = path.join(base, 'images');
  const visionDir = path.join(base, 'vision');
  const passRoot = path.join(base, 'vision-passes');
  const profile = visionWitnessPlan(document);
  await Promise.all([
    mkdir(imageDir, { recursive: true }),
    mkdir(visionDir, { recursive: true }),
    mkdir(passRoot, { recursive: true }),
  ]);
  const rendered = [];
  const successPages = [];
  const failures = [];
  run.stage = 'render_and_independent_vision';
  await updateRun(run);
  for (const page of pages) {
    throwIfInterrupted();
    const stem = `page-${String(page).padStart(3, '0')}`;
    const imagePath = path.join(imageDir, `${stem}.png`);
    const sidecarPath = path.join(visionDir, `${stem}.json`);
    const existing = await readJson(sidecarPath, null);
    if (existing && await exists(imagePath)) {
      const imageSha = await sha256File(imagePath);
      if (witnessRecordValid(existing, { ...await witnessIdentity(document, page), imageSha })) {
        successPages.push(page);
        continue;
      }
    }
    await discardVisionOutputs(sidecarPath);
    try {
      await runCapture(rendererBinary, ['draw', '-q', '-F', 'png', '-r', String(visionRenderDpi), '-o', imagePath, path.join(root, document.local_cache_path), String(page)], {
        timeoutMs: 30000,
        heartbeat: () => updateRun(run),
      });
    } catch (error) {
      if (shutdownRequested) throw interruptedError();
      if (paddleLogIndicatesRuntimeFailure(`${error.code || ''} ${error.message || ''}`)) {
        error.scope = 'runtime';
        throw error;
      }
      failures.push({
        page,
        stage: 'vision_render',
        code: error.code || 'VISION_RENDER_FAILED',
        name: error.name || 'VisionRenderError',
        message: error.message || 'MuPDF did not produce the page image',
        attempts: 1,
      });
      continue;
    }
    throwIfInterrupted();
    rendered.push({ page, imagePath });
  }
  // Vision intermittently returns Foundation._GenericObjCError when invoked in
  // the same instant that Poppler closes a newly rendered PNG. A short bounded
  // settle keeps the independent witness deterministic without weakening it.
  const renderedIdentities = new Map(await Promise.all(rendered.map(async ({ page, imagePath }) => {
    const [imageSha, imageInfo] = await Promise.all([sha256File(imagePath), stat(imagePath)]);
    return [page, { imageSha, imageBytes: imageInfo.size, imageMtimeMs: Math.trunc(imageInfo.mtimeMs) }];
  })));
  const passResultsByPage = new Map(rendered.map(({ page }) => [page, new Map()]));
  const passFailures = new Map();
  const passAttempts = new Map();
  let provenance = null;
  if (rendered.length) {
    try {
      provenance = await collectVisionEngineProvenance();
    } catch (error) {
      if (shutdownRequested) throw interruptedError();
      throw error;
    }
    await interruptibleSleep(1500);
    for (const pass of profile.passes) {
      throwIfInterrupted();
      const passDir = path.join(passRoot, pass.pass_id);
      await mkdir(passDir, { recursive: true });
      const attempts = new Map(rendered.map(({ page }) => [page, 1]));
      const executionFailures = new Map();
      const outputNotBefore = new Map();
      passAttempts.set(pass.pass_id, attempts);
      for (const { page } of rendered) {
        await discardVisionOutputs(path.join(passDir, `page-${String(page).padStart(3, '0')}.json`));
      }
      const batchStartedAt = Date.now();
      for (const { page } of rendered) outputNotBefore.set(page, batchStartedAt);
      try {
        await runLogged(
          process.execPath,
          visionLauncherInvocationArgs({
            outputDir: passDir,
            languages: pass.languages,
            imagePaths: rendered.map(({ imagePath }) => imagePath),
          }),
          logPath,
          run,
          `independent_apple_vision_${pass.pass_id.replaceAll('-', '_')}`,
          {},
          [0],
          {
            ...visionBatchLimits,
            activityPaths: [passDir],
            pipeOutput: true,
            pipeBufferLimitBytes: visionPipeBufferLimitBytes,
          },
        );
      } catch (error) {
        if (shutdownRequested) throw interruptedError();
        for (const { page } of rendered) executionFailures.set(page, error);
      }
      throwIfInterrupted();

      const failedIndexes = async () => {
        const failed = [];
        for (let index = 0; index < rendered.length; index += 1) {
          const page = rendered[index].page;
          const sidecarPath = path.join(passDir, `page-${String(page).padStart(3, '0')}.json`);
          const identity = renderedIdentities.get(page);
          const record = await readFreshVisionOutput(sidecarPath, {
            notBeforeMs: outputNotBefore.get(page),
            file: `page-${String(page).padStart(3, '0')}.png`,
            documentId: document.id,
            page,
            pdfSha,
            imageSha: identity?.imageSha,
          });
          if (!record) failed.push(index);
        }
        return failed;
      };

      let failed = await failedIndexes();
      for (const delay of [2000, 10000, 30000]) {
        if (!failed.length) break;
        await interruptibleSleep(delay);
        for (const index of failed) {
          throwIfInterrupted();
          const { page, imagePath } = rendered[index];
          attempts.set(page, (attempts.get(page) || 1) + 1);
          const sidecarPath = path.join(passDir, `page-${String(page).padStart(3, '0')}.json`);
          await discardVisionOutputs(sidecarPath);
          outputNotBefore.set(page, Date.now());
          try {
            await runLogged(
              process.execPath,
              visionLauncherInvocationArgs({
                outputDir: passDir,
                languages: pass.languages,
                imagePaths: [imagePath],
              }),
              logPath,
              run,
              `independent_apple_vision_page_retry_${pass.pass_id.replaceAll('-', '_')}`,
              {},
              [0],
              {
                ...visionPageRetryLimits,
                activityPaths: [passDir],
                pipeOutput: true,
                pipeBufferLimitBytes: visionPipeBufferLimitBytes,
              },
            );
            executionFailures.delete(page);
          } catch (error) {
            if (shutdownRequested) throw interruptedError();
            executionFailures.set(page, error);
          }
        }
        failed = await failedIndexes();
      }

      for (const { page } of rendered) {
        const stem = `page-${String(page).padStart(3, '0')}`;
        const sidecarPath = path.join(passDir, `${stem}.json`);
        const textPath = path.join(passDir, `${stem}.txt`);
        const identity = renderedIdentities.get(page);
        const record = await readFreshVisionOutput(sidecarPath, {
          notBeforeMs: outputNotBefore.get(page),
          file: `${stem}.png`,
          documentId: document.id,
          page,
          pdfSha,
          imageSha: identity?.imageSha,
        });
        if (!record) {
          passFailures.set(`${page}:${pass.pass_id}`, executionFailures.get(page)
            || Object.assign(new Error(`missing, stale, or mismatched output for pass ${pass.pass_id}`), {
              code: 'VISION_WITNESS_FAILED',
            }));
          continue;
        }
        try {
          const [rawSidecarSha, rawTextSha] = await Promise.all([
            sha256File(sidecarPath),
            sha256File(textPath),
          ]);
          passResultsByPage.get(page).set(pass.pass_id, {
            pass_id: pass.pass_id,
            record,
            raw_sidecar_file: path.relative(base, sidecarPath).split(path.sep).join('/'),
            raw_sidecar_sha256: rawSidecarSha,
            raw_text_file: path.relative(base, textPath).split(path.sep).join('/'),
            raw_text_sha256: rawTextSha,
            attempt_count: attempts.get(page),
          });
        } catch (error) {
          passFailures.set(`${page}:${pass.pass_id}`, Object.assign(error, {
            code: 'VISION_RAW_ARTIFACT_MISSING',
          }));
        }
      }
    }
  }

  for (const { page, imagePath: image } of rendered) {
    const sidecarPath = path.join(visionDir, `page-${String(page).padStart(3, '0')}.json`);
    const renderedIdentity = renderedIdentities.get(page);
    const [imageSha, imageInfo] = await Promise.all([sha256File(image), stat(image)]);
    const maximumAttempts = Math.max(1, ...profile.passes.map((pass) => passAttempts.get(pass.pass_id)?.get(page) || 1));
    if (renderedIdentity?.imageSha !== imageSha) {
      failures.push({
        page,
        stage: 'vision',
        code: 'VISION_IMAGE_CHANGED_DURING_RUN',
        name: 'VisionWitnessError',
        message: 'rendered image identity changed after Apple Vision invocation',
        attempts: maximumAttempts,
      });
      continue;
    }
    const results = [...(passResultsByPage.get(page)?.values() || [])];
    const missingPass = profile.passes.find((pass) => !results.some((result) => result.pass_id === pass.pass_id));
    if (missingPass) {
      const passFailure = passFailures.get(`${page}:${missingPass.pass_id}`);
      failures.push({
        page,
        stage: 'vision',
        code: passFailure?.code || 'VISION_REQUIRED_PASS_MISSING',
        name: passFailure?.name || 'VisionWitnessError',
        message: passFailure?.message || `required Apple Vision pass did not produce current evidence: ${missingPass.pass_id}`,
        attempts: maximumAttempts,
        pass_id: missingPass.pass_id,
      });
      continue;
    }
    let enriched;
    try {
      enriched = buildVisionWitnessSidecar({
        document,
        page,
        pdfSha,
        imageSha,
        imageInfo,
        profile,
        passResults: results,
        provenance,
      });
    } catch (error) {
      failures.push({
        page,
        stage: 'vision',
        code: error.code || 'VISION_WITNESS_ASSEMBLY_FAILED',
        name: error.name || 'VisionWitnessError',
        message: error.message,
        attempts: maximumAttempts,
        pass_id: error.pass_id || null,
      });
      continue;
    }
    if (!witnessRecordValid(enriched, { ...await witnessIdentity(document, page), imageSha })) {
      failures.push({ page, stage: 'vision', code: 'VISION_IDENTITY_MISMATCH', name: 'VisionWitnessError', message: 'sidecar identity or language profile failed strict validation', attempts: maximumAttempts });
      continue;
    }
    await writeFile(sidecarPath.replace(/\.json$/i, '.txt'), `${enriched.lines.map((line) => line.text).join('\n')}\n`);
    await atomicJson(sidecarPath, enriched);
    successPages.push(page);
  }
  return { imageDir, visionDir, successPages, failures };
}

async function preflight(document, {
  requirePrimaryRuntime = true,
  requireVisionRuntime = true,
} = {}) {
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
  let rendererSha = null;
  if (requireVisionRuntime) {
    const rendererInfo = await stat(rendererBinary).catch(() => null);
    if (!rendererInfo?.isFile()) {
      throw Object.assign(new Error(`Missing Apple Vision renderer: ${rendererBinary}`), {
        permanent: true,
        scope: 'global',
        code: 'RENDERER_MISSING',
      });
    }
    rendererSha = await sha256File(rendererBinary);
    if (rendererSha !== expected.renderer_sha256) {
      throw Object.assign(new Error('MuPDF renderer checksum mismatch'), {
        permanent: true,
        scope: 'global',
        code: 'RENDERER_CHECKSUM_MISMATCH',
      });
    }
  }
  const commit = requirePrimaryRuntime
    ? await runCapture('git', ['-C', llamaRepository, 'rev-parse', 'HEAD']).then((result) => result.stdout.trim())
    : null;
  if (requirePrimaryRuntime && commit !== expected.llama_commit) throw Object.assign(new Error(`llama.cpp revision mismatch: ${commit}`), { permanent: true, scope: 'global', code: 'LLAMA_REVISION_MISMATCH' });
  if (pdfSha !== document.source_sha256) throw Object.assign(new Error(`Source PDF checksum mismatch for ${document.id}`), { permanent: true, scope: 'document', code: 'SOURCE_CHECKSUM_MISMATCH' });
  return {
    free_gib: freeGiB,
    model_sha256: null,
    mmproj_sha256: null,
    renderer_sha256: rendererSha,
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
  const [modelSha, mmprojSha, rendererSha] = await Promise.all([
    verify(modelPath, expected.model_sha256, 'MODEL_CHECKSUM_MISMATCH', 'PaddleOCR-VL model'),
    verify(mmprojPath, expected.mmproj_sha256, 'MMPROJ_CHECKSUM_MISMATCH', 'PaddleOCR-VL mmproj'),
    verify(rendererBinary, expected.renderer_sha256, 'RENDERER_CHECKSUM_MISMATCH', 'MuPDF renderer'),
  ]);
  await atomicJson(runtimeIntegrityPath, cache);
  return { model_sha256: modelSha, mmproj_sha256: mmprojSha, renderer_sha256: rendererSha, runtime_model_integrity: 'verified' };
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

async function clearEvidencePageFailures(documentId, page) {
  const records = await readJson(pageRetriesPath, {});
  let changed = false;
  const prefix = `${documentId}:${Number(page)}:`;
  for (const key of Object.keys(records)) {
    const stage = key.startsWith(prefix) ? key.slice(prefix.length) : null;
    if (stage && evidenceRetryStages.has(stage)) {
      delete records[key];
      changed = true;
    }
  }
  if (changed) await atomicJson(pageRetriesPath, records);
}

async function reconcileRuntimePageRetries({ apply = false } = {}) {
  let reconciliationLockId = null;
  let reconciliationLockAcquired = false;
  try {
    if (apply) {
      const initialStatus = await collectStatus();
      const initialBusyReasons = retryReconcileBusyReasons(initialStatus);
      if (initialBusyReasons.length) {
        throw Object.assign(new Error(`Refusing retry reconciliation while OCR ownership is active: ${initialBusyReasons.join(',')}`), {
          code: 'OCR_OWNER_ACTIVE', exitCode: 75, busy_reasons: initialBusyReasons,
        });
      }
      reconciliationLockId = `retry-reconcile-${randomUUID()}`;
      await acquireLock(reconciliationLockId);
      reconciliationLockAcquired = true;
      const guardedStatus = await collectStatus(false);
      const guardedBusyReasons = retryReconcileBusyReasons(guardedStatus, process.pid);
      if (guardedBusyReasons.length) {
        throw Object.assign(new Error(`Refusing retry reconciliation after owner recheck: ${guardedBusyReasons.join(',')}`), {
          code: 'OCR_OWNER_ACTIVE', exitCode: 75, busy_reasons: guardedBusyReasons,
        });
      }
    }

    const [historyText, records] = await Promise.all([
      readFile(historyPath, 'utf8').catch(() => ''),
      readJson(pageRetriesPath, {}),
    ]);
    const latestRuntimeFailure = new Map();
    for (const line of historyText.split('\n').filter(Boolean)) {
      let run;
      try { run = JSON.parse(line); } catch { continue; }
      if (!run?.document_id || !Array.isArray(run.page_failures) || !run.page_failures.length) continue;
      const logText = await readFile(path.join(supervisorRoot, 'logs', String(run.run_id), 'paddle.log'), 'utf8').catch(() => '');
      const runtimeFailure = Boolean(run.paddle_execution_error)
        || (run.paddle_exit_code !== undefined && ![null, 0, 1].includes(run.paddle_exit_code))
        || paddleLogIndicatesRuntimeFailure(logText);
      if (!runtimeFailure) continue;
      const failedAt = Date.parse(run.completed_at || run.failed_at || run.heartbeat_at || run.started_at || '');
      for (const failure of run.page_failures) {
        const runtimeDerivedPageFailure = failure?.stage === 'paddle' && (
          failure?.message === 'Paddle OCR did not produce complete page artifacts'
          || failure?.code === 'PRIMARY_ARTIFACT_HASH_MISMATCH'
        );
        if (!runtimeDerivedPageFailure) continue;
        const key = pageRetryKey(run.document_id, failure.page, 'paddle');
        latestRuntimeFailure.set(key, Math.max(latestRuntimeFailure.get(key) || 0, Number.isFinite(failedAt) ? failedAt : 0));
      }
    }
    const removable = Object.entries(records).filter(([key, record]) => {
      const runtimeFailedAt = latestRuntimeFailure.get(key);
      const retryFailedAt = Date.parse(record?.last_failed_at || '');
      const runtimeDerivedRecord = (
        record?.error_code === 'PADDLE_PAGE_FAILED'
        && record?.last_error === 'PaddlePageError: Paddle OCR did not produce complete page artifacts'
      ) || (
        record?.error_code === 'PRIMARY_ARTIFACT_HASH_MISMATCH'
        && record?.last_error === 'PrimaryArtifactIntegrityError: Primary OCR page files do not match state hashes'
      );
      return runtimeFailedAt !== undefined
        && runtimeDerivedRecord
        && (!Number.isFinite(retryFailedAt) || retryFailedAt <= runtimeFailedAt + 1000);
    }).map(([key]) => key).sort();
    let backupPath = null;
    if (apply && removable.length) {
      backupPath = `${pageRetriesPath}.pre-runtime-reconcile-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await copyFile(pageRetriesPath, backupPath);
      for (const key of removable) delete records[key];
      await atomicJson(pageRetriesPath, records);
    }
    return {
      apply,
      removed_count: apply ? removable.length : 0,
      candidates: removable,
      backup_path: backupPath ? path.relative(root, backupPath) : null,
    };
  } finally {
    if (reconciliationLockAcquired) await releaseLock(reconciliationLockId).catch(() => {});
  }
}

async function promoteConceptCandidate(runDirectory) {
  const graphPath = path.join(runDirectory, 'concept-evolution.json');
  const qualityPath = path.join(runDirectory, 'concept-evolution-quality.json');
  const [graph, quality] = await Promise.all([readJson(graphPath, null), readJson(qualityPath, null)]);
  const shardAssets = Array.isArray(graph?.shard_manifest?.assets) ? graph.shard_manifest.assets : [];
  const manifest = {
    schema_version: 3,
    promoted_at: nowIso(),
    run_directory: path.relative(root, runDirectory),
    build_revision: graph?.build_revision,
    artifact_profile: graph?.artifact_profile,
    academic_schema_version: graph?.academic_schema_version,
    academic_schema: graph?.academic_schema,
    model_kind: graph?.model_kind,
    input_fingerprints: graph?.input_fingerprints,
    academic_model_ref: graph?.academic_model_ref || null,
    transport_profile: graph?.transport_profile || null,
    graph_shard_max_bytes: graph?.shard_manifest?.max_shard_bytes || null,
    graph_shard_count: shardAssets.length,
    graph_shard_descriptors_sha256: createHash('sha256').update(JSON.stringify(shardAssets)).digest('hex'),
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

async function once({ preselected = null, evidenceOnly = false } = {}) {
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
    selected = preselected || await nextBatch();
    if (!selected) {
      const status = await collectStatus();
      console.log(JSON.stringify({ status: status.scheduler_state, health: status.health }));
      return { status: status.scheduler_state, selected: null, page_failures: [] };
    }
    const { document, pages, mode } = selected;
    const executionPolicy = evidenceOnly
      ? evidenceExecutionPolicy(mode)
      : { ...ocrExecutionPolicy(mode), buildDerivedArtifacts: true };
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
      evidence_only: evidenceOnly,
      owned_llama_pid: null,
      page_failures: [],
      audited_pages: [],
      runtime_policy: {
        llama_parallel: llamaParallel,
        llama_context_per_slot: 8192,
        vl_rec_max_concurrency: vlRecMaxConcurrency,
        source: 'current_run',
      },
    };
    await updateRun(run);
    const checks = await preflight(document, {
      requirePrimaryRuntime: executionPolicy.runPrimaryOcr,
      requireVisionRuntime: executionPolicy.renderVision,
    });
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
    const paddleLogPath = path.join(logDir, 'paddle.log');
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
          '--vl-rec-max-concurrency', String(vlRecMaxConcurrency), '--server-parallel', String(llamaParallel),
        ], paddleLogPath, run, 'paddle_ocr', {
          PADDLE_PDX_CACHE_HOME: path.join(root, '.cache/paddlex'), PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True',
          PYTHONUNBUFFERED: '1',
        }, [0, 1], {
          startupTimeoutMs: 180000,
          idleTimeoutMs: 300000,
          wallTimeoutMs: Math.max(1200000, paddlePages.length * 25000),
          activityPaths: [path.join(productionRoot, document.id, 'state.json')],
        });
        run.paddle_exit_code = paddleResult.code;
      } catch (error) {
        paddleExecutionError = error;
        run.paddle_exit_code = error.code ?? error.signal ?? 'spawn_error';
        run.paddle_execution_error = error.message;
      }
    }

    const afterPaddle = await readJson(path.join(productionRoot, document.id, 'state.json'), {});
    const paddleLog = await readFile(paddleLogPath, 'utf8').catch(() => '');
    const paddleClassification = classifyPaddleExitOne({
      exitCode: run.paddle_exit_code,
      logText: paddleLog,
      pages: paddlePages,
      beforeState: beforePaddle,
      afterState: afterPaddle,
    });
    const structuredPaddleFailures = new Set(paddleClassification.structuredFailurePages);
    if (!paddleExecutionError && paddleClassification.runtimeFailure) {
      paddleExecutionError = Object.assign(new Error(paddleLogIndicatesRuntimeFailure(paddleLog)
        ? 'Paddle runtime failed while loading native dependencies'
        : 'Paddle exited before recording any page-level state change'), {
        code: paddleLogIndicatesRuntimeFailure(paddleLog) ? 'PADDLE_RUNTIME_LOG_FAILURE' : 'PADDLE_RUNTIME_NO_PAGE_PROGRESS',
        stage: 'paddle_ocr',
      });
      run.paddle_execution_error = paddleExecutionError.message;
    }
    const completedAfterPaddle = new Set((afterPaddle.completed_pages || []).map(Number));
    for (const page of paddlePages) {
      if (completedAfterPaddle.has(page) && await primaryPageValid(afterPaddle, document.id, page, true)) continue;
      const stateFailure = afterPaddle.failed_pages?.[String(page)] || null;
      if (paddleExecutionError && !structuredPaddleFailures.has(page)) continue;
      const stateError = stateFailure?.error || 'Paddle OCR did not produce complete page artifacts';
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
      else if ((!paddleExecutionError || structuredPaddleFailures.has(page)) && !run.page_failures.some((failure) => failure.page === page && failure.stage === 'paddle')) {
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
        if (evidenceOnly) await clearEvidencePageFailures(document.id, page);
        else await clearPageFailures(document.id, page);
        run.audited_pages.push(page);
      } catch (error) {
        if (shutdownRequested) throw interruptedError();
        const failure = { page, stage: 'audit', code: 'WITNESS_AUDIT_FAILED', name: error.name, message: error.message };
        await recordPageFailure(document.id, failure);
        run.page_failures.push(failure);
      }
    }

    if (paddleExecutionError) {
      const runtimeFailure = paddleRuntimeFailure(paddleExecutionError);
      run.paddle_runtime_cause = runtimeFailure.cause_code;
      run.runtime_retry_at = runtimeFailure.retry_at;
      Object.assign(paddleExecutionError, {
        code: runtimeFailure.code,
        scope: runtimeFailure.scope,
        exitCode: 10,
      });
      throw paddleExecutionError;
    }

    if (run.audited_pages.length && executionPolicy.buildDerivedArtifacts) {
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
    return {
      status: run.status,
      run_id: runId,
      selection: selected,
      audited_pages: [...run.audited_pages],
      page_failures: [...run.page_failures],
    };
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
    if (!evidenceOnly) await collectStatus().catch(() => {});
  }
}

async function evidenceScopeStateFingerprint(documents) {
  return Object.fromEntries(await Promise.all(documents.map(async (document) => {
    const statePath = path.join(productionRoot, document.id, 'state.json');
    return [document.id, await sha256File(statePath).catch(() => null)];
  })));
}

function evidenceScopeFingerprintMatches(left, right) {
  return left && right
    && Object.keys(left).length === Object.keys(right).length
    && Object.entries(left).every(([documentId, sha]) => sha && right[documentId] === sha);
}

function scopedEvidenceRetries(records, documentIds) {
  const allowed = new Set(documentIds);
  return Object.entries(records || {}).filter(([key, record]) => {
    const match = key.match(/^(.+):(\d+):([^:]+)$/);
    return match
      && allowed.has(match[1])
      && evidenceRetryStages.has(match[3])
      && (record?.quarantined || record?.next_retry_at || Number(record?.attempts || 0) > 0);
  });
}

async function backfillEvidence() {
  shutdownRequested = false;
  const scope = await loadEvidenceScope();
  const drainId = `evidence-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const stop = () => {
    shutdownRequested = true;
    if (activeStageChild?.exitCode === null) activeStageChild.kill('SIGTERM');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const state = {
    schema_version: 2,
    command: 'backfill-evidence',
    drain_id: drainId,
    pid: process.pid,
    batch_pages: batchPages,
    status: 'running',
    stage: 'starting',
    started_at: nowIso(),
    heartbeat_at: nowIso(),
    scope: {
      manifest_path: scope.manifest_path,
      manifest_sha256: scope.manifest_sha256,
      document_count: scope.documents.length,
      document_ids: scope.document_ids,
    },
    batches_completed: 0,
    pages_audited: 0,
    retry_override: retryFailed || forceImmediateRecovery,
    canary_required: false,
    runtime_policy: {
      apple_vision_only: true,
      primary_ocr_disabled: true,
      llama_disabled: true,
      derived_artifacts_disabled: true,
      source: 'evidence_drain_state',
    },
  };
  const updateDrainState = async (changes = {}) => {
    Object.assign(state, changes, { heartbeat_at: nowIso() });
    await atomicJson(drainStatePath, state);
  };
  const finish = async (decision, details = {}) => {
    const terminal = {
      status: decision.status,
      stage: decision.action === 'complete' ? 'complete' : 'stopped',
      completed_at: decision.action === 'complete' ? nowIso() : undefined,
      stopped_at: decision.action === 'stop' ? nowIso() : undefined,
      result_code: decision.code,
      ...details,
    };
    await updateDrainState(terminal);
    console.log(JSON.stringify({
      status: decision.action === 'complete' ? 'evidence_backfill_complete' : `evidence_${decision.status}`,
      code: decision.code,
      scope: state.scope,
      batches_completed: state.batches_completed,
      pages_audited: state.pages_audited,
      ...details,
    }));
    if (decision.exitCode) process.exitCode = decision.exitCode;
  };
  let drainLockAcquired = false;
  try {
    await acquireDrainLock(drainId);
    drainLockAcquired = true;
    activeOwnedDrainId = drainId;
    await updateDrainState();
    const initialRetries = await readJson(pageRetriesPath, {});
    const initialDisk = await statfs(root);
    const initialFreeGiB = Number(initialDisk.bavail * initialDisk.bsize) / 1024 ** 3;
    const diskDecision = evidenceDrainDecision({
      selection: { mode: 'witness_backfill', pages: [] },
      freeGiB: initialFreeGiB,
    });
    if (diskDecision.action === 'stop') {
      await finish(diskDecision, { free_gib: Number(initialFreeGiB.toFixed(2)) });
      return;
    }
    const unsafe = await inspectEvidenceScopePrimaryReadiness(scope.documents, {
      pageRetryRecords: initialRetries,
      deep: true,
    });
    const unsafeDecision = evidenceDrainDecision({ selection: unsafe, freeGiB: initialFreeGiB });
    if (unsafeDecision.action === 'stop') {
      await finish(unsafeDecision, {
        blocked_mode: unsafe?.mode,
        document_id: unsafe?.document?.id,
        pages: unsafe?.pages || [],
        reason: unsafe?.reason,
      });
      return;
    }
    let stateFingerprint = await evidenceScopeStateFingerprint(scope.documents);
    let canaryRequired = (retryFailed || forceImmediateRecovery)
      && scopedEvidenceRetries(initialRetries, scope.document_ids).length > 0;
    await updateDrainState({
      stage: canaryRequired ? 'canary_pending' : 'selecting_evidence',
      canary_required: canaryRequired,
      free_gib: Number(initialFreeGiB.toFixed(2)),
    });
    while (true) {
      throwIfInterrupted();
      const disk = await statfs(root);
      const freeGiB = Number(disk.bavail * disk.bsize) / 1024 ** 3;
      const currentFingerprint = await evidenceScopeStateFingerprint(scope.documents);
      if (!evidenceScopeFingerprintMatches(stateFingerprint, currentFingerprint)) {
        const decision = evidenceDrainDecision({
          selection: { mode: 'primary_recovery', pages: [], reason: 'scope_state_changed' },
          freeGiB,
        });
        await finish(decision, { reason: 'scope_state_changed_during_evidence_backfill' });
        return;
      }
      const currentRetries = await readJson(pageRetriesPath, {});
      const selection = await selectEvidenceBatch(scope.documents, {
        limit: canaryRequired ? 1 : batchPages,
        pageRetryRecords: currentRetries,
        retryOverride: retryFailed || forceImmediateRecovery,
        verifyPrimary: false,
      });
      let decision = evidenceDrainDecision({ selection, freeGiB });
      if (decision.action === 'complete') {
        const finalUnsafe = await inspectEvidenceScopePrimaryReadiness(scope.documents, {
          pageRetryRecords: currentRetries,
          deep: true,
        });
        decision = evidenceDrainDecision({ selection: finalUnsafe, freeGiB });
        if (decision.action === 'complete') {
          await finish(decision, { free_gib: Number(freeGiB.toFixed(2)) });
          return;
        }
      }
      if (decision.action === 'stop') {
        await finish(decision, {
          blocked_mode: selection?.mode,
          document_id: selection?.document?.id,
          pages: selection?.pages || [],
          reason: selection?.reason,
          free_gib: Number(freeGiB.toFixed(2)),
        });
        return;
      }
      await updateDrainState({
        stage: canaryRequired ? 'running_canary' : 'running_evidence_batch',
        canary_required: canaryRequired,
        current_batch: {
          mode: selection.mode,
          document_id: selection.document.id,
          pages: selection.pages,
        },
        free_gib: Number(freeGiB.toFixed(2)),
      });
      const outcome = await once({ preselected: selection, evidenceOnly: true });
      decision = evidenceDrainDecision({
        selection,
        freeGiB,
        pageFailures: outcome.page_failures,
      });
      if (decision.action === 'stop') {
        await finish(decision, {
          document_id: selection.document.id,
          pages: selection.pages,
          page_failures: outcome.page_failures,
          canary_required: canaryRequired,
          recovery_hint: 'rerun with --retry-failed or --force-immediate; the next recovery starts with one page',
        });
        return;
      }
      const wasCanary = canaryRequired;
      state.batches_completed += 1;
      state.pages_audited += outcome.audited_pages.length;
      if (wasCanary) canaryRequired = false;
      stateFingerprint = await evidenceScopeStateFingerprint(scope.documents);
      await updateDrainState({
        stage: 'between_evidence_batches',
        canary_required: canaryRequired,
        current_batch: null,
        last_run_id: outcome.run_id,
        last_document_id: selection.document.id,
        last_pages: selection.pages,
      });
      console.log(JSON.stringify({
        status: 'evidence_backfill_progress',
        run_id: outcome.run_id,
        mode: selection.mode,
        document_id: selection.document.id,
        pages: selection.pages,
        pages_audited: outcome.audited_pages,
        batches_completed: state.batches_completed,
        canary_passed: wasCanary,
      }));
      await interruptibleSleep(1000);
    }
  } catch (error) {
    const interrupted = shutdownRequested || error.exitCode === 130;
    const decision = evidenceDrainDecision({ interrupted });
    if (drainLockAcquired) {
      await finish(interrupted ? decision : {
        action: 'stop',
        status: 'failed',
        code: error.code || 'EVIDENCE_DRAIN_FAILED',
        exitCode: error.exitCode || 10,
      }, { error: error.message }).catch(() => {});
      return;
    }
    throw error;
  } finally {
    if (drainLockAcquired) await releaseDrainLock(drainId).catch(() => {});
    if (activeOwnedDrainId === drainId) activeOwnedDrainId = null;
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
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
    runtime_policy: {
      llama_parallel: llamaParallel,
      llama_context_per_slot: 8192,
      vl_rec_max_concurrency: vlRecMaxConcurrency,
      source: 'drain_state',
    },
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
    } else if (command === 'backfill-evidence') {
      await backfillEvidence();
    } else if (command === 'reconcile-runtime-retries') {
      console.log(JSON.stringify(await reconcileRuntimePageRetries({ apply: rawArgs.includes('--apply') }), null, 2));
    } else {
      console.error(`usage: node scripts/ocr-supervisor.mjs <status|check|once|recover|drain|backfill-evidence|reconcile-runtime-retries> [--batch-pages 1-${maxBatchPages}] [--manifest PATH] [--document ID ...] [--retry-failed] [--force-immediate] [--apply]`);
      process.exitCode = 64;
    }
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: error.code || 'RUN_FAILED', message: error.message }));
    process.exitCode = error.exitCode || 1;
  }
}
