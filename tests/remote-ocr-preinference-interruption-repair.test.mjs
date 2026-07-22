import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  acquireLifecycleLock,
  parseSystemdShow,
  repairPreInferenceInterruption,
  validateRepairOptions,
} from '../scripts/repair-remote-ocr-preinference-interruption.mjs';
import { inspectTreeStrict } from '../scripts/monitor-remote-ocr-single-shard.mjs';

const documentId = 'legacy-compendium-english';
const seedId = 'd'.repeat(64);
const grantId = 'a'.repeat(64);
const runtimeFingerprintSha256 = 'b'.repeat(64);
const predecessorStatusSha256 = 'c'.repeat(64);
const startedAt = '2026-07-22T02:32:45.088Z';
const interruptedAt = '2026-07-22T02:32:47.128Z';
const repairAt = '2026-07-22T03:10:00.000Z';
const execFile = promisify(execFileCallback);

const digest = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const sidecar = (sha256, basename) => Buffer.from(`${sha256}  ${basename}\n`);

async function writeOwned(pathname, raw) {
  await mkdir(path.dirname(pathname), { recursive: true, mode: 0o700 });
  await writeFile(pathname, raw, { mode: 0o600 });
  await chmod(pathname, 0o600);
}

async function writeJson(pathname, value, withSidecar = false) {
  const raw = json(value);
  await writeOwned(pathname, raw);
  const sha256 = digest(raw);
  if (withSidecar) await writeOwned(`${pathname}.sha256`, sidecar(sha256, path.basename(pathname)));
  return { raw, sha256 };
}

function counts(documents) {
  const statuses = Object.values(documents).map(({ status }) => status);
  return {
    total: statuses.length,
    complete: statuses.filter((status) => status === 'complete').length,
    failed: statuses.filter((status) => status === 'failed').length,
    interrupted: statuses.filter((status) => status === 'interrupted').length,
    pending: statuses.filter((status) => status === 'pending').length,
    running: statuses.filter((status) => status === 'running').length,
    retry_wait: statuses.filter((status) => status === 'retry_wait').length,
    quarantined: statuses.filter((status) => status === 'quarantined').length,
  };
}

function seedLineage(grantSha256) {
  return {
    schema_version: 1,
    seed_id: seedId,
    predecessor_status_sha256: predecessorStatusSha256,
    inherited_attempts: 5,
    timeout_recovery_grant_id: grantId,
    timeout_recovery_grant_sha256: grantSha256,
    timeout_recovery_first_missing_page: 2,
    granted_attempt: 6,
    citation_allowed: false,
  };
}

function seedProgress(predecessor, seedStatusSha256, grantSha256) {
  const progress = structuredClone(predecessor);
  progress.predecessor_status = predecessor.status;
  progress.inherited_attempts = predecessor.attempts;
  progress.seed_id = seedId;
  progress.status = 'retry_wait';
  progress.next_retry_at = predecessor.quarantined_at;
  progress.attempt_ceiling = 6;
  progress.timeout_recovery_grant_id = grantId;
  progress.timeout_recovery_grant_sha256 = grantSha256;
  progress.timeout_recovery_first_missing_page = 2;
  delete progress.quarantined_at;
  delete progress.quarantine_reason;
  progress.status_json_sha256 = seedStatusSha256;
  return progress;
}

