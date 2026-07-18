#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  assertBufferParity,
  buildReleaseManifest,
} from './build-release-manifest.mjs';
import { validateCorpusManifest } from './import-corpus.mjs';
import {
  assertPageEvidenceReleaseMode,
  validatePageEvidenceForRelease,
} from './page-evidence-release-hook.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function parseArgs(argv) {
  const args = new Map();
  const booleanArguments = new Set(['--remote', '--bootstrap', '--page-evidence-promotion']);
  const valueArguments = new Set(['--bucket', '--environment', '--renderer']);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    if (booleanArguments.has(key)) {
      args.set(key.slice(2), true);
      continue;
    }
    if (!valueArguments.has(key)) throw new Error(`unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    args.set(key.slice(2), value);
    index += 1;
  }
  return args;
}

function safeCommandError(result, operation) {
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : String(result.stderr || '');
  return new Error(`${operation} failed with exit ${result.status ?? 'unknown'}: ${stderr.trim().slice(0, 2000)}`);
}

function isMissingObjectError(result) {
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : String(result.stderr || '');
  return /(?:404|10007|not[ -]?found|does not exist|NoSuchKey)/i.test(stderr);
}

function runWrangler(arguments_, { root, operation, allowMissing = false, runCommand = spawnSync }) {
  const result = runCommand('npx', ['--no-install', 'wrangler', ...arguments_], {
    cwd: root,
    encoding: null,
    maxBuffer: MAX_OBJECT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    if (allowMissing && isMissingObjectError(result)) return null;
    throw safeCommandError(result, operation);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
}

function getRemoteObject(bucket, key, options) {
  return runWrangler(['r2', 'object', 'get', `${bucket}/${key}`, '--pipe', '--remote'], {
    ...options,
    operation: `R2 get ${key}`,
  });
}

function putRemoteObject(bucket, key, source, contentType, options) {
  runWrangler([
    'r2', 'object', 'put', `${bucket}/${key}`,
    '--file', source,
    '--content-type', contentType,
    '--remote',
  ], {
    ...options,
    operation: `R2 put ${key}`,
  });
}

function environmentForBucket(manifest, bucket, requestedEnvironment) {
  const configured = Object.entries(manifest.r2.buckets || {}).find(([, configuredBucket]) => configuredBucket === bucket)?.[0];
  if (!configured) throw new Error(`bucket is not registered in the release policy: ${bucket}`);
  if (requestedEnvironment && requestedEnvironment !== configured) {
    throw new Error(`bucket ${bucket} belongs to ${configured}, not requested environment ${requestedEnvironment}`);
  }
  return configured;
}

export function assertEnvironmentReleaseReady(manifest, environment) {
  const state = manifest.environment_snapshot?.environments?.[environment];
  if (!state) throw new Error(`release manifest has no environment state for ${environment}`);
  if (state.release_blockers.length) {
    const details = state.release_blockers.map((blocker) =>
      `${blocker.code}:${blocker.migration || blocker.requirement || blocker.message}`).join(', ');
    throw new Error(`${environment} release is blocked before remote mutation: ${details}`);
  }
  if (!state.release_ready) throw new Error(`${environment} release is not ready`);
  return state;
}

export function assertReleaseSourceReady(manifest) {
  if (!/^[0-9a-f]{40}$/.test(String(manifest.git?.head || ''))) {
    throw new Error('release source is blocked before remote mutation: missing exact Git HEAD');
  }
  if (manifest.git?.dirty !== false) {
    throw new Error('release source is blocked before remote mutation: dirty Git working tree');
  }
  const sourceBlockers = (manifest.release_blockers || []).filter((blocker) =>
    blocker.environment === 'source');
  if (sourceBlockers.length) {
    throw new Error(`release source is blocked before remote mutation: ${sourceBlockers.map((blocker) => blocker.code).join(', ')}`);
  }
  return manifest.git;
}

function validateVersionedManifest(manifest) {
  if (!manifest.release_id || !Array.isArray(manifest.r2?.objects)) throw new Error('invalid release manifest');
  const prefix = `${manifest.r2.release_prefix}/${manifest.release_id}/`;
  if (!manifest.r2.current_pointer_key || !manifest.r2.release_manifest_key) {
    throw new Error('release manifest is missing current pointer or versioned manifest key');
  }
  if (!manifest.r2.release_manifest_key.startsWith(prefix)) {
    throw new Error('versioned release manifest key is outside its immutable release prefix');
  }
  const releaseKeys = manifest.r2.objects.map((object) => object.release_key);
  if (releaseKeys.some((key) => typeof key !== 'string' || !key.startsWith(prefix))) {
    throw new Error('managed object is missing a valid versioned release_key');
  }
  if (new Set(releaseKeys).size !== releaseKeys.length) throw new Error('managed release keys contain duplicates');
  if (releaseKeys.includes(manifest.r2.release_manifest_key)) throw new Error('managed object collides with versioned release manifest key');
}

function parseCurrentPointer(buffer, pointerKey) {
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`remote ${pointerKey} is not valid JSON: ${error.message}`);
  }
  if (
    parsed.schema_version !== 1
    || typeof parsed.release_id !== 'string'
    || typeof parsed.release_manifest_key !== 'string'
    || typeof parsed.release_manifest_sha256 !== 'string'
    || !Number.isSafeInteger(parsed.release_manifest_bytes)
  ) throw new Error(`remote ${pointerKey} is not a supported release pointer`);
  return parsed;
}

function manifestArtifact(manifest) {
  const buffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  return {
    buffer,
    sha256: sha256(buffer),
    bytes: buffer.length,
  };
}

async function verifyLocalObjects(root, objects) {
  for (const object of objects) {
    const buffer = await readFile(resolve(root, object.source));
    assertBufferParity(object, buffer, `local ${object.source}`);
  }
}

async function verifyLocalCorpusEnvelope(root, expected) {
  if (!expected || typeof expected !== 'object') {
    throw new Error('release manifest is missing its corpus_release binding');
  }
  const source = String(expected.source || '');
  const absolute = resolve(root, source);
  const relativeToRoot = relative(root, absolute);
  if (!source || isAbsolute(source) || relativeToRoot === '..'
      || relativeToRoot.startsWith(`..${sep}`) || isAbsolute(relativeToRoot)) {
    throw new Error('corpus_release.source must be project-relative and remain inside root');
  }
  const buffer = await readFile(absolute);
  assertBufferParity(expected, buffer, `local corpus envelope ${source}`);
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`local corpus envelope is not valid JSON: ${error.message}`);
  }
  const manifest = validateCorpusManifest(parsed);
  for (const key of ['release_id', 'release_fingerprint_sha256', 'manifest_sha256']) {
    if (expected[key] !== manifest[key]) {
      throw new Error(`local corpus envelope ${key} does not match generated release manifest`);
    }
  }
  return manifest;
}

function inspectImmutableRemoteObject(bucket, key, expected, options) {
  const remote = getRemoteObject(bucket, key, { ...options, allowMissing: true });
  if (remote === null) return false;
  assertBufferParity(expected, remote, `immutable remote object ${key}`);
  return true;
}

async function verifyVersionedObjects(bucket, objects, options) {
  for (const object of objects) {
    const remote = getRemoteObject(bucket, object.release_key, options);
    assertBufferParity(object, remote, `remote staged object ${object.release_key}`);
    process.stdout.write(`[verified] ${object.release_key} sha256=${object.sha256} bytes=${object.bytes}\n`);
  }
}

export async function publishVersionedRelease({
  manifest,
  bucket,
  bootstrap = false,
  root = DEFAULT_ROOT,
  runCommand = spawnSync,
  publishedAt = new Date().toISOString(),
  pageEvidencePromotion = false,
  rendererPath = null,
  pageEvidenceValidator = validatePageEvidenceForRelease,
} = {}) {
  if (!bucket) throw new Error('--bucket is required');
  validateVersionedManifest(manifest);
  assertPageEvidenceReleaseMode(manifest.page_evidence, { pageEvidencePromotion });
  const projectRoot = resolve(root);
  const commandOptions = { root: projectRoot, runCommand };
  const currentPageEvidence = await pageEvidenceValidator({
    root: projectRoot,
    pageEvidencePromotion,
    evidenceManifestPath: manifest.page_evidence?.manifest?.locator,
    rendererPath,
  });
  assertPageEvidenceReleaseMode(currentPageEvidence, { pageEvidencePromotion });
  if (JSON.stringify(currentPageEvidence) !== JSON.stringify(manifest.page_evidence)) {
    throw new Error('page-evidence state changed after release-manifest generation');
  }
  await verifyLocalCorpusEnvelope(projectRoot, manifest.corpus_release);
  await verifyLocalObjects(projectRoot, manifest.r2.objects);
  process.stdout.write(`[preflight] local manifest parity exact for ${manifest.r2.objects.length} objects\n`);

  const previousPointerBuffer = getRemoteObject(bucket, manifest.r2.current_pointer_key, {
    ...commandOptions,
    allowMissing: true,
  });
  if (previousPointerBuffer === null && !bootstrap) {
    throw new Error(`remote ${manifest.r2.current_pointer_key} is missing; first versioned publish requires explicit --bootstrap`);
  }
  if (previousPointerBuffer !== null) {
    const previousPointer = parseCurrentPointer(previousPointerBuffer, manifest.r2.current_pointer_key);
    const previousManifest = getRemoteObject(bucket, previousPointer.release_manifest_key, commandOptions);
    assertBufferParity({
      sha256: previousPointer.release_manifest_sha256,
      bytes: previousPointer.release_manifest_bytes,
    }, previousManifest, `currently published release manifest ${previousPointer.release_manifest_key}`);
    process.stdout.write(`[preflight] current pointer remains valid at ${previousPointer.release_id}\n`);
  }

  const manifestFile = manifestArtifact(manifest);
  const alreadyStaged = new Set();
  for (const object of manifest.r2.objects) {
    if (inspectImmutableRemoteObject(bucket, object.release_key, object, commandOptions)) {
      alreadyStaged.add(object.release_key);
      process.stdout.write(`[preflight] immutable object already exact ${object.release_key}\n`);
    } else {
      process.stdout.write(`[preflight] immutable object missing ${object.release_key}\n`);
    }
  }
  const manifestAlreadyStaged = inspectImmutableRemoteObject(
    bucket,
    manifest.r2.release_manifest_key,
    manifestFile,
    commandOptions,
  );
  process.stdout.write(`[preflight] immutable manifest ${manifestAlreadyStaged ? 'already exact' : 'missing'} ${manifest.r2.release_manifest_key}\n`);

  for (const [index, object] of manifest.r2.objects.entries()) {
    if (alreadyStaged.has(object.release_key)) continue;
    const currentLocal = await readFile(resolve(projectRoot, object.source));
    assertBufferParity(object, currentLocal, `local immediately before staging ${object.source}`);
    process.stdout.write(`[stage ${index + 1}/${manifest.r2.objects.length}] ${object.release_key}\n`);
    putRemoteObject(bucket, object.release_key, resolve(projectRoot, object.source), object.content_type, commandOptions);
  }
  await verifyVersionedObjects(bucket, manifest.r2.objects, commandOptions);

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'curriculum-release-manifest-'));
  try {
    const manifestFilePath = join(temporaryDirectory, 'manifest.json');
    await writeFile(manifestFilePath, manifestFile.buffer);
    if (!manifestAlreadyStaged) {
      putRemoteObject(bucket, manifest.r2.release_manifest_key, manifestFilePath, 'application/json', commandOptions);
    }
    const remoteManifest = getRemoteObject(bucket, manifest.r2.release_manifest_key, commandOptions);
    assertBufferParity(manifestFile, remoteManifest, `remote staged manifest ${manifest.r2.release_manifest_key}`);

    const pointer = {
      schema_version: 1,
      release_id: manifest.release_id,
      release_manifest_key: manifest.r2.release_manifest_key,
      release_manifest_sha256: manifestFile.sha256,
      release_manifest_bytes: manifestFile.bytes,
      managed_object_count: manifest.r2.objects.length,
      published_at: publishedAt,
    };
    const pointerBuffer = Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`);
    const pointerFilePath = join(temporaryDirectory, 'current.json');
    await writeFile(pointerFilePath, pointerBuffer);

    // This is the only mutable write. R2 object replacement is atomic, and it occurs
    // only after every immutable object and the full release manifest passed readback.
    putRemoteObject(bucket, manifest.r2.current_pointer_key, pointerFilePath, 'application/json', commandOptions);
    const remotePointer = getRemoteObject(bucket, manifest.r2.current_pointer_key, commandOptions);
    assertBufferParity({ sha256: sha256(pointerBuffer), bytes: pointerBuffer.length }, remotePointer, `remote current pointer ${manifest.r2.current_pointer_key}`);
    const parsedPointer = parseCurrentPointer(remotePointer, manifest.r2.current_pointer_key);
    if (parsedPointer.release_id !== manifest.release_id || parsedPointer.release_manifest_key !== manifest.r2.release_manifest_key) {
      throw new Error('current pointer does not identify the staged release');
    }
    process.stdout.write(`[activated] ${manifest.r2.current_pointer_key} release=${manifest.release_id}\n`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  return {
    release_id: manifest.release_id,
    uploaded_objects: manifest.r2.objects.length - alreadyStaged.size,
    current_pointer_key: manifest.r2.current_pointer_key,
  };
}

