#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const sha256Pattern = /^[a-f0-9]{64}$/u;
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const unitPattern = /^[A-Za-z0-9][A-Za-z0-9_.@:-]*\.service$/u;
const issueCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const invocationPattern = /^[a-f0-9]{32}$/u;
const bootIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const alertStateSchemaVersion = 2;
const stateFiles = Object.freeze({
  arming: 'arming.json',
  armed: 'armed-receipt.json',
  deliveries: 'delivery-state.json',
  result: 'last-result.json',
});
const allowedLatestKeys = Object.freeze([
  'exit_code',
  'issue_codes',
  'predecessor',
  'resources',
  'run_id',
  'schema_version',
  'services',
  'state',
  'successor',
  'timestamp',
]);
const credentialPath = path.join(
  os.homedir(),
  '.config',
  'bdfz',
  'curriculum-ocr-monitor-telegram.env',
);

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
};

export const canonicalJson = (value) => JSON.stringify(canonicalize(value));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const iso = (milliseconds) => new Date(milliseconds).toISOString();
const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(requireObject(value, label)).sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} schema is invalid`);
}

function normalizeInvocationId(value, label) {
  const normalized = String(value || '').toLowerCase().replaceAll('-', '');
  if (!invocationPattern.test(normalized) || /^0+$/u.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function requireBootId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!bootIdPattern.test(normalized)) throw new Error('boot id is invalid');
  return normalized;
}

function requireIssueCodes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new Error('issue_codes must be a non-empty bounded array');
  }
  const codes = [...new Set(value.map(String))].sort(compareText);
  if (codes.length !== value.length || codes.some((code) => !issueCodePattern.test(code))) {
    throw new Error('issue_codes contains an invalid or duplicate code');
  }
  return codes;
}

function inside(root, pathname) {
  const relative = path.relative(root, pathname);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function disjoint(left, right) {
  return !inside(left, right) && !inside(right, left);
}

async function readProtectedFile(pathname, label, { mode, owner = true } = {}) {
  const info = await lstat(pathname);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  const resolved = await realpath(pathname);
  if (resolved !== path.resolve(pathname)) throw new Error(`${label} is not canonical`);
  if (owner && typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error(`${label} has the wrong owner`);
  }
  if (mode !== undefined && (info.mode & 0o777) !== mode) throw new Error(`${label} must be mode ${mode.toString(8)}`);
  const raw = await readFile(pathname);
  return { raw, sha256: sha256(raw), info };
}

async function requireStateDirectory(stateDir) {
  const info = await lstat(stateDir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('state directory must be a real directory');
  if ((info.mode & 0o777) !== 0o700) throw new Error('state directory must be mode 700');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('state directory has the wrong owner');
  }
  const resolved = await realpath(stateDir);
  if (resolved !== stateDir) throw new Error('state directory is not canonical');
  return resolved;
}

async function atomicWriteJson(stateDir, basename, value) {
  const destination = path.join(stateDir, basename);
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
  await chmod(destination, 0o600);
}

async function readStateJson(stateDir, basename) {
  const pathname = path.join(stateDir, basename);
  try {
    const record = await readProtectedFile(pathname, `state file ${basename}`, { mode: 0o600 });
    return JSON.parse(record.raw.toString('utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error(`state file ${basename} is invalid JSON`);
    throw error;
  }
}

async function removeStateFile(stateDir, basename) {
  await unlink(path.join(stateDir, basename)).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

function parseSystemdShow(raw) {
  const values = {};
  for (const line of String(raw || '').split(/\r?\n/u)) {
    const separator = line.indexOf('=');
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

async function probeSystemdUnit(unit, runExecFile = execFile) {
  const { stdout } = await runExecFile('/usr/bin/systemctl', [
    '--user',
    'show',
    unit,
    '--no-pager',
    '--property=InvocationID',
    '--property=ExecMainStatus',
    '--property=ExecMainStartTimestamp',
    '--property=Result',
  ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
  const values = parseSystemdShow(stdout);
  const startedAtMilliseconds = Date.parse(values.ExecMainStartTimestamp || '');
  const invocationId = String(values.InvocationID || '').trim();
  return {
    invocation_id: invocationId ? normalizeInvocationId(invocationId, `${unit} InvocationID`) : null,
    exit_code: Number(values.ExecMainStatus),
    started_at_milliseconds: Number.isFinite(startedAtMilliseconds) ? startedAtMilliseconds : null,
    result: values.Result || null,
  };
}

async function defaultRuntimeEvidence(config) {
  const [bootRaw, monitor, worker] = await Promise.all([
    readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    probeSystemdUnit(config.monitorUnit),
    probeSystemdUnit(config.workerUnit),
  ]);
  return {
    boot_id: requireBootId(bootRaw),
    monitor,
    worker,
  };
}

function makeBinding(config, runtime) {
  return {
    run_id: config.expectedRunId,
    boot_id: requireBootId(runtime.boot_id),
    worker_unit: config.workerUnit,
    worker_invocation_id: normalizeInvocationId(runtime.worker.invocation_id, 'worker InvocationID'),
    monitor_sha256: config.monitorSha256,
  };
}

function validateBinding(value, label = 'alert binding') {
  requireExactKeys(value, [
    'boot_id',
    'monitor_sha256',
    'run_id',
    'worker_invocation_id',
    'worker_unit',
  ], label);
  if (!runIdPattern.test(value.run_id)
    || !unitPattern.test(value.worker_unit)
    || !sha256Pattern.test(value.monitor_sha256)) throw new Error(`${label} is invalid`);
  return {
    run_id: value.run_id,
    boot_id: requireBootId(value.boot_id),
    worker_unit: value.worker_unit,
    worker_invocation_id: normalizeInvocationId(
      value.worker_invocation_id,
      `${label} worker InvocationID`,
    ),
    monitor_sha256: value.monitor_sha256,
  };
}

function bindingMatchesStaticConfig(binding, config, bootId = null) {
  return binding.run_id === config.expectedRunId
    && binding.worker_unit === config.workerUnit
    && binding.monitor_sha256 === config.monitorSha256
    && (bootId === null || binding.boot_id === requireBootId(bootId));
}

async function verifyMonitorScript(config) {
  const record = await readProtectedFile(config.monitorScript, 'monitor script');
  if (record.sha256 !== config.monitorSha256) throw new Error('monitor script SHA-256 mismatch');
  return record.sha256;
}

function safeProgress(latest) {
  const completed = Number(latest.successor?.completed_pages);
  const expected = Number(latest.successor?.expected_pages);
  return Number.isSafeInteger(completed) && completed >= 0
    && Number.isSafeInteger(expected) && expected >= completed
    ? { completed_pages: completed, expected_pages: expected }
    : null;
}

async function readPrivacySafeLatest(config, runtime, nowMilliseconds) {
  const record = await readProtectedFile(config.latestJson, 'monitor latest.json', { mode: 0o600 });
  let latest;
  try { latest = JSON.parse(record.raw.toString('utf8')); } catch { throw new Error('monitor latest.json is invalid JSON'); }
  requireExactKeys(latest, allowedLatestKeys, 'monitor latest.json');
  if (latest.schema_version !== 1 || latest.run_id !== config.expectedRunId) {
    throw new Error('monitor latest.json identity is invalid');
  }
  const observedMilliseconds = Date.parse(latest.timestamp);
  if (!Number.isFinite(observedMilliseconds)
    || observedMilliseconds > nowMilliseconds + 30_000
    || nowMilliseconds - observedMilliseconds > config.maxLatestAgeSeconds * 1000) {
    throw new Error('monitor latest.json is stale');
  }
  if (!Number.isFinite(runtime.monitor.started_at_milliseconds)
    || observedMilliseconds + 2_000 < runtime.monitor.started_at_milliseconds) {
    throw new Error('monitor latest.json predates the current invocation');
  }
  if (![0, 10, 12].includes(latest.exit_code)) throw new Error('monitor latest.json exit code is invalid');
  const issueCodes = latest.issue_codes.length === 0 ? [] : requireIssueCodes(latest.issue_codes);
  return {
    exit_code: latest.exit_code,
    issue_codes: issueCodes,
    observed_at: latest.timestamp,
    raw_sha256: record.sha256,
    state: latest.state,
    progress: safeProgress(latest),
  };
}

function sameBinding(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function receiptBody(binding, observations, armedAt) {
  return {
    schema_version: alertStateSchemaVersion,
    type: 'curriculum_ocr_monitor_alert_armed_receipt',
    binding,
    observations,
    armed_at: armedAt,
  };
}

function validateObservation(value, label) {
  requireExactKeys(value, ['latest_sha256', 'monitor_invocation_id', 'observed_at'], label);
  const observedMilliseconds = Date.parse(value.observed_at);
  if (!sha256Pattern.test(value.latest_sha256)
    || !Number.isFinite(observedMilliseconds)) throw new Error(`${label} is invalid`);
  return {
    monitor_invocation_id: normalizeInvocationId(value.monitor_invocation_id, `${label} InvocationID`),
    latest_sha256: value.latest_sha256,
    observed_at: value.observed_at,
  };
}

function validateArmingState(value, binding) {
  if (!value) return null;
  requireExactKeys(value, ['binding', 'observation', 'schema_version', 'type'], 'arming state');
  if (value.schema_version !== alertStateSchemaVersion
    || value.type !== 'curriculum_ocr_monitor_alert_arming') {
    throw new Error('arming state identity is invalid');
  }
  const normalizedBinding = validateBinding(value.binding, 'arming binding');
  const observation = validateObservation(value.observation, 'arming observation');
  return sameBinding(normalizedBinding, binding)
    ? { ...value, binding: normalizedBinding, observation }
    : null;
}

function parseArmedReceipt(value) {
  if (!value) return null;
  requireExactKeys(value, [
    'armed_at',
    'binding',
    'observations',
    'receipt_sha256',
    'schema_version',
    'type',
  ], 'armed receipt');
  const { receipt_sha256: claimed, ...body } = value;
  if (!sha256Pattern.test(claimed) || sha256(canonicalJson(body)) !== claimed) {
    throw new Error('armed receipt hash is invalid');
  }
  if (value.schema_version !== alertStateSchemaVersion
    || value.type !== 'curriculum_ocr_monitor_alert_armed_receipt'
    || !Array.isArray(value.observations)
    || value.observations.length !== 2) throw new Error('armed receipt identity is invalid');
  const binding = validateBinding(value.binding, 'armed receipt binding');
  const observations = value.observations.map((entry) => validateObservation(entry, 'receipt observation'));
  const invocations = observations.map((entry) => entry.monitor_invocation_id);
  if (new Set(invocations).size !== 2) throw new Error('armed receipt observations are not distinct');
  return { ...value, binding, observations };
}

function validateArmedReceipt(value, binding) {
  const receipt = parseArmedReceipt(value);
  return receipt && sameBinding(receipt.binding, binding) ? receipt : null;
}

async function recoverBindingFromArmedReceipt(config, runtime, stateDir) {
  const receipt = parseArmedReceipt(await readStateJson(stateDir, stateFiles.armed));
  if (!receipt
    || !bindingMatchesStaticConfig(receipt.binding, config, runtime.boot_id)) {
    throw new Error('live worker InvocationID is absent and no exact armed receipt binding can recover it');
  }
  return receipt.binding;
}

async function writeResult(stateDir, nowMilliseconds, binding, state, issueCodes = [], fingerprint = null) {
  await atomicWriteJson(stateDir, stateFiles.result, {
    schema_version: alertStateSchemaVersion,
    timestamp: iso(nowMilliseconds),
    run_id: binding.run_id,
    state,
    issue_codes: issueCodes,
    issue_fingerprint: fingerprint,
  });
}

async function observeSuccessfulMonitor(config, runtime, binding, nowMilliseconds, stateDir) {
  const exitCode = runtime.monitor.exit_code;
  if (![0, 10].includes(exitCode) || runtime.monitor.result !== 'success') {
    throw new Error('observe mode requires a successful monitor exit 0 or 10');
  }
  const latest = await readPrivacySafeLatest(config, runtime, nowMilliseconds);
  if (latest.exit_code !== exitCode || latest.issue_codes.length !== 0) {
    throw new Error('successful monitor evidence disagrees with latest.json');
  }
  if (exitCode === 0) {
    if (latest.state !== 'completed') throw new Error('exit 0 latest.json must be completed');
    await Promise.all([
      removeStateFile(stateDir, stateFiles.arming),
      removeStateFile(stateDir, stateFiles.armed),
    ]);
    await writeResult(stateDir, nowMilliseconds, binding, 'completed_no_alert');
    return { state: 'completed_no_alert', sent: false };
  }
  if (latest.state !== 'healthy_running') throw new Error('exit 10 latest.json must be healthy_running');
  await closeSentIncidents(
    stateDir,
    binding,
    normalizeInvocationId(runtime.monitor.invocation_id, 'monitor InvocationID'),
    nowMilliseconds,
  );
  const existingReceipt = validateArmedReceipt(
    await readStateJson(stateDir, stateFiles.armed),
    binding,
  );
  if (existingReceipt) {
    await writeResult(stateDir, nowMilliseconds, binding, 'armed_no_alert');
    return { state: 'armed_no_alert', sent: false };
  }
  const observation = {
    monitor_invocation_id: normalizeInvocationId(runtime.monitor.invocation_id, 'monitor InvocationID'),
    latest_sha256: latest.raw_sha256,
    observed_at: latest.observed_at,
  };
  const arming = validateArmingState(await readStateJson(stateDir, stateFiles.arming), binding);
  const canAdvance = arming
    && arming.observation?.monitor_invocation_id !== observation.monitor_invocation_id
    && arming.observation?.latest_sha256 !== observation.latest_sha256;
  if (!canAdvance) {
    await atomicWriteJson(stateDir, stateFiles.arming, {
      schema_version: alertStateSchemaVersion,
      type: 'curriculum_ocr_monitor_alert_arming',
      binding,
      observation,
    });
    await writeResult(stateDir, nowMilliseconds, binding, 'warming_no_alert');
    return { state: 'warming_no_alert', sent: false };
  }
  const observations = [arming.observation, observation];
  const body = receiptBody(binding, observations, iso(nowMilliseconds));
  await atomicWriteJson(stateDir, stateFiles.armed, {
    ...body,
    receipt_sha256: sha256(canonicalJson(body)),
  });
  await removeStateFile(stateDir, stateFiles.arming);
  await writeResult(stateDir, nowMilliseconds, binding, 'armed_no_alert');
  return { state: 'armed_no_alert', sent: false };
}

function normalizeDeliveryState(value) {
  if (!value) {
    return {
      schema_version: alertStateSchemaVersion,
      type: 'curriculum_ocr_monitor_alert_deliveries',
      recovery_epoch: 0,
      records: [],
    };
  }
  requireExactKeys(value, ['records', 'recovery_epoch', 'schema_version', 'type'], 'delivery state');
  if (value.schema_version !== alertStateSchemaVersion
    || value.type !== 'curriculum_ocr_monitor_alert_deliveries'
    || !Number.isSafeInteger(value.recovery_epoch)
    || value.recovery_epoch < 0
    || !Array.isArray(value.records)
    || value.records.length > 64) throw new Error('delivery state is invalid');
  for (const record of value.records) {
    const keys = [
      'attempts',
      'binding',
      'envelope',
      'envelope_sha256',
      'epoch',
      'fingerprint',
      'first_attempt_at',
      'issue_codes',
      'last_attempt_at',
      'status',
    ];
    if (record.status === 'sent') keys.push('sent_at');
    if (record.status === 'closed') {
      keys.push('closed_at', 'closed_by_monitor_invocation_id', 'sent_at');
    }
    requireExactKeys(record, keys, 'delivery record');
    const binding = validateBinding(record.binding, 'delivery binding');
    const issueCodes = requireIssueCodes(record.issue_codes);
    if (!sha256Pattern.test(record.fingerprint)
      || !sha256Pattern.test(record.envelope_sha256)
      || !['pending', 'sent', 'closed'].includes(record.status)
      || !Number.isSafeInteger(record.epoch)
      || record.epoch < 0
      || record.epoch > value.recovery_epoch
      || !Number.isSafeInteger(record.attempts)
      || record.attempts < 1
      || !Number.isFinite(Date.parse(record.first_attempt_at))
      || !Number.isFinite(Date.parse(record.last_attempt_at))
      || (record.status !== 'pending' && !Number.isFinite(Date.parse(record.sent_at)))
      || (record.status === 'closed'
        && (!Number.isFinite(Date.parse(record.closed_at))
          || normalizeInvocationId(
            record.closed_by_monitor_invocation_id,
            'delivery recovery monitor InvocationID',
          ) !== record.closed_by_monitor_invocation_id))) {
      throw new Error('delivery record is invalid');
    }
    const expectedFingerprint = issueFingerprint(binding, issueCodes, record.epoch);
    if (record.fingerprint !== expectedFingerprint) throw new Error('delivery fingerprint is invalid');
    const envelope = validateAlertEnvelope(record.envelope);
    if (record.envelope_sha256 !== sha256(canonicalJson(envelope))
      || envelope.issue_fingerprint !== record.fingerprint
      || envelope.run_id !== binding.run_id
      || canonicalJson(envelope.issue_codes) !== canonicalJson(issueCodes)) {
      throw new Error('delivery envelope is invalid');
    }
    record.binding = binding;
    record.issue_codes = issueCodes;
    record.envelope = envelope;
  }
  return value;
}

function issueFingerprint(binding, issueCodes, recoveryEpoch) {
  return sha256(canonicalJson({ binding, issue_codes: issueCodes, recovery_epoch: recoveryEpoch }));
}

function buildAlertPayload(config, binding, issueCodes, latest, fingerprint, nowMilliseconds) {
  return {
    schema_version: alertStateSchemaVersion,
    type: 'bdfz_curriculum_ocr_monitor_alert',
    timestamp: iso(nowMilliseconds),
    run_id: binding.run_id,
    monitor_unit: config.monitorUnit,
    issue_codes: issueCodes,
    issue_fingerprint: fingerprint,
    progress: latest?.progress || null,
  };
}

function validateAlertEnvelope(value) {
  requireExactKeys(value, [
    'issue_codes',
    'issue_fingerprint',
    'monitor_unit',
    'progress',
    'run_id',
    'schema_version',
    'timestamp',
    'type',
  ], 'delivery envelope');
  if (value.schema_version !== alertStateSchemaVersion
    || value.type !== 'bdfz_curriculum_ocr_monitor_alert'
    || !Number.isFinite(Date.parse(value.timestamp))
    || !runIdPattern.test(value.run_id)
    || !unitPattern.test(value.monitor_unit)
    || !sha256Pattern.test(value.issue_fingerprint)) throw new Error('delivery envelope is invalid');
  const issueCodes = requireIssueCodes(value.issue_codes);
  let progress = null;
  if (value.progress !== null) {
    requireExactKeys(value.progress, ['completed_pages', 'expected_pages'], 'delivery progress');
    const completed = value.progress.completed_pages;
    const expected = value.progress.expected_pages;
    if (!Number.isSafeInteger(completed)
      || completed < 0
      || !Number.isSafeInteger(expected)
      || expected < completed) throw new Error('delivery progress is invalid');
    progress = { completed_pages: completed, expected_pages: expected };
  }
  return { ...value, issue_codes: issueCodes, progress };
}

function pruneDeliveryRecords(deliveries) {
  while (deliveries.records.length > 64) {
    const closedIndex = deliveries.records.findIndex((record) => record.status === 'closed');
    if (closedIndex < 0) throw new Error('too many active delivery records');
    deliveries.records.splice(closedIndex, 1);
  }
}

async function closeSentIncidents(stateDir, binding, monitorInvocationId, nowMilliseconds) {
  const raw = await readStateJson(stateDir, stateFiles.deliveries);
  if (!raw) return false;
  const deliveries = normalizeDeliveryState(raw);
  const sent = deliveries.records.filter(
    (record) => record.status === 'sent' && sameBinding(record.binding, binding),
  );
  if (sent.length === 0) return false;
  for (const record of sent) {
    record.status = 'closed';
    record.closed_at = iso(nowMilliseconds);
    record.closed_by_monitor_invocation_id = monitorInvocationId;
  }
  deliveries.recovery_epoch = Math.max(
    deliveries.recovery_epoch,
    ...sent.map((record) => record.epoch + 1),
  );
  await atomicWriteJson(stateDir, stateFiles.deliveries, deliveries);
  return true;
}

async function deliverPendingRecord(
  stateDir,
  deliveries,
  record,
  nowMilliseconds,
  sendAlert,
  successState,
) {
  record.attempts += 1;
  record.last_attempt_at = iso(nowMilliseconds);
  pruneDeliveryRecords(deliveries);
  await atomicWriteJson(stateDir, stateFiles.deliveries, deliveries);
  try {
    await sendAlert(record.envelope);
  } catch {
    await writeResult(
      stateDir,
      nowMilliseconds,
      record.binding,
      'delivery_pending',
      record.issue_codes,
      record.fingerprint,
    );
    throw new Error('alert delivery failed');
  }
  record.status = 'sent';
  record.sent_at = iso(nowMilliseconds);
  await atomicWriteJson(stateDir, stateFiles.deliveries, deliveries);
  await writeResult(
    stateDir,
    nowMilliseconds,
    record.binding,
    successState,
    record.issue_codes,
    record.fingerprint,
  );
  return {
    state: successState,
    sent: true,
    issue_codes: record.issue_codes,
    fingerprint: record.fingerprint,
  };
}

async function retryPendingDelivery(config, nowMilliseconds, stateDir, sendAlert) {
  const raw = await readStateJson(stateDir, stateFiles.deliveries);
  if (!raw) return null;
  const deliveries = normalizeDeliveryState(raw);
  const pending = deliveries.records.filter((record) => record.status === 'pending');
  if (pending.length === 0) return null;
  if (pending.length !== 1) throw new Error('multiple pending alert envelopes are invalid');
  const [record] = pending;
  if (!bindingMatchesStaticConfig(record.binding, config)
    || record.envelope.monitor_unit !== config.monitorUnit) {
    throw new Error('pending alert envelope does not match the configured lineage');
  }
  return deliverPendingRecord(
    stateDir,
    deliveries,
    record,
    nowMilliseconds,
    sendAlert,
    'sent_pending_retry',
  );
}

async function alertFailedMonitor(config, runtime, binding, nowMilliseconds, stateDir, sendAlert) {
  if ([0, 10].includes(runtime.monitor.exit_code) && runtime.monitor.result === 'success') {
    await writeResult(stateDir, nowMilliseconds, binding, 'successful_exit_no_alert');
    return { state: 'successful_exit_no_alert', sent: false };
  }
  let issueCodes = ['MONITOR_EXECUTION_FAILED'];
  let latest = null;
  try {
    await verifyMonitorScript(config);
    if (runtime.monitor.exit_code !== 12) throw new Error('monitor did not exit 12');
    latest = await readPrivacySafeLatest(config, runtime, nowMilliseconds);
    if (latest.exit_code !== 12 || latest.state !== 'blocked' || latest.issue_codes.length < 1) {
      throw new Error('blocked monitor evidence disagrees with latest.json');
    }
    issueCodes = latest.issue_codes;
  } catch {
    latest = null;
  }
  const receipt = validateArmedReceipt(
    await readStateJson(stateDir, stateFiles.armed),
    binding,
  );
  const deliveries = normalizeDeliveryState(await readStateJson(stateDir, stateFiles.deliveries));
  const fingerprint = issueFingerprint(binding, issueCodes, deliveries.recovery_epoch);
  if (!receipt) {
    await writeResult(stateDir, nowMilliseconds, binding, 'suppressed_disarmed', issueCodes, fingerprint);
    return { state: 'suppressed_disarmed', sent: false, issue_codes: issueCodes };
  }
  const existing = deliveries.records.find((record) => record.fingerprint === fingerprint);
  if (existing?.status === 'sent' || existing?.status === 'closed') {
    await writeResult(stateDir, nowMilliseconds, binding, 'deduplicated', issueCodes, fingerprint);
    return { state: 'deduplicated', sent: false, issue_codes: issueCodes, fingerprint };
  }
  if (existing?.status === 'pending') {
    return deliverPendingRecord(
      stateDir,
      deliveries,
      existing,
      nowMilliseconds,
      sendAlert,
      'sent_pending_retry',
    );
  }
  const envelope = buildAlertPayload(
    config,
    binding,
    issueCodes,
    latest,
    fingerprint,
    nowMilliseconds,
  );
  const record = {
    fingerprint,
    issue_codes: issueCodes,
    binding,
    epoch: deliveries.recovery_epoch,
    envelope,
    envelope_sha256: sha256(canonicalJson(envelope)),
    status: 'pending',
    attempts: 0,
    first_attempt_at: iso(nowMilliseconds),
  };
  deliveries.records.push(record);
  return deliverPendingRecord(
    stateDir,
    deliveries,
    record,
    nowMilliseconds,
    sendAlert,
    'sent',
  );
}

function parseCredentialFile(raw) {
  const values = new Map();
  for (const line of raw.toString('utf8').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) throw new Error('credential file format is invalid');
    const name = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    if (values.has(name) || !value) throw new Error('credential file contains an invalid entry');
    values.set(name, value);
  }
  const expected = [
    'BDFZ_OCR_MONITOR_TELEGRAM_BOT_TOKEN',
    'BDFZ_OCR_MONITOR_TELEGRAM_CHAT_ID',
  ];
  if (JSON.stringify([...values.keys()].sort()) !== JSON.stringify(expected.sort())) {
    throw new Error('credential file has unexpected names');
  }
  return {
    botToken: values.get('BDFZ_OCR_MONITOR_TELEGRAM_BOT_TOKEN'),
    chatId: values.get('BDFZ_OCR_MONITOR_TELEGRAM_CHAT_ID'),
  };
}

export function telegramMessage(payload) {
  const progress = payload.progress
    ? `\nprogress=${payload.progress.completed_pages}/${payload.progress.expected_pages}`
    : '';
  return `[BDFZ OCR monitor]\nrun=${payload.run_id}\nissues=${payload.issue_codes.join(',')}\nfingerprint=${payload.issue_fingerprint}${progress}`;
}

async function sendTelegram(config, payload, runFetch = fetch) {
  if (config.credentialFile !== credentialPath) throw new Error('credential path is not the dedicated BDFZ OCR path');
  const record = await readProtectedFile(config.credentialFile, 'Telegram credential file', { mode: 0o600 });
  const credentials = parseCredentialFile(record.raw);
  if (!/^\d{6,12}:[A-Za-z0-9_-]{20,}$/u.test(credentials.botToken)
    || !/^-?\d{1,20}$/u.test(credentials.chatId)) throw new Error('Telegram credential value format is invalid');
  const response = await runFetch(`https://api.telegram.org/bot${credentials.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: credentials.chatId, text: telegramMessage(payload) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('Telegram rejected the alert');
  const body = await response.json().catch(() => null);
  if (body?.ok !== true) throw new Error('Telegram response is invalid');
}

