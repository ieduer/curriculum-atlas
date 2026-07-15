#!/usr/bin/env node
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const root = path.resolve(new URL('../', import.meta.url).pathname);
const supervisorRoot = path.join(root, '.cache/ocr-supervisor');
const watchdogLockDir = path.join(supervisorRoot, 'watchdog-lock');
const statePath = path.join(supervisorRoot, 'watchdog-state.json');
const controlPath = path.join(supervisorRoot, 'watchdog-control.json');
const incidentsPath = path.join(supervisorRoot, 'watchdog-incidents.jsonl');
const drainOwnerPath = path.join(supervisorRoot, 'drain-lock/owner.json');
const batchOwnerPath = path.join(supervisorRoot, 'lock/owner.json');
const drainStatePath = path.join(supervisorRoot, 'drain-state.json');
const currentRunPath = path.join(supervisorRoot, 'current-run.json');
const supervisorPath = path.join(root, 'scripts/ocr-supervisor.mjs');
const logPath = path.join(supervisorRoot, 'watchdog-drain.log');
const [command = 'run', ...args] = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const nowIso = () => new Date().toISOString();
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const defaults = Object.freeze({
  mode: 'run',
  batch_pages: 64,
  poll_seconds: 15,
  stale_heartbeat_seconds: 180,
  stale_confirmations: 2,
  recover_stalled_owner: true,
  auto_recover_single_page: true,
  llama_parallel: 3,
  vl_rec_max_concurrency: 3,
});

let shutdownRequested = false;
let activeChild = null;
let lockOwned = false;
let staleConfirmations = 0;

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

async function writeState(status, details = {}) {
  await atomicJson(statePath, {
    schema_version: 1,
    watchdog_pid: process.pid,
    status,
    updated_at: nowIso(),
    ...details,
  });
}

async function incident(code, message, details = {}) {
  const entry = { timestamp: nowIso(), code, message, ...details };
  await appendFile(incidentsPath, `${JSON.stringify(entry)}\n`, 'utf8');
  await writeState('incident', entry);
}

async function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function processIdentity(pid, expectedMode) {
  if (!await processAlive(pid)) return { valid: false, reason: 'not_alive' };
  try {
    const [{ stdout: commandLine }, { stdout: cwdLines }] = await Promise.all([
      execFile('/bin/ps', ['-p', String(pid), '-o', 'command=']),
      execFile('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']),
    ]);
    const cwd = cwdLines.split('\n').find((line) => line.startsWith('n'))?.slice(1) || '';
    const hasSupervisor = commandLine.includes('scripts/ocr-supervisor.mjs');
    const hasMode = new RegExp(`(?:^|\\s)${expectedMode}(?:\\s|$)`).test(commandLine);
    return {
      valid: hasSupervisor && hasMode && path.resolve(cwd) === root,
      command: commandLine.trim(),
      cwd,
      reason: hasSupervisor && hasMode ? 'cwd_mismatch' : 'command_mismatch',
    };
  } catch (error) {
    return { valid: false, reason: `identity_check_failed:${error.code || error.message}` };
  }
}

function heartbeatAgeSeconds(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? Math.max(0, (Date.now() - parsed) / 1000) : Infinity;
}

