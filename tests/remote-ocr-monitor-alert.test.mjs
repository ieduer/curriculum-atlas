import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
  unlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createCommandSender,
  runOcrMonitorAlert,
} from '../scripts/notify-remote-ocr-single-shard-monitor.mjs';

const bootId = '11111111-1111-4111-8111-111111111111';
const workerInvocation = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'curriculum-ocr-alert-')));
  const stateDir = path.join(root, 'external-state');
  const monitorOutput = path.join(root, 'monitor-output');
  await Promise.all([
    mkdir(stateDir, { mode: 0o700 }),
    mkdir(monitorOutput, { mode: 0o700 }),
  ]);
  await chmod(stateDir, 0o700);
  const monitorScript = path.join(root, 'monitor.mjs');
  const scriptRaw = Buffer.from('export const monitor = true;\n');
  await writeFile(monitorScript, scriptRaw, { mode: 0o600 });
  const latestJson = path.join(monitorOutput, 'latest.json');
  const config = {
    mode: 'observe',
    stateDir,
    latestJson,
    expectedRunId: 'run-20260718',
    monitorUnit: 'curriculum-ocr-monitor.service',
    workerUnit: 'curriculum-ocr-worker.service',
    monitorScript,
    monitorSha256: sha256(scriptRaw),
    maxLatestAgeSeconds: 300,
  };
  return { root, stateDir, latestJson, config };
}

function latestRecord(config, timestamp, exitCode, issueCodes = []) {
  const state = exitCode === 0 ? 'completed' : exitCode === 10 ? 'healthy_running' : 'blocked';
  return {
    schema_version: 1,
    timestamp: new Date(timestamp).toISOString(),
    run_id: config.expectedRunId,
    state,
    exit_code: exitCode,
    issue_codes: issueCodes,
    predecessor: { read_ok: true, anchors_match: true, documents: 6, completed_pages: 1259 },
    successor: {
      read_ok: true,
      complete: exitCode === 0,
      documents: 6,
      expected_pages: 3182,
      completed_pages: exitCode === 0 ? 3182 : 1400,
      failed_pages: 0,
      status_counts: {},
      declared_counts_match: true,
      progress_age_seconds: 1,
    },
    services: {},
    resources: {
      disk_available_gib: 300,
      memory_available_gib: 8,
      gpu_max_temperature_c: 60,
      gpu_max_utilization_percent: 80,
    },
  };
}

async function writeLatest(fx, timestamp, exitCode, issueCodes = []) {
  await writeFile(
    fx.latestJson,
    `${JSON.stringify(latestRecord(fx.config, timestamp, exitCode, issueCodes), null, 2)}\n`,
    { mode: 0o600 },
  );
  await chmod(fx.latestJson, 0o600);
}

function runtime(timestamp, exitCode, monitorInvocation, result) {
  return {
    boot_id: bootId,
    monitor: {
      invocation_id: monitorInvocation,
      exit_code: exitCode,
      started_at_milliseconds: timestamp - 1_000,
      result: result || (exitCode === 12 ? 'exit-code' : 'success'),
    },
    worker: { invocation_id: workerInvocation },
  };
}

async function invoke(fx, mode, timestamp, exitCode, monitorInvocation, sendAlert = async () => {}) {
  return runOcrMonitorAlert(
    { ...fx.config, mode },
    {
      nowMilliseconds: timestamp,
      runtime: runtime(timestamp, exitCode, monitorInvocation),
      sendAlert,
    },
  );
}

async function invokeWithRuntime(fx, mode, timestamp, evidence, sendAlert = async () => {}) {
  return runOcrMonitorAlert(
    { ...fx.config, mode },
    { nowMilliseconds: timestamp, runtime: evidence, sendAlert },
  );
}

async function arm(fx, timestamp = Date.parse('2026-07-18T08:00:00.000Z')) {
  await writeLatest(fx, timestamp, 10);
  const first = await invoke(fx, 'observe', timestamp, 10, '11111111111111111111111111111111');
  assert.equal(first.state, 'warming_no_alert');
  const secondTimestamp = timestamp + 60_000;
  await writeLatest(fx, secondTimestamp, 10);
  const second = await invoke(fx, 'observe', secondTimestamp, 10, '22222222222222222222222222222222');
  assert.equal(second.state, 'armed_no_alert');
  return secondTimestamp;
}

