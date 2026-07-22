import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from './remote-ocr-local-snapshot.mjs';
import {
  validateA2ContinuationRuntimeManifest,
  validateArchivedA2ContinuationRuntimeManifest,
} from './remote-ocr-continuation-runtime-manifest.mjs';
import { inspectTreeStrict } from '../monitor-remote-ocr-single-shard.mjs';

const sha256Pattern = /^[a-f0-9]{64}$/u;
const invocationIdPattern = /^[a-f0-9]{32}$/u;
const documentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const canonicalTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const systemdGenerationProperties = Object.freeze([
  'StateChangeTimestampMonotonic',
  'ActiveEnterTimestampMonotonic',
  'ActiveExitTimestampMonotonic',
  'InactiveEnterTimestampMonotonic',
]);

export const OPERATOR_CONTINUATION_RECEIPT_TYPE =
  'curriculum_remote_ocr_operator_interruption_continuation_receipt';
export const OPERATOR_CONTINUATION_CLAIM_TYPE =
  'curriculum_remote_ocr_operator_interruption_continuation_claim';
export const OPERATOR_CONTINUATION_MODE = 'same_granted_attempt_forward_continuation';

// These values were recovered by an independently verified, read-only
// inspection of the frozen A2 incident. They are not CLI inputs: a caller may
// not turn its own assertions into authority.
export const EXACT_A2_FORWARD_CONTINUATION_INCIDENT = Object.freeze({
  schemaVersion: 2,
  runRoot: '/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess',
  outputRoot: '/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/output/production-p1-mb16-shard-a-r2',
  outputDevice: '66306',
  outputInode: '45748776',
  lifecycleLock: '/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/.a2-lifecycle.lock',
  lifecycleLockInode: '41590544',
  evidenceBaseRoot: '/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/a2-deploy-evidence/20260719T003812Z',
  evidenceBaseDevice: '66306',
  evidenceBaseInode: '41854492',
  incidentEvidenceRoot: '/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/a2-deploy-evidence/20260719T003812Z/incident-operator-freeze-monitor-jq-20260722T041335Z',
  incidentEvidenceDevice: '66306',
  incidentEvidenceInode: '42336297',
  incidentEvidenceMode: '0700',
  incidentEvidenceUid: '1000',
  incidentEvidenceGid: '1000',
  incidentEvidenceTreeSha256: 'ecad58b65032556b52e274055bde314aa479f58ab19d54bd9c861b1681e5d2c6',
  documentId: 'legacy-compendium-english',
  attempt: 6,
  inheritedAttempts: 5,
  workerInvocationId: 'cea41604c79f46cfa9483b46d64ad0fd',
  documentInterruptedAt: '2026-07-22T04:13:35.387Z',
  incidentInterruptedAt: '2026-07-22T04:13:35.390Z',
  runStatusSha256: '1daf1ab535d8378c25625591494acd1e7922266873e48821e46be9ff04ddbe1b',
  documentStatusSha256: '28921af43e57ffd2e1443a2b03a2261075557e3dfd9a732cedc5ff4b4848c63a',
  logSha256: '470d7b4ef6be1ff3363e44c6e320d0b6d062196069f1205a679eac9b466662d2',
  logBytes: 11585,
  stateSha256: 'd16de657043c260136552cd8cf881791f42308169e2ecf55fe0cab5f155aa09d',
  documentTreeSha256: '0ecee6008bc62def2fbaaa701ea9161b72a06b739dddc7e6fe72ff8963d23265',
  documentTreeFiles: 579,
  documentTreeBytes: 7100211,
  baseRunnerSha256: '0fbf3d284f324f5faa710ca09342cdef88d24e6349b6e5d590ccca215065354d',
  seedId: 'd3b9638c866b2e5d447a62ef0bd0fd7877950dcfa9fb971b50c0927fc96e4d00',
  seedReceiptSha256: '73cab0d67ced5c1a04f268c6b3af150a4ee72df2978b48fe5ceb350d0c31213c',
  seedReceiptBytes: 943095,
  seedCommitSha256: '2c16fa3e8d908802cee37a78afdd7bdde19e492bc9aa22c851f0d7ee679780fb',
  seedCommitBytes: 4003,
  seedJournalSha256: '8a4bd7ff424d3d6891237e243d7270582e0a4f159be97e37c8f409fb9b720e4e',
  seedJournalBytes: 3899,
  runIdentitySha256: '14a9b3fe135e96ff180ea7b5d80f1bef30c4c81882f7df0d371b123f1edcad60',
  runIdentityBytes: 6968,
  ledgerIdentitySha256: 'df77305d01249d59323b76bafeb46cf1a09da30cd90a88602b238c5fa8d62c0c',
  ledgerIdentityBytes: 302,
  timeoutGrantSha256: 'd52aafa542d7c9321158c74716ebc08d4e364356b216804856edac1e91cd5338',
  timeoutGrantBytes: 4968,
  timeoutConsumptionClaimSha256: 'b30c8999016d555208deff3ac8c7826f9a4bb6106b4a1d8c8c14905455af24e6',
  timeoutConsumptionClaimBytes: 2554,
  timeoutIssuanceRelativePath: 'timeout-recovery-issuance/791ad258ee227f1fbc5646a91812b2900ec2d0eef04da885ffc1b3f6b5a960a8.issuance.json',
  timeoutIssuanceSha256: '984f511d726873496f6efac6b16ad7691e91a12b11ee9e8fc67667bf854bd9e7',
  timeoutIssuanceBytes: 2356,
  timeoutIssuanceSidecarSha256: '3ee8d0009b407c435e9bb8e90f7cb7a6fade2c1fa22772b750697e3962713655',
  timeoutIssuanceSidecarBytes: 145,
  ledgerSidecarSha256: '72d1609fc05f4b3361673eddedfa5b87505b756a9fe257e1debe04ec2e3f22cc',
  ledgerSidecarBytes: 104,
  predecessorEvidenceTreeSha256: 'fe195eff333a1e44ad9011065664cd7c09a82ad8d499b516574b690b2401ed9c',
  predecessorEvidenceTreeFiles: 40,
  predecessorEvidenceTreeBytes: 3283852,
  rearmRepairId: 'a08b53ee30c0320bc8c2783df1087392a42e33a283a776630206a857412b7dc6',
  rearmEvidenceRoot: '/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/a2-deploy-evidence/20260719T003812Z/a08b53ee30c0320bc8c2783df1087392a42e33a283a776630206a857412b7dc6',
  rearmReceiptSha256: '05c7d6fae0551ba22527c3353e112fc1ec9bce083f2a627537c089ce76754706',
  rearmReceiptBytes: 7691,
  rearmReservationClaimSha256: '91c7433f7169b369c3f980140a0ca8d32db7c83d88d34a15894af229b1ff610b',
  rearmEvidenceTreeSha256: 'a758aa84cff692c952ce2d0eae8db5c136d1c35c440710981319f534508e86d6',
  rearmAfterStatusSha256: '5a797bc61c1b62130824971276072b680b61dc6369b42a4ee0c569711358c722',
  rearmAfterStatusSidecarSha256: '666016acce233ab6dcf154d3b92a78aafae86ffc2b8e5a129a30d230a2c99eee',
  rearmAfterRunStatusSha256: 'bea326f6c1f079af4781400aed66fff1ac30c44d308a37d78c7617c78f3883e4',
  rearmAfterRunStatusSidecarSha256: '67410d38167581c871d7c65024b3858f57e16da94f86a588f922ddfae05bbdac',
  workerUnit: 'curriculum-ocr-reprocess-a-r2.service',
  monitorUnit: 'curriculum-ocr-reprocess-a-r2-monitor.service',
  monitorTimerUnit: 'curriculum-ocr-reprocess-a-r2-monitor.timer',
  alertUnit: 'curriculum-ocr-monitor-alert@curriculum-ocr-reprocess-a-r2-monitor.service.service',
  llamaUnit: 'curriculum-ocr-llama.service',
});

const requiredShaKeys = Object.freeze([
  'incidentEvidenceTreeSha256',
  'runStatusSha256',
  'documentStatusSha256',
  'logSha256',
  'stateSha256',
  'documentTreeSha256',
  'baseRunnerSha256',
  'seedId',
  'seedReceiptSha256',
  'seedCommitSha256',
  'seedJournalSha256',
  'runIdentitySha256',
  'ledgerIdentitySha256',
  'timeoutGrantSha256',
  'timeoutConsumptionClaimSha256',
  'timeoutIssuanceSha256',
  'timeoutIssuanceSidecarSha256',
  'ledgerSidecarSha256',
  'predecessorEvidenceTreeSha256',
  'rearmRepairId',
  'rearmReceiptSha256',
  'rearmReservationClaimSha256',
  'rearmEvidenceTreeSha256',
  'rearmAfterStatusSha256',
  'rearmAfterStatusSidecarSha256',
  'rearmAfterRunStatusSha256',
  'rearmAfterRunStatusSidecarSha256',
]);

