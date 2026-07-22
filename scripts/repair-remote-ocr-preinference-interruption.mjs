#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  canonicalJson,
  inspectPredecessorB1,
  inspectSuccessorB2,
  inspectTreeStrict,
} from './monitor-remote-ocr-single-shard.mjs';

const execFile = promisify(execFileCallback);
const sha256Pattern = /^[a-f0-9]{64}$/u;
const invocationIdPattern = /^[a-f0-9]{32}$/u;
const documentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const unitPattern = /^[A-Za-z0-9][A-Za-z0-9_.@:-]*\.(?:service|timer)$/u;
const repairType = 'curriculum_remote_ocr_preinference_interruption_rearm';
const receiptStatus = 'prepared_atomic_apply_required';
const grantedAttempt = 6;
const inheritedAttempt = 5;
const expectedWorkerExitStatus = 75;
const exactA2Incident = Object.freeze({
  outputRoot: '/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/output/production-p1-mb16-shard-a-r2',
  predecessorRoot: '/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/output/production-p4-mb16-shard-a-r1',
  evidenceRoot: '/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/a2-deploy-evidence/20260719T003812Z',
  lifecycleLock: '/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/.a2-lifecycle.lock',
  documentId: 'legacy-compendium-english',
  workerUnit: 'curriculum-ocr-reprocess-a-r2.service',
  monitorUnit: 'curriculum-ocr-reprocess-a-r2-monitor.service',
  monitorTimerUnit: 'curriculum-ocr-reprocess-a-r2-monitor.timer',
  retryTimerUnit: 'curriculum-ocr-monitor-alert-retry@curriculum-ocr-reprocess-a-r2-monitor.service.timer',
  alertUnit: 'curriculum-ocr-monitor-alert@curriculum-ocr-reprocess-a-r2-monitor.service.service',
  expectedOutputInode: '45748776',
  expectedWorkerInvocationId: '0916aeada09b4f38bb7b4b17b6063712',
  expectedStartedAt: '2026-07-22T02:32:45.088Z',
  expectedInterruptedAt: '2026-07-22T02:32:47.128Z',
  expectedRunStatusSha256: '1efe426705557843ee0023abf556890e8df2a4052cef13d82e9e7d04111c98e7',
  expectedDocumentStatusSha256: '3cf110083dc94c6d5bf9eebd4c42ab8243eb9a8528abccac9dc27d56a6bde6cb',
  expectedLogSha256: '2a55211f63eac4f946d19d2c2c4309b4da8c6db65834f62268f0f0fd10ba6c6a',
  expectedLogBytes: 1189,
  expectedStateSha256: 'd16de657043c260136552cd8cf881791f42308169e2ecf55fe0cab5f155aa09d',
});
const mutableRelativePaths = Object.freeze([
  'status/{document}.json',
  'status/{document}.json.sha256',
  'run-status.json',
  'run-status.json.sha256',
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function prettyJson(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function sameValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireSha256(value, label) {
  if (!sha256Pattern.test(String(value || ''))) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function requireCanonicalTimestamp(value, label) {
  const parsed = Date.parse(value);
  if (typeof value !== 'string'
    || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function requireDocumentId(value) {
  if (!documentIdPattern.test(String(value || ''))) throw new Error('document id is invalid');
  return value;
}

function requireUnit(value, label, suffix) {
  if (!unitPattern.test(String(value || '')) || !value.endsWith(suffix)) {
    throw new Error(`${label} must be a canonical ${suffix} unit`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== String(value)) {
    throw new Error(`${label} must be a canonical positive integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      if (values.apply) throw new Error('--apply may appear only once');
      values.apply = true;
      continue;
    }
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`);
    const key = argument.slice(2).replaceAll('-', '_');
    if (Object.hasOwn(values, key)) throw new Error(`duplicate option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${argument}`);
    values[key] = value;
    index += 1;
  }
  return values;
}

function requireExactIncident(options, profile) {
  for (const [key, expected] of Object.entries(profile)) {
    if (options[key] !== expected) {
      throw new Error(`${key} differs from the one authorized A2 pre-inference incident`);
    }
  }
}

export function validateRepairOptions(raw) {
  requireObject(raw, 'repair options');
  const allowed = new Set([
    'alert_unit',
    'apply',
    'document_id',
    'evidence_root',
    'expected_document_status_sha256',
    'expected_document_tree_sha256',
    'expected_interrupted_at',
    'expected_log_bytes',
    'expected_log_sha256',
    'expected_output_inode',
    'expected_run_status_sha256',
    'expected_started_at',
    'expected_state_sha256',
    'expected_worker_invocation_id',
    'lifecycle_lock',
    'monitor_timer_unit',
    'monitor_unit',
    'output_root',
    'predecessor_root',
    'repair_at',
    'retry_timer_unit',
    'worker_unit',
  ]);
  const unexpected = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`repair options contain unexpected fields: ${unexpected.sort().join(',')}`);
  }
  const requiredPaths = ['output_root', 'predecessor_root', 'evidence_root', 'lifecycle_lock'];
  for (const key of requiredPaths) {
    if (typeof raw[key] !== 'string' || !path.isAbsolute(raw[key])) {
      throw new Error(`--${key.replaceAll('_', '-')} must be an absolute path`);
    }
  }
  const options = {
    outputRoot: path.normalize(raw.output_root),
    predecessorRoot: path.normalize(raw.predecessor_root),
    evidenceRoot: path.normalize(raw.evidence_root),
    lifecycleLock: path.normalize(raw.lifecycle_lock),
    documentId: requireDocumentId(raw.document_id),
    workerUnit: requireUnit(raw.worker_unit, 'worker unit', '.service'),
    monitorUnit: requireUnit(raw.monitor_unit, 'monitor unit', '.service'),
    monitorTimerUnit: requireUnit(raw.monitor_timer_unit, 'monitor timer unit', '.timer'),
    retryTimerUnit: requireUnit(raw.retry_timer_unit, 'retry timer unit', '.timer'),
    alertUnit: requireUnit(raw.alert_unit, 'alert unit', '.service'),
    expectedOutputInode: String(requirePositiveInteger(raw.expected_output_inode, 'expected output inode')),
    expectedWorkerInvocationId: String(raw.expected_worker_invocation_id || ''),
    expectedStartedAt: requireCanonicalTimestamp(raw.expected_started_at, 'expected started_at'),
    expectedInterruptedAt: requireCanonicalTimestamp(raw.expected_interrupted_at, 'expected interrupted_at'),
    repairAt: requireCanonicalTimestamp(raw.repair_at, 'repair_at'),
    expectedRunStatusSha256: requireSha256(raw.expected_run_status_sha256, 'expected run-status SHA-256'),
    expectedDocumentStatusSha256: requireSha256(
      raw.expected_document_status_sha256,
      'expected document-status SHA-256',
    ),
    expectedLogSha256: requireSha256(raw.expected_log_sha256, 'expected log SHA-256'),
    expectedLogBytes: requirePositiveInteger(raw.expected_log_bytes, 'expected log bytes'),
    expectedStateSha256: requireSha256(raw.expected_state_sha256, 'expected state SHA-256'),
    expectedDocumentTreeSha256: requireSha256(
      raw.expected_document_tree_sha256,
      'expected document-tree SHA-256',
    ),
    apply: raw.apply === true,
  };
  if (!invocationIdPattern.test(options.expectedWorkerInvocationId)) {
    throw new Error('expected worker invocation id must be 32 lowercase hexadecimal characters');
  }
  if (Date.parse(options.expectedInterruptedAt) <= Date.parse(options.expectedStartedAt)) {
    throw new Error('expected interrupted_at must follow started_at');
  }
  if (Date.parse(options.repairAt) <= Date.parse(options.expectedInterruptedAt)) {
    throw new Error('repair_at must follow interrupted_at');
  }
  const units = [
    options.workerUnit,
    options.monitorUnit,
    options.monitorTimerUnit,
    options.retryTimerUnit,
    options.alertUnit,
  ];
  if (new Set(units).size !== units.length) throw new Error('all five unit names must be distinct');
  return options;
}

function normalizeRepairOptions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.hasOwn(raw, 'outputRoot')) {
    return validateRepairOptions(raw);
  }
  const allowed = [
    'alertUnit',
    'apply',
    'documentId',
    'evidenceRoot',
    'expectedDocumentStatusSha256',
    'expectedDocumentTreeSha256',
    'expectedInterruptedAt',
    'expectedLogBytes',
    'expectedLogSha256',
    'expectedOutputInode',
    'expectedRunStatusSha256',
    'expectedStartedAt',
    'expectedStateSha256',
    'expectedWorkerInvocationId',
    'lifecycleLock',
    'monitorTimerUnit',
    'monitorUnit',
    'outputRoot',
    'predecessorRoot',
    'repairAt',
    'retryTimerUnit',
    'workerUnit',
  ];
  if (!sameValue(Object.keys(raw).sort(), [...allowed].sort())) {
    throw new Error('validated repair option field set is invalid');
  }
  return validateRepairOptions({
    output_root: raw.outputRoot,
    predecessor_root: raw.predecessorRoot,
    evidence_root: raw.evidenceRoot,
    lifecycle_lock: raw.lifecycleLock,
    document_id: raw.documentId,
    worker_unit: raw.workerUnit,
    monitor_unit: raw.monitorUnit,
    monitor_timer_unit: raw.monitorTimerUnit,
    retry_timer_unit: raw.retryTimerUnit,
    alert_unit: raw.alertUnit,
    expected_output_inode: raw.expectedOutputInode,
    expected_worker_invocation_id: raw.expectedWorkerInvocationId,
    expected_started_at: raw.expectedStartedAt,
    expected_interrupted_at: raw.expectedInterruptedAt,
    repair_at: raw.repairAt,
    expected_run_status_sha256: raw.expectedRunStatusSha256,
    expected_document_status_sha256: raw.expectedDocumentStatusSha256,
    expected_log_sha256: raw.expectedLogSha256,
    expected_log_bytes: raw.expectedLogBytes,
    expected_state_sha256: raw.expectedStateSha256,
    expected_document_tree_sha256: raw.expectedDocumentTreeSha256,
    apply: raw.apply,
  });
}

function inside(root, pathname) {
  const relative = path.relative(root, pathname);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function requireRealDirectory(pathname, label) {
  const info = await lstat(pathname).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing`);
    throw error;
  });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  const resolved = await realpath(pathname);
  if (resolved !== path.resolve(pathname)) throw new Error(`${label} must not traverse a symbolic link`);
  return resolved;
}

async function readStableFile(root, pathname, label, { requireMode600 = true } = {}) {
  if (!inside(root, pathname)) throw new Error(`${label} escapes its root`);
  const resolved = await realpath(pathname).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing`);
    throw error;
  });
  if (resolved !== path.resolve(pathname) || !inside(root, resolved)) {
    throw new Error(`${label} traverses a symbolic link`);
  }
  const handle = await open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    const expectedUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : before.uid;
    const expectedGid = typeof process.getgid === 'function' ? BigInt(process.getgid()) : before.gid;
    if (!before.isFile()
      || before.nlink !== 1n
      || before.uid !== expectedUid
      || before.gid !== expectedGid
      || (requireMode600 && (Number(before.mode) & 0o7777) !== 0o600)) {
      throw new Error(`${label} must be a current-owner mode-0600 single-link regular file`);
    }
    const raw = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathnameInfo = await lstat(pathname, { bigint: true });
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || after.nlink !== 1n
      || pathnameInfo.dev !== after.dev
      || pathnameInfo.ino !== after.ino
      || BigInt(raw.byteLength) !== after.size) {
      throw new Error(`${label} changed while it was read`);
    }
    return { raw, sha256: sha256(raw), bytes: raw.byteLength };
  } finally {
    await handle.close();
  }
}

