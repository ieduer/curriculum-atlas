import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  classifyMonitorSnapshot,
  collectResources,
  collectShardSnapshot,
  parseGpuThrottleReasons,
  parseMeminfo,
  parseMonitorArgs,
  parseNvidiaSmi,
  parseSensorsJson,
  parseSystemdShow,
  privacySafeEvent,
  writeMonitorOutputs,
} from '../scripts/monitor-remote-ocr-reprocess.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function service(overrides = {}) {
  return {
    active_state: 'active',
    sub_state: 'running',
    n_restarts: 0,
    exec_main_status: 0,
    main_pid: 123,
    result: 'success',
    ...overrides,
  };
}

function shard(label, overrides = {}) {
  return {
    label,
    read_ok: true,
    expected_pages: 100,
    completed_pages: 32,
    failed_pages: 0,
    status_counts: {
      pending: 0,
      running: 1,
      retry_wait: 0,
      complete: 0,
      failed: 0,
      interrupted: 0,
      quarantined: 0,
    },
    complete: false,
    inconsistent_completion: false,
    progress_age_seconds: 20,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  const base = {
    schema_version: 1,
    run_id: '20260716T1520Z-partial14-reprocess',
    observed_at: '2026-07-16T16:00:00.000Z',
    paused_shards: [],
    thresholds: {
      stall_seconds: 600,
      disk_min_gib: 50,
      gpu_max_c: 85,
      memory_min_gib: 1,
      cpu_warning_c: 97,
      cpu_critical_c: 99,
    },
    collection_errors: [],
    shards: {
      a: shard('a'),
      b: shard('b'),
    },
    services: {
      workers: {
        a: service(),
        b: service({ main_pid: 124 }),
      },
      llama: {
        systemd: service({ main_pid: 1104 }),
        health: { healthy: true, http_status: 200 },
      },
    },
    resources: {
      disk: { available_gib: 326 },
      memory: { available_gib: 6.2 },
      gpu: { max_temperature_c: 77, max_utilization_percent: 99 },
      cpu_thermal: {
        available: true,
        max_temperature_c: 96,
        throttle_counters: {
          available: true,
          package_throttle_count_max: 0,
          core_throttle_count_sum: 0,
        },
      },
    },
  };
  return {
    ...base,
    ...overrides,
    shards: overrides.shards || base.shards,
    services: overrides.services || base.services,
    resources: overrides.resources || base.resources,
  };
}

test('argument parser fixes the monitor to two contained shards and loopback llama health', () => {
  const parsed = parseMonitorArgs([
    '--run-root', '/home/suen/run',
    '--output-dir', '/home/suen/run/monitor',
    '--shard-output', 'a=output/a',
    '--shard-output', 'b=output/b',
    '--worker-unit', 'a=curriculum-ocr-reprocess@a.service',
    '--worker-unit', 'b=curriculum-ocr-reprocess@b.service',
  ]);
  assert.equal(parsed.shardOutputs.get('a'), 'output/a');
  assert.equal(parsed.thresholds.stall_seconds, 600);
  assert.deepEqual([...parsed.pausedShards], []);
  const paused = parseMonitorArgs([
    '--run-root', '/home/suen/run',
    '--output-dir', '/home/suen/run/monitor',
    '--shard-output', 'a=output/a',
    '--shard-output', 'b=output/b',
    '--worker-unit', 'a=curriculum-ocr-reprocess@a.service',
    '--worker-unit', 'b=curriculum-ocr-reprocess@b.service',
    '--paused-shard', 'b',
  ]);
  assert.deepEqual([...paused.pausedShards], ['b']);
  assert.throws(() => parseMonitorArgs([
    '--run-root', '/home/suen/run',
    '--output-dir', '/home/suen/outside',
    '--shard-output', 'a=output/a',
    '--shard-output', 'b=output/b',
    '--worker-unit', 'a=curriculum-ocr-reprocess@a.service',
    '--worker-unit', 'b=curriculum-ocr-reprocess@b.service',
  ]), /output-dir must be inside/);
  assert.throws(() => parseMonitorArgs([
    '--run-root', '/home/suen/run',
    '--output-dir', '/home/suen/run/monitor',
    '--shard-output', 'a=output/a',
    '--shard-output', 'b=output/b',
    '--worker-unit', 'a=curriculum-ocr-reprocess@a.service',
    '--worker-unit', 'b=curriculum-ocr-reprocess@b.service',
    '--paused-shard', 'c',
  ]), /only shard labels a and b may be paused/);
});

test('system and resource parsers reject incomplete telemetry', () => {
  const parsed = parseSystemdShow([
    'LoadState=loaded',
    'ActiveState=active',
    'SubState=running',
    'NRestarts=0',
    'ExecMainStatus=0',
    'MainPID=123',
    'Result=success',
    '',
  ].join('\n'));
  assert.equal(parsed.main_pid, 123);
  assert.equal(parseMeminfo('MemAvailable:       1048576 kB\n'), 1024 ** 3);
  assert.equal(parseNvidiaSmi('77, 99, 2686, 6144\n').max_temperature_c, 77);
  assert.deepEqual(parseGpuThrottleReasons('0x0000000000000000\n'), ['0x0000000000000000']);
  assert.equal(parseSensorsJson(JSON.stringify({
    'coretemp-isa-0000': {
      'Package id 0': { temp1_input: 96, temp1_crit: 100 },
      'Core 0': { temp2_input: 94 },
    },
    'acpitz-acpi-0': {
      temp1: { temp1_input: 96 },
    },
    'nvme-pci-0100': {
      Composite: { temp1_input: 71 },
    },
  })).max_temperature_c, 96);
  assert.throws(() => parseSystemdShow('ActiveState=active\n'), /lacks LoadState/);
  assert.throws(() => parseMeminfo('MemFree: 1 kB\n'), /MemAvailable/);
  assert.throws(() => parseNvidiaSmi('not available\n'), /malformed/);
  assert.throws(() => parseSensorsJson(JSON.stringify({
    'nvme-pci-0100': { Composite: { temp1_input: 71 } },
  })), /no CPU package/);
});

test('missing sensors is explicitly unavailable and fail-closed while other host telemetry survives', async () => {
  const runExecFile = async (executable, arguments_) => {
    if (executable.endsWith('nvidia-smi') && arguments_[0].includes('temperature.gpu')) {
      return { stdout: '77, 99, 2686, 6144\n' };
    }
    if (executable.endsWith('nvidia-smi')) return { stdout: '0x0000000000000000\n' };
    const error = new Error('missing');
    error.code = 'ENOENT';
    throw error;
  };
  const result = await collectResources('/unused', {
    runExecFile,
    read: async (pathname) => {
      if (pathname === '/proc/meminfo') return 'MemAvailable:       2097152 kB\n';
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    },
    filesystemStat: async () => ({ bavail: 100n, bsize: 1024n ** 3n }),
    listDirectory: async () => [],
  });
  assert.deepEqual(result.errors, ['CPU_THERMAL_PROBE_FAILED']);
  assert.equal(result.resources.cpu_thermal.available, false);
  assert.equal(result.resources.disk.available_gib, 100);
  assert.equal(result.resources.gpu.max_temperature_c, 77);
  const health = classifyMonitorSnapshot(snapshot({
    collection_errors: result.errors,
    resources: result.resources,
  }));
  assert.equal(health.exit_code, 12);
  assert.ok(health.issues.some((value) => value.code === 'CPU_THERMAL_PROBE_FAILED'));
});

test('healthy running and cleanly completed runs exit zero', () => {
  assert.deepEqual(classifyMonitorSnapshot(snapshot()), {
    state: 'healthy_running',
    exit_code: 0,
    issues: [],
  });

  const completedShardA = shard('a', {
    completed_pages: 100,
    status_counts: {
      pending: 0,
      running: 0,
      retry_wait: 0,
      complete: 1,
      failed: 0,
      interrupted: 0,
      quarantined: 0,
    },
    complete: true,
    progress_age_seconds: 5000,
  });
  const completedShardB = { ...completedShardA, label: 'b' };
  const completed = snapshot({
    shards: { a: completedShardA, b: completedShardB },
    services: {
      workers: {
        a: service({ active_state: 'inactive', sub_state: 'dead', main_pid: 0 }),
        b: service({ active_state: 'inactive', sub_state: 'dead', main_pid: 0 }),
      },
      llama: {
        systemd: service({ active_state: 'inactive', sub_state: 'dead', main_pid: 0 }),
        health: { healthy: false, http_status: null },
      },
    },
  });
  assert.deepEqual(classifyMonitorSnapshot(completed), {
    state: 'completed',
    exit_code: 0,
    issues: [],
  });
});

test('no-progress is a stalled nonzero result while recoverable retry_wait remains healthy', () => {
  const stalled = snapshot({
    shards: {
      a: shard('a', { progress_age_seconds: 601 }),
      b: shard('b', { progress_age_seconds: 601 }),
    },
  });
  const result = classifyMonitorSnapshot(stalled);
  assert.equal(result.state, 'stalled');
  assert.equal(result.exit_code, 11);
  assert.deepEqual(result.issues.map((value) => value.code), ['SHARD_A_NO_PROGRESS', 'SHARD_B_NO_PROGRESS']);

  const retrying = snapshot({
    shards: {
      a: shard('a', {
        progress_age_seconds: 30,
        status_counts: {
          pending: 0,
          running: 0,
          retry_wait: 1,
          complete: 0,
          failed: 0,
          interrupted: 0,
          quarantined: 0,
        },
      }),
      b: shard('b'),
    },
  });
  assert.equal(classifyMonitorSnapshot(retrying).exit_code, 0);
});

test('an explicit operator pause is a warning and still fails closed if the paused worker runs', () => {
  const pausedShardB = shard('b', {
    completed_pages: 64,
    status_counts: {
      pending: 4,
      running: 0,
      retry_wait: 0,
      complete: 1,
      failed: 0,
      interrupted: 1,
      quarantined: 0,
    },
    progress_age_seconds: 5000,
  });
  const paused = snapshot({
    paused_shards: ['b'],
    shards: { a: shard('a'), b: pausedShardB },
    services: {
      workers: {
        a: service(),
        b: service({ active_state: 'inactive', sub_state: 'dead', main_pid: 0 }),
      },
      llama: {
        systemd: service(),
        health: { healthy: true, http_status: 200 },
      },
    },
  });
  assert.deepEqual(classifyMonitorSnapshot(paused), {
    state: 'warning',
    exit_code: 10,
    issues: [{ code: 'SHARD_B_OPERATOR_PAUSED', severity: 'warning' }],
  });
  const event = privacySafeEvent(paused, classifyMonitorSnapshot(paused));
  assert.deepEqual(event.paused_shards, ['b']);
  assert.equal(event.shards.b.paused, true);

  const activeWhilePaused = {
    ...paused,
    services: {
      ...paused.services,
      workers: { ...paused.services.workers, b: service() },
    },
  };
  const activeHealth = classifyMonitorSnapshot(activeWhilePaused);
  assert.equal(activeHealth.state, 'blocked');
  assert.ok(activeHealth.issues.some((value) => value.code === 'WORKER_B_ACTIVE_WHILE_PAUSED'));
});

test('failure quarantine restart service llama and resource thresholds fail closed', () => {
  const cases = [
    ['failed document', snapshot({
      shards: { a: shard('a', { status_counts: { ...shard('a').status_counts, failed: 1, running: 0 } }), b: shard('b') },
    }), 'SHARD_A_FAILED'],
    ['quarantined document', snapshot({
      shards: { a: shard('a', { status_counts: { ...shard('a').status_counts, quarantined: 1, running: 0 } }), b: shard('b') },
    }), 'SHARD_A_QUARANTINED'],
    ['worker restart', snapshot({
      services: {
        workers: { a: service({ n_restarts: 1 }), b: service() },
        llama: { systemd: service(), health: { healthy: true, http_status: 200 } },
      },
    }), 'WORKER_A_RESTARTED'],
    ['worker inactive', snapshot({
      services: {
        workers: { a: service({ active_state: 'inactive', sub_state: 'dead', main_pid: 0 }), b: service() },
        llama: { systemd: service(), health: { healthy: true, http_status: 200 } },
      },
    }), 'WORKER_A_NOT_ACTIVE'],
    ['llama unhealthy', snapshot({
      services: {
        workers: { a: service(), b: service() },
        llama: { systemd: service(), health: { healthy: false, http_status: 503 } },
      },
    }), 'LLAMA_HEALTH_FAILED'],
    ['disk low', snapshot({
      resources: {
        disk: { available_gib: 49.999 },
        memory: { available_gib: 6.2 },
        gpu: { max_temperature_c: 77, max_utilization_percent: 99 },
        cpu_thermal: { available: true, max_temperature_c: 96 },
      },
    }), 'DISK_BELOW_MINIMUM'],
    ['memory low', snapshot({
      resources: {
        disk: { available_gib: 326 },
        memory: { available_gib: 0.999 },
        gpu: { max_temperature_c: 77, max_utilization_percent: 99 },
        cpu_thermal: { available: true, max_temperature_c: 96 },
      },
    }), 'MEMORY_BELOW_MINIMUM'],
    ['gpu hot', snapshot({
      resources: {
        disk: { available_gib: 326 },
        memory: { available_gib: 6.2 },
        gpu: { max_temperature_c: 85.001, max_utilization_percent: 99 },
        cpu_thermal: { available: true, max_temperature_c: 96 },
      },
    }), 'GPU_OVER_TEMPERATURE'],
    ['cpu critical', snapshot({
      resources: {
        disk: { available_gib: 326 },
        memory: { available_gib: 6.2 },
        gpu: { max_temperature_c: 77, max_utilization_percent: 99 },
        cpu_thermal: { available: true, max_temperature_c: 99 },
      },
    }), 'CPU_OVER_TEMPERATURE'],
  ];

  for (const [name, input, expectedCode] of cases) {
    const result = classifyMonitorSnapshot(input);
    assert.equal(result.exit_code, 12, name);
    assert.ok(result.issues.some((value) => value.code === expectedCode), name);
  }

  const exactThresholds = snapshot({
    resources: {
      disk: { available_gib: 50 },
      memory: { available_gib: 1 },
      gpu: { max_temperature_c: 85, max_utilization_percent: 100 },
      cpu_thermal: { available: true, max_temperature_c: 96.999 },
    },
  });
  assert.equal(classifyMonitorSnapshot(exactThresholds).exit_code, 0);

  const warning = classifyMonitorSnapshot(snapshot({
    resources: {
      disk: { available_gib: 326 },
      memory: { available_gib: 6.2 },
      gpu: { max_temperature_c: 77, max_utilization_percent: 99 },
      cpu_thermal: { available: true, max_temperature_c: 97 },
    },
  }));
  assert.equal(warning.state, 'warning');
  assert.equal(warning.exit_code, 10);
  assert.deepEqual(warning.issues.map((value) => value.code), ['CPU_TEMPERATURE_WARNING']);
});

test('a missing telemetry probe is fail-closed', () => {
  const result = classifyMonitorSnapshot(snapshot({
    collection_errors: ['SHARD_A_READ_FAILED', 'HOST_RESOURCE_PROBE_FAILED'],
    shards: { a: { label: 'a', read_ok: false, complete: false }, b: shard('b') },
    resources: null,
  }));
  assert.equal(result.exit_code, 12);
  assert.deepEqual(result.issues.map((value) => value.code), [
    'HOST_RESOURCE_PROBE_FAILED',
    'SHARD_A_READ_FAILED',
  ]);
});

test('shard snapshot verifies the run-status sidecar and aggregates state without exposing ids', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'remote-ocr-monitor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'output/a');
  await mkdir(path.join(output, 'documents/doc-one'), { recursive: true });
  const runStatus = {
    schema_version: 1,
    manifest_sha256: 'a'.repeat(64),
    citation_allowed: false,
    seed_lineage: {
      schema_version: 1,
      mode: 'hash_bound_output_seed',
      seed_id: 'b'.repeat(64),
      predecessor_run_identity_sha256: 'c'.repeat(64),
      citation_allowed: false,
    },
    documents: {
      'doc-one': {
        status: 'running',
        attempts: 1,
        inherited_attempts: 1,
        predecessor_status: 'interrupted',
        seed_id: 'b'.repeat(64),
        page_count: 4,
      },
    },
  };
  const rawStatus = `${JSON.stringify(runStatus, null, 2)}\n`;
  await writeFile(path.join(output, 'run-status.json'), rawStatus);
  await writeFile(path.join(output, 'run-status.json.sha256'), `${sha256(rawStatus)}  run-status.json\n`);
  await writeFile(path.join(output, 'documents/doc-one/state.json'), `${JSON.stringify({
    schema_version: 1,
    document_id: 'doc-one',
    page_count: 4,
    completed_pages: [1, 2],
    failed_pages: {},
    selected_pages_complete: false,
  })}\n`);
  const timestamp = new Date('2026-07-16T16:00:00.000Z');
  await utimes(path.join(output, 'run-status.json'), timestamp, timestamp);
  await utimes(path.join(output, 'run-status.json.sha256'), timestamp, timestamp);
  await utimes(path.join(output, 'documents/doc-one/state.json'), timestamp, timestamp);
  const result = await collectShardSnapshot({
    label: 'a',
    runRoot: root,
    outputRoot: output,
    nowMilliseconds: timestamp.getTime() + 120_000,
  });
  assert.equal(result.completed_pages, 2);
  assert.equal(result.expected_pages, 4);
  assert.equal(result.progress_age_seconds, 120);
  assert.equal(JSON.stringify(result).includes('doc-one'), false);
  assert.equal(JSON.stringify(result).includes('b'.repeat(64)), false, 'monitor output must not expose seed ids');

  await writeFile(path.join(output, 'run-status.json.sha256'), `${'0'.repeat(64)}  run-status.json\n`);
  await assert.rejects(
    collectShardSnapshot({ label: 'a', runRoot: root, outputRoot: output }),
    /sidecar mismatch/,
  );
});

