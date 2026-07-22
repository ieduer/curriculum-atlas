#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLASSIFICATION,
  canonicalJsonBuffer,
  assertParsedBundleMatchesDescriptor,
  hydratePrivateCorpusTar,
  parsePrivateCorpusTar,
  readJsonFile,
  sha256,
  validateAgeRecipient,
  validateCorpusArtifactDescriptor,
  validatePublishReceipt,
  validateSingleRecipientAgeEnvelope,
} from './lib/private-corpus-bundle.mjs';
// Keep this static: a dynamic import from main deadlocks on publish's reverse imports while this module is evaluating.
import { getObject } from './publish-private-corpus-bundle.mjs';

const DEFAULT_DESCRIPTOR = 'data/corpus-artifact.json';
const MAX_ERROR_BYTES = 8192;
const MAX_IDENTITY_BYTES = 4096;
const MAX_PLAINTEXT_BYTES = 1024 * 1024 * 1024;

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

function minimalChildEnvironment() {
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]));
}

async function openPrivateIdentityFile(path) {
  if (!path) throw new Error('age identity file is required');
  const target = resolve(path);
  const info = await lstat(target, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('age identity path must be a regular file, not a symbolic link');
  if ((info.mode & 0o077n) !== 0n) throw new Error('age identity file must not be group- or world-accessible');
  if (info.size <= 0n || info.size > BigInt(MAX_IDENTITY_BYTES)) {
    throw new Error('age identity file exceeds its private safety limit');
  }
  const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || info.dev !== opened.dev || info.ino !== opened.ino || info.size !== opened.size) {
      throw new Error('age identity file changed before its verified file descriptor was opened');
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const result = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (bytesRead !== bytes.length || opened.dev !== after.dev || opened.ino !== after.ino
        || opened.size !== after.size || opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs) {
      throw new Error('age identity file changed while it was being read');
    }
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes) || !text.endsWith('\n')) {
      throw new Error('age identity file is not canonical UTF-8 text');
    }
    const lines = text.slice(0, -1).split('\n');
    const identityLines = lines.filter((line) => line.startsWith('AGE-SECRET-KEY-1'));
    if (identityLines.length !== 1 || !/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/.test(identityLines[0])
        || lines.some((line) => line !== identityLines[0] && !/^# [\x20-\x7e]+$/.test(line))) {
      throw new Error('age identity file must contain exactly one canonical native age identity');
    }
    const publicComments = lines.filter((line) => line.startsWith('# public key: '));
    if (publicComments.length > 1) throw new Error('age identity file contains multiple public recipient comments');
    const commentRecipient = publicComments.length
      ? validateAgeRecipient(publicComments[0].slice('# public key: '.length), 'age identity public recipient comment')
      : null;
    return { handle, seal: after, bytes, commentRecipient };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertOpenIdentityUnchanged(identity) {
  const after = await identity.handle.stat({ bigint: true });
  if (identity.seal.dev !== after.dev || identity.seal.ino !== after.ino || identity.seal.size !== after.size
      || identity.seal.mtimeNs !== after.mtimeNs || identity.seal.ctimeNs !== after.ctimeNs) {
    throw new Error('age identity file changed while it was in use');
  }
}

async function loadAgeIdentityAuthority(identityFile) {
  const identity = await openPrivateIdentityFile(identityFile);
  try {
    await assertOpenIdentityUnchanged(identity);
    return { identity_bytes: identity.bytes, recipient: identity.commentRecipient };
  } catch (error) {
    identity.bytes.fill(0);
    throw error;
  } finally {
    await identity.handle.close();
  }
}

export function disposeAgeIdentityAuthority(authority) {
  if (Buffer.isBuffer(authority?.identity_bytes)) authority.identity_bytes.fill(0);
}

export async function assertAgeIdentityMatchesRecipient({
  identityFile,
  expectedRecipient,
  spawnImpl = spawn,
} = {}) {
  const expected = validateAgeRecipient(expectedRecipient, 'declared age recipient');
  const identity = await openPrivateIdentityFile(identityFile);
  const childEnv = minimalChildEnvironment();
  let child;
  let exit;
  let outputError = null;
  try {
    child = spawnImpl('age-keygen', ['-y', '/dev/fd/3'], {
      stdio: ['ignore', 'pipe', 'pipe', identity.handle.fd],
      env: childEnv,
    });
    const stdout = captureLimited(child.stdout);
    const stderr = captureLimited(child.stderr);
    child.stdout.on('error', (error) => {
      outputError = new Error(`age identity recipient derivation output failed: ${error.message}`);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    });
    exit = processExit(child, 'age identity recipient derivation', stderr);
    await exit;
    if (outputError) throw outputError;
    await assertOpenIdentityUnchanged(identity);
    const derivedText = stdout();
    if (!derivedText.endsWith('\n') || derivedText.slice(0, -1).includes('\n')) {
      throw new Error('derived age recipient output is not canonical');
    }
    const derived = validateAgeRecipient(derivedText.slice(0, -1), 'derived age recipient');
    if (derived !== expected || (identity.commentRecipient && identity.commentRecipient !== derived)) {
      throw new Error('derived age recipient differs from declared recipient');
    }
    return { identity_bytes: identity.bytes, recipient: derived };
  } catch (error) {
    identity.bytes.fill(0);
    throw error;
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGTERM');
    await Promise.allSettled(exit ? [exit] : []);
    await identity.handle.close();
  }
}

function validateAgeIdentityAuthority(authority) {
  if (!Buffer.isBuffer(authority?.identity_bytes) || authority.identity_bytes.length === 0
      || authority.identity_bytes.length > MAX_IDENTITY_BYTES) {
    throw new Error('verified age identity authority is required');
  }
  return authority;
}

async function runDecryptPipeline({ ciphertext, identityAuthority, maxOutputBytes, spawnImpl = spawn }) {
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0) throw new Error('encrypted corpus artifact is empty');
  const identity = validateAgeIdentityAuthority(identityAuthority);
  const childEnv = minimalChildEnvironment();
  let age;
  let zstd;
  let identityInput;
  const exits = [];
  let pipelineError = null;
  let overflow = null;
  const rememberPipelineError = (label) => (error) => {
    if (!pipelineError) pipelineError = new Error(`${label}: ${error.message}`);
    if (age?.exitCode === null && age?.signalCode === null) age.kill('SIGTERM');
    if (zstd?.exitCode === null && zstd?.signalCode === null) zstd.kill('SIGTERM');
  };
  try {
    age = spawnImpl('age', ['--decrypt', '--identity', '/dev/fd/3'], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: childEnv,
    });
    const ageError = captureLimited(age.stderr);
    exits.push(processExit(age, 'age decrypt', ageError));
    identityInput = age.stdio[3];
    if (!identityInput) throw new Error('age identity input pipe is unavailable');
    age.stdin.on('error', rememberPipelineError('age transform pipeline input failed'));
    age.stdout.on('error', rememberPipelineError('age transform pipeline output failed'));
    identityInput.on('error', rememberPipelineError('age identity input failed'));
    zstd = spawnImpl('zstd', ['--decompress', '--stdout', '--quiet'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });
    const zstdError = captureLimited(zstd.stderr);
    exits.push(processExit(zstd, 'zstd decompress', zstdError));
    zstd.stdin.on('error', rememberPipelineError('zstd transform pipeline input failed'));
    zstd.stdout.on('error', rememberPipelineError('zstd terminal transform output failed'));
    age.stdout.pipe(zstd.stdin);
    const chunks = [];
    let outputBytes = 0;
    zstd.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        overflow = new Error('decrypted corpus archive exceeds declared safety limit');
        if (age.exitCode === null && age.signalCode === null) age.kill('SIGTERM');
        if (zstd.exitCode === null && zstd.signalCode === null) zstd.kill('SIGTERM');
        return;
      }
      chunks.push(chunk);
    });
    identityInput.end(identity.identity_bytes);
    age.stdin.end(ciphertext);
    await Promise.all(exits);
    if (pipelineError) throw pipelineError;
    if (overflow) throw overflow;
    return Buffer.concat(chunks, outputBytes);
  } catch (error) {
    if (overflow) throw overflow;
    if (pipelineError) throw pipelineError;
    throw error;
  } finally {
    for (const child of [age, zstd]) {
      if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGTERM');
    }
    await Promise.allSettled(exits);
  }
}

