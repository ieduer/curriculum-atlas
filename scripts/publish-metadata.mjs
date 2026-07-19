#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertCleanReleaseSource } from './assert-clean-release-source.mjs';
import { validateEnvironmentEvidenceReceipt } from './collect-release-environment-evidence.mjs';
import { validateCorpusManifest } from './import-corpus.mjs';
import {
  assertPageEvidenceReleaseMode,
  validatePageEvidenceForRelease,
} from './page-evidence-release-hook.mjs';
import {
  createImmutableBufferSnapshot,
  createImmutableFileSnapshot,
} from './lib/immutable-release-snapshot.mjs';
import {
  desiredReleaseManifest,
  desiredReleaseManifestArtifact,
  desiredReleasePin,
  parseDesiredReleaseManifestArtifact,
} from './lib/desired-release-manifest.mjs';
import { readGitBlob } from './lib/git-release-source.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_MANIFEST = '.wrangler/release-manifest.json';
const DEFAULT_EVIDENCE = '.wrangler/release-environment-evidence.json';
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RELEASE_ID_PATTERN = /^release-[a-f0-9]{32}$/;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function parseArgs(argv) {
  const args = new Map();
  const booleanArguments = new Set(['--remote', '--bootstrap', '--page-evidence-promotion']);
  const valueArguments = new Set(['--bucket', '--environment', '--renderer', '--manifest', '--evidence', '--rollback-pointer-receipt']);
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

function runWrangler(arguments_, { root, operation, runCommand = spawnSync }) {
  const result = runCommand('npx', ['--no-install', 'wrangler', ...arguments_], {
    cwd: root,
    encoding: null,
    maxBuffer: MAX_OBJECT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw safeCommandError(result, operation);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function parseRollbackPointerReceipt(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('rollback pointer receipt must be a Buffer');
  let receipt;
  try {
    receipt = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`rollback pointer receipt is not JSON: ${error.message}`);
  }
  const value = receipt?.value;
  const releaseId = String(value?.release_id || '');
  const manifestSha256 = String(value?.release_manifest_sha256 || '');
  const manifestBytes = Number(value?.release_manifest_bytes);
  const managedObjectCount = Number(value?.managed_object_count);
  const fence = Number(value?.fence);
  const publishedAt = String(value?.published_at || '');
  const canonical = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const outerKeys = receipt && typeof receipt === 'object' && !Array.isArray(receipt)
    ? Object.keys(receipt).sort() : [];
  const valueKeys = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort() : [];
  const exactOuterKeys = ['bytes', 'etag', 'exists', 'sha256', 'value', 'version'];
  const exactValueKeys = [
    'fence', 'managed_object_count', 'published_at', 'release_id', 'release_manifest_bytes',
    'release_manifest_key', 'release_manifest_sha256', 'schema_version',
  ].sort();
  const validOpaqueReceiptIdentity = (candidate) => typeof candidate === 'string'
    && candidate.length > 0 && candidate.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(candidate);
  const publishedAtMillis = Date.parse(publishedAt);
  const canonicalPublishedAt = CANONICAL_TIMESTAMP_PATTERN.test(publishedAt)
    && Number.isFinite(publishedAtMillis) && new Date(publishedAtMillis).toISOString() === publishedAt;
  if (stableStringify(outerKeys) !== stableStringify(exactOuterKeys.sort())
      || stableStringify(valueKeys) !== stableStringify(exactValueKeys)
      || receipt?.exists !== true || value?.schema_version !== 2
      || !validOpaqueReceiptIdentity(receipt.etag) || !validOpaqueReceiptIdentity(receipt.version)
      || !RELEASE_ID_PATTERN.test(releaseId) || !SHA256_PATTERN.test(manifestSha256)
      || value.release_manifest_key !== `releases/${releaseId}/manifest.json`
      || !Number.isSafeInteger(manifestBytes) || manifestBytes <= 0
      || !Number.isSafeInteger(managedObjectCount) || managedObjectCount <= 0
      || !Number.isSafeInteger(fence) || fence <= 0
      || !canonicalPublishedAt
      || receipt.sha256 !== sha256(canonical) || receipt.bytes !== canonical.length) {
    throw new Error('rollback pointer receipt identity is invalid or non-canonical');
  }
  return {
    release_id: releaseId,
    release_manifest_sha256: manifestSha256,
    release_manifest_bytes: manifestBytes,
    managed_object_count: managedObjectCount,
    source_fence: fence,
  };
}

function runPublicationLeaseCommand({ database, environment, command, root, runCommand, operation, json = false }) {
  const arguments_ = ['d1', 'execute', database];
  if (environment === 'preview') arguments_.push('--env', 'preview');
  arguments_.push('--remote', '--command', command);
  if (json) arguments_.push('--json');
  return runWrangler(arguments_, { root, runCommand, operation });
}

function findOwnerFence(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findOwnerFence(item);
      if (found !== null) return found;
    }
  } else if (value && typeof value === 'object') {
    if (Object.hasOwn(value, 'owner_fence')) {
      const fence = Number(value.owner_fence);
      if (Number.isSafeInteger(fence) && fence > 0) return fence;
    }
    for (const item of Object.values(value)) {
      const found = findOwnerFence(item);
      if (found !== null) return found;
    }
  }
  return null;
}

function parsePublicationFence(buffer) {
  let value;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`publication owner fence receipt is not JSON: ${error.message}`);
  }
  const fence = findOwnerFence(value);
  if (fence === null) throw new Error('publication owner fence receipt is missing owner_fence');
  return fence;
}

