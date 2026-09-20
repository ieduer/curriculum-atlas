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
