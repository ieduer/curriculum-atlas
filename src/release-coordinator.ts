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

type ActivationClaim = {
  tokenHash: string;
  nonceHash: string;
  expiresUnix: number;
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
): Promise<ActivationClaim> {
  const token = request.headers.get('x-release-owner-token') || '';
  if (!token) throw new Error('publication owner token is missing');
  const tokenHash = await sha256(token);
  const nonceHash = await sha256(crypto.randomUUID());
  const now = Math.floor(Date.now() / 1000);
  const expiresUnix = now + ACTIVATION_CLAIM_TTL_SECONDS;
  const claim = await env.DB.prepare(`INSERT INTO release_publication_activation_claim(
      id,release_id,manifest_sha256,owner_token_sha256,owner_fence,activation_nonce_sha256,expires_unix,updated_at
    )
    SELECT 1,release_id,manifest_sha256,owner_token_sha256,owner_fence,?1,?2,CURRENT_TIMESTAMP
    FROM release_publication_ownership
    WHERE id=1 AND release_id=?3 AND manifest_sha256=?4 AND owner_token_sha256=?5
      AND owner_fence=?6 AND expires_unix>?7
      AND NOT EXISTS(SELECT 1 FROM release_publication_activation_claim WHERE id=1 AND expires_unix>?7)
    ON CONFLICT(id) DO UPDATE SET
      release_id=excluded.release_id,manifest_sha256=excluded.manifest_sha256,
      owner_token_sha256=excluded.owner_token_sha256,owner_fence=excluded.owner_fence,
      activation_nonce_sha256=excluded.activation_nonce_sha256,
      expires_unix=excluded.expires_unix,updated_at=CURRENT_TIMESTAMP
    WHERE release_publication_activation_claim.expires_unix<=?7
    RETURNING owner_token_sha256,activation_nonce_sha256,expires_unix`).bind(
    nonceHash, expiresUnix, releaseId, manifestSha256, tokenHash, fence, now,
  ).first<{ owner_token_sha256: string; activation_nonce_sha256: string; expires_unix: number }>();
  if (!claim || !safeEqual(claim.owner_token_sha256, tokenHash)
      || !safeEqual(claim.activation_nonce_sha256, nonceHash)
      || Number(claim.expires_unix) !== expiresUnix) {
    throw new Error('publication activation claim is stale or already owned');
  }
  return { tokenHash, nonceHash, expiresUnix };
}

async function releaseActivationClaim(
  env: Env,
  releaseId: string,
  manifestSha256: string,
  fence: number,
  tokenHash: string,
  nonceHash: string,
): Promise<boolean> {
  try {
    const result = await env.DB.prepare(`DELETE FROM release_publication_activation_claim
      WHERE id=1 AND release_id=?1 AND manifest_sha256=?2 AND owner_token_sha256=?3
        AND owner_fence=?4 AND activation_nonce_sha256=?5`)
      .bind(releaseId, manifestSha256, tokenHash, fence, nonceHash).run();
    return Number(result.meta?.changes || 0) === 1;
  } catch (error) {
    console.error('release activation claim cleanup is deferred to bounded expiry', error);
    return false;
  }
}

export async function acquireCreateLease(
  env: Env,
  releaseId: string,
  manifestSha256: string,
  fence: number,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const lease = await env.DB.prepare(`INSERT INTO release_publication_prefix_state(
      release_id,manifest_sha256,owner_fence,active_creates,sealed,activated,updated_at
    )
    SELECT release_id,manifest_sha256,owner_fence,1,0,0,CURRENT_TIMESTAMP
    FROM release_publication_ownership
    WHERE id=1 AND release_id=?1 AND manifest_sha256=?2 AND owner_fence=?3 AND expires_unix>?4
      AND NOT EXISTS(SELECT 1 FROM release_publication_activation_claim WHERE id=1 AND expires_unix>?4)
    ON CONFLICT(release_id) DO UPDATE SET
      manifest_sha256=excluded.manifest_sha256,
      owner_fence=excluded.owner_fence,
      active_creates=release_publication_prefix_state.active_creates+1,
      sealed=0,
      updated_at=CURRENT_TIMESTAMP
    WHERE release_publication_prefix_state.activated=0
      AND (release_publication_prefix_state.sealed=0
        OR NOT EXISTS(SELECT 1 FROM release_publication_activation_claim WHERE id=1 AND expires_unix>?4))
      AND release_publication_prefix_state.manifest_sha256=excluded.manifest_sha256
      AND release_publication_prefix_state.owner_fence=excluded.owner_fence
    RETURNING active_creates`).bind(releaseId, manifestSha256, fence, now)
    .first<{ active_creates: number }>();
  if (!lease || Number(lease.active_creates) < 1) {
    throw new Error('release prefix is sealed by activation or already activated');
  }
}

