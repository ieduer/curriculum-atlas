import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import {
  buildVisionWitnessSidecar,
  visionLauncherInvocationArgs,
} from '../scripts/ocr-supervisor.mjs';
import {
  visionWitnessPlan,
  visionWitnessProfileSha,
  witnessRecordValid,
} from '../scripts/lib/ocr-supervisor-state.mjs';
import {
  VISION_LAUNCHER_BUFFER_LIMIT_BYTES,
  VISION_LAUNCHER_TERMINATE_GRACE_MS,
  parseVisionLauncherArguments,
} from '../scripts/vision-ocr-launcher.mjs';

const launcherPath = path.resolve(new URL('../scripts/vision-ocr-launcher.mjs', import.meta.url).pathname);

function runLauncher(arguments_) {
  const child = spawn(process.execPath, [launcherPath, ...arguments_], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  let firstOutputAt = null;
  const capture = (target) => (chunk) => {
    if (firstOutputAt === null) firstOutputAt = Date.now();
    target.push(Buffer.from(chunk));
  };
  child.stdout.on('data', capture(stdout));
  child.stderr.on('data', capture(stderr));
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      firstOutputAt,
    }));
  });
  return { child, completed, outputObserved: () => firstOutputAt !== null };
}

function runImportedLauncherWithUncooperativeChild() {
  const launcherUrl = new URL('../scripts/vision-ocr-launcher.mjs', import.meta.url).href;
  const childSource = `
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});
const header = { child_pid: process.pid, parent_pid: process.ppid };
process.stdout.write(JSON.stringify(header) + '\\n', () => process.send?.(header));
setInterval(() => {}, 1000);
`;
  const wrapperSource = `
import { spawn } from 'node:child_process';
import { runVisionLauncher } from ${JSON.stringify(launcherUrl)};
const childSource = ${JSON.stringify(childSource)};
const code = await runVisionLauncher({
  mode: 'probe_delay',
  probeDelayMs: 1,
  probeOutputBytes: 1,
  bufferLimitBytes: ${VISION_LAUNCHER_BUFFER_LIMIT_BYTES},
}, {
  spawnImplementation: (executable, args, options) => {
    const child = spawn(process.execPath, ['-e', childSource], {
      ...options,
      stdio: [...options.stdio, 'ipc'],
    });
    child.once('message', (message) => {
      process.stderr.write('[READY]' + JSON.stringify(message) + '\\n');
    });
    return child;
  },
});
process.exitCode = code;
`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', wrapperSource], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  let stderrText = '';
  let readySettled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => {
    const value = Buffer.from(chunk);
    stderr.push(value);
    stderrText += value.toString('utf8');
    const match = stderrText.match(/\[READY\](\{[^\n]+\})\n/);
    if (match && !readySettled) {
      readySettled = true;
      resolveReady(JSON.parse(match[1]));
    }
  });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error('Uncooperative child exited before its ready signal'));
      }
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
  return { child, completed, ready };
}

test('launcher argument contract is strict and caps all captures at 8 MiB', () => {
  const parsed = parseVisionLauncherArguments([
    '--buffer-limit-bytes', String(VISION_LAUNCHER_BUFFER_LIMIT_BYTES),
    '--',
    '--output-dir', '/tmp/out',
    '--languages', 'zh-Hans,en-US',
    '/tmp/page-001.png',
  ]);
  assert.equal(parsed.mode, 'vision');
  assert.equal(parsed.bufferLimitBytes, 8 * 1024 * 1024);
  assert.deepEqual(parsed.visionArguments.slice(0, 4), [
    '--output-dir', '/tmp/out', '--languages', 'zh-Hans,en-US',
  ]);
  assert.throws(
    () => parseVisionLauncherArguments([
      '--buffer-limit-bytes', String(VISION_LAUNCHER_BUFFER_LIMIT_BYTES + 1),
      '--probe-version',
    ]),
    /must be an integer/,
  );
  assert.throws(
    () => parseVisionLauncherArguments(['--', '--output-dir', '/tmp/out', '--languages', 'zh-Hans,en-US', '/tmp/page.txt']),
    /PNG inputs/,
  );
});

test('actual process tree is launcher Node -> Swift and output arrives only after Swift has exited', async () => {
  const delayMs = 400;
  const running = runLauncher(['--probe-delay-ms', String(delayMs), '--probe-output-bytes', '1']);
  const result = await running.completed;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  const header = JSON.parse(result.stdout.toString('utf8').split('\n')[0]);
  assert.equal(header.parent_pid, running.child.pid);
  assert.notEqual(header.swift_pid, running.child.pid);
  assert.ok(result.firstOutputAt - header.printed_at_ms >= delayMs - 60,
    `launcher forwarded output ${result.firstOutputAt - header.printed_at_ms} ms after Swift printed`);
});

test('launcher overflow is bounded and fail-closed', async () => {
  const result = await runLauncher([
    '--buffer-limit-bytes', '128',
    '--probe-delay-ms', '1',
    '--probe-output-bytes', '4096',
  ]).completed;
  assert.equal(result.code, 10);
  assert.ok(result.stdout.length <= 128);
  assert.match(result.stderr.toString('utf8'), /VISION_LAUNCHER_BUFFER_LIMIT/);
});

