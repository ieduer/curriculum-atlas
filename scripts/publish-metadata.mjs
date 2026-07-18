#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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
import {
  createImmutableBufferSnapshot,
  createImmutableFileSnapshot,
} from './lib/immutable-release-snapshot.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RELEASE_ID_PATTERN = /^release-[a-f0-9]{32}$/;

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

function runPublicationLeaseCommand({ database, environment, command, root, runCommand, operation }) {
  const arguments_ = ['d1', 'execute', database];
  if (environment === 'preview') arguments_.push('--env', 'preview');
  arguments_.push('--remote', '--command', command);
  return runWrangler(arguments_, { root, runCommand, operation });
}

function sameOptionalBuffer(left, right) {
  if (left === null || right === null) return left === right;
  return left.byteLength === right.byteLength && left.equals(right);
}

function canonicalIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
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
  if (!RELEASE_ID_PATTERN.test(String(manifest.release_id || ''))
    || !Array.isArray(manifest.r2?.objects)) throw new Error('invalid release manifest');
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

function parseCurrentPointer(buffer, pointerKey, releasePrefix) {
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`remote ${pointerKey} is not valid JSON: ${error.message}`);
  }
  if (
    parsed.schema_version !== 1
    || !RELEASE_ID_PATTERN.test(String(parsed.release_id || ''))
    || parsed.release_manifest_key !== `${releasePrefix}/${parsed.release_id}/manifest.json`
    || !SHA256_PATTERN.test(String(parsed.release_manifest_sha256 || ''))
    || !Number.isSafeInteger(parsed.release_manifest_bytes)
    || parsed.release_manifest_bytes <= 0
    || !Number.isSafeInteger(parsed.managed_object_count)
    || parsed.managed_object_count <= 0
    || !canonicalIsoTimestamp(parsed.published_at)
  ) throw new Error(`remote ${pointerKey} is not a supported release pointer`);
  return parsed;
}

export function immutableVersionedManifest(manifest) {
  return {
    schema_version: manifest.schema_version,
    policy: manifest.policy,
    release_id: manifest.release_id,
    release_identity: manifest.release_identity,
    git: { head: manifest.git?.head || null },
    source_tree: manifest.source_tree,
    corpus_release: manifest.corpus_release,
    page_evidence: manifest.page_evidence,
    data_assets: manifest.data_assets,
    graph_assets: manifest.graph_assets,
    static_assets: manifest.static_assets,
    r2: manifest.r2,
  };
}

export function immutableVersionedManifestArtifact(manifest) {
  const buffer = Buffer.from(`${JSON.stringify(immutableVersionedManifest(manifest), null, 2)}\n`);
  return {
    buffer,
    sha256: sha256(buffer),
    bytes: buffer.length,
  };
}

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function normalizePublicationCoordination(manifest, environment) {
  const coordination = manifest.r2?.publication_coordination;
  if (!coordination || coordination.policy !== 'd1_single_writer_lease_v1') {
    throw new Error('release manifest lacks d1_single_writer_lease_v1 publication coordination');
  }
  if (!['preview', 'production'].includes(environment)) {
    throw new Error(`publication environment is invalid: ${environment || '<unset>'}`);
  }
  const database = String(coordination.databases?.[environment] || '');
  if (!/^[a-z0-9][a-z0-9-]{2,127}$/.test(database)) {
    throw new Error(`publication coordination database is invalid for ${environment}`);
  }
  const leaseKey = String(coordination.lease_key || '');
  if (!/^[a-z0-9][a-z0-9_:-]{2,127}$/.test(leaseKey)) {
    throw new Error('publication coordination lease key is invalid');
  }
  const ttl = coordination.lease_ttl_seconds;
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 7200) {
    throw new Error('publication coordination lease TTL is invalid');
  }
  return { database, lease_key: leaseKey, lease_ttl_seconds: ttl };
}

