#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PACKAGE_ROOT = path.join(ROOT, '.cache/historical-reader-package');
const REMOTE_POINTER_KEY = 'historical-reader/current.json';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    apply: false,
    remote: false,
    resumeReadback: false,
    bucket: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--remote') options.remote = true;
    else if (arg === '--resume-readback') options.resumeReadback = true;
    else if (arg === '--bucket') options.bucket = argv[++index] || '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  requireValue(options.bucket, '--bucket is required');
  requireValue(options.remote, '--remote is required');
  requireValue(!options.resumeReadback || options.apply,
    '--resume-readback requires --apply');
  return options;
}

async function mapLimit(values, limit, callback) {
  const output = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await callback(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return output;
}

let wranglerCall = 0;
const WRANGLER_MAX_ATTEMPTS = 5;

function isTransientWranglerFailure(failure) {
  return /(?:\b429\b|\b5(?:00|02|03|04|20|21|22|23|24)\b|connection timed out|network connection lost|fetch failed|ECONNRESET|ETIMEDOUT)/i
    .test(failure);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function wrangler(args, { allowMissing = false } = {}) {
  for (let attempt = 1; attempt <= WRANGLER_MAX_ATTEMPTS; attempt += 1) {
    wranglerCall += 1;
    const logRoot = path.join(PACKAGE_ROOT, 'wrangler-logs');
    await mkdir(logRoot, { recursive: true });
    try {
      return await execFileAsync('npx', ['wrangler', ...args], {
        cwd: ROOT,
        env: {
          ...process.env,
          WRANGLER_LOG_PATH: path.join(logRoot, `${process.pid}-${wranglerCall}.log`),
        },
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) {
      const failure = `${error.stdout || ''}\n${error.stderr || ''}\n${error.message || ''}`;
      if (allowMissing && failure.includes('The specified key does not exist.')) return null;
      if (attempt < WRANGLER_MAX_ATTEMPTS && isTransientWranglerFailure(failure)) {
        const delay = 500 * (2 ** (attempt - 1));
        process.stderr.write(
          `[historical-reader] transient Wrangler failure; retry ${attempt + 1}/${WRANGLER_MAX_ATTEMPTS} in ${delay}ms\n`,
        );
        await wait(delay);
        continue;
      }
      throw new Error(`wrangler ${args.slice(0, 4).join(' ')} failed: ${error.stderr || error.message}`);
    }
  }
  throw new Error('unreachable Wrangler retry state');
}

async function getRemote(bucket, key, target, allowMissing = false) {
  await rm(target, { force: true });
  const result = await wrangler([
    'r2', 'object', 'get', `${bucket}/${key}`,
    '--file', target,
    '--remote',
  ], { allowMissing });
  if (!result) return null;
  return readFile(target);
}

const options = parseArgs(process.argv.slice(2));
const localPointer = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'current.json'), 'utf8'));
const releaseRoot = path.join(PACKAGE_ROOT, localPointer.release_root);
const [pointerBytes, objects] = await Promise.all([
  readFile(path.join(releaseRoot, 'pointer.json')),
  readFile(path.join(releaseRoot, 'objects.json'), 'utf8').then(JSON.parse),
]);
const pointer = JSON.parse(pointerBytes);
requireValue(pointer.release_id === localPointer.release_id && pointer.item_count === 461,
  'local package pointer failed validation');
const workingRoot = path.join(PACKAGE_ROOT, 'publish', options.bucket);
await mkdir(workingRoot, { recursive: true });
const remotePointerPath = path.join(workingRoot, 'remote-pointer-before.json');
const remotePointerBytes = await getRemote(options.bucket, REMOTE_POINTER_KEY, remotePointerPath, true);
if (remotePointerBytes) {
  const remotePointer = JSON.parse(remotePointerBytes);
  if (remotePointer.release_id === pointer.release_id
    && remotePointer.manifest_sha256 === pointer.manifest_sha256) {
    process.stdout.write(`${JSON.stringify({
      mode: 'already_current',
      bucket: options.bucket,
      release_id: pointer.release_id,
      objects: objects.length,
    }, null, 2)}\n`);
    process.exit(0);
  }
}
if (!options.apply) {
  process.stdout.write(`${JSON.stringify({
    mode: 'dry_run',
    bucket: options.bucket,
    release_id: pointer.release_id,
    immutable_objects: objects.length,
    pointer_predecessor: remotePointerBytes ? sha256(remotePointerBytes) : null,
  }, null, 2)}\n`);
  process.exit(0);
}

if (options.resumeReadback) {
  process.stderr.write(
    `[historical-reader] resuming at full readback for ${objects.length} expected immutable objects\n`,
  );
} else {
  let uploaded = 0;
  await mapLimit(objects, 6, async (object) => {
    const localPath = path.join(releaseRoot, object.local_path);
    await wrangler([
      'r2', 'object', 'put', `${options.bucket}/${object.key}`,
      '--file', localPath,
      '--content-type', object.content_type,
      '--remote',
    ]);
    uploaded += 1;
    if (uploaded % 25 === 0 || uploaded === objects.length) {
      process.stderr.write(`[historical-reader] uploaded ${uploaded}/${objects.length}\n`);
    }
  });
}

const readbackRoot = path.join(workingRoot, pointer.release_id);
await mkdir(readbackRoot, { recursive: true });
let verified = 0;
await mapLimit(objects, 6, async (object, index) => {
  const target = path.join(readbackRoot, `${String(index).padStart(4, '0')}.bin`);
  const bytes = await getRemote(options.bucket, object.key, target);
  requireValue(bytes.byteLength === object.bytes && sha256(bytes) === object.sha256,
    `R2 immutable readback failed: ${object.key}`);
  await rm(target, { force: true });
  verified += 1;
  if (verified % 25 === 0 || verified === objects.length) {
    process.stderr.write(`[historical-reader] readback ${verified}/${objects.length}\n`);
  }
});

await wrangler([
  'r2', 'object', 'put', `${options.bucket}/${REMOTE_POINTER_KEY}`,
  '--file', path.join(releaseRoot, 'pointer.json'),
  '--content-type', 'application/json',
  '--remote',
]);
const pointerReadbackPath = path.join(workingRoot, 'remote-pointer-after.json');
const pointerReadback = await getRemote(options.bucket, REMOTE_POINTER_KEY, pointerReadbackPath);
requireValue(pointerReadback.byteLength === pointerBytes.byteLength
  && sha256(pointerReadback) === sha256(pointerBytes),
'R2 historical reader pointer readback failed');
await writeFile(path.join(workingRoot, 'receipt.json'), `${JSON.stringify({
  schema_version: 1,
  bucket: options.bucket,
  release_id: pointer.release_id,
  immutable_objects: objects.length,
  pointer_sha256: sha256(pointerBytes),
  predecessor_pointer_sha256: remotePointerBytes ? sha256(remotePointerBytes) : null,
  verified: true,
}, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  mode: 'applied',
  bucket: options.bucket,
  release_id: pointer.release_id,
  immutable_objects: objects.length,
  pointer_sha256: sha256(pointerBytes),
  predecessor_pointer_sha256: remotePointerBytes ? sha256(remotePointerBytes) : null,
}, null, 2)}\n`);