test('launcher forwards termination to Swift and leaves no child alive', async () => {
  const running = runLauncher(['--probe-delay-ms', '5000', '--probe-output-bytes', '1']);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(running.outputObserved(), false, 'launcher must not stream Swift output while the child is alive');
  running.child.kill('SIGTERM');
  const result = await running.completed;
  assert.equal(result.code, 143);
  assert.match(result.stderr.toString('utf8'), /VISION_LAUNCHER_SIGNAL: SIGTERM/);
  const headerLine = result.stdout.toString('utf8').split('\n').find((line) => line.startsWith('{'));
  assert.ok(headerLine, 'Swift must have started and produced the buffered process-tree record');
  const header = JSON.parse(headerLine);
  assert.equal(header.parent_pid, running.child.pid);
  assert.throws(() => process.kill(header.swift_pid, 0), (error) => error.code === 'ESRCH');
});

test('launcher kills an uncooperative child before the supervisor grace and survives a second signal', async () => {
  assert.ok(VISION_LAUNCHER_TERMINATE_GRACE_MS < 5000);
  const running = runImportedLauncherWithUncooperativeChild();
  const ready = await running.ready;
  const signaledAt = Date.now();
  running.child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 200));
  running.child.kill('SIGTERM');
  const result = await running.completed;
  const elapsedMs = Date.now() - signaledAt;
  assert.equal(result.code, 143);
  assert.equal(result.signal, null);
  assert.ok(
    elapsedMs < 4000,
    `launcher took ${elapsedMs} ms to reap an uncooperative child`,
  );
  assert.match(result.stderr.toString('utf8'), /VISION_LAUNCHER_SIGNAL: SIGTERM/);
  const header = JSON.parse(result.stdout.toString('utf8').trim());
  assert.deepEqual(header, ready);
  assert.equal(header.parent_pid, running.child.pid);
  assert.throws(() => process.kill(header.child_pid, 0), (error) => error.code === 'ESRCH');
});

test('supervisor routes both Vision batch and retry through the launcher', async () => {
  const invocation = visionLauncherInvocationArgs({
    outputDir: '/tmp/out',
    languages: ['zh-Hans', 'en-US'],
    imagePaths: ['/tmp/page-001.png'],
  });
  assert.equal(path.basename(invocation[0]), 'vision-ocr-launcher.mjs');
  assert.deepEqual(invocation.slice(1, 5), [
    '--buffer-limit-bytes',
    String(VISION_LAUNCHER_BUFFER_LIMIT_BYTES),
    '--',
    '--output-dir',
  ]);
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(
    new URL('../scripts/ocr-supervisor.mjs', import.meta.url),
    'utf8',
  ));
  assert.doesNotMatch(source, /runLogged\(\s*'\/usr\/bin\/swift'/);
  assert.equal(
    (source.match(/runLogged\(\s*process\.execPath,\s*visionLauncherInvocationArgs\(/g) || []).length,
    2,
  );
  assert.match(source, /independent_apple_vision_page_retry_/);
});

test('launcher provenance is validated while older signed witnesses remain compatible', () => {
  const document = { id: 'doc', subject: '语文' };
  const profile = visionWitnessPlan(document);
  const provenance = {
    schema_version: 1,
    framework: 'Apple Vision',
    request_api: 'VNRecognizeTextRequest',
    framework_distribution: 'macOS bundled',
    execution_binary: '/usr/bin/swift',
    swift_version: 'Swift version 6.0',
    script_path: 'scripts/vision-ocr-batch.swift',
    script_sha256: 'a'.repeat(64),
    launcher: {
      schema_version: 1,
      path: 'scripts/vision-ocr-launcher.mjs',
      sha256: 'b'.repeat(64),
      node_binary: process.execPath,
      child_binary: '/usr/bin/swift',
      buffer_limit_bytes: VISION_LAUNCHER_BUFFER_LIMIT_BYTES,
    },
    renderer: {
      name: 'MuPDF mutool 1.28.0',
      binary: '/opt/homebrew/bin/mutool',
      sha256: 'c'.repeat(64),
    },
    os: {
      product_name: 'macOS',
      product_version: '15.5',
      build_version: '24F74',
      platform: 'darwin',
      architecture: 'arm64',
      kernel_type: 'Darwin',
      kernel_release: '24.5.0',
      kernel_version: 'Darwin Kernel Version 24.5.0',
    },
  };
  const sidecar = buildVisionWitnessSidecar({
    document,
    page: 1,
    pdfSha: 'd'.repeat(64),
    imageSha: 'e'.repeat(64),
    imageInfo: { size: 1024, mtimeMs: 1234 },
    profile,
    passResults: [{
      pass_id: 'zh-primary',
      record: { lines: [{ text: '课程标准', confidence: 0.99 }] },
      raw_sidecar_file: 'vision-passes/zh-primary/page-001.json',
      raw_sidecar_sha256: 'f'.repeat(64),
      raw_text_file: 'vision-passes/zh-primary/page-001.txt',
      raw_text_sha256: '1'.repeat(64),
      attempt_count: 1,
    }],
    provenance,
  });
  const expected = {
    documentId: 'doc',
    page: 1,
    pdfSha: 'd'.repeat(64),
    imageSha: 'e'.repeat(64),
    file: 'page-001.png',
    witnessProfile: profile,
    witnessProfileSha: visionWitnessProfileSha(profile),
    allowLegacyDefault: true,
  };
  assert.equal(witnessRecordValid(sidecar, expected), true);
  const oldCompatible = structuredClone(sidecar);
  delete oldCompatible.engine_provenance.launcher;
  assert.equal(witnessRecordValid(oldCompatible, expected), true);
  const drifted = structuredClone(sidecar);
  drifted.engine_provenance.launcher.sha256 = 'not-a-hash';
  assert.equal(witnessRecordValid(drifted, expected), false);
});