const requiredPositiveIntegerKeys = Object.freeze([
  'attempt',
  'inheritedAttempts',
  'logBytes',
  'documentTreeFiles',
  'documentTreeBytes',
  'seedReceiptBytes',
  'seedCommitBytes',
  'seedJournalBytes',
  'runIdentityBytes',
  'ledgerIdentityBytes',
  'timeoutGrantBytes',
  'timeoutConsumptionClaimBytes',
  'timeoutIssuanceBytes',
  'timeoutIssuanceSidecarBytes',
  'ledgerSidecarBytes',
  'predecessorEvidenceTreeFiles',
  'predecessorEvidenceTreeBytes',
  'rearmReceiptBytes',
]);

const requiredDecimalKeys = Object.freeze([
  'outputDevice',
  'outputInode',
  'lifecycleLockInode',
  'evidenceBaseDevice',
  'evidenceBaseInode',
  'incidentEvidenceDevice',
  'incidentEvidenceInode',
  'incidentEvidenceUid',
  'incidentEvidenceGid',
]);

const requiredAbsolutePathKeys = Object.freeze([
  'runRoot',
  'outputRoot',
  'lifecycleLock',
  'evidenceBaseRoot',
  'incidentEvidenceRoot',
  'rearmEvidenceRoot',
]);

const requiredExactProfileKeys = Object.freeze([
  ...requiredShaKeys,
  ...requiredPositiveIntegerKeys,
  ...requiredDecimalKeys,
  ...requiredAbsolutePathKeys,
  'schemaVersion',
  'documentId',
  'workerInvocationId',
  'documentInterruptedAt',
  'incidentInterruptedAt',
  'incidentEvidenceMode',
  'timeoutIssuanceRelativePath',
  'workerUnit',
  'monitorUnit',
  'monitorTimerUnit',
  'alertUnit',
  'llamaUnit',
].sort());

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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

export function prettyJson(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function requireCanonicalTimestamp(value, label) {
  if (typeof value !== 'string'
    || !canonicalTimestampPattern.test(value)
    || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC millisecond timestamp`);
  }
}

export function validateA2ForwardContinuationProfile(raw) {
  const profile = requireObject(raw, 'A2 forward-continuation incident profile');
  if (canonicalJson(Object.keys(profile).sort()) !== canonicalJson(requiredExactProfileKeys)) {
    throw new Error('frozen A2 forward-continuation profile keys differ from the exact schema');
  }
  const missing = [];
  for (const key of requiredShaKeys) {
    if (!sha256Pattern.test(String(profile[key] || ''))) missing.push(key);
  }
  for (const key of requiredPositiveIntegerKeys) {
    if (!Number.isSafeInteger(profile[key]) || profile[key] < 1) missing.push(key);
  }
  for (const key of requiredDecimalKeys) {
    if (!/^(?:0|[1-9]\d*)$/u.test(String(profile[key] || ''))) missing.push(key);
  }
  for (const key of requiredAbsolutePathKeys) {
    if (typeof profile[key] !== 'string' || !path.isAbsolute(profile[key])) missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(`frozen A2 forward-continuation profile is incomplete or invalid: ${[...new Set(missing)].sort().join(', ')}`);
  }
  if (profile.schemaVersion !== 2
    || profile.documentId !== 'legacy-compendium-english'
    || !documentIdPattern.test(profile.documentId)
    || profile.attempt !== 6
    || profile.inheritedAttempts !== 5
    || !invocationIdPattern.test(String(profile.workerInvocationId || ''))
    || profile.incidentEvidenceMode !== '0700') {
    throw new Error('frozen A2 forward-continuation identity is invalid');
  }
  requireCanonicalTimestamp(profile.documentInterruptedAt, 'frozen document interrupted_at');
  requireCanonicalTimestamp(profile.incidentInterruptedAt, 'frozen operator incident interrupted_at');
  if (Date.parse(profile.documentInterruptedAt) > Date.parse(profile.incidentInterruptedAt)) {
    throw new Error('frozen document interruption is after the operator incident');
  }
  if (profile.rearmEvidenceRoot !== path.join(profile.evidenceBaseRoot, profile.rearmRepairId)) {
    throw new Error('frozen A2 rearm evidence path is not bound to its repair_id');
  }
  if (!profile.outputRoot.startsWith(`${profile.runRoot}${path.sep}`)
    || !profile.evidenceBaseRoot.startsWith(`${profile.runRoot}${path.sep}`)
    || !profile.incidentEvidenceRoot.startsWith(`${profile.evidenceBaseRoot}${path.sep}`)
    || profile.lifecycleLock !== path.join(profile.runRoot, '.a2-lifecycle.lock')) {
    throw new Error('frozen A2 paths do not share the exact authorized run root');
  }
  for (const key of ['workerUnit', 'monitorUnit', 'monitorTimerUnit', 'alertUnit', 'llamaUnit']) {
    if (typeof profile[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@:-]*\.(?:service|timer)$/u.test(profile[key])) {
      throw new Error(`frozen A2 ${key} is invalid`);
    }
  }
  return profile;
}

export function a2ForwardContinuationProfileFingerprint(profile) {
  validateA2ForwardContinuationProfile(profile);
  return sha256(canonicalJson(profile));
}

function inside(root, pathname) {
  const relative = path.relative(root, pathname);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..'
    && !path.isAbsolute(relative));
}

export async function requireStableDirectory(pathname, label, expected = {}) {
  const resolved = await realpath(pathname).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing`);
    throw error;
  });
  if (resolved !== path.resolve(pathname)) throw new Error(`${label} must not traverse a symbolic link`);
  const info = await lstat(resolved, { bigint: true });
  const currentUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : info.uid;
  const currentGid = typeof process.getgid === 'function' ? BigInt(process.getgid()) : info.gid;
  if (!info.isDirectory() || info.isSymbolicLink()
    || (expected.currentOwner !== false && (info.uid !== currentUid || info.gid !== currentGid))) {
    throw new Error(`${label} must be a current-owner real directory`);
  }
  if (expected.mode !== undefined && (Number(info.mode) & 0o7777) !== expected.mode) {
    throw new Error(`${label} mode differs from the frozen identity`);
  }
  if (expected.dev !== undefined && String(info.dev) !== String(expected.dev)) {
    throw new Error(`${label} device differs from the frozen identity`);
  }
  if (expected.ino !== undefined && String(info.ino) !== String(expected.ino)) {
    throw new Error(`${label} inode differs from the frozen identity`);
  }
  if (expected.uid !== undefined && String(info.uid) !== String(expected.uid)) {
    throw new Error(`${label} owner UID differs from the frozen identity`);
  }
  if (expected.gid !== undefined && String(info.gid) !== String(expected.gid)) {
    throw new Error(`${label} owner GID differs from the frozen identity`);
  }
  return { pathname: resolved, info };
}

export async function readStableFile(root, pathname, label, { requireMode600 = true } = {}) {
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
    const currentUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : before.uid;
    const currentGid = typeof process.getgid === 'function' ? BigInt(process.getgid()) : before.gid;
    if (!before.isFile()
      || before.nlink !== 1n
      || before.uid !== currentUid
      || before.gid !== currentGid
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
    return {
      raw,
      sha256: sha256(raw),
      bytes: raw.byteLength,
      dev: String(after.dev),
      ino: String(after.ino),
      mode: Number(after.mode) & 0o7777,
      uid: String(after.uid),
      gid: String(after.gid),
    };
  } finally {
    await handle.close();
  }
}

export async function readStableFileWithSidecar(root, pathname, label) {
  const record = await readStableFile(root, pathname, label);
  const sidecar = await readStableFile(root, `${pathname}.sha256`, `${label} SHA-256 sidecar`);
  const expected = `${record.sha256}  ${path.basename(pathname)}\n`;
  if (sidecar.raw.toString('utf8') !== expected) throw new Error(`${label} SHA-256 sidecar is invalid`);
  return { ...record, sidecar };
}

export function operatorContinuationEvidencePaths(evidenceBaseRoot, documentId, attempt = 6) {
  if (!documentIdPattern.test(String(documentId || ''))) throw new Error('document ID is unsafe');
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('attempt must be a positive integer');
  const parent = path.join(path.resolve(evidenceBaseRoot), 'operator-forward-continuations');
  const root = path.join(parent, documentId, `attempt-${String(attempt).padStart(4, '0')}`);
  return {
    parent,
    documentParent: path.dirname(root),
    root,
    receipt: path.join(root, 'receipt.json'),
    receiptSidecar: path.join(root, 'receipt.json.sha256'),
    claim: path.join(root, 'claim.json'),
    claimSidecar: path.join(root, 'claim.json.sha256'),
    interruptedRunStatus: path.join(root, 'interrupted-run-status.json'),
    interruptedStatus: path.join(root, 'interrupted-status.json'),
    interruptedState: path.join(root, 'interrupted-state.json'),
    preContinuationLog: path.join(root, 'pre-continuation.log'),
    documentInventory: path.join(root, 'document-inventory.json'),
    runtimeManifest: path.join(root, 'runtime-manifest.json'),
    states: path.join(root, 'states'),
  };
}