export async function decryptAndDecompressAge({
  ciphertext,
  identityFile,
  expectedRecipient = null,
  identityAuthority = null,
  expectedPlaintextBytes = null,
  spawnImpl = spawn,
  keygenSpawnImpl = spawn,
} = {}) {
  const maximum = expectedPlaintextBytes === null
    ? MAX_PLAINTEXT_BYTES
    : Number(expectedPlaintextBytes);
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > MAX_PLAINTEXT_BYTES) {
    throw new Error('declared plaintext byte limit is invalid');
  }
  let authority = identityAuthority;
  let ownsAuthority = false;
  if (!authority) {
    authority = expectedRecipient === null
      ? await loadAgeIdentityAuthority(identityFile)
      : await assertAgeIdentityMatchesRecipient({ identityFile, expectedRecipient, spawnImpl: keygenSpawnImpl });
    ownsAuthority = true;
  } else {
    validateAgeIdentityAuthority(authority);
    if (expectedRecipient !== null && authority.recipient !== validateAgeRecipient(expectedRecipient, 'declared age recipient')) {
      throw new Error('derived age recipient differs from declared recipient');
    }
  }
  try {
    const plaintext = await runDecryptPipeline({
      ciphertext,
      identityAuthority: authority,
      maxOutputBytes: maximum,
      spawnImpl,
    });
    if (expectedPlaintextBytes !== null && plaintext.length !== maximum) {
      throw new Error('decrypted corpus archive byte count differs from descriptor');
    }
    return plaintext;
  } finally {
    if (ownsAuthority) disposeAgeIdentityAuthority(authority);
  }
}

