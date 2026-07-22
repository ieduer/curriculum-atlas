#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLASSIFICATION,
  buildPrivateCorpusTar,
  canonicalJsonBuffer,
  createBuildReceipt,
  parsePrivateCorpusTar,
  readPrivateFile,
  sha256,
  validateAgeRecipient,
  validateSingleRecipientAgeEnvelope,
  writePrivateFile,
} from './lib/private-corpus-bundle.mjs';
import {
  assertAgeIdentityMatchesRecipient,
  decryptAndDecompressAge,
  disposeAgeIdentityAuthority,
} from './hydrate-corpus.mjs';

const MAX_ERROR_BYTES = 8192;
const MAX_CIPHERTEXT_BYTES = 1024 * 1024 * 1024;

function captureLimited(stream) {
  const chunks = [];
  let bytes = 0;
  stream.on('data', (chunk) => {
    if (bytes >= MAX_ERROR_BYTES) return;
    const kept = chunk.subarray(0, MAX_ERROR_BYTES - bytes);
    chunks.push(kept);
    bytes += kept.length;
  });
  return () => Buffer.concat(chunks).toString('utf8');
}

function processExit(child, label, stderr) {
  return new Promise((fulfill, reject) => {
    let startupError = null;
    child.once('error', (error) => { startupError = error; });
    child.once('close', (code, signal) => {
      if (startupError) reject(new Error(`${label} could not start: ${startupError.message}`));
      else if (code === 0) fulfill();
      else reject(new Error(`${label} failed with ${signal ? `signal ${signal}` : `exit ${code}`}: ${stderr().trim()}`));
    });
  });
}

function minimalChildEnvironment() {
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]));
}

async function openCanonicalRecipientFile(path, expectedRecipient = null) {
  if (!path) throw new Error('age recipients file is required');
  const target = resolve(path);
  const info = await lstat(target, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error('age recipients file must be a regular file, not a symbolic link');
  }
  if (info.size <= 0n || info.size > 256n) throw new Error('age recipients file must contain exactly one canonical age recipient');
  const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || info.dev !== opened.dev || info.ino !== opened.ino || info.size !== opened.size) {
      throw new Error('age recipients file changed before its verified file descriptor was opened');
    }
    const buffer = Buffer.alloc(Number(opened.size));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (bytesRead !== buffer.length || opened.dev !== after.dev || opened.ino !== after.ino
        || opened.size !== after.size || opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs) {
      throw new Error('age recipients file changed while it was being read');
    }
    const text = buffer.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(buffer) || !text.endsWith('\n') || text.slice(0, -1).includes('\n')) {
      throw new Error('age recipients file must contain exactly one canonical age recipient');
    }
    const recipient = validateAgeRecipient(text.slice(0, -1), 'age recipients file');
    if (expectedRecipient !== null && recipient !== validateAgeRecipient(expectedRecipient, 'expected age recipient')) {
      throw new Error('age recipients file differs from the bundle-bound age recipient');
    }
    return { handle, recipient, seal: after };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertRecipientFileUnchanged(opened) {
  const after = await opened.handle.stat({ bigint: true });
  if (opened.seal.dev !== after.dev || opened.seal.ino !== after.ino || opened.seal.size !== after.size
      || opened.seal.mtimeNs !== after.mtimeNs || opened.seal.ctimeNs !== after.ctimeNs) {
    throw new Error('age recipients file changed while encryption was running');
  }
}

export async function readCanonicalAgeRecipientFile(path) {
  const opened = await openCanonicalRecipientFile(path);
  try {
    return opened.recipient;
  } finally {
    await opened.handle.close();
  }
}

export async function compressAndEncryptAge({
  plaintext,
  recipientFile,
  expectedRecipient = null,
  spawnImpl = spawn,
} = {}) {
  if (!Buffer.isBuffer(plaintext) || plaintext.length === 0) throw new Error('private corpus plaintext archive is empty');
  const recipients = await openCanonicalRecipientFile(recipientFile, expectedRecipient);
  const childEnv = minimalChildEnvironment();
  let zstd;
  let age;
  const exits = [];
  let pipelineError = null;
  let overflow = null;
  try {
    zstd = spawnImpl('zstd', ['--compress', '--stdout', '--quiet', '--threads=1', '--no-progress'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });
    const zstdError = captureLimited(zstd.stderr);
    exits.push(processExit(zstd, 'zstd compress', zstdError));
    age = spawnImpl('age', ['--encrypt', '--recipients-file', '/dev/fd/3'], {
      stdio: ['pipe', 'pipe', 'pipe', recipients.handle.fd],
      env: childEnv,
    });
    const ageError = captureLimited(age.stderr);
    exits.push(processExit(age, 'age encrypt', ageError));
    const rememberPipelineError = (label) => (error) => {
      if (!pipelineError) pipelineError = new Error(`${label}: ${error.message}`);
      if (zstd?.exitCode === null && zstd?.signalCode === null) zstd.kill('SIGTERM');
      if (age?.exitCode === null && age?.signalCode === null) age.kill('SIGTERM');
    };
    zstd.stdin.on('error', rememberPipelineError('zstd transform pipeline input failed'));
    zstd.stdout.on('error', rememberPipelineError('zstd transform pipeline output failed'));
    age.stdin.on('error', rememberPipelineError('age transform pipeline input failed'));
    age.stdout.on('error', rememberPipelineError('age terminal transform output failed'));
    zstd.stdout.pipe(age.stdin);
    const chunks = [];
    let bytes = 0;
    age.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_CIPHERTEXT_BYTES) {
        overflow = new Error('encrypted private corpus artifact exceeds safety limit');
        if (zstd.exitCode === null && zstd.signalCode === null) zstd.kill('SIGTERM');
        if (age.exitCode === null && age.signalCode === null) age.kill('SIGTERM');
        return;
      }
      chunks.push(chunk);
    });
    zstd.stdin.end(plaintext);
    await Promise.all(exits);
    if (pipelineError) throw pipelineError;
    if (overflow) throw overflow;
    await assertRecipientFileUnchanged(recipients);
    const ciphertext = Buffer.concat(chunks, bytes);
    if (!ciphertext.length) throw new Error('encrypted private corpus artifact is empty');
    return ciphertext;
  } catch (error) {
    if (overflow) throw overflow;
    if (pipelineError) throw pipelineError;
    throw error;
  } finally {
    for (const child of [zstd, age]) {
      if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGTERM');
    }
    await Promise.allSettled(exits);
    await recipients.handle.close();
  }
}

