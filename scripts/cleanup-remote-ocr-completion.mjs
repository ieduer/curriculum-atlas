#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { constants } from 'node:fs';
import {
  lstat,
  open,
  realpath,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const systemctlPath = '/usr/bin/systemctl';
const maxRunStatusBytes = 16 * 1024 * 1024;
const allowedDocumentStatuses = Object.freeze([
  'pending',
  'running',
  'retry_wait',
  'complete',
  'failed',
  'interrupted',
  'quarantined',
]);
const countKeys = Object.freeze([
  'total',
  'complete',
  'failed',
  'interrupted',
  'pending',
  'running',
  'retry_wait',
  'quarantined',
]);
const systemdProperties = Object.freeze([
  'LoadState',
  'UnitFileState',
  'ActiveState',
  'SubState',
  'ExecMainCode',
  'ExecMainStatus',
  'Result',
  'MainPID',
  'InvocationID',
  'NRestarts',
  'ExecMainStartTimestampMonotonic',
  'ExecMainExitTimestampMonotonic',
]);

function requireUnitName(value, label) {
  if (typeof value !== 'string'
    || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9@_.-]*\.service$/u.test(value)) {
    throw new Error(`${label} must be a safe explicit .service unit name`);
  }
  return value;
}

export function parseCleanupArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const values = {};
  const accepted = new Map([
    ['--output-root', 'outputRoot'],
    ['--worker-unit', 'workerUnit'],
    ['--llama-unit', 'llamaUnit'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = accepted.get(argument);
    if (!key) throw new Error(`unexpected argument: ${argument}`);
    if (values[key] !== undefined) throw new Error(`${argument} may be specified only once`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    values[key] = value;
    index += 1;
  }
  for (const [argument, key] of accepted) {
    if (values[key] === undefined) throw new Error(`${argument} is required`);
  }
  if (!path.isAbsolute(values.outputRoot) || path.normalize(values.outputRoot) !== values.outputRoot) {
    throw new Error('--output-root must be an absolute normalized path');
  }
  requireUnitName(values.workerUnit, '--worker-unit');
  requireUnitName(values.llamaUnit, '--llama-unit');
  if (values.workerUnit === values.llamaUnit) throw new Error('worker and llama units must differ');
  return values;
}

function statFingerprint(metadata) {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    uid: metadata.uid,
    gid: metadata.gid,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  };
}

function sameFingerprint(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

async function canonicalOwnedOutputRoot(outputRoot) {
  const resolved = path.resolve(outputRoot);
  if (resolved !== outputRoot) throw new Error('output root is not normalized');
  const before = await lstat(resolved, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error('output root must be a real directory');
  }
  if (before.uid !== BigInt(process.getuid())) throw new Error('output root is not owned by the current user');
  if ((before.mode & 0o022n) !== 0n) throw new Error('output root must not be group- or world-writable');
  const canonical = await realpath(resolved);
  if (canonical !== resolved) throw new Error('output root must be canonical and contain no symlink traversal');
  const after = await lstat(resolved, { bigint: true });
  if (!sameFingerprint(statFingerprint(before), statFingerprint(after))) {
    throw new Error('output root changed while it was validated');
  }
  return { path: canonical, fingerprint: statFingerprint(after) };
}

async function readOwnedStableFile(pathname, label, maxBytes) {
  let handle;
  try {
    handle = await open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error(`${label} must not be a symlink`);
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
    if (before.uid !== BigInt(process.getuid())) throw new Error(`${label} is not owned by the current user`);
    if ((before.mode & 0o777n) !== 0o600n) throw new Error(`${label} mode must be exactly 0600`);
    if (before.nlink !== 1n) throw new Error(`${label} must have exactly one hard link`);
    if (before.size < 1n || before.size > BigInt(maxBytes)) throw new Error(`${label} size is invalid`);
    const raw = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const beforeFingerprint = statFingerprint(before);
    const afterFingerprint = statFingerprint(after);
    if (!sameFingerprint(beforeFingerprint, afterFingerprint) || BigInt(raw.length) !== after.size) {
      throw new Error(`${label} changed while it was read`);
    }
    const pathnameMetadata = await lstat(pathname, { bigint: true });
    if (pathnameMetadata.isSymbolicLink()
      || !sameFingerprint(afterFingerprint, statFingerprint(pathnameMetadata))) {
      throw new Error(`${label} pathname changed while it was read`);
    }
    return { raw, fingerprint: afterFingerprint };
  } finally {
    await handle.close();
  }
}

function sha256(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

export async function readCompletionStatus(outputRoot) {
  const root = await canonicalOwnedOutputRoot(outputRoot);
  const statusPath = path.join(root.path, 'run-status.json');
  const sidecarPath = `${statusPath}.sha256`;
  const status = await readOwnedStableFile(statusPath, 'run-status.json', maxRunStatusBytes);
  const sidecar = await readOwnedStableFile(sidecarPath, 'run-status.json SHA-256 sidecar', 256);
  const sidecarText = sidecar.raw.toString('utf8');
  const match = /^([a-f0-9]{64})  run-status\.json\n$/u.exec(sidecarText);
  if (!match) throw new Error('run-status.json SHA-256 sidecar must bind the exact basename');
  if (sha256(status.raw) !== match[1]) throw new Error('run-status.json SHA-256 sidecar mismatch');
  const rootAfter = await canonicalOwnedOutputRoot(outputRoot);
  if (!sameFingerprint(root.fingerprint, rootAfter.fingerprint)) {
    throw new Error('output root changed while run-status.json was read');
  }
  let value;
  try {
    value = JSON.parse(status.raw.toString('utf8'));
  } catch {
    throw new Error('run-status.json is not valid JSON');
  }
  return {
    value,
    raw: status.raw,
    sha256: match[1],
    rootFingerprint: root.fingerprint,
    statusFingerprint: status.fingerprint,
    sidecarFingerprint: sidecar.fingerprint,
  };
}

function requireSafeDocumentId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error('run status contains an unsafe document id');
  }
}

export function validateCompletionStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('run status must be an object');
  }
  if (value.schema_version !== 1) throw new Error('run status schema_version must equal 1');
  if (value.citation_allowed !== false) throw new Error('run status citation_allowed must equal false');
  if (typeof value.manifest_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.manifest_sha256)) {
    throw new Error('run status manifest SHA-256 is invalid');
  }
  if (typeof value.runtime_fingerprint_sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.runtime_fingerprint_sha256)) {
    throw new Error('run status runtime fingerprint SHA-256 is invalid');
  }
  if (!value.documents || typeof value.documents !== 'object' || Array.isArray(value.documents)) {
    throw new Error('run status documents must be an object');
  }
  const documents = Object.entries(value.documents);
  if (documents.length === 0) throw new Error('run status must contain at least one document');
  const actual = Object.fromEntries(allowedDocumentStatuses.map((status) => [status, 0]));
  for (const [documentId, document] of documents) {
    requireSafeDocumentId(documentId);
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      throw new Error(`run status document ${documentId} must be an object`);
    }
    if (!allowedDocumentStatuses.includes(document.status)) {
      throw new Error(`run status document ${documentId} has an invalid status`);
    }
    actual[document.status] += 1;
  }
  if (!value.counts || typeof value.counts !== 'object' || Array.isArray(value.counts)) {
    throw new Error('run status counts must be an object');
  }
  const declaredKeys = Object.keys(value.counts).sort();
  const expectedKeys = [...countKeys].sort();
  if (JSON.stringify(declaredKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error('run status counts must contain exactly the canonical keys');
  }
  for (const key of countKeys) {
    if (!Number.isSafeInteger(value.counts[key]) || value.counts[key] < 0) {
      throw new Error(`run status count ${key} is invalid`);
    }
  }
  if (value.counts.total !== documents.length) throw new Error('run status total differs from documents');
  for (const status of allowedDocumentStatuses) {
    if (value.counts[status] !== actual[status]) {
      throw new Error(`run status ${status} count differs from documents`);
    }
  }
  const expectedFinished = actual.complete === documents.length;
  const expectedSettled = actual.complete + actual.quarantined === documents.length;
  if (value.finished !== expectedFinished) throw new Error('run status finished flag contradicts documents');
  if (value.settled !== expectedSettled) throw new Error('run status settled flag contradicts documents');
  const complete = value.finished === true
    && value.settled === true
    && value.counts.total === value.counts.complete
    && value.counts.complete > 0
    && countKeys.filter((key) => !['total', 'complete'].includes(key))
      .every((key) => value.counts[key] === 0)
    && documents.every(([, document]) => document.status === 'complete');
  return { complete, documents: documents.length, counts: { ...value.counts } };
}

