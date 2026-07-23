import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../', import.meta.url);
const [layer, graph, catalog, appSource] = await Promise.all([
  readFile(new URL('public/data/ocr-observation-layer.json', projectRoot), 'utf8').then(JSON.parse),
  readFile(new URL('public/data/concept-evolution.json', projectRoot), 'utf8').then(JSON.parse),
  readFile(new URL('data/catalog.json', projectRoot), 'utf8').then(JSON.parse),
  readFile(new URL('public/app.js', projectRoot), 'utf8'),
]);

test('OCR observation layer is source-bound and complete for moe-2022-03', () => {
  const document = catalog.documents.find((item) => item.id === 'moe-2022-03');
  assert.ok(document);
  assert.equal(layer.schema_version, 1);
  assert.equal(layer.artifact_profile, 'curriculum-ocr-observation-layer-v1');
  assert.equal(layer.source.document_id, document.id);
  assert.equal(layer.source.source_sha256, document.checksum_sha256);
  assert.equal(layer.source.page_count, document.page_count);
  assert.equal(layer.source.completed_pages, document.page_count);
  assert.equal(layer.source.failed_pages, 0);
  assert.equal(layer.source.citation_allowed, false);
  assert.equal(layer.pages.length, document.page_count);
  assert.deepEqual(layer.pages.map((page) => page.page), Array.from({ length: document.page_count }, (_, index) => index + 1));
  assert.ok(layer.pages.every((page) => /^[a-f0-9]{64}$/.test(page.content_sha256) && page.content.length > 0));
});

test('OCR candidates and relations remain nonsemantic and fail closed for citation', () => {
  assert.ok(layer.episodes.length >= 20);
  assert.ok(layer.edges.some((edge) => edge.mode === 'lineage'));
  assert.ok(layer.edges.some((edge) => edge.mode === 'cross'));
  assert.ok(layer.evidence.length > layer.episodes.length);
  assert.ok(layer.evidence.every((item) => item.citation_allowed === false && item.observation_class === 'ocr_candidate_nonsemantic'));
  assert.ok(layer.episodes.every((episode) => episode.time.year === 2022
    && episode.curriculum_line.school_type === 'general_education'
    && episode.observation.status === 'ocr_complete_pending_audit'
    && episode.observation.semantic === false
    && episode.claim_policy.display_level === 'uniform_star'
    && episode.claim_policy.quotation_allowed === false
    && episode.claim_policy.semantic_relation_allowed === false));
  assert.ok(layer.edges.every((edge) => edge.semantic === false && edge.influence_claim_allowed === false));

  const nodeIds = new Set([...graph.episodes, ...layer.episodes].map((episode) => episode.id));
  assert.ok(layer.edges.every((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)));
});

test('OCR layer exposes searchable 2022 text and production UI wiring', () => {
  assert.ok(layer.pages.some((page) => page.content.includes('学习任务群')));
  assert.ok(layer.concepts.some((concept) => concept.label === '学习任务群' && concept.mention_count > 0));
  assert.equal(layer.pipeline_summary.complete_documents, 11);
  assert.equal(layer.pipeline_summary.complete_pages, 4727);
  assert.equal(layer.pipeline_summary.active_documents, 0);
  assert.equal(
    layer.documents.find((document) => document.id === 'legacy-compendium-english')?.status,
    'complete',
  );
  assert.deepEqual(
    layer.documents.filter((document) => document.status === 'retry_wait').map((document) => document.id),
    [
      'legacy-compendium-geography',
      'legacy-compendium-mathematics',
      'legacy-compendium-politics',
    ],
  );
  assert.match(appSource, /ocr-observation-layer\.json/);
  assert.match(appSource, /OCR 待核命中/);
  assert.match(appSource, /ocr-p-/);
});