export async function buildEncryptedPrivateCorpusBundle({
  root = process.cwd(),
  outputPath,
  receiptPath,
  recipientFile,
  identityFile,
} = {}) {
  if (!outputPath || !receiptPath) throw new Error('encrypted output and build receipt paths are required');
  const ageRecipient = await readCanonicalAgeRecipientFile(recipientFile);
  const identityAuthority = await assertAgeIdentityMatchesRecipient({
    identityFile,
    expectedRecipient: ageRecipient,
  });
  try {
  const built = await buildPrivateCorpusTar({ root, ageRecipient });
  const ciphertext = await compressAndEncryptAge({
    plaintext: built.tar_buffer,
    recipientFile,
    expectedRecipient: ageRecipient,
  });
  validateSingleRecipientAgeEnvelope(ciphertext);
  const replayBuffer = await decryptAndDecompressAge({
    ciphertext,
    identityAuthority,
    expectedRecipient: ageRecipient,
    expectedPlaintextBytes: built.plaintext_tar_bytes,
  });
  if (!replayBuffer.equals(built.tar_buffer)) throw new Error('encrypted corpus local decrypt replay differs from source tar');
  const replay = parsePrivateCorpusTar(replayBuffer);
  if (replay.bundle_manifest_sha256 !== built.bundle_manifest_sha256
      || replay.bundle_manifest.bundle_id !== built.bundle_manifest.bundle_id) {
    throw new Error('encrypted corpus bundle manifest replay differs');
  }
  const receipt = createBuildReceipt({ built, ciphertextBuffer: ciphertext });
  const receiptBuffer = canonicalJsonBuffer(receipt);
  await writePrivateFile(resolve(outputPath), ciphertext);
  await writePrivateFile(resolve(receiptPath), receiptBuffer);
  const artifactReadback = await readPrivateFile(resolve(outputPath), {
    expectedBytes: ciphertext.length,
    maxBytes: MAX_CIPHERTEXT_BYTES,
    label: 'private corpus local artifact readback',
  });
  const receiptReadback = await readPrivateFile(resolve(receiptPath), {
    expectedBytes: receiptBuffer.length,
    maxBytes: 1024 * 1024,
    label: 'private corpus local build receipt readback',
  });
  if (!artifactReadback.equals(ciphertext) || !receiptReadback.equals(receiptBuffer)) {
    throw new Error('private corpus local artifact readback differs');
  }
  return {
    receipt,
    receipt_sha256: sha256(receiptBuffer),
    receipt_bytes: receiptBuffer.length,
    ciphertext_sha256: sha256(ciphertext),
    ciphertext_bytes: ciphertext.length,
  };
  } finally {
    disposeAgeIdentityAuthority(identityAuthority);
  }
}

function parseArgs(argv) {
  const args = new Map();
  const supported = new Set(['--root', '--output', '--receipt', '--recipient-file', '--identity-file']);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!supported.has(key)) throw new Error(`unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    args.set(key.slice(2), value);
    index += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await buildEncryptedPrivateCorpusBundle({
    root: resolve(args.get('root') || process.cwd()),
    outputPath: args.get('output'),
    receiptPath: args.get('receipt'),
    recipientFile: args.get('recipient-file') || process.env.CURRICULUM_CORPUS_AGE_RECIPIENT_FILE,
    identityFile: args.get('identity-file') || process.env.CURRICULUM_CORPUS_AGE_IDENTITY_FILE,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    classification: CLASSIFICATION,
    corpus_release_id: result.receipt.corpus.release_id,
    bundle_id: result.receipt.bundle.bundle_id,
    ciphertext_sha256: result.ciphertext_sha256,
    ciphertext_bytes: result.ciphertext_bytes,
    build_receipt_sha256: result.receipt_sha256,
    build_receipt_bytes: result.receipt_bytes,
  })}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) await main();
