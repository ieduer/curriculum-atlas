import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  parseCleanupArgs,
  parseSystemdShow,
  readCompletionStatus,
  runCompletionCleanup,
  validateCompletionStatus,
} from '../scripts/cleanup-remote-ocr-completion.mjs';

const workerUnit = 'curriculum-ocr-reprocess-b-r3.service';
const llamaUnit = 'curriculum-ocr-llama.service';

function sha256(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

function runStatusFor(statuses = ['complete', 'complete']) {
  const names = statuses.map((status, index) => [`doc-${index + 1}`, { status, attempts: 1, page_count: 1 }]);
  const count = (status) => statuses.filter((value) => value === status).length;
  const counts = {
    total: statuses.length,
    complete: count('complete'),
    failed: count('failed'),
    interrupted: count('interrupted'),
    pending: count('pending'),
    running: count('running'),
    retry_wait: count('retry_wait'),
    quarantined: count('quarantined'),
  };
  return {
    schema_version: 1,
    manifest_sha256: 'a'.repeat(64),
    runtime_fingerprint_sha256: 'b'.repeat(64),
    citation_allowed: false,
    documents: Object.fromEntries(names),
    counts,
    finished: counts.complete === counts.total,
    settled: counts.complete + counts.quarantined === counts.total,
  };
}

async function writeRunStatus(outputRoot, value) {
  const raw = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const pathname = path.join(outputRoot, 'run-status.json');
  await writeFile(pathname, raw, { mode: 0o600 });
  await chmod(pathname, 0o600);
  await writeFile(`${pathname}.sha256`, `${sha256(raw)}  run-status.json\n`, { mode: 0o600 });
  await chmod(`${pathname}.sha256`, 0o600);
}

async function fixture(t, status = runStatusFor()) {
  const canonicalTmp = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(canonicalTmp, 'curriculum-b3-cleanup-'));
  const outputRoot = path.join(root, 'output');
  await mkdir(outputRoot, { mode: 0o700 });
  await chmod(outputRoot, 0o700);
  await writeRunStatus(outputRoot, status);
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    outputRoot,
    options: { outputRoot, workerUnit, llamaUnit },
  };
}

function systemdShow({
  unitFileState = 'enabled',
  activeState = 'inactive',
  subState = 'dead',
  execMainCode = 1,
  execMainStatus = 0,
  result = 'success',
  mainPid = 0,
  invocationId = '1'.repeat(32),
  nRestarts = 0,
  startMonotonic = 100,
  exitMonotonic = 200,
} = {}) {
  return [
    'LoadState=loaded',
    `UnitFileState=${unitFileState}`,
    `ActiveState=${activeState}`,
    `SubState=${subState}`,
    `ExecMainCode=${execMainCode}`,
    `ExecMainStatus=${execMainStatus}`,
    `Result=${result}`,
    `MainPID=${mainPid}`,
    `InvocationID=${invocationId}`,
    `NRestarts=${nRestarts}`,
    `ExecMainStartTimestampMonotonic=${startMonotonic}`,
    `ExecMainExitTimestampMonotonic=${exitMonotonic}`,
    '',
  ].join('\n');
}

function systemctlRuntime({
  workerOverrides = [],
  llamaOverride = {},
  failAction = null,
  failShow = false,
  disableChanges = true,
} = {}) {
  const calls = [];
  let workerShowIndex = 0;
  let disabled = false;
  let llamaStopped = false;
  const runExecFile = async (executable, arguments_) => {
    calls.push({ executable, arguments: [...arguments_] });
    assert.equal(executable, '/usr/bin/systemctl');
    assert.equal(arguments_[0], '--user');
    const action = arguments_[1];
    if (action === 'show') {
      if (failShow) throw new Error('systemctl show failed');
      const unit = arguments_[2];
      if (unit === workerUnit) {
        const override = workerOverrides[workerShowIndex] || {};
        workerShowIndex += 1;
        return {
          stdout: systemdShow({
            unitFileState: disabled ? 'disabled' : 'enabled',
            ...override,
          }),
        };
      }
      assert.equal(unit, llamaUnit);
      return {
        stdout: systemdShow({
          unitFileState: 'static',
          activeState: llamaStopped ? 'inactive' : 'active',
          subState: llamaStopped ? 'dead' : 'running',
          mainPid: llamaStopped ? 0 : 8112,
          ...llamaOverride,
        }),
      };
    }
    if (action === 'disable') {
      assert.equal(arguments_[2], workerUnit);
      if (failAction === 'disable') throw new Error('systemctl disable failed');
      if (disableChanges) disabled = true;
      return { stdout: '' };
    }
    if (action === 'stop') {
      assert.equal(arguments_[2], llamaUnit);
      if (failAction === 'stop') throw new Error('systemctl stop failed');
      llamaStopped = true;
      return { stdout: '' };
    }
    assert.fail(`unexpected systemctl action: ${action}`);
  };
  return { calls, runExecFile };
}