export async function publishMetadata({
  bucket,
  environment,
  remote = false,
  bootstrap = false,
  root = DEFAULT_ROOT,
  runCommand = spawnSync,
  pageEvidencePromotion = false,
  rendererPath = null,
} = {}) {
  if (!bucket) throw new Error('--bucket is required');
  if (!remote) throw new Error('refusing remote mutation without explicit --remote');

  const projectRoot = resolve(root);
  const manifest = await buildReleaseManifest({
    root: projectRoot,
    pageEvidencePromotion,
    rendererPath,
  });
  assertReleaseSourceReady(manifest);
  const selectedEnvironment = environmentForBucket(manifest, bucket, environment);
  const environmentState = assertEnvironmentReleaseReady(manifest, selectedEnvironment);
  process.stdout.write(`[release] ${manifest.release_id} environment=${selectedEnvironment} worker=${environmentState.worker_revision} version=${environmentState.worker_version_id || 'local'}\n`);
  const result = await publishVersionedRelease({
    manifest,
    bucket,
    bootstrap,
    root: projectRoot,
    runCommand,
    pageEvidencePromotion,
    rendererPath,
  });
  return { ...result, environment: selectedEnvironment };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await publishMetadata({
    bucket: String(args.get('bucket') || ''),
    environment: args.get('environment'),
    remote: args.get('remote') === true,
    bootstrap: args.get('bootstrap') === true,
    pageEvidencePromotion: args.get('page-evidence-promotion') === true,
    rendererPath: args.get('renderer') || null,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`publish-metadata: ${error.message}\n`);
    process.exitCode = 1;
  });
}
