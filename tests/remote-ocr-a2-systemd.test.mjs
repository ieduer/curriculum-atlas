import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const unit = (name) => readFile(new URL(`../ops/systemd/${name}`, import.meta.url), 'utf8');

test('A2 worker resumes only a committed canonical timeout-recovery seed under one lifecycle lock', async () => {
  const [worker, cleanup] = await Promise.all([
    unit('curriculum-ocr-reprocess-a-r2.service'),
    unit('curriculum-ocr-reprocess-a-r2-cleanup.service'),
  ]);
  const lifecycle = '/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/.a2-lifecycle.lock';
  assert.match(worker, new RegExp(`^ExecStart=/usr/bin/flock --no-fork --exclusive --wait 60 --conflict-exit-code 75 ${lifecycle.replaceAll('.', '\\.')}`, 'mu'));
  assert.match(cleanup, /^ExecStart=\/usr\/bin\/flock --no-fork --exclusive --wait 60 --conflict-exit-code 75 \$\{BDFZ_OCR_A2_LIFECYCLE_LOCK\}/mu);
  assert.match(worker, /--seed-from-output-root \/home\/suen\/curriculum-ocr-offload\/runs\/20260716T1520Z-partial14-reprocess\/output\/production-p4-mb16-shard-a-r1/u);
  assert.match(worker, /--timeout-recovery-ledger \/home\/suen\/curriculum-ocr-offload\/runs\/20260716T1520Z-partial14-reprocess\/input\/timeout-recovery-authority-v1/u);
  assert.match(worker, /ConditionPathExists=.*production-p1-mb16-shard-a-r2\/seed-commit\.json$/mu);
  assert.match(worker, /ConditionPathExists=.*production-p1-mb16-shard-a-r2\/timeout-recovery-consumption-claim\.json$/mu);
  assert.match(worker, /^OnSuccess=curriculum-ocr-reprocess-a-r2-cleanup\.service$/mu);
  assert.match(worker, /^RestartPreventExitStatus=2 12 75$/mu);
});

test('A2 runtime is parallel-1, quality-first, and isolated from every predecessor worker', async () => {
  const [llama, worker] = await Promise.all([
    unit('curriculum-ocr-llama.service'),
    unit('curriculum-ocr-reprocess-a-r2.service'),
  ]);
  assert.match(llama, /--ctx-size 32768 --parallel 1 /u);
  assert.match(llama, /--temp 0 /u);
  assert.match(worker, /--vl-rec-max-concurrency 1 --server-parallel 1 --micro-batch 16 --use-queues/u);
  assert.match(worker, /--child-idle-timeout-seconds 1200/u);
  assert.doesNotMatch(worker, /--server-parallel 4/u);
  assert.match(worker, /^Conflicts=curriculum-ocr-reprocess@a\.service curriculum-ocr-reprocess@b\.service curriculum-ocr-reprocess-b-r2\.service curriculum-ocr-reprocess-b-r3\.service$/mu);
  assert.match(worker, /^TimeoutStartSec=4min$/mu);
  assert.match(worker, /^WantedBy=default\.target$/mu);
});

test('A2 monitor loads hash-sealed live A1 anchors and covers completion plus alerting', async () => {
  const [monitor, timer, dropIn, alertConfig] = await Promise.all([
    unit('curriculum-ocr-reprocess-a-r2-monitor.service'),
    unit('curriculum-ocr-reprocess-a-r2-monitor.timer'),
    unit('curriculum-ocr-reprocess-a-r2-monitor.service.d/alert-only.conf'),
    unit('curriculum-ocr-reprocess-a-r2-monitor-alert.conf.example'),
  ]);
  assert.match(monitor, /^EnvironmentFile=.*workspace-a-r2\/a1-anchors\.env$/mu);
  assert.match(monitor, /^ExecStartPre=\/usr\/bin\/sha256sum --check --strict .*workspace-a-r2\/SHA256SUMS$/mu);
  for (const variable of [
    'BDFZ_OCR_A1_IDENTITY_SHA256',
    'BDFZ_OCR_A1_RUN_STATUS_SHA256',
    'BDFZ_OCR_A1_STATE_HASHSET_SHA256',
    'BDFZ_OCR_A1_STATUS_HASHSET_SHA256',
    'BDFZ_OCR_A1_ARTIFACT_HASHSET_SHA256',
  ]) assert.match(monitor, new RegExp(`\\$\\{${variable}\\}`, 'u'));
  assert.match(monitor, /--inactive-worker-unit b-r3=curriculum-ocr-reprocess-b-r3\.service/u);
  assert.match(monitor, /--memory-min-gib 1/u);
  assert.match(timer, /^Persistent=true$/mu);
  assert.match(timer, /^OnUnitActiveSec=2min$/mu);
  assert.match(dropIn, /^OnFailure=curriculum-ocr-monitor-alert@%n\.service$/mu);
  assert.match(dropIn, /--mode observe/u);
  assert.match(alertConfig, /^BDFZ_OCR_ALERT_RUN_ROOT=\/home\/suen\/curriculum-ocr-offload\/runs\/20260716T1520Z-partial14-reprocess$/mu);
  assert.match(alertConfig, /^BDFZ_OCR_ALERT_LATEST_JSON=.*\/monitor-a-r2\/latest\.json$/mu);
  assert.match(alertConfig, /^BDFZ_OCR_ALERT_EXPECTED_RUN_ID=20260716T1520Z-partial14-reprocess$/mu);
  assert.match(alertConfig, /^BDFZ_OCR_ALERT_WORKER_UNIT=curriculum-ocr-reprocess-a-r2\.service$/mu);
  assert.match(alertConfig, /^BDFZ_OCR_ALERT_MONITOR_SCRIPT=.*\/workspace-a-r2\/scripts\/monitor-remote-ocr-single-shard\.mjs$/mu);
  assert.match(alertConfig, /^BDFZ_OCR_ALERT_MONITOR_SHA256=<LOWERCASE_64_HEX_SHA256>$/mu);
  assert.doesNotMatch(alertConfig, /(?:PASSWORD|TOKEN|COOKIE|\.secrets\.env)/iu);
});