function parseJson(record, label) {
  let value;
  try {
    value = JSON.parse(record.raw.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  return requireObject(value, label);
}

function exactNames(actual, expected, label) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (canonicalJson(left) !== canonicalJson(right)) {
    throw new Error(`${label} contains missing or unexpected entries`);
  }
}

function exactObject(value, keys, label) {
  const object = requireObject(value, label);
  exactNames(Object.keys(object), keys, label);
  return object;
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function requireDecimalString(value, label) {
  if (!/^(?:0|[1-9]\d*)$/u.test(String(value || ''))) {
    throw new Error(`${label} must be a canonical decimal string`);
  }
}

function requireSafePathname(value, label) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.startsWith('/')
    || value.includes('\\')
    || /[\0\r\n]/u.test(value)
    || value.split('/').some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new Error(`${label} is not a safe canonical relative path`);
  }
}

function validateQuiescentUnitFence(value, profile) {
  const fence = exactObject(
    value,
    ['worker', 'monitor', 'monitor_timer', 'alert'],
    'operator continuation quiescent unit fence',
  );
  const unitKeys = {
    worker: 'workerUnit',
    monitor: 'monitorUnit',
    monitor_timer: 'monitorTimerUnit',
    alert: 'alertUnit',
  };
  for (const role of ['worker', 'monitor', 'monitor_timer', 'alert']) {
    const timer = role.endsWith('_timer');
    const state = exactObject(
      fence[role],
      [
        'unit',
        'load_state',
        'active_state',
        'sub_state',
        'invocation_id',
        ...(timer ? [] : ['main_pid', 'exec_main_status']),
        'generation',
      ],
      `operator continuation ${role} unit fence`,
    );
    const expectedSubState = state.active_state === 'inactive' ? 'dead' : 'failed';
    if (state.unit !== profile[unitKeys[role]]
      || state.load_state !== 'loaded'
      || !['inactive', 'failed'].includes(state.active_state)
      || state.sub_state !== expectedSubState
      || (timer
        ? state.invocation_id !== ''
        : (state.main_pid !== '0'
          || !/^(?:0|[1-9]\d*)$/u.test(String(state.exec_main_status || ''))
          || (state.invocation_id !== '' && !invocationIdPattern.test(state.invocation_id))))) {
      throw new Error(`operator continuation ${role} unit fence is not exact quiescent state`);
    }
    if (role === 'worker'
      && (state.invocation_id !== profile.workerInvocationId || state.exec_main_status !== '75')) {
      throw new Error('operator continuation worker unit fence is not the frozen interruption');
    }
    const generationProperties = [
      ...systemdGenerationProperties,
      ...(timer ? ['LastTriggerUSecMonotonic'] : []),
    ];
    const generation = exactObject(
      state.generation,
      generationProperties,
      `operator continuation ${role} unit generation`,
    );
    for (const property of generationProperties) {
      requireDecimalString(generation[property], `operator continuation ${role} ${property}`);
    }
  }
  return fence;
}

function validateArchiveDescriptor(record, raw, expectedPath, label) {
  const descriptor = exactObject(raw, ['path', 'sha256', 'bytes'], `${label} descriptor`);
  if (descriptor.path !== expectedPath
    || descriptor.sha256 !== record.sha256
    || descriptor.bytes !== record.bytes) {
    throw new Error(`${label} differs from the continuation receipt`);
  }
}

function validateDocumentInventory(inventory, inventoryRecord, stateRecord, logRecord, profile) {
  exactObject(inventory, [
    'schema_version',
    'output_root',
    'document_id',
    'attempt',
    'tree_sha256',
    'files',
    'bytes',
    'entries',
    'directories',
    'state',
    'log',
    'citation_allowed',
  ], 'operator continuation document inventory');
  if (inventory.schema_version !== 1
    || inventory.output_root !== profile.outputRoot
    || inventory.document_id !== profile.documentId
    || inventory.attempt !== profile.attempt
    || inventory.tree_sha256 !== profile.documentTreeSha256
    || inventory.files !== profile.documentTreeFiles
    || inventory.bytes !== profile.documentTreeBytes
    || inventory.citation_allowed !== false
    || !Array.isArray(inventory.entries)
    || !Array.isArray(inventory.directories)) {
    throw new Error('operator continuation document inventory is not the frozen A2 inventory');
  }
  const paths = new Set();
  const directoryPaths = ['.'];
  let files = 0;
  let bytes = 0;
  for (const entry of inventory.entries) {
    if (typeof entry !== 'string' || !entry.endsWith('\n')) {
      throw new Error('operator continuation inventory entry is invalid');
    }
    const parts = entry.slice(0, -1).split('\0');
    if (!['D', 'F'].includes(parts[0])
      || (parts[0] === 'D' && parts.length !== 2)
      || (parts[0] === 'F' && parts.length !== 4)) {
      throw new Error('operator continuation inventory entry format is invalid');
    }
    requireSafePathname(parts[1], 'operator continuation inventory path');
    if (paths.has(parts[1])) throw new Error('operator continuation inventory contains a duplicate path');
    paths.add(parts[1]);
    if (parts[0] === 'D') {
      directoryPaths.push(parts[1]);
      continue;
    }
    requireDecimalString(parts[2], 'operator continuation inventory file bytes');
    if (!sha256Pattern.test(parts[3])) throw new Error('operator continuation inventory file SHA-256 is invalid');
    const size = Number(parts[2]);
    if (!Number.isSafeInteger(size)) throw new Error('operator continuation inventory file is too large');
    files += 1;
    bytes += size;
    if (!Number.isSafeInteger(bytes)) throw new Error('operator continuation inventory byte total is unsafe');
  }
  if (sha256(inventory.entries.join('')) !== inventory.tree_sha256
    || files !== inventory.files
    || bytes !== inventory.bytes) {
    throw new Error('operator continuation inventory tree summary is invalid');
  }
  if (inventory.directories.length !== directoryPaths.length) {
    throw new Error('operator continuation directory identity inventory is incomplete');
  }
  const seenDirectoryPaths = new Set();
  for (let index = 0; index < inventory.directories.length; index += 1) {
    const identity = exactObject(inventory.directories[index], [
      'path', 'device', 'inode', 'mode', 'uid', 'gid',
    ], 'operator continuation directory identity');
    if (identity.path !== directoryPaths[index]
      || seenDirectoryPaths.has(identity.path)
      || !/^0[0-7]{3}$/u.test(String(identity.mode || ''))) {
      throw new Error('operator continuation directory identity order or mode is invalid');
    }
    seenDirectoryPaths.add(identity.path);
    for (const key of ['device', 'inode', 'uid', 'gid']) {
      requireDecimalString(identity[key], `operator continuation directory ${key}`);
    }
  }
  const state = exactObject(inventory.state, ['sha256', 'bytes', 'device', 'inode'], 'operator continuation state identity');
  const log = exactObject(inventory.log, ['sha256', 'bytes', 'device', 'inode'], 'operator continuation log identity');
  for (const [identity, record, expectedSha256, expectedBytes, label] of [
    [state, stateRecord, profile.stateSha256, stateRecord.bytes, 'state'],
    [log, logRecord, profile.logSha256, profile.logBytes, 'log'],
  ]) {
    requireDecimalString(identity.device, `operator continuation ${label} device`);
    requireDecimalString(identity.inode, `operator continuation ${label} inode`);
    if (identity.sha256 !== expectedSha256
      || identity.bytes !== expectedBytes
      || record.sha256 !== expectedSha256
      || record.bytes !== expectedBytes) {
      throw new Error(`operator continuation ${label} identity differs from the frozen incident`);
    }
  }
  if (inventoryRecord.sha256 !== sha256(inventoryRecord.raw)) {
    throw new Error('operator continuation document inventory readback is invalid');
  }
}

function originalControlRecords(profile, records) {
  const statusSidecar = Buffer.from(
    `${records.status.sha256}  ${profile.documentId}.json\n`,
  );
  const runStatusSidecar = Buffer.from(
    `${records.runStatus.sha256}  run-status.json\n`,
  );
  return new Map([
    [`status/${profile.documentId}.json`, {
      sha256: records.status.sha256,
      bytes: records.status.bytes,
    }],
    [`status/${profile.documentId}.json.sha256`, {
      sha256: sha256(statusSidecar),
      bytes: statusSidecar.byteLength,
    }],
    ['run-status.json', {
      sha256: records.runStatus.sha256,
      bytes: records.runStatus.bytes,
    }],
    ['run-status.json.sha256', {
      sha256: sha256(runStatusSidecar),
      bytes: runStatusSidecar.byteLength,
    }],
  ]);
}

