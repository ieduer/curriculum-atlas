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
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  defaultChildMonitoringPolicy,
  fingerprintPaddlexLayoutModelCache,
  IncompleteOcrDocumentError,
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
  validateA2ContinuationRuntimeManifest,
  validateArchivedA2ContinuationRuntimeManifest,
} from './lib/remote-ocr-continuation-runtime-manifest.mjs';
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
const spawnNonceEnvironmentKey = ['CURRICULUM_A2_CONTINUATION', 'SPAWN', 'NONCE'].join('_');
const commandShaEnvironmentKey = 'CURRICULUM_A2_CONTINUATION_COMMAND_SHA256';
const llamaStartNonceEnvironmentKey = 'CURRICULUM_A2_CONTINUATION_LLAMA_START_NONCE';

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
  const handle = await open(
    pathname,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    mode,
  );
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

function terminalTransactionTemporaryPath(pathname, record, terminalPlanState) {
  const token = sha256(canonicalJson({
    schema_version: 1,
    terminal_plan_state_sha256: terminalPlanState.sha256,
    output_path: record.output_path,
    after_sha256: record.after_sha256,
    after_bytes: record.after_bytes,
  }));
  return `${pathname}.a2-terminal-${token}.tmp`;
}

function terminalTransactionOwnershipPath(temporary) {
  return `${temporary}.owner.json`;
}

function terminalOwnershipRaw(root, temporary, record, terminalPlanState, temporaryRecord) {
  return Buffer.from(`${JSON.stringify({
    schema_version: 1,
    receipt_type: 'curriculum_a2_terminal_temp_ownership',
    terminal_plan_state_sha256: terminalPlanState.sha256,
    output_path: record.output_path,
    temporary_path: path.relative(root, temporary).split(path.sep).join('/'),
    temporary_device: temporaryRecord.dev,
    temporary_inode: temporaryRecord.ino,
    before_sha256: record.before_sha256,
    before_bytes: record.before_bytes,
    after_sha256: record.after_sha256,
    after_bytes: record.after_bytes,
  }, null, 2)}\n`);
}

function exactKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && sameJson(Object.keys(value).sort(), [...keys].sort());
}

async function readOptionalStableFile(root, pathname, label) {
  return lstat(pathname).then(
    () => readStableFileRecord(root, pathname, label),
    (error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    },
  );
}

function validateTerminalOwnership(
  root,
  temporary,
  record,
  terminalPlanState,
  temporaryRecord,
  ownershipRecord,
) {
  let value;
  try {
    value = JSON.parse(ownershipRecord.raw.toString('utf8'));
  } catch {
    return false;
  }
  const keys = [
    'schema_version',
    'receipt_type',
    'terminal_plan_state_sha256',
    'output_path',
    'temporary_path',
    'temporary_device',
    'temporary_inode',
    'before_sha256',
    'before_bytes',
    'after_sha256',
    'after_bytes',
  ];
  if (!exactKeys(value, keys)
    || value.schema_version !== 1
    || value.receipt_type !== 'curriculum_a2_terminal_temp_ownership'
    || value.terminal_plan_state_sha256 !== terminalPlanState.sha256
    || value.output_path !== record.output_path
    || value.temporary_path !== path.relative(root, temporary).split(path.sep).join('/')
    || value.temporary_device !== temporaryRecord?.dev
    || value.temporary_inode !== temporaryRecord?.ino
    || value.before_sha256 !== record.before_sha256
    || value.before_bytes !== record.before_bytes
    || value.after_sha256 !== record.after_sha256
    || value.after_bytes !== record.after_bytes) {
    return false;
  }
  return ownershipRecord.raw.equals(
    terminalOwnershipRaw(root, temporary, record, terminalPlanState, temporaryRecord),
  );
}

async function writePlanOwnedTerminalTemp(
  root,
  temporary,
  raw,
  temporaryRecord,
  dependencies,
) {
  const handle = await open(temporary, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()
      || before.nlink !== 1n
      || String(before.dev) !== temporaryRecord.dev
      || String(before.ino) !== temporaryRecord.ino) {
      throw new Error('plan-owned terminal temp changed before rewrite');
    }
    await handle.truncate(0);
    await handle.sync();
    const configuredChunk = dependencies.terminalWriteChunkBytes;
    const chunkBytes = Number.isSafeInteger(configuredChunk) && configuredChunk > 0
      ? configuredChunk
      : Math.max(1, raw.byteLength);
    let written = 0;
    while (written < raw.byteLength) {
      const end = Math.min(raw.byteLength, written + chunkBytes);
      let offset = written;
      while (offset < end) {
        const result = await handle.write(raw, offset, end - offset, offset);
        if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten < 1) {
          throw new Error('plan-owned terminal temp write made no progress');
        }
        offset += result.bytesWritten;
      }
      written = end;
      await handle.sync();
      await dependencies.afterTerminalTempChunk?.({ written, total: raw.byteLength });
    }
    const after = await handle.stat({ bigint: true });
    const entry = await lstat(temporary, { bigint: true });
    if (after.dev !== before.dev
      || after.ino !== before.ino
      || entry.dev !== before.dev
      || entry.ino !== before.ino
      || after.size !== BigInt(raw.byteLength)) {
      throw new Error('plan-owned terminal temp changed while it was written');
    }
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(temporary));
}

async function removeVerifiedFile(pathname, record, label) {
  const current = await lstat(pathname, { bigint: true });
  if (!current.isFile()
    || current.isSymbolicLink()
    || current.nlink !== 1n
    || String(current.dev) !== record.dev
    || String(current.ino) !== record.ino) {
    throw new Error(`${label} changed before removal`);
  }
  await unlink(pathname);
  await syncDirectory(path.dirname(pathname));
}