function interruptedProgress(seed, currentStatusSha256) {
  const progress = structuredClone(seed);
  progress.status = 'running';
  progress.attempts += 1;
  progress.started_at = startedAt;
  delete progress.failure_class;
  delete progress.error;
  delete progress.next_retry_at;
  progress.status = 'interrupted';
  progress.interrupted_at = interruptedAt;
  progress.signal = 'SIGTERM';
  progress.status_json_sha256 = currentStatusSha256;
  return progress;
}

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'curriculum-preinfer-rearm-')));
  const outputRoot = path.join(base, 'output');
  const predecessorRoot = path.join(base, 'predecessor');
  const evidenceRoot = path.join(base, 'evidence');
  const lifecycleLock = path.join(base, '.a2-lifecycle.lock');
  for (const directory of [outputRoot, predecessorRoot, evidenceRoot]) {
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
  }
  await writeOwned(lifecycleLock, Buffer.from(''));
  for (const directory of [
    'documents/legacy-compendium-english/pages/0001',
    'status',
    'logs',
    'seed-predecessor-evidence',
    'timeout-recovery-issuance',
  ]) await mkdir(path.join(outputRoot, directory), { recursive: true, mode: 0o700 });
  await writeOwned(
    path.join(outputRoot, 'documents', documentId, 'pages', '0001', 'content.md'),
    Buffer.from('inherited page\n'),
  );
  const state = {
    schema_version: 1,
    document_id: documentId,
    source_sha256: '1'.repeat(64),
    page_count: 2,
    completed_pages: [1],
    failed_pages: {},
    pages: { '1': { status: 'ocr_complete_pending_audit' } },
    citation_allowed: false,
  };
  const stateRecord = await writeJson(
    path.join(outputRoot, 'documents', documentId, 'state.json'),
    state,
  );
  const documentTree = await inspectTreeStrict(path.join(outputRoot, 'documents', documentId));
  const predecessorProgress = {
    status: 'quarantined',
    attempts: 5,
    page_count: 2,
    started_at: '2026-07-21T23:59:00.000Z',
    failed_at: '2026-07-22T00:00:00.000Z',
    error: 'attempt 5 idle timeout',
    status_json_sha256: predecessorStatusSha256,
    quarantined_at: '2026-07-22T00:00:01.000Z',
    quarantine_reason: 'attempt_budget_exhausted',
  };
  const predecessorRunStatus = {
    schema_version: 1,
    manifest_sha256: '2'.repeat(64),
    runtime_fingerprint_sha256: '3'.repeat(64),
    document_recovery: {},
    citation_allowed: false,
    started_at: '2026-07-21T20:00:00.000Z',
    documents: {
      [documentId]: predecessorProgress,
      complete: { status: 'complete', attempts: 1, page_count: 1 },
    },
    counts: {
      total: 2,
      complete: 1,
      failed: 0,
      interrupted: 0,
      pending: 0,
      running: 0,
      retry_wait: 0,
      quarantined: 1,
    },
    finished: false,
    settled: true,
    updated_at: '2026-07-22T00:00:01.000Z',
  };
  const archivedRun = await writeJson(
    path.join(outputRoot, 'seed-predecessor-evidence', 'run-status.json'),
    predecessorRunStatus,
    true,
  );

  const grant = {
    schema_version: 1,
    grant_id: grantId,
    documents: [{
      document_id: documentId,
      inherited_attempts: 5,
      granted_attempt: 6,
      first_missing_page: 2,
    }],
    citation_allowed: false,
  };
  const grantRecord = await writeJson(
    path.join(outputRoot, 'timeout-recovery-grant.json'),
    grant,
    true,
  );
  const outputInfo = await stat(outputRoot, { bigint: true });
  const claim = {
    schema_version: 1,
    grant_id: grantId,
    granted_documents: [{ document_id: documentId }],
    successor: {
      seed_id: seedId,
      output_root: outputRoot,
      output_device: String(outputInfo.dev),
      output_inode: String(outputInfo.ino),
    },
    citation_allowed: false,
  };
  const claimRecord = await writeJson(
    path.join(outputRoot, 'timeout-recovery-consumption-claim.json'),
    claim,
    true,
  );
  await writeJson(
    path.join(outputRoot, 'timeout-recovery-ledger-identity.json'),
    { schema_version: 1, ledger_id: '4'.repeat(64), citation_allowed: false },
    true,
  );
  const issuanceName = `${'5'.repeat(64)}.issuance.json`;
  const issuanceRecord = await writeJson(
    path.join(outputRoot, 'timeout-recovery-issuance', issuanceName),
    { schema_version: 1, grant_id: grantId, citation_allowed: false },
    true,
  );

  const seededStatus = {
    schema_version: 1,
    document_id: documentId,
    status: 'retry_wait',
    attempt: 5,
    max_attempts: 6,
    next_retry_at: predecessorProgress.quarantined_at,
    page_count: 2,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    citation_allowed: false,
    error: predecessorProgress.error,
    failed_at: predecessorProgress.failed_at,
    seed_lineage: seedLineage(grantRecord.sha256),
  };
  const seededStatusRaw = json(seededStatus);
  const seededStatusSha256 = digest(seededStatusRaw);
  const receipt = {
    schema_version: 1,
    receipt_type: 'curriculum_remote_ocr_hash_bound_output_seed',
    status: 'prepared_commit_marker_required',
    seed_id: seedId,
    predecessor: { run_status_sha256: archivedRun.sha256 },
    successor: {},
    timeout_recovery_grant: { grant_id: grantId, raw_sha256: grantRecord.sha256 },
    timeout_recovery_consumption: { claim_sha256: claimRecord.sha256 },
    timeout_recovery_issuance: { raw_sha256: issuanceRecord.sha256 },
    documents: [{
      document_id: documentId,
      page_count: 2,
      predecessor_status: 'quarantined',
      predecessor_status_sha256: predecessorStatusSha256,
      inherited_attempts: 5,
      successor_document_tree: {
        tree_sha256: documentTree.tree_sha256,
        files: documentTree.files,
        bytes: documentTree.bytes,
      },
      successor_state_sha256: stateRecord.sha256,
      successor_status_sha256: seededStatusSha256,
      timeout_recovery: {
        grant_id: grantId,
        grant_raw_sha256: grantRecord.sha256,
        granted_attempt: 6,
        first_missing_page: 2,
      },
    }],
    citation_allowed: false,
  };
  const receiptRecord = await writeJson(path.join(outputRoot, 'seed-receipt.json'), receipt, true);
  const identity = {
    schema_version: 1,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    seed_lineage: {
      seed_id: seedId,
      seed_receipt_sha256: receiptRecord.sha256,
      timeout_recovery_grant_id: grantId,
      timeout_recovery_claim_sha256: claimRecord.sha256,
      timeout_recovery_issuance_sha256: issuanceRecord.sha256,
    },
    citation_allowed: false,
  };
  await writeJson(path.join(outputRoot, 'run-identity.json'), identity);
  await writeJson(path.join(outputRoot, 'seed-commit.json'), {
    schema_version: 1,
    seed_id: seedId,
    seed_receipt_sha256: receiptRecord.sha256,
    citation_allowed: false,
  }, true);
  await writeJson(path.join(outputRoot, '.seed-journal.json'), {
    schema_version: 1,
    seed_id: seedId,
    seed_receipt_sha256: receiptRecord.sha256,
    citation_allowed: false,
  }, true);

  const currentStatus = {
    schema_version: 1,
    document_id: documentId,
    status: 'interrupted',
    attempt: 6,
    max_attempts: 6,
    page_count: 2,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    citation_allowed: false,
    interrupted_at: interruptedAt,
    seed_lineage: seedLineage(grantRecord.sha256),
  };
  const currentStatusRecord = await writeJson(
    path.join(outputRoot, 'status', `${documentId}.json`),
    currentStatus,
    true,
  );
  const seededProgress = seedProgress(predecessorProgress, seededStatusSha256, grantRecord.sha256);
  const documents = {
    [documentId]: interruptedProgress(seededProgress, currentStatusRecord.sha256),
    complete: { status: 'complete', attempts: 1, page_count: 1 },
  };
  const runStatus = {
    schema_version: 1,
    manifest_sha256: '2'.repeat(64),
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    document_recovery: {},
    citation_allowed: false,
    started_at: '2026-07-21T20:00:00.000Z',
    documents,
    seed_lineage: { seed_id: seedId, citation_allowed: false },
    updated_at: '2026-07-22T02:32:48.000Z',
    counts: counts(documents),
    finished: false,
    settled: false,
  };
  const runStatusRecord = await writeJson(path.join(outputRoot, 'run-status.json'), runStatus, true);
  const logRaw = Buffer.from('Paddle startup warning before inference\n');
  await writeOwned(path.join(outputRoot, 'logs', `${documentId}.log`), logRaw);

  const rawOptions = {
    output_root: outputRoot,
    predecessor_root: predecessorRoot,
    evidence_root: evidenceRoot,
    lifecycle_lock: lifecycleLock,
    document_id: documentId,
    worker_unit: 'curriculum-ocr-reprocess-a-r2.service',
    monitor_unit: 'curriculum-ocr-reprocess-a-r2-monitor.service',
    monitor_timer_unit: 'curriculum-ocr-reprocess-a-r2-monitor.timer',
    retry_timer_unit: 'curriculum-ocr-monitor-alert-retry@a2.timer',
    alert_unit: 'curriculum-ocr-monitor-alert@a2.service',
    expected_output_inode: String(outputInfo.ino),
    expected_worker_invocation_id: '9'.repeat(32),
    expected_started_at: startedAt,
    expected_interrupted_at: interruptedAt,
    repair_at: repairAt,
    expected_run_status_sha256: runStatusRecord.sha256,
    expected_document_status_sha256: currentStatusRecord.sha256,
    expected_log_sha256: digest(logRaw),
    expected_log_bytes: String(logRaw.byteLength),
    expected_state_sha256: stateRecord.sha256,
    expected_document_tree_sha256: documentTree.tree_sha256,
  };
  const quiescent = {
    LoadState: 'loaded',
    ActiveState: 'inactive',
    SubState: 'dead',
    MainPID: '0',
    InvocationID: '',
    ExecMainStatus: '0',
  };
  const dependencies = {
    incidentProfile: {
      outputRoot,
      predecessorRoot,
      evidenceRoot,
      lifecycleLock,
      documentId,
      workerUnit: rawOptions.worker_unit,
      monitorUnit: rawOptions.monitor_unit,
      monitorTimerUnit: rawOptions.monitor_timer_unit,
      retryTimerUnit: rawOptions.retry_timer_unit,
      alertUnit: rawOptions.alert_unit,
      expectedOutputInode: rawOptions.expected_output_inode,
      expectedWorkerInvocationId: rawOptions.expected_worker_invocation_id,
      expectedStartedAt: rawOptions.expected_started_at,
      expectedInterruptedAt: rawOptions.expected_interrupted_at,
    },
    acquireLifecycleLock: async () => async () => {},
    inspectUnit: async (unit, role) => {
      if (role.endsWith('_timer')) {
        return {
          LoadState: 'loaded',
          ActiveState: 'inactive',
          SubState: 'dead',
          InvocationID: '',
        };
      }
      return unit === rawOptions.worker_unit
        ? { ...quiescent, ActiveState: 'failed', SubState: 'failed', InvocationID: '9'.repeat(32), ExecMainStatus: '75' }
        : quiescent;
    },
    validateSeed: async () => ({ successor: {} }),
  };
  return {
    base,
    outputRoot,
    evidenceRoot,
    rawOptions,
    dependencies,
    seededStatusSha256,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

async function rewriteHashBound(pathname, mutate) {
  const value = JSON.parse(await readFile(pathname, 'utf8'));
  mutate(value);
  return writeJson(pathname, value, true);
}

test('two dry-runs are byte-identical and prove exact attempt-5 reconstruction', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const options = validateRepairOptions(f.rawOptions);
  const first = await repairPreInferenceInterruption(options, f.dependencies);
  const second = await repairPreInferenceInterruption(options, f.dependencies);
  assert.deepEqual(second, first);
  assert.equal(first.state, 'ready');
  assert.equal(first.attempt, 5);
  assert.equal(first.after_document_status_sha256, f.seededStatusSha256);
  await assert.rejects(stat(first.evidence_path), /ENOENT/u);
});