async function inspectOwners() {
  const [drainOwner, batchOwner, drainState, currentRun] = await Promise.all([
    readJson(drainOwnerPath),
    readJson(batchOwnerPath),
    readJson(drainStatePath),
    readJson(currentRunPath),
  ]);
  const [drainAlive, batchAlive] = await Promise.all([
    processAlive(drainOwner?.pid),
    processAlive(batchOwner?.pid),
  ]);
  const owner = drainAlive ? { type: 'drain', ...drainOwner }
    : batchAlive ? { type: 'batch', ...batchOwner }
      : null;
  const heartbeatAt = batchAlive && currentRun?.pid === batchOwner?.pid
    ? currentRun.heartbeat_at
    : drainAlive && drainState?.pid === drainOwner?.pid
      ? drainState.heartbeat_at
      : null;
  return {
    owner,
    heartbeat_at: heartbeatAt,
    heartbeat_age_seconds: heartbeatAgeSeconds(heartbeatAt),
    stage: batchAlive ? currentRun?.stage : drainState?.stage,
    run_id: currentRun?.run_id || null,
    drain_id: drainOwner?.drain_id || null,
    document_id: currentRun?.document_id || null,
    pages: currentRun?.pages || [],
  };
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

async function control() {
  const saved = await readJson(controlPath, {});
  return {
    ...defaults,
    ...saved,
    mode: saved.mode === 'hold' ? 'hold' : 'run',
    batch_pages: boundedInteger(saved.batch_pages, defaults.batch_pages, 1, 64),
    poll_seconds: boundedInteger(saved.poll_seconds, defaults.poll_seconds, 5, 300),
    stale_heartbeat_seconds: boundedInteger(saved.stale_heartbeat_seconds, defaults.stale_heartbeat_seconds, 90, 1200),
    stale_confirmations: boundedInteger(saved.stale_confirmations, defaults.stale_confirmations, 2, 10),
    llama_parallel: boundedInteger(saved.llama_parallel, defaults.llama_parallel, 1, 4),
    vl_rec_max_concurrency: boundedInteger(saved.vl_rec_max_concurrency, defaults.vl_rec_max_concurrency, 1, 8),
  };
}

async function acquireLock() {
  await mkdir(supervisorRoot, { recursive: true });
  try {
    await mkdir(watchdogLockDir);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await readJson(path.join(watchdogLockDir, 'owner.json'), {});
    if (await processAlive(owner.pid)) throw new Error(`OCR watchdog already active under PID ${owner.pid}`);
    const stale = `${watchdogLockDir}-stale-${Date.now()}`;
    await rename(watchdogLockDir, stale);
    await mkdir(watchdogLockDir);
  }
  await atomicJson(path.join(watchdogLockDir, 'owner.json'), { pid: process.pid, started_at: nowIso() });
  lockOwned = true;
}

async function releaseLock() {
  const owner = await readJson(path.join(watchdogLockDir, 'owner.json'));
  if (lockOwned && owner?.pid === process.pid) await rm(watchdogLockDir, { recursive: true, force: true });
  lockOwned = false;
}

async function captureSupervisor(subcommand) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [supervisorPath, subcommand], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code: code ?? 128, signal, stdout, stderr }));
  });
}

async function spawnSupervisor(subcommand, subcommandArgs, settings) {
  const logFd = openSync(logPath, 'a', 0o600);
  const env = {
    ...process.env,
    OCR_LLAMA_PARALLEL: String(settings.llama_parallel),
    OCR_VL_REC_MAX_CONCURRENCY: String(settings.vl_rec_max_concurrency),
  };
  try {
    const child = spawn(process.execPath, [supervisorPath, subcommand, ...subcommandArgs], {
      cwd: root,
      env,
      stdio: ['ignore', logFd, logFd],
    });
    activeChild = child;
    await writeState(`starting_${subcommand}`, {
      child_pid: child.pid,
      batch_pages: settings.batch_pages,
      llama_parallel: settings.llama_parallel,
      vl_rec_max_concurrency: settings.vl_rec_max_concurrency,
    });
    const exitPromise = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code: code ?? 128, signal }));
    });
    let result;
    if (subcommand !== 'drain') {
      result = await exitPromise;
    } else {
      while (!result) {
        result = await Promise.race([
          exitPromise,
          sleep(settings.poll_seconds * 1000).then(() => null),
        ]);
        if (result) break;
        const owners = await inspectOwners();
        const isSpawnedOwner = owners.owner?.type === 'drain' && owners.owner.pid === child.pid;
        const stale = isSpawnedOwner && owners.heartbeat_age_seconds >= settings.stale_heartbeat_seconds;
        staleConfirmations = stale ? staleConfirmations + 1 : 0;
        await writeState(isSpawnedOwner ? (stale ? 'stale_owner_observed' : 'observing_active_owner') : 'waiting_for_spawned_owner', {
          child_pid: child.pid,
          llama_parallel: settings.llama_parallel,
          vl_rec_max_concurrency: settings.vl_rec_max_concurrency,
          owner: owners.owner,
          heartbeat_at: owners.heartbeat_at,
          heartbeat_age_seconds: Number.isFinite(owners.heartbeat_age_seconds)
            ? Number(owners.heartbeat_age_seconds.toFixed(1))
            : null,
          stale_confirmations: staleConfirmations,
          stage: owners.stage,
          run_id: owners.run_id,
          drain_id: owners.drain_id,
          document_id: owners.document_id,
          pages: owners.pages,
        });
        if (stale && staleConfirmations >= settings.stale_confirmations) {
          await terminateVerifiedStalledOwner(owners, settings);
          staleConfirmations = 0;
        }
      }
    }
    return result;
  } finally {
    if (activeChild === child) activeChild = null;
    closeSync(logFd);
  }
}

