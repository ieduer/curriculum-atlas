#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultChildMonitoringPolicy,
  fingerprintPaddlexLayoutModelCache,
  invokeOcrChild,
  preflightDocument,
  probePythonOcrRuntime,
  runRemoteOcrOffload,
  terminateOwnedChild,
  validateLlamaSystemdUnitName,
  validateOcrDocumentOutput,
  validateRemoteOcrManifest,
  verifyLlamaServerAttestation,
  verifyPinnedRuntime,
} from './run-remote-ocr-offload.mjs';
import {
  canonicalJson,
  inspectTree,
  inspectTreeInventory,
} from './lib/remote-ocr-local-snapshot.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const baseRunnerPath = fileURLToPath(new URL('./run-remote-ocr-offload.mjs', import.meta.url));
const pinnedBaseRunnerSha256 = '0fbf3d284f324f5faa710ca09342cdef88d24e6349b6e5d590ccca215065354d';
const sha256Pattern = /^[a-f0-9]{64}$/u;
const documentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const invocationIdPattern = /^[a-f0-9]{32}$/u;
const receiptType = 'curriculum_remote_ocr_operator_interruption_continuation_receipt';
const claimType = 'curriculum_remote_ocr_operator_interruption_continuation_claim';
const continuationMode = 'same_granted_attempt_forward_continuation';
const operatorClassification = 'operator_controlled_sigterm_after_observer_error';
const attemptCeiling = 6;
const interruptionSignal = 'SIGTERM';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function sha256File(pathname) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(pathname)) hash.update(chunk);
  return hash.digest('hex');
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function requireSha256(value, label) {
  if (!sha256Pattern.test(String(value || ''))) throw new Error(`${label} must be lowercase SHA-256`);
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function requireCanonicalTimestamp(value, label) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC millisecond timestamp`);
  }
  return value;
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertCurrentOwner(info, label) {
  if ((typeof process.getuid === 'function' && info.uid !== process.getuid())
    || (typeof process.getgid === 'function' && info.gid !== process.getgid())) {
    throw new Error(`${label} must be owned by the current UID/GID`);
  }
}

async function requireOwnerDirectory(pathname, label) {
  const info = await lstat(pathname).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing`);
    throw error;
  });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  assertCurrentOwner(info, label);
  if ((info.mode & 0o777) !== 0o700) throw new Error(`${label} must have mode 0700`);
  return info;
}