test('the executable rejects every incident except the embedded production A2 identity', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  let touched = false;
  await assert.rejects(
    repairPreInferenceInterruption(validateRepairOptions(f.rawOptions), {
      acquireLifecycleLock: async () => {
        touched = true;
        return async () => {};
      },
    }),
    /outputRoot differs from the one authorized A2 pre-inference incident/u,
  );
  assert.equal(touched, false);
});

test('validated camel-case options are fully revalidated at the exported API boundary', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const invalid = validateRepairOptions(f.rawOptions);
  invalid.repairAt = 'not-a-timestamp';
  let touched = false;
  await assert.rejects(
    repairPreInferenceInterruption(invalid, {
      ...f.dependencies,
      acquireLifecycleLock: async () => {
        touched = true;
        return async () => {};
      },
    }),
    /canonical ISO timestamp/u,
  );
  assert.equal(touched, false);
});

test('Linux util-linux flock remains held by the inherited parent descriptor', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'curriculum-rearm-flock-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const lockPath = path.join(base, 'lifecycle.lock');
  await writeOwned(lockPath, Buffer.from(''));
  const release = await acquireLifecycleLock(lockPath);
  t.after(release);
  await assert.rejects(
    execFile('/usr/bin/flock', [
      '--exclusive',
      '--nonblock',
      lockPath,
      '/usr/bin/true',
    ]),
    (error) => error?.code === 1,
  );
  await release();
  await execFile('/usr/bin/flock', [
    '--exclusive',
    '--nonblock',
    lockPath,
    '/usr/bin/true',
  ]);
});