function mutationCalls(calls) {
  return calls.filter(({ arguments: arguments_ }) => ['disable', 'stop'].includes(arguments_[1]));
}

test('cleanup CLI accepts only the three explicit safe arguments', () => {
  assert.deepEqual(parseCleanupArgs([
    '--output-root', '/home/suen/output',
    '--worker-unit', workerUnit,
    '--llama-unit', llamaUnit,
  ]), {
    outputRoot: '/home/suen/output',
    workerUnit,
    llamaUnit,
  });
  assert.deepEqual(parseCleanupArgs(['--help']), { help: true });
  assert.throws(() => parseCleanupArgs([]), /--output-root is required/);
  assert.throws(() => parseCleanupArgs([
    '--output-root', 'relative', '--worker-unit', workerUnit, '--llama-unit', llamaUnit,
  ]), /absolute normalized/);
  assert.throws(() => parseCleanupArgs([
    '--output-root', '/tmp/a/../b', '--worker-unit', workerUnit, '--llama-unit', llamaUnit,
  ]), /absolute normalized/);
  assert.throws(() => parseCleanupArgs([
    '--output-root', '/tmp/b', '--worker-unit', '--bad.service', '--llama-unit', llamaUnit,
  ]), /requires a value/);
  assert.throws(() => parseCleanupArgs([
    '--output-root', '/tmp/b', '--worker-unit', workerUnit, '--llama-unit', workerUnit,
  ]), /must differ/);
  assert.throws(() => parseCleanupArgs([
    '--output-root', '/tmp/b', '--worker-unit', workerUnit, '--llama-unit', llamaUnit, '--force', 'yes',
  ]), /unexpected argument/);
});

test('completion status requires exact self-consistent terminal counts', () => {
  assert.equal(validateCompletionStatus(runStatusFor()).complete, true);
  assert.equal(validateCompletionStatus(runStatusFor(['complete', 'pending'])).complete, false);

  const contradictory = runStatusFor(['complete', 'pending']);
  contradictory.finished = true;
  assert.throws(() => validateCompletionStatus(contradictory), /finished flag contradicts/);

  const wrongCount = runStatusFor();
  wrongCount.counts.pending = 1;
  assert.throws(() => validateCompletionStatus(wrongCount), /pending count differs/);

  const extraCount = runStatusFor();
  extraCount.counts.unknown = 0;
  assert.throws(() => validateCompletionStatus(extraCount), /exactly the canonical keys/);
});

test('systemd parser requires the live systemd 260 numeric CLD_EXITED lifecycle record', () => {
  const parsed = parseSystemdShow(systemdShow());
  assert.equal(parsed.exec_main_code, 1);
  assert.equal(parsed.exec_main_status, 0);
  assert.equal(parsed.main_pid, 0);
  assert.throws(() => parseSystemdShow('LoadState=loaded\n'), /lacks UnitFileState/);
  assert.throws(() => parseSystemdShow(systemdShow().replace('ExecMainCode=1', 'ExecMainCode=exited')), /ExecMainCode is invalid/);
  assert.throws(() => parseSystemdShow(systemdShow().replace('ExecMainCode=1', 'ExecMainCode=')), /ExecMainCode is invalid/);
  assert.throws(() => parseSystemdShow(systemdShow().replace('MainPID=0', 'MainPID=bad')), /MainPID is invalid/);
  assert.throws(() => parseSystemdShow(`${systemdShow()}Result=success\n`), /repeats Result/);
});

