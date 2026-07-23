import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const [source, layer, app] = await Promise.all([
  readFile(new URL('data/subject-detail-observation-source.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/data/subject-detail-observation-layer.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/app.js', root), 'utf8'),
]);

const expectedFacets = [
  '语文', '数学', '外语', '思想政治与道德法治', '历史', '历史与社会',
  '地理', '科学类', '技术', '劳动', '艺术', '体育与健康',
];

test('the controlled source packet binds complete OCR documents across all twelve facets', () => {
  assert.equal(source.schema_version, 1);
  assert.equal(source.artifact_profile, 'curriculum-subject-detail-observation-source-v1');
  assert.equal(source.projection_policy.grain, 'one_exact_surface_observation_per_concept_document');
  assert.equal(source.projection_policy.display_level, 'uniform_star');
  assert.equal(source.projection_policy.citation_allowed, false);
  assert.deepEqual(
    [...new Set(source.version_sources.map((item) => item.facet))],
    expectedFacets,
  );
  assert.equal(new Set(source.version_sources.map((item) => item.document_id)).size, source.version_sources.length);
});

test('the generated detail layer is bounded, nonsemantic, and evidence-bearing', () => {
  assert.equal(layer.schema_version, 1);
  assert.equal(layer.artifact_profile, 'curriculum-subject-detail-observation-layer-v1');
  assert.equal(layer.publication_status, 'candidate_fail_closed');
  assert.equal(layer.node_semantics, 'subject_detail_concept_observation_episode_not_document');
  assert.equal(layer.time_semantics, 'year_is_single_spatial_coordinate_not_a_second_timeline');
  assert.equal(layer.counts.subject_facets, 12);
  assert.equal(layer.counts.source_documents, source.version_sources.length);
  assert.equal(layer.counts.controlled_concepts, 40);
  assert.equal(layer.counts.observed_concepts, 40);
  assert.equal(layer.counts.episodes, layer.episodes.length);
  assert.equal(layer.counts.evidence, layer.evidence.length);
  assert.ok(layer.episodes.length >= 90);
  assert.ok(layer.evidence.length >= layer.episodes.length);
  assert.ok(layer.sources.every((item) =>
    item.completed_pages === item.page_count
    && item.failed_pages === 0
    && item.citation_allowed === false));
  assert.ok(layer.episodes.every((episode) =>
    episode.observation.semantic === false
    && episode.claim_policy.display_level === 'uniform_star'
    && episode.claim_policy.quotation_allowed === false
    && episode.claim_policy.semantic_relation_allowed === false
    && episode.evidence_ids.length >= 1
    && episode.evidence_ids.length <= source.projection_policy.maximum_evidence_pages_per_observation));
  assert.ok(layer.evidence.every((item) =>
    item.citation_allowed === false
    && item.semantic_claim_allowed === false
    && item.content_sha256));
});

test('every facet exposes observed practice, content, and ability concepts', () => {
  const familyPrefixByCategory = new Map([
    ['实践与学习活动', 'practice'],
    ['课程内容与组织', 'content'],
    ['能力与素养表现', 'ability'],
  ]);
  for (const facet of expectedFacets) {
    const facetConcepts = layer.concepts.filter((concept) => concept.visibility_facets.includes(facet));
    assert.ok(facetConcepts.length >= 3, facet);
    for (const category of familyPrefixByCategory.keys()) {
      assert.ok(facetConcepts.some((concept) => concept.category === category && concept.episode_count >= 1),
        `${facet}:${category}`);
    }
  }
});

test('the frontend merges the detail observations into the existing single Canvas', () => {
  assert.match(app, /data\/subject-detail-observation-layer\.json/);
  assert.match(app, /conceptGraph\.episodes = \[\.\.\.conceptGraph\.episodes, \.\.\.detailLayer\.episodes\]/);
  assert.match(app, /conceptGraph\.evidence = \[\.\.\.conceptGraph\.evidence, \.\.\.detailLayer\.evidence\]/);
  assert.doesNotMatch(app, /subject-detail-timeline|detail-track/);
});