test('real Linux service and timer systemd-show schemas remain role-exact', () => {
  assert.deepEqual(parseSystemdShow([
    'LoadState=loaded',
    'ActiveState=failed',
    'SubState=failed',
    'MainPID=0',
    'InvocationID=0916aeada09b4f38bb7b4b17b6063712',
    'ExecMainStatus=75',
    '',
  ].join('\n'), 'curriculum-ocr-reprocess-a-r2.service', 'worker'), {
    LoadState: 'loaded',
    ActiveState: 'failed',
    SubState: 'failed',
    MainPID: '0',
    InvocationID: '0916aeada09b4f38bb7b4b17b6063712',
    ExecMainStatus: '75',
  });
  assert.deepEqual(parseSystemdShow([
    'LoadState=loaded',
    'ActiveState=inactive',
    'SubState=dead',
    'InvocationID=',
    '',
  ].join('\n'), 'curriculum-ocr-reprocess-a-r2-monitor.timer', 'monitor_timer'), {
    LoadState: 'loaded',
    ActiveState: 'inactive',
    SubState: 'dead',
    InvocationID: '',
  });
  assert.throws(
    () => parseSystemdShow([
      'LoadState=loaded',
      'ActiveState=inactive',
      'SubState=dead',
      'MainPID=0',
      'InvocationID=',
      'ExecMainStatus=0',
      '',
    ].join('\n'), 'curriculum-ocr-reprocess-a-r2-monitor.timer', 'monitor_timer'),
    /property set is invalid/u,
  );
  assert.throws(
    () => parseSystemdShow([
      'LoadState=loaded',
      'ActiveState=inactive',
      'SubState=dead',
      `InvocationID=${'1'.repeat(32)}`,
      '',
    ].join('\n'), 'curriculum-ocr-reprocess-a-r2-monitor.timer', 'monitor_timer'),
    /property values are invalid/u,
  );
  assert.deepEqual(parseSystemdShow([
    'LoadState=loaded',
    'ActiveState=failed',
    'SubState=failed',
    'MainPID=0',
    `InvocationID=${'2'.repeat(32)}`,
    'ExecMainStatus=12',
    '',
  ].join('\n'), 'curriculum-ocr-reprocess-a-r2-monitor.service', 'monitor'), {
    LoadState: 'loaded',
    ActiveState: 'failed',
    SubState: 'failed',
    MainPID: '0',
    InvocationID: '2'.repeat(32),
    ExecMainStatus: '12',
  });
  assert.deepEqual(parseSystemdShow([
    'LoadState=loaded',
    'ActiveState=failed',
    'SubState=failed',
    'MainPID=0',
    `InvocationID=${'3'.repeat(32)}`,
    'ExecMainStatus=0',
    '',
  ].join('\n'), 'curriculum-ocr-monitor-alert@a2.service', 'alert'), {
    LoadState: 'loaded',
    ActiveState: 'failed',
    SubState: 'failed',
    MainPID: '0',
    InvocationID: '3'.repeat(32),
    ExecMainStatus: '0',
  });
});