test('verified completion disables the same worker execution before stopping llama', async (t) => {
  const value = await fixture(t);
  const runtime = systemctlRuntime();
  const result = await runCompletionCleanup(value.options, { runExecFile: runtime.runExecFile });
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, 'cleaned');
  assert.equal(result.documents, 2);
  assert.deepEqual(mutationCalls(runtime.calls).map(({ arguments: arguments_ }) => arguments_.slice(1, 3)), [
    ['disable', workerUnit],
    ['stop', llamaUnit],
  ]);
  const workerShows = runtime.calls.filter(({ arguments: arguments_ }) => arguments_[1] === 'show' && arguments_[2] === workerUnit);
  assert.equal(workerShows.length, 4);
});

test('valid incomplete status exits 10 without service mutation', async (t) => {
  const value = await fixture(t, runStatusFor(['complete', 'pending']));
  const runtime = systemctlRuntime();
  const result = await runCompletionCleanup(value.options, { runExecFile: runtime.runExecFile });
  assert.deepEqual({ exitCode: result.exitCode, state: result.state }, { exitCode: 10, state: 'skipped' });
  assert.match(result.reason, /incomplete/);
  assert.deepEqual(mutationCalls(runtime.calls), []);
});

test('manual stop exits 10 without service mutation', async (t) => {
  const value = await fixture(t);
  const runtime = systemctlRuntime({
    workerOverrides: [{ execMainCode: 2, execMainStatus: 15, result: 'success' }],
  });
  const result = await runCompletionCleanup(value.options, { runExecFile: runtime.runExecFile });
  assert.equal(result.exitCode, 10);
  assert.match(result.reason, /terminal success/);
  assert.deepEqual(mutationCalls(runtime.calls), []);
});

test('activating worker exits 10 before reading mutable status', async (t) => {
  const value = await fixture(t);
  await unlink(path.join(value.outputRoot, 'run-status.json'));
  await unlink(path.join(value.outputRoot, 'run-status.json.sha256'));
  const runtime = systemctlRuntime({
    workerOverrides: [{
      activeState: 'activating',
      subState: 'start',
      execMainCode: 0,
      result: '',
      mainPid: 123,
      exitMonotonic: 0,
    }],
  });
  const result = await runCompletionCleanup(value.options, { runExecFile: runtime.runExecFile });
  assert.equal(result.exitCode, 10);
  assert.match(result.reason, /activating\/start/);
  assert.deepEqual(mutationCalls(runtime.calls), []);
});

test('tampered sidecar fails closed without service mutation', async (t) => {
  const value = await fixture(t);
  await writeFile(path.join(value.outputRoot, 'run-status.json.sha256'), `${'0'.repeat(64)}  run-status.json\n`);
  await chmod(path.join(value.outputRoot, 'run-status.json.sha256'), 0o600);
  const runtime = systemctlRuntime();
  await assert.rejects(
    runCompletionCleanup(value.options, { runExecFile: runtime.runExecFile }),
    /sidecar mismatch/,
  );
  assert.deepEqual(mutationCalls(runtime.calls), []);
});