function parseCanonicalJson(record, label) {
  let value;
  try {
    value = JSON.parse(record.raw.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  if (!record.raw.equals(prettyJson(value))) {
    throw new Error(`${label} is not canonical pretty-printed JSON`);
  }
  return value;
}

function sidecarRaw(digest, basename) {
  return Buffer.from(`${digest}  ${basename}\n`);
}

async function readHashBoundJson(root, pathname, label) {
  const [body, sidecar] = await Promise.all([
    readStableFile(root, pathname, label),
    readStableFile(root, `${pathname}.sha256`, `${label} sidecar`),
  ]);
  if (!sidecar.raw.equals(sidecarRaw(body.sha256, path.basename(pathname)))) {
    throw new Error(`${label} sidecar is invalid`);
  }
  return { ...body, value: parseCanonicalJson(body, label), sidecar };
}

function publicRecord(pathname, record) {
  return { path: pathname, bytes: record.bytes, sha256: record.sha256 };
}

async function outputRootEntries(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
  })).filter(({ name }) => !name.endsWith('.rearm-tmp'))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
}

async function inspectNonTransactionOutput(outputRoot, documentId, repairId) {
  const excluded = new Set(mutableRelativePaths.map(
    (value) => value.replace('{document}', documentId),
  ));
  const transactionTemporaries = new Set([...excluded].map((relative) => {
    const dirname = path.posix.dirname(relative);
    const basename = path.posix.basename(relative);
    return path.posix.join(dirname, `.${basename}.${repairId}.rearm-tmp`);
  }));
  const entries = [];
  let files = 0;
  let bytes = 0;
  async function walk(directory, relativeDirectory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    if (relativeDirectory && children.length === 0) entries.push(`D\0${relativeDirectory}\n`);
    for (const child of children) {
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      if (excluded.has(relative) || transactionTemporaries.has(relative)) continue;
      const pathname = path.join(directory, child.name);
      const info = await lstat(pathname);
      if (info.isSymbolicLink()) throw new Error('non-transaction output contains a symbolic link');
      if (info.isDirectory()) {
        entries.push(`D\0${relative}\n`);
        await walk(pathname, relative);
      } else if (info.isFile()) {
        const record = await readStableFile(
          outputRoot,
          pathname,
          `non-transaction output ${relative}`,
          { requireMode600: false },
        );
        entries.push(`F\0${relative}\0${record.bytes}\0${record.sha256}\n`);
        files += 1;
        bytes += record.bytes;
      } else {
        throw new Error('non-transaction output contains a non-regular entry');
      }
    }
  }
  await walk(outputRoot, '');
  return { tree_sha256: sha256(entries.join('')), files, bytes };
}