function validateTerminalPlanState(value, beforeRecords) {
  const expectedExitCodes = new Map([
    ['complete', 0],
    ['failed', 2],
    ['interrupted', 75],
    ['quarantined', 12],
  ]);
  if (!expectedExitCodes.has(value.outcome)
    || value.exit_code !== expectedExitCodes.get(value.outcome)
    || !Array.isArray(value.transaction)
    || value.transaction.length !== beforeRecords.size) {
    throw new Error('operator continuation terminal plan outcome is invalid');
  }
  requireCanonicalTimestamp(value.terminal_at, 'operator continuation terminal plan timestamp');
  const transaction = new Map();
  for (const rawRecord of value.transaction) {
    const record = exactObject(rawRecord, [
      'output_path',
      'before_sha256',
      'before_bytes',
      'after_sha256',
      'after_bytes',
      'after_base64',
    ], 'operator continuation terminal transaction record');
    const before = beforeRecords.get(record.output_path);
    if (!before || transaction.has(record.output_path)
      || record.before_sha256 !== before.sha256
      || record.before_bytes !== before.bytes
      || !sha256Pattern.test(String(record.after_sha256 || ''))
      || !Number.isSafeInteger(record.after_bytes)
      || record.after_bytes < 1
      || typeof record.after_base64 !== 'string') {
      throw new Error('operator continuation terminal transaction identity is invalid');
    }
    const after = Buffer.from(record.after_base64, 'base64');
    if (after.byteLength !== record.after_bytes
      || sha256(after) !== record.after_sha256
      || after.toString('base64') !== record.after_base64) {
      throw new Error('operator continuation terminal transaction payload is invalid');
    }
    transaction.set(record.output_path, { ...record, after });
  }
  exactNames(transaction.keys(), beforeRecords.keys(), 'operator continuation terminal transaction');
  const actualStatusPath = [...transaction.keys()].find((candidate) => candidate.startsWith('status/') && !candidate.endsWith('.sha256'));
  const status = transaction.get(actualStatusPath);
  const statusSidecar = transaction.get(`${actualStatusPath}.sha256`);
  const runStatus = transaction.get('run-status.json');
  const runStatusSidecar = transaction.get('run-status.json.sha256');
  if (!status || !statusSidecar || !runStatus || !runStatusSidecar
    || !statusSidecar.after.equals(Buffer.from(`${status.after_sha256}  ${path.basename(actualStatusPath)}\n`))
    || !runStatusSidecar.after.equals(Buffer.from(`${runStatus.after_sha256}  run-status.json\n`))) {
    throw new Error('operator continuation terminal sidecars do not bind their control payloads');
  }
  return transaction;
}

function validateCheckpointTree(raw, label) {
  const tree = exactObject(raw, ['tree_sha256', 'files', 'bytes', 'entries'], `${label} tree`);
  if (!sha256Pattern.test(String(tree.tree_sha256 || ''))
    || !Number.isSafeInteger(tree.files)
    || tree.files < 1
    || !Number.isSafeInteger(tree.bytes)
    || tree.bytes < 1
    || !Array.isArray(tree.entries)
    || tree.entries.some((entry) => typeof entry !== 'string' || !entry.endsWith('\n'))
    || sha256(tree.entries.join('')) !== tree.tree_sha256) {
    throw new Error(`${label} tree identity is invalid`);
  }
  let files = 0;
  let bytes = 0;
  const paths = new Set();
  for (const entry of tree.entries) {
    const parts = entry.slice(0, -1).split('\0');
    if (!['D', 'F'].includes(parts[0])
      || (parts[0] === 'D' && parts.length !== 2)
      || (parts[0] === 'F' && parts.length !== 4)) {
      throw new Error(`${label} tree entry is invalid`);
    }
    requireSafePathname(parts[1], `${label} tree path`);
    if (paths.has(parts[1])) throw new Error(`${label} tree contains a duplicate path`);
    paths.add(parts[1]);
    if (parts[0] === 'F') {
      requireDecimalString(parts[2], `${label} tree file bytes`);
      if (!sha256Pattern.test(parts[3])) throw new Error(`${label} tree file SHA-256 is invalid`);
      files += 1;
      bytes += Number(parts[2]);
    }
  }
  if (!Number.isSafeInteger(bytes) || files !== tree.files || bytes !== tree.bytes) {
    throw new Error(`${label} tree totals are invalid`);
  }
  return tree;
}

function validateCheckpointFileIdentity(raw, label, { includeBase64 = false } = {}) {
  const identity = exactObject(
    raw,
    ['sha256', 'bytes', 'device', 'inode', ...(includeBase64 ? ['base64'] : [])],
    label,
  );
  if (!sha256Pattern.test(String(identity.sha256 || ''))
    || !Number.isSafeInteger(identity.bytes)
    || identity.bytes < 1) {
    throw new Error(`${label} is invalid`);
  }
  for (const key of ['device', 'inode']) requireDecimalString(identity[key], `${label} ${key}`);
  if (includeBase64) {
    if (typeof identity.base64 !== 'string') throw new Error(`${label} payload is invalid`);
    const rawPayload = Buffer.from(identity.base64, 'base64');
    if (rawPayload.byteLength !== identity.bytes
      || rawPayload.toString('base64') !== identity.base64
      || sha256(rawPayload) !== identity.sha256) {
      throw new Error(`${label} payload differs from its identity`);
    }
  }
  return identity;
}

function validateCheckpointDirectories(raw, tree, label) {
  if (!Array.isArray(raw)) throw new Error(`${label} directories are invalid`);
  const expected = ['.', ...tree.entries
    .filter((entry) => entry.startsWith('D\0'))
    .map((entry) => entry.slice(0, -1).split('\0')[1])];
  if (raw.length !== expected.length) throw new Error(`${label} directory inventory is incomplete`);
  const seen = new Set();
  for (let index = 0; index < raw.length; index += 1) {
    const identity = exactObject(
      raw[index],
      ['path', 'device', 'inode', 'mode', 'uid', 'gid'],
      `${label} directory identity`,
    );
    if (identity.path !== expected[index]
      || seen.has(identity.path)
      || !/^0[0-7]{3}$/u.test(String(identity.mode || ''))) {
      throw new Error(`${label} directory identity is invalid`);
    }
    for (const key of ['device', 'inode', 'uid', 'gid']) {
      requireDecimalString(identity[key], `${label} directory ${key}`);
    }
    seen.add(identity.path);
  }
  return raw;
}

function checkpointStateRaw(checkpoint, label) {
  const state = validateCheckpointFileIdentity(checkpoint.state, `${label} state`, {
    includeBase64: true,
  });
  return Buffer.from(state.base64, 'base64');
}

function validateCheckpointStateForwardOnly(previousRaw, currentRaw, documentId, label) {
  const previous = parseJson({ raw: previousRaw }, `${label} previous state`);
  const current = parseJson({ raw: currentRaw }, `${label} current state`);
  if (previous.document_id !== documentId || current.document_id !== documentId) {
    throw new Error(`${label} document identity changed`);
  }
  const previousCompleted = Array.isArray(previous.completed_pages) ? previous.completed_pages : [];
  const currentCompleted = new Set(Array.isArray(current.completed_pages) ? current.completed_pages : []);
  for (const page of previousCompleted) {
    if (!currentCompleted.has(page) || !sameJson(previous.pages?.[String(page)], current.pages?.[String(page)])) {
      throw new Error(`${label} lost immutable completed page ${page}`);
    }
  }
}