export function createCommandSender(command, { environment = {} } = {}) {
  return async (payload) => {
    const info = await lstat(command);
    if (!path.isAbsolute(command)
      || !info.isFile()
      || info.isSymbolicLink()
      || (info.mode & 0o111) === 0
      || await realpath(command) !== command) throw new Error('send command is not a canonical executable');
    await new Promise((resolve, reject) => {
      const child = spawn(command, [], {
        stdio: ['pipe', 'ignore', 'ignore'],
        env: { PATH: process.env.PATH || '/usr/bin:/bin', ...environment },
      });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        if (code === 0 && !signal) resolve();
        else reject(new Error('send command failed'));
      });
      child.stdin.end(`${JSON.stringify(payload)}\n`);
    });
  };
}

export async function runOcrMonitorAlert(config, dependencies = {}) {
  const stateDir = await requireStateDirectory(config.stateDir);
  const nowMilliseconds = dependencies.nowMilliseconds ?? Date.now();
  const sendAlert = config.mode === 'alert'
    ? (dependencies.sendAlert
      || (config.sendCommand
        ? createCommandSender(config.sendCommand)
        : (payload) => sendTelegram(config, payload, dependencies.fetch || fetch)))
    : null;
  if (sendAlert) {
    const retried = await retryPendingDelivery(
      config,
      nowMilliseconds,
      stateDir,
      sendAlert,
    );
    if (retried) return retried;
  }
  const runtime = dependencies.runtime || await defaultRuntimeEvidence(config);
  runtime.monitor.invocation_id = normalizeInvocationId(runtime.monitor.invocation_id, 'monitor InvocationID');
  if (!Number.isSafeInteger(runtime.monitor.exit_code) || runtime.monitor.exit_code < 0) {
    throw new Error('monitor exit code is invalid');
  }
  if (config.mode === 'observe') {
    runtime.worker.invocation_id = normalizeInvocationId(
      runtime.worker?.invocation_id,
      'worker InvocationID',
    );
    const binding = makeBinding(config, runtime);
    await verifyMonitorScript(config);
    return observeSuccessfulMonitor(config, runtime, binding, nowMilliseconds, stateDir);
  }
  const liveWorkerInvocationId = String(runtime.worker?.invocation_id || '').trim();
  let binding;
  if (liveWorkerInvocationId) {
    runtime.worker.invocation_id = normalizeInvocationId(
      liveWorkerInvocationId,
      'worker InvocationID',
    );
    binding = makeBinding(config, runtime);
  } else {
    binding = await recoverBindingFromArmedReceipt(config, runtime, stateDir);
  }
  return alertFailedMonitor(config, runtime, binding, nowMilliseconds, stateDir, sendAlert);
}