function parseArgs(argv) {
  const args = new Map();
  const booleans = new Set(['--allow-private-download']);
  const values = new Set(['--root', '--descriptor', '--identity-file', '--endpoint']);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (booleans.has(key)) {
      args.set(key.slice(2), true);
      continue;
    }
    if (!values.has(key)) throw new Error(`unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    args.set(key.slice(2), value);
    index += 1;
  }
  return args;
}

function requiredEnvironment(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required in the process environment`);
  return value;
}

export function validatePublishReceiptAgainstDescriptor(buffer, descriptor) {
  if (buffer.length !== descriptor.receipt.bytes || sha256(buffer) !== descriptor.receipt.sha256) {
    throw new Error('publish receipt bytes differ from artifact descriptor');
  }
  let receipt;
  try {
    receipt = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`publish receipt is not JSON: ${error.message}`);
  }
  if (!canonicalJsonBuffer(receipt).equals(buffer)) throw new Error('publish receipt JSON is not canonical');
  validatePublishReceipt(receipt);
  if (!canonicalJsonBuffer(receipt.corpus).equals(canonicalJsonBuffer(descriptor.corpus))
      || !canonicalJsonBuffer(receipt.bundle).equals(canonicalJsonBuffer(descriptor.bundle))
      || receipt.storage.provider !== descriptor.storage.provider
      || receipt.storage.bucket !== descriptor.storage.bucket
      || receipt.storage.object_key !== descriptor.storage.object_key) {
    throw new Error('publish receipt does not authorize this exact private corpus artifact');
  }
  return receipt;
}

export async function hydrateCorpusFromDescriptor({
  root = process.cwd(),
  descriptorPath = DEFAULT_DESCRIPTOR,
  identityFile,
  endpoint,
  accessKeyId,
  secretAccessKey,
  allowPrivateDownload = false,
  fetchImpl = fetch,
} = {}) {
  if (!allowPrivateDownload) throw new Error('private corpus download requires explicit --allow-private-download');
  const descriptor = validateCorpusArtifactDescriptor(
    await readJsonFile(resolve(root, descriptorPath), 'private corpus artifact descriptor'),
  );
  const identityAuthority = await assertAgeIdentityMatchesRecipient({
    identityFile,
    expectedRecipient: descriptor.bundle.age_recipient,
  });
  try {
    const common = {
      endpoint,
      bucket: descriptor.storage.bucket,
      accessKeyId,
      secretAccessKey,
      fetchImpl,
    };
    const receiptReadback = await getObject({
      ...common,
      key: descriptor.storage.receipt_key,
      expectedBytes: descriptor.receipt.bytes,
      maxBytes: descriptor.receipt.bytes,
    });
    validatePublishReceiptAgainstDescriptor(receiptReadback.body, descriptor);
    const artifactReadback = await getObject({
      ...common,
      key: descriptor.storage.object_key,
      expectedBytes: descriptor.bundle.ciphertext_bytes,
      maxBytes: descriptor.bundle.ciphertext_bytes,
    });
    if (artifactReadback.body.length !== descriptor.bundle.ciphertext_bytes
        || sha256(artifactReadback.body) !== descriptor.bundle.ciphertext_sha256) {
      throw new Error('encrypted corpus readback differs from artifact descriptor');
    }
    validateSingleRecipientAgeEnvelope(artifactReadback.body);
    const plaintext = await decryptAndDecompressAge({
      ciphertext: artifactReadback.body,
      identityAuthority,
      expectedRecipient: descriptor.bundle.age_recipient,
      expectedPlaintextBytes: descriptor.bundle.plaintext_tar_bytes,
    });
    if (sha256(plaintext) !== descriptor.bundle.plaintext_tar_sha256) {
      throw new Error('decrypted corpus archive differs from artifact descriptor');
    }
    const parsed = parsePrivateCorpusTar(plaintext);
    assertParsedBundleMatchesDescriptor(parsed, descriptor);
    return hydratePrivateCorpusTar({ root, tarBuffer: plaintext });
  } finally {
    disposeAgeIdentityAuthority(identityAuthority);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.get('root') || process.cwd());
  const result = await hydrateCorpusFromDescriptor({
    root,
    descriptorPath: args.get('descriptor') || DEFAULT_DESCRIPTOR,
    identityFile: args.get('identity-file') || process.env.CURRICULUM_CORPUS_AGE_IDENTITY_FILE,
    endpoint: args.get('endpoint') || requiredEnvironment('R2_S3_ENDPOINT'),
    accessKeyId: requiredEnvironment('R2_ACCESS_KEY_ID'),
    secretAccessKey: requiredEnvironment('R2_SECRET_ACCESS_KEY'),
    allowPrivateDownload: args.get('allow-private-download') === true,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: result.status,
    classification: CLASSIFICATION,
    bundle_id: result.bundle_id,
    corpus_release_id: result.corpus_release_id,
    hydrated_file_count: result.hydrated_file_count,
    tracked_manifest_preserved: result.tracked_manifest_preserved,
  })}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) await main();