export function buildPublicationLeaseAcquireSql({ leaseKey, token, releaseId, ttlSeconds }) {
  const now = "CAST(strftime('%s','now') AS INTEGER)";
  return `DELETE FROM corpus_import_guards WHERE guard_key='r2_publication_lease';
INSERT INTO corpus_import_guards(guard_key,ok)
SELECT 'r2_publication_lease',CASE WHEN
  NOT EXISTS(SELECT 1 FROM site_meta WHERE key=${sql(leaseKey)})
  OR EXISTS(
    SELECT 1 FROM site_meta WHERE key=${sql(leaseKey)}
      AND json_valid(value)
      AND json_extract(value,'$.policy')='d1_single_writer_lease_v1'
      AND (
        json_extract(value,'$.token')=${sql(token)}
        OR CAST(json_extract(value,'$.expires_unix') AS INTEGER)<=${now}
      )
  )
THEN 1 ELSE 0 END;
INSERT INTO site_meta(key,value) VALUES(
  ${sql(leaseKey)},
  json_object(
    'policy','d1_single_writer_lease_v1',
    'token',${sql(token)},
    'release_id',${sql(releaseId)},
    'expires_unix',${now}+${ttlSeconds}
  )
) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP;
DELETE FROM corpus_import_guards WHERE guard_key='r2_publication_lease';`;
}

export function buildPublicationLeaseRenewSql({ leaseKey, token, releaseId, ttlSeconds }) {
  const now = "CAST(strftime('%s','now') AS INTEGER)";
  return `DELETE FROM corpus_import_guards WHERE guard_key='r2_publication_lease';
INSERT INTO corpus_import_guards(guard_key,ok)
SELECT 'r2_publication_lease',CASE WHEN EXISTS(
  SELECT 1 FROM site_meta WHERE key=${sql(leaseKey)}
    AND json_valid(value)
    AND json_extract(value,'$.policy')='d1_single_writer_lease_v1'
    AND json_extract(value,'$.token')=${sql(token)}
    AND json_extract(value,'$.release_id')=${sql(releaseId)}
    AND CAST(json_extract(value,'$.expires_unix') AS INTEGER)>${now}
) THEN 1 ELSE 0 END;
UPDATE site_meta SET value=json_set(value,'$.expires_unix',${now}+${ttlSeconds}),updated_at=CURRENT_TIMESTAMP
WHERE key=${sql(leaseKey)} AND json_extract(value,'$.token')=${sql(token)};
DELETE FROM corpus_import_guards WHERE guard_key='r2_publication_lease';`;
}

export function buildPublicationLeaseReleaseSql({ leaseKey, token, releaseId }) {
  return `DELETE FROM site_meta
WHERE key=${sql(leaseKey)}
  AND json_valid(value)
  AND json_extract(value,'$.policy')='d1_single_writer_lease_v1'
  AND json_extract(value,'$.token')=${sql(token)}
  AND json_extract(value,'$.release_id')=${sql(releaseId)};`;
}