export async function recoverableTerminalAtomicReplace(
  root,
  pathname,
  raw,
  record,
  terminalPlanState,
  dependencies = {},
) {
  const temporary = terminalTransactionTemporaryPath(pathname, record, terminalPlanState);
  const ownershipPath = terminalTransactionOwnershipPath(temporary);
  let temporaryRecord = await readOptionalStableFile(
    root,
    temporary,
    `deterministic terminal temp for ${record.output_path}`,
  );
  let ownershipRecord = await readOptionalStableFile(
    root,
    ownershipPath,
    `terminal temp ownership for ${record.output_path}`,
  );
  const current = await readStableFileRecord(root, pathname, `terminal control ${record.output_path}`);
  if (current.sha256 === record.after_sha256 && current.bytes === record.after_bytes) {
    if (temporaryRecord) {
      await removeVerifiedFile(
        temporary,
        temporaryRecord,
        `deterministic terminal temp for ${record.output_path}`,
      );
    }
    if (ownershipRecord) {
      await removeVerifiedFile(
        ownershipPath,
        ownershipRecord,
        `terminal temp ownership for ${record.output_path}`,
      );
    }
    return;
  }
  if (current.sha256 !== record.before_sha256 || current.bytes !== record.before_bytes) {
    throw new Error(
      `terminal control is neither exact before nor exact after: ${record.output_path} `
      + `(actual ${current.sha256}/${current.bytes}, before ${record.before_sha256}/${record.before_bytes}, `
      + `after ${record.after_sha256}/${record.after_bytes})`,
    );
  }
  let ownershipValid = temporaryRecord && ownershipRecord
    ? validateTerminalOwnership(
        root,
        temporary,
        record,
        terminalPlanState,
        temporaryRecord,
        ownershipRecord,
      )
    : false;
  const exactAfter = temporaryRecord
    && temporaryRecord.sha256 === record.after_sha256
    && temporaryRecord.bytes === record.after_bytes
    && temporaryRecord.raw.equals(raw);
  const exactOwnedPrefix = ownershipValid
    && temporaryRecord.bytes < record.after_bytes
    && raw.subarray(0, temporaryRecord.bytes).equals(temporaryRecord.raw);
  if (temporaryRecord && !exactAfter && !exactOwnedPrefix) {
    if (temporaryRecord.bytes === 0 && !ownershipValid) {
      if (ownershipRecord) {
        await removeVerifiedFile(
          ownershipPath,
          ownershipRecord,
          `incomplete terminal temp ownership for ${record.output_path}`,
        );
        ownershipRecord = null;
      }
      await removeVerifiedFile(
        temporary,
        temporaryRecord,
        `unbound empty terminal temp for ${record.output_path}`,
      );
      temporaryRecord = null;
    } else {
      throw new Error(
        `deterministic terminal temp is neither exact after nor safely absent: ${record.output_path}`,
      );
    }
  }
  if (!temporaryRecord && ownershipRecord) {
    throw new Error(`terminal temp ownership has no exact owned inode: ${record.output_path}`);
  }
  if (!temporaryRecord) {
    await writeDurableFile(temporary, Buffer.alloc(0));
    await syncDirectory(path.dirname(temporary));
    temporaryRecord = await readStableFileRecord(
      root,
      temporary,
      `deterministic terminal temp for ${record.output_path}`,
    );
    const ownershipRaw = terminalOwnershipRaw(
      root,
      temporary,
      record,
      terminalPlanState,
      temporaryRecord,
    );
    await writeDurableFile(ownershipPath, ownershipRaw);
    await syncDirectory(path.dirname(ownershipPath));
    ownershipRecord = await readStableFileRecord(
      root,
      ownershipPath,
      `terminal temp ownership for ${record.output_path}`,
    );
    ownershipValid = validateTerminalOwnership(
      root,
      temporary,
      record,
      terminalPlanState,
      temporaryRecord,
      ownershipRecord,
    );
    if (!ownershipValid) {
      throw new Error(`terminal temp ownership did not persist exact plan identity: ${record.output_path}`);
    }
  }
  if (!exactAfter) {
    await writePlanOwnedTerminalTemp(root, temporary, raw, temporaryRecord, dependencies);
    temporaryRecord = await readStableFileRecord(
      root,
      temporary,
      `deterministic terminal temp for ${record.output_path}`,
    );
    if (temporaryRecord.sha256 !== record.after_sha256
      || temporaryRecord.bytes !== record.after_bytes
      || !temporaryRecord.raw.equals(raw)) {
      throw new Error(`deterministic terminal temp did not persist exact after bytes: ${record.output_path}`);
    }
    await dependencies.afterTerminalTempSync?.(temporary, record.output_path);
  }
  const targetBeforeRename = await readStableFileRecord(
    root,
    pathname,
    `terminal control ${record.output_path}`,
  );
  if (targetBeforeRename.sha256 !== record.before_sha256
    || targetBeforeRename.bytes !== record.before_bytes) {
    throw new Error(`terminal control changed before deterministic rename: ${record.output_path}`);
  }
  await rename(temporary, pathname);
  await syncDirectory(path.dirname(pathname));
  if (ownershipRecord) {
    await removeVerifiedFile(
      ownershipPath,
      ownershipRecord,
      `terminal temp ownership for ${record.output_path}`,
    );
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

async function loadExistingIncidentArchive(profile, runtimeManifest) {
  const paths = operatorContinuationPaths(profile.evidenceBaseRoot, profile.documentId, profile.attempt);
  const present = await lstat(paths.root).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (!present) return null;
  await requireStableDirectory(paths.root, 'existing continuation evidence', { mode: 0o700 });
  const [
    receiptRecord,
    runStatusRecord,
    statusRecord,
    stateRecord,
    logRecord,
    inventoryRecord,
    runtimeManifestRecord,
  ] = await Promise.all([
    readStableFileWithSidecarRecord(paths.root, paths.receipt, 'existing continuation receipt'),
    readStableFileWithSidecarRecord(paths.root, paths.interruptedRunStatus, 'archived interrupted run status'),
    readStableFileWithSidecarRecord(paths.root, paths.interruptedStatus, 'archived interrupted document status'),
    readStableFileWithSidecarRecord(paths.root, paths.interruptedState, 'archived interrupted state'),
    readStableFileWithSidecarRecord(paths.root, paths.preContinuationLog, 'archived pre-continuation log'),
    readStableFileWithSidecarRecord(paths.root, paths.documentInventory, 'archived document inventory'),
    readStableFileWithSidecarRecord(paths.root, paths.runtimeManifest, 'archived continuation runtime manifest'),
  ]);
  const receipt = parseJson(receiptRecord.raw, 'existing continuation receipt');
  const inventory = parseJson(inventoryRecord.raw, 'archived document inventory');
  if (receipt.schema_version !== 3
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
    || receipt.authorization?.runtime_manifest?.path !== 'runtime-manifest.json'
    || receipt.authorization?.runtime_manifest?.sha256 !== runtimeManifest.sha256
    || receipt.authorization?.runtime_manifest?.bytes !== runtimeManifest.bytes
    || receipt.authorization?.runtime_manifest?.runtime_tree_sha256 !== runtimeManifest.runtime_tree_sha256
    || receipt.authorization?.runtime_manifest?.files !== runtimeManifest.files
    || receipt.citation_allowed !== false) {
    throw new Error('existing continuation receipt is not the frozen A2 incident');
  }
  validateArchivedA2ContinuationRuntimeManifest(runtimeManifestRecord.raw, runtimeManifest);
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
    runtimeManifestRecord,
  };
}

async function inspectInterruptedState(options, profile, runtimeManifest) {
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
  const archivedIncident = await loadExistingIncidentArchive(profile, runtimeManifest);
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
    schema_version: 3,
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
      runtime_manifest: {
        path: 'runtime-manifest.json',
        sha256: runtimeManifest.sha256,
        bytes: runtimeManifest.bytes,
        runtime_tree_sha256: runtimeManifest.runtime_tree_sha256,
        files: runtimeManifest.files,
      },
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
    runtimeManifest,
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
      'runtime-manifest.json',
      'runtime-manifest.json.sha256',
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
      [paths.runtimeManifest, inspected.runtimeManifest.raw, 'archived continuation runtime manifest'],
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
      writeEvidenceFile(temporary, 'runtime-manifest.json', inspected.runtimeManifest.raw),
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

async function setLlamaStartMarker(profile, marker, dependencies = {}) {
  if (dependencies.setLlamaStartMarker) {
    return dependencies.setLlamaStartMarker(profile, marker);
  }
  await execFile('systemctl', [
    '--user',
    'set-environment',
    `${llamaStartNonceEnvironmentKey}=${marker}`,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 });
  return undefined;
}

async function clearLlamaStartMarker(profile, dependencies = {}) {
  if (dependencies.clearLlamaStartMarker) {
    return dependencies.clearLlamaStartMarker(profile);
  }
  await execFile('systemctl', [
    '--user',
    'unset-environment',
    llamaStartNonceEnvironmentKey,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 });
  return undefined;
}

async function verifyLlamaStartMarker(activeLlama, marker, dependencies = {}) {
  if (dependencies.verifyLlamaStartMarker) {
    return dependencies.verifyLlamaStartMarker(activeLlama, marker);
  }
  if (process.platform !== 'linux') {
    throw new Error('exact llama start marker verification requires Linux procfs');
  }
  const pid = Number(activeLlama.MainPID);
  const processRoot = `/proc/${pid}`;
  const before = await lstat(processRoot, { bigint: true });
  const environment = await readFile(path.join(processRoot, 'environ'));
  const after = await lstat(processRoot, { bigint: true });
  const currentUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : after.uid;
  if (before.dev !== after.dev
    || before.ino !== after.ino
    || before.uid !== after.uid
    || after.uid !== currentUid
    || !environment.toString('utf8').split('\0').includes(
      `${llamaStartNonceEnvironmentKey}=${marker}`,
    )) {
    throw new Error('active llama start marker is not owned by the pending continuation intent');
  }
  return true;
}

function llamaStartNonce(seed, ordinal) {
  return sha256(canonicalJson({
    schema_version: 1,
    llama_start_nonce_seed: seed,
    execution_ordinal: ordinal,
  }));
}

function llamaStartNonceSeed(claimId) {
  return sha256(canonicalJson({
    schema_version: 1,
    claim_id: claimId,
    purpose: 'a2_llama_start_intent',
  }));
}

async function stopExactLlama(profile, expected, dependencies = {}) {
  const inspectUnit = dependencies.inspectUnit || inspectSystemdUnit;
  let current = await inspectUnit(profile.llamaUnit, 'llama');
  let active = current.LoadState === 'loaded'
    && current.ActiveState === 'active'
    && current.SubState === 'running';
  if (!active) {
    requireQuiescentUnit(current, profile.llamaUnit, 'llama');
    return false;
  }
  if (!expected
    || current.InvocationID !== expected.InvocationID
    || current.MainPID !== expected.MainPID) {
    throw new Error('llama invocation changed immediately before stop');
  }
  if (expected.startNonce) {
    await verifyLlamaStartMarker(current, expected.startNonce, dependencies);
  }
  current = await inspectUnit(profile.llamaUnit, 'llama');
  active = current.LoadState === 'loaded'
    && current.ActiveState === 'active'
    && current.SubState === 'running';
  if (!active
    || current.InvocationID !== expected.InvocationID
    || current.MainPID !== expected.MainPID) {
    throw new Error('llama invocation changed immediately before stop');
  }
  if (dependencies.stopLlama) {
    await dependencies.stopLlama(profile.llamaUnit, expected);
    return true;
  }
  await execFile('systemctl', ['--user', 'stop', profile.llamaUnit], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
  });
  return true;
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

function processEnvironmentMatches(raw, spawnNonce, commandSha256, separator) {
  const entries = separator === '\0'
    ? raw.toString('utf8').split('\0')
    : raw.toString('utf8').split(/\s+/u);
  return entries.includes(`${spawnNonceEnvironmentKey}=${spawnNonce}`)
    && entries.includes(`${commandShaEnvironmentKey}=${commandSha256}`);
}

function parseLinuxProcessStarttime(raw, pid) {
  const value = raw.toString('utf8');
  const close = value.lastIndexOf(')');
  if (close < 0) throw new Error(`owned OCR process ${pid} has malformed proc stat`);
  const fields = value.slice(close + 1).trim().split(/\s+/u);
  const starttime = fields[19];
  if (!/^[1-9]\d*$/u.test(String(starttime || ''))) {
    throw new Error(`owned OCR process ${pid} has invalid proc starttime`);
  }
  return starttime;
}

async function inspectLinuxOcrProcess(pid, executionState) {
  const processRoot = `/proc/${pid}`;
  try {
    const before = await lstat(processRoot, { bigint: true });
    const [environment, procStat] = await Promise.all([
      readFile(path.join(processRoot, 'environ')),
      readFile(path.join(processRoot, 'stat')),
    ]);
    const after = await lstat(processRoot, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.uid !== after.uid) {
      throw new Error(`owned OCR process ${pid} changed during proc inspection`);
    }
    return {
      pid,
      uid: Number(after.uid),
      starttime: parseLinuxProcessStarttime(procStat, pid),
      markersMatch: processEnvironmentMatches(
        environment,
        executionState.value.spawn_nonce,
        executionState.value.ocr_command_sha256,
        '\0',
      ),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function inspectPortableOcrProcess(pid, executionState) {
  try {
    const [identity, observed] = await Promise.all([
      execFile('/bin/ps', ['-p', String(pid), '-o', 'uid=', '-o', 'lstart='], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
      }),
      execFile('/bin/ps', ['eww', '-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        maxBuffer: 512 * 1024,
      }),
    ]);
    const match = /^\s*([0-9]+)\s+(.+?)\s*$/u.exec(String(identity.stdout));
    if (!match) throw new Error(`owned OCR process ${pid} has invalid ps identity`);
    return {
      pid,
      uid: Number(match[1]),
      starttime: match[2],
      markersMatch: processEnvironmentMatches(
        Buffer.from(observed.stdout),
        executionState.value.spawn_nonce,
        executionState.value.ocr_command_sha256,
        ' ',
      ),
    };
  } catch (error) {
    if (error?.code === 1 || error?.code === 'ESRCH') return null;
    throw error;
  }
}

async function inspectOcrProcess(pid, executionState) {
  return process.platform === 'linux'
    ? inspectLinuxOcrProcess(pid, executionState)
    : inspectPortableOcrProcess(pid, executionState);
}

async function revalidateExactOwnedOcrProcess(owned, executionState) {
  const current = await inspectOcrProcess(owned.pid, executionState);
  if (!current) return null;
  if (!current.markersMatch
    || current.uid !== owned.uid
    || current.starttime !== owned.starttime) {
    throw new Error(`owned OCR process identity changed immediately before signal: ${owned.pid}`);
  }
  return { pid: current.pid, uid: current.uid, starttime: current.starttime };
}

async function findOwnedOcrProcesses(executionState) {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const matches = [];
  if (process.platform === 'linux') {
    const pids = (await readdir('/proc')).filter((name) => /^[1-9]\d*$/u.test(name));
    for (const textPid of pids) {
      const pid = Number(textPid);
      if (pid === process.pid) continue;
      try {
        const observed = await inspectLinuxOcrProcess(pid, executionState);
        if (!observed || (currentUid !== null && observed.uid !== currentUid)) continue;
        if (observed.markersMatch) {
          matches.push({ pid, uid: observed.uid, starttime: observed.starttime });
        }
      } catch (error) {
        if (['ENOENT', 'EACCES', 'EPERM'].includes(error?.code)) continue;
        throw error;
      }
    }
    return matches;
  }
  const { stdout } = await execFile('/bin/ps', ['-axo', 'pid=,uid='], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  for (const line of String(stdout).trim().split('\n')) {
    const match = /^\s*([1-9]\d*)\s+([0-9]+)\s*$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const uid = Number(match[2]);
    if (pid === process.pid || (currentUid !== null && uid !== currentUid)) continue;
    try {
      const observed = await inspectPortableOcrProcess(pid, executionState);
      if (observed?.markersMatch) {
        matches.push({ pid, uid, starttime: observed.starttime });
      }
    } catch (error) {
      if (error?.code === 1 || error?.code === 'ESRCH') continue;
      throw error;
    }
  }
  return matches;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function terminateExactProcess(owned, executionState, graceMilliseconds = 2_000, dependencies = {}) {
  const { pid } = owned;
  if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) {
    throw new Error('owned OCR process PID is invalid');
  }
  const revalidate = dependencies.revalidateOwnedOcrProcess || revalidateExactOwnedOcrProcess;
  const signal = dependencies.signalOwnedOcrProcess || ((targetPid, value) => process.kill(targetPid, value));
  const beforeTerm = await revalidate(owned, executionState);
  if (!beforeTerm) return;
  if (beforeTerm.pid !== owned.pid
    || beforeTerm.uid !== owned.uid
    || beforeTerm.starttime !== owned.starttime) {
    throw new Error(`owned OCR process identity changed immediately before signal: ${pid}`);
  }
  signal(pid, 'SIGTERM');
  const deadline = Date.now() + graceMilliseconds;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await delay(25);
  }
  if (processIsAlive(pid)) {
    const beforeKill = await revalidate(owned, executionState);
    if (!beforeKill) return;
    if (beforeKill.pid !== owned.pid
      || beforeKill.uid !== owned.uid
      || beforeKill.starttime !== owned.starttime) {
      throw new Error(`owned OCR process identity changed immediately before signal: ${pid}`);
    }
    signal(pid, 'SIGKILL');
  }
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline) {
    if (!processIsAlive(pid)) return;
    await delay(25);
  }
  throw new Error(`owned OCR process ${pid} did not terminate`);
}

export async function reconcileOwnedContinuationExecution(profile, executionState, dependencies = {}) {
  if (!executionState?.value
    || !sha256Pattern.test(String(executionState.value.spawn_nonce || ''))
    || !sha256Pattern.test(String(executionState.value.ocr_command_sha256 || ''))
    || !sha256Pattern.test(String(executionState.value.llama_start_nonce || ''))
    || !invocationIdPattern.test(String(executionState.value.llama_invocation_id || ''))
    || !/^[1-9]\d*$/u.test(String(executionState.value.llama_main_pid || ''))) {
    throw new Error('running journal does not contain an exact owned execution identity');
  }
  const findProcesses = dependencies.findOwnedOcrProcesses || findOwnedOcrProcesses;
  const ownedProcesses = await findProcesses(executionState);
  if (!Array.isArray(ownedProcesses)
    || new Set(ownedProcesses.map(({ pid }) => pid)).size !== ownedProcesses.length) {
    throw new Error('running journal resolves to an invalid owned OCR process set');
  }
  const inspectUnit = dependencies.inspectUnit || inspectSystemdUnit;
  const llama = await inspectUnit(profile.llamaUnit, 'llama');
  const llamaActive = llama.LoadState === 'loaded'
    && llama.ActiveState === 'active'
    && llama.SubState === 'running';
  if (llamaActive
    && (llama.InvocationID !== executionState.value.llama_invocation_id
      || llama.MainPID !== executionState.value.llama_main_pid)) {
    throw new Error('active llama unit is not owned by the running journal identity');
  }
  if (!llamaActive) requireQuiescentUnit(llama, profile.llamaUnit, 'llama');
  for (const owned of ownedProcesses) {
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : owned.uid;
    if (!Number.isSafeInteger(owned.pid)
      || owned.pid < 1
      || owned.pid === process.pid
      || owned.uid !== currentUid
      || (typeof owned.starttime !== 'string' && !dependencies.terminateOwnedOcrProcess)
      || (typeof owned.starttime === 'string' && !owned.starttime)) {
      throw new Error('owned OCR process identity is unsafe');
    }
  }
  const terminate = dependencies.terminateOwnedOcrProcess;
  await Promise.all(ownedProcesses.map((owned) => terminate
    ? terminate(owned, executionState)
    : terminateExactProcess(
        owned,
        executionState,
        dependencies.ownedProcessGraceMilliseconds,
        dependencies,
      )));
  if (llamaActive) {
    await stopExactLlama(profile, {
      InvocationID: executionState.value.llama_invocation_id,
      MainPID: executionState.value.llama_main_pid,
      startNonce: executionState.value.llama_start_nonce,
    }, dependencies);
  }
  const remaining = await findProcesses(executionState);
  if (!Array.isArray(remaining) || remaining.length !== 0) {
    throw new Error('owned OCR process remained after recovery');
  }
  const stoppedLlama = await inspectUnit(profile.llamaUnit, 'llama');
  requireQuiescentUnit(stoppedLlama, profile.llamaUnit, 'llama');
  return {
    terminated_ocr_pid: ownedProcesses[0]?.pid || null,
    terminated_ocr_pids: ownedProcesses.map(({ pid }) => pid).sort((left, right) => left - right),
    stopped_llama: llamaActive,
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

function requireCheckpointIdentity(identity, label, { includeBase64 = false } = {}) {
  const keys = ['sha256', 'bytes', 'device', 'inode', ...(includeBase64 ? ['base64'] : [])];
  if (!exactKeys(identity, keys)
    || !sha256Pattern.test(String(identity.sha256 || ''))
    || !Number.isSafeInteger(identity.bytes)
    || identity.bytes < 1
    || !/^(?:0|[1-9]\d*)$/u.test(String(identity.device || ''))
    || !/^(?:0|[1-9]\d*)$/u.test(String(identity.inode || ''))) {
    throw new Error(`${label} identity is invalid`);
  }
  if (includeBase64) {
    if (typeof identity.base64 !== 'string') throw new Error(`${label} payload is invalid`);
    const raw = Buffer.from(identity.base64, 'base64');
    if (raw.byteLength !== identity.bytes
      || raw.toString('base64') !== identity.base64
      || sha256(raw) !== identity.sha256) {
      throw new Error(`${label} payload differs from its identity`);
    }
  }
  return identity;
}

function requireCheckpointTree(tree, label) {
  if (!exactKeys(tree, ['tree_sha256', 'files', 'bytes', 'entries'])
    || !sha256Pattern.test(String(tree.tree_sha256 || ''))
    || !Number.isSafeInteger(tree.files)
    || tree.files < 1
    || !Number.isSafeInteger(tree.bytes)
    || tree.bytes < 1
    || !Array.isArray(tree.entries)
    || tree.entries.some((entry) => typeof entry !== 'string' || !entry.endsWith('\n'))
    || sha256(tree.entries.join('')) !== tree.tree_sha256) {
    throw new Error(`${label} strict tree is invalid`);
  }
  let files = 0;
  let bytes = 0;
  const paths = new Set();
  for (const entry of tree.entries) {
    const parts = entry.slice(0, -1).split('\0');
    if (!['D', 'F'].includes(parts[0])
      || (parts[0] === 'D' && parts.length !== 2)
      || (parts[0] === 'F' && parts.length !== 4)
      || typeof parts[1] !== 'string'
      || !parts[1]
      || path.isAbsolute(parts[1])
      || parts[1].split('/').some((part) => !part || part === '.' || part === '..')
      || paths.has(parts[1])) {
      throw new Error(`${label} strict tree entry is invalid`);
    }
    paths.add(parts[1]);
    if (parts[0] === 'F') {
      if (!/^(?:0|[1-9]\d*)$/u.test(parts[2]) || !sha256Pattern.test(parts[3])) {
        throw new Error(`${label} strict tree file identity is invalid`);
      }
      files += 1;
      bytes += Number(parts[2]);
    }
  }
  if (files !== tree.files || bytes !== tree.bytes || !Number.isSafeInteger(bytes)) {
    throw new Error(`${label} strict tree totals are invalid`);
  }
  return tree;
}

function requireCheckpointDirectories(directories, tree, label) {
  if (!Array.isArray(directories)) throw new Error(`${label} directories are invalid`);
  const expected = ['.', ...tree.entries
    .filter((entry) => entry.startsWith('D\0'))
    .map((entry) => entry.slice(0, -1).split('\0')[1])];
  if (directories.length !== expected.length) throw new Error(`${label} directory inventory is incomplete`);
  const seen = new Set();
  for (let index = 0; index < directories.length; index += 1) {
    const identity = directories[index];
    if (!exactKeys(identity, ['path', 'device', 'inode', 'mode', 'uid', 'gid'])
      || identity.path !== expected[index]
      || seen.has(identity.path)
      || !/^0[0-7]{3}$/u.test(String(identity.mode || ''))
      || ['device', 'inode', 'uid', 'gid'].some(
        (key) => !/^(?:0|[1-9]\d*)$/u.test(String(identity[key] || '')),
      )) {
      throw new Error(`${label} directory identity is invalid`);
    }
    seen.add(identity.path);
  }
  return directories;
}

function checkpointBaseline(inspected) {
  return {
    document_tree_sha256: inspected.documentTree.tree_sha256,
    document_tree_files: inspected.documentTree.files,
    document_tree_bytes: inspected.documentTree.bytes,
    state_sha256: inspected.stateRecord.sha256,
    state_bytes: inspected.stateRecord.bytes,
    log_sha256: inspected.logRecord.sha256,
    log_bytes: inspected.logRecord.bytes,
    log_device: inspected.logRecord.dev,
    log_inode: inspected.logRecord.ino,
  };
}

function requireCheckpointBaseline(value, inspected) {
  if (!exactKeys(value, [
    'document_tree_sha256',
    'document_tree_files',
    'document_tree_bytes',
    'state_sha256',
    'state_bytes',
    'log_sha256',
    'log_bytes',
    'log_device',
    'log_inode',
  ]) || !sameJson(value, checkpointBaseline(inspected))) {
    throw new Error('partial checkpoint baseline differs from the frozen incident');
  }
  return value;
}

function checkpointStateRecord(checkpoint) {
  const state = requireCheckpointIdentity(
    checkpoint.value.state,
    'partial checkpoint state',
    { includeBase64: true },
  );
  return { ...state, raw: Buffer.from(state.base64, 'base64') };
}

function validateStateForwardOnly(previousRaw, currentRaw, documentId) {
  const previous = parseJson(previousRaw, 'previous partial checkpoint state');
  const current = parseJson(currentRaw, 'current partial checkpoint state');
  if (previous.document_id !== documentId || current.document_id !== documentId) {
    throw new Error('partial checkpoint state document identity changed');
  }
  const previousCompleted = Array.isArray(previous.completed_pages) ? previous.completed_pages : [];
  const currentCompleted = new Set(Array.isArray(current.completed_pages) ? current.completed_pages : []);
  for (const page of previousCompleted) {
    if (!currentCompleted.has(page)
      || !sameJson(previous.pages?.[String(page)], current.pages?.[String(page)])) {
      throw new Error(`partial checkpoint lost immutable completed page ${page}`);
    }
  }
}

function checkpointLogReference(inspected, checkpoint) {
  if (!checkpoint) {
    return {
      sha256: inspected.logRecord.sha256,
      bytes: inspected.logRecord.bytes,
      device: inspected.logRecord.dev,
      inode: inspected.logRecord.ino,
    };
  }
  const identity = checkpoint.value.append_only_log;
  return {
    sha256: identity.sha256,
    bytes: identity.bytes,
    device: identity.device,
    inode: identity.inode,
  };
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

async function verifyForwardOnlyDocument(inspected, previousCheckpoint = null) {
  const beforeInventory = previousCheckpoint
    ? requireCheckpointTree(previousCheckpoint.value.document_tree, 'previous partial checkpoint')
    : inspected.documentTree;
  const directoryIdentities = previousCheckpoint
    ? requireCheckpointDirectories(
        previousCheckpoint.value.directories,
        beforeInventory,
        'previous partial checkpoint',
      )
    : inspected.directoryIdentities;
  const previousState = previousCheckpoint
    ? checkpointStateRecord(previousCheckpoint)
    : { raw: inspected.stateRaw };
  const logReference = checkpointLogReference(inspected, previousCheckpoint);
  const { documentRoot } = inspected;
  await verifyDirectoryIdentities(documentRoot, directoryIdentities);
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
  if (log.dev !== logReference.device
    || log.ino !== logReference.inode
    || log.bytes < logReference.bytes
    || sha256(log.raw.subarray(0, logReference.bytes)) !== logReference.sha256) {
    throw new Error('document log was replaced, truncated, or lost its immutable prefix');
  }
  const state = await readStableFileRecord(
    inspected.outputRoot,
    inspected.statePath,
    'continued document state',
  );
  validateStateForwardOnly(previousState.raw, state.raw, inspected.document.id);
  return { after, log, state };
}

async function verifyExactPartialCheckpointSnapshot(inspected, checkpoint) {
  requireCheckpointBaseline(checkpoint.value.baseline, inspected);
  const expectedTree = requireCheckpointTree(
    checkpoint.value.document_tree,
    'partial checkpoint',
  );
  const expectedState = checkpointStateRecord(checkpoint);
  const expectedLog = requireCheckpointIdentity(
    {
      sha256: checkpoint.value.append_only_log?.sha256,
      bytes: checkpoint.value.append_only_log?.bytes,
      device: checkpoint.value.append_only_log?.device,
      inode: checkpoint.value.append_only_log?.inode,
    },
    'partial checkpoint log',
  );
  const directories = requireCheckpointDirectories(
    checkpoint.value.directories,
    expectedTree,
    'partial checkpoint',
  );
  await verifyDirectoryIdentities(inspected.documentRoot, directories);
  const [actualTree, actualState, actualLog] = await Promise.all([
    inspectTreeStrict(inspected.documentRoot),
    readStableFileRecord(inspected.outputRoot, inspected.statePath, 'partial checkpoint state'),
    readStableFileRecord(inspected.outputRoot, inspected.logPath, 'partial checkpoint log'),
  ]);
  await verifyDirectoryIdentities(inspected.documentRoot, directories);
  if (!sameJson(actualTree, expectedTree)) {
    throw new Error('live document differs from the durable partial checkpoint document tree');
  }
  if (actualState.sha256 !== expectedState.sha256
    || actualState.bytes !== expectedState.bytes
    || actualState.dev !== expectedState.device
    || actualState.ino !== expectedState.inode
    || !actualState.raw.equals(expectedState.raw)) {
    throw new Error('live state differs from the durable partial checkpoint state identity');
  }
  if (actualLog.sha256 !== expectedLog.sha256
    || actualLog.bytes !== expectedLog.bytes
    || actualLog.dev !== expectedLog.device
    || actualLog.ino !== expectedLog.inode) {
    throw new Error('live log differs from the durable partial checkpoint log identity');
  }
  return { tree: actualTree, state: actualState, log: actualLog };
}

async function buildPartialCheckpointPayload(
  inspected,
  progression,
  forward,
  checkpointedAt,
) {
  const execution = progression.executionStates.at(-1);
  if (!execution) throw new Error('partial checkpoint has no execution state');
  const previousCheckpoint = progression.partialCheckpoints.at(-1) || null;
  const previousLog = checkpointLogReference(inspected, previousCheckpoint);
  const stateEntry = forwardOnlyEntryMap(forward.after.entries).get('state.json');
  const stateParts = typeof stateEntry === 'string'
    ? stateEntry.slice(0, -1).split('\0')
    : [];
  if (stateParts.length !== 4
    || stateParts[0] !== 'F'
    || stateParts[2] !== String(forward.state.bytes)
    || stateParts[3] !== forward.state.sha256) {
    throw new Error('partial checkpoint state differs from its strict document tree');
  }
  const directories = await captureDirectoryIdentities(inspected.documentRoot, forward.after);
  await verifyDirectoryIdentities(inspected.documentRoot, directories);
  const payload = {
    checkpointed_at: checkpointedAt,
    execution_state_sha256: execution.sha256,
    previous_checkpoint_state_sha256: previousCheckpoint?.sha256 || null,
    baseline: checkpointBaseline(inspected),
    document_tree: structuredClone(forward.after),
    state: {
      sha256: forward.state.sha256,
      bytes: forward.state.bytes,
      device: forward.state.dev,
      inode: forward.state.ino,
      base64: forward.state.raw.toString('base64'),
    },
    append_only_log: {
      sha256: forward.log.sha256,
      bytes: forward.log.bytes,
      device: forward.log.dev,
      inode: forward.log.ino,
      prefix_sha256: previousLog.sha256,
      prefix_bytes: previousLog.bytes,
    },
    directories,
  };
  return payload;
}

async function verifyFrozenPreSpawnSnapshot(inspected, profile, partialCheckpoint = null) {
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
    || grant.digest !== profile.timeoutGrantSha256
    || claim.digest !== profile.timeoutConsumptionClaimSha256) {
    throw new Error('frozen output or authority provenance changed immediately before OCR spawn');
  }
  if (partialCheckpoint) {
    await verifyExactPartialCheckpointSnapshot(inspected, partialCheckpoint);
  } else {
    if (state.sha256 !== profile.stateSha256
      || state.bytes !== inspected.stateRecord.bytes
      || state.dev !== inspected.stateRecord.dev
      || state.ino !== inspected.stateRecord.ino
      || log.sha256 !== profile.logSha256
      || log.bytes !== profile.logBytes
      || log.dev !== inspected.logRecord.dev
      || log.ino !== inspected.logRecord.ino) {
      throw new Error('frozen state or log provenance changed immediately before OCR spawn');
    }
    await verifyDirectoryIdentities(inspected.documentRoot, inspected.directoryIdentities);
  }
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

function validatePartialCheckpointJournalState(
  checkpoint,
  ordinal,
  execution,
  previousCheckpoint,
  expectedDocumentId,
) {
  const expectedStage = `partial_checkpoint_${String(ordinal).padStart(4, '0')}`;
  requireExactStateKeys(checkpoint.value, [
    'checkpointed_at',
    'execution_state_sha256',
    'previous_checkpoint_state_sha256',
    'baseline',
    'document_tree',
    'state',
    'append_only_log',
    'directories',
  ], `operator continuation ${expectedStage} state`);
  requireCanonicalTimestamp(checkpoint.value.checkpointed_at, `${expectedStage} time`);
  const executionTimestamp = execution.value.resumed_at || execution.value.started_at;
  if (checkpoint.value.stage !== expectedStage
    || checkpoint.value.execution_state_sha256 !== execution.sha256
    || checkpoint.value.previous_checkpoint_state_sha256 !== (previousCheckpoint?.sha256 || null)
    || Date.parse(checkpoint.value.checkpointed_at) < Date.parse(executionTimestamp)) {
    throw new Error('operator continuation partial checkpoint chain is invalid');
  }
  const tree = requireCheckpointTree(checkpoint.value.document_tree, expectedStage);
  const state = requireCheckpointIdentity(
    checkpoint.value.state,
    `${expectedStage} state`,
    { includeBase64: true },
  );
  const checkpointState = parseJson(
    Buffer.from(state.base64, 'base64'),
    `${expectedStage} state`,
  );
  if (checkpointState.document_id !== expectedDocumentId
    || checkpointState.selected_pages_complete !== false
    || !Array.isArray(checkpointState.completed_pages)
    || checkpointState.completed_pages.length >= checkpointState.page_count) {
    throw new Error(`${expectedStage} state is not an incomplete OCR document`);
  }
  const appendOnlyLog = checkpoint.value.append_only_log;
  if (!exactKeys(appendOnlyLog, [
    'sha256', 'bytes', 'device', 'inode', 'prefix_sha256', 'prefix_bytes',
  ])) throw new Error(`${expectedStage} append-only log identity is invalid`);
  requireCheckpointIdentity({
    sha256: appendOnlyLog.sha256,
    bytes: appendOnlyLog.bytes,
    device: appendOnlyLog.device,
    inode: appendOnlyLog.inode,
  }, `${expectedStage} append-only log`);
  if (!sha256Pattern.test(String(appendOnlyLog.prefix_sha256 || ''))
    || !Number.isSafeInteger(appendOnlyLog.prefix_bytes)
    || appendOnlyLog.prefix_bytes < 1
    || appendOnlyLog.bytes < appendOnlyLog.prefix_bytes) {
    throw new Error(`${expectedStage} append-only log prefix is invalid`);
  }
  const stateEntry = forwardOnlyEntryMap(tree.entries).get('state.json');
  const stateParts = typeof stateEntry === 'string' ? stateEntry.slice(0, -1).split('\0') : [];
  if (stateParts.length !== 4
    || stateParts[0] !== 'F'
    || stateParts[2] !== String(state.bytes)
    || stateParts[3] !== state.sha256) {
    throw new Error(`${expectedStage} state differs from its strict tree`);
  }
  requireCheckpointDirectories(checkpoint.value.directories, tree, expectedStage);
  return checkpoint;
}

function validateJournalProgression(states, claim, expectedUnitFence) {
  if (states.length === 0) {
    return {
      claimed: null,
      executionStates: [],
      partialCheckpoints: [],
      terminalPlan: null,
      terminal: null,
    };
  }
  const claimed = states[0];
  requireExactStateKeys(
    claimed.value,
    ['claimed_at', 'worker_invocation_id', 'quiescent_unit_fence', 'llama_start_nonce_seed'],
    'operator continuation claimed state',
  );
  if (claimed.value.stage !== 'claimed'
    || claimed.value.claimed_at !== claim.claim.claimed_at
    || !invocationIdPattern.test(String(claimed.value.worker_invocation_id || ''))
    || claimed.value.llama_start_nonce_seed !== llamaStartNonceSeed(claim.claim.claim_id)
    || !sameJson(claimed.value.quiescent_unit_fence, expectedUnitFence)) {
    throw new Error('operator continuation claimed state or unit fence is invalid');
  }
  const executionStates = [];
  const partialCheckpoints = [];
  let index = 1;
  if (states[index]) {
    const running = states[index];
    requireExactStateKeys(
      running.value,
      [
        'started_at',
        'llama_invocation_id',
        'llama_main_pid',
        'llama_start_nonce',
        'spawn_nonce',
        'ocr_command_sha256',
      ],
      'operator continuation running state',
    );
    if (running.value.stage !== 'running'
      || running.value.started_at !== claim.claim.claimed_at
      || !invocationIdPattern.test(String(running.value.llama_invocation_id || ''))
      || !/^[1-9]\d*$/u.test(String(running.value.llama_main_pid || ''))
      || running.value.llama_start_nonce !== llamaStartNonce(claimed.value.llama_start_nonce_seed, 0)
      || !sha256Pattern.test(String(running.value.spawn_nonce || ''))
      || !sha256Pattern.test(String(running.value.ocr_command_sha256 || ''))) {
      throw new Error('operator continuation running state is invalid');
    }
    executionStates.push(running);
    index += 1;
  }
  const invocationIds = new Set(executionStates.map(({ value }) => value.llama_invocation_id));
  const spawnNonces = new Set(executionStates.map(({ value }) => value.spawn_nonce));
  let resumeOrdinal = 1;
  while (executionStates.length > 0) {
    const predecessor = executionStates.at(-1);
    const expectedCheckpointStage = `partial_checkpoint_${String(executionStates.length).padStart(4, '0')}`;
    let checkpoint = null;
    if (states[index]?.value.stage === expectedCheckpointStage) {
      checkpoint = validatePartialCheckpointJournalState(
        states[index],
        executionStates.length,
        predecessor,
        partialCheckpoints.at(-1) || null,
        claim.claim.document_id,
      );
      partialCheckpoints.push(checkpoint);
      index += 1;
    }
    const expectedStage = `resume_running_${String(resumeOrdinal).padStart(4, '0')}`;
    if (states[index]?.value.stage !== expectedStage) break;
    if (!checkpoint) {
      throw new Error('operator continuation resume_running has no durable partial checkpoint');
    }
    const resumed = states[index];
    requireExactStateKeys(
      resumed.value,
      [
        'resumed_at',
        'llama_invocation_id',
        'llama_main_pid',
        'llama_start_nonce',
        'spawn_nonce',
        'ocr_command_sha256',
        'resumed_from_state_sha256',
        'partial_checkpoint_state_sha256',
      ],
      `operator continuation ${expectedStage} state`,
    );
    const predecessorTimestamp = predecessor?.value.resumed_at || predecessor?.value.started_at;
    if (resumed.value.stage !== expectedStage
      || !predecessor
      || resumed.value.resumed_from_state_sha256 !== predecessor.sha256
      || resumed.value.partial_checkpoint_state_sha256 !== checkpoint.sha256
      || !invocationIdPattern.test(String(resumed.value.llama_invocation_id || ''))
      || invocationIds.has(resumed.value.llama_invocation_id)
      || spawnNonces.has(resumed.value.spawn_nonce)
      || !/^[1-9]\d*$/u.test(String(resumed.value.llama_main_pid || ''))
      || resumed.value.llama_start_nonce !== llamaStartNonce(
        claimed.value.llama_start_nonce_seed,
        executionStates.length,
      )
      || !sha256Pattern.test(String(resumed.value.spawn_nonce || ''))
      || !sha256Pattern.test(String(resumed.value.ocr_command_sha256 || ''))) {
      throw new Error('operator continuation resume_running chain is invalid');
    }
    requireCanonicalTimestamp(resumed.value.resumed_at, 'operator continuation resume time');
    if (Date.parse(resumed.value.resumed_at) < Date.parse(predecessorTimestamp)) {
      throw new Error('operator continuation resume_running chronology is invalid');
    }
    invocationIds.add(resumed.value.llama_invocation_id);
    spawnNonces.add(resumed.value.spawn_nonce);
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
  return { claimed, executionStates, partialCheckpoints, terminalPlan, terminal };
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

async function loadExistingRecoveryJournal(profile, runtimeManifest, currentUnitFence) {
  const paths = operatorContinuationPaths(profile.evidenceBaseRoot, profile.documentId, profile.attempt);
  const rootPresent = await lstat(paths.root).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (!rootPresent) return null;
  const root = await requireStableDirectory(paths.root, 'existing continuation recovery root', { mode: 0o700 });
  const claimPresent = await lstat(paths.claim).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  const claimSidecarPresent = await lstat(paths.claimSidecar).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (!claimPresent || !claimSidecarPresent) return null;
  const [receiptRecord, claimRecord, archivedRuntimeManifest] = await Promise.all([
    readStableFileWithSidecarRecord(paths.root, paths.receipt, 'existing continuation recovery receipt'),
    readStableFileWithSidecarRecord(paths.root, paths.claim, 'existing continuation recovery claim'),
    readStableFileWithSidecarRecord(paths.root, paths.runtimeManifest, 'existing continuation recovery runtime manifest'),
  ]);
  const receipt = parseJson(receiptRecord.raw, 'existing continuation recovery receipt');
  const claimValue = parseJson(claimRecord.raw, 'existing continuation recovery claim');
  validateArchivedA2ContinuationRuntimeManifest(archivedRuntimeManifest.raw, runtimeManifest);
  const receiptBasis = { ...receipt };
  delete receiptBasis.continuation_id;
  const claimBasis = { ...claimValue };
  delete claimBasis.claim_id;
  if (receipt.schema_version !== 3
    || receipt.receipt_type !== receiptType
    || receipt.mode !== continuationMode
    || receipt.profile_sha256 !== a2ForwardContinuationProfileFingerprint(profile)
    || receipt.continuation_id !== sha256(canonicalJson(receiptBasis))
    || receipt.output?.root !== profile.outputRoot
    || receipt.output?.device !== profile.outputDevice
    || receipt.output?.inode !== profile.outputInode
    || receipt.document?.document_id !== profile.documentId
    || receipt.document?.attempt !== profile.attempt
    || receipt.authorization?.worker_invocation_id !== profile.workerInvocationId
    || receipt.authorization?.runtime_manifest?.sha256 !== runtimeManifest.sha256
    || claimValue.schema_version !== 2
    || claimValue.claim_type !== claimType
    || claimValue.mode !== continuationMode
    || claimValue.continuation_id !== receipt.continuation_id
    || claimValue.receipt_sha256 !== receiptRecord.sha256
    || claimValue.output?.root !== profile.outputRoot
    || claimValue.output?.device !== profile.outputDevice
    || claimValue.output?.inode !== profile.outputInode
    || claimValue.evidence_root?.path !== paths.root
    || claimValue.evidence_root?.device !== String(root.info.dev)
    || claimValue.evidence_root?.inode !== String(root.info.ino)
    || claimValue.document_id !== profile.documentId
    || claimValue.attempt !== profile.attempt
    || claimValue.profile_sha256 !== receipt.profile_sha256
    || claimValue.claim_id !== sha256(canonicalJson(claimBasis))
    || claimValue.citation_allowed !== false) {
    throw new Error('existing recovery journal authority is not the exact frozen continuation claim');
  }
  const claim = { claim: claimValue, raw: claimRecord.raw, sha256: claimRecord.sha256 };
  let scanned = await scanJournal(paths, claim);
  if (scanned.states.length === 0) return { paths, claim, progression: null };
  const claimedFence = scanned.states[0].value.quiescent_unit_fence;
  requireSameContinuationUnitFence(currentUnitFence, claimedFence);
  scanned = await recoverTrailingJournalPair(paths, claim, claimedFence);
  const progression = validateJournalProgression(scanned.states, claim, claimedFence);
  return { paths, claim, progression, claimedFence };
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
    await recoverableTerminalAtomicReplace(
      inspected.outputRoot,
      record.pathname,
      record.after,
      record,
      terminalPlanState,
      dependencies,
    );
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

async function validateRecoveredDocumentOutput(inspected, runtime, dependencies = {}) {
  const validateOutput = dependencies.validateDocumentOutput || validateOcrDocumentOutput;
  const workerConfiguration = dependencies.recoveredWorkerConfiguration
    || inspected.identity.worker_configuration;
  try {
    return {
      complete: true,
      artifacts: await validateOutput(
        inspected.document,
        inspected.documentRoot,
        runtime,
        { requireComplete: true, workerConfiguration },
      ),
    };
  } catch (error) {
    if (!(error instanceof IncompleteOcrDocumentError)) throw error;
    const artifacts = await validateOutput(
      inspected.document,
      inspected.documentRoot,
      runtime,
      { requireComplete: false, workerConfiguration },
    );
    return { complete: false, artifacts, incomplete: error };
  }
}

function requireSigkillCheckpointProgress(inspected, previousCheckpoint, forward) {
  const previousTree = previousCheckpoint?.value.document_tree || inspected.documentTree;
  const previousState = previousCheckpoint
    ? checkpointStateRecord(previousCheckpoint)
    : { sha256: inspected.stateRecord.sha256, raw: inspected.stateRaw };
  const previousLog = checkpointLogReference(inspected, previousCheckpoint);
  const previousStateValue = parseJson(previousState.raw, 'pre-SIGKILL checkpoint state');
  const currentStateValue = parseJson(forward.state.raw, 'post-SIGKILL checkpoint state');
  if (forward.after.tree_sha256 === previousTree.tree_sha256
    || forward.state.sha256 === previousState.sha256
    || forward.log.bytes <= previousLog.bytes
    || !Array.isArray(previousStateValue.completed_pages)
    || !Array.isArray(currentStateValue.completed_pages)
    || currentStateValue.completed_pages.length <= previousStateValue.completed_pages.length) {
    throw new Error('SIGKILL left no complete durable page/state/log progress to checkpoint');
  }
}

export async function continueOperatorInterruptedAttempt(options, dependencies = {}) {
  const profile = validateA2ForwardContinuationProfile(
    dependencies.incidentProfile || EXACT_A2_FORWARD_CONTINUATION_INCIDENT,
  );
  validateOptions(options, profile);
  const runtimeManifest = await validateA2ContinuationRuntimeManifest();
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
  let ownedLlamaIdentity = null;
  let pendingLlamaIdentity = null;
  let llamaStartMarkerTouched = false;
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
    const recoveryFenceUnits = await inspectContinuationFenceUnits(profile, dependencies);
    const existingRecovery = await loadExistingRecoveryJournal(
      profile,
      runtimeManifest,
      recoveryFenceUnits,
    );
    const existingProgression = existingRecovery?.progression || null;
    const priorExecutionState = existingProgression?.executionStates.at(-1) || null;
    if (existingProgression && options.apply === true) {
      const inspectUnit = dependencies.inspectUnit || inspectSystemdUnit;
      const observedLlama = await inspectUnit(profile.llamaUnit, 'llama');
      const observedActive = observedLlama.LoadState === 'loaded'
        && observedLlama.ActiveState === 'active'
        && observedLlama.SubState === 'running';
      const priorOwnsActive = priorExecutionState
        && observedActive
        && observedLlama.InvocationID === priorExecutionState.value.llama_invocation_id
        && observedLlama.MainPID === priorExecutionState.value.llama_main_pid;
      if (priorOwnsActive || !observedActive) {
        if (priorExecutionState) {
          await reconcileOwnedContinuationExecution(profile, priorExecutionState, dependencies);
        } else {
          requireQuiescentUnit(observedLlama, profile.llamaUnit, 'llama');
        }
      } else {
        const claimed = existingProgression.claimed;
        if (!claimed) throw new Error('active llama has no durable continuation start intent');
        const expectedStartNonce = llamaStartNonce(
          claimed.value.llama_start_nonce_seed,
          existingProgression.executionStates.length,
        );
        await verifyLlamaStartMarker(observedLlama, expectedStartNonce, dependencies).catch(() => {
          throw new Error('active llama start marker is not owned by the pending continuation intent');
        });
        if (priorExecutionState) {
          const findProcesses = dependencies.findOwnedOcrProcesses || findOwnedOcrProcesses;
          const stale = await findProcesses(priorExecutionState);
          if (!Array.isArray(stale) || stale.length !== 0) {
            throw new Error('pending llama start coexists with an unreconciled prior OCR process');
          }
        }
        pendingLlamaIdentity = {
          ...observedLlama,
          startNonce: expectedStartNonce,
        };
        ownedLlamaIdentity = pendingLlamaIdentity;
        llamaStartMarkerTouched = true;
      }
      const recoveredFenceUnits = await inspectContinuationFenceUnits(profile, dependencies);
      requireSameContinuationUnitFence(recoveredFenceUnits, existingRecovery.claimedFence);
    }
    if (pendingLlamaIdentity) {
      frozenUnitFence = existingRecovery.claimedFence;
    } else {
      const initialUnits = await inspectA2ContinuationUnits(profile, dependencies);
      frozenUnitFence = continuationUnitFence(initialUnits);
    }
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
    const inspected = await inspectInterruptedState(options, profile, runtimeManifest);
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
    const continuationLlamaStartNonceSeed = llamaStartNonceSeed(claim.claim.claim_id);
    await appendJournalState(published.paths, claim, 'claimed', {
      claimed_at: options.continuedAt,
      worker_invocation_id: profile.workerInvocationId,
      quiescent_unit_fence: frozenUnitFence,
      llama_start_nonce_seed: continuationLlamaStartNonceSeed,
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

    let progression = validateJournalProgression(journal.states, claim, frozenUnitFence);
    if (progression.executionStates.length > 0) {
      // A crash may occur after the child exits but before its terminal plan is
      // journaled. A fully valid forward result is finalized without invoking
      // OCR again; an incomplete but forward-only result resumes the same
      // already claimed attempt 6.
      const previousCheckpoint = progression.partialCheckpoints.at(-1) || null;
      const lastExecution = progression.executionStates.at(-1);
      const checkpointForLastExecution = previousCheckpoint?.value.execution_state_sha256
        === lastExecution.sha256
        ? previousCheckpoint
        : null;
      let forward;
      let recovered;
      if (checkpointForLastExecution) {
        await verifyExactPartialCheckpointSnapshot(inspected, checkpointForLastExecution);
        forward = await verifyForwardOnlyDocument(inspected, checkpointForLastExecution);
        recovered = await validateRecoveredDocumentOutput(
          inspected,
          inspected.identity.runtime,
          dependencies,
        );
        if (recovered.complete) {
          throw new Error('partial checkpoint unexpectedly describes a complete document');
        }
      } else {
        forward = await verifyForwardOnlyDocument(inspected, previousCheckpoint);
        recovered = await validateRecoveredDocumentOutput(
          inspected,
          inspected.identity.runtime,
          dependencies,
        );
      }
      if (recovered.complete) {
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
            artifacts: { ...recovered.artifacts, forward_document_tree: forward.after, append_only_log: {
              sha256: forward.log.sha256,
              bytes: forward.log.bytes,
              device: forward.log.dev,
              inode: forward.log.ino,
            } },
          },
          guardedDependencies,
        );
      }
      if (!checkpointForLastExecution) {
        const checkpointedAt = requireCanonicalTimestamp(
          dependencies.now?.() || new Date().toISOString(),
          'partial checkpoint timestamp',
        );
        const checkpointStage = `partial_checkpoint_${String(progression.executionStates.length).padStart(4, '0')}`;
        const payload = await buildPartialCheckpointPayload(
          inspected,
          progression,
          forward,
          checkpointedAt,
        );
        await appendJournalState(
          published.paths,
          claim,
          checkpointStage,
          payload,
          guardedDependencies,
        );
        journal = await recoverTrailingJournalPair(published.paths, claim, frozenUnitFence);
        progression = validateJournalProgression(journal.states, claim, frozenUnitFence);
      }
    }

    const nextLlamaStartNonce = llamaStartNonce(
      progression.claimed.value.llama_start_nonce_seed,
      progression.executionStates.length,
    );
    let activeLlama;
    if (pendingLlamaIdentity) {
      await transactionGuard('before_llama_adopt');
      activeLlama = await inspectActiveLlama(
        profile,
        pendingLlamaIdentity.InvocationID,
        dependencies,
      );
      if (activeLlama.MainPID !== pendingLlamaIdentity.MainPID) {
        throw new Error('pending llama MainPID changed before adoption');
      }
      await verifyLlamaStartMarker(activeLlama, nextLlamaStartNonce, dependencies).catch(() => {
        throw new Error('active llama start marker is not owned by the pending continuation intent');
      });
      ownedLlamaIdentity = { ...activeLlama, startNonce: nextLlamaStartNonce };
      await clearLlamaStartMarker(profile, dependencies);
      llamaStartMarkerTouched = false;
    } else {
      await transactionGuard('before_llama_start');
      llamaStartMarkerTouched = true;
      await setLlamaStartMarker(profile, nextLlamaStartNonce, dependencies);
      let startError = null;
      try {
        await startExactLlama(profile, dependencies);
      } catch (error) {
        startError = error;
      }
      try {
        activeLlama = await inspectActiveLlama(profile, null, dependencies);
        await verifyLlamaStartMarker(activeLlama, nextLlamaStartNonce, dependencies).catch(() => {
          throw new Error('active llama start marker is not owned by the pending continuation intent');
        });
        ownedLlamaIdentity = { ...activeLlama, startNonce: nextLlamaStartNonce };
      } finally {
        await clearLlamaStartMarker(profile, dependencies);
        llamaStartMarkerTouched = false;
      }
      if (startError) throw startError;
    }
    await dependencies.afterLlamaStartBeforeExecutionState?.({
      InvocationID: activeLlama.InvocationID,
      MainPID: activeLlama.MainPID,
      startNonce: nextLlamaStartNonce,
    });
    const verifyRuntime = dependencies.verifyActiveRuntime || verifyActiveRuntime;
    const activeRuntime = await verifyRuntime(options, inspected, dependencies);
    const source = activeRuntime?.source || {
      sourceSha256: inspected.document.source_sha256,
      pageCount: inspected.document.page_count,
    };
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
    const spawnNonce = sha256(randomUUID());
    const ocrCommandSha256 = sha256(canonicalJson([options.python, ...commandArguments]));
    const previousExecutionState = progression.executionStates.at(-1);
    const resumeCheckpoint = progression.partialCheckpoints.at(-1) || null;
    if (previousExecutionState
      && resumeCheckpoint?.value.execution_state_sha256 !== previousExecutionState.sha256) {
      throw new Error('resumed execution has no exact durable partial checkpoint');
    }
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
      llama_start_nonce: nextLlamaStartNonce,
      spawn_nonce: spawnNonce,
      ocr_command_sha256: ocrCommandSha256,
      resumed_from_state_sha256: previousExecutionState.sha256,
      partial_checkpoint_state_sha256: resumeCheckpoint.sha256,
    } : {
      started_at: executionTimestamp,
      llama_invocation_id: activeLlama.InvocationID,
      llama_main_pid: activeLlama.MainPID,
      llama_start_nonce: nextLlamaStartNonce,
      spawn_nonce: spawnNonce,
      ocr_command_sha256: ocrCommandSha256,
    }, guardedDependencies);
    await transactionGuard('after_execution_state');
    const preSpawnUnits = await inspectPreSpawnUnits(profile, activeLlama, dependencies);
    requireSameContinuationUnitFence(preSpawnUnits, frozenUnitFence);
    await verifyFrozenPreSpawnSnapshot(inspected, profile, resumeCheckpoint);

    const invoke = dependencies.invokeOcr || invokeOcrChild;
    let childResult;
    let invocationError;
    try {
      childResult = await invoke(options.python, commandArguments, {
        env: {
          ...process.env,
          PADDLE_PDX_CACHE_HOME: inspected.identity.worker_configuration.paddlex_cache_home,
          [spawnNonceEnvironmentKey]: spawnNonce,
          [commandShaEnvironmentKey]: ocrCommandSha256,
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
    await dependencies.afterChildExit?.({ childResult, invocationError });
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
    let sigkillValidationError = null;
    let resumableSigkill = null;
    if (childResult?.signal === 'SIGKILL' && !monitorIncident && !invocationError) {
      try {
        const forward = await verifyForwardOnlyDocument(inspected, resumeCheckpoint);
        const recovered = await validateRecoveredDocumentOutput(
          inspected,
          activeRuntime?.runtime || inspected.identity.runtime,
          dependencies,
        );
        if (!recovered.complete) {
          requireSigkillCheckpointProgress(inspected, resumeCheckpoint, forward);
          resumableSigkill = { forward };
        }
      } catch (error) {
        sigkillValidationError = error;
      }
    }
    if (resumableSigkill) {
      await transactionGuard('before_sigkill_partial_checkpoint');
      journal = await recoverTrailingJournalPair(published.paths, claim, frozenUnitFence);
      const sigkillProgression = validateJournalProgression(
        journal.states,
        claim,
        frozenUnitFence,
      );
      const sigkillExecution = sigkillProgression.executionStates.at(-1);
      if (!sigkillExecution
        || sigkillExecution.value.spawn_nonce !== spawnNonce
        || sigkillExecution.value.ocr_command_sha256 !== ocrCommandSha256
        || sigkillExecution.value.llama_invocation_id !== activeLlama.InvocationID
        || sigkillProgression.partialCheckpoints.at(-1)?.value.execution_state_sha256
          === sigkillExecution.sha256) {
        throw new Error('SIGKILL checkpoint does not belong to the just-finished execution');
      }
      const checkpointStage = `partial_checkpoint_${String(sigkillProgression.executionStates.length).padStart(4, '0')}`;
      const checkpointPayload = await buildPartialCheckpointPayload(
        inspected,
        sigkillProgression,
        resumableSigkill.forward,
        timestamp,
      );
      const checkpoint = await appendJournalState(
        published.paths,
        claim,
        checkpointStage,
        checkpointPayload,
        guardedDependencies,
      );
      await verifyExactPartialCheckpointSnapshot(inspected, checkpoint);
      await transactionGuard('after_sigkill_partial_checkpoint');
      return {
        status: 'resumable',
        exitCode: 75,
        signal: childResult.signal,
        continuation_id: inspected.receipt.continuation_id,
        receipt_sha256: published.receiptSha256,
        claim_sha256: claim.sha256,
        partial_checkpoint_state_sha256: checkpoint.sha256,
        document_id: options.documentId,
        attempt: attemptCeiling,
        citation_allowed: false,
      };
    }
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
              ? `OCR child terminated by ${childResult.signal}${sigkillValidationError
                  ? `; partial output is not resumable: ${sigkillValidationError.message}`
                  : ''}`
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
    const forward = await verifyForwardOnlyDocument(
      inspected,
      resumeCheckpoint,
    ).catch(async (error) => ({ validationError: error }));
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
      if (ownedLlamaIdentity) {
        await stopExactLlama(profile, ownedLlamaIdentity, dependencies);
      }
    } catch (error) {
      finalizationErrors.push(error);
    }
    try {
      if (llamaStartMarkerTouched) {
        await clearLlamaStartMarker(profile, dependencies);
        llamaStartMarkerTouched = false;
      }
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
        `continuation failed: ${primaryError.message}; five-unit quiescent closeout also failed: ${finalizationError.message}`,
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
