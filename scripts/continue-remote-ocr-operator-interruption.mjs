#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
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
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
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
} from './lib/remote-ocr-local-snapshot.mjs';
import {
  EXACT_A2_FORWARD_CONTINUATION_INCIDENT,
  OPERATOR_CONTINUATION_CLAIM_TYPE,
  OPERATOR_CONTINUATION_MODE,
  OPERATOR_CONTINUATION_RECEIPT_TYPE,
  a2ForwardContinuationProfileFingerprint,
  operatorContinuationEvidencePaths,
  prettyJson,
  readStableFile as readStableFileRecord,
  readStableFileWithSidecar as readStableFileWithSidecarRecord,
  requireStableDirectory,
  validateA2ForwardContinuationProfile,
} from './lib/remote-ocr-operator-continuation.mjs';
import { inspectTreeStrict } from './monitor-remote-ocr-single-shard.mjs';
import {
  acquireLifecycleLock,
  parseSystemdShow,
} from './repair-remote-ocr-preinference-interruption.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const baseRunnerPath = fileURLToPath(new URL('./run-remote-ocr-offload.mjs', import.meta.url));
const pinnedBaseRunnerSha256 = '0fbf3d284f324f5faa710ca09342cdef88d24e6349b6e5d590ccca215065354d';
const execFile = promisify(execFileCallback);
const sha256Pattern = /^[a-f0-9]{64}$/u;
const documentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const invocationIdPattern = /^[a-f0-9]{32}$/u;
const receiptType = OPERATOR_CONTINUATION_RECEIPT_TYPE;
const claimType = OPERATOR_CONTINUATION_CLAIM_TYPE;
const continuationMode = OPERATOR_CONTINUATION_MODE;
const operatorClassification = 'operator_controlled_sigterm_after_observer_error';
const attemptCeiling = 6;
const interruptionSignal = 'SIGTERM';
const systemdGenerationProperties = Object.freeze([
  'StateChangeTimestampMonotonic',
  'ActiveEnterTimestampMonotonic',
  'ActiveExitTimestampMonotonic',
  'InactiveEnterTimestampMonotonic',
]);
const continuationFenceRoles = Object.freeze(['worker', 'monitor', 'monitor_timer', 'alert']);

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

async function readStrictFile(pathname, label) {
  return (await readStableFileRecord(path.parse(pathname).root, pathname, label)).raw;
}