async function verifyFrozenDirectoryIdentities(documentRoot, identities) {
  for (const identity of identities) {
    const pathname = identity.path === '.' ? documentRoot : path.join(documentRoot, identity.path);
    const resolved = await realpath(pathname).catch((error) => {
      if (error?.code === 'ENOENT') throw new Error(`pre-existing directory was removed: ${identity.path}`);
      throw error;
    });
    const info = await lstat(pathname, { bigint: true });
    if (resolved !== path.resolve(pathname)
      || !info.isDirectory()
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

export async function validateOperatorContinuationEvidence(
  evidenceRoot,
  rawProfile = EXACT_A2_FORWARD_CONTINUATION_INCIDENT,
) {
  const profile = validateA2ForwardContinuationProfile(rawProfile);
  const expectedPaths = operatorContinuationEvidencePaths(
    profile.evidenceBaseRoot,
    profile.documentId,
    profile.attempt,
  );
  const resolved = await requireStableDirectory(evidenceRoot, 'operator continuation evidence', { mode: 0o700 });
  if (resolved.pathname !== expectedPaths.root) {
    throw new Error('operator continuation evidence path is not the frozen A2 path');
  }
  const entries = await readdir(resolved.pathname, { withFileTypes: true });
  exactNames(entries.map(({ name }) => name), [
    'claim.json',
    'claim.json.sha256',
    'document-inventory.json',
    'document-inventory.json.sha256',
    'interrupted-run-status.json',
    'interrupted-run-status.json.sha256',
    'interrupted-state.json',
    'interrupted-state.json.sha256',
    'interrupted-status.json',
    'interrupted-status.json.sha256',
    'pre-continuation.log',
    'pre-continuation.log.sha256',
    'receipt.json',
    'receipt.json.sha256',
    'runtime-manifest.json',
    'runtime-manifest.json.sha256',
    'states',
  ], 'operator continuation evidence');
  const [
    receiptRecord,
    claimRecord,
    inventoryRecord,
    interruptedRunStatusRecord,
    interruptedStatusRecord,
    interruptedStateRecord,
    preContinuationLogRecord,
    runtimeManifestRecord,
  ] = await Promise.all([
    readStableFileWithSidecar(resolved.pathname, expectedPaths.receipt, 'operator continuation receipt'),
    readStableFileWithSidecar(resolved.pathname, expectedPaths.claim, 'operator continuation claim'),
    readStableFileWithSidecar(resolved.pathname, expectedPaths.documentInventory, 'operator continuation document inventory'),
    readStableFileWithSidecar(resolved.pathname, expectedPaths.interruptedRunStatus, 'archived interrupted run status'),
    readStableFileWithSidecar(resolved.pathname, expectedPaths.interruptedStatus, 'archived interrupted document status'),
    readStableFileWithSidecar(resolved.pathname, expectedPaths.interruptedState, 'archived interrupted document state'),
    readStableFileWithSidecar(resolved.pathname, expectedPaths.preContinuationLog, 'archived pre-continuation log'),
    readStableFileWithSidecar(resolved.pathname, expectedPaths.runtimeManifest, 'archived continuation runtime manifest'),
  ]);
  const receipt = parseJson(receiptRecord, 'operator continuation receipt');
  const claim = parseJson(claimRecord, 'operator continuation claim');
  const inventory = parseJson(inventoryRecord, 'operator continuation document inventory');
  const interruptedRunStatus = parseJson(interruptedRunStatusRecord, 'archived interrupted run status');
  const interruptedStatus = parseJson(interruptedStatusRecord, 'archived interrupted document status');
  const interruptedState = parseJson(interruptedStateRecord, 'archived interrupted document state');
  exactObject(receipt, [
    'schema_version',
    'receipt_type',
    'mode',
    'output',
    'document',
    'authorization',
    'timeout_recovery',
    'interrupted_snapshot',
    'profile_sha256',
    'citation_allowed',
    'continuation_id',
  ], 'operator continuation receipt');
  const receiptOutput = exactObject(receipt.output, ['root', 'device', 'inode'], 'operator continuation receipt output');
  const receiptDocument = exactObject(receipt.document, [
    'document_id',
    'attempt',
    'max_attempts',
    'original_started_at',
    'interrupted_at',
    'signal',
    'document_tree_sha256',
    'document_tree_files',
    'document_tree_bytes',
    'state_sha256',
    'log_sha256',
    'log_bytes',
  ], 'operator continuation receipt document');
  const authorization = exactObject(receipt.authorization, [
    'classification',
    'worker_invocation_id',
    'interrupted_at',
    'authorized_at',
    'incident_evidence_root',
    'incident_evidence_tree_sha256',
    'base_runner_path',
    'base_runner_sha256',
    'runtime_manifest',
  ], 'operator continuation authorization');
  const runtimeManifestDescriptor = exactObject(authorization.runtime_manifest, [
    'path',
    'sha256',
    'bytes',
    'runtime_tree_sha256',
    'files',
  ], 'operator continuation runtime manifest descriptor');
  const timeoutRecovery = exactObject(receipt.timeout_recovery, [
    'seed_id',
    'grant_id',
    'grant_sha256',
    'consumption_claim_sha256',
    'inherited_attempts',
    'granted_attempt',
    'automatic_attempt_7',
  ], 'operator continuation timeout recovery');
  const snapshot = exactObject(receipt.interrupted_snapshot, [
    'archives',
    'document_inventory',
    'run_status_sha256',
    'status_sha256',
    'document_progress',
    'document_status',
  ], 'operator continuation interrupted snapshot');
  const archives = exactObject(snapshot.archives, [
    'interrupted_run_status',
    'interrupted_status',
    'interrupted_state',
    'pre_continuation_log',
  ], 'operator continuation interrupted archives');
  const trustedRuntimeManifest = await validateA2ContinuationRuntimeManifest();
  validateArchivedA2ContinuationRuntimeManifest(runtimeManifestRecord.raw, trustedRuntimeManifest);
  if (receipt.schema_version !== 3
    || receipt.receipt_type !== OPERATOR_CONTINUATION_RECEIPT_TYPE
    || receipt.mode !== OPERATOR_CONTINUATION_MODE
    || receipt.profile_sha256 !== a2ForwardContinuationProfileFingerprint(profile)
    || receiptDocument.document_id !== profile.documentId
    || receiptDocument.attempt !== profile.attempt
    || receiptDocument.max_attempts !== profile.attempt
    || receiptDocument.interrupted_at !== profile.documentInterruptedAt
    || receiptDocument.signal !== 'SIGTERM'
    || receiptDocument.document_tree_sha256 !== profile.documentTreeSha256
    || receiptDocument.document_tree_files !== profile.documentTreeFiles
    || receiptDocument.document_tree_bytes !== profile.documentTreeBytes
    || receiptDocument.state_sha256 !== profile.stateSha256
    || receiptDocument.log_sha256 !== profile.logSha256
    || receiptDocument.log_bytes !== profile.logBytes
    || authorization.classification !== 'operator_controlled_sigterm_after_observer_error'
    || authorization.worker_invocation_id !== profile.workerInvocationId
    || authorization.interrupted_at !== profile.incidentInterruptedAt
    || authorization.incident_evidence_root !== profile.incidentEvidenceRoot
    || authorization.incident_evidence_tree_sha256 !== profile.incidentEvidenceTreeSha256
    || typeof authorization.base_runner_path !== 'string'
    || !path.isAbsolute(authorization.base_runner_path)
    || authorization.base_runner_sha256 !== profile.baseRunnerSha256
    || runtimeManifestDescriptor.path !== 'runtime-manifest.json'
    || runtimeManifestDescriptor.sha256 !== runtimeManifestRecord.sha256
    || runtimeManifestDescriptor.bytes !== runtimeManifestRecord.bytes
    || runtimeManifestDescriptor.runtime_tree_sha256 !== trustedRuntimeManifest.runtime_tree_sha256
    || runtimeManifestDescriptor.files !== trustedRuntimeManifest.files
    || timeoutRecovery.seed_id !== profile.seedId
    || !sha256Pattern.test(String(timeoutRecovery.grant_id || ''))
    || timeoutRecovery.grant_sha256 !== profile.timeoutGrantSha256
    || timeoutRecovery.consumption_claim_sha256 !== profile.timeoutConsumptionClaimSha256
    || timeoutRecovery.inherited_attempts !== profile.inheritedAttempts
    || timeoutRecovery.granted_attempt !== profile.attempt
    || timeoutRecovery.automatic_attempt_7 !== false
    || receiptOutput.root !== profile.outputRoot
    || receiptOutput.device !== profile.outputDevice
    || receiptOutput.inode !== profile.outputInode
    || snapshot.run_status_sha256 !== profile.runStatusSha256
    || snapshot.status_sha256 !== profile.documentStatusSha256
    || receipt.citation_allowed !== false) {
    throw new Error('operator continuation receipt is not bound to the frozen A2 incident');
  }
  requireCanonicalTimestamp(receiptDocument.original_started_at, 'original attempt-6 start');
  requireCanonicalTimestamp(authorization.authorized_at, 'operator continuation authorization time');
  if (Date.parse(receiptDocument.original_started_at) > Date.parse(profile.documentInterruptedAt)
    || Date.parse(profile.documentInterruptedAt) > Date.parse(profile.incidentInterruptedAt)
    || Date.parse(profile.incidentInterruptedAt) > Date.parse(authorization.authorized_at)) {
    throw new Error('operator continuation authorization chronology is invalid');
  }
  validateArchiveDescriptor(
    interruptedRunStatusRecord,
    archives.interrupted_run_status,
    'interrupted-run-status.json',
    'archived interrupted run status',
  );
  validateArchiveDescriptor(
    interruptedStatusRecord,
    archives.interrupted_status,
    'interrupted-status.json',
    'archived interrupted document status',
  );
  validateArchiveDescriptor(
    interruptedStateRecord,
    archives.interrupted_state,
    'interrupted-state.json',
    'archived interrupted document state',
  );
  validateArchiveDescriptor(
    preContinuationLogRecord,
    archives.pre_continuation_log,
    'pre-continuation.log',
    'archived pre-continuation log',
  );
  validateArchiveDescriptor(
    inventoryRecord,
    snapshot.document_inventory,
    'document-inventory.json',
    'archived document inventory',
  );
  if (interruptedRunStatusRecord.sha256 !== profile.runStatusSha256
    || interruptedStatusRecord.sha256 !== profile.documentStatusSha256
    || interruptedStateRecord.sha256 !== profile.stateSha256
    || preContinuationLogRecord.sha256 !== profile.logSha256
    || preContinuationLogRecord.bytes !== profile.logBytes
    || !sameJson(snapshot.document_status, interruptedStatus)
    || !sameJson(snapshot.document_progress, interruptedRunStatus.documents?.[profile.documentId])
    || interruptedStatus.status !== 'interrupted'
    || interruptedStatus.attempt !== profile.attempt
    || interruptedStatus.interrupted_at !== profile.documentInterruptedAt
    || interruptedState.document_id !== profile.documentId
    || interruptedState.selected_pages_complete !== false) {
    throw new Error('archived interrupted controls differ from the frozen A2 snapshot');
  }
  validateDocumentInventory(
    inventory,
    inventoryRecord,
    interruptedStateRecord,
    preContinuationLogRecord,
    profile,
  );
  const receiptBasis = { ...receipt };
  delete receiptBasis.continuation_id;
  if (receipt.continuation_id !== sha256(canonicalJson(receiptBasis))) {
    throw new Error('operator continuation receipt ID is invalid');
  }
  exactObject(claim, [
    'schema_version',
    'claim_type',
    'mode',
    'continuation_id',
    'receipt_sha256',
    'output',
    'evidence_root',
    'document_id',
    'attempt',
    'claimed_at',
    'timeout_recovery_grant_id',
    'profile_sha256',
    'timeout_recovery_grant_sha256',
    'timeout_recovery_consumption_claim_sha256',
    'citation_allowed',
    'claim_id',
  ], 'operator continuation claim');
  const claimOutput = exactObject(claim.output, ['root', 'device', 'inode'], 'operator continuation claim output');
  const claimEvidenceRoot = exactObject(claim.evidence_root, ['path', 'device', 'inode'], 'operator continuation claim evidence root');
  if (claim.schema_version !== 2
    || claim.claim_type !== OPERATOR_CONTINUATION_CLAIM_TYPE
    || claim.mode !== OPERATOR_CONTINUATION_MODE
    || claim.continuation_id !== receipt.continuation_id
    || claim.receipt_sha256 !== receiptRecord.sha256
    || claimOutput.root !== profile.outputRoot
    || claimOutput.device !== profile.outputDevice
    || claimOutput.inode !== profile.outputInode
    || claimEvidenceRoot.path !== resolved.pathname
    || claimEvidenceRoot.device !== String(resolved.info.dev)
    || claimEvidenceRoot.inode !== String(resolved.info.ino)
    || claim.document_id !== profile.documentId
    || claim.attempt !== profile.attempt
    || claim.timeout_recovery_grant_id !== timeoutRecovery.grant_id
    || claim.profile_sha256 !== receipt.profile_sha256
    || claim.timeout_recovery_grant_sha256 !== profile.timeoutGrantSha256
    || claim.timeout_recovery_consumption_claim_sha256 !== profile.timeoutConsumptionClaimSha256
    || claim.citation_allowed !== false) {
    throw new Error('operator continuation claim is not bound to its receipt');
  }
  requireCanonicalTimestamp(claim.claimed_at, 'operator continuation claim time');
  if (Date.parse(claim.claimed_at) < Date.parse(authorization.authorized_at)) {
    throw new Error('operator continuation claim predates its authorization');
  }
  const claimBasis = { ...claim };
  delete claimBasis.claim_id;
  if (claim.claim_id !== sha256(canonicalJson(claimBasis))) {
    throw new Error('operator continuation claim ID is invalid');
  }
  const statesRoot = await requireStableDirectory(expectedPaths.states, 'operator continuation states', { mode: 0o700 });
  const stateNames = (await readdir(statesRoot.pathname)).sort();
  if (stateNames.length < 8 || stateNames.length % 2 !== 0) {
    throw new Error('operator continuation state journal is incomplete');
  }
  const jsonNames = stateNames.filter((name) => name.endsWith('.json'));
  exactNames(stateNames, jsonNames.flatMap((name) => [name, `${name}.sha256`]), 'operator continuation state journal');
  let previousSha256 = null;
  let terminal = null;
  let terminalPlan = null;
  let terminalPlanTransaction = null;
  let claimedState = null;
  const states = [];
  const executionStates = [];
  const partialCheckpoints = [];
  const invocationIds = new Set();
  const spawnNonces = new Set();
  const commonStateKeys = [
    'schema_version',
    'sequence',
    'continuation_id',
    'claim_id',
    'stage',
    'previous_state_sha256',
    'citation_allowed',
  ];
  const expectedStateKeys = new Map([
    ['claimed', [
      'claimed_at',
      'worker_invocation_id',
      'quiescent_unit_fence',
      'llama_start_nonce_seed',
    ]],
    ['running', [
      'started_at',
      'llama_invocation_id',
      'llama_main_pid',
      'llama_start_nonce',
      'spawn_nonce',
      'ocr_command_sha256',
    ]],
    ['terminal_plan', ['outcome', 'exit_code', 'terminal_at', 'transaction']],
    ['terminal', ['outcome', 'exit_code', 'terminal_at', 'terminal_plan_state_sha256']],
  ]);
  const beforeControls = originalControlRecords(profile, {
    status: interruptedStatusRecord,
    runStatus: interruptedRunStatusRecord,
  });
  for (let index = 0; index < jsonNames.length; index += 1) {
    const name = jsonNames[index];
    if (!new RegExp(`^${String(index + 1).padStart(6, '0')}-[a-z][a-z0-9_-]*\\.json$`, 'u').test(name)) {
      throw new Error('operator continuation state sequence is not contiguous');
    }
    const record = await readStableFileWithSidecar(statesRoot.pathname, path.join(statesRoot.pathname, name), 'operator continuation state');
    const value = parseJson(record, 'operator continuation state');
    const resumeMatch = /^resume_running_(\d{4})$/u.exec(String(value.stage || ''));
    const checkpointMatch = /^partial_checkpoint_(\d{4})$/u.exec(String(value.stage || ''));
    const extraKeys = checkpointMatch
      ? [
          'checkpointed_at',
          'execution_state_sha256',
          'previous_checkpoint_state_sha256',
          'baseline',
          'document_tree',
          'state',
          'append_only_log',
          'directories',
        ]
      : resumeMatch
      ? [
          'resumed_at',
          'llama_invocation_id',
          'llama_main_pid',
          'llama_start_nonce',
          'spawn_nonce',
          'ocr_command_sha256',
          'resumed_from_state_sha256',
          'partial_checkpoint_state_sha256',
        ]
      : expectedStateKeys.get(value.stage);
    if (!extraKeys) throw new Error('operator continuation state stage is invalid');
    exactObject(value, [...commonStateKeys, ...extraKeys], `operator continuation ${value.stage} state`);
    if (value.schema_version !== 1
      || value.sequence !== index + 1
      || name !== `${String(index + 1).padStart(6, '0')}-${value.stage}.json`
      || value.continuation_id !== receipt.continuation_id
      || value.claim_id !== claim.claim_id
      || value.previous_state_sha256 !== previousSha256
      || value.citation_allowed !== false) {
      throw new Error('operator continuation state chain is invalid');
    }
    if (value.stage === 'claimed'
      && (value.claimed_at !== claim.claimed_at
        || value.worker_invocation_id !== profile.workerInvocationId
        || value.llama_start_nonce_seed !== llamaStartNonceSeed(claim.claim_id))) {
      throw new Error('operator continuation claimed state is invalid');
    }
    if (value.stage === 'claimed') {
      validateQuiescentUnitFence(value.quiescent_unit_fence, profile);
      claimedState = value;
    }
    if (value.stage === 'running') {
      requireCanonicalTimestamp(value.started_at, 'operator continuation running time');
      if (value.started_at !== claim.claimed_at
        || !invocationIdPattern.test(String(value.llama_invocation_id || ''))
        || !/^[1-9]\d*$/u.test(String(value.llama_main_pid || ''))
        || !claimedState
        || value.llama_start_nonce !== llamaStartNonce(claimedState.llama_start_nonce_seed, 0)
        || !sha256Pattern.test(String(value.spawn_nonce || ''))
        || !sha256Pattern.test(String(value.ocr_command_sha256 || ''))) {
        throw new Error('operator continuation running state is invalid');
      }
      invocationIds.add(value.llama_invocation_id);
      spawnNonces.add(value.spawn_nonce);
      executionStates.push({ value, sha256: record.sha256 });
    }
    if (resumeMatch) {
      const predecessor = executionStates.at(-1);
      const expectedOrdinal = executionStates.length;
      const checkpoint = partialCheckpoints.at(-1);
      const predecessorTimestamp = predecessor?.value.resumed_at || predecessor?.value.started_at;
      requireCanonicalTimestamp(value.resumed_at, 'operator continuation resume time');
      if (!predecessor
        || Number(resumeMatch[1]) !== expectedOrdinal
        || value.resumed_from_state_sha256 !== predecessor.sha256
        || checkpoint?.value.execution_state_sha256 !== predecessor.sha256
        || value.partial_checkpoint_state_sha256 !== checkpoint?.sha256
        || !invocationIdPattern.test(String(value.llama_invocation_id || ''))
        || invocationIds.has(value.llama_invocation_id)
        || spawnNonces.has(value.spawn_nonce)
        || !/^[1-9]\d*$/u.test(String(value.llama_main_pid || ''))
        || !claimedState
        || value.llama_start_nonce !== llamaStartNonce(
          claimedState.llama_start_nonce_seed,
          executionStates.length,
        )
        || !sha256Pattern.test(String(value.spawn_nonce || ''))
        || !sha256Pattern.test(String(value.ocr_command_sha256 || ''))
        || Date.parse(value.resumed_at) < Date.parse(predecessorTimestamp)) {
        throw new Error('operator continuation resume_running state is invalid');
      }
      invocationIds.add(value.llama_invocation_id);
      spawnNonces.add(value.spawn_nonce);
      executionStates.push({ value, sha256: record.sha256 });
    }
    if (checkpointMatch) {
      const execution = executionStates.at(-1);
      const previousCheckpoint = partialCheckpoints.at(-1) || null;
      const ordinal = executionStates.length;
      requireCanonicalTimestamp(value.checkpointed_at, 'operator continuation partial checkpoint time');
      const executionTimestamp = execution?.value.resumed_at || execution?.value.started_at;
      const baseline = exactObject(value.baseline, [
        'document_tree_sha256',
        'document_tree_files',
        'document_tree_bytes',
        'state_sha256',
        'state_bytes',
        'log_sha256',
        'log_bytes',
        'log_device',
        'log_inode',
      ], 'operator continuation partial checkpoint baseline');
      if (!execution
        || Number(checkpointMatch[1]) !== ordinal
        || value.execution_state_sha256 !== execution.sha256
        || previousCheckpoint?.value.execution_state_sha256 === execution.sha256
        || value.previous_checkpoint_state_sha256 !== (previousCheckpoint?.sha256 || null)
        || Date.parse(value.checkpointed_at) < Date.parse(executionTimestamp)
        || baseline.document_tree_sha256 !== profile.documentTreeSha256
        || baseline.document_tree_files !== profile.documentTreeFiles
        || baseline.document_tree_bytes !== profile.documentTreeBytes
        || baseline.state_sha256 !== profile.stateSha256
        || baseline.state_bytes !== interruptedStateRecord.bytes
        || baseline.log_sha256 !== profile.logSha256
        || baseline.log_bytes !== profile.logBytes
        || baseline.log_device !== inventory.log.device
        || baseline.log_inode !== inventory.log.inode) {
        throw new Error('operator continuation partial checkpoint baseline or chain is invalid');
      }
      const tree = validateCheckpointTree(value.document_tree, 'operator continuation partial checkpoint');
      const stateRaw = checkpointStateRaw(value, 'operator continuation partial checkpoint');
      const checkpointState = parseJson(
        { raw: stateRaw },
        'operator continuation partial checkpoint state',
      );
      if (checkpointState.document_id !== profile.documentId
        || checkpointState.source_sha256 !== interruptedState.source_sha256
        || checkpointState.page_count !== interruptedState.page_count
        || checkpointState.selected_pages_complete !== false
        || !Array.isArray(checkpointState.completed_pages)
        || checkpointState.completed_pages.length >= checkpointState.page_count) {
        throw new Error('operator continuation partial checkpoint state is not an incomplete OCR document');
      }
      const appendOnlyLog = exactObject(value.append_only_log, [
        'sha256', 'bytes', 'device', 'inode', 'prefix_sha256', 'prefix_bytes',
      ], 'operator continuation partial checkpoint append-only log');
      validateCheckpointFileIdentity({
        sha256: appendOnlyLog.sha256,
        bytes: appendOnlyLog.bytes,
        device: appendOnlyLog.device,
        inode: appendOnlyLog.inode,
      }, 'operator continuation partial checkpoint append-only log');
      const previousTree = previousCheckpoint?.value.document_tree || inventory;
      const previousStateRaw = previousCheckpoint
        ? checkpointStateRaw(previousCheckpoint.value, 'previous operator continuation partial checkpoint')
        : interruptedStateRecord.raw;
      const previousLog = previousCheckpoint?.value.append_only_log || {
        sha256: profile.logSha256,
        bytes: profile.logBytes,
        device: inventory.log.device,
        inode: inventory.log.inode,
      };
      if (appendOnlyLog.device !== previousLog.device
        || appendOnlyLog.inode !== previousLog.inode
        || appendOnlyLog.bytes < previousLog.bytes
        || appendOnlyLog.prefix_sha256 !== previousLog.sha256
        || appendOnlyLog.prefix_bytes !== previousLog.bytes) {
        throw new Error('operator continuation partial checkpoint log chain is invalid');
      }
      const previousEntries = treeEntryMap(previousTree.entries);
      const currentEntries = treeEntryMap(tree.entries);
      for (const [pathname, entry] of previousEntries) {
        if (pathname !== 'state.json' && currentEntries.get(pathname) !== entry) {
          throw new Error(`operator continuation partial checkpoint changed prior evidence: ${pathname}`);
        }
      }
      const preexistingPageDirectories = new Set(
        previousTree.entries
          .filter((entry) => entry.startsWith('D\0pages/'))
          .map((entry) => entry.slice(0, -1).split('\0')[1])
          .filter((pathname) => /^pages\/\d{4}$/u.test(pathname)),
      );
      for (const [pathname] of currentEntries) {
        if (previousEntries.has(pathname)) continue;
        const parts = pathname.split('/');
        const match = /^pages\/(\d{4})(?:\/(.*))?$/u.exec(pathname);
        if (!match
          || parts.some((part) => !part || part === '..' || part.startsWith('.'))
          || Number(match[1]) < 1
          || Number(match[1]) > interruptedState.page_count
          || preexistingPageDirectories.has(`pages/${match[1]}`)) {
          throw new Error(`operator continuation partial checkpoint contains an invalid forward path: ${pathname}`);
        }
        if (match[2]) {
          const first = match[2].split('/')[0];
          if (!['result.json', 'content.md', 'markdown', 'visual'].includes(first)
            || (['result.json', 'content.md'].includes(first) && match[2] !== first)) {
            throw new Error(`operator continuation partial checkpoint contains an unrecognized page artifact: ${pathname}`);
          }
        }
      }
      const stateEntry = currentEntries.get('state.json');
      const stateParts = typeof stateEntry === 'string' ? stateEntry.slice(0, -1).split('\0') : [];
      if (stateParts.length !== 4
        || stateParts[0] !== 'F'
        || stateParts[2] !== String(value.state.bytes)
        || stateParts[3] !== value.state.sha256) {
        throw new Error('operator continuation partial checkpoint state differs from its tree');
      }
      validateCheckpointStateForwardOnly(
        previousStateRaw,
        stateRaw,
        profile.documentId,
        'operator continuation partial checkpoint',
      );
      validateCheckpointDirectories(
        value.directories,
        tree,
        'operator continuation partial checkpoint',
      );
      partialCheckpoints.push({ value, sha256: record.sha256 });
    }
    if (value.stage === 'terminal_plan') {
      const predecessorTimestamp = executionStates.at(-1)?.value.resumed_at
        || executionStates.at(-1)?.value.started_at;
      if (!predecessorTimestamp) throw new Error('operator continuation terminal plan has no execution state');
      requireCanonicalTimestamp(value.terminal_at, 'operator continuation terminal plan time');
      if (Date.parse(value.terminal_at) < Date.parse(predecessorTimestamp)) {
        throw new Error('operator continuation terminal plan predates its execution state');
      }
      terminalPlan = { value, sha256: record.sha256 };
      terminalPlanTransaction = validateTerminalPlanState(value, beforeControls);
    }
    previousSha256 = record.sha256;
    states.push({ name, value, sha256: record.sha256 });
    if (value.stage === 'terminal') terminal = value;
  }
  const stages = states.map(({ value }) => value.stage);
  const expectedStages = ['claimed', 'running'];
  for (let ordinal = 1; ordinal < executionStates.length; ordinal += 1) {
    expectedStages.push(
      `partial_checkpoint_${String(ordinal).padStart(4, '0')}`,
      `resume_running_${String(ordinal).padStart(4, '0')}`,
    );
  }
  expectedStages.push('terminal_plan', 'terminal');
  if (partialCheckpoints.length !== Math.max(0, executionStates.length - 1)
    || canonicalJson(stages) !== canonicalJson(expectedStages)) {
    throw new Error('operator continuation state journal stages are not exact');
  }
  if (!terminalPlan
    || !terminal
    || !['complete', 'failed', 'interrupted', 'quarantined'].includes(terminal.outcome)
    || !Number.isSafeInteger(terminal.exit_code)
    || terminal.outcome !== terminalPlan.value.outcome
    || terminal.exit_code !== terminalPlan.value.exit_code
    || terminal.terminal_at !== terminalPlan.value.terminal_at
    || terminal.terminal_plan_state_sha256 !== terminalPlan.sha256) {
    throw new Error('operator continuation terminal state is missing or invalid');
  }
  requireCanonicalTimestamp(terminal.terminal_at, 'operator continuation terminal time');
  if (Date.parse(terminal.terminal_at) < Date.parse(claim.claimed_at)) {
    throw new Error('operator continuation terminal state predates its claim');
  }
  const evidenceTree = await inspectTreeStrict(resolved.pathname);
  return {
    profile,
    receipt,
    receiptSha256: receiptRecord.sha256,
    claim,
    claimSha256: claimRecord.sha256,
    inventory,
    inventorySha256: inventoryRecord.sha256,
    archives: {
      interruptedRunStatus,
      interruptedRunStatusSha256: interruptedRunStatusRecord.sha256,
      interruptedStatus,
      interruptedStatusSha256: interruptedStatusRecord.sha256,
      interruptedState,
      interruptedStateSha256: interruptedStateRecord.sha256,
      preContinuationLogSha256: preContinuationLogRecord.sha256,
      preContinuationLogBytes: preContinuationLogRecord.bytes,
    },
    terminalPlan,
    terminalPlanTransaction,
    terminal,
    states,
    partialCheckpoints,
    evidenceTree,
    evidence_fingerprint_sha256: sha256(canonicalJson({
      profile_sha256: receipt.profile_sha256,
      receipt_sha256: receiptRecord.sha256,
      claim_sha256: claimRecord.sha256,
      inventory_sha256: inventoryRecord.sha256,
      terminal_state_sha256: previousSha256,
      evidence_tree_sha256: evidenceTree.tree_sha256,
    })),
  };
}

function treeEntryMap(entries) {
  return new Map(entries.map((entry) => {
    const parts = entry.replace(/\n$/u, '').split('\0');
    return [parts[1], entry];
  }));
}

export async function validateOperatorContinuationOutput(
  outputRoot,
  evidence,
  rawProfile = EXACT_A2_FORWARD_CONTINUATION_INCIDENT,
) {
  const profile = validateA2ForwardContinuationProfile(rawProfile);
  if (evidence.profile !== profile && canonicalJson(evidence.profile) !== canonicalJson(profile)) {
    throw new Error('operator continuation evidence and output profiles differ');
  }
  if (evidence.terminal.outcome !== 'complete' || evidence.terminal.exit_code !== 0) {
    throw new Error('receiver requires a complete exit-0 operator continuation terminal state');
  }
  const root = await requireStableDirectory(outputRoot, 'continued A2 output root', {
    dev: profile.outputDevice,
    ino: profile.outputInode,
  });
  if (root.pathname !== profile.outputRoot) throw new Error('continued A2 output path differs from the frozen profile');
  const paths = operatorContinuationEvidencePaths(
    profile.evidenceBaseRoot,
    profile.documentId,
    profile.attempt,
  );
  const statusPath = path.join(root.pathname, 'status', `${profile.documentId}.json`);
  const runStatusPath = path.join(root.pathname, 'run-status.json');
  const logPath = path.join(root.pathname, 'logs', `${profile.documentId}.log`);
  const documentRoot = path.join(root.pathname, 'documents', profile.documentId);
  const statePath = path.join(documentRoot, 'state.json');
  const latestCheckpoint = evidence.partialCheckpoints?.at(-1) || null;
  await verifyFrozenDirectoryIdentities(documentRoot, evidence.inventory.directories);
  if (latestCheckpoint) {
    await verifyFrozenDirectoryIdentities(documentRoot, latestCheckpoint.value.directories);
  }
  const [statusRecord, runStatusRecord, logRecord, preLogRecord, stateRecord, tree] = await Promise.all([
    readStableFileWithSidecar(root.pathname, statusPath, 'continued A2 document status'),
    readStableFileWithSidecar(root.pathname, runStatusPath, 'continued A2 run status'),
    readStableFile(root.pathname, logPath, 'continued A2 document log'),
    readStableFile(paths.root, paths.preContinuationLog, 'archived pre-continuation log'),
    readStableFile(root.pathname, statePath, 'continued A2 document state'),
    inspectTreeStrict(documentRoot),
  ]);
  await verifyFrozenDirectoryIdentities(documentRoot, evidence.inventory.directories);
  if (latestCheckpoint) {
    await verifyFrozenDirectoryIdentities(documentRoot, latestCheckpoint.value.directories);
  }
  const status = parseJson(statusRecord, 'continued A2 document status');
  const runStatus = parseJson(runStatusRecord, 'continued A2 run status');
  const progress = requireObject(runStatus.documents?.[profile.documentId], 'continued A2 run progress');
  const liveControls = new Map([
    [`status/${profile.documentId}.json`, statusRecord],
    [`status/${profile.documentId}.json.sha256`, statusRecord.sidecar],
    ['run-status.json', runStatusRecord],
    ['run-status.json.sha256', runStatusRecord.sidecar],
  ]);
  for (const [outputPath, record] of liveControls) {
    const planned = evidence.terminalPlanTransaction?.get(outputPath);
    if (!planned
      || planned.after_sha256 !== record.sha256
      || planned.after_bytes !== record.bytes
      || !planned.after.equals(record.raw)) {
      throw new Error(`continued A2 control differs from its immutable terminal plan: ${outputPath}`);
    }
  }
  if (status.schema_version !== 1
    || status.document_id !== profile.documentId
    || status.status !== 'complete'
    || status.attempt !== profile.attempt
    || status.max_attempts !== profile.attempt
    || status.citation_allowed !== false
    || status.seed_lineage?.seed_id !== profile.seedId
    || status.seed_lineage?.granted_attempt !== profile.attempt
    || progress.status !== 'complete'
    || progress.attempts !== profile.attempt
    || progress.status_json_sha256 !== statusRecord.sha256
    || status.completed_at !== evidence.terminal.terminal_at
    || progress.completed_at !== evidence.terminal.terminal_at
    || runStatus.updated_at !== evidence.terminal.terminal_at
    || runStatus.finished !== true
    || runStatus.settled !== true
    || runStatus.citation_allowed !== false) {
    throw new Error('continued A2 live controls are not exact complete attempt 6');
  }
  const logPrefix = latestCheckpoint?.value.append_only_log || {
    sha256: preLogRecord.sha256,
    bytes: preLogRecord.bytes,
    device: evidence.inventory.log.device,
    inode: evidence.inventory.log.inode,
  };
  if (logRecord.dev !== logPrefix.device
    || logRecord.ino !== logPrefix.inode
    || logRecord.bytes < logPrefix.bytes
    || preLogRecord.sha256 !== profile.logSha256
    || preLogRecord.bytes !== profile.logBytes
    || sha256(logRecord.raw.subarray(0, logPrefix.bytes)) !== logPrefix.sha256
    || status.artifacts?.append_only_log?.sha256 !== logRecord.sha256
    || status.artifacts?.append_only_log?.bytes !== logRecord.bytes
    || status.artifacts?.append_only_log?.device !== logRecord.dev
    || status.artifacts?.append_only_log?.inode !== logRecord.ino) {
    throw new Error('continued A2 live log is not the same append-only inode and prefix');
  }
  for (const checkpoint of evidence.partialCheckpoints || []) {
    const checkpointLog = checkpoint.value.append_only_log;
    if (logRecord.dev !== checkpointLog.device
      || logRecord.ino !== checkpointLog.inode
      || logRecord.bytes < checkpointLog.bytes
      || sha256(logRecord.raw.subarray(0, checkpointLog.bytes)) !== checkpointLog.sha256) {
      throw new Error('continued A2 live log does not retain every partial checkpoint prefix');
    }
  }
  const beforeTree = latestCheckpoint?.value.document_tree || evidence.inventory;
  const beforeEntries = treeEntryMap(beforeTree.entries);
  const afterEntries = treeEntryMap(tree.entries);
  const finalStateEntry = afterEntries.get('state.json');
  const finalStateParts = typeof finalStateEntry === 'string'
    ? finalStateEntry.replace(/\n$/u, '').split('\0')
    : [];
  if (finalStateParts.length !== 4
    || finalStateParts[0] !== 'F'
    || status.artifacts?.state_sha256 !== finalStateParts[3]) {
    throw new Error('continued A2 final state is missing or differs from terminal artifacts');
  }
  const preexistingPages = new Set(
    beforeTree.entries
      .filter((entry) => entry.startsWith('D\0pages/'))
      .map((entry) => entry.replace(/\n$/u, '').split('\0')[1])
      .filter((pathname) => /^pages\/\d{4}$/u.test(pathname)),
  );
  for (const [pathname, entry] of beforeEntries) {
    if (pathname === 'state.json') continue;
    if (afterEntries.get(pathname) !== entry) {
      throw new Error(`continued A2 changed or removed frozen document evidence: ${pathname}`);
    }
  }
  if (latestCheckpoint) {
    validateCheckpointStateForwardOnly(
      checkpointStateRaw(latestCheckpoint.value, 'latest operator continuation partial checkpoint'),
      stateRecord.raw,
      profile.documentId,
      'continued A2 final state',
    );
  }
  for (const [pathname] of afterEntries) {
    if (beforeEntries.has(pathname)) continue;
    const parts = pathname.split('/');
    const match = /^pages\/(\d{4})(?:\/(.*))?$/u.exec(pathname);
    if (!match
      || parts.some((part) => part.length === 0 || part === '..' || part.startsWith('.'))
      || Number(match[1]) < 1
      || Number(match[1]) > status.page_count
      || preexistingPages.has(`pages/${match[1]}`)) {
      throw new Error(`continued A2 contains an invalid forward-only path: ${pathname}`);
    }
    if (match[2]) {
      const first = match[2].split('/')[0];
      if (!['result.json', 'content.md', 'markdown', 'visual'].includes(first)
        || (['result.json', 'content.md'].includes(first) && match[2] !== first)) {
        throw new Error(`continued A2 contains an unrecognized forward artifact: ${pathname}`);
      }
    }
  }
  const declaredTree = status.artifacts?.forward_document_tree;
  if (!declaredTree
    || declaredTree.tree_sha256 !== tree.tree_sha256
    || declaredTree.files !== tree.files
    || declaredTree.bytes !== tree.bytes) {
    throw new Error('continued A2 live tree differs from its terminal status fingerprint');
  }
  return {
    status,
    statusSha256: statusRecord.sha256,
    runStatus,
    runStatusSha256: runStatusRecord.sha256,
    documentTree: tree,
    log: {
      sha256: logRecord.sha256,
      bytes: logRecord.bytes,
      device: logRecord.dev,
      inode: logRecord.ino,
    },
    output_fingerprint_sha256: sha256(canonicalJson({
      evidence_fingerprint_sha256: evidence.evidence_fingerprint_sha256,
      terminal_state_sha256: evidence.states.at(-1)?.sha256,
      status_sha256: statusRecord.sha256,
      run_status_sha256: runStatusRecord.sha256,
      document_tree_sha256: tree.tree_sha256,
      log_sha256: logRecord.sha256,
      log_device: logRecord.dev,
      log_inode: logRecord.ino,
    })),
  };
}