test('apply snapshots evidence, mutates only four controls, and is idempotent', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const beforeOther = JSON.parse(await readFile(path.join(f.outputRoot, 'run-status.json'), 'utf8')).documents.complete;
  const applied = await repairPreInferenceInterruption(
    validateRepairOptions({ ...f.rawOptions, apply: true }),
    f.dependencies,
  );
  assert.equal(applied.state, 'applied');
  assert.equal(applied.replacements, 4);
  const afterRun = JSON.parse(await readFile(path.join(f.outputRoot, 'run-status.json'), 'utf8'));
  assert.equal(afterRun.documents[documentId].status, 'retry_wait');
  assert.equal(afterRun.documents[documentId].attempts, 5);
  assert.deepEqual(afterRun.documents.complete, beforeOther);
  assert.equal(afterRun.counts.retry_wait, 1);
  assert.equal(afterRun.counts.interrupted, 0);
  assert.equal(afterRun.citation_allowed, false);
  assert.equal((await stat(applied.evidence_path)).mode & 0o7777, 0o700);
  assert.equal((await stat(path.join(applied.evidence_path, 'before', 'logs', `${documentId}.log`))).mode & 0o7777, 0o600);

  const again = await repairPreInferenceInterruption(
    validateRepairOptions({ ...f.rawOptions, apply: true }),
    f.dependencies,
  );
  assert.equal(again.state, 'already_applied');
  assert.equal(again.replacements, 0);
});

test('a mixed crash state resumes only exact before/after members', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  let injected = false;
  await assert.rejects(
    repairPreInferenceInterruption(
      validateRepairOptions({ ...f.rawOptions, apply: true }),
      {
        ...f.dependencies,
        afterReplacement: async (index) => {
          if (index === 2 && !injected) {
            injected = true;
            throw new Error('simulated power loss');
          }
        },
      },
    ),
    /simulated power loss/u,
  );
  const resumed = await repairPreInferenceInterruption(
    validateRepairOptions({ ...f.rawOptions, apply: true }),
    f.dependencies,
  );
  assert.equal(resumed.state, 'applied');
  assert.equal(resumed.replacements, 2);
  const progress = JSON.parse(await readFile(path.join(f.outputRoot, 'run-status.json'), 'utf8'))
    .documents[documentId];
  assert.equal(progress.status, 'retry_wait');
  assert.equal(progress.attempts, 5);
});

test('crash resume rejects unrelated output drift before replacing a remaining control', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const unrelatedLog = path.join(f.outputRoot, 'logs', 'complete.log');
  await writeOwned(unrelatedLog, Buffer.from('stable unrelated log\n'));
  await assert.rejects(
    repairPreInferenceInterruption(
      validateRepairOptions({ ...f.rawOptions, apply: true }),
      {
        ...f.dependencies,
        afterReplacement: async (index) => {
          if (index === 2) throw new Error('simulated crash before run-status replacement');
        },
      },
    ),
    /simulated crash/u,
  );
  const runStatusBeforeResume = await readFile(path.join(f.outputRoot, 'run-status.json'));
  await writeOwned(unrelatedLog, Buffer.from('drifted unrelated log\n'));
  await assert.rejects(
    repairPreInferenceInterruption(
      validateRepairOptions({ ...f.rawOptions, apply: true }),
      f.dependencies,
    ),
    /repair receipt is not bound to this exact incident/u,
  );
  assert.deepEqual(
    await readFile(path.join(f.outputRoot, 'run-status.json')),
    runStatusBeforeResume,
  );
});

