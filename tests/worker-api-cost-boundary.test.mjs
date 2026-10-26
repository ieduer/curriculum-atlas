import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

async function load(file) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const { default: worker } = await load('../src/index.ts');
const { resolveApiRoute } = await load('../src/api-route.ts');
const routes = [
  ['GET', '/api/health', 'health'], ['GET', '/api/me', 'me'],
  ['GET', '/api/meta', 'meta'], ['GET', '/api/documents', 'documents'],
  ['GET', '/api/documents/doc-12', 'document', 'doc-12'],
  ['GET', '/api/search', 'search'], ['GET', '/api/insights', 'insights'],
  ['GET', '/api/terms', 'terms'], ['GET', '/api/compare', 'compare'],
  ['GET', '/api/source-manifest', 'source-manifest'],
  ['GET', '/api/historical/a%2Fb/source.pdf', 'historical-pdf', 'a%2Fb'],
  ['GET', '/api/historical/a/b', 'historical-item', 'a/b'],
  ['GET', '/api/comments', 'comments'], ['POST', '/api/comments', 'create-comment'],
  ['POST', '/api/comments/ab-123/report', 'report-comment', 'ab-123'],
  ['PATCH', '/api/admin/comments/ab-123', 'moderate-comment', 'ab-123'],
  ['GET', '/api/admin/summary', 'admin-summary'], ['POST', '/api/ai/chat', 'ai-chat'],
];

test('existing method/path contract and historical PDF priority are preserved', () => {
  for (const [method, path, kind, id] of routes) {
    assert.deepEqual(resolveApiRoute(path, method), id ? { kind, id } : { kind });
  }
});

test('unknown and wrong-method API requests return 404 without any binding access or body read', async () => {
  let touched = 0;
  const env = new Proxy({}, { get() { touched++; throw Error('Unexpected binding access'); } });
  const invalid = [['GET', '/api/missing'], ['GET', '/api/admin/missing'], ['POST', '/api/ai/missing'],
    ['GET', '/api/documents/UPPER'], ['GET', '/api/comments/zz/report'],
    ...routes.map(([, path]) => ['DELETE', path]), ...routes.map(([, path]) => ['HEAD', path])];
  for (const [method, path] of invalid) {
    const request = new Request(`https://curriculum.bdfz.net${path}`, {
      method, headers: { cookie: 'bdfz_uc_session=synthetic-test-value' },
      ...(['POST', 'DELETE'].includes(method) ? { body: '{invalid-json' } : {}),
    });
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.equal(request.bodyUsed, false);
    assert.equal((await response.json()).error, 'API 路径不存在');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  assert.equal(touched, 0);
});

test('preflight stays free of bindings and corpus-backed routes still fail closed', async () => {
  const preflight = await worker.fetch(new Request('https://curriculum.bdfz.net/api/missing', { method: 'OPTIONS' }), {});
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('allow'), 'GET, POST, PATCH, OPTIONS');
  for (const [method, path, kind] of routes.filter((r) => !['health', 'me'].includes(r[2]))) {
    let reads = 0;
    const env = { DB: { prepare(sql) {
      reads++; assert.match(sql, /FROM corpus_import_releases r/);
      return { async first() { return null; } };
    } } };
    const response = await worker.fetch(new Request(`https://curriculum.bdfz.net${path}`, { method }), env);
    assert.equal(response.status, 503, kind);
    assert.equal(reads, 1, kind);
  }
});

test('anonymous session lookup remains independent of corpus readiness', async () => {
  const response = await worker.fetch(new Request('https://curriculum.bdfz.net/api/me'), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: false, user: null, admin: false });
});

