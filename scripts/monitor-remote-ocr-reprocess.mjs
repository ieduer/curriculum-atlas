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

const execFile = promisify(execFileCallback);
const gib = 1024 ** 3;
const allowedDocumentStatuses = new Set([
  'pending',
  'running',
  'retry_wait',
  'complete',
  'failed',
  'interrupted',
  'quarantined',
]);
const defaultThresholds = Object.freeze({
  stall_seconds: 600,
  disk_min_gib: 50,
  gpu_max_c: 85,
  memory_min_gib: 1,
  cpu_warning_c: 97,
  cpu_critical_c: 99,
});

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const iso = (milliseconds) => new Date(milliseconds).toISOString();

function requireFiniteNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be numeric`);
  return parsed;
}

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function parsePair(value, label) {
  const separator = value.indexOf('=');
  if (separator < 1 || separator === value.length - 1) {
    throw new Error(`${label} must use LABEL=VALUE`);
  }
  return [value.slice(0, separator), value.slice(separator + 1)];
}

export function parseMonitorArgs(argv) {
  const values = {
    shardOutputs: new Map(),
    workerUnits: new Map(),
    pausedShards: new Set(),
    llamaUnit: 'curriculum-ocr-llama.service',
    llamaHealthUrl: 'http://127.0.0.1:8112/health',
    thresholds: { ...defaultThresholds },
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      index += 1;
      return value;
    };
    if (argument === '--run-root') values.runRoot = path.resolve(next());
    else if (argument === '--output-dir') values.outputDir = path.resolve(next());
    else if (argument === '--shard-output') {
      const [label, relativePath] = parsePair(next(), '--shard-output');
      values.shardOutputs.set(label, relativePath);
    } else if (argument === '--worker-unit') {
      const [label, unit] = parsePair(next(), '--worker-unit');
      values.workerUnits.set(label, unit);
    } else if (argument === '--paused-shard') {
      values.pausedShards.add(next());
    } else if (argument === '--llama-unit') values.llamaUnit = next();
    else if (argument === '--llama-health-url') values.llamaHealthUrl = next();
    else if (argument === '--stall-seconds') {
      values.thresholds.stall_seconds = requirePositiveInteger(next(), '--stall-seconds');
    } else if (argument === '--disk-min-gib') {
      values.thresholds.disk_min_gib = requireFiniteNumber(next(), '--disk-min-gib');
    } else if (argument === '--gpu-max-c') {
      values.thresholds.gpu_max_c = requireFiniteNumber(next(), '--gpu-max-c');
    } else if (argument === '--memory-min-gib') {
      values.thresholds.memory_min_gib = requireFiniteNumber(next(), '--memory-min-gib');
    } else if (argument === '--cpu-warning-c') {
      values.thresholds.cpu_warning_c = requireFiniteNumber(next(), '--cpu-warning-c');
    } else if (argument === '--cpu-critical-c') {
      values.thresholds.cpu_critical_c = requireFiniteNumber(next(), '--cpu-critical-c');
    } else if (argument === '--help') {
      values.help = true;
    } else {
      throw new Error(`unexpected argument: ${argument}`);
    }
  }

  if (values.help) return values;
  if (!values.runRoot) throw new Error('--run-root is required');
  if (!values.outputDir) throw new Error('--output-dir is required');
  if (!inside(values.runRoot, values.outputDir)) throw new Error('--output-dir must be inside --run-root');
  if (!/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9/_-]*$/u.test(values.llamaHealthUrl)) {
    throw new Error('--llama-health-url must be an explicit 127.0.0.1 HTTP endpoint');
  }
  if (!/^[A-Za-z0-9@_.-]+\.service$/u.test(values.llamaUnit)) {
    throw new Error('--llama-unit is invalid');
  }

  for (const label of ['a', 'b']) {
    const relativeOutput = values.shardOutputs.get(label);
    const workerUnit = values.workerUnits.get(label);
    if (!relativeOutput) throw new Error(`--shard-output ${label}=... is required`);
    if (path.isAbsolute(relativeOutput)) throw new Error(`shard ${label} output must be relative to --run-root`);
    const outputRoot = path.resolve(values.runRoot, relativeOutput);
    if (!inside(values.runRoot, outputRoot)) throw new Error(`shard ${label} output escapes --run-root`);
    if (!workerUnit || !/^[A-Za-z0-9@_.-]+\.service$/u.test(workerUnit)) {
      throw new Error(`worker unit for shard ${label} is invalid`);
    }
  }
  if ([...values.shardOutputs.keys()].some((label) => !['a', 'b'].includes(label))) {
    throw new Error('only shard labels a and b are allowed');
  }
  if ([...values.workerUnits.keys()].some((label) => !['a', 'b'].includes(label))) {
    throw new Error('only worker labels a and b are allowed');
  }
  if ([...values.pausedShards].some((label) => !['a', 'b'].includes(label))) {
    throw new Error('only shard labels a and b may be paused');
  }
  for (const [key, value] of Object.entries(values.thresholds)) {
    if (!(value > 0)) throw new Error(`${key} must be greater than zero`);
  }
  if (values.thresholds.cpu_critical_c <= values.thresholds.cpu_warning_c) {
    throw new Error('cpu_critical_c must be greater than cpu_warning_c');
  }
  return values;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function regularFile(pathname, label) {
  const metadata = await lstat(pathname);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${label} is not a regular file`);
  return metadata;
}