async function requireOwnerFile(pathname, label) {
  const info = await lstat(pathname).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing`);
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  assertCurrentOwner(info, label);
  if ((info.mode & 0o777) !== 0o600 || info.nlink !== 1) {
    throw new Error(`${label} must be a current-owner mode-0600 single-link file`);
  }
  return info;
}

function parseSidecar(raw, pathname, expectedDigest, label) {
  const expected = `${expectedDigest}  ${path.basename(pathname)}\n`;
  if (raw.toString('utf8') !== expected) throw new Error(`${label} SHA-256 sidecar is invalid`);
}

async function readStrictFile(pathname, label) {
  await requireOwnerFile(pathname, label);
  return readFile(pathname);
}

async function readStrictFileWithSidecar(pathname, label) {
  const sidecarPath = `${pathname}.sha256`;
  const [raw, sidecarRaw] = await Promise.all([
    readStrictFile(pathname, label),
    readStrictFile(sidecarPath, `${label} SHA-256 sidecar`),
  ]);
  const digest = sha256(raw);
  parseSidecar(sidecarRaw, pathname, digest, label);
  return { raw, sidecarRaw, digest };
}

function parseJson(raw, label) {
  try {
    return requireObject(JSON.parse(raw.toString('utf8')), label);
  } catch (error) {
    if (/must be a JSON object/u.test(error.message)) throw error;
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function syncDirectory(pathname) {
  const handle = await open(pathname, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurableFile(pathname, raw, mode = 0o600) {
  const handle = await open(pathname, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
  try {
    await handle.writeFile(raw);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function durableAtomicReplace(pathname, raw) {
  const temporary = `${pathname}.tmp-${process.pid}-${randomUUID()}`;
  await writeDurableFile(temporary, raw);
  try {
    await rename(temporary, pathname);
    await syncDirectory(path.dirname(pathname));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeMutableJsonWithSidecar(pathname, value) {
  const raw = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const digest = sha256(raw);
  await durableAtomicReplace(pathname, raw);
  await durableAtomicReplace(
    `${pathname}.sha256`,
    Buffer.from(`${digest}  ${path.basename(pathname)}\n`),
  );
  return digest;
}

async function writeEvidenceFile(root, basename, raw) {
  const pathname = path.join(root, basename);
  const digest = sha256(raw);
  await writeDurableFile(pathname, raw);
  await writeDurableFile(
    `${pathname}.sha256`,
    Buffer.from(`${digest}  ${basename}\n`),
  );
  return { path: basename, sha256: digest, bytes: raw.byteLength };
}

export function operatorContinuationPaths(outputRoot, documentId, attempt) {
  if (!documentIdPattern.test(String(documentId || ''))) throw new Error('document ID is unsafe');
  requirePositiveInteger(attempt, 'attempt');
  const root = path.join(
    path.resolve(outputRoot),
    'operator-continuations',
    documentId,
    `attempt-${String(attempt).padStart(4, '0')}`,
  );
  return {
    root,
    receipt: path.join(root, 'receipt.json'),
    receiptSidecar: path.join(root, 'receipt.json.sha256'),
    claim: path.join(root, 'claim.json'),
    claimSidecar: path.join(root, 'claim.json.sha256'),
    interruptedRunStatus: path.join(root, 'interrupted-run-status.json'),
    interruptedStatus: path.join(root, 'interrupted-status.json'),
    interruptedState: path.join(root, 'interrupted-state.json'),
    preContinuationLog: path.join(root, 'pre-continuation.log'),
  };
}

function validateOptions(options) {
  requireObject(options, 'continuation options');
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
    'llamaUrl',
    'runtimeDevice',
    'documentId',
    'workerInvocationId',
    'operatorInterruptedAt',
    'authorizedAt',
    'continuedAt',
    'incidentEvidenceRoot',
    'expectedOutputDevice',
    'expectedOutputInode',
  ]) {
    if (typeof options[key] !== 'string' || !options[key]) throw new Error(`${key} is required`);
  }
  if (!documentIdPattern.test(options.documentId)) throw new Error('document ID is unsafe');
  if (!invocationIdPattern.test(options.workerInvocationId)) {
    throw new Error('worker InvocationID must be exactly 32 lowercase hexadecimal characters');
  }
  if (options.attempt !== attemptCeiling) throw new Error('only exact granted attempt 6 can be continued');
  if (!/^\d+$/u.test(options.expectedOutputDevice) || !/^\d+$/u.test(options.expectedOutputInode)) {
    throw new Error('expected output device and inode must be unsigned decimal strings');
  }
  for (const [key, label] of [
    ['expectedRunStatusSha256', 'expected run status SHA-256'],
    ['expectedStatusSha256', 'expected document status SHA-256'],
    ['expectedLogSha256', 'expected log SHA-256'],
    ['expectedStateSha256', 'expected state SHA-256'],
    ['expectedDocumentTreeSha256', 'expected document tree SHA-256'],
    ['expectedIncidentTreeSha256', 'expected incident evidence tree SHA-256'],
    ['expectedGrantSha256', 'expected timeout recovery grant SHA-256'],
    ['expectedConsumptionClaimSha256', 'expected timeout recovery consumption claim SHA-256'],
    ['expectedRunnerScriptSha256', 'expected base runner script SHA-256'],
  ]) requireSha256(options[key], label);
  for (const [key, label] of [
    ['expectedLogBytes', 'expected log bytes'],
    ['expectedDocumentTreeFiles', 'expected document tree files'],
    ['expectedDocumentTreeBytes', 'expected document tree bytes'],
  ]) requirePositiveInteger(options[key], label);
  requireCanonicalTimestamp(options.operatorInterruptedAt, 'operator interrupted_at');
  requireCanonicalTimestamp(options.authorizedAt, 'authorization timestamp');
  requireCanonicalTimestamp(options.continuedAt, 'continuation claim timestamp');
  if (!(Date.parse(options.operatorInterruptedAt) <= Date.parse(options.authorizedAt)
    && Date.parse(options.authorizedAt) <= Date.parse(options.continuedAt))) {
    throw new Error('operator interruption, authorization, and continuation timestamps are out of order');
  }
  for (const key of [
    'vlRecMaxConcurrency',
    'serverParallel',
    'microBatch',
    'childStartupTimeoutSeconds',
    'childIdleTimeoutSeconds',
    'childWallFloorSeconds',
    'childWallSecondsPerPage',
    'childTerminateGraceSeconds',
    'childPollIntervalSeconds',
  ]) requirePositiveInteger(options[key], key);
  if (options.vlRecMaxConcurrency !== 1
    || options.serverParallel !== 1
    || options.microBatch !== 16
    || options.useQueues !== true
    || options.llamaUrl !== 'http://127.0.0.1:8112/v1'
    || options.childStartupTimeoutSeconds !== 180
    || options.childIdleTimeoutSeconds !== 1200
    || options.childWallFloorSeconds !== 1200
    || options.childWallSecondsPerPage !== 25
    || options.childTerminateGraceSeconds !== 15
    || options.childPollIntervalSeconds !== 5) {
    throw new Error('continuation requires the exact audited A2 p1/mb16 monitoring configuration');
  }
  validateLlamaSystemdUnitName(options.llamaSystemdUnit);
  if (options.expectedRunnerScriptSha256 !== pinnedBaseRunnerSha256) {
    throw new Error('expected base runner script SHA-256 is not the immutable A2 runner');
  }
  return options;
}

function validateCounts(runStatus) {
  const statuses = Object.values(requireObject(runStatus.documents, 'run status documents'))
    .map((document) => requireObject(document, 'run status document').status);
  const expected = {
    total: statuses.length,
    complete: statuses.filter((status) => status === 'complete').length,
    failed: statuses.filter((status) => status === 'failed').length,
    interrupted: statuses.filter((status) => status === 'interrupted').length,
    pending: statuses.filter((status) => status === 'pending').length,
    running: statuses.filter((status) => status === 'running').length,
    retry_wait: statuses.filter((status) => status === 'retry_wait').length,
    quarantined: statuses.filter((status) => status === 'quarantined').length,
  };
  if (!sameJson(runStatus.counts, expected)) throw new Error('run status counts are inconsistent');
}

function refreshRunStatus(runStatus, timestamp) {
  const statuses = Object.values(runStatus.documents).map((document) => document.status);
  runStatus.updated_at = timestamp;
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
}

function continuationStatusSeedLineage(identity, progress, receiptDocument) {
  return {
    seed_lineage: {
      schema_version: 1,
      seed_id: identity.seed_lineage.seed_id,
      predecessor_status_sha256: receiptDocument.predecessor_status_sha256,
      inherited_attempts: progress.inherited_attempts,
      timeout_recovery_grant_id: progress.timeout_recovery_grant_id,
      timeout_recovery_grant_sha256: progress.timeout_recovery_grant_sha256,
      timeout_recovery_first_missing_page: progress.timeout_recovery_first_missing_page,
      granted_attempt: attemptCeiling,
      citation_allowed: false,
    },
  };
}

async function inspectInterruptedState(options) {
  const outputRoot = await realpath(options.outputRoot);
  const inputRoot = await realpath(options.inputRoot);
  const incidentEvidenceRoot = await realpath(options.incidentEvidenceRoot);
  const outputInfo = await requireOwnerDirectory(outputRoot, 'successor output root');
  await requireOwnerDirectory(incidentEvidenceRoot, 'operator incident evidence root');
  if (String(outputInfo.dev) !== options.expectedOutputDevice
    || String(outputInfo.ino) !== options.expectedOutputInode) {
    throw new Error('successor output device/inode differs from the authorized A2 root');
  }
  if (isWithin(outputRoot, incidentEvidenceRoot) || isWithin(incidentEvidenceRoot, outputRoot)) {
    throw new Error('operator incident evidence root must be disjoint from the successor output root');
  }
  const manifestPath = await realpath(options.manifest);
  const manifestRaw = await readFile(manifestPath);
  const manifest = validateRemoteOcrManifest(JSON.parse(manifestRaw));
  const document = manifest.documents.find((item) => item.id === options.documentId);
  if (!document || manifest.documents.filter((item) => item.id === options.documentId).length !== 1) {
    throw new Error('target document is not exactly one manifest document');
  }
  const documentRoot = path.join(outputRoot, 'documents', options.documentId);
  const statusPath = path.join(outputRoot, 'status', `${options.documentId}.json`);
  const runStatusPath = path.join(outputRoot, 'run-status.json');
  const logPath = path.join(outputRoot, 'logs', `${options.documentId}.log`);
  const statePath = path.join(documentRoot, 'state.json');
  const [
    identityRaw,
    seedReceiptEvidence,
    runStatusEvidence,
    statusEvidence,
    logRaw,
    stateRawBefore,
    grantEvidence,
    consumptionEvidence,
  ] = await Promise.all([
    readStrictFile(path.join(outputRoot, 'run-identity.json'), 'run identity'),
    readStrictFileWithSidecar(path.join(outputRoot, 'seed-receipt.json'), 'seed receipt'),
    readStrictFileWithSidecar(runStatusPath, 'run status'),
    readStrictFileWithSidecar(statusPath, 'document status'),
    readStrictFile(logPath, 'document log'),
    readStrictFile(statePath, 'document state'),
    readStrictFileWithSidecar(path.join(outputRoot, 'timeout-recovery-grant.json'), 'timeout recovery grant'),
    readStrictFileWithSidecar(
      path.join(outputRoot, 'timeout-recovery-consumption-claim.json'),
      'timeout recovery consumption claim',
    ),
  ]);
  if (runStatusEvidence.digest !== options.expectedRunStatusSha256) throw new Error('run status SHA-256 drifted');
  if (statusEvidence.digest !== options.expectedStatusSha256) throw new Error('document status SHA-256 drifted');
  if (sha256(logRaw) !== options.expectedLogSha256) throw new Error('document log SHA-256 drifted');
  if (logRaw.byteLength !== options.expectedLogBytes) throw new Error('document log byte count drifted');
  if (sha256(stateRawBefore) !== options.expectedStateSha256) throw new Error('document state SHA-256 drifted');
  if (grantEvidence.digest !== options.expectedGrantSha256) throw new Error('timeout recovery grant SHA-256 drifted');
  if (consumptionEvidence.digest !== options.expectedConsumptionClaimSha256) {
    throw new Error('timeout recovery consumption claim SHA-256 drifted');
  }
  const [documentTree, incidentTree, stateRawAfter] = await Promise.all([
    inspectTreeInventory(documentRoot),
    inspectTree(incidentEvidenceRoot),
    readFile(statePath),
  ]);
  if (!stateRawBefore.equals(stateRawAfter)) throw new Error('document state changed during inspection');
  if (documentTree.tree_sha256 !== options.expectedDocumentTreeSha256
    || documentTree.files !== options.expectedDocumentTreeFiles
    || documentTree.bytes !== options.expectedDocumentTreeBytes) {
    throw new Error('document tree differs from the authorized exact inventory');
  }
  if (incidentTree.tree_sha256 !== options.expectedIncidentTreeSha256) {
    throw new Error('operator incident evidence tree SHA-256 drifted');
  }

  const identity = parseJson(identityRaw, 'run identity');
  const seedReceipt = parseJson(seedReceiptEvidence.raw, 'seed receipt');
  const runStatus = parseJson(runStatusEvidence.raw, 'run status');
  const status = parseJson(statusEvidence.raw, 'document status');
  const grant = parseJson(grantEvidence.raw, 'timeout recovery grant');
  const consumptionClaim = parseJson(consumptionEvidence.raw, 'timeout recovery consumption claim');
  const state = parseJson(stateRawBefore, 'document state');
  const progress = requireObject(runStatus.documents?.[options.documentId], 'target run status progress');
  validateCounts(runStatus);
  if (identity.manifest_sha256 !== sha256(manifestRaw)
    || runStatus.manifest_sha256 !== identity.manifest_sha256
    || identity.runtime_fingerprint_sha256 !== runtimeFingerprintSha256From(status)
    || runStatus.runtime_fingerprint_sha256 !== identity.runtime_fingerprint_sha256) {
    throw new Error('manifest or runtime identity differs across active controls');
  }
  if (identity.runner_script_sha256 !== pinnedBaseRunnerSha256) {
    throw new Error('run identity is not bound to the immutable A2 runner');
  }
  if (identity.input_root !== inputRoot) throw new Error('run identity input root drifted');
  if (status.schema_version !== 1
    || status.document_id !== options.documentId
    || status.status !== 'interrupted'
    || status.attempt !== attemptCeiling
    || status.max_attempts !== attemptCeiling
    || status.page_count !== document.page_count
    || status.citation_allowed !== false
    || status.interrupted_at !== options.operatorInterruptedAt) {
    throw new Error('document status is not the exact authorized interrupted attempt 6');
  }
  if (progress.status !== 'interrupted'
    || progress.attempts !== attemptCeiling
    || progress.attempt_ceiling !== attemptCeiling
    || progress.inherited_attempts !== 5
    || progress.signal !== interruptionSignal
    || progress.interrupted_at !== options.operatorInterruptedAt
    || progress.status_json_sha256 !== statusEvidence.digest
    || progress.page_count !== document.page_count) {
    throw new Error('run status is not the exact authorized interrupted attempt 6');
  }
  requireCanonicalTimestamp(progress.started_at, 'attempt 6 original started_at');
  if (Date.parse(progress.started_at) > Date.parse(progress.interrupted_at)) {
    throw new Error('attempt 6 started_at is after interrupted_at');
  }
  const identitySeed = requireObject(identity.seed_lineage, 'run identity seed lineage');
  if (identitySeed.mode !== 'hash_bound_output_seed'
    || identitySeed.seed_id !== progress.seed_id
    || !Array.isArray(identitySeed.timeout_recovery_documents)
    || identitySeed.timeout_recovery_documents.filter((id) => id === options.documentId).length !== 1
    || identitySeed.timeout_recovery_grant_id !== progress.timeout_recovery_grant_id
    || identitySeed.timeout_recovery_grant_sha256 !== grantEvidence.digest
    || identitySeed.timeout_recovery_claim_sha256 !== consumptionEvidence.digest
    || identitySeed.citation_allowed !== false) {
    throw new Error('target is not bound to the existing single timeout grant and consumption claim');
  }
  const granted = grant.documents?.filter((item) => item.document_id === options.documentId) || [];
  const consumed = consumptionClaim.granted_documents?.filter(
    (item) => item.document_id === options.documentId,
  ) || [];
  if (grant.schema_version !== 1
    || grant.grant_type !== 'curriculum_remote_ocr_timeout_recovery_grant'
    || grant.mode !== 'one_additional_attempt_per_document'
    || grant.policy?.granted_attempt !== attemptCeiling
    || grant.policy?.automatic_attempt_7 !== false
    || grant.grant_id !== identitySeed.timeout_recovery_grant_id
    || granted.length !== 1
    || granted[0].inherited_attempts !== 5
    || granted[0].granted_attempt !== attemptCeiling
    || grant.citation_allowed !== false) {
    throw new Error('target does not have exactly one valid attempt-6 timeout grant');
  }
  if (consumptionClaim.schema_version !== 1
    || consumptionClaim.claim_type !== 'curriculum_remote_ocr_timeout_recovery_consumption_claim'
    || consumptionClaim.claim_mode !== 'atomic_single_claim'
    || consumptionClaim.grant_id !== grant.grant_id
    || consumptionClaim.grant_raw_sha256 !== grantEvidence.digest
    || consumed.length !== 1
    || consumed[0].inherited_attempts !== 5
    || consumed[0].granted_attempt !== attemptCeiling
    || consumptionClaim.successor?.seed_id !== identitySeed.seed_id
    || consumptionClaim.successor?.output_root !== outputRoot
    || consumptionClaim.successor?.output_device !== String(outputInfo.dev)
    || consumptionClaim.successor?.output_inode !== String(outputInfo.ino)
    || consumptionClaim.citation_allowed !== false) {
    throw new Error('existing timeout recovery consumption claim does not bind this successor and attempt');
  }
  const receiptDocument = seedReceipt.documents?.find((item) => item.document_id === options.documentId);
  if (!receiptDocument
    || seedReceipt.documents.filter((item) => item.document_id === options.documentId).length !== 1
    || receiptDocument.timeout_recovery?.granted_attempt !== attemptCeiling
    || receiptDocument.timeout_recovery?.grant_id !== grant.grant_id
    || seedReceipt.seed_id !== identitySeed.seed_id
    || seedReceipt.citation_allowed !== false) {
    throw new Error('seed receipt does not bind the target to granted attempt 6');
  }
  if (status.seed_lineage?.seed_id !== identitySeed.seed_id
    || status.seed_lineage?.inherited_attempts !== 5
    || status.seed_lineage?.timeout_recovery_grant_id !== grant.grant_id
    || status.seed_lineage?.timeout_recovery_grant_sha256 !== grantEvidence.digest
    || status.seed_lineage?.granted_attempt !== attemptCeiling
    || status.seed_lineage?.citation_allowed !== false) {
    throw new Error('interrupted document status seed lineage is invalid');
  }
  if (state.schema_version !== 1
    || state.document_id !== options.documentId
    || state.source_sha256 !== document.source_sha256
    || state.page_count !== document.page_count
    || state.selected_pages_complete !== false
    || !Array.isArray(state.completed_pages)
    || state.completed_pages.length >= document.page_count
    || !requireObject(state.failed_pages, 'document failed_pages')) {
    throw new Error('document state is not a valid partial attempt-6 state');
  }
  const archives = {
    interrupted_run_status: {
      path: 'interrupted-run-status.json',
      sha256: runStatusEvidence.digest,
      bytes: runStatusEvidence.raw.byteLength,
    },
    interrupted_status: {
      path: 'interrupted-status.json',
      sha256: statusEvidence.digest,
      bytes: statusEvidence.raw.byteLength,
    },
    interrupted_state: {
      path: 'interrupted-state.json',
      sha256: sha256(stateRawBefore),
      bytes: stateRawBefore.byteLength,
    },
    pre_continuation_log: {
      path: 'pre-continuation.log',
      sha256: sha256(logRaw),
      bytes: logRaw.byteLength,
    },
  };
  const receiptBasis = {
    schema_version: 1,
    receipt_type: receiptType,
    mode: continuationMode,
    output: {
      root: outputRoot,
      device: String(outputInfo.dev),
      inode: String(outputInfo.ino),
    },
    document: {
      document_id: options.documentId,
      attempt: attemptCeiling,
      max_attempts: attemptCeiling,
      original_started_at: progress.started_at,
      interrupted_at: options.operatorInterruptedAt,
      signal: interruptionSignal,
      document_tree_sha256: documentTree.tree_sha256,
      document_tree_files: documentTree.files,
      document_tree_bytes: documentTree.bytes,
      state_sha256: sha256(stateRawBefore),
      log_sha256: sha256(logRaw),
      log_bytes: logRaw.byteLength,
    },
    authorization: {
      classification: operatorClassification,
      worker_invocation_id: options.workerInvocationId,
      authorized_at: options.authorizedAt,
      incident_evidence_root: incidentEvidenceRoot,
      incident_evidence_tree_sha256: incidentTree.tree_sha256,
      base_runner_path: baseRunnerPath,
      base_runner_sha256: options.expectedRunnerScriptSha256,
    },
    timeout_recovery: {
      seed_id: identitySeed.seed_id,
      grant_id: grant.grant_id,
      grant_sha256: grantEvidence.digest,
      consumption_claim_sha256: consumptionEvidence.digest,
      inherited_attempts: 5,
      granted_attempt: attemptCeiling,
      automatic_attempt_7: false,
    },
    interrupted_snapshot: {
      archives,
      run_status_sha256: runStatusEvidence.digest,
      status_sha256: statusEvidence.digest,
      document_progress: structuredClone(progress),
      document_status: structuredClone(status),
    },
    citation_allowed: false,
  };
  const receipt = {
    ...receiptBasis,
    continuation_id: sha256(canonicalJson(receiptBasis)),
  };
  return {
    archives,
    consumptionClaim,
    document,
    documentRoot,
    documentTree,
    grant,
    identity,
    identityRaw,
    inputRoot,
    logPath,
    logRaw,
    manifest,
    manifestPath,
    manifestRaw,
    outputInfo,
    outputRoot,
    progress,
    receipt,
    receiptDocument,
    runStatus,
    runStatusEvidence,
    runStatusPath,
    seedReceipt,
    statePath,
    stateRaw: stateRawBefore,
    status,
    statusEvidence,
    statusPath,
  };
}

function runtimeFingerprintSha256From(status) {
  requireSha256(status.runtime_fingerprint_sha256, 'document status runtime fingerprint SHA-256');
  return status.runtime_fingerprint_sha256;
}

async function verifyCommittedSeed(options) {
  return runRemoteOcrOffload({
    manifest: options.manifest,
    inputRoot: options.inputRoot,
    outputRoot: options.outputRoot,
    python: options.python,
    ocrScript: options.ocrScript,
    model: options.model,
    mmproj: options.mmproj,
    llamaRepo: options.llamaRepo,
    llamaServerBin: options.llamaServerBin,
    llamaSystemdUnit: options.llamaSystemdUnit,
    llamaUrl: options.llamaUrl,
    runtimeDevice: options.runtimeDevice,
    paddlexCacheHome: options.paddlexCacheHome,
    vlRecMaxConcurrency: options.vlRecMaxConcurrency,
    serverParallel: options.serverParallel,
    microBatch: options.microBatch,
    useQueues: options.useQueues,
    childStartupTimeoutSeconds: options.childStartupTimeoutSeconds,
    childIdleTimeoutSeconds: options.childIdleTimeoutSeconds,
    childWallFloorSeconds: options.childWallFloorSeconds,
    childWallSecondsPerPage: options.childWallSecondsPerPage,
    childTerminateGraceSeconds: options.childTerminateGraceSeconds,
    childPollIntervalSeconds: options.childPollIntervalSeconds,
    seedFromOutputRoot: options.outputRoot,
    seedOnly: true,
  });
}

async function verifyActiveRuntime(options, inspected, dependencies = {}) {
  const [pythonTarget, ocrScriptPath, actualRunnerSha256] = await Promise.all([
    realpath(options.python),
    realpath(options.ocrScript),
    sha256File(baseRunnerPath),
  ]);
  if (actualRunnerSha256 !== pinnedBaseRunnerSha256
    || actualRunnerSha256 !== inspected.identity.runner_script_sha256) {
    throw new Error('immutable A2 base runner SHA-256 drifted');
  }
  if (await sha256File(ocrScriptPath) !== inspected.identity.ocr_script_sha256) {
    throw new Error('OCR script SHA-256 drifted');
  }
  const pythonInfo = await stat(options.python);
  if (!pythonInfo.isFile() || (pythonInfo.mode & 0o111) === 0) throw new Error('Python invocation is not executable');
  await access(options.python, constants.X_OK);
  if (inspected.identity.python_resolved_target
    && inspected.identity.python_resolved_target !== pythonTarget) {
    throw new Error('Python resolved target drifted');
  }
  const runtime = await verifyPinnedRuntime(inspected.manifest.runtime, options);
  const llamaServerAttestation = await verifyLlamaServerAttestation(
    inspected.manifest.runtime,
    options,
    dependencies.llamaServerAttestationDependencies,
  );
  const llamaServerAttestationSha256 = sha256(`${JSON.stringify(llamaServerAttestation)}\n`);
  const pythonRuntime = probePythonOcrRuntime(options.python, {
    llamaUrl: options.llamaUrl,
    vlRecMaxConcurrency: options.vlRecMaxConcurrency,
    paddlexCacheHome: inspected.identity.worker_configuration.paddlex_cache_home,
  });
  const paddlexLayoutModelCache = await fingerprintPaddlexLayoutModelCache(
    inspected.identity.worker_configuration.paddlex_cache_home,
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
    paddlex_cache_home: inspected.identity.worker_configuration.paddlex_cache_home,
    python_runtime: pythonRuntime,
    paddlex_layout_model_cache_sha256: paddlexLayoutModelCache.tree_sha256,
  };
  if (!sameJson(runtime, inspected.identity.runtime)
    || !sameJson(llamaServerAttestation, inspected.identity.llama_server_attestation)
    || !sameJson(runtimeFingerprint, inspected.identity.runtime_fingerprint)
    || sha256(`${JSON.stringify(runtimeFingerprint)}\n`) !== inspected.identity.runtime_fingerprint_sha256
    || !sameJson(workerConfiguration, inspected.identity.worker_configuration)) {
    throw new Error('active OCR runtime differs from the immutable A2 run identity');
  }
  const source = await preflightDocument(inspected.document, {
    inputRoot: inspected.inputRoot,
    python: options.python,
    pageCounter: dependencies.pageCounter,
  });
  await validateOcrDocumentOutput(
    inspected.document,
    inspected.documentRoot,
    runtime,
    { requireComplete: false, workerConfiguration },
  );
  return { source, runtime, workerConfiguration, ocrScriptPath };
}

async function ensureOwnerDirectory(pathname) {
  const present = await lstat(pathname).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (!present) await mkdir(pathname, { mode: 0o700 });
  await requireOwnerDirectory(pathname, pathname);
}

async function publishReceipt(inspected, options) {
  const paths = operatorContinuationPaths(inspected.outputRoot, options.documentId, options.attempt);
  const rootPresent = await lstat(paths.root).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  const receiptRaw = Buffer.from(`${JSON.stringify(inspected.receipt, null, 2)}\n`);
  if (rootPresent) {
    await requireOwnerDirectory(paths.root, 'continuation evidence directory');
    const allowed = new Set([
      'receipt.json',
      'receipt.json.sha256',
      'interrupted-run-status.json',
      'interrupted-run-status.json.sha256',
      'interrupted-status.json',
      'interrupted-status.json.sha256',
      'interrupted-state.json',
      'interrupted-state.json.sha256',
      'pre-continuation.log',
      'pre-continuation.log.sha256',
      'claim.json',
      'claim.json.sha256',
    ]);
    const entries = await readdir(paths.root);
    if (entries.some((entry) => !allowed.has(entry))) {
      throw new Error('continuation evidence directory contains an unexpected entry');
    }
    const existing = await readStrictFileWithSidecar(paths.receipt, 'continuation receipt');
    if (!existing.raw.equals(receiptRaw)) throw new Error('existing continuation receipt differs from this incident');
    for (const [pathname, raw, label] of [
      [paths.interruptedRunStatus, inspected.runStatusEvidence.raw, 'archived interrupted run status'],
      [paths.interruptedStatus, inspected.statusEvidence.raw, 'archived interrupted status'],
      [paths.interruptedState, inspected.stateRaw, 'archived interrupted state'],
      [paths.preContinuationLog, inspected.logRaw, 'archived pre-continuation log'],
    ]) {
      const evidence = await readStrictFileWithSidecar(pathname, label);
      if (!evidence.raw.equals(raw)) throw new Error(`${label} differs from the authorized incident`);
    }
    return { paths, receiptRaw, receiptSha256: existing.digest, existing: true };
  }
  const baseRoot = path.join(inspected.outputRoot, 'operator-continuations');
  const documentEvidenceRoot = path.join(baseRoot, options.documentId);
  await ensureOwnerDirectory(baseRoot);
  await ensureOwnerDirectory(documentEvidenceRoot);
  const temporary = path.join(documentEvidenceRoot, `.attempt-0006.tmp-${process.pid}-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    await Promise.all([
      writeEvidenceFile(temporary, 'interrupted-run-status.json', inspected.runStatusEvidence.raw),
      writeEvidenceFile(temporary, 'interrupted-status.json', inspected.statusEvidence.raw),
      writeEvidenceFile(temporary, 'interrupted-state.json', inspected.stateRaw),
      writeEvidenceFile(temporary, 'pre-continuation.log', inspected.logRaw),
      writeEvidenceFile(temporary, 'receipt.json', receiptRaw),
    ]);
    await syncDirectory(temporary);
    await rename(temporary, paths.root);
    await syncDirectory(documentEvidenceRoot);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { paths, receiptRaw, receiptSha256: sha256(receiptRaw), existing: false };
}