function strictQueueComplete(status) {
  const completed = status?.queue?.completed_pages;
  return status?.health?.exit_code === 0
    && status?.scheduler_state === 'queue_complete'
    && status?.queue?.pending_pages === 0
    && status?.queue?.failed_pages === 0
    && status?.evidence?.witness_pages === completed
    && status?.evidence?.audited_pages === completed
    && status?.evidence?.witness_error_sidecars === 0
    && status?.evidence?.witness_missing_for_completed === 0
    && status?.evidence?.stale_audit_pages === 0;
}

async function terminateVerifiedStalledOwner(observation, settings) {
  if (!settings.recover_stalled_owner || observation.owner?.type !== 'drain') return false;
  const identity = await processIdentity(observation.owner.pid, 'drain');
  const latest = await inspectOwners();
  const stillSame = latest.owner?.type === 'drain'
    && latest.owner.pid === observation.owner.pid
    && latest.drain_id === observation.drain_id
    && latest.heartbeat_age_seconds >= settings.stale_heartbeat_seconds;
  if (!identity.valid || !stillSame) {
    await incident('STALE_OWNER_NOT_SIGNALED', 'Stale OCR owner failed exact PID, command, cwd, lock, or heartbeat revalidation.', {
      owner_pid: observation.owner.pid,
      identity_reason: identity.reason,
    });
    return false;
  }
  await incident('STALE_OWNER_RECOVERY', 'Sending SIGTERM to the exact stale OCR drain owner; supervisor retains completed page artifacts.', {
    owner_pid: observation.owner.pid,
    run_id: observation.run_id,
    drain_id: observation.drain_id,
    heartbeat_age_seconds: Math.round(observation.heartbeat_age_seconds),
  });
  process.kill(observation.owner.pid, 'SIGTERM');
  return true;
}

