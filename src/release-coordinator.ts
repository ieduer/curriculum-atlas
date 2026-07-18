import type { Env } from './types';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RELEASE_ID_PATTERN = /^release-[a-f0-9]{32}$/;
const RELEASE_PREFIX = 'releases/';
const CURRENT_POINTER_KEY = 'release/current.json';
const MAX_CREATE_BYTES = 64 * 1024 * 1024;
const ACTIVATION_CLAIM_TTL_SECONDS = 600;

type Ownership = {
  release_id: string;
  manifest_sha256: string;
  owner_token_sha256: string;
  owner_fence: number;
  expires_unix: number;
};

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

async function sha256(value: ArrayBuffer | string): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((item) => item.toString(16).padStart(2, '0')).join('');
}

function releaseKey(value: unknown, releaseId: string): string {
  const key = String(value || '');
  const prefix = `${RELEASE_PREFIX}${releaseId}/`;
  if (!key.startsWith(prefix) || key.includes('..') || key.endsWith('/')) throw new Error('release object key is invalid');
  return key;
}

function exactFence(value: unknown): number {
  const fence = Number(value);
  if (!Number.isSafeInteger(fence) || fence <= 0) throw new Error('publication fence is invalid');
  return fence;
}

async function authenticate(request: Request, env: Env): Promise<boolean> {
  const configured = env.RELEASE_COORDINATOR_TOKEN || '';
  const authorization = request.headers.get('authorization') || '';
  if (!configured || !authorization.startsWith('Bearer ')) return false;
  const [actual, expected] = await Promise.all([sha256(authorization.slice(7)), sha256(configured)]);
  return safeEqual(actual, expected);
}

async function requireOwner(request: Request, env: Env, releaseId: string, manifestSha256: string, fence: number): Promise<Ownership> {
  const token = request.headers.get('x-release-owner-token') || '';
  if (!token) throw new Error('publication owner token is missing');
  const tokenHash = await sha256(token);
  const owner = await env.DB.prepare(`SELECT release_id,manifest_sha256,owner_token_sha256,owner_fence,expires_unix
    FROM release_publication_ownership WHERE id=1`).first<Ownership>();
  const now = Math.floor(Date.now() / 1000);
  if (!owner || owner.release_id !== releaseId || owner.manifest_sha256 !== manifestSha256
      || owner.owner_fence !== fence || owner.expires_unix <= now
      || !safeEqual(owner.owner_token_sha256, tokenHash)) {
    throw new Error('publication ownership or fence is stale');
  }
  return owner;
}

async function exactObject(
  object: R2ObjectBody,
  expectedSha256: string,
  expectedBytes: number,
  releaseId?: string,
  manifestSha256?: string,
  expectedContentType?: string,
): Promise<boolean> {
  if (object.size !== expectedBytes
      || object.customMetadata?.sha256 !== expectedSha256
      || object.customMetadata?.bytes !== String(expectedBytes)) return false;
  if (releaseId && object.customMetadata?.release_id !== releaseId) return false;
  if (manifestSha256 && object.customMetadata?.manifest_sha256 !== manifestSha256) return false;
  if (expectedContentType && (object.httpMetadata?.contentType !== expectedContentType
      || object.customMetadata?.content_type !== expectedContentType)) return false;
  return await sha256(await object.arrayBuffer()) === expectedSha256;
}

function exactContentType(value: unknown): string {
  const contentType = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(contentType)) throw new Error('immutable content type is invalid');
  return contentType;
}

async function acquireActivationClaim(
  request: Request,
  env: Env,
  releaseId: string,
  manifestSha256: string,
  fence: number,
): Promise<{ tokenHash: string }> {
  const token = request.headers.get('x-release-owner-token') || '';
  if (!token) throw new Error('publication owner token is missing');
  const tokenHash = await sha256(token);
  const now = Math.floor(Date.now() / 1000);
  const claim = await env.DB.prepare(`INSERT INTO release_publication_activation_claim(
      id,release_id,manifest_sha256,owner_token_sha256,owner_fence,expires_unix,updated_at
    )
    SELECT 1,release_id,manifest_sha256,owner_token_sha256,owner_fence,?1, CURRENT_TIMESTAMP
    FROM release_publication_ownership
    WHERE id=1 AND release_id=?2 AND manifest_sha256=?3 AND owner_token_sha256=?4
      AND owner_fence=?5 AND expires_unix>?6
      AND (
        NOT EXISTS(SELECT 1 FROM release_publication_activation_claim WHERE id=1 AND expires_unix>?6)
        OR EXISTS(
          SELECT 1 FROM release_publication_activation_claim WHERE id=1
            AND release_id=?2 AND manifest_sha256=?3 AND owner_token_sha256=?4
            AND owner_fence=?5 AND expires_unix>?6
        )
      )
    ON CONFLICT(id) DO UPDATE SET
      release_id=excluded.release_id,manifest_sha256=excluded.manifest_sha256,
      owner_token_sha256=excluded.owner_token_sha256,owner_fence=excluded.owner_fence,
      expires_unix=excluded.expires_unix,updated_at=CURRENT_TIMESTAMP
    WHERE release_publication_activation_claim.expires_unix<=?6
      OR (
        release_publication_activation_claim.release_id=excluded.release_id
        AND release_publication_activation_claim.manifest_sha256=excluded.manifest_sha256
        AND release_publication_activation_claim.owner_token_sha256=excluded.owner_token_sha256
        AND release_publication_activation_claim.owner_fence=excluded.owner_fence
      )
    RETURNING owner_token_sha256`).bind(
    now + ACTIVATION_CLAIM_TTL_SECONDS, releaseId, manifestSha256, tokenHash, fence, now,
  ).first<{ owner_token_sha256: string }>();
  if (!claim || !safeEqual(claim.owner_token_sha256, tokenHash)) {
    throw new Error('publication activation claim is stale or already owned');
  }
  return { tokenHash };
}