async function snapshotLocalCorpusEnvelope(root, expected) {
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
  const snapshot = await createImmutableFileSnapshot({
    root,
    source,
    expected,
    label: `local corpus envelope ${source}`,
  });
  try {
    const buffer = await readFile(snapshot.path);
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
    return { manifest, snapshot };
  } catch (error) {
    await snapshot.cleanup();
    throw error;
  }
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
  environment = null,
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
  const selectedEnvironment = environment || environmentForBucket(manifest, bucket, null);
  const coordination = normalizePublicationCoordination(manifest, selectedEnvironment);
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
  const { snapshot: corpusSnapshot } = await snapshotLocalCorpusEnvelope(
    projectRoot,
    manifest.corpus_release,
  );
  const objectSnapshots = [];
  let manifestSnapshot = null;
  let pointerSnapshot = null;
  let leaseAcquired = false;
  let caughtError = null;
  const token = randomUUID();
  const leaseOptions = {
    leaseKey: coordination.lease_key,
    token,
    releaseId: manifest.release_id,
    ttlSeconds: coordination.lease_ttl_seconds,
  };
  const leaseCommand = (command, operation) => runPublicationLeaseCommand({
    database: coordination.database,
    environment: selectedEnvironment,
    command,
    root: projectRoot,
    runCommand,
    operation,
  });
  try {
    for (const object of manifest.r2.objects) {
      objectSnapshots.push({
        object,
        snapshot: await createImmutableFileSnapshot({
          root: projectRoot,
          source: object.source,
          expected: object,
          label: `R2 release object ${object.source}`,
        }),
      });
    }
    const manifestFile = immutableVersionedManifestArtifact(manifest);
    manifestSnapshot = await createImmutableBufferSnapshot({
      buffer: manifestFile.buffer,
      label: 'immutable versioned release manifest',
    });
    await corpusSnapshot.verify();
    for (const { snapshot } of objectSnapshots) await snapshot.verify();
    await manifestSnapshot.verify();
    process.stdout.write(`[preflight] private fixed snapshots sealed for ${manifest.r2.objects.length} objects\n`);

    leaseCommand(buildPublicationLeaseAcquireSql(leaseOptions), 'acquire D1 publication lease');
    leaseAcquired = true;
    const renewLease = () => leaseCommand(
      buildPublicationLeaseRenewSql(leaseOptions),
      'renew D1 publication lease',
    );

    const previousPointerBuffer = getRemoteObject(bucket, manifest.r2.current_pointer_key, {
      ...commandOptions,
      allowMissing: true,
    });
    if (previousPointerBuffer === null && !bootstrap) {
      throw new Error(`remote ${manifest.r2.current_pointer_key} is missing; first versioned publish requires explicit --bootstrap`);
    }
    let previousPointer = null;
    if (previousPointerBuffer !== null) {
      previousPointer = parseCurrentPointer(
        previousPointerBuffer,
        manifest.r2.current_pointer_key,
        manifest.r2.release_prefix,
      );
      const previousManifest = getRemoteObject(bucket, previousPointer.release_manifest_key, commandOptions);
      assertBufferParity({
        sha256: previousPointer.release_manifest_sha256,
        bytes: previousPointer.release_manifest_bytes,
      }, previousManifest, `currently published release manifest ${previousPointer.release_manifest_key}`);
      process.stdout.write(`[preflight] current pointer remains valid at ${previousPointer.release_id}\n`);
    }

    const alreadyStaged = new Set();
    for (const object of manifest.r2.objects) {
      if (inspectImmutableRemoteObject(bucket, object.release_key, object, commandOptions)) {
        alreadyStaged.add(object.release_key);
        process.stdout.write(`[preflight] immutable object already exact ${object.release_key}\n`);
      } else {
        process.stdout.write(`[preflight] immutable object missing ${object.release_key}\n`);
      }
    }
    let manifestAlreadyStaged = inspectImmutableRemoteObject(
      bucket,
      manifest.r2.release_manifest_key,
      manifestFile,
      commandOptions,
    );
    process.stdout.write(`[preflight] immutable manifest ${manifestAlreadyStaged ? 'already exact' : 'missing'} ${manifest.r2.release_manifest_key}\n`);

    let uploadedObjects = 0;
    for (const [index, { object, snapshot }] of objectSnapshots.entries()) {
      if (alreadyStaged.has(object.release_key)) continue;
      renewLease();
      if (inspectImmutableRemoteObject(bucket, object.release_key, object, commandOptions)) {
        alreadyStaged.add(object.release_key);
        continue;
      }
      await snapshot.verify();
      process.stdout.write(`[stage ${index + 1}/${manifest.r2.objects.length}] ${object.release_key}\n`);
      putRemoteObject(bucket, object.release_key, snapshot.path, object.content_type, commandOptions);
      await snapshot.verify();
      const remote = getRemoteObject(bucket, object.release_key, commandOptions);
      assertBufferParity(object, remote, `remote staged object ${object.release_key}`);
      uploadedObjects += 1;
    }
    await verifyVersionedObjects(bucket, manifest.r2.objects, commandOptions);

    if (!manifestAlreadyStaged) {
      renewLease();
      manifestAlreadyStaged = inspectImmutableRemoteObject(
        bucket,
        manifest.r2.release_manifest_key,
        manifestFile,
        commandOptions,
      );
      if (!manifestAlreadyStaged) {
        await manifestSnapshot.verify();
        putRemoteObject(
          bucket,
          manifest.r2.release_manifest_key,
          manifestSnapshot.path,
          'application/json',
          commandOptions,
        );
        await manifestSnapshot.verify();
      }
    }
    const remoteManifest = getRemoteObject(bucket, manifest.r2.release_manifest_key, commandOptions);
    assertBufferParity(manifestFile, remoteManifest, `remote staged manifest ${manifest.r2.release_manifest_key}`);

    const alreadyActivated = previousPointer
      && previousPointer.release_id === manifest.release_id
      && previousPointer.release_manifest_key === manifest.r2.release_manifest_key
      && previousPointer.release_manifest_sha256 === manifestFile.sha256
      && previousPointer.release_manifest_bytes === manifestFile.bytes
      && previousPointer.managed_object_count === manifest.r2.objects.length;
    if (!alreadyActivated) {
      renewLease();
      const pointerImmediatelyBeforeActivation = getRemoteObject(
        bucket,
        manifest.r2.current_pointer_key,
        { ...commandOptions, allowMissing: true },
      );
      if (!sameOptionalBuffer(previousPointerBuffer, pointerImmediatelyBeforeActivation)) {
        throw new Error('current pointer changed after lease acquisition; refusing lost-update activation');
      }
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
      pointerSnapshot = await createImmutableBufferSnapshot({
        buffer: pointerBuffer,
        label: 'R2 current release pointer',
      });
      await pointerSnapshot.verify();
      putRemoteObject(
        bucket,
        manifest.r2.current_pointer_key,
        pointerSnapshot.path,
        'application/json',
        commandOptions,
      );
      await pointerSnapshot.verify();
      const remotePointer = getRemoteObject(bucket, manifest.r2.current_pointer_key, commandOptions);
      assertBufferParity(pointerSnapshot, remotePointer, `remote current pointer ${manifest.r2.current_pointer_key}`);
      const parsedPointer = parseCurrentPointer(
        remotePointer,
        manifest.r2.current_pointer_key,
        manifest.r2.release_prefix,
      );
      if (parsedPointer.release_id !== manifest.release_id || parsedPointer.release_manifest_key !== manifest.r2.release_manifest_key) {
        throw new Error('current pointer does not identify the staged release');
      }
    }
    process.stdout.write(`[activated] ${manifest.r2.current_pointer_key} release=${manifest.release_id}${alreadyActivated ? ' already-exact' : ''}\n`);

    return {
      release_id: manifest.release_id,
      uploaded_objects: uploadedObjects,
      current_pointer_key: manifest.r2.current_pointer_key,
      coordination: 'd1_single_writer_lease_v1',
    };
  } catch (error) {
    caughtError = error;
    throw error;
  } finally {
    let releaseError = null;
    if (leaseAcquired) {
      try {
        leaseCommand(buildPublicationLeaseReleaseSql(leaseOptions), 'release D1 publication lease');
      } catch (error) {
        releaseError = error;
      }
    }
    await Promise.allSettled([
      corpusSnapshot.cleanup(),
      ...objectSnapshots.map(({ snapshot }) => snapshot.cleanup()),
      manifestSnapshot?.cleanup(),
      pointerSnapshot?.cleanup(),
    ].filter(Boolean));
    if (releaseError && !caughtError) throw releaseError;
  }
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
    environment: selectedEnvironment,
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