async function readStableJson(pathname, label, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const before = await regularFile(pathname, label);
      const raw = await readFile(pathname);
      const after = await stat(pathname);
      if (
        before.dev !== after.dev
        || before.ino !== after.ino
        || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs
      ) {
        throw new Error(`${label} changed while it was read`);
      }
      return { value: JSON.parse(raw.toString('utf8')), raw, metadata: after };
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(100);
    }
  }
  throw lastError;
}

async function readHashBoundJson(pathname, label) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const [body, sidecar] = await Promise.all([
        readStableJson(pathname, label, 1),
        readStableJsonText(`${pathname}.sha256`, `${label} SHA-256 sidecar`, 1),
      ]);
      const match = /^([a-f0-9]{64})  ([^\r\n]+)\n$/u.exec(sidecar.raw);
      if (!match || match[2] !== path.basename(pathname)) throw new Error(`${label} SHA-256 sidecar format is invalid`);
      const digest = sha256(body.raw);
      if (digest !== match[1]) throw new Error(`${label} SHA-256 sidecar mismatch`);
      return { ...body, sha256: digest };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(100);
    }
  }
  throw lastError;
}

async function readStableJsonText(pathname, label, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const before = await regularFile(pathname, label);
      const raw = await readFile(pathname, 'utf8');
      const after = await stat(pathname);
      if (
        before.dev !== after.dev
        || before.ino !== after.ino
        || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs
      ) {
        throw new Error(`${label} changed while it was read`);
      }
      return { raw, metadata: after };
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(100);
    }
  }
  throw lastError;
}

function pageSet(value, pageCount, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const result = new Set();
  for (const page of value) {
    if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) {
      throw new Error(`${label} contains an invalid page`);
    }
    if (result.has(page)) throw new Error(`${label} contains a duplicate page`);
    result.add(page);
  }
  return result;
}

function failedPageSet(value, pageCount, label) {
  if (value === undefined) return new Set();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const result = new Set();
  for (const key of Object.keys(value)) {
    if (!/^[1-9]\d*$/u.test(key)) throw new Error(`${label} contains an invalid page key`);
    const page = Number(key);
    if (page > pageCount || result.has(page)) throw new Error(`${label} contains an invalid page`);
    result.add(page);
  }
  return result;
}

function requireDocumentId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error('run status contains an unsafe document id');
  }
  return value;
}

function requireRunStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('run status must be an object');
  if (value.schema_version !== 1) throw new Error('run status schema_version must equal 1');
  if (value.citation_allowed !== false) throw new Error('run status citation_allowed must equal false');
  if (typeof value.manifest_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.manifest_sha256)) {
    throw new Error('run status manifest SHA-256 is invalid');
  }
  if (!value.documents || typeof value.documents !== 'object' || Array.isArray(value.documents)) {
    throw new Error('run status documents must be an object');
  }
  const entries = Object.entries(value.documents);
  if (entries.length === 0) throw new Error('run status has no documents');
  for (const [documentId, document] of entries) {
    requireDocumentId(documentId);
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      throw new Error('run status document must be an object');
    }
    if (!allowedDocumentStatuses.has(document.status)) throw new Error('run status document has an invalid status');
    requirePositiveInteger(document.page_count, 'run status page_count');
    if (!Number.isSafeInteger(document.attempts) || document.attempts < 0 || document.attempts > 5) {
      throw new Error('run status document attempts are invalid');
    }
  }
  return entries;
}