async function readStrictFileWithSidecar(pathname, label) {
  const record = await readStableFileWithSidecarRecord(path.parse(pathname).root, pathname, label);
  return {
    raw: record.raw,
    sidecarRaw: record.sidecar.raw,
    digest: record.sha256,
    dev: record.dev,
    ino: record.ino,
    bytes: record.bytes,
  };
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
  const handle = await open(
    pathname,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat({ bigint: true });
    const entry = await lstat(pathname, { bigint: true });
    if (!info.isDirectory() || info.dev !== entry.dev || info.ino !== entry.ino) {
      throw new Error(`directory changed before fsync: ${pathname}`);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurableFile(pathname, raw, mode = 0o600) {
  const handle = await open(pathname, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
  try {
    const before = await handle.stat({ bigint: true });
    const currentUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : before.uid;
    const currentGid = typeof process.getgid === 'function' ? BigInt(process.getgid()) : before.gid;
    if (!before.isFile()
      || before.nlink !== 1n
      || before.uid !== currentUid
      || before.gid !== currentGid
      || (Number(before.mode) & 0o7777) !== mode) {
      throw new Error(`new evidence file identity is unsafe: ${pathname}`);
    }
    await handle.writeFile(raw);
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    const entry = await lstat(pathname, { bigint: true });
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || after.dev !== entry.dev
      || after.ino !== entry.ino
      || BigInt(Buffer.byteLength(raw)) !== after.size) {
      throw new Error(`new evidence file changed while it was written: ${pathname}`);
    }
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

export function operatorContinuationPaths(evidenceBaseRoot, documentId, attempt) {
  return operatorContinuationEvidencePaths(evidenceBaseRoot, documentId, attempt);
}

function validateOptions(options, profile) {
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
    'paddlexCacheHome',
    'documentId',
    'authorizedAt',
    'continuedAt',
  ]) {
    if (typeof options[key] !== 'string' || !options[key]) throw new Error(`${key} is required`);
  }
  const forbiddenCallerProofs = [
    'workerInvocationId',
    'operatorInterruptedAt',
    'incidentEvidenceRoot',
    'expectedOutputDevice',
    'expectedOutputInode',
    'expectedRunStatusSha256',
    'expectedStatusSha256',
    'expectedLogSha256',
    'expectedLogBytes',
    'expectedStateSha256',
    'expectedDocumentTreeSha256',
    'expectedDocumentTreeFiles',
    'expectedDocumentTreeBytes',
    'expectedIncidentTreeSha256',
    'expectedGrantSha256',
    'expectedConsumptionClaimSha256',
    'expectedRunnerScriptSha256',
  ];
  const callerProof = forbiddenCallerProofs.find((key) => Object.hasOwn(options, key));
  if (callerProof) {
    throw new Error(`${callerProof} is frozen incident authority and must not be supplied by the caller`);
  }
  if (!documentIdPattern.test(options.documentId)
    || options.documentId !== profile.documentId
    || options.attempt !== profile.attempt
    || path.resolve(options.outputRoot) !== profile.outputRoot
    || options.llamaSystemdUnit !== profile.llamaUnit) {
    throw new Error('continuation target differs from the frozen A2 incident');
  }
  requireCanonicalTimestamp(options.authorizedAt, 'authorization timestamp');
  requireCanonicalTimestamp(options.continuedAt, 'continuation claim timestamp');
  if (!(Date.parse(profile.interruptedAt) <= Date.parse(options.authorizedAt)
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
  if (profile.baseRunnerSha256 !== pinnedBaseRunnerSha256) {
    throw new Error('frozen base runner SHA-256 is not the immutable A2 runner');
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

async function verifyExactAuthorityArtifacts({
  outputRoot,
  profile,
  identityRaw,
  seedReceiptEvidence,
  grantEvidence,
  consumptionEvidence,
}) {
  const [
    seedCommit,
    seedJournal,
    ledger,
    issuance,
    predecessorTree,
    rearmReceipt,
    rearmReservation,
    rearmTree,
  ] = await Promise.all([
    readStrictFileWithSidecar(path.join(outputRoot, 'seed-commit.json'), 'seed commit'),
    readStrictFileWithSidecar(path.join(outputRoot, '.seed-journal.json'), 'seed journal'),
    readStrictFileWithSidecar(
      path.join(outputRoot, 'timeout-recovery-ledger-identity.json'),
      'timeout recovery ledger identity',
    ),
    readStrictFileWithSidecar(
      path.join(outputRoot, profile.timeoutIssuanceRelativePath),
      'timeout recovery issuance',
    ),
    inspectTreeStrict(path.join(outputRoot, 'seed-predecessor-evidence')),
    readStrictFileWithSidecar(
      path.join(profile.rearmEvidenceRoot, 'repair-receipt.json'),
      'pre-inference rearm receipt',
    ),
    readStableFileRecord(
      profile.evidenceBaseRoot,
      path.join(profile.evidenceBaseRoot, `${profile.rearmRepairId}.claim.json`),
      'pre-inference rearm reservation claim',
    ),
    inspectTreeStrict(profile.rearmEvidenceRoot),
  ]);
  const rearmReceiptValue = parseJson(rearmReceipt.raw, 'pre-inference rearm receipt');
  const rearmTransaction = Array.isArray(rearmReceiptValue.transaction)
    ? rearmReceiptValue.transaction
    : [];
  const expectedRearmAfter = new Map([
    [`status/${profile.documentId}.json`, profile.rearmAfterStatusSha256],
    [`status/${profile.documentId}.json.sha256`, profile.rearmAfterStatusSidecarSha256],
    ['run-status.json', profile.rearmAfterRunStatusSha256],
    ['run-status.json.sha256', profile.rearmAfterRunStatusSidecarSha256],
  ]);
  const mismatches = [];
  const check = (actual, expected, label) => {
    if (actual !== expected) mismatches.push(label);
  };
  check(sha256(identityRaw), profile.runIdentitySha256, 'run identity SHA-256');
  check(identityRaw.byteLength, profile.runIdentityBytes, 'run identity bytes');
  check(seedReceiptEvidence.digest, profile.seedReceiptSha256, 'seed receipt SHA-256');
  check(seedReceiptEvidence.raw.byteLength, profile.seedReceiptBytes, 'seed receipt bytes');
  check(seedCommit.digest, profile.seedCommitSha256, 'seed commit SHA-256');
  check(seedCommit.raw.byteLength, profile.seedCommitBytes, 'seed commit bytes');
  check(seedJournal.digest, profile.seedJournalSha256, 'seed journal SHA-256');
  check(seedJournal.raw.byteLength, profile.seedJournalBytes, 'seed journal bytes');
  check(ledger.digest, profile.ledgerIdentitySha256, 'ledger identity SHA-256');
  check(ledger.raw.byteLength, profile.ledgerIdentityBytes, 'ledger identity bytes');
  check(sha256(ledger.sidecarRaw), profile.ledgerSidecarSha256, 'ledger identity sidecar SHA-256');
  check(ledger.sidecarRaw.byteLength, profile.ledgerSidecarBytes, 'ledger identity sidecar bytes');
  check(grantEvidence.digest, profile.timeoutGrantSha256, 'timeout grant SHA-256');
  check(grantEvidence.raw.byteLength, profile.timeoutGrantBytes, 'timeout grant bytes');
  check(consumptionEvidence.digest, profile.timeoutConsumptionClaimSha256, 'consumption claim SHA-256');
  check(consumptionEvidence.raw.byteLength, profile.timeoutConsumptionClaimBytes, 'consumption claim bytes');
  check(issuance.digest, profile.timeoutIssuanceSha256, 'issuance SHA-256');
  check(issuance.raw.byteLength, profile.timeoutIssuanceBytes, 'issuance bytes');
  check(sha256(issuance.sidecarRaw), profile.timeoutIssuanceSidecarSha256, 'issuance sidecar SHA-256');
  check(issuance.sidecarRaw.byteLength, profile.timeoutIssuanceSidecarBytes, 'issuance sidecar bytes');
  check(predecessorTree.tree_sha256, profile.predecessorEvidenceTreeSha256, 'predecessor evidence tree SHA-256');
  check(predecessorTree.files, profile.predecessorEvidenceTreeFiles, 'predecessor evidence tree files');
  check(predecessorTree.bytes, profile.predecessorEvidenceTreeBytes, 'predecessor evidence tree bytes');
  check(rearmReceipt.digest, profile.rearmReceiptSha256, 'rearm receipt SHA-256');
  check(rearmReceipt.raw.byteLength, profile.rearmReceiptBytes, 'rearm receipt bytes');
  check(rearmReservation.sha256, profile.rearmReservationClaimSha256, 'rearm reservation claim SHA-256');
  check(rearmTree.tree_sha256, profile.rearmEvidenceTreeSha256, 'rearm evidence tree SHA-256');
  check(rearmReceiptValue.repair_id, profile.rearmRepairId, 'rearm receipt repair ID');
  check(
    rearmReceiptValue.receipt_type,
    'curriculum_remote_ocr_preinference_interruption_rearm',
    'rearm receipt type',
  );
  check(rearmReceiptValue.status, 'prepared_atomic_apply_required', 'rearm receipt status');
  check(rearmReceiptValue.after_document_status_sha256, profile.rearmAfterStatusSha256, 'rearm after document status SHA-256');
  check(rearmReceiptValue.after_run_status_sha256, profile.rearmAfterRunStatusSha256, 'rearm after run status SHA-256');
  check(rearmReceiptValue.publication_claim?.sha256, profile.rearmReservationClaimSha256, 'rearm receipt reservation claim SHA-256');
  check(rearmReceiptValue.citation_allowed, false, 'rearm receipt citation gate');
  check(rearmTransaction.length, expectedRearmAfter.size, 'rearm transaction count');
  for (const [outputPath, expectedSha256] of expectedRearmAfter) {
    const matches = rearmTransaction.filter(({ output_path: candidate }) => candidate === outputPath);
    check(matches.length, 1, `rearm transaction ${outputPath} count`);
    check(matches[0]?.after?.sha256, expectedSha256, `rearm transaction ${outputPath} after SHA-256`);
  }
  if (mismatches.length > 0) {
    throw new Error(`frozen A2 authority artifact drift: ${mismatches.join(', ')}`);
  }
  return {
    seedCommit,
    seedJournal,
    ledger,
    issuance,
    predecessorTree,
    rearmReceipt,
    rearmReservation,
    rearmTree,
  };
}

async function loadExistingIncidentArchive(profile) {
  const paths = operatorContinuationPaths(profile.evidenceBaseRoot, profile.documentId, profile.attempt);
  const present = await lstat(paths.root).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (!present) return null;
  await requireStableDirectory(paths.root, 'existing continuation evidence', { mode: 0o700 });
  const [receiptRecord, runStatusRecord, statusRecord, stateRecord, logRecord, inventoryRecord] = await Promise.all([
    readStableFileWithSidecarRecord(paths.root, paths.receipt, 'existing continuation receipt'),
    readStableFileWithSidecarRecord(paths.root, paths.interruptedRunStatus, 'archived interrupted run status'),
    readStableFileWithSidecarRecord(paths.root, paths.interruptedStatus, 'archived interrupted document status'),
    readStableFileWithSidecarRecord(paths.root, paths.interruptedState, 'archived interrupted state'),
    readStableFileWithSidecarRecord(paths.root, paths.preContinuationLog, 'archived pre-continuation log'),
    readStableFileWithSidecarRecord(paths.root, paths.documentInventory, 'archived document inventory'),
  ]);
  const receipt = parseJson(receiptRecord.raw, 'existing continuation receipt');
  const inventory = parseJson(inventoryRecord.raw, 'archived document inventory');
  if (receipt.schema_version !== 2
    || receipt.receipt_type !== receiptType
    || receipt.mode !== continuationMode
    || receipt.profile_sha256 !== a2ForwardContinuationProfileFingerprint(profile)
    || receipt.output?.root !== profile.outputRoot
    || receipt.output?.device !== profile.outputDevice
    || receipt.output?.inode !== profile.outputInode
    || receipt.document?.document_id !== profile.documentId
    || receipt.document?.attempt !== profile.attempt
    || receipt.authorization?.worker_invocation_id !== profile.workerInvocationId
    || receipt.authorization?.interrupted_at !== profile.interruptedAt
    || receipt.citation_allowed !== false) {
    throw new Error('existing continuation receipt is not the frozen A2 incident');
  }
  const basis = { ...receipt };
  delete basis.continuation_id;
  if (receipt.continuation_id !== sha256(canonicalJson(basis))) {
    throw new Error('existing continuation receipt ID is invalid');
  }
  for (const [record, artifact, label] of [
    [runStatusRecord, receipt.interrupted_snapshot?.archives?.interrupted_run_status, 'run status'],
    [statusRecord, receipt.interrupted_snapshot?.archives?.interrupted_status, 'document status'],
    [stateRecord, receipt.interrupted_snapshot?.archives?.interrupted_state, 'state'],
    [logRecord, receipt.interrupted_snapshot?.archives?.pre_continuation_log, 'log'],
    [inventoryRecord, receipt.interrupted_snapshot?.document_inventory, 'document inventory'],
  ]) {
    if (record.sha256 !== artifact?.sha256 || record.bytes !== artifact?.bytes) {
      throw new Error(`archived ${label} differs from the continuation receipt`);
    }
  }
  if (inventory.schema_version !== 1
    || inventory.output_root !== profile.outputRoot
    || inventory.document_id !== profile.documentId
    || inventory.attempt !== profile.attempt
    || inventory.tree_sha256 !== profile.documentTreeSha256
    || inventory.files !== profile.documentTreeFiles
    || inventory.bytes !== profile.documentTreeBytes
    || !Array.isArray(inventory.entries)
    || !Array.isArray(inventory.directories)
    || inventory.state?.sha256 !== profile.stateSha256
    || inventory.log?.sha256 !== profile.logSha256
    || inventory.log?.bytes !== profile.logBytes
    || inventory.citation_allowed !== false) {
    throw new Error('archived document inventory is not the frozen A2 inventory');
  }
  return {
    paths,
    receipt,
    receiptRecord,
    runStatusRecord,
    statusRecord,
    stateRecord,
    logRecord,
    inventory,
    inventoryRecord,
  };
}

async function inspectInterruptedState(options, profile) {
  const outputRoot = await realpath(options.outputRoot);
  const inputRoot = await realpath(options.inputRoot);
  const incidentEvidenceRoot = await realpath(profile.incidentEvidenceRoot);
  const outputInfo = await requireOwnerDirectory(outputRoot, 'successor output root');
  const evidenceBase = await requireStableDirectory(profile.evidenceBaseRoot, 'A2 evidence base', {
    mode: 0o700,
    dev: profile.evidenceBaseDevice,
    ino: profile.evidenceBaseInode,
  });
  const incidentDirectory = await requireStableDirectory(incidentEvidenceRoot, 'operator incident evidence root', {
    mode: 0o700,
    dev: profile.incidentEvidenceDevice,
    ino: profile.incidentEvidenceInode,
    uid: profile.incidentEvidenceUid,
    gid: profile.incidentEvidenceGid,
  });
  if (outputRoot !== profile.outputRoot
    || String(outputInfo.dev) !== profile.outputDevice
    || String(outputInfo.ino) !== profile.outputInode) {
    throw new Error('successor output device/inode differs from the authorized A2 root');
  }
  if (isWithin(outputRoot, incidentEvidenceRoot) || isWithin(incidentEvidenceRoot, outputRoot)) {
    throw new Error('operator incident evidence root must be disjoint from the successor output root');
  }
  const manifestPath = await realpath(options.manifest);
  const manifestRaw = (await readStableFileRecord(
    path.dirname(manifestPath),
    manifestPath,
    'OCR manifest',
  )).raw;
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
  const archivedIncident = await loadExistingIncidentArchive(profile);
  const liveRecords = await Promise.all([
    readStrictFile(path.join(outputRoot, 'run-identity.json'), 'run identity'),
    readStrictFileWithSidecar(path.join(outputRoot, 'seed-receipt.json'), 'seed receipt'),
    readStrictFileWithSidecar(path.join(outputRoot, 'timeout-recovery-grant.json'), 'timeout recovery grant'),
    readStrictFileWithSidecar(
      path.join(outputRoot, 'timeout-recovery-consumption-claim.json'),
      'timeout recovery consumption claim',
    ),
  ]);
  const [identityRaw, seedReceiptEvidence, grantEvidence, consumptionEvidence] = liveRecords;
  const archivedPair = (record, originalBasename) => ({
    raw: record.raw,
    sidecarRaw: Buffer.from(`${record.sha256}  ${originalBasename}\n`),
    digest: record.sha256,
    bytes: record.bytes,
  });
  const [runStatusEvidence, statusEvidence, logRecord, stateRecord] = archivedIncident
    ? [
      archivedPair(archivedIncident.runStatusRecord, 'run-status.json'),
      archivedPair(archivedIncident.statusRecord, path.basename(statusPath)),
      {
        ...archivedIncident.logRecord,
        dev: archivedIncident.inventory.log.device,
        ino: archivedIncident.inventory.log.inode,
      },
      {
        ...archivedIncident.stateRecord,
        dev: archivedIncident.inventory.state.device,
        ino: archivedIncident.inventory.state.inode,
      },
    ]
    : await Promise.all([
      readStrictFileWithSidecar(runStatusPath, 'run status'),
      readStrictFileWithSidecar(statusPath, 'document status'),
      readStableFileRecord(outputRoot, logPath, 'document log'),
      readStableFileRecord(outputRoot, statePath, 'document state'),
    ]);
  if (runStatusEvidence.digest !== profile.runStatusSha256) throw new Error('run status SHA-256 drifted');
  if (statusEvidence.digest !== profile.documentStatusSha256) throw new Error('document status SHA-256 drifted');
  const logRaw = logRecord.raw;
  const stateRawBefore = stateRecord.raw;
  if (logRecord.sha256 !== profile.logSha256) throw new Error('document log SHA-256 drifted');
  if (logRecord.bytes !== profile.logBytes) throw new Error('document log byte count drifted');
  if (stateRecord.sha256 !== profile.stateSha256) throw new Error('document state SHA-256 drifted');
  if (grantEvidence.digest !== profile.timeoutGrantSha256) throw new Error('timeout recovery grant SHA-256 drifted');
  if (consumptionEvidence.digest !== profile.timeoutConsumptionClaimSha256) {
    throw new Error('timeout recovery consumption claim SHA-256 drifted');
  }
  const [liveDocumentTree, incidentTree, stateRawAfter] = await Promise.all([
    archivedIncident ? Promise.resolve(null) : inspectTreeStrict(documentRoot),
    inspectTreeStrict(incidentEvidenceRoot),
    archivedIncident ? Promise.resolve(stateRawBefore) : readStrictFile(statePath, 'document state recheck'),
  ]);
  const documentTree = archivedIncident ? {
    tree_sha256: archivedIncident.inventory.tree_sha256,
    files: archivedIncident.inventory.files,
    bytes: archivedIncident.inventory.bytes,
    entries: archivedIncident.inventory.entries,
  } : liveDocumentTree;
  if (!stateRawBefore.equals(stateRawAfter)) throw new Error('document state changed during inspection');
  if (documentTree.tree_sha256 !== profile.documentTreeSha256
    || documentTree.files !== profile.documentTreeFiles
    || documentTree.bytes !== profile.documentTreeBytes) {
    throw new Error('document tree differs from the authorized exact inventory');
  }
  if (incidentTree.tree_sha256 !== profile.incidentEvidenceTreeSha256) {
    throw new Error('operator incident evidence tree SHA-256 drifted');
  }
  const authorityArtifacts = await verifyExactAuthorityArtifacts({
    outputRoot,
    profile,
    identityRaw,
    seedReceiptEvidence,
    grantEvidence,
    consumptionEvidence,
  });

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
    || status.interrupted_at !== profile.interruptedAt) {
    throw new Error('document status is not the exact authorized interrupted attempt 6');
  }
  if (progress.status !== 'interrupted'
    || progress.attempts !== attemptCeiling
    || progress.attempt_ceiling !== attemptCeiling
    || progress.inherited_attempts !== 5
    || progress.signal !== interruptionSignal
    || progress.interrupted_at !== profile.interruptedAt
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
  const directoryIdentities = archivedIncident
    ? archivedIncident.inventory.directories
    : await captureDirectoryIdentities(documentRoot, documentTree);
  const documentInventory = {
    schema_version: 1,
    output_root: outputRoot,
    document_id: profile.documentId,
    attempt: profile.attempt,
    tree_sha256: documentTree.tree_sha256,
    files: documentTree.files,
    bytes: documentTree.bytes,
    entries: documentTree.entries,
    directories: directoryIdentities,
    state: {
      sha256: stateRecord.sha256,
      bytes: stateRecord.bytes,
      device: stateRecord.dev,
      inode: stateRecord.ino,
    },
    log: {
      sha256: logRecord.sha256,
      bytes: logRecord.bytes,
      device: logRecord.dev,
      inode: logRecord.ino,
    },
    citation_allowed: false,
  };
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
    schema_version: 2,
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
      interrupted_at: profile.interruptedAt,
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
      worker_invocation_id: profile.workerInvocationId,
      interrupted_at: profile.interruptedAt,
      authorized_at: options.authorizedAt,
      incident_evidence_root: incidentEvidenceRoot,
      incident_evidence_tree_sha256: incidentTree.tree_sha256,
      base_runner_path: baseRunnerPath,
      base_runner_sha256: profile.baseRunnerSha256,
    },
    timeout_recovery: {
      seed_id: identitySeed.seed_id,
      grant_id: grant.grant_id,
      grant_sha256: profile.timeoutGrantSha256,
      consumption_claim_sha256: profile.timeoutConsumptionClaimSha256,
      inherited_attempts: 5,
      granted_attempt: attemptCeiling,
      automatic_attempt_7: false,
    },
    interrupted_snapshot: {
      archives,
      document_inventory: {
        path: 'document-inventory.json',
        sha256: sha256(prettyJson(documentInventory)),
        bytes: prettyJson(documentInventory).byteLength,
      },
      run_status_sha256: runStatusEvidence.digest,
      status_sha256: statusEvidence.digest,
      document_progress: structuredClone(progress),
      document_status: structuredClone(status),
    },
    profile_sha256: a2ForwardContinuationProfileFingerprint(profile),
    citation_allowed: false,
  };
  const receipt = {
    ...receiptBasis,
    continuation_id: sha256(canonicalJson(receiptBasis)),
  };
  return {
    archives,
    archivedIncident,
    authorityArtifacts,
    consumptionClaim,
    document,
    documentRoot,
    documentTree,
    documentInventory,
    directoryIdentities,
    grant,
    identity,
    identityRaw,
    inputRoot,
    logPath,
    logRaw,
    logRecord,
    manifest,
    manifestPath,
    manifestRaw,
    outputInfo,
    outputRoot,
    evidenceBase,
    incidentDirectory,
    progress,
    receipt,
    receiptDocument,
    runStatus,
    runStatusEvidence,
    runStatusPath,
    seedReceipt,
    statePath,
    stateRaw: stateRawBefore,
    stateRecord,
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

async function publishReceipt(inspected, options, profile) {
  const paths = operatorContinuationPaths(profile.evidenceBaseRoot, options.documentId, options.attempt);
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
      'document-inventory.json',
      'document-inventory.json.sha256',
      'states',
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
      [paths.documentInventory, prettyJson(inspected.documentInventory), 'archived document inventory'],
    ]) {
      const evidence = await readStrictFileWithSidecar(pathname, label);
      if (!evidence.raw.equals(raw)) throw new Error(`${label} differs from the authorized incident`);
    }
    return { paths, receiptRaw, receiptSha256: existing.digest, existing: true };
  }
  await ensureOwnerDirectory(paths.parent);
  await ensureOwnerDirectory(paths.documentParent);
  const temporary = path.join(paths.documentParent, `.attempt-0006.tmp-${process.pid}-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    await Promise.all([
      writeEvidenceFile(temporary, 'interrupted-run-status.json', inspected.runStatusEvidence.raw),
      writeEvidenceFile(temporary, 'interrupted-status.json', inspected.statusEvidence.raw),
      writeEvidenceFile(temporary, 'interrupted-state.json', inspected.stateRaw),
      writeEvidenceFile(temporary, 'pre-continuation.log', inspected.logRaw),
      writeEvidenceFile(temporary, 'document-inventory.json', prettyJson(inspected.documentInventory)),
      writeEvidenceFile(temporary, 'receipt.json', receiptRaw),
    ]);
    await mkdir(path.join(temporary, 'states'), { mode: 0o700 });
    await syncDirectory(path.join(temporary, 'states'));
    await syncDirectory(temporary);
    await rename(temporary, paths.root);
    await syncDirectory(paths.documentParent);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { paths, receiptRaw, receiptSha256: sha256(receiptRaw), existing: false };
}

async function recoverHashBoundPair(root, pathname, raw, label, dependencies = {}) {
  const sidecarPath = `${pathname}.sha256`;
  const sidecarRaw = Buffer.from(`${sha256(raw)}  ${path.basename(pathname)}\n`);
  const claimPresent = await lstat(pathname).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  const sidecarPresent = await lstat(sidecarPath).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (claimPresent) {
    const current = await readStableFileRecord(root, pathname, label);
    if (!current.raw.equals(raw)) throw new Error(`${label} differs from the deterministic incident`);
  }
  if (sidecarPresent) {
    const current = await readStableFileRecord(root, sidecarPath, `${label} SHA-256 sidecar`);
    if (!current.raw.equals(sidecarRaw)) throw new Error(`${label} SHA-256 sidecar differs from the deterministic incident`);
  }
  if (!claimPresent && !sidecarPresent) {
    await writeDurableFile(pathname, raw);
    await dependencies.afterBody?.(pathname);
    await writeDurableFile(sidecarPath, sidecarRaw);
  } else if (claimPresent && !sidecarPresent) {
    await writeDurableFile(sidecarPath, sidecarRaw);
  } else if (!claimPresent && sidecarPresent) {
    await writeDurableFile(pathname, raw);
  }
  await syncDirectory(root);
  const verified = await readStableFileWithSidecarRecord(root, pathname, label);
  if (!verified.raw.equals(raw)) throw new Error(`${label} recovery did not converge`);
  return { raw, sha256: verified.sha256, sidecarRaw };
}

async function publishClaim(inspected, published, options, profile, dependencies = {}) {
  const evidenceInfo = await lstat(published.paths.root, { bigint: true });
  if (!evidenceInfo.isDirectory() || evidenceInfo.isSymbolicLink()) {
    throw new Error('operator continuation evidence root identity is invalid');
  }
  const claimBasis = {
    schema_version: 2,
    claim_type: claimType,
    mode: continuationMode,
    continuation_id: inspected.receipt.continuation_id,
    receipt_sha256: published.receiptSha256,
    output: structuredClone(inspected.receipt.output),
    evidence_root: {
      path: published.paths.root,
      device: String(evidenceInfo.dev),
      inode: String(evidenceInfo.ino),
    },
    document_id: options.documentId,
    attempt: attemptCeiling,
    claimed_at: options.continuedAt,
    timeout_recovery_grant_id: inspected.grant.grant_id,
    profile_sha256: a2ForwardContinuationProfileFingerprint(profile),
    timeout_recovery_grant_sha256: profile.timeoutGrantSha256,
    timeout_recovery_consumption_claim_sha256: profile.timeoutConsumptionClaimSha256,
    citation_allowed: false,
  };
  const claim = { ...claimBasis, claim_id: sha256(canonicalJson(claimBasis)) };
  const raw = prettyJson(claim);
  const recovered = await recoverHashBoundPair(
    published.paths.root,
    published.paths.claim,
    raw,
    'operator continuation claim',
    { afterBody: dependencies.afterClaimBody },
  );
  return { claim, ...recovered };
}

async function inspectSystemdUnit(unit, role) {
  const { stdout } = await execFile('systemctl', [
    '--user',
    'show',
    unit,
    '--property=LoadState',
    '--property=ActiveState',
    '--property=SubState',
    '--property=MainPID',
    '--property=InvocationID',
    '--property=ExecMainStatus',
    ...systemdGenerationProperties.map((property) => `--property=${property}`),
    ...(role.endsWith('_timer') ? ['--property=LastTriggerUSecMonotonic'] : []),
    '--no-pager',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 });
  const values = {};
  for (const line of String(stdout).trim().split('\n')) {
    const delimiter = line.indexOf('=');
    if (delimiter < 1) throw new Error(`${unit}: systemd show output is invalid`);
    const key = line.slice(0, delimiter);
    if (Object.hasOwn(values, key)) throw new Error(`${unit}: duplicate systemd property ${key}`);
    values[key] = line.slice(delimiter + 1);
  }
  const baselineProperties = role.endsWith('_timer')
    ? ['LoadState', 'ActiveState', 'SubState', 'InvocationID']
    : ['LoadState', 'ActiveState', 'SubState', 'MainPID', 'InvocationID', 'ExecMainStatus'];
  const generationProperties = [
    ...systemdGenerationProperties,
    ...(role.endsWith('_timer') ? ['LastTriggerUSecMonotonic'] : []),
  ];
  const expectedProperties = [...baselineProperties, ...generationProperties].sort();
  if (!sameJson(Object.keys(values).sort(), expectedProperties)) {
    throw new Error(`${unit}: systemd show property set is invalid`);
  }
  const baseline = parseSystemdShow(
    `${baselineProperties.map((property) => `${property}=${values[property]}`).join('\n')}\n`,
    unit,
    role,
  );
  const generation = Object.fromEntries(generationProperties.map((property) => {
    if (!/^(?:0|[1-9]\d*)$/u.test(values[property])) {
      throw new Error(`${unit}: systemd generation property ${property} is invalid`);
    }
    return [property, values[property]];
  }));
  return { ...baseline, Generation: generation };
}

function requireUnitGeneration(state, unit, role) {
  const generation = requireObject(state.Generation, `${unit} systemd generation`);
  const expectedProperties = [
    ...systemdGenerationProperties,
    ...(role.endsWith('_timer') ? ['LastTriggerUSecMonotonic'] : []),
  ];
  if (!sameJson(Object.keys(generation).sort(), [...expectedProperties].sort())) {
    throw new Error(`${unit} systemd generation property set is invalid`);
  }
  for (const property of expectedProperties) {
    if (!/^(?:0|[1-9]\d*)$/u.test(String(generation[property] || ''))) {
      throw new Error(`${unit} systemd generation property ${property} is invalid`);
    }
  }
  return generation;
}

function requireQuiescentUnit(state, unit, role) {
  requireUnitGeneration(state, unit, role);
  const expectedSubState = state.ActiveState === 'inactive' ? 'dead' : 'failed';
  if (state.LoadState !== 'loaded'
    || !['inactive', 'failed'].includes(state.ActiveState)
    || state.SubState !== expectedSubState
    || (role.endsWith('_timer') ? state.InvocationID !== '' : state.MainPID !== '0')) {
    throw new Error(`${unit} is not quiescent`);
  }
}

function continuationUnitFence(snapshot) {
  return Object.fromEntries(continuationFenceRoles.map((role) => {
    const state = snapshot[role];
    if (!state) throw new Error(`A2 ${role} unit is missing from the quiescent fence`);
    const service = !role.endsWith('_timer');
    return [role, {
      unit: state.unit,
      load_state: state.LoadState,
      active_state: state.ActiveState,
      sub_state: state.SubState,
      invocation_id: state.InvocationID,
      ...(service ? {
        main_pid: state.MainPID,
        exec_main_status: state.ExecMainStatus,
      } : {}),
      generation: structuredClone(requireUnitGeneration(state, state.unit, role)),
    }];
  }));
}

function requireSameContinuationUnitFence(snapshot, frozen) {
  const current = continuationUnitFence(snapshot);
  if (!sameJson(current, frozen)) {
    throw new Error('A2 worker/monitor/timer/alert InvocationID or generation fence changed');
  }
  return current;
}

export async function inspectA2ContinuationUnits(profile, dependencies = {}) {
  const inspectUnit = dependencies.inspectUnit || inspectSystemdUnit;
  const roles = [
    ['worker', profile.workerUnit],
    ['monitor', profile.monitorUnit],
    ['monitor_timer', profile.monitorTimerUnit],
    ['alert', profile.alertUnit],
    ['llama', profile.llamaUnit],
  ];
  const result = {};
  for (const [role, unit] of roles) {
    const state = await inspectUnit(unit, role);
    requireQuiescentUnit(state, unit, role);
    result[role] = { unit, ...state };
  }
  if (result.worker.InvocationID !== profile.workerInvocationId
    || result.worker.ExecMainStatus !== '75') {
    throw new Error('worker InvocationID or exit status differs from the frozen A2 interruption');
  }
  return result;
}

async function startExactLlama(profile, dependencies = {}) {
  if (dependencies.startLlama) return dependencies.startLlama(profile.llamaUnit);
  await execFile('systemctl', ['--user', 'start', profile.llamaUnit], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
  });
  return undefined;
}

async function stopExactLlama(profile, dependencies = {}) {
  if (dependencies.stopLlama) return dependencies.stopLlama(profile.llamaUnit);
  await execFile('systemctl', ['--user', 'stop', profile.llamaUnit], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
  });
  return undefined;
}

async function inspectActiveLlama(profile, expectedInvocationId, dependencies = {}) {
  const inspectUnit = dependencies.inspectUnit || inspectSystemdUnit;
  const state = await inspectUnit(profile.llamaUnit, 'llama');
  if (state.LoadState !== 'loaded'
    || state.ActiveState !== 'active'
    || state.SubState !== 'running'
    || !/^[1-9]\d*$/u.test(state.MainPID)
    || !invocationIdPattern.test(state.InvocationID)
    || (expectedInvocationId && state.InvocationID !== expectedInvocationId)) {
    throw new Error('A2 llama unit is not the exact active invocation');
  }
  return { unit: profile.llamaUnit, ...state };
}

async function inspectContinuationFenceUnits(profile, dependencies = {}) {
  const inspectUnit = dependencies.inspectUnit || inspectSystemdUnit;
  const result = {};
  for (const [role, unit] of [
    ['worker', profile.workerUnit],
    ['monitor', profile.monitorUnit],
    ['monitor_timer', profile.monitorTimerUnit],
    ['alert', profile.alertUnit],
  ]) {
    const state = await inspectUnit(unit, role);
    requireQuiescentUnit(state, unit, role);
    result[role] = { unit, ...state };
  }
  if (result.worker.InvocationID !== profile.workerInvocationId
    || result.worker.ExecMainStatus !== '75') {
    throw new Error('worker provenance changed during forward continuation');
  }
  return result;
}

async function inspectPreSpawnUnits(profile, activeLlama, dependencies = {}) {
  const result = await inspectContinuationFenceUnits(profile, dependencies);
  result.llama = await inspectActiveLlama(profile, activeLlama.InvocationID, dependencies);
  return result;
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

async function captureDirectoryIdentities(documentRoot, inventory) {
  const relatives = ['', ...inventory.entries
    .filter((entry) => entry.startsWith('D\0'))
    .map((entry) => entry.replace(/\n$/u, '').split('\0')[1])];
  const identities = [];
  for (const relative of relatives) {
    const pathname = relative ? path.join(documentRoot, relative) : documentRoot;
    const resolved = await realpath(pathname);
    if (resolved !== path.resolve(pathname)) throw new Error(`document directory traverses a symbolic link: ${relative || '.'}`);
    const info = await lstat(pathname, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`document directory identity is invalid: ${relative || '.'}`);
    }
    identities.push({
      path: relative || '.',
      device: String(info.dev),
      inode: String(info.ino),
      mode: (Number(info.mode) & 0o7777).toString(8).padStart(4, '0'),
      uid: String(info.uid),
      gid: String(info.gid),
    });
  }
  return identities;
}

async function verifyDirectoryIdentities(documentRoot, identities) {
  for (const identity of identities) {
    const pathname = identity.path === '.' ? documentRoot : path.join(documentRoot, identity.path);
    const info = await lstat(pathname, { bigint: true }).catch((error) => {
      if (error?.code === 'ENOENT') throw new Error(`pre-existing directory was removed: ${identity.path}`);
      throw error;
    });
    if (!info.isDirectory()
      || info.isSymbolicLink()
      || String(info.dev) !== identity.device
      || String(info.ino) !== identity.inode
      || (Number(info.mode) & 0o7777).toString(8).padStart(4, '0') !== identity.mode
      || String(info.uid) !== identity.uid
      || String(info.gid) !== identity.gid) {
      throw new Error(`pre-existing directory identity changed: ${identity.path}`);
    }
  }
}

async function verifyForwardOnlyDocument(inspected) {
  const { documentTree: beforeInventory, documentRoot } = inspected;
  await verifyDirectoryIdentities(documentRoot, inspected.directoryIdentities);
  const after = await inspectTreeStrict(documentRoot);
  const beforeEntries = forwardOnlyEntryMap(beforeInventory.entries);
  const afterEntries = forwardOnlyEntryMap(after.entries);
  for (const entry of beforeInventory.entries) {
    const parts = entry.replace(/\n$/u, '').split('\0');
    const pathname = parts[1];
    if (pathname === 'state.json') continue;
    if (afterEntries.get(pathname) !== entry) {
      throw new Error(`continuation changed or removed pre-existing document evidence: ${pathname}`);
    }
  }
  const preexistingPageDirectories = new Set(
    beforeInventory.entries
      .filter((entry) => entry.startsWith('D\0pages/'))
      .map((entry) => entry.replace(/\n$/u, '').split('\0')[1])
      .filter((pathname) => /^pages\/\d{4}$/u.test(pathname)),
  );
  for (const [pathname] of afterEntries) {
    if (beforeEntries.has(pathname)) continue;
    const parts = pathname.split('/');
    if (parts.some((part) => part.length === 0 || part === '..' || part.startsWith('.'))) {
      throw new Error(`continuation left a hidden, staging, or unsafe path: ${pathname}`);
    }
    const match = /^pages\/(\d{4})(?:\/(.*))?$/u.exec(pathname);
    if (!match) throw new Error(`continuation created a path outside a new page: ${pathname}`);
    const page = Number(match[1]);
    if (page < 1 || page > inspected.document.page_count) {
      throw new Error(`continuation created an out-of-range page path: ${pathname}`);
    }
    const pageRoot = `pages/${match[1]}`;
    if (preexistingPageDirectories.has(pageRoot)) {
      throw new Error(`continuation added evidence inside a pre-existing page: ${pathname}`);
    }
    if (match[2]) {
      const first = match[2].split('/')[0];
      if (!['result.json', 'content.md', 'markdown', 'visual'].includes(first)) {
        throw new Error(`continuation created an unrecognized page artifact path: ${pathname}`);
      }
      if (['result.json', 'content.md'].includes(first) && match[2] !== first) {
        throw new Error(`continuation nested content beneath a page file: ${pathname}`);
      }
    }
  }
  const log = await readStableFileRecord(inspected.outputRoot, inspected.logPath, 'continued document log');
  if (log.dev !== inspected.logRecord.dev
    || log.ino !== inspected.logRecord.ino
    || log.bytes < inspected.logRecord.bytes
    || !log.raw.subarray(0, inspected.logRecord.bytes).equals(inspected.logRaw)) {
    throw new Error('document log was replaced, truncated, or lost its immutable prefix');
  }
  return { after, log };
}

async function verifyFrozenPreSpawnSnapshot(inspected, profile) {
  const [output, evidence, incident, lifecycle, runStatus, status, state, log, grant, claim] = await Promise.all([
    requireStableDirectory(inspected.outputRoot, 'successor output root', {
      dev: profile.outputDevice,
      ino: profile.outputInode,
    }),
    requireStableDirectory(profile.evidenceBaseRoot, 'A2 evidence base', {
      mode: 0o700,
      dev: profile.evidenceBaseDevice,
      ino: profile.evidenceBaseInode,
    }),
    requireStableDirectory(profile.incidentEvidenceRoot, 'operator incident evidence root', {
      mode: 0o700,
      dev: profile.incidentEvidenceDevice,
      ino: profile.incidentEvidenceInode,
    }),
    lstat(profile.lifecycleLock, { bigint: true }),
    readStrictFileWithSidecar(inspected.runStatusPath, 'pre-spawn run status'),
    readStrictFileWithSidecar(inspected.statusPath, 'pre-spawn document status'),
    readStableFileRecord(inspected.outputRoot, inspected.statePath, 'pre-spawn document state'),
    readStableFileRecord(inspected.outputRoot, inspected.logPath, 'pre-spawn document log'),
    readStrictFileWithSidecar(path.join(inspected.outputRoot, 'timeout-recovery-grant.json'), 'pre-spawn timeout grant'),
    readStrictFileWithSidecar(
      path.join(inspected.outputRoot, 'timeout-recovery-consumption-claim.json'),
      'pre-spawn timeout claim',
    ),
  ]);
  void output;
  void evidence;
  void incident;
  if (!lifecycle.isFile()
    || lifecycle.isSymbolicLink()
    || String(lifecycle.ino) !== profile.lifecycleLockInode) {
    throw new Error('shared lifecycle lock inode changed');
  }
  if (runStatus.digest !== profile.runStatusSha256
    || status.digest !== profile.documentStatusSha256
    || state.sha256 !== profile.stateSha256
    || log.sha256 !== profile.logSha256
    || log.bytes !== profile.logBytes
    || log.dev !== inspected.logRecord.dev
    || log.ino !== inspected.logRecord.ino
    || grant.digest !== profile.timeoutGrantSha256
    || claim.digest !== profile.timeoutConsumptionClaimSha256) {
    throw new Error('frozen output or authority provenance changed immediately before OCR spawn');
  }
  await verifyDirectoryIdentities(inspected.documentRoot, inspected.directoryIdentities);
}

function cleanProgress(progress) {
  for (const key of [
    'interrupted_at',
    'signal',
    'failure_class',
    'error',
    'next_retry_at',
    'quarantine_reason',
    'quarantined_at',
    'completed_at',
  ]) delete progress[key];
}

function terminalControlPlan(inspected, options, outcome, timestamp, details = {}) {
  const runStatus = structuredClone(inspected.runStatus);
  const progress = runStatus.documents[options.documentId];
  cleanProgress(progress);
  progress.status = outcome;
  const common = {
    schema_version: 1,
    document_id: options.documentId,
    status: outcome,
    attempt: attemptCeiling,
    max_attempts: attemptCeiling,
    page_count: inspected.document.page_count,
    runtime_fingerprint_sha256: inspected.identity.runtime_fingerprint_sha256,
    citation_allowed: false,
    ...continuationStatusSeedLineage(inspected.identity, progress, inspected.receiptDocument),
  };
  let status;
  let exitCode;
  if (outcome === 'complete') {
    progress.completed_at = timestamp;
    status = {
      ...common,
      source_sha256: details.source.sourceSha256,
      page_count: details.source.pageCount,
      whole_document_atomic: true,
      artifacts: details.artifacts,
      completed_at: timestamp,
    };
    exitCode = 0;
  } else if (outcome === 'interrupted') {
    progress.interrupted_at = timestamp;
    progress.signal = details.signal || interruptionSignal;
    status = { ...common, interrupted_at: timestamp };
    exitCode = 75;
  } else if (outcome === 'failed') {
    progress.failure_class = 'shared_runtime_configuration';
    progress.failed_at = timestamp;
    progress.error = details.error;
    status = {
      ...common,
      failure_class: 'shared_runtime_configuration',
      error: details.error,
      failed_at: timestamp,
    };
    exitCode = 2;
  } else if (outcome === 'quarantined') {
    progress.quarantined_at = timestamp;
    progress.quarantine_reason = 'attempt_budget_exhausted';
    progress.error = details.error;
    status = {
      ...common,
      quarantine_reason: 'attempt_budget_exhausted',
      error: details.error,
      quarantined_at: timestamp,
    };
    exitCode = 12;
  } else {
    throw new Error(`unsupported continuation terminal outcome: ${outcome}`);
  }
  const statusRaw = prettyJson(status);
  const statusSidecarRaw = Buffer.from(`${sha256(statusRaw)}  ${path.basename(inspected.statusPath)}\n`);
  progress.status_json_sha256 = sha256(statusRaw);
  refreshRunStatus(runStatus, timestamp);
  const runStatusRaw = prettyJson(runStatus);
  const runStatusSidecarRaw = Buffer.from(`${sha256(runStatusRaw)}  run-status.json\n`);
  const records = [
    {
      output_path: path.relative(inspected.outputRoot, inspected.statusPath),
      pathname: inspected.statusPath,
      before: inspected.statusEvidence.raw,
      after: statusRaw,
    },
    {
      output_path: path.relative(inspected.outputRoot, `${inspected.statusPath}.sha256`),
      pathname: `${inspected.statusPath}.sha256`,
      before: inspected.statusEvidence.sidecarRaw,
      after: statusSidecarRaw,
    },
    {
      output_path: 'run-status.json',
      pathname: inspected.runStatusPath,
      before: inspected.runStatusEvidence.raw,
      after: runStatusRaw,
    },
    {
      output_path: 'run-status.json.sha256',
      pathname: `${inspected.runStatusPath}.sha256`,
      before: inspected.runStatusEvidence.sidecarRaw,
      after: runStatusSidecarRaw,
    },
  ];
  return {
    outcome,
    exitCode,
    timestamp,
    transaction: records.map((record) => ({
      output_path: record.output_path,
      before_sha256: sha256(record.before),
      before_bytes: record.before.byteLength,
      after_sha256: sha256(record.after),
      after_bytes: record.after.byteLength,
      after_base64: record.after.toString('base64'),
    })),
  };
}

async function scanJournal(paths, claim) {
  await requireStableDirectory(paths.states, 'operator continuation state journal', { mode: 0o700 });
  const names = (await readdir(paths.states)).sort();
  if (names.some((name) => !/^\d{6}-[a-z][a-z0-9_-]*\.json(?:\.sha256)?$/u.test(name))) {
    throw new Error('operator continuation state journal contains an unexpected entry');
  }
  const stems = [...new Set(names.map((name) => name.replace(/\.sha256$/u, '')))];
  const states = [];
  let previousSha256 = null;
  let incomplete = null;
  for (let index = 0; index < stems.length; index += 1) {
    const stem = stems[index];
    if (!stem.startsWith(`${String(index + 1).padStart(6, '0')}-`)) {
      throw new Error('operator continuation state journal sequence is not contiguous');
    }
    const bodyPresent = names.includes(stem);
    const sidecarPresent = names.includes(`${stem}.sha256`);
    if (!bodyPresent || !sidecarPresent) {
      if (index !== stems.length - 1 || incomplete) {
        throw new Error('operator continuation state journal has a non-terminal partial pair');
      }
      incomplete = { stem, bodyPresent, sidecarPresent };
      continue;
    }
    const record = await readStableFileWithSidecarRecord(
      paths.states,
      path.join(paths.states, stem),
      'operator continuation state',
    );
    const value = parseJson(record.raw, 'operator continuation state');
    if (value.schema_version !== 1
      || value.sequence !== index + 1
      || value.continuation_id !== claim.claim.continuation_id
      || value.claim_id !== claim.claim.claim_id
      || value.previous_state_sha256 !== previousSha256
      || stem !== `${String(index + 1).padStart(6, '0')}-${value.stage}.json`
      || value.citation_allowed !== false) {
      throw new Error('operator continuation state journal hash chain is invalid');
    }
    states.push({ stem, value, sha256: record.sha256 });
    previousSha256 = record.sha256;
  }
  return { states, incomplete, previousSha256 };
}

function requireExactStateKeys(value, extraKeys, label) {
  const common = [
    'schema_version',
    'sequence',
    'continuation_id',
    'claim_id',
    'stage',
    'previous_state_sha256',
    'citation_allowed',
  ];
  if (!sameJson(Object.keys(value).sort(), [...common, ...extraKeys].sort())) {
    throw new Error(`${label} contains missing or unexpected keys`);
  }
}

function validateJournalProgression(states, claim, expectedUnitFence) {
  if (states.length === 0) return { executionStates: [], terminalPlan: null, terminal: null };
  const claimed = states[0];
  requireExactStateKeys(
    claimed.value,
    ['claimed_at', 'worker_invocation_id', 'quiescent_unit_fence'],
    'operator continuation claimed state',
  );
  if (claimed.value.stage !== 'claimed'
    || claimed.value.claimed_at !== claim.claim.claimed_at
    || !invocationIdPattern.test(String(claimed.value.worker_invocation_id || ''))
    || !sameJson(claimed.value.quiescent_unit_fence, expectedUnitFence)) {
    throw new Error('operator continuation claimed state or unit fence is invalid');
  }
  const executionStates = [];
  let index = 1;
  if (states[index]) {
    const running = states[index];
    requireExactStateKeys(
      running.value,
      ['started_at', 'llama_invocation_id', 'llama_main_pid'],
      'operator continuation running state',
    );
    if (running.value.stage !== 'running'
      || running.value.started_at !== claim.claim.claimed_at
      || !invocationIdPattern.test(String(running.value.llama_invocation_id || ''))
      || !/^[1-9]\d*$/u.test(String(running.value.llama_main_pid || ''))) {
      throw new Error('operator continuation running state is invalid');
    }
    executionStates.push(running);
    index += 1;
  }
  const invocationIds = new Set(executionStates.map(({ value }) => value.llama_invocation_id));
  let resumeOrdinal = 1;
  while (states[index] && /^resume_running_\d{4}$/u.test(states[index].value.stage)) {
    const resumed = states[index];
    const expectedStage = `resume_running_${String(resumeOrdinal).padStart(4, '0')}`;
    requireExactStateKeys(
      resumed.value,
      ['resumed_at', 'llama_invocation_id', 'llama_main_pid', 'resumed_from_state_sha256'],
      `operator continuation ${expectedStage} state`,
    );
    const predecessor = executionStates.at(-1);
    const predecessorTimestamp = predecessor?.value.resumed_at || predecessor?.value.started_at;
    if (resumed.value.stage !== expectedStage
      || !predecessor
      || resumed.value.resumed_from_state_sha256 !== predecessor.sha256
      || !invocationIdPattern.test(String(resumed.value.llama_invocation_id || ''))
      || invocationIds.has(resumed.value.llama_invocation_id)
      || !/^[1-9]\d*$/u.test(String(resumed.value.llama_main_pid || ''))) {
      throw new Error('operator continuation resume_running chain is invalid');
    }
    requireCanonicalTimestamp(resumed.value.resumed_at, 'operator continuation resume time');
    if (Date.parse(resumed.value.resumed_at) < Date.parse(predecessorTimestamp)) {
      throw new Error('operator continuation resume_running chronology is invalid');
    }
    invocationIds.add(resumed.value.llama_invocation_id);
    executionStates.push(resumed);
    resumeOrdinal += 1;
    index += 1;
  }
  let terminalPlan = null;
  if (states[index]) {
    terminalPlan = states[index];
    requireExactStateKeys(
      terminalPlan.value,
      ['outcome', 'exit_code', 'terminal_at', 'transaction'],
      'operator continuation terminal_plan state',
    );
    if (terminalPlan.value.stage !== 'terminal_plan' || executionStates.length === 0) {
      throw new Error('operator continuation terminal_plan ordering is invalid');
    }
    requireCanonicalTimestamp(terminalPlan.value.terminal_at, 'operator continuation terminal plan time');
    const lastExecutionTimestamp = executionStates.at(-1).value.resumed_at
      || executionStates.at(-1).value.started_at;
    if (Date.parse(terminalPlan.value.terminal_at) < Date.parse(lastExecutionTimestamp)) {
      throw new Error('operator continuation terminal plan predates its execution state');
    }
    index += 1;
  }
  let terminal = null;
  if (states[index]) {
    terminal = states[index];
    requireExactStateKeys(
      terminal.value,
      ['outcome', 'exit_code', 'terminal_at', 'terminal_plan_state_sha256'],
      'operator continuation terminal state',
    );
    if (terminal.value.stage !== 'terminal' || !terminalPlan) {
      throw new Error('operator continuation terminal ordering is invalid');
    }
    index += 1;
  }
  if (index !== states.length) throw new Error('operator continuation state journal stages are invalid');
  return { executionStates, terminalPlan, terminal };
}

async function recoverTrailingJournalPair(paths, claim, expectedUnitFence) {
  let scanned = await scanJournal(paths, claim);
  if (!scanned.incomplete) {
    validateJournalProgression(scanned.states, claim, expectedUnitFence);
    return scanned;
  }
  if (!scanned.incomplete.bodyPresent) {
    throw new Error('operator continuation trailing sidecar has no recoverable journal body');
  }
  const pathname = path.join(paths.states, scanned.incomplete.stem);
  const body = await readStableFileRecord(paths.states, pathname, 'partial operator continuation state');
  const value = parseJson(body.raw, 'partial operator continuation state');
  const candidate = {
    stem: scanned.incomplete.stem,
    value,
    sha256: body.sha256,
  };
  validateJournalProgression([...scanned.states, candidate], claim, expectedUnitFence);
  await recoverHashBoundPair(
    paths.states,
    pathname,
    body.raw,
    'partial operator continuation state',
  );
  scanned = await scanJournal(paths, claim);
  validateJournalProgression(scanned.states, claim, expectedUnitFence);
  return scanned;
}

async function appendJournalState(paths, claim, stage, payload, dependencies = {}) {
  if (!/^[a-z][a-z0-9_-]*$/u.test(stage)) throw new Error('continuation journal stage is invalid');
  const scanned = await scanJournal(paths, claim);
  if (dependencies.expectedUnitFence) {
    validateJournalProgression(scanned.states, claim, dependencies.expectedUnitFence);
  }
  const existing = scanned.states.find(({ value }) => value.stage === stage);
  if (existing) {
    const expectedPayload = { ...existing.value };
    for (const key of ['schema_version', 'sequence', 'continuation_id', 'claim_id', 'stage', 'previous_state_sha256', 'citation_allowed']) {
      delete expectedPayload[key];
    }
    if (!sameJson(expectedPayload, payload)) {
      throw new Error(`existing ${stage} continuation state differs from the deterministic recovery plan`);
    }
    return existing;
  }
  const sequence = scanned.states.length + 1;
  const stem = `${String(sequence).padStart(6, '0')}-${stage}.json`;
  if (scanned.incomplete && scanned.incomplete.stem !== stem) {
    throw new Error('partial continuation state does not match the next deterministic stage');
  }
  const value = {
    schema_version: 1,
    sequence,
    continuation_id: claim.claim.continuation_id,
    claim_id: claim.claim.claim_id,
    stage,
    previous_state_sha256: scanned.previousSha256,
    ...payload,
    citation_allowed: false,
  };
  const raw = prettyJson(value);
  const record = await recoverHashBoundPair(
    paths.states,
    path.join(paths.states, stem),
    raw,
    `operator continuation ${stage} state`,
    { afterBody: dependencies.afterJournalBody },
  );
  if (dependencies.expectedUnitFence) {
    const verified = await scanJournal(paths, claim);
    validateJournalProgression(verified.states, claim, dependencies.expectedUnitFence);
  }
  return { stem, value, sha256: record.sha256 };
}

function terminalPlanFromState(inspected, value) {
  if (value.stage !== 'terminal_plan'
    || !['complete', 'failed', 'interrupted', 'quarantined'].includes(value.outcome)
    || !Number.isSafeInteger(value.exit_code)
    || !Array.isArray(value.transaction)
    || value.transaction.length !== 4) {
    throw new Error('continuation terminal plan state is invalid');
  }
  const allowed = new Map([
    [path.relative(inspected.outputRoot, inspected.statusPath), inspected.statusPath],
    [path.relative(inspected.outputRoot, `${inspected.statusPath}.sha256`), `${inspected.statusPath}.sha256`],
    ['run-status.json', inspected.runStatusPath],
    ['run-status.json.sha256', `${inspected.runStatusPath}.sha256`],
  ]);
  const transaction = value.transaction.map((record) => {
    const pathname = allowed.get(record.output_path);
    if (!pathname
      || !sha256Pattern.test(String(record.before_sha256 || ''))
      || !sha256Pattern.test(String(record.after_sha256 || ''))
      || !Number.isSafeInteger(record.before_bytes)
      || !Number.isSafeInteger(record.after_bytes)
      || typeof record.after_base64 !== 'string') {
      throw new Error('continuation terminal transaction record is invalid');
    }
    const after = Buffer.from(record.after_base64, 'base64');
    if (after.byteLength !== record.after_bytes || sha256(after) !== record.after_sha256) {
      throw new Error('continuation terminal transaction payload is invalid');
    }
    return { ...record, pathname, after };
  });
  if (new Set(transaction.map(({ output_path: outputPath }) => outputPath)).size !== 4) {
    throw new Error('continuation terminal transaction paths are duplicated');
  }
  return { outcome: value.outcome, exitCode: value.exit_code, transaction };
}

async function applyTerminalTransaction(inspected, terminalPlanState, dependencies = {}) {
  const plan = terminalPlanFromState(inspected, terminalPlanState.value);
  for (let index = 0; index < plan.transaction.length; index += 1) {
    await dependencies.transactionGuard?.(`before_terminal_replacement_${index + 1}`);
    const record = plan.transaction[index];
    const current = await readStableFileRecord(inspected.outputRoot, record.pathname, `terminal control ${record.output_path}`);
    if (current.sha256 === record.after_sha256 && current.bytes === record.after_bytes) {
      await dependencies.transactionGuard?.(`after_terminal_replacement_${index + 1}`);
      continue;
    }
    if (current.sha256 !== record.before_sha256 || current.bytes !== record.before_bytes) {
      throw new Error(
        `terminal control is neither exact before nor exact after: ${record.output_path} `
        + `(actual ${current.sha256}/${current.bytes}, before ${record.before_sha256}/${record.before_bytes}, `
        + `after ${record.after_sha256}/${record.after_bytes})`,
      );
    }
    await durableAtomicReplace(record.pathname, record.after);
    await dependencies.afterTerminalReplacement?.(index + 1, record.output_path);
    await dependencies.transactionGuard?.(`after_terminal_replacement_${index + 1}`);
  }
  return plan;
}

async function finalizeOutcome(inspected, published, claim, options, outcome, timestamp, details, dependencies = {}) {
  await dependencies.transactionGuard?.('before_terminal_plan');
  const plan = terminalControlPlan(inspected, options, outcome, timestamp, details);
  const planState = await appendJournalState(published.paths, claim, 'terminal_plan', {
    outcome,
    exit_code: plan.exitCode,
    terminal_at: timestamp,
    transaction: plan.transaction,
  }, dependencies);
  await dependencies.afterTerminalPlan?.(planState);
  await dependencies.transactionGuard?.('after_terminal_plan');
  const applied = await applyTerminalTransaction(inspected, planState, dependencies);
  const verifyBase = dependencies.verifyCommittedSeed || verifyCommittedSeed;
  await verifyBase(options);
  await dependencies.transactionGuard?.('before_terminal_state');
  await appendJournalState(published.paths, claim, 'terminal', {
    outcome,
    exit_code: applied.exitCode,
    terminal_at: timestamp,
    terminal_plan_state_sha256: planState.sha256,
  }, dependencies);
  await dependencies.transactionGuard?.('after_terminal_state');
  return {
    status: outcome,
    exitCode: applied.exitCode,
    continuation_id: inspected.receipt.continuation_id,
    receipt_sha256: published.receiptSha256,
    claim_sha256: claim.sha256,
    document_id: options.documentId,
    attempt: attemptCeiling,
    citation_allowed: false,
  };
}

export async function continueOperatorInterruptedAttempt(options, dependencies = {}) {
  const profile = validateA2ForwardContinuationProfile(
    dependencies.incidentProfile || EXACT_A2_FORWARD_CONTINUATION_INCIDENT,
  );
  validateOptions(options, profile);
  const lock = dependencies.acquireLifecycleLock || acquireLifecycleLock;
  const releaseLock = await lock(profile.lifecycleLock);
  const assertLockHeld = async () => {
    releaseLock.assertHeld?.();
    if (releaseLock.verifyIdentity) {
      await releaseLock.verifyIdentity({ inode: profile.lifecycleLockInode });
      return;
    }
    const lifecycle = await lstat(profile.lifecycleLock, { bigint: true }).catch((error) => {
      if (error?.code === 'ENOENT') throw new Error('shared A2 lifecycle lock pathname disappeared');
      throw error;
    });
    const currentUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : lifecycle.uid;
    const currentGid = typeof process.getgid === 'function' ? BigInt(process.getgid()) : lifecycle.gid;
    if (!lifecycle.isFile()
      || lifecycle.isSymbolicLink()
      || lifecycle.nlink !== 1n
      || lifecycle.uid !== currentUid
      || lifecycle.gid !== currentGid
      || (Number(lifecycle.mode) & 0o7777) !== 0o600
      || String(lifecycle.ino) !== profile.lifecycleLockInode) {
      throw new Error('shared A2 lifecycle lock pathname/inode differs from the held frozen lock');
    }
  };
  let activeChild = null;
  let externalTermination = null;
  let stopRequested = false;
  let llamaStarted = false;
  let primaryError = null;
  let frozenUnitFence = null;
  let guardedDependencies = dependencies;
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
    await assertLockHeld();
    const initialUnits = await inspectA2ContinuationUnits(profile, dependencies);
    frozenUnitFence = continuationUnitFence(initialUnits);
    const transactionGuard = async () => {
      await assertLockHeld();
      const current = await inspectContinuationFenceUnits(profile, dependencies);
      requireSameContinuationUnitFence(current, frozenUnitFence);
      await assertLockHeld();
    };
    guardedDependencies = {
      ...dependencies,
      expectedUnitFence: frozenUnitFence,
      transactionGuard,
    };
    const inspected = await inspectInterruptedState(options, profile);
    const paths = operatorContinuationPaths(profile.evidenceBaseRoot, options.documentId, options.attempt);
    if (options.apply !== true) {
      return {
        status: 'ready',
        continuation_id: inspected.receipt.continuation_id,
        document_id: options.documentId,
        attempt: attemptCeiling,
        receipt_path: paths.receipt,
        claim_path: paths.claim,
        evidence_root_disjoint: true,
        citation_allowed: false,
      };
    }
    const verifyBase = dependencies.verifyCommittedSeed || verifyCommittedSeed;
    if (!inspected.archivedIncident) await verifyBase(options);
    await transactionGuard('before_receipt_publication');
    const published = await publishReceipt(inspected, options, profile);
    await transactionGuard('after_receipt_publication');
    const claim = await publishClaim(inspected, published, options, profile, guardedDependencies);
    await transactionGuard('after_claim_publication');
    await appendJournalState(published.paths, claim, 'claimed', {
      claimed_at: options.continuedAt,
      worker_invocation_id: profile.workerInvocationId,
      quiescent_unit_fence: frozenUnitFence,
    }, guardedDependencies);

    let journal = await recoverTrailingJournalPair(
      published.paths,
      claim,
      frozenUnitFence,
    );
    const existingPlanState = journal.states.find(({ value }) => value.stage === 'terminal_plan');
    if (existingPlanState) {
      const applied = await applyTerminalTransaction(inspected, existingPlanState, guardedDependencies);
      await verifyBase(options);
      const terminalAt = existingPlanState.value.terminal_at;
      await appendJournalState(published.paths, claim, 'terminal', {
        outcome: applied.outcome,
        exit_code: applied.exitCode,
        terminal_at: terminalAt,
        terminal_plan_state_sha256: existingPlanState.sha256,
      }, guardedDependencies);
      await transactionGuard('after_recovered_terminal_state');
      return {
        status: applied.outcome,
        exitCode: applied.exitCode,
        continuation_id: inspected.receipt.continuation_id,
        receipt_sha256: published.receiptSha256,
        claim_sha256: claim.sha256,
        document_id: options.documentId,
        attempt: attemptCeiling,
        recovered: true,
        citation_allowed: false,
      };
    }

    if (inspected.archivedIncident) await verifyBase(options);

    const progression = validateJournalProgression(journal.states, claim, frozenUnitFence);
    if (progression.executionStates.length > 0) {
      // A crash may occur after the child exits but before its terminal plan is
      // journaled. A fully valid forward result is finalized without invoking
      // OCR again; an incomplete but forward-only result resumes the same
      // already claimed attempt 6.
      const forward = await verifyForwardOnlyDocument(inspected);
      let recoveredArtifacts;
      try {
        const validateOutput = dependencies.validateDocumentOutput || validateOcrDocumentOutput;
        recoveredArtifacts = await validateOutput(
          inspected.document,
          inspected.documentRoot,
          inspected.identity.runtime,
          { workerConfiguration: inspected.identity.worker_configuration },
        );
      } catch (error) {
        if (/changed|removed|replaced|truncated|unsafe|out-of-range|unrecognized/u.test(error.message)) throw error;
      }
      if (recoveredArtifacts) {
        const recoveryTimestamp = requireCanonicalTimestamp(
          dependencies.now?.() || new Date().toISOString(),
          'continuation recovery timestamp',
        );
        return await finalizeOutcome(
          inspected,
          published,
          claim,
          options,
          'complete',
          recoveryTimestamp,
          {
            source: {
              sourceSha256: inspected.document.source_sha256,
              pageCount: inspected.document.page_count,
            },
            artifacts: { ...recoveredArtifacts, forward_document_tree: forward.after, append_only_log: {
              sha256: forward.log.sha256,
              bytes: forward.log.bytes,
              device: forward.log.dev,
              inode: forward.log.ino,
            } },
          },
          guardedDependencies,
        );
      }
    }

    llamaStarted = true;
    await transactionGuard('before_llama_start');
    await startExactLlama(profile, dependencies);
    const activeLlama = await inspectActiveLlama(profile, null, dependencies);
    const verifyRuntime = dependencies.verifyActiveRuntime || verifyActiveRuntime;
    const activeRuntime = await verifyRuntime(options, inspected, dependencies);
    const source = activeRuntime?.source || {
      sourceSha256: inspected.document.source_sha256,
      pageCount: inspected.document.page_count,
    };
    const previousExecutionState = progression.executionStates.at(-1);
    const executionStage = previousExecutionState
      ? `resume_running_${String(progression.executionStates.length).padStart(4, '0')}`
      : 'running';
    const executionTimestamp = previousExecutionState
      ? requireCanonicalTimestamp(
          dependencies.now?.() || new Date().toISOString(),
          'continuation resume timestamp',
        )
      : options.continuedAt;
    if (previousExecutionState
      && progression.executionStates.some(
        ({ value }) => value.llama_invocation_id === activeLlama.InvocationID,
      )) {
      throw new Error('resumed llama invocation must differ from every prior running state');
    }
    await appendJournalState(published.paths, claim, executionStage, previousExecutionState ? {
      resumed_at: executionTimestamp,
      llama_invocation_id: activeLlama.InvocationID,
      llama_main_pid: activeLlama.MainPID,
      resumed_from_state_sha256: previousExecutionState.sha256,
    } : {
      started_at: executionTimestamp,
      llama_invocation_id: activeLlama.InvocationID,
      llama_main_pid: activeLlama.MainPID,
    }, guardedDependencies);
    await transactionGuard('after_execution_state');
    const preSpawnUnits = await inspectPreSpawnUnits(profile, activeLlama, dependencies);
    requireSameContinuationUnitFence(preSpawnUnits, frozenUnitFence);
    await verifyFrozenPreSpawnSnapshot(inspected, profile);

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
    await transactionGuard('after_child_exit');
    const timestamp = requireCanonicalTimestamp(
      dependencies.now?.() || new Date().toISOString(),
      'continuation outcome timestamp',
    );
    if (stopRequested) {
      return await finalizeOutcome(
        inspected,
        published,
        claim,
        options,
        'interrupted',
        timestamp,
        { signal: childResult?.signal || interruptionSignal },
        guardedDependencies,
      );
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
      if (childResult?.code === 2 && !childResult.signal && !monitorIncident && !invocationError) {
        return await finalizeOutcome(
          inspected,
          published,
          claim,
          options,
          'failed',
          timestamp,
          { error: 'OCR child exited 2: shared runtime or configuration failure' },
          guardedDependencies,
        );
      }
      const revalidate = dependencies.revalidateActiveRuntime || verifyRuntime;
      try {
        await revalidate(options, inspected, dependencies);
      } catch (error) {
        const shared = new Error(`shared runtime revalidation failed after continuation child failure: ${error.message}`, { cause: error });
        return await finalizeOutcome(
          inspected,
          published,
          claim,
          options,
          'failed',
          timestamp,
          { error: shared.message },
          guardedDependencies,
        );
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
      return await finalizeOutcome(
        inspected,
        published,
        claim,
        options,
        'quarantined',
        timestamp,
        { error: failure.message },
        guardedDependencies,
      );
    }
    const forward = await verifyForwardOnlyDocument(inspected).catch(async (error) => ({ validationError: error }));
    let artifacts;
    let validationError = forward.validationError;
    if (!validationError) {
      const validateOutput = dependencies.validateDocumentOutput || validateOcrDocumentOutput;
      try {
        artifacts = await validateOutput(
          inspected.document,
          inspected.documentRoot,
          activeRuntime?.runtime || inspected.identity.runtime,
          { workerConfiguration: activeRuntime?.workerConfiguration || inspected.identity.worker_configuration },
        );
      } catch (error) {
        validationError = error;
      }
    }
    if (!validationError) {
      return await finalizeOutcome(
        inspected,
        published,
        claim,
        options,
        'complete',
        timestamp,
        {
          source,
          artifacts: { ...artifacts, forward_document_tree: forward.after, append_only_log: {
            sha256: forward.log.sha256,
            bytes: forward.log.bytes,
            device: forward.log.dev,
            inode: forward.log.ino,
          } },
        },
        guardedDependencies,
      );
    }
    return await finalizeOutcome(
      inspected,
      published,
      claim,
      options,
      'quarantined',
      timestamp,
      { error: `continuation output validation failed: ${validationError.message}` },
      guardedDependencies,
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    externalTermination?.cancel();
    if (handleSignals) {
      process.removeListener('SIGTERM', requestStop);
      process.removeListener('SIGINT', requestStop);
    }
    const finalizationErrors = [];
    try {
      await assertLockHeld();
    } catch (error) {
      finalizationErrors.push(error);
    }
    try {
      if (llamaStarted) await stopExactLlama(profile, dependencies);
    } catch (error) {
      finalizationErrors.push(error);
    }
    try {
      const finalUnits = await inspectA2ContinuationUnits(profile, dependencies);
      if (frozenUnitFence) requireSameContinuationUnitFence(finalUnits, frozenUnitFence);
    } catch (error) {
      finalizationErrors.push(error);
    }
    try {
      await assertLockHeld();
    } catch (error) {
      finalizationErrors.push(error);
    }
    try {
      await releaseLock();
    } catch (error) {
      finalizationErrors.push(error);
    }
    const finalizationError = finalizationErrors.length === 0
      ? null
      : finalizationErrors.length === 1
        ? finalizationErrors[0]
        : new AggregateError(
            finalizationErrors,
            `continuation closeout encountered multiple failures: ${finalizationErrors
              .map((error) => error.message)
              .join('; ')}`,
          );
    if (finalizationError && primaryError) {
      throw new AggregateError(
        [primaryError, finalizationError],
        `continuation failed and five-unit quiescent closeout also failed: ${finalizationError.message}`,
      );
    }
    if (finalizationError) throw finalizationError;
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
    ['--authorized-at', 'authorizedAt'],
    ['--continued-at', 'continuedAt'],
  ]);
  const integers = new Map([
    ['--attempt', 'attempt'],
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
    '  --document-id legacy-compendium-english --attempt 6 \\',
    '  --authorized-at ISO --continued-at ISO [--apply]',
    '',
    'All incident identity, filesystem, authority, and hash anchors are compiled into a strict profile;',
    'the command rejects caller-supplied incident proofs. The production profile intentionally remains',
    'fail-closed until the missing independently witnessed hashes are populated in source review.',
    'Without --apply the command is persistence-free. --apply publishes disjoint owner-only evidence',
    'and one crash-resumable claim, then continues the already consumed attempt 6 without increment.',
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