export function parseAlertArgs(argv) {
  const values = { maxLatestAgeSeconds: 300 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      index += 1;
      return value;
    };
    if (argument === '--mode') values.mode = next();
    else if (argument === '--state-dir') values.stateDir = path.resolve(next());
    else if (argument === '--latest-json') values.latestJson = path.resolve(next());
    else if (argument === '--expected-run-id') values.expectedRunId = next();
    else if (argument === '--monitor-unit') values.monitorUnit = next();
    else if (argument === '--worker-unit') values.workerUnit = next();
    else if (argument === '--monitor-script') values.monitorScript = path.resolve(next());
    else if (argument === '--monitor-sha256') values.monitorSha256 = next();
    else if (argument === '--max-latest-age-seconds') values.maxLatestAgeSeconds = Number(next());
    else if (argument === '--credential-file') values.credentialFile = path.resolve(next());
    else if (argument === '--send-command') values.sendCommand = path.resolve(next());
    else if (argument === '--help') values.help = true;
    else throw new Error(`unexpected argument: ${argument}`);
  }
  if (values.help) return values;
  if (!['observe', 'alert'].includes(values.mode)) throw new Error('--mode must be observe or alert');
  if (!values.stateDir || !values.latestJson || !values.monitorScript) throw new Error('state latest and monitor paths are required');
  if (!runIdPattern.test(values.expectedRunId || '')) throw new Error('--expected-run-id is invalid');
  if (!unitPattern.test(values.monitorUnit || '') || !unitPattern.test(values.workerUnit || '')) {
    throw new Error('monitor and worker units are required and must be .service units');
  }
  if (!sha256Pattern.test(values.monitorSha256 || '')) throw new Error('--monitor-sha256 is invalid');
  if (!Number.isSafeInteger(values.maxLatestAgeSeconds)
    || values.maxLatestAgeSeconds < 30
    || values.maxLatestAgeSeconds > 900) throw new Error('--max-latest-age-seconds must be 30..900');
  if (!disjoint(values.stateDir, path.dirname(values.latestJson))) {
    throw new Error('state directory must be external to monitor output');
  }
  if (values.mode === 'observe' && (values.credentialFile || values.sendCommand)) {
    throw new Error('observe mode never accepts a sender');
  }
  if (values.mode === 'alert' && Boolean(values.credentialFile) === Boolean(values.sendCommand)) {
    throw new Error('alert mode requires exactly one credential file or send command');
  }
  if (values.credentialFile && values.credentialFile !== credentialPath) {
    throw new Error('--credential-file must use the dedicated BDFZ OCR path');
  }
  return values;
}