export function parseSystemdShow(raw) {
  const fields = new Map();
  for (const line of String(raw).split('\n')) {
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('systemd show output is malformed');
    const key = line.slice(0, separator);
    if (fields.has(key)) throw new Error(`systemd show output repeats ${key}`);
    fields.set(key, line.slice(separator + 1));
  }
  for (const property of systemdProperties) {
    if (!fields.has(property)) throw new Error(`systemd show output lacks ${property}`);
  }
  if (fields.get('LoadState') !== 'loaded') throw new Error('systemd unit is not loaded');
  for (const property of ['UnitFileState', 'ActiveState', 'SubState', 'Result']) {
    if (!/^[A-Za-z0-9_-]*$/u.test(fields.get(property))) {
      throw new Error(`systemd ${property} is malformed`);
    }
  }
  const invocationId = fields.get('InvocationID');
  if (invocationId && !/^[a-f0-9]{32}$/u.test(invocationId)) {
    throw new Error('systemd InvocationID is malformed');
  }
  const numeric = {};
  for (const property of [
    'ExecMainCode',
    'ExecMainStatus',
    'MainPID',
    'NRestarts',
    'ExecMainStartTimestampMonotonic',
    'ExecMainExitTimestampMonotonic',
  ]) {
    const rawValue = fields.get(property);
    if (!/^(?:0|[1-9]\d*)$/u.test(rawValue)) throw new Error(`systemd ${property} is invalid`);
    const value = Number(rawValue);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`systemd ${property} is invalid`);
    numeric[property] = value;
  }
  return {
    load_state: fields.get('LoadState'),
    unit_file_state: fields.get('UnitFileState'),
    active_state: fields.get('ActiveState'),
    sub_state: fields.get('SubState'),
    exec_main_code: numeric.ExecMainCode,
    exec_main_status: numeric.ExecMainStatus,
    result: fields.get('Result'),
    main_pid: numeric.MainPID,
    invocation_id: invocationId,
    n_restarts: numeric.NRestarts,
    exec_main_start_monotonic: numeric.ExecMainStartTimestampMonotonic,
    exec_main_exit_monotonic: numeric.ExecMainExitTimestampMonotonic,
  };
}