test('latest JSON is atomic and JSONL events omit document ids paths and errors', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'remote-ocr-monitor-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = snapshot();
  current.shards.a.secret_document_id = 'must-not-appear';
  current.shards.a.raw_error = 'must-not-appear';
  const health = classifyMonitorSnapshot(current);
  await writeMonitorOutputs(root, current, health);
  await writeMonitorOutputs(root, current, health);

  const latest = JSON.parse(await readFile(path.join(root, 'latest.json'), 'utf8'));
  assert.equal(latest.health.exit_code, 0);
  const eventsRaw = await readFile(path.join(root, 'events.jsonl'), 'utf8');
  const events = eventsRaw.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.length, 2);
  assert.equal(eventsRaw.includes('must-not-appear'), false);
  assert.equal(eventsRaw.includes('/home/'), false);
  assert.equal(JSON.stringify(privacySafeEvent(current, health)).includes('secret_document_id'), false);
  assert.deepEqual(events[0].resources.cpu_throttle_counters, {
    available: true,
    package_throttle_count_max: 0,
    core_throttle_count_sum: 0,
  });
});

test('user systemd templates are inert observers on the exact run and two-minute cadence', async () => {
  const serviceUnit = await readFile(
    path.join(projectRoot, 'ops/systemd/curriculum-ocr-reprocess-monitor.service'),
    'utf8',
  );
  const timerUnit = await readFile(
    path.join(projectRoot, 'ops/systemd/curriculum-ocr-reprocess-monitor.timer'),
    'utf8',
  );
  assert.match(serviceUnit, /^Type=oneshot$/mu);
  assert.match(serviceUnit, /^SuccessExitStatus=10$/mu);
  assert.match(serviceUnit, /^Restart=no$/mu);
  assert.match(serviceUnit, /20260716T1520Z-partial14-reprocess/u);
  assert.match(serviceUnit, /a=output\/production-p4-mb16-shard-a-r1/u);
  assert.match(serviceUnit, /b=output\/production-p4-mb16-shard-b-r1/u);
  assert.match(serviceUnit, /http:\/\/127\.0\.0\.1:8112\/health/u);
  assert.match(serviceUnit, /--stall-seconds 900/u);
  assert.match(serviceUnit, /--cpu-warning-c 97/u);
  assert.match(serviceUnit, /--cpu-critical-c 99/u);
  assert.doesNotMatch(serviceUnit, /--paused-shard/u);
  assert.doesNotMatch(serviceUnit, /\b(?:restart|stop|kill|rm)\b.*curriculum-ocr-reprocess@/iu);
  assert.match(timerUnit, /^OnBootSec=2min$/mu);
  assert.match(timerUnit, /^OnUnitActiveSec=2min$/mu);
  assert.match(timerUnit, /^Persistent=true$/mu);
});