function environmentForBucket(manifest, bucket, requestedEnvironment) {
  const configured = Object.entries(manifest.r2.buckets || {}).find(([, configuredBucket]) => configuredBucket === bucket)?.[0];
  if (!configured) throw new Error(`bucket is not registered in the release policy: ${bucket}`);
  if (requestedEnvironment && requestedEnvironment !== configured) {
    throw new Error(`bucket ${bucket} belongs to ${configured}, not requested environment ${requestedEnvironment}`);
  }
  return configured;
}

function projectRelativePath(root, value, label) {
  const projectRoot = resolve(root);
  const target = resolve(projectRoot, String(value || ''));
  const relation = relative(projectRoot, target);
  if (!value || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${label} must remain inside the project root`);
  }
  return target;
}

export async function loadDesiredReleaseArtifact({
  root = DEFAULT_ROOT,
  manifestPath = DEFAULT_MANIFEST,
} = {}) {
  const buffer = await readFile(projectRelativePath(root, manifestPath, 'desired release manifest'));
  return parseDesiredReleaseManifestArtifact(buffer);
}

export function assertDesiredReleaseSourceReady(artifact, git) {
  const head = artifact?.value?.git?.head;
  if (!/^[a-f0-9]{40}$/.test(String(head || ''))) {
    throw new Error('desired release source is missing an exact Git HEAD');
  }
  if (!git || git.head !== head || git.upstream !== head) {
    throw new Error('desired release artifact does not match the clean pushed Git source gate');
  }
  return git;
}

function exactPolicyAtReleaseHead(root, artifact) {
  const buffer = readGitBlob(root, artifact.value.git.head, 'data/release-assets-policy.json');
  if (sha256(buffer) !== artifact.value.release_identity?.policy_sha256) {
    throw new Error('desired release policy bytes differ from the exact Git HEAD');
  }
  let policy;
  try {
    policy = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`desired release policy is not JSON: ${error.message}`);
  }
  return policy;
}

function exactMigrationSet(manifest) {
  return (manifest.source_tree?.files || [])
    .map((entry) => String(entry.path || ''))
    .filter((path) => /^migrations\/\d{4}_.+\.sql$/.test(path))
    .map((path) => path.slice('migrations/'.length))
    .sort();
}

export async function assertDesiredEnvironmentReleaseReady({
  root = DEFAULT_ROOT,
  artifact,
  environment,
  evidencePath = null,
  now = new Date().toISOString(),
} = {}) {
  if (!['preview', 'production'].includes(environment)) {
    throw new Error(`desired release environment is invalid: ${environment || '<unset>'}`);
  }
  const policy = exactPolicyAtReleaseHead(root, artifact);
  const source = evidencePath || DEFAULT_EVIDENCE;
  const receiptBuffer = await readFile(projectRelativePath(root, source, 'release environment evidence'));
  const receiptSnapshot = await createImmutableBufferSnapshot({
    buffer: receiptBuffer,
    label: `${environment} release environment evidence`,
  });
  try {
    const receipt = validateEnvironmentEvidenceReceipt(JSON.parse(receiptBuffer.toString('utf8')));
    if (receipt.schema_version !== 2 || receipt.contract !== 'curriculum_release_environment_evidence_v2') {
      throw new Error(`${environment} release requires desired-release-bound environment evidence v2`);
    }
    const desired = desiredReleasePin(artifact);
    if (stableStringify(receipt.desired_release) !== stableStringify(desired)) {
      throw new Error(`${environment} environment evidence targets a different desired release`);
    }
    const state = receipt.environments?.[environment];
    if (!state) throw new Error(`${environment} release environment evidence is absent`);
    const blockers = [];
    const maximumAgeHours = Number(policy.release_governance?.environment_evidence_max_age_hours);
    const ageHours = (Date.parse(now) - Date.parse(state.observed_at)) / 3_600_000;
    if (!Number.isFinite(maximumAgeHours) || maximumAgeHours <= 0
        || !Number.isFinite(ageHours) || ageHours < -0.25 || ageHours > maximumAgeHours) {
      blockers.push('environment_evidence_stale');
    }
    const migrations = exactMigrationSet(artifact.value);
    if (stableStringify([...(state.applied_migrations || [])].sort()) !== stableStringify(migrations)
        || (state.pending_migrations || []).length !== 0) {
      blockers.push('pending_or_unbound_d1_migration');
    }
    const requiredMigration = String(policy.environment_snapshot?.required_migration || '');
    if (!requiredMigration || !state.applied_migrations.includes(requiredMigration)) {
      blockers.push('required_release_fence_migration_missing');
    }
    const requiredReader = String(policy.environment_snapshot?.required_r2_release_reader || '');
    if (!requiredReader || state.r2_release_reader !== requiredReader) {
      blockers.push('versioned_fenced_r2_reader_missing');
    }
    if (state.asset_git_commit !== desired.git_head || state.asset_parity?.valid !== true) {
      blockers.push('worker_asset_git_parity_missing');
    }
    if (state.health?.http_status !== 200 || state.health?.ok !== true
        || state.health?.release_git_commit !== desired.git_head
        || state.health?.release_id !== desired.release_id
        || state.health?.release_manifest_sha256 !== desired.release_manifest_sha256
        || state.health?.release_source_tree_sha256 !== desired.source_tree_sha256
        || state.health?.corpus_release_id !== desired.corpus_release_id
        || state.health?.corpus_manifest_sha256 !== desired.corpus_manifest_sha256) {
      blockers.push('worker_health_desired_release_mismatch');
    }
    if (state.corpus?.ready !== true
        || state.corpus.release_id !== artifact.value.corpus_release.release_id
        || state.corpus.release_fingerprint_sha256 !== artifact.value.corpus_release.release_fingerprint_sha256
        || state.corpus.manifest_sha256 !== artifact.value.corpus_release.manifest_sha256
        || stableStringify(state.corpus.counts) !== stableStringify(artifact.value.corpus_release.counts)) {
      blockers.push('d1_corpus_desired_release_mismatch');
    }
    if (blockers.length) {
      throw new Error(`${environment} release is blocked before remote mutation: ${blockers.join(', ')}`);
    }
    await receiptSnapshot.verify();
    return { ...state, evidence_age_hours: ageHours, release_ready: true };
  } finally {
    await receiptSnapshot.cleanup();
  }
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

export function immutableVersionedManifest(manifest) {
  return desiredReleaseManifest(manifest);
}

export function immutableVersionedManifestArtifact(manifest) {
  return desiredReleaseManifestArtifact(manifest);
}

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function normalizePublicationCoordination(manifest, environment) {
  const coordination = manifest.r2?.publication_coordination;
  if (!coordination || coordination.policy !== 'd1_activation_claimed_r2_binding_v3') {
    throw new Error('release manifest lacks d1_activation_claimed_r2_binding_v3 publication coordination');
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
  const coordinatorUrl = String(coordination.coordinator_urls?.[environment] || '');
  if (!/^https:\/\/[^/]+\/api\/admin\/release-coordinate$/.test(coordinatorUrl)) {
    throw new Error(`publication coordinator URL is invalid for ${environment}`);
  }
  return { database, lease_key: leaseKey, lease_ttl_seconds: ttl, coordinator_url: coordinatorUrl };
}

function publicationTokenHash(token) {
  const value = String(token || '');
  if (!/^[A-Za-z0-9._:-]{16,200}$/.test(value)) throw new Error('publication owner token is invalid');
  return sha256(Buffer.from(value));
}

export function buildPublicationLeaseAcquireSql({ token, releaseId, manifestSha256, ttlSeconds }) {
  const tokenHash = publicationTokenHash(token);
  if (!SHA256_PATTERN.test(String(manifestSha256 || ''))) throw new Error('publication manifest SHA-256 is invalid');
  const now = "CAST(strftime('%s','now') AS INTEGER)";
  return `DELETE FROM corpus_import_guards WHERE guard_key='r2_publication_owner_acquire';
INSERT INTO corpus_import_guards(guard_key,ok)
SELECT 'r2_publication_owner_acquire',CASE WHEN
  (
    NOT EXISTS(SELECT 1 FROM release_publication_ownership WHERE id=1)
    OR EXISTS(
      SELECT 1 FROM release_publication_ownership WHERE id=1 AND (
        expires_unix<=${now}
        OR (
          release_id=${sql(releaseId)} AND manifest_sha256=${sql(manifestSha256)}
          AND owner_token_sha256=${sql(tokenHash)} AND expires_unix>${now}
        )
      )
    )
  )
AND NOT EXISTS(
  SELECT 1 FROM release_publication_activation_claim
  WHERE id=1 AND expires_unix>${now}
)
THEN 1 ELSE 0 END;
UPDATE release_publication_fence_state SET last_fence=last_fence+1
WHERE id=1 AND (
  NOT EXISTS(SELECT 1 FROM release_publication_ownership WHERE id=1)
  OR EXISTS(SELECT 1 FROM release_publication_ownership WHERE id=1 AND expires_unix<=${now})
);
INSERT INTO release_publication_ownership(
  id,release_id,manifest_sha256,owner_token_sha256,owner_fence,expires_unix,updated_at
) VALUES(
  1,${sql(releaseId)},${sql(manifestSha256)},${sql(tokenHash)},
  (SELECT last_fence FROM release_publication_fence_state WHERE id=1),${now}+${ttlSeconds},CURRENT_TIMESTAMP
) ON CONFLICT(id) DO UPDATE SET
  release_id=excluded.release_id,manifest_sha256=excluded.manifest_sha256,
  owner_token_sha256=excluded.owner_token_sha256,
  owner_fence=CASE WHEN release_publication_ownership.expires_unix<=${now}
    THEN excluded.owner_fence ELSE release_publication_ownership.owner_fence END,
  expires_unix=excluded.expires_unix,updated_at=CURRENT_TIMESTAMP;
DELETE FROM corpus_import_guards WHERE guard_key='r2_publication_owner_acquire';
SELECT owner_fence FROM release_publication_ownership
WHERE id=1 AND release_id=${sql(releaseId)} AND manifest_sha256=${sql(manifestSha256)}
  AND owner_token_sha256=${sql(tokenHash)} AND expires_unix>${now};`;
}

export function buildPublicationLeaseRenewSql({ token, releaseId, manifestSha256, ownerFence, ttlSeconds }) {
  const tokenHash = publicationTokenHash(token);
  const now = "CAST(strftime('%s','now') AS INTEGER)";
  return `DELETE FROM corpus_import_guards WHERE guard_key='r2_publication_lease';
INSERT INTO corpus_import_guards(guard_key,ok)
SELECT 'r2_publication_lease',CASE WHEN EXISTS(
  SELECT 1 FROM release_publication_ownership WHERE id=1
    AND release_id=${sql(releaseId)} AND manifest_sha256=${sql(manifestSha256)}
    AND owner_token_sha256=${sql(tokenHash)} AND owner_fence=${ownerFence}
    AND expires_unix>${now}
) THEN 1 ELSE 0 END;
UPDATE release_publication_ownership SET expires_unix=${now}+${ttlSeconds},updated_at=CURRENT_TIMESTAMP
WHERE id=1 AND release_id=${sql(releaseId)} AND manifest_sha256=${sql(manifestSha256)}
  AND owner_token_sha256=${sql(tokenHash)} AND owner_fence=${ownerFence} AND expires_unix>${now};
DELETE FROM corpus_import_guards WHERE guard_key='r2_publication_lease';`;
}

export function buildPublicationLeaseReleaseSql({ token, releaseId, manifestSha256, ownerFence }) {
  const tokenHash = publicationTokenHash(token);
  const now = "CAST(strftime('%s','now') AS INTEGER)";
  return `UPDATE release_publication_ownership
SET expires_unix=MIN(expires_unix,COALESCE((
    SELECT expires_unix FROM release_publication_activation_claim
    WHERE id=1 AND release_id=${sql(releaseId)} AND manifest_sha256=${sql(manifestSha256)}
      AND owner_token_sha256=${sql(tokenHash)} AND owner_fence=${ownerFence}
      AND expires_unix>${now}
  ),${now})),updated_at=CURRENT_TIMESTAMP
WHERE id=1 AND release_id=${sql(releaseId)} AND manifest_sha256=${sql(manifestSha256)}
  AND owner_token_sha256=${sql(tokenHash)} AND owner_fence=${ownerFence};`;
}

export function buildPublicationActivationClaimAcquireSql({
  token,
  releaseId,
  manifestSha256,
  ownerFence,
  activationNonce,
  ttlSeconds = 600,
}) {
  const tokenHash = publicationTokenHash(token);
  const nonceHash = publicationTokenHash(activationNonce);
  if (!RELEASE_ID_PATTERN.test(String(releaseId || '')) || !SHA256_PATTERN.test(String(manifestSha256 || ''))
      || !Number.isSafeInteger(ownerFence) || ownerFence <= 0
      || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 900) {
    throw new Error('publication activation claim identity is invalid');
  }
  const now = "CAST(strftime('%s','now') AS INTEGER)";
  return `DELETE FROM corpus_import_guards WHERE guard_key='r2_publication_activation_claim';
INSERT INTO corpus_import_guards(guard_key,ok)
SELECT 'r2_publication_activation_claim',CASE WHEN EXISTS(
  SELECT 1 FROM release_publication_ownership
  WHERE id=1 AND release_id=${sql(releaseId)} AND manifest_sha256=${sql(manifestSha256)}
    AND owner_token_sha256=${sql(tokenHash)} AND owner_fence=${ownerFence} AND expires_unix>${now}
)
AND NOT EXISTS(
  SELECT 1 FROM release_publication_activation_claim WHERE id=1 AND expires_unix>${now}
) THEN 1 ELSE 0 END;
INSERT INTO release_publication_activation_claim(
  id,release_id,manifest_sha256,owner_token_sha256,owner_fence,
  activation_nonce_sha256,expires_unix,updated_at
) VALUES(
  1,${sql(releaseId)},${sql(manifestSha256)},${sql(tokenHash)},${ownerFence},
  ${sql(nonceHash)},${now}+${ttlSeconds},CURRENT_TIMESTAMP
) ON CONFLICT(id) DO UPDATE SET
  release_id=excluded.release_id,manifest_sha256=excluded.manifest_sha256,
  owner_token_sha256=excluded.owner_token_sha256,owner_fence=excluded.owner_fence,
  activation_nonce_sha256=excluded.activation_nonce_sha256,
  expires_unix=excluded.expires_unix,updated_at=CURRENT_TIMESTAMP
WHERE release_publication_activation_claim.expires_unix<=${now};
DELETE FROM corpus_import_guards WHERE guard_key='r2_publication_activation_claim';`;
}

export function buildPublicationActivationClaimReleaseSql({
  token, releaseId, manifestSha256, ownerFence, activationNonce,
}) {
  const tokenHash = publicationTokenHash(token);
  const nonceHash = publicationTokenHash(activationNonce);
  if (!RELEASE_ID_PATTERN.test(String(releaseId || '')) || !SHA256_PATTERN.test(String(manifestSha256 || ''))
      || !Number.isSafeInteger(ownerFence) || ownerFence <= 0) {
    throw new Error('publication activation claim release identity is invalid');
  }
  return `DELETE FROM release_publication_activation_claim
WHERE id=1 AND release_id=${sql(releaseId)} AND manifest_sha256=${sql(manifestSha256)}
  AND owner_token_sha256=${sql(tokenHash)} AND owner_fence=${ownerFence}
  AND activation_nonce_sha256=${sql(nonceHash)};`;
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

async function coordinatorJson({
  url,
  operation,
  method = 'POST',
  coordinatorToken,
  ownerToken = null,
  headers = {},
  body = null,
  fetchImpl = fetch,
}) {
  if (!coordinatorToken) throw new Error('CURRICULUM_RELEASE_COORDINATOR_TOKEN is required');
  const target = new URL(url);
  target.searchParams.set('operation', operation);
  const requestHeaders = new Headers(headers);
  requestHeaders.set('authorization', `Bearer ${coordinatorToken}`);
  requestHeaders.set('cache-control', 'no-store');
  if (ownerToken) requestHeaders.set('x-release-owner-token', ownerToken);
  const response = await fetchImpl(target, { method, headers: requestHeaders, body });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`release coordinator returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(`release coordinator ${operation} failed HTTP ${response.status}: ${value.error || 'unknown error'}`);
  return value;
}

async function coordinatorCreate({
  coordination,
  coordinatorToken,
  ownerToken,
  ownerFence,
  manifest,
  manifestSha256,
  key,
  contentType,
  snapshot,
  fetchImpl,
}) {
  await snapshot.verify();
  const body = await readFile(snapshot.path);
  const target = new URL(coordination.coordinator_url);
  target.searchParams.set('key', key);
  const result = await coordinatorJson({
    url: target.href,
    operation: 'create',
    method: 'PUT',
    coordinatorToken,
    ownerToken,
    fetchImpl,
    headers: {
      'content-type': contentType,
      'content-length': String(body.length),
      'x-content-sha256': snapshot.sha256,
      'x-release-id': manifest.release_id,
      'x-release-manifest-sha256': manifestSha256,
      'x-release-owner-fence': String(ownerFence),
    },
    body,
  });
  await snapshot.verify();
  return result;
}

function assertExactReleaseInventory(manifest, manifestArtifact, inventory) {
  const expected = [...manifest.r2.objects.map((object) => object.release_key), manifest.r2.release_manifest_key].sort();
  const actual = (inventory.objects || []).map((object) => object.key).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`release prefix inventory is not exact; expected=${expected.length} actual=${actual.length}`);
  }
  const expectedByKey = new Map([
    ...manifest.r2.objects.map((object) => [object.release_key, object]),
    [manifest.r2.release_manifest_key, { ...manifestArtifact, content_type: 'application/json' }],
  ]);
  for (const object of inventory.objects) {
    const expectedObject = expectedByKey.get(object.key);
    if (!expectedObject || object.bytes !== expectedObject.bytes || object.sha256 !== expectedObject.sha256
        || object.metadata_sha256 !== expectedObject.sha256
        || object.metadata_bytes !== String(expectedObject.bytes)
        || object.metadata_release_id !== manifest.release_id
        || object.metadata_manifest_sha256 !== manifestArtifact.sha256
        || object.content_type !== expectedObject.content_type
        || object.metadata_content_type !== expectedObject.content_type) {
      throw new Error(`release prefix inventory parity failure: ${object.key}`);
    }
  }
  return true;
}