test('metadata reuses verified counts for the same release pointer; health and pointer changes recount', async () => {
  const core = JSON.stringify(Object.fromEntries(['subjects','periods','document_relations','chapters','document_classifications','document_sources','primary_document_sources','subject_insights','terms','term_relations','version_diffs','online_verifications','online_evidence'].map(k => [k, 0])));
  const corpus = { release_id: 'corpus-fixture', manifest_sha256: 'a'.repeat(64), state: 'ready', accepted_ocr_documents: 0, live_accepted_ocr_documents: 0,
    expected_core_counts_json: core, actual_core_counts_json: core, live_core_counts_json: core };
  for (const [kind, count] of Object.entries({ documents: 2, paragraphs: 17, fts_rows: 17, page_gates: 4, displayed_paragraphs: 8, chunks: 1 })) {
    for (const prefix of ['expected', 'actual', 'live']) corpus[`${prefix}_${kind}`] = count;
  }
  // The pointer lookup returns only the release row; the full count adds the live_* columns.
  const releaseRow = () => Object.fromEntries(Object.entries(structuredClone(corpus)).filter(([key]) => !key.startsWith('live_')));
  let pointerReads = 0;
  let fullCounts = 0;
  const env = { TURNSTILE_SITE_KEY: 'public-fixture', SOURCES: { async get() { return null; } }, DB: { prepare(sql) {
    assert.doesNotMatch(sql, /SELECT COUNT\(\*\) AS count FROM (documents|paragraphs) WHERE corpus_release_id/);
    return { bind() { return this; }, async first() {
      if (sql.includes('FROM corpus_import_releases r')) {
        if (sql.includes('paragraph_counts')) { fullCounts++; return structuredClone(corpus); }
        pointerReads++; return releaseRow();
      }
      if (sql.includes('LEFT JOIN document_classifications')) return null;
      if (sql.includes('comments')) return { count: 3 };
      if (sql.includes('citation_allowed=1')) return { count: 1 };
      if (sql.includes('online_verifications')) return { count: 5 };
      throw new Error('Unexpected query');
    }, async all() { return { results: [] }; } };
  } } };
  const get = (path) => worker.fetch(new Request(`https://curriculum.bdfz.net${path}`), env);
  const first = await get('/api/meta');
  assert.equal(first.status, 200);
  assert.deepEqual((await first.json()).counts, { documents: 2, paragraphs: 17, comments: 3, citationReadyDocuments: 1, onlineVerifications: 5 });
  assert.deepEqual([pointerReads, fullCounts], [1, 1]);
  assert.equal((await get('/api/meta')).status, 200);
  assert.deepEqual([pointerReads, fullCounts], [2, 1], 'same pointer: the full count is reused');
  corpus.live_paragraphs = 16;
  assert.equal((await get('/api/meta')).status, 200, 'same-pointer drift is not re-read by read routes inside the window');
  assert.equal(fullCounts, 1);
  const health = await get('/api/health');
  assert.equal(health.status, 503);
  assert.equal((await health.json()).corpus.ready, false, 'health always recounts');
  assert.equal(fullCounts, 2);
  assert.equal((await get('/api/meta')).status, 503, 'a failed health count clears the reused result');
  assert.equal(fullCounts, 3);
  assert.equal((await get('/api/meta')).status, 503, 'a failed count is never reused');
  assert.equal(fullCounts, 4);
  corpus.live_paragraphs = 17;
  assert.equal((await get('/api/meta')).status, 200);
  assert.equal(fullCounts, 5);
  assert.equal((await get('/api/meta')).status, 200);
  assert.equal(fullCounts, 5);
  corpus.manifest_sha256 = 'b'.repeat(64);
  assert.equal((await get('/api/meta')).status, 200);
  assert.equal(fullCounts, 6, 'a changed release pointer recounts at once');
  const now = Date.now;
  try {
    Date.now = () => now() + 60 * 60 * 1000;
    assert.equal((await get('/api/meta')).status, 200);
    assert.equal(fullCounts, 7, 'the reused result expires after one hour');
  } finally {
    Date.now = now;
  }
  assert.equal((await get('/api/meta')).status, 200);
  assert.equal(fullCounts, 8, 'a result counted in the future is not trusted');
});