test('crash resume rejects self-consistent forged after bytes before mutation', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const dry = await repairPreInferenceInterruption(
    validateRepairOptions(f.rawOptions),
    f.dependencies,
  );
  await assert.rejects(
    repairPreInferenceInterruption(
      validateRepairOptions({ ...f.rawOptions, apply: true }),
      {
        ...f.dependencies,
        afterReplacement: async (index) => {
          if (index === 2) throw new Error('simulated crash before run-status replacement');
        },
      },
    ),
    /simulated crash/u,
  );
  const liveRunPath = path.join(f.outputRoot, 'run-status.json');
  const liveRunBeforeResume = await readFile(liveRunPath);
  const forgedAfterPath = path.join(dry.evidence_path, 'after', 'run-status.json');
  const forgedAfter = JSON.parse(await readFile(forgedAfterPath, 'utf8'));
  forgedAfter.updated_at = '2026-07-22T03:11:00.000Z';
  const forgedRaw = json(forgedAfter);
  const forgedSha256 = digest(forgedRaw);
  const forgedSidecarRaw = sidecar(forgedSha256, 'run-status.json');
  await writeOwned(forgedAfterPath, forgedRaw);
  await writeOwned(`${forgedAfterPath}.sha256`, forgedSidecarRaw);

  const receiptPath = path.join(dry.evidence_path, 'repair-receipt.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const replaceArtifact = (relative, raw) => {
    const record = receipt.evidence_artifacts.find(({ path: pathname }) => pathname === relative);
    assert.ok(record);
    record.bytes = raw.byteLength;
    record.sha256 = digest(raw);
    return { path: relative, bytes: raw.byteLength, sha256: digest(raw) };
  };
  receipt.after_run_status_sha256 = forgedSha256;
  replaceArtifact('after/run-status.json', forgedRaw);
  replaceArtifact('after/run-status.json.sha256', forgedSidecarRaw);
  receipt.transaction.find(({ output_path: value }) => value === 'run-status.json').after = {
    path: 'after/run-status.json',
    bytes: forgedRaw.byteLength,
    sha256: forgedSha256,
  };
  receipt.transaction.find(({ output_path: value }) => value === 'run-status.json.sha256').after = {
    path: 'after/run-status.json.sha256',
    bytes: forgedSidecarRaw.byteLength,
    sha256: digest(forgedSidecarRaw),
  };
  await writeJson(receiptPath, receipt, true);

  await assert.rejects(
    repairPreInferenceInterruption(
      validateRepairOptions({ ...f.rawOptions, apply: true }),
      f.dependencies,
    ),
    /was not reconstructed from trusted controls/u,
  );
  assert.deepEqual(await readFile(liveRunPath), liveRunBeforeResume);
});

test('an exact leftover transaction temp is cleaned but a third-byte temp fails closed', async (t) => {
  await t.test('exact after temp', async (st) => {
    const f = await fixture();
    st.after(f.cleanup);
    const applied = await repairPreInferenceInterruption(
      validateRepairOptions({ ...f.rawOptions, apply: true }),
      f.dependencies,
    );
    const target = path.join(f.outputRoot, 'run-status.json');
    const temporary = path.join(f.outputRoot, `.run-status.json.${applied.repair_id}.rearm-tmp`);
    await writeOwned(temporary, await readFile(target));
    const resumed = await repairPreInferenceInterruption(
      validateRepairOptions({ ...f.rawOptions, apply: true }),
      f.dependencies,
    );
    assert.equal(resumed.state, 'already_applied');
    await assert.rejects(stat(temporary), /ENOENT/u);
  });
  await t.test('third-byte temp', async (st) => {
    const f = await fixture();
    st.after(f.cleanup);
    const applied = await repairPreInferenceInterruption(
      validateRepairOptions({ ...f.rawOptions, apply: true }),
      f.dependencies,
    );
    const temporary = path.join(
      f.outputRoot,
      `.run-status.json.${applied.repair_id}.rearm-tmp`,
    );
    await writeOwned(temporary, Buffer.from('not receipt-bound bytes\n'));
    await assert.rejects(
      repairPreInferenceInterruption(
        validateRepairOptions({ ...f.rawOptions, apply: true }),
        f.dependencies,
      ),
      /temporary file differs from exact after bytes/u,
    );
  });
});