async function verifyPostActivation({ coordination, coordinatorToken, manifest, manifestArtifact, fetchImpl = fetch }) {
  const pointer = await coordinatorJson({
    url: coordination.coordinator_url,
    operation: 'inspect-pointer',
    coordinatorToken,
    fetchImpl,
  });
  const healthUrl = new URL('/api/health', coordination.coordinator_url);
  healthUrl.searchParams.set('release-verification', manifest.release_id);
  const healthResponse = await fetchImpl(healthUrl, { headers: { 'cache-control': 'no-store' } });
  const health = await healthResponse.json();
  if (!healthResponse.ok || health?.release?.gitCommit !== manifest.git.head
      || health?.release?.releaseId !== manifest.release_id
      || health?.release?.releaseManifestSha256 !== manifestArtifact.sha256
      || health?.release?.sourceTreeSha256 !== manifest.source_tree.sha256
      || health?.release?.corpusReleaseId !== manifest.corpus_release.release_id
      || health?.release?.corpusManifestSha256 !== manifest.corpus_release.manifest_sha256) {
    throw new Error('post-activation Worker proof does not match the desired release');
  }
  if (!pointer.exists || pointer.value?.release_id !== manifest.release_id
      || pointer.value?.release_manifest_sha256 !== manifestArtifact.sha256) {
    throw new Error('post-activation R2 pointer does not match the desired release');
  }
  return { pointer, health };
}