async function loadControlState(outputRoot, documentId) {
  const issuanceRoot = await requireRealDirectory(
    path.join(outputRoot, 'timeout-recovery-issuance'),
    'timeout recovery issuance directory',
  );
  const issuanceNames = (await readdir(issuanceRoot, { withFileTypes: true }))
    .map((entry) => ({ name: entry.name, file: entry.isFile() && !entry.isSymbolicLink() }));
  const issuanceBodies = issuanceNames.filter(({ name }) => name.endsWith('.issuance.json'));
  if (issuanceBodies.length !== 1
    || issuanceNames.length !== 2
    || !issuanceNames.every(({ file }) => file)
    || !issuanceNames.some(({ name }) => name === `${issuanceBodies[0].name}.sha256`)) {
    throw new Error('exactly one hash-bound timeout-recovery issuance claim is required');
  }
  const rootEntries = await outputRootEntries(outputRoot);
  const rootNames = rootEntries.map(({ name }) => name);
  for (const exact of [
    'timeout-recovery-grant.json',
    'timeout-recovery-grant.json.sha256',
    'timeout-recovery-consumption-claim.json',
    'timeout-recovery-consumption-claim.json.sha256',
  ]) {
    if (rootNames.filter((name) => name === exact).length !== 1) {
      throw new Error(`exactly one ${exact} is required`);
    }
  }
  if (rootNames.some((name) => (
    name.startsWith('timeout-recovery-grant')
      && !['timeout-recovery-grant.json', 'timeout-recovery-grant.json.sha256'].includes(name)
  )) || rootNames.some((name) => (
    name.startsWith('timeout-recovery-consumption-claim')
      && ![
        'timeout-recovery-consumption-claim.json',
        'timeout-recovery-consumption-claim.json.sha256',
      ].includes(name)
  ))) {
    throw new Error('a second timeout-recovery grant or consumption claim is forbidden');
  }

  const controlPaths = {
    receipt: 'seed-receipt.json',
    marker: 'seed-commit.json',
    journal: '.seed-journal.json',
    identity: 'run-identity.json',
    grant: 'timeout-recovery-grant.json',
    ledger: 'timeout-recovery-ledger-identity.json',
    claim: 'timeout-recovery-consumption-claim.json',
    issuance: `timeout-recovery-issuance/${issuanceBodies[0].name}`,
  };
  const [receipt, marker, journal, identityRaw, grant, ledger, claim, issuance] = await Promise.all([
    readHashBoundJson(outputRoot, path.join(outputRoot, controlPaths.receipt), 'seed receipt'),
    readHashBoundJson(outputRoot, path.join(outputRoot, controlPaths.marker), 'seed commit marker'),
    readHashBoundJson(outputRoot, path.join(outputRoot, controlPaths.journal), 'seed journal'),
    readStableFile(outputRoot, path.join(outputRoot, controlPaths.identity), 'run identity'),
    readHashBoundJson(outputRoot, path.join(outputRoot, controlPaths.grant), 'timeout recovery grant'),
    readHashBoundJson(outputRoot, path.join(outputRoot, controlPaths.ledger), 'timeout recovery ledger'),
    readHashBoundJson(outputRoot, path.join(outputRoot, controlPaths.claim), 'timeout recovery claim'),
    readHashBoundJson(outputRoot, path.join(outputRoot, controlPaths.issuance), 'timeout recovery issuance'),
  ]);
  const identity = { ...identityRaw, value: parseCanonicalJson(identityRaw, 'run identity') };
  const predecessorEvidenceRoot = await requireRealDirectory(
    path.join(outputRoot, 'seed-predecessor-evidence'),
    'seed predecessor evidence',
  );
  const predecessorTree = await inspectTreeStrict(predecessorEvidenceRoot);
  const archivedRunStatus = await readHashBoundJson(
    predecessorEvidenceRoot,
    path.join(predecessorEvidenceRoot, 'run-status.json'),
    'archived predecessor run status',
  );

  const receiptValue = requireObject(receipt.value, 'seed receipt');
  const identityValue = requireObject(identity.value, 'run identity');
  const markerValue = requireObject(marker.value, 'seed marker');
  const journalValue = requireObject(journal.value, 'seed journal');
  const grantValue = requireObject(grant.value, 'timeout recovery grant');
  const claimValue = requireObject(claim.value, 'timeout recovery claim');
  const issuanceValue = requireObject(issuance.value, 'timeout recovery issuance');
  const receiptDocument = (receiptValue.documents || []).filter(
    (entry) => entry?.document_id === documentId,
  );
  const grantDocument = (grantValue.documents || []).filter(
    (entry) => entry?.document_id === documentId,
  );
  const claimDocument = (claimValue.granted_documents || []).filter(
    (entry) => entry?.document_id === documentId,
  );
  if (receiptDocument.length !== 1 || grantDocument.length !== 1 || claimDocument.length !== 1) {
    throw new Error('target document must occur exactly once in receipt, grant, and claim');
  }
  const seedId = requireSha256(receiptValue.seed_id, 'seed id');
  if (receiptValue.citation_allowed !== false
    || identityValue.citation_allowed !== false
    || grantValue.citation_allowed !== false
    || claimValue.citation_allowed !== false
    || issuanceValue.citation_allowed !== false
    || markerValue.citation_allowed !== false
    || journalValue.citation_allowed !== false) {
    throw new Error('all seed and authority controls must remain citation-disallowed');
  }
  if (receiptValue.predecessor?.run_status_sha256 !== archivedRunStatus.sha256
    || receiptValue.timeout_recovery_grant?.raw_sha256 !== grant.sha256
    || receiptValue.timeout_recovery_grant?.grant_id !== grantValue.grant_id
    || receiptValue.timeout_recovery_consumption?.claim_sha256 !== claim.sha256
    || receiptValue.timeout_recovery_issuance?.raw_sha256 !== issuance.sha256
    || markerValue.seed_id !== seedId
    || markerValue.seed_receipt_sha256 !== receipt.sha256
    || journalValue.seed_id !== seedId
    || journalValue.seed_receipt_sha256 !== receipt.sha256
    || identityValue.seed_lineage?.seed_id !== seedId
    || identityValue.seed_lineage?.seed_receipt_sha256 !== receipt.sha256
    || identityValue.seed_lineage?.timeout_recovery_grant_id !== grantValue.grant_id
    || identityValue.seed_lineage?.timeout_recovery_claim_sha256 !== claim.sha256
    || identityValue.seed_lineage?.timeout_recovery_issuance_sha256 !== issuance.sha256
    || claimValue.grant_id !== grantValue.grant_id
    || claimValue.successor?.seed_id !== seedId) {
    throw new Error('seed, grant, claim, issuance, and predecessor controls are not one lineage');
  }

  const records = { receipt, marker, journal, identity, grant, ledger, claim, issuance };
  const recordSnapshot = Object.fromEntries(Object.entries(records).map(([name, record]) => [name, {
    ...publicRecord(controlPaths[name], record),
    ...(record.sidecar ? {
      sidecar: publicRecord(`${controlPaths[name]}.sha256`, record.sidecar),
    } : {}),
  }]));
  return {
    receipt: receiptValue,
    identity: identityValue,
    grant: grantValue,
    claim: claimValue,
    receiptDocument: receiptDocument[0],
    grantDocument: grantDocument[0],
    archivedRunStatus: archivedRunStatus.value,
    snapshot: {
      schema_version: 1,
      seed_id: seedId,
      records: recordSnapshot,
      predecessor_evidence_tree: {
        tree_sha256: predecessorTree.tree_sha256,
        files: predecessorTree.files,
        bytes: predecessorTree.bytes,
      },
      output_root_entries: rootEntries,
      issuance_claim_count: 1,
      grant_count: 1,
      consumption_claim_count: 1,
      citation_allowed: false,
    },
  };
}

export function parseSystemdShow(raw, unit, role) {
  const values = {};
  for (const line of String(raw).trim().split('\n')) {
    const delimiter = line.indexOf('=');
    if (delimiter < 1) throw new Error(`${unit}: systemd show output is invalid`);
    const key = line.slice(0, delimiter);
    if (Object.hasOwn(values, key)) throw new Error(`${unit}: duplicate systemd property ${key}`);
    values[key] = line.slice(delimiter + 1);
  }
  const expected = role.endsWith('_timer')
    ? ['ActiveState', 'InvocationID', 'LoadState', 'SubState']
    : ['ActiveState', 'ExecMainStatus', 'InvocationID', 'LoadState', 'MainPID', 'SubState'];
  if (!sameValue(Object.keys(values).sort(), expected.sort())) {
    throw new Error(`${unit}: systemd show property set is invalid`);
  }
  if (values.LoadState.length === 0
    || values.ActiveState.length === 0
    || values.SubState.length === 0
    || (role.endsWith('_timer')
      ? values.InvocationID !== ''
      : (!/^(?:0|[1-9]\d*)$/u.test(values.MainPID)
        || !/^(?:0|[1-9]\d*)$/u.test(values.ExecMainStatus)
        || (values.InvocationID !== '' && !invocationIdPattern.test(values.InvocationID))))) {
    throw new Error(`${unit}: systemd show property values are invalid`);
  }
  return values;
}

async function inspectUnit(unit, role) {
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
    '--no-pager',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 });
  return parseSystemdShow(stdout, unit, role);
}

async function inspectQuiescentUnits(options, dependencies) {
  const getUnitState = dependencies.inspectUnit || inspectUnit;
  const roles = [
    ['worker', options.workerUnit],
    ['monitor', options.monitorUnit],
    ['monitor_timer', options.monitorTimerUnit],
    ['retry_timer', options.retryTimerUnit],
    ['alert', options.alertUnit],
  ];
  const snapshot = {};
  for (const [role, unit] of roles) {
    const state = await getUnitState(unit, role);
    const expectedSubState = state.ActiveState === 'inactive' ? 'dead' : 'failed';
    if (state.LoadState !== 'loaded'
      || !['inactive', 'failed'].includes(state.ActiveState)
      || state.SubState !== expectedSubState
      || (role.endsWith('_timer')
        ? state.InvocationID !== ''
        : state.MainPID !== '0')) {
      throw new Error(`${unit} is not quiescent`);
    }
    snapshot[role] = { unit, ...state };
  }
  const worker = snapshot.worker;
  if (worker.InvocationID !== options.expectedWorkerInvocationId
    || worker.ExecMainStatus !== String(expectedWorkerExitStatus)) {
    throw new Error('worker invocation or exit status differs from the frozen incident');
  }
  return snapshot;
}