test('changed page or state is rejected even when the operator updates the claimed hash', async (t) => {
  await t.test('page', async (st) => {
    const f = await fixture();
    st.after(f.cleanup);
    await writeOwned(
      path.join(f.outputRoot, 'documents', documentId, 'pages', '0001', 'content.md'),
      Buffer.from('changed page\n'),
    );
    const tree = await inspectTreeStrict(path.join(f.outputRoot, 'documents', documentId));
    await assert.rejects(
      repairPreInferenceInterruption(
        validateRepairOptions({ ...f.rawOptions, expected_document_tree_sha256: tree.tree_sha256 }),
        f.dependencies,
      ),
      /page\/state tree changed/u,
    );
  });
  await t.test('state', async (st) => {
    const f = await fixture();
    st.after(f.cleanup);
    const record = await rewriteHashBound(
      path.join(f.outputRoot, 'documents', documentId, 'state.json'),
      (value) => { value.unexpected = true; },
    );
    const tree = await inspectTreeStrict(path.join(f.outputRoot, 'documents', documentId));
    await assert.rejects(
      repairPreInferenceInterruption(
        validateRepairOptions({
          ...f.rawOptions,
          expected_state_sha256: record.sha256,
          expected_document_tree_sha256: tree.tree_sha256,
        }),
        f.dependencies,
      ),
      /page\/state tree changed/u,
    );
  });
});

test('changed log or document status fails against the frozen incident hashes', async (t) => {
  await t.test('log', async (st) => {
    const f = await fixture();
    st.after(f.cleanup);
    await writeOwned(path.join(f.outputRoot, 'logs', `${documentId}.log`), Buffer.from('changed\n'));
    await assert.rejects(
      repairPreInferenceInterruption(validateRepairOptions(f.rawOptions), f.dependencies),
      /differs from the frozen incident/u,
    );
  });
  await t.test('status', async (st) => {
    const f = await fixture();
    st.after(f.cleanup);
    await rewriteHashBound(path.join(f.outputRoot, 'status', `${documentId}.json`), (value) => {
      value.interrupted_at = '2026-07-22T02:32:47.129Z';
    });
    await assert.rejects(
      repairPreInferenceInterruption(validateRepairOptions(f.rawOptions), f.dependencies),
      /differs from the frozen incident/u,
    );
  });
});

test('active unit and held lifecycle flock fail before any evidence write', async (t) => {
  await t.test('active unit', async (st) => {
    const f = await fixture();
    st.after(f.cleanup);
    await assert.rejects(
      repairPreInferenceInterruption(validateRepairOptions(f.rawOptions), {
        ...f.dependencies,
        inspectUnit: async (unit, role) => (
          unit === f.rawOptions.monitor_unit
            ? { LoadState: 'loaded', ActiveState: 'active', SubState: 'running', MainPID: '42', InvocationID: '', ExecMainStatus: '0' }
            : f.dependencies.inspectUnit(unit, role)
        ),
      }),
      /is not quiescent/u,
    );
  });
  await t.test('held lock', async (st) => {
    const f = await fixture();
    st.after(f.cleanup);
    await assert.rejects(
      repairPreInferenceInterruption(validateRepairOptions(f.rawOptions), {
        ...f.dependencies,
        acquireLifecycleLock: async () => { throw new Error('lifecycle flock is held'); },
      }),
      /flock is held/u,
    );
  });
  await t.test('lock lost before publication', async (st) => {
    const f = await fixture();
    st.after(f.cleanup);
    let checks = 0;
    const release = async () => {};
    release.assertHeld = () => {
      checks += 1;
      if (checks > 1) throw new Error('lifecycle flock was lost');
    };
    await assert.rejects(
      repairPreInferenceInterruption(
        validateRepairOptions({ ...f.rawOptions, apply: true }),
        { ...f.dependencies, acquireLifecycleLock: async () => release },
      ),
      /flock was lost/u,
    );
    assert.deepEqual(await readdir(f.evidenceRoot), []);
  });
});

test('second grant or claim and pre-existing evidence collision fail closed', async (t) => {
  await t.test('second grant', async (st) => {
    const f = await fixture();
    st.after(f.cleanup);
    await writeJson(path.join(f.outputRoot, 'timeout-recovery-grant-second.json'), { citation_allowed: false });
    await assert.rejects(
      repairPreInferenceInterruption(validateRepairOptions(f.rawOptions), f.dependencies),
      /second timeout-recovery grant/u,
    );
  });
  await t.test('second claim', async (st) => {
    const f = await fixture();
    st.after(f.cleanup);
    await writeJson(path.join(f.outputRoot, 'timeout-recovery-consumption-claim-second.json'), { citation_allowed: false });
    await assert.rejects(
      repairPreInferenceInterruption(validateRepairOptions(f.rawOptions), f.dependencies),
      /second timeout-recovery grant or consumption claim/u,
    );
  });
  await t.test('evidence collision', async (st) => {
    const f = await fixture();
    st.after(f.cleanup);
    const dry = await repairPreInferenceInterruption(validateRepairOptions(f.rawOptions), f.dependencies);
    await mkdir(dry.evidence_path, { mode: 0o700 });
    await writeOwned(path.join(dry.evidence_path, 'foreign'), Buffer.from('collision\n'));
    await assert.rejects(
      repairPreInferenceInterruption(
        validateRepairOptions({ ...f.rawOptions, apply: true }),
        f.dependencies,
      ),
      /evidence collision: reservation is missing/u,
    );
  });
});