async function releaseActivationClaim(
  env: Env,
  releaseId: string,
  manifestSha256: string,
  fence: number,
  tokenHash: string,
): Promise<boolean> {
  try {
    const result = await env.DB.prepare(`DELETE FROM release_publication_activation_claim
      WHERE id=1 AND release_id=?1 AND manifest_sha256=?2 AND owner_token_sha256=?3 AND owner_fence=?4`)
      .bind(releaseId, manifestSha256, tokenHash, fence).run();
    return Number(result.meta?.changes || 0) === 1;
  } catch (error) {
    console.error('release activation claim cleanup is deferred to bounded expiry', error);
    return false;
  }
}

async function createImmutable(request: Request, env: Env): Promise<Response> {
  const releaseId = request.headers.get('x-release-id') || '';
  const manifestSha256 = request.headers.get('x-release-manifest-sha256') || '';
  const expectedSha256 = request.headers.get('x-content-sha256') || '';
  const expectedBytes = Number(request.headers.get('content-length'));
  const fence = exactFence(request.headers.get('x-release-owner-fence'));
  if (!RELEASE_ID_PATTERN.test(releaseId) || !SHA256_PATTERN.test(manifestSha256)
      || !SHA256_PATTERN.test(expectedSha256) || !Number.isSafeInteger(expectedBytes)
      || expectedBytes <= 0 || expectedBytes > MAX_CREATE_BYTES) {
    return response({ error: 'immutable create identity is invalid' }, 400);
  }
  const key = releaseKey(new URL(request.url).searchParams.get('key'), releaseId);
  const contentType = exactContentType(request.headers.get('content-type'));
  await requireOwner(request, env, releaseId, manifestSha256, fence);
  const body = await request.arrayBuffer();
  if (body.byteLength !== expectedBytes || await sha256(body) !== expectedSha256) {
    return response({ error: 'immutable create body parity failure' }, 400);
  }
  const created = await env.SOURCES.put(key, body, {
    onlyIf: new Headers({ 'if-none-match': '*' }),
    httpMetadata: { contentType },
    customMetadata: {
      release_id: releaseId,
      manifest_sha256: manifestSha256,
      sha256: expectedSha256,
      bytes: String(expectedBytes),
      content_type: contentType,
      fence: String(fence),
    },
    sha256: expectedSha256,
  });
  if (created) return response({ created: true, key, etag: created.httpEtag, version: created.version });
  const existing = await env.SOURCES.get(key);
  if (!existing || !await exactObject(existing, expectedSha256, expectedBytes, releaseId, manifestSha256, contentType)) {
    return response({ error: 'immutable key collision', key }, 409);
  }
  return response({ created: false, exact: true, key, etag: existing.httpEtag, version: existing.version });
}

async function inspectPointer(env: Env): Promise<Response> {
  const object = await env.SOURCES.get(CURRENT_POINTER_KEY);
  if (!object) return response({ exists: false });
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength > 64 * 1024) return response({ error: 'pointer is oversized' }, 409);
  return response({
    exists: true,
    etag: object.httpEtag,
    version: object.version,
    sha256: await sha256(bytes),
    bytes: bytes.byteLength,
    value: JSON.parse(new TextDecoder().decode(bytes)),
  });
}