function usage() {
  return [
    'Usage: node scripts/notify-remote-ocr-single-shard-monitor.mjs --mode observe|alert',
    '  --state-dir DIR --latest-json FILE --expected-run-id ID',
    '  --monitor-unit UNIT.service --worker-unit UNIT.service',
    '  --monitor-script FILE --monitor-sha256 SHA256',
    '  [--credential-file ~/.config/bdfz/curriculum-ocr-monitor-telegram.env]',
    '',
    'Two distinct healthy exit-10 monitor invocations arm alerting for one exact',
    'run, boot, worker unit/InvocationID, and monitor SHA-256. Exit 0/10 never alerts.',
    'Exit 12 alerts only when armed. Precheck or stale evidence is reported only',
    'as MONITOR_EXECUTION_FAILED. Delivery is at-least-once: retry may duplicate',
    'a provider-accepted message, so every message exposes a stable fingerprint.',
    'This notifier never stops or restarts OCR.',
  ].join('\n');
}

async function main() {
  const config = parseAlertArgs(process.argv.slice(2));
  if (config.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await runOcrMonitorAlert(config);
  process.stdout.write(`${JSON.stringify({ state: result.state, sent: result.sent })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`OCR monitor notifier failed closed: ${error.name || 'Error'}\n`);
    process.exitCode = 75;
  });
}