async function oneCycle(settings, allowMutation = true) {
  const owners = await inspectOwners();
  if (owners.owner) {
    const stale = owners.heartbeat_age_seconds >= settings.stale_heartbeat_seconds;
    staleConfirmations = stale ? staleConfirmations + 1 : 0;
    await writeState(stale ? 'stale_owner_observed' : 'observing_active_owner', {
      owner: owners.owner,
      llama_parallel: settings.llama_parallel,
      vl_rec_max_concurrency: settings.vl_rec_max_concurrency,
      heartbeat_at: owners.heartbeat_at,
      heartbeat_age_seconds: Number(owners.heartbeat_age_seconds.toFixed(1)),
      stale_confirmations: staleConfirmations,
      stage: owners.stage,
      run_id: owners.run_id,
      drain_id: owners.drain_id,
      document_id: owners.document_id,
      pages: owners.pages,
    });
    if (allowMutation && stale && staleConfirmations >= settings.stale_confirmations) {
      await terminateVerifiedStalledOwner(owners, settings);
      staleConfirmations = 0;
    }
    return { action: 'observe', owners };
  }

  staleConfirmations = 0;
  const captured = await captureSupervisor('status');
  let status;
  try { status = JSON.parse(captured.stdout); } catch {
    await incident('STATUS_PARSE_FAILED', 'OCR supervisor status was not valid JSON.', { stderr: captured.stderr.slice(-500) });
    return { action: 'backoff', seconds: 30 };
  }
  if (strictQueueComplete(status)) {
    await writeState('queue_complete', { queue: status.queue, evidence: status.evidence, disk: status.disk });
    return { action: 'complete', seconds: 900 };
  }
  if (settings.mode === 'hold' || !allowMutation) {
    await writeState(settings.mode === 'hold' ? 'held' : 'dry_run', {
      queue: status.queue,
      health: status.health,
      disk: status.disk,
      next_batch: status.next_batch,
    });
    return { action: 'hold', seconds: settings.poll_seconds };
  }
  if (status.disk?.warning || status.health?.exit_code === 12) {
    await incident('FAIL_CLOSED_HARD_STOP', 'OCR watchdog will not restart while disk, checksum, or quarantine hard-stop is active.', {
      health: status.health,
      disk: status.disk,
    });
    return { action: 'hard_stop', seconds: 300 };
  }
  if (status.health?.exit_code === 2) {
    const retryAt = Date.parse(status.health.earliest_retry_at || '');
    const seconds = Number.isFinite(retryAt) ? Math.max(15, Math.ceil((retryAt - Date.now()) / 1000)) : 60;
    await writeState('retry_backoff', { seconds, health: status.health, queue: status.queue });
    return { action: 'backoff', seconds };
  }
  if (status.health?.exit_code === 10 && settings.auto_recover_single_page) {
    const recovery = await spawnSupervisor('recover', ['--batch-pages', '1', '--force-immediate'], settings);
    if (recovery.code !== 0) {
      await incident('RECOVERY_CANARY_FAILED', 'Single-page OCR recovery canary failed; retry is bounded and delayed.', recovery);
      return { action: 'backoff', seconds: 60 };
    }
  }
  const result = await spawnSupervisor('drain', ['--batch-pages', String(settings.batch_pages)], settings);
  if (result.code === 0) return { action: 'drain_exit', seconds: 2, result };
  if (result.code === 75) return { action: 'owner_race', seconds: settings.poll_seconds, result };
  await incident('DRAIN_EXITED', 'OCR drain exited; watchdog will re-evaluate health before any restart.', result);
  return { action: 'backoff', seconds: result.code === 12 ? 300 : 30, result };
}

async function run() {
  await acquireLock();
  const stop = () => {
    shutdownRequested = true;
    if (activeChild?.exitCode === null) activeChild.kill('SIGTERM');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (!shutdownRequested) {
      const settings = await control();
      const outcome = await oneCycle(settings, true);
      const waitSeconds = outcome.seconds || settings.poll_seconds;
      for (let elapsed = 0; !shutdownRequested && elapsed < waitSeconds; elapsed += 1) await sleep(1000);
    }
  } finally {
    await writeState('stopped', { stopped_at: nowIso() }).catch(() => {});
    await releaseLock();
  }
}

await mkdir(supervisorRoot, { recursive: true });
if (command === 'status') {
  console.log(JSON.stringify(await readJson(statePath, { status: 'not_started' }), null, 2));
} else if (command === 'once') {
  console.log(JSON.stringify(await oneCycle(await control(), !dryRun), null, 2));
} else if (command === 'run') {
  await run();
} else {
  console.error('usage: node scripts/ocr-watchdog.mjs <run|once|status> [--dry-run]');
  process.exitCode = 64;
}