test('exit 10 warms then arms without alert, and exit 0 completes without alert', async () => {
  const fx = await fixture();
  const sent = [];
  const firstTimestamp = Date.parse('2026-07-18T08:00:00.000Z');
  await writeLatest(fx, firstTimestamp, 10);
  const first = await invoke(
    fx,
    'observe',
    firstTimestamp,
    10,
    '11111111111111111111111111111111',
    async (payload) => sent.push(payload),
  );
  assert.equal(first.state, 'warming_no_alert');
  const secondTimestamp = firstTimestamp + 60_000;
  await writeLatest(fx, secondTimestamp, 10);
  const second = await invoke(
    fx,
    'observe',
    secondTimestamp,
    10,
    '22222222222222222222222222222222',
    async (payload) => sent.push(payload),
  );
  assert.equal(second.state, 'armed_no_alert');
  const completedTimestamp = secondTimestamp + 60_000;
  await writeLatest(fx, completedTimestamp, 0);
  const completed = await invoke(
    fx,
    'observe',
    completedTimestamp,
    0,
    '33333333333333333333333333333333',
    async (payload) => sent.push(payload),
  );
  assert.equal(completed.state, 'completed_no_alert');
  assert.equal(sent.length, 0);
  await assert.rejects(readFile(path.join(fx.stateDir, 'armed-receipt.json')), { code: 'ENOENT' });
});

test('exit 12 remains local and sends nothing while disarmed', async () => {
  const fx = await fixture();
  const timestamp = Date.parse('2026-07-18T08:10:00.000Z');
  await writeLatest(fx, timestamp, 12, ['MEMORY_BELOW_MINIMUM']);
  const sent = [];
  const result = await invoke(
    fx,
    'alert',
    timestamp,
    12,
    '33333333333333333333333333333333',
    async (payload) => sent.push(payload),
  );
  assert.equal(result.state, 'suppressed_disarmed');
  assert.deepEqual(result.issue_codes, ['MEMORY_BELOW_MINIMUM']);
  assert.equal(sent.length, 0);
});

test('alert handler never sends for a successful exit 0 or 10', async () => {
  for (const [index, exitCode] of [0, 10].entries()) {
    const fx = await fixture();
    const timestamp = Date.parse('2026-07-18T08:15:00.000Z') + index * 60_000;
    await writeLatest(fx, timestamp, exitCode);
    const sent = [];
    const result = await invoke(
      fx,
      'alert',
      timestamp,
      exitCode,
      `${index + 4}`.repeat(32),
      async (payload) => sent.push(payload),
    );
    assert.equal(result.state, 'successful_exit_no_alert');
    assert.equal(sent.length, 0);
  }
});

test('armed exit 12 sends once, deduplicates the same fingerprint, and sends a new issue', async () => {
  const fx = await fixture();
  const armedAt = await arm(fx);
  const sent = [];
  const firstFailure = armedAt + 60_000;
  await writeLatest(fx, firstFailure, 12, ['MEMORY_BELOW_MINIMUM']);
  const first = await invoke(
    fx,
    'alert',
    firstFailure,
    12,
    '33333333333333333333333333333333',
    async (payload) => sent.push(payload),
  );
  assert.equal(first.state, 'sent');
  assert.equal(sent.length, 1);
  const duplicate = await invoke(
    fx,
    'alert',
    firstFailure + 1_000,
    12,
    '33333333333333333333333333333333',
    async (payload) => sent.push(payload),
  );
  assert.equal(duplicate.state, 'deduplicated');
  assert.equal(sent.length, 1);
  const newFailure = firstFailure + 60_000;
  await writeLatest(fx, newFailure, 12, ['GPU_OVER_TEMPERATURE']);
  const changed = await invoke(
    fx,
    'alert',
    newFailure,
    12,
    '44444444444444444444444444444444',
    async (payload) => sent.push(payload),
  );
  assert.equal(changed.state, 'sent');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].issue_codes, ['GPU_OVER_TEMPERATURE']);
  assert.equal(Object.hasOwn(sent[1], 'boot_id'), false);
  assert.equal(Object.hasOwn(sent[1], 'worker_invocation_id'), false);
});

test('a failed delivery remains pending and retries the same issue fingerprint', async () => {
  const fx = await fixture();
  const armedAt = await arm(fx);
  const failedAt = armedAt + 60_000;
  await writeLatest(fx, failedAt, 12, ['B2_NO_PROGRESS']);
  await assert.rejects(
    invoke(
      fx,
      'alert',
      failedAt,
      12,
      '33333333333333333333333333333333',
      async () => { throw new Error('dummy send failure'); },
    ),
    /alert delivery failed/u,
  );
  const sent = [];
  const retry = await invoke(
    fx,
    'alert',
    failedAt + 1_000,
    12,
    '33333333333333333333333333333333',
    async (payload) => sent.push(payload),
  );
  assert.equal(retry.state, 'sent');
  assert.equal(sent.length, 1);
  const deliveryState = JSON.parse(await readFile(path.join(fx.stateDir, 'delivery-state.json'), 'utf8'));
  assert.equal(deliveryState.records[0].attempts, 2);
  assert.equal(deliveryState.records[0].status, 'sent');
});