export async function releaseCreateLease(
  env: Env,
  releaseId: string,
  manifestSha256: string,
  fence: number,
): Promise<void> {
  await env.DB.prepare(`UPDATE release_publication_prefix_state
    SET active_creates=active_creates-1,updated_at=CURRENT_TIMESTAMP
    WHERE release_id=?1 AND manifest_sha256=?2 AND owner_fence=?3 AND active_creates>0`)
    .bind(releaseId, manifestSha256, fence).run();
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
  await acquireCreateLease(env, releaseId, manifestSha256, fence);
  try {
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
  } finally {
    await releaseCreateLease(env, releaseId, manifestSha256, fence);
  }
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
): Promise<Record<string, unknown> | null> {
  const manifestKey = `${RELEASE_PREFIX}${releaseId}/manifest.json`;
  const object = await env.SOURCES.get(manifestKey);
  if (!object || !await exactObject(object, manifestSha256, manifestBytes, releaseId, manifestSha256, 'application/json')) return null;
  const fresh = await env.SOURCES.get(manifestKey);
  if (!fresh) return null;
  let manifest: Record<string, unknown>;
  try {
    manifest = await fresh.json<Record<string, unknown>>();
  } catch {
    return null;
  }
  const r2 = manifest.r2 as Record<string, unknown> | undefined;
  const declared = Array.isArray(r2?.objects) ? r2.objects as Array<Record<string, unknown>> : [];
  if (manifest.manifest_contract !== 'curriculum_desired_release_v2'
      || manifest.release_id !== releaseId
      || r2?.release_manifest_key !== manifestKey
      || r2?.managed_object_count !== managedObjectCount
      || declared.length !== managedObjectCount) return null;
  const expected = new Map<string, { sha256: string; bytes: number; contentType: string }>();
  for (const entry of declared) {
    const key = String(entry.release_key || '');
    const hash = String(entry.sha256 || '');
    const bytes = Number(entry.bytes);
    const contentType = String(entry.content_type || '');
    if (!key.startsWith(`${RELEASE_PREFIX}${releaseId}/`) || !SHA256_PATTERN.test(hash)
        || !Number.isSafeInteger(bytes) || bytes <= 0
        || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(contentType) || expected.has(key)) return null;
    expected.set(key, { sha256: hash, bytes, contentType });
  }
  expected.set(manifestKey, { sha256: manifestSha256, bytes: manifestBytes, contentType: 'application/json' });
  const inventory = await inventoryObjects(env, releaseId);
  if (inventory.length !== expected.size) return null;
  for (const entry of inventory) {
    const key = String(entry.key || '');
    const item = expected.get(key);
    if (!item || entry.sha256 !== item.sha256 || entry.bytes !== item.bytes
        || entry.metadata_sha256 !== item.sha256 || entry.metadata_bytes !== String(item.bytes)
        || entry.metadata_release_id !== releaseId
        || entry.metadata_manifest_sha256 !== manifestSha256
        || entry.content_type !== item.contentType
        || entry.metadata_content_type !== item.contentType) return null;
  }
  return manifest;
}

function exactNonNegative(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('corpus release count is invalid');
  return number;
}

type DesiredCorpus = {
  release_id: string;
  release_fingerprint_sha256: string;
  manifest_sha256: string;
  counts: Record<string, unknown>;
};

function desiredCorpusFromManifest(manifest: Record<string, unknown>): DesiredCorpus {
  const corpus = manifest.corpus_release as Record<string, unknown> | undefined;
  const counts = corpus?.counts as Record<string, unknown> | undefined;
  if (!corpus || !/^corpus-[a-f0-9]{24}$/.test(String(corpus.release_id || ''))
      || !SHA256_PATTERN.test(String(corpus.release_fingerprint_sha256 || ''))
      || !SHA256_PATTERN.test(String(corpus.manifest_sha256 || '')) || !counts) {
    throw new Error('staged release lacks an exact corpus identity');
  }
  for (const key of [
    'documents', 'paragraphs', 'fts_rows', 'page_publication_gates',
    'displayed_paragraphs', 'accepted_ocr_documents', 'chunks',
  ]) exactNonNegative(counts[key]);
  if (!counts.core_table_counts || typeof counts.core_table_counts !== 'object') {
    throw new Error('staged release lacks exact corpus core counts');
  }
  return {
    release_id: String(corpus.release_id),
    release_fingerprint_sha256: String(corpus.release_fingerprint_sha256),
    manifest_sha256: String(corpus.manifest_sha256),
    counts,
  };
}