test('status and sidecar must remain owner-only regular files', async (t) => {
  await t.test('output-root symlink', async (t) => {
    const value = await fixture(t);
    const alias = path.join(value.root, 'output-alias');
    await symlink('output', alias);
    await assert.rejects(readCompletionStatus(alias), /canonical|real directory/);
  });
  await t.test('group-writable output root', async (t) => {
    const value = await fixture(t);
    await chmod(value.outputRoot, 0o720);
    await assert.rejects(readCompletionStatus(value.outputRoot), /group- or world-writable/);
  });
  await t.test('wrong mode', async (t) => {
    const value = await fixture(t);
    await chmod(path.join(value.outputRoot, 'run-status.json'), 0o640);
    await assert.rejects(readCompletionStatus(value.outputRoot), /mode must be exactly 0600/);
  });
  await t.test('sidecar symlink', async (t) => {
    const value = await fixture(t);
    const sidecar = path.join(value.outputRoot, 'run-status.json.sha256');
    const target = path.join(value.outputRoot, 'sidecar-target');
    await writeFile(target, `${'0'.repeat(64)}  run-status.json\n`, { mode: 0o600 });
    await unlink(sidecar);
    await symlink('sidecar-target', sidecar);
    await assert.rejects(readCompletionStatus(value.outputRoot), /symlink|ELOOP/);
  });
  await t.test('wrong sidecar basename', async (t) => {
    const value = await fixture(t);
    const raw = await readFile(path.join(value.outputRoot, 'run-status.json'));
    const sidecar = path.join(value.outputRoot, 'run-status.json.sha256');
    await writeFile(sidecar, `${sha256(raw)}  other.json\n`);
    await chmod(sidecar, 0o600);
    await assert.rejects(readCompletionStatus(value.outputRoot), /exact basename/);
  });
});

test('run-status TOCTOU replacement is rejected before mutation', async (t) => {
  const value = await fixture(t);
  const runtime = systemctlRuntime();
  let reads = 0;
  const readStatus = async (outputRoot) => {
    const record = await readCompletionStatus(outputRoot);
    reads += 1;
    if (reads === 1) {
      const changed = runStatusFor();
      changed.updated_at = '2026-07-18T09:00:00.000Z';
      await writeRunStatus(outputRoot, changed);
    }
    return record;
  };
  await assert.rejects(
    runCompletionCleanup(value.options, { runExecFile: runtime.runExecFile, readStatus }),
    /run status changed/,
  );
  assert.deepEqual(mutationCalls(runtime.calls), []);
});

test('worker restart or activating race is rejected before mutation', async (t) => {
  await t.test('new invocation', async (t) => {
    const value = await fixture(t);
    const runtime = systemctlRuntime({ workerOverrides: [{}, { invocationId: '2'.repeat(32) }] });
    await assert.rejects(
      runCompletionCleanup(value.options, { runExecFile: runtime.runExecFile }),
      /worker execution changed/,
    );
    assert.deepEqual(mutationCalls(runtime.calls), []);
  });
  await t.test('activating after status validation', async (t) => {
    const value = await fixture(t);
    const runtime = systemctlRuntime({
      workerOverrides: [{}, {
        activeState: 'activating',
        subState: 'start',
        execMainCode: 0,
        result: '',
        mainPid: 222,
        exitMonotonic: 0,
      }],
    });
    await assert.rejects(
      runCompletionCleanup(value.options, { runExecFile: runtime.runExecFile }),
      /worker execution changed/,
    );
    assert.deepEqual(mutationCalls(runtime.calls), []);
  });
});

test('systemctl show and disable failures are nonzero and never stop llama', async (t) => {
  await t.test('show failure', async (t) => {
    const value = await fixture(t);
    const runtime = systemctlRuntime({ failShow: true });
    await assert.rejects(
      runCompletionCleanup(value.options, { runExecFile: runtime.runExecFile }),
      /systemctl show failed/,
    );
    assert.deepEqual(mutationCalls(runtime.calls), []);
  });
  await t.test('disable failure', async (t) => {
    const value = await fixture(t);
    const runtime = systemctlRuntime({ failAction: 'disable' });
    await assert.rejects(
      runCompletionCleanup(value.options, { runExecFile: runtime.runExecFile }),
      /systemctl disable failed/,
    );
    assert.deepEqual(mutationCalls(runtime.calls).map(({ arguments: arguments_ }) => arguments_[1]), ['disable']);
  });
  await t.test('disable did not stick', async (t) => {
    const value = await fixture(t);
    const runtime = systemctlRuntime({ disableChanges: false });
    await assert.rejects(
      runCompletionCleanup(value.options, { runExecFile: runtime.runExecFile }),
      /terminal and disabled/,
    );
    assert.deepEqual(mutationCalls(runtime.calls).map(({ arguments: arguments_ }) => arguments_[1]), ['disable']);
  });
});