test('stale latest.json is reduced to one generic MONITOR_EXECUTION_FAILED alert', async () => {
  const fx = await fixture();
  const armedAt = await arm(fx);
  const failureAt = armedAt + 10 * 60_000;
  const sent = [];
  const result = await invoke(
    fx,
    'alert',
    failureAt,
    12,
    '33333333333333333333333333333333',
    async (payload) => sent.push(payload),
  );
  assert.equal(result.state, 'sent');
  assert.deepEqual(sent[0].issue_codes, ['MONITOR_EXECUTION_FAILED']);
  assert.equal(sent[0].progress, null);
});

test('missing latest.json is reduced to MONITOR_EXECUTION_FAILED when armed', async () => {
  const fx = await fixture();
  const armedAt = await arm(fx);
  await unlink(fx.latestJson);
  const failureAt = armedAt + 60_000;
  const sent = [];
  const result = await invoke(
    fx,
    'alert',
    failureAt,
    12,
    '33333333333333333333333333333333',
    async (payload) => sent.push(payload),
  );
  assert.equal(result.state, 'sent');
  assert.deepEqual(sent[0].issue_codes, ['MONITOR_EXECUTION_FAILED']);
});

test('ExecStartPre failure with a retained exit-10 status becomes MONITOR_EXECUTION_FAILED', async () => {
  const fx = await fixture();
  const armedAt = await arm(fx);
  await unlink(fx.latestJson);
  const failureAt = armedAt + 60_000;
  const sent = [];
  const evidence = runtime(
    failureAt,
    10,
    '33333333333333333333333333333333',
    'exit-code',
  );
  evidence.monitor.started_at_milliseconds = null;
  const result = await invokeWithRuntime(
    fx,
    'alert',
    failureAt,
    evidence,
    async (payload) => sent.push(payload),
  );
  assert.equal(result.state, 'sent');
  assert.deepEqual(sent[0].issue_codes, ['MONITOR_EXECUTION_FAILED']);
});

test('send-command injection receives only the privacy-safe payload', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'curriculum-ocr-alert-command-')));
  const command = path.join(root, 'dummy-sender.mjs');
  const sink = path.join(root, 'sink.jsonl');
  await writeFile(command, [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs';",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => appendFileSync(process.env.BDFZ_OCR_ALERT_TEST_SINK, input));",
    '',
  ].join('\n'), { mode: 0o700 });
  await chmod(command, 0o700);
  const sender = createCommandSender(command, {
    environment: { BDFZ_OCR_ALERT_TEST_SINK: sink },
  });
  const payload = {
    schema_version: 1,
    type: 'bdfz_curriculum_ocr_monitor_alert',
    run_id: 'run-20260718',
    issue_codes: ['B2_NO_PROGRESS'],
  };
  await sender(payload);
  assert.deepEqual(JSON.parse((await readFile(sink, 'utf8')).trim()), payload);
});

test('B-r3 systemd templates preserve exit 10, stay reusable, and never auto-stop OCR', async () => {
  const repo = path.resolve(import.meta.dirname, '..');
  const [handler, dropIn, configTemplate] = await Promise.all([
    readFile(path.join(repo, 'ops/systemd/curriculum-ocr-monitor-alert@.service'), 'utf8'),
    readFile(path.join(repo, 'ops/systemd/curriculum-ocr-reprocess-b-r3-monitor.service.d/alert-only.conf'), 'utf8'),
    readFile(path.join(repo, 'ops/systemd/curriculum-ocr-monitor-alert.conf.example'), 'utf8'),
  ]);
  assert.match(dropIn, /^ConditionPathIsDirectory=\s*$/mu);
  assert.match(dropIn, /^OnFailure=curriculum-ocr-monitor-alert@%n\.service$/mu);
  assert.match(dropIn, /^SuccessExitStatus=10$/mu);
  assert.match(dropIn, /^ExecStartPre=\/usr\/bin\/test -d /mu);
  assert.match(handler, /^ExecStartPre=\/usr\/bin\/test -d /mu);
  assert.match(handler, /\.config\/bdfz\/curriculum-ocr-monitor-telegram\.env/u);
  assert.match(handler, /^Restart=on-failure$/mu);
  assert.doesNotMatch(`${handler}\n${dropIn}`, /\.secrets\.env|systemctl\s+(?:--user\s+)?(?:stop|restart)|ExecStop/u);
  assert.match(`${handler}\n${dropIn}`, /\.local\/state\/bdfz-curriculum-ocr-monitor-alert/u);
  assert.match(`${handler}\n${dropIn}`, /EnvironmentFile=%h\/\.config\/bdfz\/curriculum-ocr-monitor-alert\.conf/u);
  assert.match(configTemplate, /BDFZ_OCR_ALERT_WORKER_UNIT=curriculum-ocr-reprocess-b-r3\.service/u);
  assert.match(configTemplate, /BDFZ_OCR_ALERT_MONITOR_SHA256=<LOWERCASE_64_HEX_SHA256>/u);
  assert.doesNotMatch(`${handler}\n${dropIn}\n${configTemplate}`, /b-r2|B-r2/u);
});