async function stagedCorpusReady(env: Env, corpus: DesiredCorpus): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT r.*,
      (SELECT COUNT(*) FROM documents WHERE corpus_release_id=r.release_id) AS live_documents,
      (SELECT COUNT(*) FROM paragraphs WHERE corpus_release_id=r.release_id) AS live_paragraphs,
      (SELECT COUNT(*) FROM paragraph_fts) AS live_fts_rows,
      (SELECT COUNT(*) FROM page_publication_gates WHERE corpus_release_id=r.release_id) AS live_page_gates,
      (SELECT COUNT(*) FROM paragraphs WHERE corpus_release_id=r.release_id AND display_allowed=1) AS live_displayed_paragraphs,
      (SELECT COUNT(DISTINCT document_id) FROM page_publication_gates
        WHERE corpus_release_id=r.release_id AND publication_basis='accepted_ocr_page_manifest') AS live_accepted_ocr_documents,
      (SELECT COUNT(*) FROM corpus_import_chunks WHERE release_id=r.release_id) AS live_chunks,
      json_object(
        'subjects',(SELECT COUNT(*) FROM subjects),
        'periods',(SELECT COUNT(*) FROM periods),
        'document_relations',(SELECT COUNT(*) FROM document_relations),
        'chapters',(SELECT COUNT(*) FROM chapters),
        'document_classifications',(SELECT COUNT(*) FROM document_classifications dc JOIN documents d ON d.id=dc.document_id WHERE d.corpus_release_id=r.release_id),
        'document_sources',(SELECT COUNT(*) FROM document_sources ds JOIN documents d ON d.id=ds.document_id WHERE d.corpus_release_id=r.release_id),
        'primary_document_sources',(SELECT COUNT(*) FROM document_sources ds JOIN documents d ON d.id=ds.document_id WHERE d.corpus_release_id=r.release_id AND ds.is_primary=1),
        'subject_insights',(SELECT COUNT(*) FROM subject_insights),
        'terms',(SELECT COUNT(*) FROM terms),
        'term_relations',(SELECT COUNT(*) FROM term_relations),
        'version_diffs',(SELECT COUNT(*) FROM version_diffs),
        'online_verifications',(SELECT COUNT(*) FROM online_verifications WHERE corpus_release_id=r.release_id),
        'online_evidence',(SELECT COUNT(*) FROM online_evidence oe JOIN online_verifications ov ON ov.id=oe.verification_id WHERE ov.corpus_release_id=r.release_id),
        'embedded_items',(SELECT COUNT(*) FROM embedded_items WHERE corpus_release_id=r.release_id)
      ) AS live_core_counts_json
    FROM corpus_import_releases r
    WHERE r.release_id=?1 AND r.release_fingerprint_sha256=?2 AND r.manifest_sha256=?3 AND r.state='ready'`)
    .bind(corpus.release_id, corpus.release_fingerprint_sha256, corpus.manifest_sha256)
    .first<Record<string, unknown>>();
  if (!row) return false;
  const counts = corpus.counts;
  const expected = {
    actual_documents: counts.documents,
    actual_paragraphs: counts.paragraphs,
    actual_fts_rows: counts.fts_rows,
    actual_page_gates: counts.page_publication_gates,
    actual_displayed_paragraphs: counts.displayed_paragraphs,
    actual_chunks: counts.chunks,
    live_documents: counts.documents,
    live_paragraphs: counts.paragraphs,
    live_fts_rows: counts.fts_rows,
    live_page_gates: counts.page_publication_gates,
    live_displayed_paragraphs: counts.displayed_paragraphs,
    live_accepted_ocr_documents: counts.accepted_ocr_documents,
    live_chunks: counts.chunks,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (Number(row[key]) !== Number(value)) return false;
  }
  const expectedCore = JSON.stringify(counts.core_table_counts);
  return String(row.expected_core_counts_json || '') === expectedCore
    && String(row.actual_core_counts_json || '') === expectedCore
    && String(row.live_core_counts_json || '') === expectedCore;
}

type D1Predecessor = {
  corpusReleaseId: string;
  corpusManifestSha256: string;
  importState: string;
  acceptedOcrDocumentCount: string;
  releaseId: string;
  releaseManifestKey: string;
  releaseManifestSha256: string;
  releaseManifestBytes: string;
  releaseManagedObjectCount: string;
  releaseFence: string;
};

async function inspectD1Predecessor(env: Env): Promise<D1Predecessor> {
  const rows = await env.DB.prepare(`SELECT key,value FROM site_meta WHERE key IN (
    'current_corpus_release_id','current_corpus_manifest_sha256','corpus_import_state','accepted_ocr_document_count',
    'current_release_id','current_release_manifest_key','current_release_manifest_sha256',
    'current_release_manifest_bytes','current_release_managed_object_count','current_release_fence'
  )`).all<{ key: string; value: string }>();
  const values = new Map(rows.results.map((row) => [row.key, row.value]));
  return {
    corpusReleaseId: values.get('current_corpus_release_id') || '',
    corpusManifestSha256: values.get('current_corpus_manifest_sha256') || '',
    importState: values.get('corpus_import_state') || '',
    acceptedOcrDocumentCount: values.get('accepted_ocr_document_count') || '',
    releaseId: values.get('current_release_id') || '',
    releaseManifestKey: values.get('current_release_manifest_key') || '',
    releaseManifestSha256: values.get('current_release_manifest_sha256') || '',
    releaseManifestBytes: values.get('current_release_manifest_bytes') || '',
    releaseManagedObjectCount: values.get('current_release_managed_object_count') || '',
    releaseFence: values.get('current_release_fence') || '',
  };
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

async function d1MatchesPointerPredecessor(
  env: Env,
  predecessor: D1Predecessor,
  value: Record<string, unknown>,
): Promise<boolean> {
  const pointer = {
    releaseId: String(value.release_id || ''),
    releaseManifestKey: String(value.release_manifest_key || ''),
    releaseManifestSha256: String(value.release_manifest_sha256 || ''),
    releaseManifestBytes: String(value.release_manifest_bytes || ''),
    releaseManagedObjectCount: String(value.managed_object_count || ''),
    releaseFence: String(value.fence || ''),
  };
  const exact = predecessor.releaseId === pointer.releaseId
    && predecessor.releaseManifestKey === pointer.releaseManifestKey
    && predecessor.releaseManifestSha256 === pointer.releaseManifestSha256
    && predecessor.releaseManifestBytes === pointer.releaseManifestBytes
    && predecessor.releaseManagedObjectCount === pointer.releaseManagedObjectCount
    && predecessor.releaseFence === pointer.releaseFence;
  if (value.schema_version === 1) {
    const legacyUnpinned = [
      predecessor.releaseId, predecessor.releaseManifestKey, predecessor.releaseManifestSha256,
      predecessor.releaseManifestBytes, predecessor.releaseManagedObjectCount, predecessor.releaseFence,
    ].every((entry) => entry === '');
    return exact || legacyUnpinned;
  }
  if (value.schema_version !== 2 || !exact) return false;
  const prefix = await env.DB.prepare(`SELECT release_id,manifest_sha256,owner_fence,active_creates,sealed,activated
    FROM release_publication_prefix_state WHERE release_id=?1 AND manifest_sha256=?2`).bind(
    pointer.releaseId, pointer.releaseManifestSha256,
  ).first<Record<string, unknown>>();
  return Boolean(prefix)
    && Number(prefix?.owner_fence) === Number(value.fence)
    && Number(prefix?.active_creates) === 0
    && Number(prefix?.sealed) === 1
    && Number(prefix?.activated) === 1;
}

async function activateD1CorpusRelease(
  env: Env,
  {
    corpus,
    predecessor,
    releaseId,
    manifestKey,
    manifestSha256,
    manifestBytes,
    managedObjectCount,
    fence,
  }: {
    corpus: DesiredCorpus;
    predecessor: D1Predecessor;
    releaseId: string;
    manifestKey: string;
    manifestSha256: string;
    manifestBytes: number;
    managedObjectCount: number;
    fence: number;
  },
): Promise<void> {
  const guardKey = `release_activation:${fence}`;
  const expected = [
    ['current_corpus_release_id', predecessor.corpusReleaseId],
    ['current_corpus_manifest_sha256', predecessor.corpusManifestSha256],
    ['corpus_import_state', predecessor.importState],
    ['accepted_ocr_document_count', predecessor.acceptedOcrDocumentCount],
    ['current_release_id', predecessor.releaseId],
    ['current_release_manifest_key', predecessor.releaseManifestKey],
    ['current_release_manifest_sha256', predecessor.releaseManifestSha256],
    ['current_release_manifest_bytes', predecessor.releaseManifestBytes],
    ['current_release_managed_object_count', predecessor.releaseManagedObjectCount],
    ['current_release_fence', predecessor.releaseFence],
  ];
  const guardBindings: unknown[] = [guardKey];
  const bindGuard = (value: unknown): string => {
    guardBindings.push(value);
    return `?${guardBindings.length}`;
  };
  const predecessorChecks = expected.map(([key, value]) =>
    `COALESCE((SELECT value FROM site_meta WHERE key=${bindGuard(key)}),'')=${bindGuard(value)}`)
    .join(' AND ');
  const counts = corpus.counts;
  const coreCounts = JSON.stringify(counts.core_table_counts);
  const releaseRowCheck = `EXISTS(
    SELECT 1 FROM corpus_import_releases r
    WHERE r.release_id=${bindGuard(corpus.release_id)}
      AND r.release_fingerprint_sha256=${bindGuard(corpus.release_fingerprint_sha256)}
      AND r.manifest_sha256=${bindGuard(corpus.manifest_sha256)}
      AND r.state='ready'
      AND r.expected_documents=${bindGuard(exactNonNegative(counts.documents))}
      AND r.expected_paragraphs=${bindGuard(exactNonNegative(counts.paragraphs))}
      AND r.expected_fts_rows=${bindGuard(exactNonNegative(counts.fts_rows))}
      AND r.expected_page_gates=${bindGuard(exactNonNegative(counts.page_publication_gates))}
      AND r.expected_displayed_paragraphs=${bindGuard(exactNonNegative(counts.displayed_paragraphs))}
      AND r.accepted_ocr_documents=${bindGuard(exactNonNegative(counts.accepted_ocr_documents))}
      AND r.expected_chunks=${bindGuard(exactNonNegative(counts.chunks))}
      AND r.expected_core_counts_json=${bindGuard(coreCounts)}
      AND r.actual_documents=r.expected_documents
      AND r.actual_paragraphs=r.expected_paragraphs
      AND r.actual_fts_rows=r.expected_fts_rows
      AND r.actual_page_gates=r.expected_page_gates
      AND r.actual_displayed_paragraphs=r.expected_displayed_paragraphs
      AND r.actual_chunks=r.expected_chunks
      AND r.actual_core_counts_json=r.expected_core_counts_json
  )`;
  const liveChecks = [
    `(SELECT COUNT(*) FROM documents WHERE corpus_release_id=${bindGuard(corpus.release_id)})=${bindGuard(exactNonNegative(counts.documents))}`,
    `(SELECT COUNT(*) FROM paragraphs WHERE corpus_release_id=${bindGuard(corpus.release_id)})=${bindGuard(exactNonNegative(counts.paragraphs))}`,
    `(SELECT COUNT(*) FROM paragraph_fts)=${bindGuard(exactNonNegative(counts.fts_rows))}`,
    `(SELECT COUNT(*) FROM page_publication_gates WHERE corpus_release_id=${bindGuard(corpus.release_id)})=${bindGuard(exactNonNegative(counts.page_publication_gates))}`,
    `(SELECT COUNT(*) FROM paragraphs WHERE corpus_release_id=${bindGuard(corpus.release_id)} AND display_allowed=1)=${bindGuard(exactNonNegative(counts.displayed_paragraphs))}`,
    `(SELECT COUNT(DISTINCT document_id) FROM page_publication_gates WHERE corpus_release_id=${bindGuard(corpus.release_id)} AND publication_basis='accepted_ocr_page_manifest')=${bindGuard(exactNonNegative(counts.accepted_ocr_documents))}`,
    `(SELECT COUNT(*) FROM corpus_import_chunks WHERE release_id=${bindGuard(corpus.release_id)})=${bindGuard(exactNonNegative(counts.chunks))}`,
    `json_object(
      'subjects',(SELECT COUNT(*) FROM subjects),
      'periods',(SELECT COUNT(*) FROM periods),
      'document_relations',(SELECT COUNT(*) FROM document_relations),
      'chapters',(SELECT COUNT(*) FROM chapters),
      'document_classifications',(SELECT COUNT(*) FROM document_classifications dc JOIN documents d ON d.id=dc.document_id WHERE d.corpus_release_id=${bindGuard(corpus.release_id)}),
      'document_sources',(SELECT COUNT(*) FROM document_sources ds JOIN documents d ON d.id=ds.document_id WHERE d.corpus_release_id=${bindGuard(corpus.release_id)}),
      'primary_document_sources',(SELECT COUNT(*) FROM document_sources ds JOIN documents d ON d.id=ds.document_id WHERE d.corpus_release_id=${bindGuard(corpus.release_id)} AND ds.is_primary=1),
      'subject_insights',(SELECT COUNT(*) FROM subject_insights),
      'terms',(SELECT COUNT(*) FROM terms),
      'term_relations',(SELECT COUNT(*) FROM term_relations),
      'version_diffs',(SELECT COUNT(*) FROM version_diffs),
      'online_verifications',(SELECT COUNT(*) FROM online_verifications WHERE corpus_release_id=${bindGuard(corpus.release_id)}),
      'online_evidence',(SELECT COUNT(*) FROM online_evidence oe JOIN online_verifications ov ON ov.id=oe.verification_id WHERE ov.corpus_release_id=${bindGuard(corpus.release_id)}),
      'embedded_items',(SELECT COUNT(*) FROM embedded_items WHERE corpus_release_id=${bindGuard(corpus.release_id)})
    )=${bindGuard(coreCounts)}`,
  ].join(' AND ');
  const prefixCheck = `EXISTS(
    SELECT 1 FROM release_publication_prefix_state
    WHERE release_id=${bindGuard(releaseId)} AND manifest_sha256=${bindGuard(manifestSha256)}
      AND owner_fence=${bindGuard(fence)} AND active_creates=0 AND sealed=1
  )`;
  const statements = [
    env.DB.prepare('DELETE FROM corpus_import_guards WHERE guard_key=?1').bind(guardKey),
    env.DB.prepare(`INSERT INTO corpus_import_guards(guard_key,ok)
      SELECT ?1,CASE WHEN ${predecessorChecks} AND ${releaseRowCheck}
        AND ${liveChecks} AND ${prefixCheck} THEN 1 ELSE 0 END`).bind(...guardBindings),
  ];
  const nextMeta = [
    ['current_corpus_release_id', corpus.release_id],
    ['current_corpus_manifest_sha256', corpus.manifest_sha256],
    ['corpus_import_state', 'ready'],
    ['accepted_ocr_document_count', String(exactNonNegative(corpus.counts.accepted_ocr_documents))],
    ['current_release_id', releaseId],
    ['current_release_manifest_key', manifestKey],
    ['current_release_manifest_sha256', manifestSha256],
    ['current_release_manifest_bytes', String(manifestBytes)],
    ['current_release_managed_object_count', String(managedObjectCount)],
    ['current_release_fence', String(fence)],
  ];
  for (const [key, value] of nextMeta) {
    statements.push(env.DB.prepare(`INSERT INTO site_meta(key,value) SELECT ?1,?2
      WHERE EXISTS(SELECT 1 FROM corpus_import_guards WHERE guard_key=?3)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`)
      .bind(key, value, guardKey));
  }
  statements.push(env.DB.prepare(`UPDATE release_publication_prefix_state
    SET activated=1,sealed=1,updated_at=CURRENT_TIMESTAMP
    WHERE release_id=?1 AND manifest_sha256=?2 AND owner_fence=?3 AND sealed=1 AND active_creates=0`)
    .bind(releaseId, manifestSha256, fence));
  statements.push(env.DB.prepare('DELETE FROM corpus_import_guards WHERE guard_key=?1').bind(guardKey));
  await env.DB.batch(statements);
  const current = await inspectD1Predecessor(env);
  const prefix = await env.DB.prepare(`SELECT owner_fence,active_creates,sealed,activated
    FROM release_publication_prefix_state WHERE release_id=?1 AND manifest_sha256=?2`).bind(
    releaseId, manifestSha256,
  ).first<Record<string, unknown>>();
  if (current.corpusReleaseId !== corpus.release_id
      || current.corpusManifestSha256 !== corpus.manifest_sha256
      || current.importState !== 'ready'
      || current.releaseId !== releaseId
      || current.releaseManifestKey !== manifestKey
      || current.releaseManifestSha256 !== manifestSha256
      || current.releaseManifestBytes !== String(manifestBytes)
      || current.releaseManagedObjectCount !== String(managedObjectCount)
      || current.releaseFence !== String(fence)
      || Number(prefix?.owner_fence) !== fence
      || Number(prefix?.active_creates) !== 0
      || Number(prefix?.sealed) !== 1
      || Number(prefix?.activated) !== 1) {
    throw new Error('D1 release activation CAS did not reach the exact desired state');
  }
}

async function rollbackD1Activation(
  env: Env,
  {
    corpus, predecessor, releaseId, manifestKey, manifestSha256, manifestBytes, managedObjectCount, fence,
  }: {
    corpus: DesiredCorpus;
    predecessor: D1Predecessor;
    releaseId: string;
    manifestKey: string;
    manifestSha256: string;
    manifestBytes: number;
    managedObjectCount: number;
    fence: number;
  },
): Promise<boolean> {
  const current = await inspectD1Predecessor(env);
  if (JSON.stringify(current) === JSON.stringify(predecessor)) return true;
  const activated = {
    corpusReleaseId: corpus.release_id,
    corpusManifestSha256: corpus.manifest_sha256,
    importState: 'ready',
    acceptedOcrDocumentCount: String(exactNonNegative(corpus.counts.accepted_ocr_documents)),
    releaseId,
    releaseManifestKey: manifestKey,
    releaseManifestSha256: manifestSha256,
    releaseManifestBytes: String(manifestBytes),
    releaseManagedObjectCount: String(managedObjectCount),
    releaseFence: String(fence),
  };
  if (JSON.stringify(current) !== JSON.stringify(activated)) return false;
  const currentEntries = [
    ['current_corpus_release_id', activated.corpusReleaseId],
    ['current_corpus_manifest_sha256', activated.corpusManifestSha256],
    ['corpus_import_state', activated.importState],
    ['accepted_ocr_document_count', activated.acceptedOcrDocumentCount],
    ['current_release_id', activated.releaseId],
    ['current_release_manifest_key', activated.releaseManifestKey],
    ['current_release_manifest_sha256', activated.releaseManifestSha256],
    ['current_release_manifest_bytes', activated.releaseManifestBytes],
    ['current_release_managed_object_count', activated.releaseManagedObjectCount],
    ['current_release_fence', activated.releaseFence],
  ];
  const restoreEntries = [
    ['current_corpus_release_id', predecessor.corpusReleaseId],
    ['current_corpus_manifest_sha256', predecessor.corpusManifestSha256],
    ['corpus_import_state', predecessor.importState],
    ['accepted_ocr_document_count', predecessor.acceptedOcrDocumentCount],
    ['current_release_id', predecessor.releaseId],
    ['current_release_manifest_key', predecessor.releaseManifestKey],
    ['current_release_manifest_sha256', predecessor.releaseManifestSha256],
    ['current_release_manifest_bytes', predecessor.releaseManifestBytes],
    ['current_release_managed_object_count', predecessor.releaseManagedObjectCount],
    ['current_release_fence', predecessor.releaseFence],
  ];
  const guardKey = `release_activation_rollback:${fence}`;
  const bindings: unknown[] = [guardKey];
  const bind = (value: unknown): string => {
    bindings.push(value);
    return `?${bindings.length}`;
  };
  const checks = currentEntries.map(([key, value]) =>
    `COALESCE((SELECT value FROM site_meta WHERE key=${bind(key)}),'')=${bind(value)}`)
    .join(' AND ');
  const statements = [
    env.DB.prepare('DELETE FROM corpus_import_guards WHERE guard_key=?1').bind(guardKey),
    env.DB.prepare(`INSERT INTO corpus_import_guards(guard_key,ok)
      SELECT ?1,CASE WHEN ${checks} THEN 1 ELSE 0 END`).bind(...bindings),
  ];
  for (const [key, value] of restoreEntries) {
    statements.push(env.DB.prepare(`INSERT INTO site_meta(key,value) SELECT ?1,?2
      WHERE EXISTS(SELECT 1 FROM corpus_import_guards WHERE guard_key=?3)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`)
      .bind(key, value, guardKey));
  }
  statements.push(env.DB.prepare(`UPDATE release_publication_prefix_state
    SET activated=0,sealed=1,updated_at=CURRENT_TIMESTAMP
    WHERE release_id=?1 AND manifest_sha256=?2 AND owner_fence=?3
      AND EXISTS(SELECT 1 FROM corpus_import_guards WHERE guard_key=?4)`)
    .bind(releaseId, manifestSha256, fence, guardKey));
  statements.push(env.DB.prepare('DELETE FROM corpus_import_guards WHERE guard_key=?1').bind(guardKey));
  await env.DB.batch(statements);
  return JSON.stringify(await inspectD1Predecessor(env)) === JSON.stringify(predecessor);
}

async function rollbackR2Pointer(
  env: Env,
  {
    written,
    predecessorBytes,
    predecessorHttpMetadata,
    predecessorCustomMetadata,
  }: {
    written: R2Object;
    predecessorBytes: ArrayBuffer | null;
    predecessorHttpMetadata?: R2HTTPMetadata;
    predecessorCustomMetadata?: Record<string, string>;
  },
): Promise<boolean> {
  if (!predecessorBytes) return false;
  const predecessorSha256 = await sha256(predecessorBytes);
  const restored = await env.SOURCES.put(CURRENT_POINTER_KEY, predecessorBytes, {
    onlyIf: new Headers({ 'if-match': written.httpEtag }),
    httpMetadata: predecessorHttpMetadata || { contentType: 'application/json' },
    customMetadata: predecessorCustomMetadata,
    sha256: predecessorSha256,
  });
  if (!restored) return false;
  const readback = await env.SOURCES.get(CURRENT_POINTER_KEY);
  return Boolean(readback)
    && readback?.size === predecessorBytes.byteLength
    && await sha256(await readback!.arrayBuffer()) === predecessorSha256;
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
    const stagedManifest = await validateStagedRelease(env, releaseId, manifestSha256, manifestBytes, managedObjectCount);
    if (!stagedManifest) {
      return response({ error: 'staged release prefix is absent, polluted, or inexact' }, 409);
    }
    const corpus = desiredCorpusFromManifest(stagedManifest);
    if (!await stagedCorpusReady(env, corpus)) {
      return response({ error: 'staged D1 corpus is absent, stale, or inexact' }, 409);
    }
    const d1Predecessor = await inspectD1Predecessor(env);
    const current = await env.SOURCES.get(CURRENT_POINTER_KEY);
    const predecessor = input.predecessor as Record<string, unknown> | null;
    let predecessorValue: Record<string, unknown> | null = null;
    let predecessorBytes: ArrayBuffer | null = null;
    if (current) {
      if (!predecessor || predecessor.exists !== true
          || predecessor.etag !== current.httpEtag || predecessor.version !== current.version) {
        return response({ error: 'pointer predecessor changed' }, 409);
      }
      try {
        predecessorBytes = await current.arrayBuffer();
        predecessorValue = JSON.parse(new TextDecoder().decode(predecessorBytes)) as Record<string, unknown>;
      } catch {
        return response({ error: 'current pointer is invalid' }, 409);
      }
      if (!await exactPointerPredecessor(env, predecessorValue)) {
        return response({ error: 'current pointer predecessor manifest is absent or inexact' }, 409);
      }
      if (!await d1MatchesPointerPredecessor(env, d1Predecessor, predecessorValue)) {
        return response({ error: 'D1 and R2 pointer predecessors are inconsistent' }, 409);
      }
      const currentFence = Number(predecessorValue.fence || 0);
      const alreadyExact = predecessorValue.release_id === releaseId
        && predecessorValue.release_manifest_sha256 === manifestSha256
        && predecessorValue.release_manifest_bytes === manifestBytes
        && predecessorValue.managed_object_count === managedObjectCount;
      if (!Number.isSafeInteger(currentFence) || fence < currentFence) {
        return response({ error: 'publication fence is not monotonic' }, 409);
      }
      if (alreadyExact) {
        if (fence !== currentFence) return response({ error: 'exact pointer fence differs from activation fence' }, 409);
        await activateD1CorpusRelease(env, {
          corpus, predecessor: d1Predecessor, releaseId, manifestKey, manifestSha256,
          manifestBytes, managedObjectCount, fence,
        });
        return response({
          activated: false, exact: true, d1Activated: true,
          etag: current.httpEtag, version: current.version, value: predecessorValue,
        });
      }
      if (fence === currentFence) return response({ error: 'publication fence is not monotonic' }, 409);
    } else if (predecessor && predecessor.exists !== false) {
      return response({ error: 'pointer predecessor changed' }, 409);
    }
    if (!current) {
      return response({ error: 'initial cross-store activation requires an explicit rollbackable R2 predecessor' }, 409);
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
    const conditional = new Headers({ 'if-match': current.httpEtag });
    const written = await env.SOURCES.put(CURRENT_POINTER_KEY, body, {
      onlyIf: conditional,
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { release_id: releaseId, manifest_sha256: manifestSha256, fence: String(fence) },
      sha256: await sha256(body.buffer),
    });
    if (!written) return response({ error: 'pointer conditional activation failed' }, 409);
    try {
      await activateD1CorpusRelease(env, {
        corpus, predecessor: d1Predecessor, releaseId, manifestKey, manifestSha256,
        manifestBytes, managedObjectCount, fence,
      });
    } catch (error) {
      const rolledBack = await rollbackR2Pointer(env, {
        written,
        predecessorBytes,
        predecessorHttpMetadata: current.httpMetadata,
        predecessorCustomMetadata: current.customMetadata,
      });
      if (!rolledBack) {
        throw new Error(`D1 activation failed after R2 CAS and exact predecessor rollback failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const d1RolledBack = await rollbackD1Activation(env, {
        corpus, predecessor: d1Predecessor, releaseId, manifestKey, manifestSha256,
        manifestBytes, managedObjectCount, fence,
      });
      if (!d1RolledBack) {
        throw new Error(`D1 activation failed after R2 CAS and D1 predecessor reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const restored = await env.SOURCES.get(CURRENT_POINTER_KEY);
      const restoredBytes = restored ? await restored.arrayBuffer() : null;
      const d1AfterRollback = await inspectD1Predecessor(env);
      if (!restoredBytes || !predecessorBytes
          || await sha256(restoredBytes) !== await sha256(predecessorBytes)
          || JSON.stringify(d1AfterRollback) !== JSON.stringify(d1Predecessor)
          || !await d1MatchesPointerPredecessor(env, d1AfterRollback, predecessorValue!)) {
        throw new Error('exact R2 predecessor rollback did not preserve D1/R2 readback parity');
      }
      throw new Error(`D1 activation failed after R2 CAS; exact predecessor restored: ${error instanceof Error ? error.message : String(error)}`);
    }
    return response({
      activated: true,
      d1Activated: true,
      etag: written.httpEtag,
      version: written.version,
      sha256: await sha256(body.buffer),
      bytes: body.byteLength,
      value,
    });
  } finally {
    await releaseActivationClaim(env, releaseId, manifestSha256, fence, claim.tokenHash, claim.nonceHash);
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