test('stop failure and post-stop races fail closed after the ordered disable', async (t) => {
  await t.test('stop command failure', async (t) => {
    const value = await fixture(t);
    const runtime = systemctlRuntime({ failAction: 'stop' });
    await assert.rejects(
      runCompletionCleanup(value.options, { runExecFile: runtime.runExecFile }),
      /systemctl stop failed/,
    );
    assert.deepEqual(mutationCalls(runtime.calls).map(({ arguments: arguments_ }) => arguments_[1]), ['disable', 'stop']);
  });
  await t.test('llama remains active', async (t) => {
    const value = await fixture(t);
    const runtime = systemctlRuntime({
      llamaOverride: { activeState: 'active', subState: 'running', mainPid: 8112 },
    });
    await assert.rejects(
      runCompletionCleanup(value.options, { runExecFile: runtime.runExecFile }),
      /llama unit did not become inactive/,
    );
  });
  await t.test('worker restarts after llama stop', async (t) => {
    const value = await fixture(t);
    const runtime = systemctlRuntime({
      workerOverrides: [{}, {}, {}, { invocationId: '3'.repeat(32) }],
    });
    await assert.rejects(
      runCompletionCleanup(value.options, { runExecFile: runtime.runExecFile }),
      /worker changed after llama shutdown/,
    );
  });
});

test('systemd template holds the complete lifecycle under one bounded no-fork flock', async () => {
  const service = await readFile(new URL('../ops/systemd/curriculum-ocr-reprocess-b-r3-cleanup.service', import.meta.url), 'utf8');
  const config = await readFile(new URL('../ops/systemd/curriculum-ocr-reprocess-b-r3-cleanup.conf.example', import.meta.url), 'utf8');
  assert.match(service, /^EnvironmentFile=%h\/\.config\/bdfz\/curriculum-ocr-reprocess-b-r3-cleanup\.conf$/mu);
  assert.doesNotMatch(service, /^EnvironmentFile=-/mu);
  assert.match(service, /^SuccessExitStatus=10 75$/mu);
  assert.match(service, /^ExecStartPre=\/usr\/bin\/sha256sum --check --strict %h\/curriculum-ocr-offload\/runs\/20260716T1520Z-partial14-reprocess\/workspace-b-r3\/SHA256SUMS$/mu);
  assert.match(service, /^ExecStart=\/usr\/bin\/flock --no-fork --exclusive --wait 60 --conflict-exit-code 75 /mu);
  assert.match(service, /--output-root \$\{BDFZ_OCR_B3_OUTPUT_ROOT\}/u);
  assert.match(service, /--worker-unit \$\{BDFZ_OCR_B3_WORKER_UNIT\}/u);
  assert.match(service, /--llama-unit \$\{BDFZ_OCR_B3_LLAMA_UNIT\}/u);
  assert.match(service, /^Restart=no$/mu);
  assert.match(service, /^ProtectHome=read-only$/mu);
  assert.match(service, /^ReadWritePaths=%h\/\.config\/systemd\/user\/default\.target\.wants$/mu);
  assert.doesNotMatch(`${service}\n${config}`, /(?:PASSWORD|TOKEN|COOKIE|\.secrets\.env)/iu);
  assert.match(config, /^BDFZ_OCR_B3_CLEANUP_SCRIPT=\/home\/suen\/curriculum-ocr-offload\/runs\/20260716T1520Z-partial14-reprocess\/workspace-b-r3\/scripts\/cleanup-remote-ocr-completion\.mjs$/mu);
  assert.match(config, /^BDFZ_OCR_B3_OUTPUT_ROOT=\/home\/suen\/curriculum-ocr-offload\/runs\/20260716T1520Z-partial14-reprocess\/output\/production-p1-mb16-shard-b-r3$/mu);
  assert.match(config, /^BDFZ_OCR_B3_LIFECYCLE_LOCK=\/home\/suen\/curriculum-ocr-offload\/runs\/20260716T1520Z-partial14-reprocess\/\.b3-lifecycle\.lock$/mu);
});