test('noncanonical timestamps and extra current fields are rejected', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  assert.throws(
    () => validateRepairOptions({ ...f.rawOptions, expected_started_at: '2026-07-22 02:32:45Z' }),
    /canonical ISO timestamp/u,
  );
  const runPath = path.join(f.outputRoot, 'run-status.json');
  const changed = await rewriteHashBound(runPath, (value) => {
    value.documents[documentId].unexpected = 'field';
  });
  await assert.rejects(
    repairPreInferenceInterruption(
      validateRepairOptions({ ...f.rawOptions, expected_run_status_sha256: changed.sha256 }),
      f.dependencies,
    ),
    /unexpected or extra fields/u,
  );
});

test('real frozen A2 dry-run crosses Linux flock, systemd, and full B1/B2 inspectors', {
  skip: process.platform !== 'linux'
    || process.env.CURRICULUM_A2_REAL_INTEGRATION !== '1',
}, async () => {
  const runRoot = '/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess';
  const outputRoot = `${runRoot}/output/production-p1-mb16-shard-a-r2`;
  const predecessorRoot = `${runRoot}/output/production-p4-mb16-shard-a-r1`;
  const evidenceRoot = `${runRoot}/a2-deploy-evidence/20260719T003812Z`;
  const receipt = JSON.parse(await readFile(path.join(outputRoot, 'seed-receipt.json'), 'utf8'));
  const receiptDocument = receipt.documents.find(({ document_id: value }) => value === documentId);
  assert.ok(receiptDocument);
  assert.ok(process.env.CURRICULUM_A2_REPAIR_AT);
  const raw = {
    output_root: outputRoot,
    predecessor_root: predecessorRoot,
    evidence_root: evidenceRoot,
    lifecycle_lock: `${runRoot}/.a2-lifecycle.lock`,
    document_id: documentId,
    worker_unit: 'curriculum-ocr-reprocess-a-r2.service',
    monitor_unit: 'curriculum-ocr-reprocess-a-r2-monitor.service',
    monitor_timer_unit: 'curriculum-ocr-reprocess-a-r2-monitor.timer',
    retry_timer_unit: 'curriculum-ocr-monitor-alert-retry@curriculum-ocr-reprocess-a-r2-monitor.service.timer',
    alert_unit: 'curriculum-ocr-monitor-alert@curriculum-ocr-reprocess-a-r2-monitor.service.service',
    expected_output_inode: '45748776',
    expected_worker_invocation_id: '0916aeada09b4f38bb7b4b17b6063712',
    expected_started_at: startedAt,
    expected_interrupted_at: interruptedAt,
    repair_at: process.env.CURRICULUM_A2_REPAIR_AT,
    expected_run_status_sha256: '1efe426705557843ee0023abf556890e8df2a4052cef13d82e9e7d04111c98e7',
    expected_document_status_sha256: '3cf110083dc94c6d5bf9eebd4c42ab8243eb9a8528abccac9dc27d56a6bde6cb',
    expected_log_sha256: '2a55211f63eac4f946d19d2c2c4309b4da8c6db65834f62268f0f0fd10ba6c6a',
    expected_log_bytes: '1189',
    expected_state_sha256: 'd16de657043c260136552cd8cf881791f42308169e2ecf55fe0cab5f155aa09d',
    expected_document_tree_sha256: receiptDocument.successor_document_tree.tree_sha256,
  };
  const mutable = [
    path.join(outputRoot, 'status', `${documentId}.json`),
    path.join(outputRoot, 'status', `${documentId}.json.sha256`),
    path.join(outputRoot, 'run-status.json'),
    path.join(outputRoot, 'run-status.json.sha256'),
  ];
  const before = await Promise.all(mutable.map((pathname) => readFile(pathname)));
  const first = await repairPreInferenceInterruption(raw);
  const second = await repairPreInferenceInterruption(raw);
  assert.deepEqual(second, first);
  assert.equal(first.valid, true);
  assert.equal(first.mode, 'dry_run');
  assert.equal(first.citation_allowed, false);
  const after = await Promise.all(mutable.map((pathname) => readFile(pathname)));
  assert.deepEqual(after, before);
});