export async function acquireLifecycleLock(lockPath) {
  const resolved = await realpath(lockPath).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error('lifecycle lock file is missing');
    throw error;
  });
  if (resolved !== path.resolve(lockPath)) {
    throw new Error('lifecycle lock must not traverse a symbolic link');
  }
  const lockHandle = await open(resolved, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
  let lockIdentity;
  try {
    const [lockInfo, pathnameInfo] = await Promise.all([
      lockHandle.stat({ bigint: true }),
      lstat(resolved, { bigint: true }),
    ]);
    const currentUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : lockInfo.uid;
    const currentGid = typeof process.getgid === 'function' ? BigInt(process.getgid()) : lockInfo.gid;
    if (!lockInfo.isFile()
      || pathnameInfo.isSymbolicLink()
      || lockInfo.dev !== pathnameInfo.dev
      || lockInfo.ino !== pathnameInfo.ino
      || lockInfo.nlink !== 1n
      || lockInfo.uid !== currentUid
      || lockInfo.gid !== currentGid
      || (Number(lockInfo.mode) & 0o7777) !== 0o600) {
      throw new Error('lifecycle lock must be a current-owner mode-0600 single-link regular file');
    }
    lockIdentity = Object.freeze({
      path: resolved,
      device: String(lockInfo.dev),
      inode: String(lockInfo.ino),
      uid: String(lockInfo.uid),
      gid: String(lockInfo.gid),
      mode: '0600',
    });
    const child = spawn('/usr/bin/flock', [
      '--exclusive',
      '--nonblock',
      '3',
    ], { stdio: ['ignore', 'ignore', 'pipe', lockHandle.fd] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exit = new Promise((resolveExit) => {
      child.once('error', (error) => resolveExit({ error }));
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    let timeout;
    const result = await Promise.race([
      exit,
      new Promise((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout({ timeout: true }), 5_000);
      }),
    ]);
    clearTimeout(timeout);
    if (result.timeout) {
      child.kill('SIGTERM');
      await exit;
      throw new Error('timed out acquiring lifecycle flock');
    }
    if (result.error) throw result.error;
    if (result.code !== 0) {
      throw new Error(
        `lifecycle flock is held or unavailable (exit ${result.code}, signal ${result.signal || 'none'}): ${stderr.trim()}`,
      );
    }
    // flock(2) binds the lock to the inherited open-file description; this
    // parent handle keeps it held after the one-shot util-linux helper exits.
  } catch (error) {
    await lockHandle.close();
    throw error;
  }
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await lockHandle.close();
  };
  release.assertHeld = () => {
    if (released) throw new Error('lifecycle flock was lost before transaction completion');
  };
  release.verifyIdentity = async ({ inode } = {}) => {
    release.assertHeld();
    const [handleInfo, pathnameInfo] = await Promise.all([
      lockHandle.stat({ bigint: true }),
      lstat(resolved, { bigint: true }).catch((error) => {
        if (error?.code === 'ENOENT') throw new Error('lifecycle lock pathname disappeared while held');
        throw error;
      }),
    ]);
    if (!handleInfo.isFile()
      || pathnameInfo.isSymbolicLink()
      || handleInfo.dev !== pathnameInfo.dev
      || handleInfo.ino !== pathnameInfo.ino
      || String(handleInfo.dev) !== lockIdentity.device
      || String(handleInfo.ino) !== lockIdentity.inode
      || handleInfo.nlink !== 1n
      || String(handleInfo.uid) !== lockIdentity.uid
      || String(handleInfo.gid) !== lockIdentity.gid
      || (Number(handleInfo.mode) & 0o7777) !== 0o600
      || (inode !== undefined && String(handleInfo.ino) !== String(inode))) {
      throw new Error('lifecycle lock descriptor and pathname identity diverged while held');
    }
    return lockIdentity;
  };
  release.identity = lockIdentity;
  return release;
}

function countStatuses(runStatus) {
  const statuses = Object.values(requireObject(runStatus.documents, 'run-status documents'))
    .map((document) => document.status);
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

function reconstructSeedStatusAndProgress(control, documentId) {
  const receiptDocument = control.receiptDocument;
  const recovery = requireObject(receiptDocument.timeout_recovery, 'target timeout recovery receipt');
  const predecessorProgress = requireObject(
    control.archivedRunStatus.documents?.[documentId],
    'archived target progress',
  );
  if (receiptDocument.predecessor_status !== 'quarantined'
    || receiptDocument.inherited_attempts !== inheritedAttempt
    || predecessorProgress.status !== 'quarantined'
    || predecessorProgress.attempts !== inheritedAttempt
    || predecessorProgress.page_count !== receiptDocument.page_count
    || recovery.granted_attempt !== grantedAttempt
    || control.grantDocument.inherited_attempts !== inheritedAttempt
    || control.grantDocument.granted_attempt !== grantedAttempt
    || recovery.grant_id !== control.grant.grant_id) {
    throw new Error('target is not the exact inherited-attempt-5 recovery grant');
  }
  requireCanonicalTimestamp(predecessorProgress.quarantined_at, 'archived quarantined_at');
  requireCanonicalTimestamp(predecessorProgress.failed_at, 'archived failed_at');
  if (typeof predecessorProgress.error !== 'string' || predecessorProgress.error.length === 0) {
    throw new Error('archived target error is missing');
  }
  const seedStatus = {
    schema_version: 1,
    document_id: documentId,
    status: 'retry_wait',
    attempt: inheritedAttempt,
    max_attempts: grantedAttempt,
    next_retry_at: predecessorProgress.quarantined_at,
    page_count: receiptDocument.page_count,
    runtime_fingerprint_sha256: control.identity.runtime_fingerprint_sha256,
    citation_allowed: false,
    error: predecessorProgress.error,
    failed_at: predecessorProgress.failed_at,
  };
  seedStatus.seed_lineage = {
    schema_version: 1,
    seed_id: control.receipt.seed_id,
    predecessor_status_sha256: receiptDocument.predecessor_status_sha256,
    inherited_attempts: inheritedAttempt,
    timeout_recovery_grant_id: recovery.grant_id,
    timeout_recovery_grant_sha256: recovery.grant_raw_sha256,
    timeout_recovery_first_missing_page: recovery.first_missing_page,
    granted_attempt: grantedAttempt,
    citation_allowed: false,
  };
  const seedStatusRaw = prettyJson(seedStatus);
  const seedStatusSha256 = sha256(seedStatusRaw);
  if (seedStatusSha256 !== receiptDocument.successor_status_sha256) {
    throw new Error('reconstructed seed successor status differs from the receipt');
  }
  const seedProgress = structuredClone(predecessorProgress);
  seedProgress.predecessor_status = predecessorProgress.status;
  seedProgress.inherited_attempts = predecessorProgress.attempts;
  seedProgress.seed_id = control.receipt.seed_id;
  seedProgress.status = 'retry_wait';
  seedProgress.next_retry_at = predecessorProgress.quarantined_at;
  seedProgress.attempt_ceiling = grantedAttempt;
  seedProgress.timeout_recovery_grant_id = recovery.grant_id;
  seedProgress.timeout_recovery_grant_sha256 = recovery.grant_raw_sha256;
  seedProgress.timeout_recovery_first_missing_page = recovery.first_missing_page;
  delete seedProgress.quarantined_at;
  delete seedProgress.quarantine_reason;
  seedProgress.status_json_sha256 = seedStatusSha256;
  return { seedStatus, seedStatusRaw, seedStatusSha256, seedProgress };
}

function expectedInterruptedState(seed, control, options) {
  const progress = structuredClone(seed.seedProgress);
  progress.status = 'running';
  progress.attempts += 1;
  progress.started_at = options.expectedStartedAt;
  delete progress.failure_class;
  delete progress.error;
  delete progress.next_retry_at;
  progress.status = 'interrupted';
  progress.interrupted_at = options.expectedInterruptedAt;
  progress.signal = 'SIGTERM';
  progress.status_json_sha256 = options.expectedDocumentStatusSha256;
  const status = {
    schema_version: 1,
    document_id: options.documentId,
    status: 'interrupted',
    attempt: grantedAttempt,
    max_attempts: grantedAttempt,
    page_count: control.receiptDocument.page_count,
    runtime_fingerprint_sha256: control.identity.runtime_fingerprint_sha256,
    citation_allowed: false,
    interrupted_at: options.expectedInterruptedAt,
    seed_lineage: structuredClone(seed.seedStatus.seed_lineage),
  };
  return { progress, status };
}

async function readIncidentState(outputRoot, documentId) {
  const statusPath = path.join(outputRoot, 'status', `${documentId}.json`);
  const runStatusPath = path.join(outputRoot, 'run-status.json');
  const statePath = path.join(outputRoot, 'documents', documentId, 'state.json');
  const logPath = path.join(outputRoot, 'logs', `${documentId}.log`);
  const [statusRecord, runStatusRecord, stateRecord, logRecord, documentTree] = await Promise.all([
    readHashBoundJson(outputRoot, statusPath, 'current target status'),
    readHashBoundJson(outputRoot, runStatusPath, 'current run status'),
    readStableFile(outputRoot, statePath, 'current target state'),
    readStableFile(outputRoot, logPath, 'current target log'),
    inspectTreeStrict(path.join(outputRoot, 'documents', documentId)),
  ]);
  return { statusRecord, runStatusRecord, stateRecord, logRecord, documentTree };
}

function documentTreeSummary(tree) {
  return { tree_sha256: tree.tree_sha256, files: tree.files, bytes: tree.bytes };
}

function verifyIncidentState(incident, control, seed, options) {
  if (incident.runStatusRecord.sha256 !== options.expectedRunStatusSha256
    || incident.statusRecord.sha256 !== options.expectedDocumentStatusSha256
    || incident.logRecord.sha256 !== options.expectedLogSha256
    || incident.logRecord.bytes !== options.expectedLogBytes
    || incident.stateRecord.sha256 !== options.expectedStateSha256
    || incident.documentTree.tree_sha256 !== options.expectedDocumentTreeSha256) {
    throw new Error('current run/status/log/state/document-tree evidence differs from the frozen incident');
  }
  const receiptTree = requireObject(
    control.receiptDocument.successor_document_tree,
    'seed successor document tree',
  );
  if (!sameValue(documentTreeSummary(incident.documentTree), receiptTree)
    || incident.documentTree.tree_sha256 !== control.receiptDocument.successor_document_tree.tree_sha256
    || incident.stateRecord.sha256 !== control.receiptDocument.successor_state_sha256) {
    throw new Error('target page/state tree changed after the seed');
  }
  const expected = expectedInterruptedState(seed, control, options);
  const currentRunStatus = requireObject(incident.runStatusRecord.value, 'current run status');
  const currentProgress = requireObject(
    currentRunStatus.documents?.[options.documentId],
    'current target progress',
  );
  if (!sameValue(currentProgress, expected.progress)
    || !sameValue(incident.statusRecord.value, expected.status)) {
    throw new Error('current interruption has unexpected or extra fields');
  }
  if (currentRunStatus.citation_allowed !== false) throw new Error('current run status is not fail-closed');
  requireCanonicalTimestamp(currentRunStatus.updated_at, 'current run-status updated_at');
  if (Date.parse(options.repairAt) <= Date.parse(currentRunStatus.updated_at)) {
    throw new Error('repair_at must follow the current run-status updated_at');
  }
  return currentRunStatus;
}

function makeAfterState(currentRunStatus, seed, options) {
  const afterRunStatus = structuredClone(currentRunStatus);
  afterRunStatus.documents[options.documentId] = structuredClone(seed.seedProgress);
  afterRunStatus.updated_at = options.repairAt;
  afterRunStatus.counts = countStatuses(afterRunStatus);
  afterRunStatus.finished = afterRunStatus.counts.complete === afterRunStatus.counts.total;
  afterRunStatus.settled = afterRunStatus.counts.complete + afterRunStatus.counts.quarantined
    === afterRunStatus.counts.total;
  afterRunStatus.citation_allowed = false;
  const runStatusRaw = prettyJson(afterRunStatus);
  const runStatusSha256 = sha256(runStatusRaw);
  return {
    runStatus: afterRunStatus,
    runStatusRaw,
    runStatusSha256,
    runStatusSidecarRaw: sidecarRaw(runStatusSha256, 'run-status.json'),
    statusRaw: seed.seedStatusRaw,
    statusSha256: seed.seedStatusSha256,
    statusSidecarRaw: sidecarRaw(seed.seedStatusSha256, `${options.documentId}.json`),
  };
}

function repairIdentityBasis(options, outputInfo, control) {
  return {
    schema_version: 1,
    repair_type: repairType,
    output_root: options.outputRoot,
    output_device: String(outputInfo.dev),
    output_inode: String(outputInfo.ino),
    predecessor_root: options.predecessorRoot,
    lifecycle_lock: options.lifecycleLock,
    document_id: options.documentId,
    worker_unit: options.workerUnit,
    worker_invocation_id: options.expectedWorkerInvocationId,
    worker_exit_status: expectedWorkerExitStatus,
    started_at: options.expectedStartedAt,
    interrupted_at: options.expectedInterruptedAt,
    repair_at: options.repairAt,
    before: {
      run_status_sha256: options.expectedRunStatusSha256,
      document_status_sha256: options.expectedDocumentStatusSha256,
      log_sha256: options.expectedLogSha256,
      log_bytes: options.expectedLogBytes,
      state_sha256: options.expectedStateSha256,
      document_tree_sha256: options.expectedDocumentTreeSha256,
    },
    seed_id: control.receipt.seed_id,
    seed_receipt_sha256: control.snapshot.records.receipt.sha256,
    citation_allowed: false,
  };
}

function transactionBasis(options, outputInfo, control, nonTransactionOutput) {
  return {
    ...repairIdentityBasis(options, outputInfo, control),
    non_transaction_output: nonTransactionOutput,
  };
}

function repairIdFor(options, outputInfo, control) {
  return sha256(canonicalJson(repairIdentityBasis(options, outputInfo, control)));
}

function artifact(pathname, raw) {
  return { path: pathname, bytes: raw.byteLength, sha256: sha256(raw) };
}

function evidenceArtifactPaths(documentId) {
  return [
    'before/run-status.json',
    'before/run-status.json.sha256',
    `before/status/${documentId}.json`,
    `before/status/${documentId}.json.sha256`,
    `before/logs/${documentId}.log`,
    `before/documents/${documentId}/state.json`,
    'after/run-status.json',
    'after/run-status.json.sha256',
    `after/status/${documentId}.json`,
    `after/status/${documentId}.json.sha256`,
    'controls.json',
  ];
}

function buildEvidencePlan({
  options,
  outputInfo,
  control,
  units,
  incident,
  after,
  nonTransactionOutput,
}) {
  const basis = transactionBasis(options, outputInfo, control, nonTransactionOutput);
  const repairId = repairIdFor(options, outputInfo, control);
  const documentStatusRelative = `status/${options.documentId}.json`;
  const files = new Map([
    ['before/run-status.json', incident.runStatusRecord.raw],
    ['before/run-status.json.sha256', incident.runStatusRecord.sidecar.raw],
    [`before/status/${options.documentId}.json`, incident.statusRecord.raw],
    [`before/status/${options.documentId}.json.sha256`, incident.statusRecord.sidecar.raw],
    [`before/logs/${options.documentId}.log`, incident.logRecord.raw],
    [`before/documents/${options.documentId}/state.json`, incident.stateRecord.raw],
    ['after/run-status.json', after.runStatusRaw],
    ['after/run-status.json.sha256', after.runStatusSidecarRaw],
    [`after/status/${options.documentId}.json`, after.statusRaw],
    [`after/status/${options.documentId}.json.sha256`, after.statusSidecarRaw],
  ]);
  const controlsRaw = prettyJson(control.snapshot);
  files.set('controls.json', controlsRaw);
  const artifacts = [...files.entries()].map(([pathname, raw]) => artifact(pathname, raw));
  const transaction = [
    {
      output_path: documentStatusRelative,
      before: artifact(`before/${documentStatusRelative}`, incident.statusRecord.raw),
      after: artifact(`after/${documentStatusRelative}`, after.statusRaw),
    },
    {
      output_path: `${documentStatusRelative}.sha256`,
      before: artifact(`before/${documentStatusRelative}.sha256`, incident.statusRecord.sidecar.raw),
      after: artifact(`after/${documentStatusRelative}.sha256`, after.statusSidecarRaw),
    },
    {
      output_path: 'run-status.json',
      before: artifact('before/run-status.json', incident.runStatusRecord.raw),
      after: artifact('after/run-status.json', after.runStatusRaw),
    },
    {
      output_path: 'run-status.json.sha256',
      before: artifact('before/run-status.json.sha256', incident.runStatusRecord.sidecar.raw),
      after: artifact('after/run-status.json.sha256', after.runStatusSidecarRaw),
    },
  ];
  const receipt = {
    schema_version: 1,
    receipt_type: repairType,
    status: receiptStatus,
    repair_id: repairId,
    basis,
    units,
    controls: artifact('controls.json', controlsRaw),
    evidence_artifacts: artifacts,
    transaction,
    after_run_status_sha256: after.runStatusSha256,
    after_document_status_sha256: after.statusSha256,
    citation_allowed: false,
  };
  const claimRaw = prettyJson({
    schema_version: 1,
    claim_type: 'curriculum_remote_ocr_preinference_rearm_evidence_reservation',
    repair_id: repairId,
    evidence_path: path.join(options.evidenceRoot, repairId),
    citation_allowed: false,
  });
  receipt.publication_claim = artifact(`${repairId}.claim.json`, claimRaw);
  const finalReceiptRaw = prettyJson(receipt);
  files.set('repair-receipt.json', finalReceiptRaw);
  files.set('repair-receipt.json.sha256', sidecarRaw(sha256(finalReceiptRaw), 'repair-receipt.json'));
  return {
    repairId,
    evidencePath: path.join(options.evidenceRoot, repairId),
    basis,
    receipt,
    claimPath: path.join(options.evidenceRoot, `${repairId}.claim.json`),
    claimRaw,
    files,
    transaction,
  };
}

async function syncDirectory(pathname) {
  const handle = await open(pathname, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncEvidenceDirectories(root, relativeFiles) {
  const directories = new Set([root]);
  for (const relative of relativeFiles) {
    let current = path.dirname(relative);
    while (current !== '.') {
      directories.add(path.join(root, current));
      current = path.dirname(current);
    }
  }
  const ordered = [...directories].sort((left, right) => (
    right.split(path.sep).length - left.split(path.sep).length
  ));
  for (const directory of ordered) await syncDirectory(directory);
}

async function writeExclusive(pathname, raw) {
  await mkdir(path.dirname(pathname), { recursive: true, mode: 0o700 });
  const handle = await open(
    pathname,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(raw);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(pathname, 0o600);
}

async function publishEvidence(plan, options) {
  const claimExists = await lstat(plan.claimPath).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (claimExists) {
    const existingClaim = await readStableFile(options.evidenceRoot, plan.claimPath, 'repair evidence reservation');
    if (!existingClaim.raw.equals(plan.claimRaw)) {
      throw new Error('evidence collision: repair reservation differs');
    }
  } else {
    await writeExclusive(plan.claimPath, plan.claimRaw);
    await syncDirectory(options.evidenceRoot);
  }
  const exists = await lstat(plan.evidencePath).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (exists) throw new Error('evidence collision: repair evidence path already exists');
  const stage = path.join(options.evidenceRoot, `.${plan.repairId}.prepare-${process.pid}-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    for (const [relativePath, raw] of plan.files) {
      await writeExclusive(path.join(stage, relativePath), raw);
    }
    await syncEvidenceDirectories(stage, plan.files.keys());
    await rename(stage, plan.evidencePath);
    await syncDirectory(options.evidenceRoot);
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function requireExactReceipt(receipt, options, outputInfo, control, nonTransactionOutput) {
  requireObject(receipt, 'repair receipt');
  const expectedKeys = [
    'after_document_status_sha256',
    'after_run_status_sha256',
    'basis',
    'citation_allowed',
    'controls',
    'evidence_artifacts',
    'publication_claim',
    'receipt_type',
    'repair_id',
    'schema_version',
    'status',
    'transaction',
    'units',
  ].sort();
  if (!sameValue(Object.keys(receipt).sort(), expectedKeys)) {
    throw new Error('repair receipt field set is invalid');
  }
  if (receipt.schema_version !== 1
    || receipt.receipt_type !== repairType
    || receipt.status !== receiptStatus
    || receipt.citation_allowed !== false) {
    throw new Error('repair receipt contract is invalid');
  }
  const expectedBasis = transactionBasis(options, outputInfo, control, nonTransactionOutput);
  const expectedId = repairIdFor(options, outputInfo, control);
  if (receipt.repair_id !== expectedId || !sameValue(receipt.basis, expectedBasis)) {
    throw new Error('repair receipt is not bound to this exact incident');
  }
  return expectedId;
}

async function loadEvidence(options, outputInfo, control, nonTransactionOutput) {
  const expectedId = repairIdFor(options, outputInfo, control);
  const evidencePath = path.join(options.evidenceRoot, expectedId);
  const claimPath = path.join(options.evidenceRoot, `${expectedId}.claim.json`);
  const claimExists = await lstat(claimPath).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  const exists = await lstat(evidencePath).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (!exists) {
    if (claimExists) {
      const claim = await readStableFile(options.evidenceRoot, claimPath, 'repair evidence reservation');
      const expectedClaim = prettyJson({
        schema_version: 1,
        claim_type: 'curriculum_remote_ocr_preinference_rearm_evidence_reservation',
        repair_id: expectedId,
        evidence_path: evidencePath,
        citation_allowed: false,
      });
      if (!claim.raw.equals(expectedClaim)) throw new Error('evidence reservation collision');
    }
    return null;
  }
  if (!claimExists) throw new Error('evidence collision: reservation is missing');
  const root = await requireRealDirectory(evidencePath, 'repair evidence directory');
  const mode = (await stat(root)).mode & 0o7777;
  if (mode !== 0o700) throw new Error('repair evidence directory must be mode 0700');
  const receiptRecord = await readHashBoundJson(root, path.join(root, 'repair-receipt.json'), 'repair receipt');
  const receipt = receiptRecord.value;
  requireExactReceipt(receipt, options, outputInfo, control, nonTransactionOutput);
  const claim = await readStableFile(options.evidenceRoot, claimPath, 'repair evidence reservation');
  if (!claim.raw.equals(prettyJson({
    schema_version: 1,
    claim_type: 'curriculum_remote_ocr_preinference_rearm_evidence_reservation',
    repair_id: expectedId,
    evidence_path: evidencePath,
    citation_allowed: false,
  })) || !sameValue(receipt.publication_claim, artifact(`${expectedId}.claim.json`, claim.raw))) {
    throw new Error('repair evidence reservation differs from its receipt');
  }
  const artifactRecords = Array.isArray(receipt.evidence_artifacts)
    ? receipt.evidence_artifacts
    : [];
  const requiredArtifactPaths = evidenceArtifactPaths(options.documentId);
  if (artifactRecords.length !== requiredArtifactPaths.length
    || !sameValue(
      artifactRecords.map(({ path: pathname }) => pathname),
      requiredArtifactPaths,
    )) {
    throw new Error('repair evidence artifact inventory is invalid');
  }
  const expectedArtifactPaths = new Set([
    ...requiredArtifactPaths,
    'repair-receipt.json',
    'repair-receipt.json.sha256',
  ]);
  const tree = await inspectTreeStrict(root);
  const actualPaths = tree.entries
    .filter((entry) => entry.startsWith('F\0'))
    .map((entry) => entry.split('\0')[1]);
  if (actualPaths.length !== expectedArtifactPaths.size
    || actualPaths.some((pathname) => !expectedArtifactPaths.has(pathname))) {
    throw new Error('repair evidence inventory contains a missing or extra file');
  }
  const files = new Map();
  for (const record of artifactRecords) {
    requireSha256(record.sha256, `evidence ${record.path} SHA-256`);
    const value = await readStableFile(root, path.join(root, record.path), `evidence ${record.path}`);
    if (value.sha256 !== record.sha256 || value.bytes !== record.bytes) {
      throw new Error(`evidence ${record.path} differs from its receipt`);
    }
    files.set(record.path, value.raw);
  }
  const controlsRaw = files.get('controls.json');
  if (!controlsRaw || !sameValue(JSON.parse(controlsRaw), control.snapshot)) {
    throw new Error('current immutable controls differ from the repair evidence');
  }
  const transaction = receipt.transaction || [];
  const expectedOutputPaths = mutableRelativePaths.map((value) => value.replace('{document}', options.documentId));
  if (transaction.length !== expectedOutputPaths.length
    || !sameValue(transaction.map(({ output_path: pathname }) => pathname), expectedOutputPaths)) {
    throw new Error('repair transaction path inventory is invalid');
  }
  return {
    repairId: expectedId,
    evidencePath,
    receipt,
    receiptRecord,
    claim,
    files,
    transaction,
  };
}

function incidentFromEvidence(evidence, options, documentTree) {
  const makeRecord = (relative, label, { json = false, sidecar = false } = {}) => {
    const raw = evidence.files.get(relative);
    if (!raw) throw new Error(`${label} is missing from repair evidence`);
    const record = { raw, sha256: sha256(raw), bytes: raw.byteLength };
    if (json) record.value = parseCanonicalJson(record, label);
    if (sidecar) {
      const sidecarPath = `${relative}.sha256`;
      const sidecarBytes = evidence.files.get(sidecarPath);
      if (!sidecarBytes
        || !sidecarBytes.equals(sidecarRaw(record.sha256, path.basename(relative)))) {
        throw new Error(`${label} evidence sidecar is invalid`);
      }
      record.sidecar = {
        raw: sidecarBytes,
        sha256: sha256(sidecarBytes),
        bytes: sidecarBytes.byteLength,
      };
    }
    return record;
  };
  return {
    runStatusRecord: makeRecord('before/run-status.json', 'evidence run status', {
      json: true,
      sidecar: true,
    }),
    statusRecord: makeRecord(
      `before/status/${options.documentId}.json`,
      'evidence document status',
      { json: true, sidecar: true },
    ),
    logRecord: makeRecord(
      `before/logs/${options.documentId}.log`,
      'evidence document log',
    ),
    stateRecord: makeRecord(
      `before/documents/${options.documentId}/state.json`,
      'evidence document state',
    ),
    documentTree,
  };
}

function requireEvidenceMatchesPlan(evidence, plan) {
  if (evidence.repairId !== plan.repairId
    || evidence.evidencePath !== plan.evidencePath
    || !evidence.receiptRecord.raw.equals(plan.files.get('repair-receipt.json'))
    || !evidence.receiptRecord.sidecar.raw.equals(plan.files.get('repair-receipt.json.sha256'))
    || !evidence.claim.raw.equals(plan.claimRaw)) {
    throw new Error('existing repair evidence was not reconstructed from trusted controls');
  }
  const expectedArtifactPaths = evidenceArtifactPaths(plan.basis.document_id);
  for (const relative of expectedArtifactPaths) {
    if (!evidence.files.get(relative)?.equals(plan.files.get(relative))) {
      throw new Error(`existing repair evidence ${relative} differs from the reconstructed plan`);
    }
  }
}

function transactionTemporaryPath(item, repairId) {
  return path.join(
    path.dirname(item.pathname),
    `.${path.basename(item.pathname)}.${repairId}.rearm-tmp`,
  );
}

async function inspectTransactionTemporaries(outputRoot, evidence, states) {
  const expected = new Set(states.map((item) => transactionTemporaryPath(item, evidence.repairId)));
  const directories = [...new Set(states.map((item) => path.dirname(item.pathname)))];
  for (const directory of directories) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.name.endsWith('.rearm-tmp')) continue;
      const pathname = path.join(directory, entry.name);
      if (!expected.has(pathname) || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('unexpected rearm transaction temporary file');
      }
    }
  }
  for (const item of states) {
    const temporary = transactionTemporaryPath(item, evidence.repairId);
    const exists = await lstat(temporary).then(() => true, (error) => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    });
    if (!exists) continue;
    const record = await readStableFile(path.dirname(temporary), temporary, 'transaction temporary file');
    if (!record.raw.equals(item.afterRaw)) {
      throw new Error('transaction temporary file differs from exact after bytes');
    }
    item.temporary = temporary;
  }
}

async function classifyMutableFiles(outputRoot, evidence) {
  const states = [];
  for (const item of evidence.transaction) {
    const pathname = path.join(outputRoot, item.output_path);
    const current = await readStableFile(outputRoot, pathname, `mutable ${item.output_path}`);
    const beforeRaw = evidence.files.get(item.before.path);
    const afterRaw = evidence.files.get(item.after.path);
    if (!beforeRaw || !afterRaw
      || sha256(beforeRaw) !== item.before.sha256
      || beforeRaw.byteLength !== item.before.bytes
      || sha256(afterRaw) !== item.after.sha256
      || afterRaw.byteLength !== item.after.bytes) {
      throw new Error(`repair evidence for ${item.output_path} is invalid`);
    }
    const state = current.raw.equals(beforeRaw) ? 'before' : current.raw.equals(afterRaw) ? 'after' : 'unknown';
    if (state === 'unknown') throw new Error(`${item.output_path} is neither exact before nor exact after state`);
    states.push({ ...item, pathname, state, beforeRaw, afterRaw });
  }
  return states;
}

async function atomicReplaceFromEvidence(item, repairId) {
  const parent = path.dirname(item.pathname);
  const temporary = transactionTemporaryPath(item, repairId);
  const existing = await lstat(temporary).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (existing) {
    const temp = await readStableFile(parent, temporary, 'transaction temporary file');
    if (!temp.raw.equals(item.afterRaw)) {
      await rm(temporary);
    }
  }
  const stillExists = await lstat(temporary).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (!stillExists) await writeExclusive(temporary, item.afterRaw);
  await rename(temporary, item.pathname);
  await syncDirectory(parent);
}

async function defaultValidateSeed({ predecessorRoot, outputRoot, nowMilliseconds }) {
  const predecessor = await inspectPredecessorB1(predecessorRoot);
  const successor = await inspectSuccessorB2(outputRoot, predecessor, nowMilliseconds);
  return { predecessor, successor };
}

async function verifyUnchangedIncidentArtifacts(outputRoot, options, control) {
  const [stateRecord, logRecord, tree] = await Promise.all([
    readStableFile(
      outputRoot,
      path.join(outputRoot, 'documents', options.documentId, 'state.json'),
      'current target state',
    ),
    readStableFile(
      outputRoot,
      path.join(outputRoot, 'logs', `${options.documentId}.log`),
      'current target log',
    ),
    inspectTreeStrict(path.join(outputRoot, 'documents', options.documentId)),
  ]);
  if (stateRecord.sha256 !== options.expectedStateSha256
    || stateRecord.sha256 !== control.receiptDocument.successor_state_sha256
    || logRecord.sha256 !== options.expectedLogSha256
    || logRecord.bytes !== options.expectedLogBytes
    || tree.tree_sha256 !== options.expectedDocumentTreeSha256
    || !sameValue(documentTreeSummary(tree), control.receiptDocument.successor_document_tree)) {
    throw new Error('page/state/log evidence changed after transaction preparation');
  }
  return { stateRecord, logRecord, tree };
}

async function verifyNonTransactionOutput(outputRoot, options, repairId, expected) {
  const current = await inspectNonTransactionOutput(outputRoot, options.documentId, repairId);
  if (!sameValue(current, expected)) {
    throw new Error('non-transaction output changed after transaction preparation');
  }
  return current;
}

export async function repairPreInferenceInterruption(rawOptions, dependencies = {}) {
  const options = normalizeRepairOptions(rawOptions);
  requireExactIncident(options, dependencies.incidentProfile || exactA2Incident);
  const [outputRoot, predecessorRoot, evidenceRoot] = await Promise.all([
    requireRealDirectory(options.outputRoot, 'output root'),
    requireRealDirectory(options.predecessorRoot, 'predecessor root'),
    requireRealDirectory(options.evidenceRoot, 'evidence root'),
  ]);
  if (inside(outputRoot, evidenceRoot) || inside(evidenceRoot, outputRoot)) {
    throw new Error('evidence root and output root must be disjoint');
  }
  options.outputRoot = outputRoot;
  options.predecessorRoot = predecessorRoot;
  options.evidenceRoot = evidenceRoot;
  const releaseLock = await (dependencies.acquireLifecycleLock || acquireLifecycleLock)(options.lifecycleLock);
  const assertLockHeld = () => releaseLock.assertHeld?.();
  try {
    assertLockHeld();
    const outputInfo = await stat(outputRoot, { bigint: true });
    if (String(outputInfo.ino) !== options.expectedOutputInode) {
      throw new Error('output root inode differs from the frozen incident');
    }
    const units = await inspectQuiescentUnits(options, dependencies);
    const control = await loadControlState(outputRoot, options.documentId);
    if (control.claim.successor?.output_root !== outputRoot
      || control.claim.successor?.output_device !== String(outputInfo.dev)
      || control.claim.successor?.output_inode !== String(outputInfo.ino)) {
      throw new Error('consumption claim is not bound to this output inode');
    }
    const repairId = repairIdFor(options, outputInfo, control);
    const nonTransactionOutput = await inspectNonTransactionOutput(
      outputRoot,
      options.documentId,
      repairId,
    );
    const existingEvidence = await loadEvidence(
      options,
      outputInfo,
      control,
      nonTransactionOutput,
    );
    const validateSeed = dependencies.validateSeed || defaultValidateSeed;

    if (existingEvidence) {
      assertLockHeld();
      const unchanged = await verifyUnchangedIncidentArtifacts(outputRoot, options, control);
      const seed = reconstructSeedStatusAndProgress(control, options.documentId);
      const incident = incidentFromEvidence(existingEvidence, options, unchanged.tree);
      const beforeRunStatus = verifyIncidentState(incident, control, seed, options);
      const after = makeAfterState(beforeRunStatus, seed, options);
      const reconstructed = buildEvidencePlan({
        options,
        outputInfo,
        control,
        units,
        incident,
        after,
        nonTransactionOutput,
      });
      requireEvidenceMatchesPlan(existingEvidence, reconstructed);
      await verifyNonTransactionOutput(
        outputRoot,
        options,
        reconstructed.repairId,
        nonTransactionOutput,
      );
      let states = await classifyMutableFiles(outputRoot, reconstructed);
      await inspectTransactionTemporaries(outputRoot, reconstructed, states);
      const beforeCount = states.filter(({ state }) => state === 'before').length;
      if (!options.apply) {
        return {
          valid: true,
          mode: 'dry_run',
          state: beforeCount === 0 ? 'already_applied' : 'resume_ready',
          repair_id: reconstructed.repairId,
          evidence_path: reconstructed.evidencePath,
          replacements_remaining: beforeCount,
          citation_allowed: false,
        };
      }
      await verifyNonTransactionOutput(
        outputRoot,
        options,
        reconstructed.repairId,
        nonTransactionOutput,
      );
      let replacements = 0;
      for (let index = 0; index < states.length; index += 1) {
        const item = states[index];
        if (item.state === 'before') {
          assertLockHeld();
          await atomicReplaceFromEvidence(item, reconstructed.repairId);
          replacements += 1;
          await dependencies.afterReplacement?.(index + 1, item.output_path);
        } else if (item.temporary) {
          await rm(item.temporary);
          await syncDirectory(path.dirname(item.temporary));
        }
      }
      states = await classifyMutableFiles(outputRoot, reconstructed);
      await inspectTransactionTemporaries(outputRoot, reconstructed, states);
      if (states.some(({ temporary }) => temporary)) throw new Error('repair transaction left a temporary file');
      if (states.some(({ state }) => state !== 'after')) throw new Error('repair transaction did not converge');
      assertLockHeld();
      await validateSeed({ predecessorRoot, outputRoot, nowMilliseconds: Date.parse(options.repairAt) });
      return {
        valid: true,
        mode: 'apply',
        state: replacements === 0 ? 'already_applied' : 'applied',
        repair_id: reconstructed.repairId,
        evidence_path: reconstructed.evidencePath,
        replacements,
        attempt: inheritedAttempt,
        status: 'retry_wait',
        citation_allowed: false,
      };
    }

    const seedValidation = await validateSeed({
      predecessorRoot,
      outputRoot,
      nowMilliseconds: Date.parse(options.repairAt),
    });
    if (seedValidation?.successor?.run_status_sha256
      && seedValidation.successor.run_status_sha256 !== options.expectedRunStatusSha256) {
      throw new Error('full seed validation observed a different run status');
    }
    const seed = reconstructSeedStatusAndProgress(control, options.documentId);
    const incident = await readIncidentState(outputRoot, options.documentId);
    const currentRunStatus = verifyIncidentState(incident, control, seed, options);
    const after = makeAfterState(currentRunStatus, seed, options);
    const plan = buildEvidencePlan({
      options,
      outputInfo,
      control,
      units,
      incident,
      after,
      nonTransactionOutput,
    });
    if (!options.apply) {
      return {
        valid: true,
        mode: 'dry_run',
        state: 'ready',
        repair_id: plan.repairId,
        evidence_path: plan.evidencePath,
        before_run_status_sha256: incident.runStatusRecord.sha256,
        after_run_status_sha256: after.runStatusSha256,
        before_document_status_sha256: incident.statusRecord.sha256,
        after_document_status_sha256: after.statusSha256,
        replacements: plan.transaction.length,
        attempt: inheritedAttempt,
        status: 'retry_wait',
        citation_allowed: false,
      };
    }

    assertLockHeld();
    await verifyNonTransactionOutput(outputRoot, options, plan.repairId, nonTransactionOutput);
    await publishEvidence(plan, options);
    const published = await loadEvidence(
      options,
      outputInfo,
      control,
      nonTransactionOutput,
    );
    if (!published) throw new Error('published repair evidence cannot be read back');
    requireEvidenceMatchesPlan(published, plan);
    await verifyUnchangedIncidentArtifacts(outputRoot, options, control);
    await verifyNonTransactionOutput(outputRoot, options, plan.repairId, nonTransactionOutput);
    let replacements = 0;
    const states = await classifyMutableFiles(outputRoot, published);
    await inspectTransactionTemporaries(outputRoot, published, states);
    for (let index = 0; index < states.length; index += 1) {
      const item = states[index];
      if (item.state === 'before') {
        assertLockHeld();
        await atomicReplaceFromEvidence(item, plan.repairId);
        replacements += 1;
        await dependencies.afterReplacement?.(index + 1, item.output_path);
      } else if (item.temporary) {
        await rm(item.temporary);
        await syncDirectory(path.dirname(item.temporary));
      }
    }
    const finalStates = await classifyMutableFiles(outputRoot, published);
    await inspectTransactionTemporaries(outputRoot, published, finalStates);
    if (finalStates.some(({ temporary }) => temporary)) throw new Error('repair transaction left a temporary file');
    if (finalStates.some(({ state }) => state !== 'after')) throw new Error('repair transaction did not converge');
    assertLockHeld();
    await validateSeed({ predecessorRoot, outputRoot, nowMilliseconds: Date.parse(options.repairAt) });
    return {
      valid: true,
      mode: 'apply',
      state: 'applied',
      repair_id: plan.repairId,
      evidence_path: plan.evidencePath,
      replacements,
      attempt: inheritedAttempt,
      status: 'retry_wait',
      citation_allowed: false,
    };
  } finally {
    await releaseLock();
  }
}

function usage() {
  return [
    'Usage: node scripts/repair-remote-ocr-preinference-interruption.mjs \\',
    '  --output-root DIR --predecessor-root DIR --evidence-root DIR --lifecycle-lock FILE \\',
    '  --document-id ID --worker-unit UNIT --monitor-unit UNIT \\',
    '  --monitor-timer-unit UNIT --retry-timer-unit UNIT --alert-unit UNIT \\',
    '  --expected-output-inode N --expected-worker-invocation-id HEX32 \\',
    '  --expected-started-at ISO --expected-interrupted-at ISO --repair-at ISO \\',
    '  --expected-run-status-sha256 HEX64 --expected-document-status-sha256 HEX64 \\',
    '  --expected-log-sha256 HEX64 --expected-log-bytes N --expected-state-sha256 HEX64 \\',
    '  --expected-document-tree-sha256 HEX64 [--apply]',
    '',
    'Dry-run is the default. --apply publishes owner-only evidence before four atomic replacements.',
  ].join('\n');
}

async function main() {
  try {
    const raw = parseArgs(process.argv.slice(2));
    const result = await repairPreInferenceInterruption(validateRepairOptions(raw));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`pre-inference repair failed closed: ${error.message}\n`);
    process.exitCode = 2;
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
