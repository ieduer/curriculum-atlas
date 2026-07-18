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
  assert.match(worker, /^ExecStartPre=\/usr\/bin\/test -f .*production-p1-mb16-shard-a-r2\/seed-commit\.json$/mu);
  assert.match(worker, /^ExecStartPre=\/usr\/bin\/test -f .*production-p1-mb16-shard-a-r2\/timeout-recovery-consumption-claim\.json$/mu);
  assert.match(worker, /^OnSuccess=curriculum-ocr-reprocess-a-r2-cleanup\.service$/mu);
  assert.match(worker, /^RestartPreventExitStatus=2 12 75$/mu);
});

test('A2 worker fails startup when any mandatory runtime prerequisite is absent', async () => {
  const worker = await unit('curriculum-ocr-reprocess-a-r2.service');
  assert.doesNotMatch(worker, /^Condition(?:Path|File)/mu);
  const requiredChecks = [
    'ExecStartPre=/usr/bin/test -d /home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/workspace-a-r2',
    'ExecStartPre=/usr/bin/test -d /home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/output/production-p4-mb16-shard-a-r1',
    'ExecStartPre=/usr/bin/test -d /home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/output/production-p1-mb16-shard-a-r2',
    'ExecStartPre=/usr/bin/test -f /home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/output/production-p1-mb16-shard-a-r2/seed-commit.json',
    'ExecStartPre=/usr/bin/test -f /home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/output/production-p1-mb16-shard-a-r2/seed-commit.json.sha256',
    'ExecStartPre=/usr/bin/test -f /home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/output/production-p1-mb16-shard-a-r2/timeout-recovery-grant.json',
    'ExecStartPre=/usr/bin/test -f /home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/output/production-p1-mb16-shard-a-r2/timeout-recovery-grant.json.sha256',
    'ExecStartPre=/usr/bin/test -f /home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/output/production-p1-mb16-shard-a-r2/timeout-recovery-consumption-claim.json',
    'ExecStartPre=/usr/bin/test -f /home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/output/production-p1-mb16-shard-a-r2/timeout-recovery-consumption-claim.json.sha256',
  ];
  const lines = new Set(worker.split('\n'));
  for (const check of requiredChecks) assert.equal(lines.has(check), true, check);
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

test('shared completion cleanup reports a runtime-neutral fail-closed label', async () => {
  const source = await readFile(new URL('../scripts/cleanup-remote-ocr-completion.mjs', import.meta.url), 'utf8');
  assert.match(source, /Remote OCR completion cleanup failed closed:/u);
  assert.doesNotMatch(source, /B3 completion cleanup failed closed:/u);
});

test('A2 deployment runbook is executable, ordered, and preserves the authority boundary', async () => {
  const runbook = await readFile(new URL('../docs/remote-ocr-a2-deployment.md', import.meta.url), 'utf8');
  for (const exact of [
    'DMITPro2 inner bdfz workstation',
    'ssh dmitpro2',
    'ssh -p 22222 suen@localhost',
    'BatchMode=yes',
    'df -hT /',
    'free -h',
    'nvidia-smi',
    'systemctl --failed',
    'ss -lntup',
    'docker ps',
    'SHA256SUMS',
    'a1-anchors.env',
    'systemd-analyze --user verify',
    'provision-timeout-recovery-authority.mjs',
    'prepare-timeout-recovery-grant.mjs',
    '--seed-dry-run',
    '--seed-only',
    'curriculum-ocr-reprocess-a-r2-monitor.service',
    'curriculum-ocr-reprocess-a-r2-monitor.timer',
    'ActiveState',
    'MainPID',
    'ConditionResult',
    'NRestarts',
    'run-status.json.sha256',
    'archive',
    'readback',
    'freeze',
    'rollback',
  ]) assert.ok(runbook.includes(exact), exact);
  assert.match(runbook, /preview[^\n]*twice|two[^\n]*preview/iu);
  assert.match(runbook, /apply[^\n]*once|one[^\n]*apply/iu);
  assert.match(runbook, /irreversible|不可逆/iu);
  assert.match(runbook, /must not.*restore|不得.*恢复/iu);
  assert.doesNotMatch(runbook, /(?:PASSWORD|TOKEN|COOKIE|API_KEY)\s*[=:]\s*[^<\s]/iu);
});

test('A2 deployment creates a new private monitor output directory before worker start', async () => {
  const runbook = await readFile(new URL('../docs/remote-ocr-a2-deployment.md', import.meta.url), 'utf8');
  for (const exact of [
    'MONITOR_DIR="$RUN_ROOT/monitor-a-r2"',
    'test ! -e "$MONITOR_DIR"',
    'test ! -L "$MONITOR_DIR"',
    'mkdir -m 700 "$MONITOR_DIR"',
    'test -d "$MONITOR_DIR"',
    'test "$(stat -c %a "$MONITOR_DIR")" = 700',
    'test "$(stat -c %u "$MONITOR_DIR")" = "$(id -u)"',
  ]) assert.ok(runbook.includes(exact), exact);
  const createAt = runbook.indexOf('mkdir -m 700 "$MONITOR_DIR"');
  const workerStartAt = runbook.indexOf('systemctl --user start curriculum-ocr-reprocess-a-r2.service');
  assert.ok(createAt >= 0 && workerStartAt >= 0 && createAt < workerStartAt);
});

test('A2 deployment binds the exact reviewed alert handler and retry chain', async () => {
  const runbook = await readFile(new URL('../docs/remote-ocr-a2-deployment.md', import.meta.url), 'utf8');
  for (const exact of [
    'scripts/notify-remote-ocr-single-shard-monitor.mjs',
    'ops/systemd/curriculum-ocr-monitor-alert@.service',
    'ops/systemd/curriculum-ocr-monitor-alert-retry@.timer',
    '"$HOME/.config/systemd/user/curriculum-ocr-monitor-alert@.service"',
    '"$HOME/.config/systemd/user/curriculum-ocr-monitor-alert-retry@.timer"',
    '"$HOME/curriculum-ocr-offload/alert-runtime/notify-remote-ocr-single-shard-monitor.mjs"',
    '"$HOME/curriculum-ocr-offload/alert-runtime/SHA256SUMS"',
    '"$SYSTEMD_USER/curriculum-ocr-monitor-alert@.service"',
    '"$SYSTEMD_USER/curriculum-ocr-monitor-alert-retry@.timer"',
    'cmp "$WORKSPACE/scripts/notify-remote-ocr-single-shard-monitor.mjs"',
    'cmp "$WORKSPACE/ops/systemd/curriculum-ocr-monitor-alert@.service"',
    'cmp "$WORKSPACE/ops/systemd/curriculum-ocr-monitor-alert-retry@.timer"',
    'ALERT_RUNTIME="$HOME/curriculum-ocr-offload/alert-runtime"',
    'alert-runtime-state.env',
  ]) assert.ok(runbook.includes(exact), exact);
  assert.match(runbook, /sha256sum "\$ALERT_RUNTIME\/notify-remote-ocr-single-shard-monitor\.mjs"[\s\S]*SHA256SUMS/u);
  const archiveBlock = runbook.slice(
    runbook.indexOf('git -C "$REPO" archive'),
    runbook.indexOf('| tar -xf - -C "$LOCAL_STAGE"'),
  );
  for (const exact of [
    'scripts/notify-remote-ocr-single-shard-monitor.mjs',
    'ops/systemd/curriculum-ocr-monitor-alert@.service',
    'ops/systemd/curriculum-ocr-monitor-alert-retry@.timer',
  ]) assert.ok(archiveBlock.includes(exact), exact);
  const verifyBlock = runbook.slice(
    runbook.indexOf('systemd-analyze --user verify'),
    runbook.indexOf('! systemctl --user cat curriculum-ocr-reprocess-a-r2.service'),
  );
  assert.ok(verifyBlock.includes('"$SYSTEMD_USER/curriculum-ocr-monitor-alert@.service"'));
  assert.ok(verifyBlock.includes('"$SYSTEMD_USER/curriculum-ocr-monitor-alert-retry@.timer"'));
  const rollbackBlock = runbook.slice(runbook.indexOf('## 11. Rollback and irreversible boundary'));
  assert.ok(rollbackBlock.includes('ALERT_RUNTIME_STATE='));
  assert.ok(rollbackBlock.includes('alert-runtime-state.env'));
  assert.ok(rollbackBlock.includes('sha256sum --check --strict SHA256SUMS'));
  const disableOldAt = runbook.indexOf('systemctl --user disable --now curriculum-ocr-reprocess-b-r3-monitor.timer');
  const installHandlerAt = runbook.indexOf('install -m 0644 "$WORKSPACE/ops/systemd/curriculum-ocr-monitor-alert@.service"');
  assert.ok(disableOldAt >= 0 && installHandlerAt >= 0 && disableOldAt < installHandlerAt);
});

test('A2 rollback proves every runtime is quiescent before restoring shared files', async () => {
  const runbook = await readFile(new URL('../docs/remote-ocr-a2-deployment.md', import.meta.url), 'utf8');
  const rollback = runbook.slice(runbook.indexOf('## 11. Rollback and irreversible boundary'));
  assert.doesNotMatch(rollback, /\|\|\s*(?:true|:)/u);
  assert.doesNotMatch(rollback, /set \+e/u);
  for (const exact of [
    'reviewed_unit_absent()',
    'disable_timer_or_reviewed_absent()',
    'disable_worker_or_reviewed_absent()',
    'stop_service_or_reviewed_absent()',
    'assert_service_quiet_or_reviewed_absent()',
    'LoadState --value',
    'not-found)',
    'test "$ACTIVE_STATE" = inactive',
    'test "$MAIN_PID" = 0',
    'test "$ENABLED_STATE" = disabled',
    'curriculum-ocr-reprocess-a-r2-monitor.timer',
    'curriculum-ocr-monitor-alert-retry@curriculum-ocr-reprocess-a-r2-monitor.service.timer',
    'curriculum-ocr-reprocess-a-r2.service',
    'curriculum-ocr-reprocess-a-r2-monitor.service',
    'curriculum-ocr-monitor-alert@curriculum-ocr-reprocess-a-r2-monitor.service.service',
    'curriculum-ocr-reprocess-a-r2-cleanup.service',
    'curriculum-ocr-llama.service',
    'disable_timer_or_reviewed_absent "$MONITOR_TIMER"',
    'disable_timer_or_reviewed_absent "$ALERT_RETRY_TIMER"',
    'disable_worker_or_reviewed_absent "$WORKER"',
    'stop_service_or_reviewed_absent "$MONITOR"',
    'stop_service_or_reviewed_absent "$ALERT_HANDLER"',
    'stop_service_or_reviewed_absent "$CLEANUP"',
    'stop_service_or_reviewed_absent "$LLAMA"',
    'assert_timer_quiet_or_reviewed_absent "$MONITOR_TIMER"',
    'assert_timer_quiet_or_reviewed_absent "$ALERT_RETRY_TIMER"',
    'assert_worker_quiet_or_reviewed_absent "$WORKER"',
    'assert_service_quiet_or_reviewed_absent "$MONITOR"',
    'assert_service_quiet_or_reviewed_absent "$ALERT_HANDLER"',
    'assert_service_quiet_or_reviewed_absent "$CLEANUP"',
    'assert_service_quiet_or_reviewed_absent "$LLAMA"',
    'QUIESCENCE_VERIFIED=1',
    'test "$QUIESCENCE_VERIFIED" = 1',
  ]) assert.ok(rollback.includes(exact), exact);
  assert.match(rollback, /not-found[\s\S]*file-state\.tsv[\s\S]*test ! -e[\s\S]*test ! -L/u);
  const quiescenceAt = rollback.indexOf('QUIESCENCE_VERIFIED=1');
  const restoreAt = rollback.indexOf("while IFS=$'\\t' read -r state relative; do");
  const daemonReloadAt = rollback.indexOf('systemctl --user daemon-reload');
  assert.ok(quiescenceAt >= 0 && restoreAt > quiescenceAt && daemonReloadAt > restoreAt);
  for (const unit of [
    'curriculum-ocr-reprocess-a-r2-monitor.timer',
    'curriculum-ocr-monitor-alert-retry@curriculum-ocr-reprocess-a-r2-monitor.service.timer',
    'curriculum-ocr-reprocess-a-r2.service',
    'curriculum-ocr-reprocess-a-r2-monitor.service',
    'curriculum-ocr-monitor-alert@curriculum-ocr-reprocess-a-r2-monitor.service.service',
    'curriculum-ocr-reprocess-a-r2-cleanup.service',
    'curriculum-ocr-llama.service',
  ]) assert.ok(rollback.indexOf(unit) < quiescenceAt, unit);
  assert.match(rollback, /successor, monitor evidence directory, alert[\s\S]*remain preserved/iu);
});