export async function probeSystemdUnit(unit, runExecFile = execFile) {
  const { stdout } = await runExecFile(systemctlPath, [
    '--user',
    'show',
    unit,
    '--no-pager',
    ...systemdProperties.map((property) => `--property=${property}`),
  ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
  return parseSystemdShow(stdout);
}

function isTerminalWorkerSuccess(status) {
  return status.active_state === 'inactive'
    && status.sub_state === 'dead'
    // systemd exposes the siginfo CLD_EXITED value as numeric 1 on the target.
    && status.exec_main_code === 1
    && status.exec_main_status === 0
    && status.result === 'success'
    && status.main_pid === 0
    && /^[a-f0-9]{32}$/u.test(status.invocation_id);
}

function sameExecution(left, right, { includeUnitFileState = true } = {}) {
  const keys = [
    'load_state',
    'active_state',
    'sub_state',
    'exec_main_code',
    'exec_main_status',
    'result',
    'main_pid',
    'invocation_id',
    'n_restarts',
    'exec_main_start_monotonic',
    'exec_main_exit_monotonic',
  ];
  if (includeUnitFileState) keys.push('unit_file_state');
  return keys.every((key) => left[key] === right[key]);
}

function sameStatusRecord(left, right) {
  return left.sha256 === right.sha256
    && left.raw.equals(right.raw)
    && sameFingerprint(left.rootFingerprint, right.rootFingerprint)
    && sameFingerprint(left.statusFingerprint, right.statusFingerprint)
    && sameFingerprint(left.sidecarFingerprint, right.sidecarFingerprint);
}

async function systemctlAction(action, unit, runExecFile) {
  await runExecFile(systemctlPath, ['--user', action, unit], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
}

function skip(reason) {
  return { exitCode: 10, state: 'skipped', reason };
}

export async function runCompletionCleanup(options, dependencies = {}) {
  const runExecFile = dependencies.runExecFile || execFile;
  const readStatus = dependencies.readStatus || readCompletionStatus;
  const probeUnit = dependencies.probeUnit
    || ((unit) => probeSystemdUnit(unit, runExecFile));
  await canonicalOwnedOutputRoot(options.outputRoot);

  const initialWorker = await probeUnit(options.workerUnit);
  if (initialWorker.active_state !== 'inactive' || initialWorker.sub_state !== 'dead') {
    return skip(`worker is ${initialWorker.active_state}/${initialWorker.sub_state}`);
  }

  const initialStatus = await readStatus(options.outputRoot);
  const completion = validateCompletionStatus(initialStatus.value);
  if (!isTerminalWorkerSuccess(initialWorker)) return skip('worker did not end with terminal success');
  if (!completion.complete) return skip('run status is valid but incomplete');

  const revalidatedStatus = await readStatus(options.outputRoot);
  const revalidatedCompletion = validateCompletionStatus(revalidatedStatus.value);
  if (!revalidatedCompletion.complete || !sameStatusRecord(initialStatus, revalidatedStatus)) {
    throw new Error('run status changed during completion cleanup validation');
  }
  const revalidatedWorker = await probeUnit(options.workerUnit);
  if (!isTerminalWorkerSuccess(revalidatedWorker)
    || !sameExecution(initialWorker, revalidatedWorker)) {
    throw new Error('worker execution changed during completion cleanup validation');
  }

  await systemctlAction('disable', options.workerUnit, runExecFile);
  const disabledWorker = await probeUnit(options.workerUnit);
  if (!isTerminalWorkerSuccess(disabledWorker)
    || !sameExecution(revalidatedWorker, disabledWorker, { includeUnitFileState: false })
    || disabledWorker.unit_file_state !== 'disabled') {
    throw new Error('worker did not remain terminal and disabled');
  }

  await systemctlAction('stop', options.llamaUnit, runExecFile);
  const [finalWorker, finalLlama] = await Promise.all([
    probeUnit(options.workerUnit),
    probeUnit(options.llamaUnit),
  ]);
  if (!isTerminalWorkerSuccess(finalWorker)
    || !sameExecution(disabledWorker, finalWorker)
    || finalWorker.unit_file_state !== 'disabled') {
    throw new Error('worker changed after llama shutdown');
  }
  if (finalLlama.active_state !== 'inactive'
    || finalLlama.sub_state !== 'dead'
    || finalLlama.main_pid !== 0) {
    throw new Error('llama unit did not become inactive/dead');
  }
  return {
    exitCode: 0,
    state: 'cleaned',
    documents: completion.documents,
    run_status_sha256: initialStatus.sha256,
    worker_unit: options.workerUnit,
    llama_unit: options.llamaUnit,
  };
}

function usage() {
  return [
    'Usage: node scripts/cleanup-remote-ocr-completion.mjs \\',
    '  --output-root DIR --worker-unit UNIT.service --llama-unit UNIT.service',
    '',
    'Exit 0 means a verified completed worker was disabled and llama was stopped.',
    'Exit 10 means a valid incomplete, manually stopped, or non-terminal worker was skipped.',
    'All integrity, TOCTOU, and systemd command failures exit nonzero.',
  ].join('\n');
}

async function main() {
  const options = parseCleanupArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await runCompletionCleanup(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`B3 completion cleanup failed closed: ${error.message}\n`);
    process.exitCode = 2;
  });
}