export async function rollbackVersionedReleasePointer({
  manifest,
  receiptPath,
  environment,
  root = DEFAULT_ROOT,
  runCommand = spawnSync,
  coordinatorToken = process.env.CURRICULUM_RELEASE_COORDINATOR_TOKEN,
  fetchImpl = fetch,
} = {}) {
  if (!receiptPath) throw new Error('rollback requires --rollback-pointer-receipt');
  const projectRoot = resolve(root);
  const coordination = normalizePublicationCoordination(manifest, environment);
  const receiptSource = projectRelativePath(projectRoot, receiptPath, 'rollback pointer receipt');
  const receiptBuffer = await readFile(receiptSource);
  const receiptSnapshot = await createImmutableFileSnapshot({
    root: projectRoot,
    source: relative(projectRoot, receiptSource),
    expected: { sha256: sha256(receiptBuffer), bytes: receiptBuffer.length },
    label: 'verified predecessor pointer receipt',
  });
  const target = parseRollbackPointerReceipt(receiptBuffer);
  const token = randomUUID();
  const leaseOptions = {
    token,
    releaseId: target.release_id,
    manifestSha256: target.release_manifest_sha256,
    ttlSeconds: coordination.lease_ttl_seconds,
  };
  const leaseCommand = (command, operation, json = false) => runPublicationLeaseCommand({
    database: coordination.database,
    environment,
    command,
    root: projectRoot,
    runCommand,
    operation,
    json,
  });
  let ownerFence = null;
  let leaseAcquired = false;
  let caughtError = null;
  try {
    await receiptSnapshot.verify();
    ownerFence = parsePublicationFence(leaseCommand(
      buildPublicationLeaseAcquireSql(leaseOptions),
      'acquire higher-fence rollback owner',
      true,
    ));
    leaseAcquired = true;
    const current = await coordinatorJson({
      url: coordination.coordinator_url,
      operation: 'inspect-pointer',
      coordinatorToken,
      fetchImpl,
    });
    if (!current.exists) throw new Error('rollback refuses an absent current pointer');
    if (current.value?.release_id === target.release_id
        && current.value?.release_manifest_sha256 === target.release_manifest_sha256) {
      throw new Error('rollback target is already the current release');
    }
    if (!Number.isSafeInteger(ownerFence) || ownerFence <= Number(current.value?.fence || 0)) {
      throw new Error('rollback owner fence is not strictly newer than the current pointer');
    }
    await coordinatorJson({
      url: coordination.coordinator_url,
      operation: 'inventory',
      coordinatorToken,
      ownerToken: token,
      fetchImpl,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        release_id: target.release_id,
        manifest_sha256: target.release_manifest_sha256,
        owner_fence: ownerFence,
      }),
    });
    await receiptSnapshot.verify();
    const activation = await coordinatorJson({
      url: coordination.coordinator_url,
      operation: 'activate',
      coordinatorToken,
      ownerToken: token,
      fetchImpl,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        release_id: target.release_id,
        release_manifest_sha256: target.release_manifest_sha256,
        release_manifest_bytes: target.release_manifest_bytes,
        managed_object_count: target.managed_object_count,
        owner_fence: ownerFence,
        predecessor: { exists: true, etag: current.etag, version: current.version },
      }),
    });
    const readback = await coordinatorJson({
      url: coordination.coordinator_url,
      operation: 'inspect-pointer',
      coordinatorToken,
      fetchImpl,
    });
    if (!readback.exists || readback.value?.release_id !== target.release_id
        || readback.value?.release_manifest_sha256 !== target.release_manifest_sha256
        || readback.value?.fence !== ownerFence) {
      throw new Error('rollback pointer readback does not match the higher-fence target');
    }
    return {
      rollback: true,
      release_id: target.release_id,
      replaced_release_id: current.value?.release_id || null,
      owner_fence: ownerFence,
      pointer_etag: readback.etag,
      pointer_version: readback.version,
      activation,
    };
  } catch (error) {
    caughtError = error;
    throw error;
  } finally {
    let releaseError = null;
    if (leaseAcquired) {
      try {
        leaseCommand(
          buildPublicationLeaseReleaseSql({ ...leaseOptions, ownerFence }),
          'release higher-fence rollback owner',
        );
      } catch (error) {
        releaseError = error;
      }
    }
    await receiptSnapshot.cleanup();
    if (releaseError && !caughtError) throw releaseError;
  }
}