async function publishClaim(inspected, published, options) {
  const claimPresent = await lstat(published.paths.claim).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  const sidecarPresent = await lstat(published.paths.claimSidecar).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (claimPresent || sidecarPresent) {
    if (!claimPresent && sidecarPresent) throw new Error('orphan continuation claim sidecar exists');
    throw new Error('operator interruption continuation was already consumed');
  }
  const claimBasis = {
    schema_version: 1,
    claim_type: claimType,
    mode: continuationMode,
    continuation_id: inspected.receipt.continuation_id,
    receipt_sha256: published.receiptSha256,
    output: structuredClone(inspected.receipt.output),
    document_id: options.documentId,
    attempt: attemptCeiling,
    claimed_at: options.continuedAt,
    timeout_recovery_grant_id: inspected.grant.grant_id,
    timeout_recovery_grant_sha256: options.expectedGrantSha256,
    timeout_recovery_consumption_claim_sha256: options.expectedConsumptionClaimSha256,
    citation_allowed: false,
  };
  const claim = { ...claimBasis, claim_id: sha256(canonicalJson(claimBasis)) };
  const raw = Buffer.from(`${JSON.stringify(claim, null, 2)}\n`);
  await writeDurableFile(published.paths.claim, raw);
  await writeDurableFile(
    published.paths.claimSidecar,
    Buffer.from(`${sha256(raw)}  claim.json\n`),
  );
  await syncDirectory(published.paths.root);
  return { claim, raw, sha256: sha256(raw) };
}

