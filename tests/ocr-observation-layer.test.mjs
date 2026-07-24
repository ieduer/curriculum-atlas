import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../', import.meta.url);
const [layer, graph, catalogBytes, coverageBytes, yearPolicyBytes, appSource] = await Promise.all([
  readFile(new URL('public/data/ocr-observation-layer.json', projectRoot), 'utf8').then(JSON.parse),
  readFile(new URL('public/data/concept-evolution.json', projectRoot), 'utf8').then(JSON.parse),
  readFile(new URL('data/catalog.json', projectRoot)),
  readFile(new URL('data/ocr-coverage-ledger.json', projectRoot)),
  readFile(new URL('data/ocr-document-year-policy.json', projectRoot)),
  readFile(new URL('public/app.js', projectRoot), 'utf8'),
]);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('OCR observation layer binds all 83 completed documents and all 10,210 pages', () => {
  assert.equal(layer.schema_version, 2);
  assert.equal(layer.artifact_profile, 'curriculum-ocr-observation-layer-v2');
  assert.equal(layer.publication_status, 'candidate_fail_closed');
  assert.equal(layer.source.catalog_sha256, sha256(catalogBytes));
  assert.equal(layer.source.coverage_ledger_sha256, sha256(coverageBytes));
  assert.equal(layer.source.year_policy_sha256, sha256(yearPolicyBytes));
  assert.equal(layer.source.citation_allowed, false);
  assert.equal(layer.source.semantic_claim_allowed, false);
  assert.equal(layer.documents.length, 83);
  assert.equal(layer.counts.complete_documents, 83);
  assert.equal(layer.counts.complete_pages, 10210);
  assert.equal(layer.counts.projected_documents, 70);
  assert.equal(layer.counts.unresolved_year_documents, 0);
  assert.ok(layer.documents.every((document) =>
    document.completed_pages === document.page_count
    && document.failed_pages === 0
    && Number.isInteger(document.year)
    && document.citation_allowed === false
    && document.semantic_claim_allowed === false
    && /^[a-f0-9]{64}$/.test(document.source_sha256)
    && /^[a-f0-9]{64}$/.test(document.state_sha256)));
});

test('all-subject OCR candidates and relations remain nonsemantic and fail closed for citation', () => {
  assert.equal(layer.counts.concept_candidates, 308);
  assert.equal(layer.counts.evidence_pages, 308);
  assert.equal(layer.episodes.length, 308);
  assert.equal(layer.evidence.length, 308);
  assert.ok(layer.edges.some((edge) => edge.mode === 'lineage'));
  assert.ok(layer.edges.some((edge) => edge.mode === 'cross'));
  assert.deepEqual(
    [...new Set(layer.episodes.flatMap((episode) => episode.visibility_facets))].sort(),
    ['体育与健康', '劳动', '历史', '历史与社会', '地理', '外语', '思想政治与道德法治', '技术', '数学', '科学类', '艺术', '语文'].sort(),
  );
  assert.ok(layer.evidence.every((item) =>
    item.citation_allowed === false
    && item.semantic_claim_allowed === false
    && item.observation_class === 'ocr_candidate_nonsemantic'
    && /^[a-f0-9]{64}$/.test(item.source_pdf_sha256)
    && /^[a-f0-9]{64}$/.test(item.content_sha256)));
  assert.ok(layer.episodes.every((episode) =>
    [2001, 2003, 2011, 2022].includes(episode.time.year)
    && episode.observation.status === 'ocr_complete_machine_candidate'
    && episode.observation.semantic === false
    && episode.claim_policy.display_level === 'uniform_star'
    && episode.claim_policy.quotation_allowed === false
    && episode.claim_policy.semantic_relation_allowed === false));
  assert.ok(layer.edges.every((edge) =>
    edge.semantic === false
    && edge.citation_allowed === false
    && edge.influence_claim_allowed === false));

  const nodeIds = new Set([...graph.episodes, ...layer.episodes].map((episode) => episode.id));
  assert.ok(layer.edges.every((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)));
});

test('OCR layer exposes all-subject searchable snippets and production UI wiring', () => {
  assert.ok(layer.pages.some((page) => page.snippet.includes('学习任务群')));
  assert.ok(layer.concepts.some((concept) => concept.label === '学习任务群' && concept.mention_count > 0));
  assert.equal(layer.pipeline_summary.complete_documents, 83);
  assert.equal(layer.pipeline_summary.complete_pages, 10210);
  assert.equal(layer.pipeline_summary.bounded_item_documents, 9);
  assert.equal(layer.pipeline_summary.deduplicated_alias_documents, 1);
  assert.equal(layer.pipeline_summary.non_subject_scope_documents, 3);
  assert.match(appSource, /ocr-observation-layer\.json/);
  assert.match(appSource, /OCR 候选命中/);
  assert.match(appSource, /83 份已完成 OCR 文件/);
  assert.match(appSource, /ocr-p-/);
});
