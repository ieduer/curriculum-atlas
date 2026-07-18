import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const unit = (name) => readFile(new URL(`../ops/systemd/${name}`, import.meta.url), 'utf8');

test('B3 worker and cleanup serialize the full lifecycle and keep reboot opt-in', async () => {
  const [worker, cleanup] = await Promise.all([
    unit('curriculum-ocr-reprocess-b-r3.service'),
    unit('curriculum-ocr-reprocess-b-r3-cleanup.service'),
  ]);
  const lifecycle = '/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/.b3-lifecycle.lock';
  assert.match(worker, new RegExp(`^ExecStart=/usr/bin/flock --no-fork --exclusive --wait 60 --conflict-exit-code 75 ${lifecycle.replaceAll('.', '\\.')}`, 'mu'));
  assert.match(cleanup, /^ExecStart=\/usr\/bin\/flock --no-fork --exclusive --wait 60 --conflict-exit-code 75 \$\{BDFZ_OCR_B3_LIFECYCLE_LOCK\}/mu);
  assert.match(worker, /^RestartPreventExitStatus=2 12 75$/mu);
  assert.match(worker, /^OnSuccess=curriculum-ocr-reprocess-b-r3-cleanup\.service$/mu);
  assert.match(worker, /^TimeoutStartSec=4min$/mu);
  assert.doesNotMatch(worker, /^WantedBy=timers\.target$/mu);
  assert.match(worker, /^WantedBy=default\.target$/mu);
});

test('B3 llama and worker pin the exact parallel-1 runtime', async () => {
  const [llama, worker] = await Promise.all([
    unit('curriculum-ocr-llama.service'),
    unit('curriculum-ocr-reprocess-b-r3.service'),
  ]);
  assert.match(llama, /--ctx-size 32768 --parallel 1 /u);
  assert.match(llama, /--temp 0 /u);
  assert.match(llama, /^Conflicts=curriculum-ocr-llama-p1-canary\.service$/mu);
  assert.match(worker, /--vl-rec-max-concurrency 1 --server-parallel 1 --micro-batch 16 --use-queues/u);
  assert.match(worker, /--child-idle-timeout-seconds 1200/u);
  assert.match(worker, /^Conflicts=curriculum-ocr-reprocess@a\.service curriculum-ocr-reprocess@b\.service curriculum-ocr-reprocess-b-r2\.service$/mu);
});

test('B3 monitor pins all immutable B1 anchors and observes every masked predecessor', async () => {
  const [monitor, timer] = await Promise.all([
    unit('curriculum-ocr-reprocess-b-r3-monitor.service'),
    unit('curriculum-ocr-reprocess-b-r3-monitor.timer'),
  ]);
  for (const anchor of [
    '83d9b65f772682465792ee4f76ed77d42a46541ff5e87bcfaa1559ba28a1f374',
    '5a98d8ee9f614543ba89366e911554e31f9576c6b57953e14119563a18d6d209',
    'c61c02947563caef884db15c5e60f1e79a818eaaeee0609d7502e51c0321703a',
    '1b41d39c07d331d35f6edd9818e02dce1bbf52c095356fd45e8471292a4f61ca',
    '3287cc5314e105dd012faadd8e22b629fd0d3f9b4fd9449aff5ccbc22b861e4c',
  ]) assert.match(monitor, new RegExp(anchor, 'u'));
  assert.match(monitor, /--old-worker-unit a=curriculum-ocr-reprocess@a\.service/u);
  assert.match(monitor, /--old-worker-unit b=curriculum-ocr-reprocess@b\.service/u);
  assert.match(monitor, /--inactive-worker-unit b-r2=curriculum-ocr-reprocess-b-r2\.service/u);
  assert.match(monitor, /--inactive-worker-unit llama-p1-canary=curriculum-ocr-llama-p1-canary\.service/u);
  assert.match(timer, /^Persistent=true$/mu);
  assert.match(timer, /^OnUnitActiveSec=2min$/mu);
});