async function inventoryObjects(env: Env, releaseId: string): Promise<Array<Record<string, unknown>>> {
  const prefix = `${RELEASE_PREFIX}${releaseId}/`;
  const objects: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  do {
    const page = await env.SOURCES.list({ prefix, cursor, include: ['customMetadata'] });
    for (const listed of page.objects) {
      const object = await env.SOURCES.get(listed.key);
      if (!object) throw new Error(`release object disappeared during inventory: ${listed.key}`);
      const body = await object.arrayBuffer();
      objects.push({
        key: object.key,
        bytes: object.size,
        etag: object.httpEtag,
        version: object.version,
        sha256: await sha256(body),
        metadata_sha256: object.customMetadata?.sha256 || null,
        metadata_bytes: object.customMetadata?.bytes || null,
        metadata_release_id: object.customMetadata?.release_id || null,
        metadata_manifest_sha256: object.customMetadata?.manifest_sha256 || null,
        content_type: object.httpMetadata?.contentType || null,
        metadata_content_type: object.customMetadata?.content_type || null,
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  objects.sort((left, right) => String(left.key).localeCompare(String(right.key), 'en'));
  return objects;
}

async function exactInventory(env: Env, releaseId: string): Promise<Response> {
  const prefix = `${RELEASE_PREFIX}${releaseId}/`;
  const objects = await inventoryObjects(env, releaseId);
  return response({ prefix, objects });
}

async function validateStagedRelease(
  env: Env,
  releaseId: string,
  manifestSha256: string,
  manifestBytes: number,
  managedObjectCount: number,
): Promise<boolean> {
  const manifestKey = `${RELEASE_PREFIX}${releaseId}/manifest.json`;
  const object = await env.SOURCES.get(manifestKey);
  if (!object || !await exactObject(object, manifestSha256, manifestBytes, releaseId, manifestSha256, 'application/json')) return false;
  const fresh = await env.SOURCES.get(manifestKey);
  if (!fresh) return false;
  let manifest: Record<string, unknown>;
  try {
    manifest = await fresh.json<Record<string, unknown>>();
  } catch {
    return false;
  }
  const r2 = manifest.r2 as Record<string, unknown> | undefined;
  const declared = Array.isArray(r2?.objects) ? r2.objects as Array<Record<string, unknown>> : [];
  if (manifest.manifest_contract !== 'curriculum_desired_release_v2'
      || manifest.release_id !== releaseId
      || r2?.release_manifest_key !== manifestKey
      || r2?.managed_object_count !== managedObjectCount
      || declared.length !== managedObjectCount) return false;
  const expected = new Map<string, { sha256: string; bytes: number; contentType: string }>();
  for (const entry of declared) {
    const key = String(entry.release_key || '');
    const hash = String(entry.sha256 || '');
    const bytes = Number(entry.bytes);
    const contentType = String(entry.content_type || '');
    if (!key.startsWith(`${RELEASE_PREFIX}${releaseId}/`) || !SHA256_PATTERN.test(hash)
        || !Number.isSafeInteger(bytes) || bytes <= 0
        || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(contentType) || expected.has(key)) return false;
    expected.set(key, { sha256: hash, bytes, contentType });
  }
  expected.set(manifestKey, { sha256: manifestSha256, bytes: manifestBytes, contentType: 'application/json' });
  const inventory = await inventoryObjects(env, releaseId);
  if (inventory.length !== expected.size) return false;
  for (const entry of inventory) {
    const key = String(entry.key || '');
    const item = expected.get(key);
    if (!item || entry.sha256 !== item.sha256 || entry.bytes !== item.bytes
        || entry.metadata_sha256 !== item.sha256 || entry.metadata_bytes !== String(item.bytes)
        || entry.metadata_release_id !== releaseId
        || entry.metadata_manifest_sha256 !== manifestSha256
        || entry.content_type !== item.contentType
        || entry.metadata_content_type !== item.contentType) return false;
  }
  return true;
}

async function exactPointerPredecessor(env: Env, value: Record<string, unknown>): Promise<boolean> {
  const key = String(value.release_manifest_key || '');
  const hash = String(value.release_manifest_sha256 || '');
  const bytes = Number(value.release_manifest_bytes);
  if (!key.startsWith(RELEASE_PREFIX) || !key.endsWith('/manifest.json')
      || !SHA256_PATTERN.test(hash) || !Number.isSafeInteger(bytes) || bytes <= 0) return false;
  const object = await env.SOURCES.get(key);
  if (!object || object.size !== bytes) return false;
  if (value.schema_version === 1) {
    return await sha256(await object.arrayBuffer()) === hash;
  }
  return value.schema_version === 2
    && await exactObject(object, hash, bytes, String(value.release_id || ''), hash, 'application/json');
}

async function activatePointer(request: Request, env: Env): Promise<Response> {
  const input = await request.json<Record<string, unknown>>();
  const releaseId = String(input.release_id || '');
  const manifestSha256 = String(input.release_manifest_sha256 || '');
  const manifestBytes = Number(input.release_manifest_bytes);
  const managedObjectCount = Number(input.managed_object_count);
  const fence = exactFence(input.owner_fence);
  const manifestKey = `${RELEASE_PREFIX}${releaseId}/manifest.json`;
  if (!RELEASE_ID_PATTERN.test(releaseId) || !SHA256_PATTERN.test(manifestSha256)
      || !Number.isSafeInteger(manifestBytes) || manifestBytes <= 0
      || !Number.isSafeInteger(managedObjectCount) || managedObjectCount <= 0) {
    return response({ error: 'pointer activation identity is invalid' }, 400);
  }
  const claim = await acquireActivationClaim(request, env, releaseId, manifestSha256, fence);
  try {
    if (!await validateStagedRelease(env, releaseId, manifestSha256, manifestBytes, managedObjectCount)) {
      return response({ error: 'staged release prefix is absent, polluted, or inexact' }, 409);
    }
    const current = await env.SOURCES.get(CURRENT_POINTER_KEY);
    const predecessor = input.predecessor as Record<string, unknown> | null;
    if (current) {
    if (!predecessor || predecessor.exists !== true
        || predecessor.etag !== current.httpEtag || predecessor.version !== current.version) {
      return response({ error: 'pointer predecessor changed' }, 409);
    }
    let value: Record<string, unknown>;
    try {
      value = await current.json<Record<string, unknown>>();
    } catch {
      return response({ error: 'current pointer is invalid' }, 409);
    }
    if (!await exactPointerPredecessor(env, value)) {
      return response({ error: 'current pointer predecessor manifest is absent or inexact' }, 409);
    }
    const currentFence = Number(value.fence || 0);
    const alreadyExact = value.release_id === releaseId
      && value.release_manifest_sha256 === manifestSha256
      && value.release_manifest_bytes === manifestBytes
      && value.managed_object_count === managedObjectCount;
    if (!Number.isSafeInteger(currentFence) || fence < currentFence) {
      return response({ error: 'publication fence is not monotonic' }, 409);
    }
    if (alreadyExact) return response({ activated: false, exact: true, etag: current.httpEtag, version: current.version, value });
    if (fence === currentFence) {
      return response({ error: 'publication fence is not monotonic' }, 409);
    }
    } else if (predecessor && predecessor.exists !== false) {
      return response({ error: 'pointer predecessor changed' }, 409);
    }
    const value = {
    schema_version: 2,
    release_id: releaseId,
    release_manifest_key: manifestKey,
    release_manifest_sha256: manifestSha256,
    release_manifest_bytes: manifestBytes,
    managed_object_count: managedObjectCount,
    fence,
    published_at: new Date().toISOString(),
  };
    const body = new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
    const conditional = current
      ? new Headers({ 'if-match': current.httpEtag })
      : new Headers({ 'if-none-match': '*' });
    const written = await env.SOURCES.put(CURRENT_POINTER_KEY, body, {
    onlyIf: conditional,
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { release_id: releaseId, manifest_sha256: manifestSha256, fence: String(fence) },
    sha256: await sha256(body.buffer),
    });
    if (!written) return response({ error: 'pointer conditional activation failed' }, 409);
    return response({
    activated: true,
    etag: written.httpEtag,
    version: written.version,
    sha256: await sha256(body.buffer),
    bytes: body.byteLength,
    value,
    });
  } finally {
    await releaseActivationClaim(env, releaseId, manifestSha256, fence, claim.tokenHash);
  }
}

export async function handleReleaseCoordinator(request: Request, env: Env): Promise<Response> {
  if (!await authenticate(request, env)) return response({ error: 'unauthorized' }, 401);
  const url = new URL(request.url);
  const operation = url.searchParams.get('operation');
  try {
    if (operation === 'create' && request.method === 'PUT') return await createImmutable(request, env);
    if (operation === 'inspect-pointer' && request.method === 'POST') return await inspectPointer(env);
    if (operation === 'inventory' && request.method === 'POST') {
      const input = await request.json<{ release_id?: string; manifest_sha256?: string; owner_fence?: number }>();
      const releaseId = String(input.release_id || '');
      const manifestSha256 = String(input.manifest_sha256 || '');
      const fence = exactFence(input.owner_fence);
      if (!RELEASE_ID_PATTERN.test(releaseId) || !SHA256_PATTERN.test(manifestSha256)) {
        return response({ error: 'release inventory identity is invalid' }, 400);
      }
      await requireOwner(request, env, releaseId, manifestSha256, fence);
      return await exactInventory(env, releaseId);
    }
    if (operation === 'activate' && request.method === 'POST') return await activatePointer(request, env);
    return response({ error: 'unsupported coordinator operation' }, 404);
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : String(error) }, 409);
  }
}