async function acquireContinuationLock(outputRoot) {
  const pathname = path.join(outputRoot, '.remote-ocr-orchestrator.lock');
  const owner = {
    pid: process.pid,
    token: randomUUID(),
    purpose: 'operator_interruption_attempt6_forward_continuation',
    created_at: new Date().toISOString(),
  };
  let handle;
  try {
    handle = await open(pathname, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error('orchestrator lock already exists; continuation refuses stale-lock recovery');
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(outputRoot);
  return async () => {
    const current = parseJson(await readFile(pathname), 'continuation lock');
    if (current.token !== owner.token) throw new Error('continuation lock ownership changed');
    await unlink(pathname);
    await syncDirectory(outputRoot);
  };
}

function monitoringPolicy(options, pageCount) {
  return {
    startup_timeout_seconds: options.childStartupTimeoutSeconds,
    idle_timeout_seconds: options.childIdleTimeoutSeconds,
    wall_floor_seconds: options.childWallFloorSeconds,
    wall_seconds_per_page: options.childWallSecondsPerPage,
    terminate_grace_seconds: options.childTerminateGraceSeconds,
    poll_interval_seconds: options.childPollIntervalSeconds,
    wall_timeout_seconds: Math.max(
      options.childWallFloorSeconds,
      options.childWallSecondsPerPage * pageCount,
    ),
  };
}

function forwardOnlyEntryMap(entries) {
  return new Map(entries.map((entry) => {
    const parts = entry.replace(/\n$/u, '').split('\0');
    return [parts[1], entry];
  }));
}

async function verifyForwardOnlyDocument(beforeInventory, documentRoot) {
  const after = await inspectTreeInventory(documentRoot);
  const afterEntries = forwardOnlyEntryMap(after.entries);
  for (const entry of beforeInventory.entries) {
    const parts = entry.replace(/\n$/u, '').split('\0');
    const pathname = parts[1];
    if (pathname === 'state.json') continue;
    if (afterEntries.get(pathname) !== entry) {
      throw new Error(`continuation changed or removed pre-existing document evidence: ${pathname}`);
    }
  }
  return after;
}

async function persistRunning(inspected, options) {
  const progress = inspected.runStatus.documents[options.documentId];
  progress.status = 'running';
  delete progress.interrupted_at;
  delete progress.signal;
  delete progress.failure_class;
  delete progress.error;
  delete progress.next_retry_at;
  const statusSha256 = await writeMutableJsonWithSidecar(inspected.statusPath, {
    schema_version: 1,
    document_id: options.documentId,
    status: 'running',
    attempt: attemptCeiling,
    max_attempts: attemptCeiling,
    page_count: inspected.document.page_count,
    runtime_fingerprint_sha256: inspected.identity.runtime_fingerprint_sha256,
    citation_allowed: false,
    started_at: progress.started_at,
    ...continuationStatusSeedLineage(inspected.identity, progress, inspected.receiptDocument),
  });
  progress.status_json_sha256 = statusSha256;
  refreshRunStatus(inspected.runStatus, options.continuedAt);
  await writeMutableJsonWithSidecar(inspected.runStatusPath, inspected.runStatus);
}

async function persistInterrupted(inspected, options, timestamp, signal) {
  const progress = inspected.runStatus.documents[options.documentId];
  progress.status = 'interrupted';
  progress.interrupted_at = timestamp;
  progress.signal = signal || interruptionSignal;
  const statusSha256 = await writeMutableJsonWithSidecar(inspected.statusPath, {
    schema_version: 1,
    document_id: options.documentId,
    status: 'interrupted',
    attempt: attemptCeiling,
    max_attempts: attemptCeiling,
    page_count: inspected.document.page_count,
    runtime_fingerprint_sha256: inspected.identity.runtime_fingerprint_sha256,
    citation_allowed: false,
    interrupted_at: timestamp,
    ...continuationStatusSeedLineage(inspected.identity, progress, inspected.receiptDocument),
  });
  progress.status_json_sha256 = statusSha256;
  refreshRunStatus(inspected.runStatus, timestamp);
  await writeMutableJsonWithSidecar(inspected.runStatusPath, inspected.runStatus);
}

async function persistSharedRuntimeFailure(inspected, options, timestamp, error) {
  const progress = inspected.runStatus.documents[options.documentId];
  progress.status = 'failed';
  progress.failure_class = 'shared_runtime_configuration';
  progress.failed_at = timestamp;
  progress.error = error.message;
  const statusSha256 = await writeMutableJsonWithSidecar(inspected.statusPath, {
    schema_version: 1,
    document_id: options.documentId,
    status: 'failed',
    failure_class: 'shared_runtime_configuration',
    attempt: attemptCeiling,
    max_attempts: attemptCeiling,
    page_count: inspected.document.page_count,
    runtime_fingerprint_sha256: inspected.identity.runtime_fingerprint_sha256,
    citation_allowed: false,
    error: error.message,
    failed_at: timestamp,
    ...continuationStatusSeedLineage(inspected.identity, progress, inspected.receiptDocument),
  });
  progress.status_json_sha256 = statusSha256;
  refreshRunStatus(inspected.runStatus, timestamp);
  await writeMutableJsonWithSidecar(inspected.runStatusPath, inspected.runStatus);
}

async function persistQuarantined(inspected, options, timestamp, error) {
  const progress = inspected.runStatus.documents[options.documentId];
  progress.status = 'quarantined';
  progress.quarantined_at = timestamp;
  progress.quarantine_reason = 'attempt_budget_exhausted';
  progress.error = error.message;
  const statusSha256 = await writeMutableJsonWithSidecar(inspected.statusPath, {
    schema_version: 1,
    document_id: options.documentId,
    status: 'quarantined',
    attempt: attemptCeiling,
    max_attempts: attemptCeiling,
    page_count: inspected.document.page_count,
    runtime_fingerprint_sha256: inspected.identity.runtime_fingerprint_sha256,
    citation_allowed: false,
    quarantine_reason: 'attempt_budget_exhausted',
    error: error.message,
    quarantined_at: timestamp,
    ...continuationStatusSeedLineage(inspected.identity, progress, inspected.receiptDocument),
  });
  progress.status_json_sha256 = statusSha256;
  refreshRunStatus(inspected.runStatus, timestamp);
  await writeMutableJsonWithSidecar(inspected.runStatusPath, inspected.runStatus);
}

async function persistComplete(inspected, options, timestamp, source, artifacts) {
  const progress = inspected.runStatus.documents[options.documentId];
  progress.status = 'complete';
  progress.completed_at = timestamp;
  delete progress.interrupted_at;
  delete progress.signal;
  delete progress.failure_class;
  delete progress.error;
  delete progress.next_retry_at;
  delete progress.quarantine_reason;
  delete progress.quarantined_at;
  const statusSha256 = await writeMutableJsonWithSidecar(inspected.statusPath, {
    schema_version: 1,
    document_id: options.documentId,
    status: 'complete',
    attempt: attemptCeiling,
    max_attempts: attemptCeiling,
    source_sha256: source.sourceSha256,
    page_count: source.pageCount,
    runtime_fingerprint_sha256: inspected.identity.runtime_fingerprint_sha256,
    citation_allowed: false,
    whole_document_atomic: true,
    artifacts,
    completed_at: timestamp,
    ...continuationStatusSeedLineage(inspected.identity, progress, inspected.receiptDocument),
  });
  progress.status_json_sha256 = statusSha256;
  refreshRunStatus(inspected.runStatus, timestamp);
  await writeMutableJsonWithSidecar(inspected.runStatusPath, inspected.runStatus);
}

export async function continueOperatorInterruptedAttempt(options, dependencies = {}) {
  validateOptions(options);
  if (options.apply === true) {
    const verifyBase = dependencies.verifyCommittedSeed || verifyCommittedSeed;
    await verifyBase(options);
  }
  const resolvedOutputRoot = await realpath(options.outputRoot);
  const paths = operatorContinuationPaths(resolvedOutputRoot, options.documentId, options.attempt);
  const existingClaim = await Promise.all([
    lstat(paths.claim).then(() => true, (error) => error?.code === 'ENOENT' ? false : Promise.reject(error)),
    lstat(paths.claimSidecar).then(() => true, (error) => error?.code === 'ENOENT' ? false : Promise.reject(error)),
  ]);
  if (existingClaim[0] || existingClaim[1]) {
    if (!existingClaim[0] && existingClaim[1]) throw new Error('orphan continuation claim sidecar exists');
    throw new Error('operator interruption continuation was already consumed');
  }
  const firstInspection = await inspectInterruptedState(options);
  if (options.apply !== true) {
    return {
      status: 'ready',
      continuation_id: firstInspection.receipt.continuation_id,
      document_id: options.documentId,
      attempt: attemptCeiling,
      receipt_path: paths.receipt,
      claim_path: paths.claim,
      citation_allowed: false,
    };
  }

  const releaseLock = await acquireContinuationLock(firstInspection.outputRoot);
  let activeChild = null;
  let externalTermination = null;
  let stopRequested = false;
  const requestStop = () => {
    stopRequested = true;
    externalTermination?.cancel();
    externalTermination = terminateOwnedChild(
      activeChild,
      options.childTerminateGraceSeconds * 1_000,
    );
  };
  const handleSignals = dependencies.handleSignals !== false;
  if (handleSignals) {
    process.once('SIGTERM', requestStop);
    process.once('SIGINT', requestStop);
  }
  try {
    const inspected = await inspectInterruptedState(options);
    if (inspected.receipt.continuation_id !== firstInspection.receipt.continuation_id) {
      throw new Error('authorized incident changed before the orchestrator lock was acquired');
    }
    const verifyRuntime = dependencies.verifyActiveRuntime || verifyActiveRuntime;
    const activeRuntime = await verifyRuntime(options, inspected, dependencies);
    const source = activeRuntime?.source || {
      sourceSha256: inspected.document.source_sha256,
      pageCount: inspected.document.page_count,
    };
    const published = await publishReceipt(inspected, options);
    const claim = await publishClaim(inspected, published, options);
    await persistRunning(inspected, options);

    const commandArguments = [
      activeRuntime?.ocrScriptPath || options.ocrScript,
      options.documentId,
      source.sourcePath || path.join(inspected.inputRoot, inspected.document.source_path),
      path.join(inspected.outputRoot, 'documents'),
      '--llama-url', options.llamaUrl,
      '--dpi', String(inspected.identity.runtime.render_dpi),
      '--vl-rec-max-concurrency', String(options.vlRecMaxConcurrency),
      '--server-parallel', String(options.serverParallel),
      '--micro-batch', String(options.microBatch),
      '--runtime-device', options.runtimeDevice,
      '--use-queues',
      '--seed-id', inspected.identity.seed_lineage.seed_id,
      '--seed-predecessor-run-identity-sha256',
      inspected.identity.seed_lineage.predecessor_run_identity_sha256,
      '--seed-predecessor-configuration-sha256',
      inspected.receiptDocument.predecessor_configuration_sha256,
    ];
    const invoke = dependencies.invokeOcr || invokeOcrChild;
    let childResult;
    let invocationError;
    try {
      childResult = await invoke(options.python, commandArguments, {
        env: {
          ...process.env,
          PADDLE_PDX_CACHE_HOME: inspected.identity.worker_configuration.paddlex_cache_home,
        },
        logPath: inspected.logPath,
        documentRoot: inspected.documentRoot,
        monitoring: monitoringPolicy(options, inspected.document.page_count),
        onChild: (child) => {
          activeChild = child;
          if (stopRequested) requestStop();
        },
      });
    } catch (error) {
      invocationError = error;
    } finally {
      externalTermination?.cancel();
      externalTermination = null;
      activeChild = null;
    }
    const timestamp = requireCanonicalTimestamp(
      dependencies.now?.() || new Date().toISOString(),
      'continuation outcome timestamp',
    );
    if (stopRequested) {
      await persistInterrupted(inspected, options, timestamp, childResult?.signal || interruptionSignal);
      return {
        status: 'interrupted',
        exitCode: 75,
        continuation_id: inspected.receipt.continuation_id,
        claim_sha256: claim.sha256,
        attempt: attemptCeiling,
        citation_allowed: false,
      };
    }
    const monitorIncident = childResult?.monitorIncident || invocationError?.monitorIncident;
    const childFailed = Boolean(
      invocationError
      || monitorIncident
      || childResult?.signal
      || !childResult
      || childResult.code !== 0,
    );
    if (childFailed) {
      const revalidate = dependencies.revalidateActiveRuntime || verifyRuntime;
      try {
        await revalidate(options, inspected, dependencies);
      } catch (error) {
        const shared = new Error(`shared runtime revalidation failed after continuation child failure: ${error.message}`, { cause: error });
        await persistSharedRuntimeFailure(inspected, options, timestamp, shared);
        throw shared;
      }
      const failure = new Error(
        monitorIncident
          ? `OCR child ${monitorIncident.type} after ${monitorIncident.elapsed_seconds}s; terminated with ${monitorIncident.termination_signals.join(' then ')}`
          : invocationError
            ? `OCR child invocation failed: ${invocationError.message}`
            : childResult?.signal
              ? `OCR child terminated by ${childResult.signal}`
              : `OCR child exited ${childResult?.code ?? 'without a result'}`,
      );
      await persistQuarantined(inspected, options, timestamp, failure);
      return {
        status: 'quarantined',
        exitCode: 12,
        continuation_id: inspected.receipt.continuation_id,
        claim_sha256: claim.sha256,
        attempt: attemptCeiling,
        citation_allowed: false,
      };
    }
    await verifyForwardOnlyDocument(inspected.documentTree, inspected.documentRoot);
    const validateOutput = dependencies.validateDocumentOutput || validateOcrDocumentOutput;
    const artifacts = await validateOutput(
      inspected.document,
      inspected.documentRoot,
      activeRuntime?.runtime || inspected.identity.runtime,
      { workerConfiguration: activeRuntime?.workerConfiguration || inspected.identity.worker_configuration },
    );
    await persistComplete(inspected, options, timestamp, source, artifacts);
    return {
      status: 'complete',
      exitCode: 0,
      continuation_id: inspected.receipt.continuation_id,
      receipt_sha256: published.receiptSha256,
      claim_sha256: claim.sha256,
      document_id: options.documentId,
      attempt: attemptCeiling,
      base_runner_sha256: pinnedBaseRunnerSha256,
      citation_allowed: false,
    };
  } finally {
    externalTermination?.cancel();
    if (handleSignals) {
      process.removeListener('SIGTERM', requestStop);
      process.removeListener('SIGINT', requestStop);
    }
    await releaseLock();
  }
}

function parseArguments(argv) {
  const options = {
    vlRecMaxConcurrency: 1,
    serverParallel: 1,
    microBatch: 16,
    useQueues: false,
    childStartupTimeoutSeconds: defaultChildMonitoringPolicy.startup_timeout_seconds,
    childIdleTimeoutSeconds: 1200,
    childWallFloorSeconds: defaultChildMonitoringPolicy.wall_floor_seconds,
    childWallSecondsPerPage: defaultChildMonitoringPolicy.wall_seconds_per_page,
    childTerminateGraceSeconds: defaultChildMonitoringPolicy.terminate_grace_seconds,
    childPollIntervalSeconds: defaultChildMonitoringPolicy.poll_interval_seconds,
    attempt: attemptCeiling,
    apply: false,
  };
  const strings = new Map([
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
    ['--document-id', 'documentId'],
    ['--worker-invocation-id', 'workerInvocationId'],
    ['--operator-interrupted-at', 'operatorInterruptedAt'],
    ['--authorized-at', 'authorizedAt'],
    ['--continued-at', 'continuedAt'],
    ['--incident-evidence-root', 'incidentEvidenceRoot'],
    ['--expected-output-device', 'expectedOutputDevice'],
    ['--expected-output-inode', 'expectedOutputInode'],
    ['--expected-run-status-sha256', 'expectedRunStatusSha256'],
    ['--expected-status-sha256', 'expectedStatusSha256'],
    ['--expected-log-sha256', 'expectedLogSha256'],
    ['--expected-state-sha256', 'expectedStateSha256'],
    ['--expected-document-tree-sha256', 'expectedDocumentTreeSha256'],
    ['--expected-incident-tree-sha256', 'expectedIncidentTreeSha256'],
    ['--expected-grant-sha256', 'expectedGrantSha256'],
    ['--expected-consumption-claim-sha256', 'expectedConsumptionClaimSha256'],
    ['--expected-runner-script-sha256', 'expectedRunnerScriptSha256'],
  ]);
  const integers = new Map([
    ['--attempt', 'attempt'],
    ['--expected-log-bytes', 'expectedLogBytes'],
    ['--expected-document-tree-files', 'expectedDocumentTreeFiles'],
    ['--expected-document-tree-bytes', 'expectedDocumentTreeBytes'],
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
    if (argument === '--apply') {
      options.apply = true;
      continue;
    }
    if (argument === '--use-queues') {
      options.useQueues = true;
      continue;
    }
    const key = strings.get(argument) || integers.get(argument);
    if (!key) throw new Error(`unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${argument}`);
    options[key] = integers.has(argument) ? Number(value) : value;
    index += 1;
  }
  return options;
}

function usage() {
  return [
    'Usage: node scripts/continue-remote-ocr-operator-interruption.mjs [exact original runner options] \\',
    '  --document-id ID --attempt 6 --worker-invocation-id ID --operator-interrupted-at ISO \\',
    '  --authorized-at ISO --continued-at ISO --incident-evidence-root DIR \\',
    '  --expected-output-device N --expected-output-inode N \\',
    '  --expected-run-status-sha256 SHA --expected-status-sha256 SHA \\',
    '  --expected-log-sha256 SHA --expected-log-bytes N --expected-state-sha256 SHA \\',
    '  --expected-document-tree-sha256 SHA --expected-document-tree-files N \\',
    '  --expected-document-tree-bytes N --expected-incident-tree-sha256 SHA \\',
    '  --expected-grant-sha256 SHA --expected-consumption-claim-sha256 SHA \\',
    `  --expected-runner-script-sha256 ${pinnedBaseRunnerSha256} [--apply]`,
    '',
    'Without --apply the command is mutation-free. --apply publishes one owner-only receipt and',
    'one consumption claim, then continues the already consumed granted attempt 6 without increment.',
    'It never creates a timeout grant, never resets attempts to 5, and never authorizes attempt 7.',
  ].join('\n');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await continueOperatorInterruptedAttempt(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (Number.isSafeInteger(result.exitCode)) process.exitCode = result.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`continue-remote-ocr-operator-interruption: ${error.message}\n`);
    process.exitCode = 2;
  });
}
