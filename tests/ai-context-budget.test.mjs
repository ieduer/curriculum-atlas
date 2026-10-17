// APIS payload contract 2026-10-15 (curriculum-atlas: text <= 256 KiB): whole retrieved passages within a budget.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
async function loadAi() {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('src/ai.ts', root))], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}
const passage = (id, chars) => ({ id, document_id: `d${id}`, title: `课程标准${id}`, entity_kind: 'subject', taxonomy_entity_kind: 'subject', display_facet: null, subject: '语文', entity_label: '语文', subject_family: null, scope_kind: null, scope_label: null, version_label: '2022', page_number: 1, source_locator: `p.${id}`, body: '标'.repeat(chars), source_url: 'https://example.invalid', score: 0 });
const bytes = (s) => new TextEncoder().encode(JSON.stringify(s)).length;

test('ten maximal corpus paragraphs (2,200 chars) are all sent', async () => {
  const { selectContextPassages, contextEntry, CONTEXT_BUDGET_BYTES } = await loadAi();
  const ten = Array.from({ length: 10 }, (_, i) => passage(i + 1, 2200));
  assert.equal(selectContextPassages(ten).length, 10);
  assert.ok(bytes(ten.map(contextEntry).join('\n\n')) < CONTEXT_BUDGET_BYTES / 2);
});

test('longer bodies are taken whole in retrieval order within the budget; the boundary is exact', async () => {
  const { selectContextPassages, contextEntry, CONTEXT_BUDGET_BYTES } = await loadAi();
  const big = Array.from({ length: 10 }, (_, i) => passage(i + 1, 20000));
  const kept = selectContextPassages(big);
  assert.ok(kept.length < 10 && kept.length > 0);
  assert.deepEqual(kept.map((p) => p.id), big.slice(0, kept.length).map((p) => p.id));
  assert.ok(kept.every((p) => p.body.length === 20000), 'never cut');
  assert.ok(kept.reduce((n, p) => n + bytes(contextEntry(p)) + 4, 0) <= CONTEXT_BUDGET_BYTES);
  const one = passage(1, 100), size = bytes(contextEntry(one)) + 4;
  assert.equal(selectContextPassages([one], size).length, 1);
  assert.equal(selectContextPassages([one], size - 1).length, 0);
});

test('passages over the budget are skipped whole; the route sends and cites only those used and reports both counts', async () => {
  const { answerWithEvidence } = await loadAi();
  const retrieved = [passage(1, 90000), passage(2, 90000), passage(3, 100)];
  let prompt = '';
  const env = {
    APIS_ENABLED: 'true', APIS_CALLER_TOKEN: 'test-only', AI_ORIGIN: 'https://curriculum.bdfz.net', PRIVACY_HASH_SECRET: 'x'.repeat(32),
    DB: { prepare: (sql) => ({ bind: () => ({ all: async () => ({ results: sql.includes('paragraph_fts') || sql.includes('paragraphs') ? retrieved : [] }), run: async () => ({}) }) }) },
    APIS: { fetch: async (request) => { const body = await request.json(); prompt = body.contents[0].parts[0].text; return Response.json({ answer: '课程目标有明确表述。[P:3]' }); } },
  };
  const result = await answerWithEvidence(env, { user: null }, '课程目标', '');
  assert.equal(result.retrievalCount, 3);
  assert.equal(result.contextCount, 1);
  assert.match(prompt, /\[P:3\]/);
  assert.doesNotMatch(prompt, /\[P:1\]|\[P:2\]/);
  assert.ok(new TextEncoder().encode(JSON.stringify(prompt)).length < 256 * 1024);
});