export async function publishVersionedRelease({
  manifest,
  manifestArtifact = null,
  bucket,
  environment = null,
  bootstrap = false,
  root = DEFAULT_ROOT,
  runCommand = spawnSync,
  pageEvidencePromotion = false,
  rendererPath = null,
  pageEvidenceValidator = validatePageEvidenceForRelease,
  coordinatorToken = process.env.CURRICULUM_RELEASE_COORDINATOR_TOKEN,
  fetchImpl = fetch,
  postActivationVerifier = verifyPostActivation,
} = {}) {
  if (!bucket) throw new Error('--bucket is required');
  validateVersionedManifest(manifest);
  assertPageEvidenceReleaseMode(manifest.page_evidence, { pageEvidencePromotion });
  const projectRoot = resolve(root);
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
  let leaseAcquired = false;
  let ownerFence = null;
  let caughtError = null;
  const token = randomUUID();
  const canonicalManifestFile = immutableVersionedManifestArtifact(manifest);
  if (manifestArtifact && (!manifestArtifact.buffer?.equals(canonicalManifestFile.buffer)
      || manifestArtifact.sha256 !== canonicalManifestFile.sha256
      || manifestArtifact.bytes !== canonicalManifestFile.bytes)) {
    throw new Error('provided desired release artifact differs from its canonical manifest value');
  }
  const manifestFile = manifestArtifact || canonicalManifestFile;
  const leaseOptions = {
    token,
    releaseId: manifest.release_id,
    manifestSha256: manifestFile.sha256,
    ttlSeconds: coordination.lease_ttl_seconds,
  };
  const leaseCommand = (command, operation, json = false) => runPublicationLeaseCommand({
    database: coordination.database,
    environment: selectedEnvironment,
    command,
    root: projectRoot,
    runCommand,
    operation,
    json,
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
    manifestSnapshot = await createImmutableBufferSnapshot({
      buffer: manifestFile.buffer,
      label: 'immutable versioned release manifest',
    });
    await corpusSnapshot.verify();
    for (const { snapshot } of objectSnapshots) await snapshot.verify();
    await manifestSnapshot.verify();
    process.stdout.write(`[preflight] private fixed snapshots sealed for ${manifest.r2.objects.length} objects\n`);

    ownerFence = parsePublicationFence(leaseCommand(
      buildPublicationLeaseAcquireSql(leaseOptions),
      'acquire D1 publication owner fence',
      true,
    ));
    leaseAcquired = true;
    const renewLease = () => leaseCommand(
      buildPublicationLeaseRenewSql({ ...leaseOptions, ownerFence }),
      'renew D1 publication owner fence',
    );

    const previousPointer = await coordinatorJson({
      url: coordination.coordinator_url,
      operation: 'inspect-pointer',
      coordinatorToken,
      fetchImpl,
    });
    if (!previousPointer.exists && !bootstrap) {
      throw new Error(`remote ${manifest.r2.current_pointer_key} is missing; first versioned publish requires explicit --bootstrap`);
    }

    let uploadedObjects = 0;
    for (const [index, { object, snapshot }] of objectSnapshots.entries()) {
      renewLease();
      process.stdout.write(`[stage ${index + 1}/${manifest.r2.objects.length}] ${object.release_key}\n`);
      const staged = await coordinatorCreate({
        coordination, coordinatorToken, ownerToken: token, ownerFence,
        manifest, manifestSha256: manifestFile.sha256,
        key: object.release_key, contentType: object.content_type, snapshot, fetchImpl,
      });
      if (staged.created) uploadedObjects += 1;
    }
    renewLease();
    await coordinatorCreate({
      coordination, coordinatorToken, ownerToken: token, ownerFence,
      manifest, manifestSha256: manifestFile.sha256,
      key: manifest.r2.release_manifest_key, contentType: 'application/json', snapshot: manifestSnapshot, fetchImpl,
    });
    const inventory = await coordinatorJson({
      url: coordination.coordinator_url,
      operation: 'inventory',
      coordinatorToken,
      ownerToken: token,
      fetchImpl,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        release_id: manifest.release_id,
        manifest_sha256: manifestFile.sha256,
        owner_fence: ownerFence,
      }),
    });
    assertExactReleaseInventory(manifest, manifestFile, inventory);
    renewLease();
    const activation = await coordinatorJson({
      url: coordination.coordinator_url,
      operation: 'activate',
      coordinatorToken,
      ownerToken: token,
      fetchImpl,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        release_id: manifest.release_id,
        release_manifest_sha256: manifestFile.sha256,
        release_manifest_bytes: manifestFile.bytes,
        managed_object_count: manifest.r2.objects.length,
        owner_fence: ownerFence,
        predecessor: previousPointer.exists
          ? { exists: true, etag: previousPointer.etag, version: previousPointer.version }
          : { exists: false },
      }),
    });
    const postActivation = await postActivationVerifier({
      coordination, coordinatorToken, manifest, manifestArtifact: manifestFile, fetchImpl,
    });
    process.stdout.write(`[activated] ${manifest.r2.current_pointer_key} release=${manifest.release_id}${activation.exact ? ' already-exact' : ''} fence=${ownerFence}\n`);

    return {
      release_id: manifest.release_id,
      uploaded_objects: uploadedObjects,
      current_pointer_key: manifest.r2.current_pointer_key,
      owner_fence: ownerFence,
      coordination: 'd1_activation_claimed_r2_binding_v3',
      post_activation_pointer_sha256: postActivation.pointer.sha256,
    };
  } catch (error) {
    caughtError = error;
    throw error;
  } finally {
    let releaseError = null;
    if (leaseAcquired) {
      try {
        leaseCommand(
          buildPublicationLeaseReleaseSql({ ...leaseOptions, ownerFence }),
          'release D1 publication owner fence',
        );
      } catch (error) {
        releaseError = error;
      }
    }
    await Promise.allSettled([
      corpusSnapshot.cleanup(),
      ...objectSnapshots.map(({ snapshot }) => snapshot.cleanup()),
      manifestSnapshot?.cleanup(),
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
  manifestPath = DEFAULT_MANIFEST,
  evidencePath = null,
  runCommand = spawnSync,
  pageEvidencePromotion = false,
  rendererPath = null,
  cleanSourceValidator = assertCleanReleaseSource,
  artifactLoader = loadDesiredReleaseArtifact,
  environmentReadinessValidator = assertDesiredEnvironmentReleaseReady,
  coordinatorToken = process.env.CURRICULUM_RELEASE_COORDINATOR_TOKEN,
  fetchImpl = fetch,
  postActivationVerifier = verifyPostActivation,
  rollbackPointerReceipt = null,
} = {}) {
  if (!bucket) throw new Error('--bucket is required');
  if (!remote) throw new Error('refusing remote mutation without explicit --remote');

  const projectRoot = resolve(root);
  const artifact = await artifactLoader({ root: projectRoot, manifestPath });
  const manifest = artifact.value;
  const git = cleanSourceValidator({ root: projectRoot, requireUpstream: true, runCommand });
  assertDesiredReleaseSourceReady(artifact, git);
  const selectedEnvironment = environmentForBucket(manifest, bucket, environment);
  const environmentState = await environmentReadinessValidator({
    root: projectRoot,
    artifact,
    environment: selectedEnvironment,
    evidencePath,
  });
  process.stdout.write(`[release] ${manifest.release_id} manifest_sha256=${artifact.sha256} environment=${selectedEnvironment} worker=${environmentState.worker_name || 'unknown'} version=${environmentState.worker_version_id}\n`);
  if (rollbackPointerReceipt) {
    const rollback = await rollbackVersionedReleasePointer({
      manifest,
      receiptPath: rollbackPointerReceipt,
      environment: selectedEnvironment,
      root: projectRoot,
      runCommand,
      coordinatorToken,
      fetchImpl,
    });
    return { ...rollback, environment: selectedEnvironment };
  }
  const result = await publishVersionedRelease({
    manifest,
    manifestArtifact: artifact,
    bucket,
    environment: selectedEnvironment,
    bootstrap,
    root: projectRoot,
    runCommand,
    pageEvidencePromotion,
    rendererPath,
    coordinatorToken,
    fetchImpl,
    postActivationVerifier,
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
    manifestPath: args.get('manifest') || DEFAULT_MANIFEST,
    evidencePath: args.get('evidence') || null,
    pageEvidencePromotion: args.get('page-evidence-promotion') === true,
    rendererPath: args.get('renderer') || null,
    rollbackPointerReceipt: args.get('rollback-pointer-receipt') || null,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`publish-metadata: ${error.message}\n`);
    process.exitCode = 1;
  });
}
