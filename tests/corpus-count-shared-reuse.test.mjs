import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Each import of the bundle is a separate module instance: a separate isolate with empty memory.
const bundle = (await build({ entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false })).outputFiles[0].text;
let isolates = 0;
const isolate = async () => (await import(`data:text/javascript;base64,${Buffer.from(`${bundle}\n// isolate ${++isolates}`).toString('base64')}`)).default;

// Data-centre cache shared by the isolates (Workers Cache API shape: match, put, delete by URL).
function dataCentreCache() {
  const entries = new Map();
  return {
    entries,
    default: {
      async match(key) { const body = entries.get(String(key)); return body === undefined ? undefined : new Response(body); },
      async put(key, response) { entries.set(String(key), await response.text()); },
      async delete(key) { return entries.delete(String(key)); },
    },
  };
}

function fixture() {
  const core = JSON.stringify(Object.fromEntries(['subjects', 'periods', 'document_relations', 'chapters', 'document_classifications', 'document_sources', 'primary_document_sources', 'subject_insights', 'terms', 'term_relations', 'version_diffs', 'online_verifications', 'online_evidence'].map((key) => [key, 0])));
  const corpus = { release_id: 'corpus-fixture', manifest_sha256: 'a'.repeat(64), state: 'ready', accepted_ocr_documents: 0, live_accepted_ocr_documents: 0,
    expected_core_counts_json: core, actual_core_counts_json: core, live_core_counts_json: core };
  for (const [kind, count] of Object.entries({ documents: 2, paragraphs: 17, fts_rows: 17, page_gates: 4, displayed_paragraphs: 8, chunks: 1 })) {
    for (const prefix of ['expected', 'actual', 'live']) corpus[`${prefix}_${kind}`] = count;
  }
  const state = { corpus, fullCounts: 0, pointerReads: 0 };
  const releaseRow = () => Object.fromEntries(Object.entries(structuredClone(corpus)).filter(([key]) => !key.startsWith('live_')));
  state.env = { SITE_ORIGIN: 'https://curriculum.bdfz.net', TURNSTILE_SITE_KEY: 'public-fixture', SOURCES: { async get() { return null; } }, DB: { prepare(sql) {
    return { bind() { return this; }, async first() {
      if (sql.includes('FROM corpus_import_releases r')) {
        if (sql.includes('paragraph_counts')) { state.fullCounts++; return structuredClone(corpus); }
        state.pointerReads++; return releaseRow();
      }
      if (sql.includes('LEFT JOIN document_classifications')) return null;
      if (sql.includes('comments')) return { count: 3 };
      if (sql.includes('citation_allowed=1')) return { count: 1 };
      if (sql.includes('online_verifications')) return { count: 5 };
      throw new Error('Unexpected query');
    }, async all() { return { results: [] }; } };
  } } };
  return state;
}

const get = (worker, env, path) => worker.fetch(new Request(`https://curriculum.bdfz.net${path}`), env);

test('isolates in one data centre share a passing count for the same release pointer', async (t) => {
  const cache = dataCentreCache();
  globalThis.caches = cache;
  t.after(() => { delete globalThis.caches; });
  const f = fixture();
  const a = await isolate();
  assert.equal((await get(a, f.env, '/api/meta')).status, 200);
  assert.equal(f.fullCounts, 1);
  const [[key, body]] = [...cache.entries];
  assert.match(key, /^https:\/\/curriculum\.bdfz\.net\/__corpus-integrity\/v1\/[0-9a-f]{64}$/);
  assert.equal(JSON.parse(body).corpus.live_paragraphs, 17);
  const b = await isolate();
  assert.equal((await get(b, f.env, '/api/meta')).status, 200);
  assert.equal(f.fullCounts, 1, 'a second isolate reuses the shared count');
  assert.equal((await get(b, f.env, '/api/meta')).status, 200);
  assert.equal(f.fullCounts, 1);
  f.corpus.manifest_sha256 = 'b'.repeat(64);
  const c = await isolate();
  assert.equal((await get(c, f.env, '/api/meta')).status, 200);
  assert.equal(f.fullCounts, 2, 'a changed pointer has a different shared key and recounts');
  assert.equal(cache.entries.size, 2);
});

test('health clears the shared count after a failed full count; failed counts are never shared', async (t) => {
  const cache = dataCentreCache();
  globalThis.caches = cache;
  t.after(() => { delete globalThis.caches; });
  const f = fixture();
  const a = await isolate();
  assert.equal((await get(a, f.env, '/api/meta')).status, 200);
  f.corpus.live_paragraphs = 16;
  const health = await get(a, f.env, '/api/health');
  assert.equal((await health.json()).corpus.ready, false);
  assert.equal(cache.entries.size, 0, 'health deleted the shared entry');
  const b = await isolate();
  assert.equal((await get(b, f.env, '/api/meta')).status, 503);
  assert.equal(cache.entries.size, 0, 'a failed count is not shared');
  f.corpus.live_paragraphs = 17;
  assert.equal((await get(b, f.env, '/api/meta')).status, 200);
  assert.equal(cache.entries.size, 1);
});

test('expired, future, mismatched, unready or malformed shared entries are not trusted', async (t) => {
  const cache = dataCentreCache();
  globalThis.caches = cache;
  t.after(() => { delete globalThis.caches; });
  const f = fixture();
  assert.equal((await get(await isolate(), f.env, '/api/meta')).status, 200);
  const [[key, body]] = [...cache.entries];
  const entry = JSON.parse(body);
  const now = Date.now;
  t.after(() => { Date.now = now; });
  for (const [name, value, clock] of [
    ['expired', entry, () => now() + 60 * 60 * 1000],
    ['counted in the future', { ...entry, at: now() + 60_000 }, now],
    ['other pointer', { ...entry, pointer: '[]' }, now],
    ['unready counts', { ...entry, corpus: { ...entry.corpus, live_paragraphs: 16 } }, now],
    ['malformed', null, now],
  ]) {
    cache.entries.set(key, value === null ? '{not json' : JSON.stringify(value));
    Date.now = clock;
    const before = f.fullCounts;
    assert.equal((await get(await isolate(), f.env, '/api/meta')).status, 200, name);
    assert.equal(f.fullCounts, before + 1, `${name}: recounted`);
    Date.now = now;
  }
});

test('without a Cache API or an https site origin the isolate-only reuse still works', async () => {
  delete globalThis.caches;
  const f = fixture();
  const a = await isolate();
  assert.equal((await get(a, f.env, '/api/meta')).status, 200);
  assert.equal((await get(a, f.env, '/api/meta')).status, 200);
  assert.equal(f.fullCounts, 1);
  globalThis.caches = dataCentreCache();
  try {
    const g = fixture();
    g.env.SITE_ORIGIN = 'http://insecure.example';
    const b = await isolate();
    assert.equal((await get(b, g.env, '/api/meta')).status, 200);
    assert.equal(globalThis.caches.entries.size, 0);
  } finally {
    delete globalThis.caches;
  }
});