export async function collectShardSnapshot({
  label,
  runRoot,
  outputRoot,
  nowMilliseconds = Date.now(),
}) {
  const canonicalRunRoot = await realpath(runRoot);
  const canonicalOutputRoot = await realpath(outputRoot);
  if (!inside(canonicalRunRoot, canonicalOutputRoot)) throw new Error(`shard ${label} output escapes run root`);

  const runStatusPath = path.join(canonicalOutputRoot, 'run-status.json');
  const runStatusRecord = await readHashBoundJson(runStatusPath, `shard ${label} run status`);
  const entries = requireRunStatus(runStatusRecord.value);
  const statusCounts = Object.fromEntries([...allowedDocumentStatuses].map((status) => [status, 0]));
  let expectedPages = 0;
  let completedPages = 0;
  let failedPages = 0;
  let stateFiles = 0;
  let latestProgressMilliseconds = runStatusRecord.metadata.mtimeMs;

  for (const [documentId, document] of entries) {
    statusCounts[document.status] += 1;
    expectedPages += document.page_count;
    const statePath = path.join(canonicalOutputRoot, 'documents', documentId, 'state.json');
    let stateRecord;
    try {
      stateRecord = await readStableJson(statePath, `shard ${label} document state`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (document.status === 'complete') throw new Error(`shard ${label} complete document state is missing`);
      continue;
    }
    const canonicalStatePath = await realpath(statePath);
    if (!inside(canonicalOutputRoot, canonicalStatePath)) throw new Error(`shard ${label} state escapes output root`);
    const state = stateRecord.value;
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error(`shard ${label} state must be an object`);
    if (state.document_id !== documentId) throw new Error(`shard ${label} state document identity mismatch`);
    if (state.page_count !== undefined && state.page_count !== document.page_count) {
      throw new Error(`shard ${label} state page count mismatch`);
    }
    const completed = pageSet(state.completed_pages || [], document.page_count, `shard ${label} completed pages`);
    const failed = failedPageSet(state.failed_pages, document.page_count, `shard ${label} failed pages`);
    if ([...completed].some((page) => failed.has(page))) throw new Error(`shard ${label} page is both complete and failed`);
    if (document.status === 'complete') {
      if (completed.size !== document.page_count || failed.size !== 0 || state.selected_pages_complete !== true) {
        throw new Error(`shard ${label} complete document does not have complete page state`);
      }
    }
    completedPages += completed.size;
    failedPages += failed.size;
    stateFiles += 1;
    latestProgressMilliseconds = Math.max(latestProgressMilliseconds, stateRecord.metadata.mtimeMs);
  }

  const complete = statusCounts.complete === entries.length
    && completedPages === expectedPages
    && failedPages === 0;
  const inconsistentCompletion = runStatusRecord.value.finished === true && !complete;
  return {
    label,
    read_ok: true,
    run_status_sha256: runStatusRecord.sha256,
    manifest_sha256: runStatusRecord.value.manifest_sha256,
    documents: entries.length,
    state_files: stateFiles,
    expected_pages: expectedPages,
    completed_pages: completedPages,
    failed_pages: failedPages,
    status_counts: statusCounts,
    complete,
    inconsistent_completion: inconsistentCompletion,
    latest_progress_at: iso(latestProgressMilliseconds),
    progress_age_seconds: Math.max(0, Math.floor((nowMilliseconds - latestProgressMilliseconds) / 1000)),
  };
}

export function parseSystemdShow(raw) {
  const fields = {};
  for (const line of String(raw).split('\n')) {
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('systemd show output is malformed');
    fields[line.slice(0, separator)] = line.slice(separator + 1);
  }
  for (const required of ['LoadState', 'ActiveState', 'SubState', 'NRestarts', 'ExecMainStatus', 'MainPID', 'Result']) {
    if (!(required in fields)) throw new Error(`systemd show output lacks ${required}`);
  }
  if (fields.LoadState !== 'loaded') throw new Error('systemd unit is not loaded');
  const nRestarts = Number(fields.NRestarts);
  const execMainStatus = Number(fields.ExecMainStatus);
  const mainPid = Number(fields.MainPID);
  if (![nRestarts, execMainStatus, mainPid].every(Number.isSafeInteger) || nRestarts < 0 || mainPid < 0) {
    throw new Error('systemd numeric status is invalid');
  }
  return {
    active_state: fields.ActiveState,
    sub_state: fields.SubState,
    n_restarts: nRestarts,
    exec_main_status: execMainStatus,
    main_pid: mainPid,
    result: fields.Result,
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

export function parseMeminfo(raw) {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/mu.exec(String(raw));
  if (!match) throw new Error('MemAvailable is missing from /proc/meminfo');
  return Number(match[1]) * 1024;
}

export function parseNvidiaSmi(raw) {
  const devices = String(raw).trim().split('\n').filter(Boolean).map((line) => {
    const fields = line.split(',').map((value) => Number(value.trim()));
    if (fields.length !== 4 || fields.some((value) => !Number.isFinite(value))) {
      throw new Error('nvidia-smi output is malformed');
    }
    const [temperature, utilization, memoryUsed, memoryTotal] = fields;
    return {
      temperature_c: temperature,
      utilization_percent: utilization,
      memory_used_mib: memoryUsed,
      memory_total_mib: memoryTotal,
    };
  });
  if (devices.length === 0) throw new Error('nvidia-smi returned no devices');
  return {
    available: true,
    devices: devices.length,
    max_temperature_c: Math.max(...devices.map((device) => device.temperature_c)),
    max_utilization_percent: Math.max(...devices.map((device) => device.utilization_percent)),
    memory_used_mib: devices.reduce((total, device) => total + device.memory_used_mib, 0),
    memory_total_mib: devices.reduce((total, device) => total + device.memory_total_mib, 0),
  };
}

export function parseGpuThrottleReasons(raw) {
  const reasons = String(raw).trim().split('\n').filter(Boolean).map((value) => value.trim());
  if (reasons.length === 0) return null;
  if (reasons.some((value) => value.length > 64 || !/^[A-Za-z0-9 .:_-]+$/u.test(value))) {
    throw new Error('GPU throttle reason output is malformed');
  }
  return reasons;
}

async function probeGpu(runExecFile = execFile) {
  const { stdout } = await runExecFile('/usr/bin/nvidia-smi', [
    '--query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total',
    '--format=csv,noheader,nounits',
  ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
  const gpu = parseNvidiaSmi(stdout);
  for (const field of ['clocks_event_reasons.active', 'clocks_throttle_reasons.active']) {
    try {
      const result = await runExecFile('/usr/bin/nvidia-smi', [
        `--query-gpu=${field}`,
        '--format=csv,noheader,nounits',
      ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
      gpu.active_throttle_reasons = parseGpuThrottleReasons(result.stdout);
      gpu.active_throttle_reason_field = field;
      return gpu;
    } catch {
      // Driver generations expose one of the two field names. The reason is best-effort.
    }
  }
  gpu.active_throttle_reasons = null;
  gpu.active_throttle_reason_field = null;
  return gpu;
}

function temperatureInputs(value, pathParts = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const readings = [];
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...pathParts, key];
    if (/^temp\d+_input$/u.test(key) && typeof child === 'number' && Number.isFinite(child)) {
      readings.push({ path: nextPath, temperature_c: child });
    } else {
      readings.push(...temperatureInputs(child, nextPath));
    }
  }
  return readings;
}

export function parseSensorsJson(raw) {
  const value = JSON.parse(String(raw));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('sensors JSON must be an object');
  }
  const acceptedChip = /(coretemp|k10temp|zenpower|cpu[-_]?thermal|x86_pkg_temp|acpitz)/iu;
  const readings = temperatureInputs(value).filter(({ path: parts }) => acceptedChip.test(parts[0] || ''));
  if (readings.length === 0) throw new Error('sensors returned no CPU package, core, or ACPI thermal reading');
  return {
    available: true,
    source: 'sensors',
    readings: readings.length,
    max_temperature_c: Math.max(...readings.map((reading) => reading.temperature_c)),
  };
}

async function probeSysfsCpuThermal({
  listDirectory = readdir,
  read = readFile,
} = {}) {
  let entries;
  try {
    entries = await listDirectory('/sys/class/thermal', { withFileTypes: true });
  } catch {
    return { available: false, readings: 0, max_temperature_c: null };
  }
  const temperatures = [];
  for (const entry of entries) {
    if (!/^thermal_zone\d+$/u.test(entry.name)) continue;
    const zoneRoot = path.join('/sys/class/thermal', entry.name);
    try {
      const [typeRaw, temperatureRaw] = await Promise.all([
        read(path.join(zoneRoot, 'type'), 'utf8'),
        read(path.join(zoneRoot, 'temp'), 'utf8'),
      ]);
      const type = String(typeRaw).trim();
      if (!/(cpu|pkg|package|x86|acpi)/iu.test(type)) continue;
      const rawTemperature = Number(String(temperatureRaw).trim());
      if (!Number.isFinite(rawTemperature)) continue;
      const temperature = Math.abs(rawTemperature) > 1_000 ? rawTemperature / 1_000 : rawTemperature;
      if (temperature >= -20 && temperature <= 150) temperatures.push(temperature);
    } catch {
      // Individual thermal zones may disappear or be unreadable between directory and file reads.
    }
  }
  return temperatures.length === 0
    ? { available: false, readings: 0, max_temperature_c: null }
    : {
        available: true,
        readings: temperatures.length,
        max_temperature_c: Math.max(...temperatures),
      };
}

async function probeThermalThrottleCounters({
  listDirectory = readdir,
  read = readFile,
} = {}) {
  let cpuEntries;
  try {
    cpuEntries = await listDirectory('/sys/devices/system/cpu', { withFileTypes: true });
  } catch {
    return { available: false };
  }
  const values = { package_throttle_count: [], core_throttle_count: [] };
  let readableFiles = 0;
  for (const entry of cpuEntries) {
    if (!/^cpu\d+$/u.test(entry.name)) continue;
    for (const name of Object.keys(values)) {
      try {
        const raw = await read(path.join('/sys/devices/system/cpu', entry.name, 'thermal_throttle', name), 'utf8');
        const value = Number(String(raw).trim());
        if (!Number.isSafeInteger(value) || value < 0) continue;
        values[name].push(value);
        readableFiles += 1;
      } catch {
        // Counters are optional and architecture-dependent.
      }
    }
  }
  return readableFiles === 0
    ? { available: false }
    : {
        available: true,
        readable_files: readableFiles,
        package_throttle_count_max: values.package_throttle_count.length > 0
          ? Math.max(...values.package_throttle_count)
          : null,
        core_throttle_count_sum: values.core_throttle_count.length > 0
          ? values.core_throttle_count.reduce((total, value) => total + value, 0)
          : null,
      };
}

async function probeCpuThermal(runExecFile = execFile, dependencies = {}) {
  const { stdout } = await runExecFile('/usr/bin/sensors', ['-j'], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 512 * 1024,
  });
  const sensors = parseSensorsJson(stdout);
  const [sysfs, throttleCounters] = await Promise.all([
    probeSysfsCpuThermal(dependencies),
    probeThermalThrottleCounters(dependencies),
  ]);
  return {
    available: true,
    source: sysfs.available ? 'sensors+sysfs' : 'sensors',
    sensors_readings: sensors.readings,
    sysfs_readings: sysfs.readings,
    max_temperature_c: Math.max(
      sensors.max_temperature_c,
      sysfs.available ? sysfs.max_temperature_c : Number.NEGATIVE_INFINITY,
    ),
    throttle_counters: throttleCounters,
  };
}

async function readBoundedResponse(response, byteLimit = 64 * 1024) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > byteLimit) {
      await reader.cancel();
      throw new Error('llama health response exceeds limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((value) => Buffer.from(value))).toString('utf8');
}

async function probeLlamaHealth(url, runFetch = fetch) {
  try {
    const response = await runFetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    const raw = await readBoundedResponse(response);
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    return {
      healthy: response.status === 200 && (body?.status === 'ok' || body?.ok === true),
      http_status: response.status,
    };
  } catch {
    return { healthy: false, http_status: null };
  }
}

export async function collectResources(runRoot, {
  runExecFile = execFile,
  read = readFile,
  filesystemStat = statfs,
  listDirectory = readdir,
} = {}) {
  const probes = await Promise.allSettled([
    filesystemStat(runRoot, { bigint: true }),
    read('/proc/meminfo', 'utf8'),
    probeGpu(runExecFile),
    probeCpuThermal(runExecFile, { read, listDirectory }),
  ]);
  const errors = [];
  let disk = null;
  let memory = null;
  let gpu = { available: false };
  let cpuThermal = { available: false };

  if (probes[0].status === 'fulfilled') {
    const availableBytes = Number(probes[0].value.bavail * probes[0].value.bsize);
    if (Number.isSafeInteger(availableBytes) && availableBytes >= 0) {
      disk = {
        available_bytes: availableBytes,
        available_gib: Number((availableBytes / gib).toFixed(3)),
      };
    } else {
      errors.push('DISK_PROBE_FAILED');
    }
  } else {
    errors.push('DISK_PROBE_FAILED');
  }
  if (probes[1].status === 'fulfilled') {
    try {
      const memoryAvailableBytes = parseMeminfo(probes[1].value);
      memory = {
        available_bytes: memoryAvailableBytes,
        available_gib: Number((memoryAvailableBytes / gib).toFixed(3)),
      };
    } catch {
      errors.push('MEMORY_PROBE_FAILED');
    }
  } else {
    errors.push('MEMORY_PROBE_FAILED');
  }
  if (probes[2].status === 'fulfilled') gpu = probes[2].value;
  else errors.push('GPU_PROBE_FAILED');
  if (probes[3].status === 'fulfilled') cpuThermal = probes[3].value;
  else errors.push('CPU_THERMAL_PROBE_FAILED');

  return {
    resources: {
      disk,
      memory,
      gpu,
      cpu_thermal: cpuThermal,
    },
    errors,
  };
}

function failedProbe(label) {
  return { label, read_ok: false, complete: false };
}

export async function collectMonitorSnapshot(config, dependencies = {}) {
  const nowMilliseconds = dependencies.nowMilliseconds ?? Date.now();
  const collectionErrors = [];
  const capture = async (code, action, fallback) => {
    try {
      return await action();
    } catch {
      collectionErrors.push(code);
      return fallback;
    }
  };
  const shardRoots = Object.fromEntries(['a', 'b'].map((label) => [
    label,
    path.resolve(config.runRoot, config.shardOutputs.get(label)),
  ]));
  const runExecFile = dependencies.execFile || execFile;
  const runFetch = dependencies.fetch || fetch;

  const [shardA, shardB, workerA, workerB, llamaSystemd, llamaHealth, resourceResult] = await Promise.all([
    capture('SHARD_A_READ_FAILED', () => collectShardSnapshot({
      label: 'a',
      runRoot: config.runRoot,
      outputRoot: shardRoots.a,
      nowMilliseconds,
    }), failedProbe('a')),
    capture('SHARD_B_READ_FAILED', () => collectShardSnapshot({
      label: 'b',
      runRoot: config.runRoot,
      outputRoot: shardRoots.b,
      nowMilliseconds,
    }), failedProbe('b')),
    capture('WORKER_A_SYSTEMD_PROBE_FAILED', () => probeSystemd(config.workerUnits.get('a'), runExecFile), null),
    capture('WORKER_B_SYSTEMD_PROBE_FAILED', () => probeSystemd(config.workerUnits.get('b'), runExecFile), null),
    capture('LLAMA_SYSTEMD_PROBE_FAILED', () => probeSystemd(config.llamaUnit, runExecFile), null),
    probeLlamaHealth(config.llamaHealthUrl, runFetch),
    collectResources(config.runRoot, {
      runExecFile,
      read: dependencies.readFile || readFile,
      filesystemStat: dependencies.statfs || statfs,
      listDirectory: dependencies.readdir || readdir,
    }),
  ]);
  collectionErrors.push(...resourceResult.errors);

  return {
    schema_version: 1,
    run_id: path.basename(config.runRoot),
    observed_at: iso(nowMilliseconds),
    paused_shards: [...config.pausedShards].sort(),
    thresholds: { ...config.thresholds },
    collection_errors: collectionErrors.sort(),
    shards: { a: shardA, b: shardB },
    services: {
      workers: { a: workerA, b: workerB },
      llama: {
        systemd: llamaSystemd,
        health: llamaHealth,
      },
    },
    resources: resourceResult.resources,
  };
}

function issue(code, severity = 'critical') {
  return { code, severity };
}

export function classifyMonitorSnapshot(snapshot) {
  const issues = snapshot.collection_errors.map((code) => issue(code));
  const thresholds = snapshot.thresholds || defaultThresholds;
  const shards = Object.values(snapshot.shards || {});
  const pausedShards = new Set(snapshot.paused_shards || []);

  for (const shard of shards) {
    const prefix = `SHARD_${String(shard.label || 'UNKNOWN').toUpperCase()}`;
    const paused = pausedShards.has(shard.label);
    if (!shard.read_ok) continue;
    if (shard.inconsistent_completion) issues.push(issue(`${prefix}_COMPLETION_INCONSISTENT`));
    if ((shard.status_counts?.failed || 0) > 0) issues.push(issue(`${prefix}_FAILED`));
    if ((shard.status_counts?.quarantined || 0) > 0) issues.push(issue(`${prefix}_QUARANTINED`));
    if (paused && !shard.complete) issues.push(issue(`${prefix}_OPERATOR_PAUSED`, 'warning'));
    if (!paused && (shard.status_counts?.interrupted || 0) > 0) issues.push(issue(`${prefix}_INTERRUPTED`));
    if ((shard.failed_pages || 0) > 0) issues.push(issue(`${prefix}_PAGE_FAILURE`));
    if (!paused && !shard.complete && shard.progress_age_seconds > thresholds.stall_seconds) {
      issues.push(issue(`${prefix}_NO_PROGRESS`, 'stalled'));
    }
  }

  for (const label of ['a', 'b']) {
    const shard = snapshot.shards?.[label];
    const service = snapshot.services?.workers?.[label];
    if (!service) continue;
    if (service.n_restarts > 0) issues.push(issue(`WORKER_${label.toUpperCase()}_RESTARTED`));
    if (pausedShards.has(label) && !shard?.complete) {
      if (service.active_state === 'active' || service.sub_state === 'running' || service.main_pid > 0) {
        issues.push(issue(`WORKER_${label.toUpperCase()}_ACTIVE_WHILE_PAUSED`));
      }
      if (service.exec_main_status !== 0) issues.push(issue(`WORKER_${label.toUpperCase()}_EXIT_STATUS`));
      continue;
    }
    if (!shard?.complete) {
      if (service.active_state !== 'active' || service.sub_state !== 'running' || service.main_pid < 1) {
        issues.push(issue(`WORKER_${label.toUpperCase()}_NOT_ACTIVE`));
      }
      if (service.exec_main_status !== 0) issues.push(issue(`WORKER_${label.toUpperCase()}_EXIT_STATUS`));
    } else if (service.active_state === 'failed' || service.exec_main_status !== 0) {
      issues.push(issue(`WORKER_${label.toUpperCase()}_COMPLETION_STATUS`));
    }
  }

  const llama = snapshot.services?.llama;
  if (llama?.systemd?.n_restarts > 0) issues.push(issue('LLAMA_RESTARTED'));
  const anyIncomplete = shards.some((shard) => !shard.complete && !pausedShards.has(shard.label));
  if (anyIncomplete) {
    if (
      !llama?.systemd
      || llama.systemd.active_state !== 'active'
      || llama.systemd.sub_state !== 'running'
      || llama.systemd.main_pid < 1
      || llama.systemd.exec_main_status !== 0
    ) {
      issues.push(issue('LLAMA_NOT_ACTIVE'));
    }
    if (!llama?.health?.healthy) issues.push(issue('LLAMA_HEALTH_FAILED'));
  }

  if (snapshot.resources) {
    if (snapshot.resources.disk?.available_gib < thresholds.disk_min_gib) issues.push(issue('DISK_BELOW_MINIMUM'));
    if (snapshot.resources.memory?.available_gib < thresholds.memory_min_gib) issues.push(issue('MEMORY_BELOW_MINIMUM'));
    if (snapshot.resources.gpu?.max_temperature_c > thresholds.gpu_max_c) issues.push(issue('GPU_OVER_TEMPERATURE'));
    if (snapshot.resources.cpu_thermal?.max_temperature_c >= thresholds.cpu_critical_c) {
      issues.push(issue('CPU_OVER_TEMPERATURE'));
    } else if (snapshot.resources.cpu_thermal?.max_temperature_c >= thresholds.cpu_warning_c) {
      issues.push(issue('CPU_TEMPERATURE_WARNING', 'warning'));
    }
  }

  const deduplicated = [...new Map(issues.map((value) => [value.code, value])).values()]
    .sort((left, right) => left.code.localeCompare(right.code));
  const allComplete = shards.length === 2 && shards.every((shard) => shard.complete);
  const hasCritical = deduplicated.some((value) => value.severity === 'critical');
  const hasStalled = deduplicated.some((value) => value.severity === 'stalled');
  return {
    state: deduplicated.length === 0
      ? allComplete ? 'completed' : 'healthy_running'
      : hasCritical ? 'blocked'
        : hasStalled ? 'stalled'
          : 'warning',
    exit_code: deduplicated.length === 0 ? 0 : hasCritical ? 12 : hasStalled ? 11 : 10,
    issues: deduplicated,
  };
}

export function privacySafeEvent(snapshot, health) {
  return {
    schema_version: 1,
    timestamp: snapshot.observed_at,
    run_id: snapshot.run_id,
    state: health.state,
    exit_code: health.exit_code,
    issue_codes: health.issues.map((value) => value.code),
    paused_shards: [...new Set(snapshot.paused_shards || [])].sort(),
    shards: Object.fromEntries(Object.entries(snapshot.shards).map(([label, shard]) => [label, {
      paused: (snapshot.paused_shards || []).includes(label),
      read_ok: shard.read_ok,
      complete: shard.complete,
      expected_pages: shard.expected_pages ?? null,
      completed_pages: shard.completed_pages ?? null,
      failed_pages: shard.failed_pages ?? null,
      status_counts: shard.status_counts ?? null,
      progress_age_seconds: shard.progress_age_seconds ?? null,
    }])),
    services: {
      workers: Object.fromEntries(Object.entries(snapshot.services.workers).map(([label, service]) => [label, service && {
        active_state: service.active_state,
        sub_state: service.sub_state,
        n_restarts: service.n_restarts,
        exec_main_status: service.exec_main_status,
      }])),
      llama: {
        active_state: snapshot.services.llama.systemd?.active_state ?? null,
        sub_state: snapshot.services.llama.systemd?.sub_state ?? null,
        n_restarts: snapshot.services.llama.systemd?.n_restarts ?? null,
        healthy: snapshot.services.llama.health.healthy,
        http_status: snapshot.services.llama.health.http_status,
      },
    },
    resources: snapshot.resources && {
      disk_available_gib: snapshot.resources.disk?.available_gib ?? null,
      memory_available_gib: snapshot.resources.memory?.available_gib ?? null,
      gpu_max_temperature_c: snapshot.resources.gpu?.max_temperature_c ?? null,
      gpu_max_utilization_percent: snapshot.resources.gpu?.max_utilization_percent ?? null,
      gpu_active_throttle_reasons: snapshot.resources.gpu?.active_throttle_reasons ?? null,
      cpu_max_temperature_c: snapshot.resources.cpu_thermal?.max_temperature_c ?? null,
      cpu_thermal_available: snapshot.resources.cpu_thermal?.available ?? false,
      cpu_throttle_counters: snapshot.resources.cpu_thermal?.throttle_counters ?? null,
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

export async function writeMonitorOutputs(outputDir, snapshot, health) {
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const outputMetadata = await lstat(outputDir);
  if (outputMetadata.isSymbolicLink() || !outputMetadata.isDirectory()) {
    throw new Error('monitor output directory is not a regular directory');
  }
  await chmod(outputDir, 0o700);
  const latest = {
    ...snapshot,
    health,
  };
  await atomicWrite(path.join(outputDir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
  const eventHandle = await open(path.join(outputDir, 'events.jsonl'), 'a', 0o600);
  try {
    await eventHandle.writeFile(`${JSON.stringify(privacySafeEvent(snapshot, health))}\n`, 'utf8');
    await eventHandle.sync();
  } finally {
    await eventHandle.close();
  }
  await chmod(path.join(outputDir, 'events.jsonl'), 0o600);
  return latest;
}

function usage() {
  return [
    'Usage: node scripts/monitor-remote-ocr-reprocess.mjs \\',
    '  --run-root DIR --output-dir DIR \\',
    '  --shard-output a=RELATIVE_DIR --shard-output b=RELATIVE_DIR \\',
    '  --worker-unit a=UNIT.service --worker-unit b=UNIT.service [options]',
    '',
    'Options:',
    '  --llama-unit UNIT.service       Default: curriculum-ocr-llama.service',
    '  --llama-health-url URL          Default: http://127.0.0.1:8112/health',
    '  --paused-shard LABEL             Explicit operator pause; repeat for a or b',
    '  --stall-seconds N               Default: 600',
    '  --disk-min-gib N                Default: 50',
    '  --gpu-max-c N                   Default: 85',
    '  --memory-min-gib N              Default: 1',
    '  --cpu-warning-c N               Default: 97 (nonzero warning)',
    '  --cpu-critical-c N              Default: 99 (fail-closed critical)',
    '',
    'The monitor is read-only with respect to OCR inputs and outputs. It writes only',
    'latest.json and privacy-safe events.jsonl under --output-dir and never restarts,',
    'deletes, retries, or quarantines OCR work.',
  ].join('\n');
}

async function main() {
  const config = parseMonitorArgs(process.argv.slice(2));
  if (config.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const snapshot = await collectMonitorSnapshot(config);
  const health = classifyMonitorSnapshot(snapshot);
  await writeMonitorOutputs(config.outputDir, snapshot, health);
  process.stdout.write(`${JSON.stringify({
    timestamp: snapshot.observed_at,
    run_id: snapshot.run_id,
    state: health.state,
    exit_code: health.exit_code,
    issue_codes: health.issues.map((value) => value.code),
    paused_shards: snapshot.paused_shards,
    completed_pages: Object.fromEntries(Object.entries(snapshot.shards).map(([label, shard]) => [
      label,
      shard.completed_pages ?? null,
    ])),
  })}\n`);
  process.exitCode = health.exit_code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`remote OCR monitor failed closed: ${error.name || 'Error'}\n`);
    process.exitCode = 12;
  });
}
