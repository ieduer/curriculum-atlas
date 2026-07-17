#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VISION_LAUNCHER_BUFFER_LIMIT_BYTES = 8 * 1024 * 1024;
export const VISION_LAUNCHER_TERMINATE_GRACE_MS = 1500;

const launcherPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(launcherPath), '..');
const visionScriptPath = path.join(projectRoot, 'scripts/vision-ocr-batch.swift');
const swiftExecutable = '/usr/bin/swift';

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw Object.assign(new Error(`${name} must be an integer between 1 and ${maximum}`), {
      code: 'VISION_LAUNCHER_ARGUMENT_INVALID',
      exitCode: 64,
    });
  }
  return parsed;
}

export function parseVisionLauncherArguments(argv) {
  let bufferLimitBytes = VISION_LAUNCHER_BUFFER_LIMIT_BYTES;
  let probeVersion = false;
  let probeDelayMs = null;
  let probeOutputBytes = 0;
  let index = 0;
  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      index += 1;
      break;
    }
    if (argument === '--buffer-limit-bytes') {
      bufferLimitBytes = positiveInteger(argv[index + 1], '--buffer-limit-bytes', VISION_LAUNCHER_BUFFER_LIMIT_BYTES);
      index += 1;
      continue;
    }
    if (argument === '--probe-version') {
      probeVersion = true;
      continue;
    }
    if (argument === '--probe-delay-ms') {
      probeDelayMs = positiveInteger(argv[index + 1], '--probe-delay-ms', 5000);
      index += 1;
      continue;
    }
    if (argument === '--probe-output-bytes') {
      probeOutputBytes = positiveInteger(argv[index + 1], '--probe-output-bytes', 16 * 1024 * 1024);
      index += 1;
      continue;
    }
    throw Object.assign(new Error(`Unexpected launcher argument: ${argument}`), {
      code: 'VISION_LAUNCHER_ARGUMENT_INVALID',
      exitCode: 64,
    });
  }
  const visionArguments = argv.slice(index);
  const probeCount = Number(probeVersion) + Number(probeDelayMs !== null || probeOutputBytes > 0);
  if (probeCount > 1 || (probeVersion && visionArguments.length) || (probeDelayMs !== null && visionArguments.length)) {
    throw Object.assign(new Error('Vision launcher probe modes are exclusive'), {
      code: 'VISION_LAUNCHER_ARGUMENT_INVALID',
      exitCode: 64,
    });
  }
  if (!probeVersion && probeDelayMs === null) {
    if (visionArguments.length < 5
      || visionArguments[0] !== '--output-dir'
      || visionArguments[2] !== '--languages'
      || !visionArguments.slice(4).every((value) => path.extname(value).toLowerCase() === '.png')) {
      throw Object.assign(new Error('Vision launcher requires --output-dir DIR --languages LIST and PNG inputs'), {
        code: 'VISION_LAUNCHER_ARGUMENT_INVALID',
        exitCode: 64,
      });
    }
  }
  return {
    bufferLimitBytes,
    mode: probeVersion ? 'probe_version' : probeDelayMs !== null ? 'probe_delay' : 'vision',
    probeDelayMs,
    probeOutputBytes,
    visionArguments,
  };
}

function probeSwiftArguments(delayMs, outputBytes) {
  const source = `
import Foundation
import Darwin
let printedAtMs = Int(Date().timeIntervalSince1970 * 1000)
let header = "{\\"swift_pid\\":\\(getpid()),\\"parent_pid\\":\\(getppid()),\\"printed_at_ms\\":\\(printedAtMs)}\\n"
FileHandle.standardOutput.write(header.data(using: .utf8)!)
if ${outputBytes} > 0 {
  FileHandle.standardOutput.write(Data(repeating: 120, count: ${outputBytes}))
}
Thread.sleep(forTimeInterval: Double(${delayMs}) / 1000.0)
`;
  return ['-e', source];
}

function signalExitCode(signal) {
  return signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 10;
}

function writeAfterChild(stream, value) {
  if (!value.length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.write(value, (error) => error ? reject(error) : resolve());
  });
}

export async function runVisionLauncher(options, {
  spawnImplementation = spawn,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const swiftArguments = options.mode === 'probe_version'
    ? ['--version']
    : options.mode === 'probe_delay'
      ? probeSwiftArguments(options.probeDelayMs, options.probeOutputBytes)
      : [visionScriptPath, ...options.visionArguments];
  const child = spawnImplementation(swiftExecutable, swiftArguments, {
    cwd: projectRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bufferedBytes = 0;
  const stdoutChunks = [];
  const stderrChunks = [];
  let launcherError = null;
  let receivedSignal = null;
  let killTimer = null;

  const terminateChild = (signal = 'SIGTERM') => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal);
    if (!killTimer) {
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, VISION_LAUNCHER_TERMINATE_GRACE_MS);
    }
  };
  const capture = (target) => (chunk) => {
    if (launcherError) return;
    const value = Buffer.from(chunk);
    const remaining = options.bufferLimitBytes - bufferedBytes;
    if (value.length <= remaining) {
      target.push(value);
      bufferedBytes += value.length;
      return;
    }
    if (remaining > 0) {
      target.push(value.subarray(0, remaining));
      bufferedBytes += remaining;
    }
    launcherError = Object.assign(new Error(`Swift output exceeded ${options.bufferLimitBytes} bytes`), {
      code: 'VISION_LAUNCHER_BUFFER_LIMIT',
      exitCode: 10,
      buffer_limit_bytes: options.bufferLimitBytes,
    });
    terminateChild();
  };
  child.stdout.on('data', capture(stdoutChunks));
  child.stderr.on('data', capture(stderrChunks));

  const forwardSignal = (signal) => {
    if (receivedSignal) return;
    receivedSignal = signal;
    terminateChild(signal);
  };
  const onSigint = () => forwardSignal('SIGINT');
  const onSigterm = () => forwardSignal('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  let spawnError = null;
  child.once('error', (error) => { spawnError = error; });
  const outcome = await new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  if (killTimer) clearTimeout(killTimer);
  process.removeListener('SIGINT', onSigint);
  process.removeListener('SIGTERM', onSigterm);

  const marker = launcherError
    ? Buffer.from(`\n[${launcherError.code}: ${launcherError.message}]\n`)
    : spawnError
      ? Buffer.from(`\n[VISION_LAUNCHER_SPAWN_FAILED: ${spawnError.message}]\n`)
      : receivedSignal
        ? Buffer.from(`\n[VISION_LAUNCHER_SIGNAL: ${receivedSignal}]\n`)
        : Buffer.alloc(0);
  await writeAfterChild(stdout, Buffer.concat(stdoutChunks));
  await writeAfterChild(stderr, Buffer.concat([...stderrChunks, marker]));

  if (launcherError) return launcherError.exitCode;
  if (spawnError) return 10;
  if (receivedSignal) return signalExitCode(receivedSignal);
  if (outcome.signal) return signalExitCode(outcome.signal);
  return outcome.code === 0 ? 0 : Number.isInteger(outcome.code) && outcome.code > 0 && outcome.code < 126
    ? outcome.code
    : 10;
}

if (process.argv[1] && path.resolve(process.argv[1]) === launcherPath) {
  try {
    const options = parseVisionLauncherArguments(process.argv.slice(2));
    process.exitCode = await runVisionLauncher(options);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: 'failed',
      code: error.code || 'VISION_LAUNCHER_FAILED',
      message: error.message,
    })}\n`);
    process.exitCode = error.exitCode || 10;
  }
}
