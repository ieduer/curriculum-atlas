import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const [source, manifest, layer, localCompendia, app, html, styles] = await Promise.all([
  readFile(new URL('data/century-observation-source.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('data/embedded-items-century-v1.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/data/century-observation-layer.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('data/local-compendia.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/app.js', root), 'utf8'),
  readFile(new URL('public/index.html', root), 'utf8'),
  readFile(new URL('public/styles.css', root), 'utf8'),
]);

test('the two compendium tables of contents resolve to exactly 134 embedded items', () => {
  assert.equal(source.schema_version, 2);
  assert.equal(source.artifact_profile, 'curriculum-century-observation-source-v2');
  assert.equal(source.archive.sha256, 'f0d0521359a7617048d3ef964a4730f2091474447acc56bed0f6de7284c6334f');
  assert.equal(source.archive.citation_allowed, false);
  assert.deepEqual(source.concept_capture_policy.concept_tier_ids, [
    'language-practice-domain',
    'subject-course-identity',
  ]);
  assert.equal(source.concept_capture_policy.controlled_concepts, 69);
  assert.equal(source.concept_capture_policy.overlap_resolution, 'longest_surface_wins');
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.artifact_profile, 'curriculum-embedded-century-items-v1');
  assert.deepEqual(manifest.counts, {
    items: 134,
    chinese_items: 57,
    plan_items: 77,
    first_year: 1902,
    last_year: 2000,
  });
  assert.equal(new Set(manifest.items.map((item) => item.id)).size, 134);
  assert.ok(manifest.items.every((item) => item.identity_status === 'toc_bound_candidate'
    && item.citation_allowed === false
    && item.semantic_claim_allowed === false));
});

test('every item is source-bound to valid non-overlapping physical page segments', () => {
  const documentById = new Map(localCompendia.documents.map((document) => [document.id, document]));
  for (const sourceDocument of manifest.source_documents) {
    const parent = documentById.get(sourceDocument.document_id);
    assert.ok(parent);
    assert.equal(sourceDocument.source_pdf_sha256, parent.checksum_sha256);
    assert.equal(sourceDocument.page_count, parent.page_count);
    assert.equal(sourceDocument.printed_to_physical_offset, 14);
  }
  for (const item of manifest.items) {
    assert.ok(item.segments.length >= 1);
    const parent = documentById.get(item.parent_document_id);
    for (const segment of item.segments) {
      assert.equal(segment.physical_page_start, segment.printed_page_start + 14);
      assert.equal(segment.physical_page_end, segment.printed_page_end + 14);
      assert.ok(segment.physical_page_start <= segment.physical_page_end);
      assert.ok(segment.physical_page_end <= parent.page_count);
    }
  }
  const chineseFirst = manifest.items.find((item) =>
    item.parent_document_id === 'legacy-compendium-chinese' && item.title === '钦定蒙学堂章程');
  const plansFirst = manifest.items.find((item) =>
    item.parent_document_id === 'legacy-compendium-plans' && item.title === '钦定蒙学堂章程');
  assert.equal(chineseFirst.segments[0].physical_page_start, 17);
  assert.equal(plansFirst.segments[0].physical_page_start, 15);
  assert.equal(manifest.items.filter((item) => item.segments.length > 1).length, 4);
});

test('the century candidate layer remains nonsemantic and bounded', () => {
  assert.equal(layer.schema_version, 2);
  assert.equal(layer.artifact_profile, 'curriculum-century-candidate-observation-layer-v2');
  assert.equal(layer.publication_status, 'candidate_fail_closed');
  assert.equal(layer.items.length, 134);
  assert.equal(layer.counts.first_year, 1902);
  assert.equal(layer.counts.last_year, 2022);
  assert.equal(layer.counts.subject_facets, 12);
  assert.equal(layer.counts.catalog_metadata_observations, 44);
  assert.ok(layer.concept_observations.length > 0);
  assert.ok(layer.concept_observations.every((item) => item.semantic === false
    && item.citation_allowed === false
    && ['ocr_surface_candidate_nonsemantic', 'catalog_title_candidate_nonsemantic']
      .includes(item.observation_class)));
  assert.ok(layer.concept_observations.some((item) =>
    item.observation_class === 'catalog_title_candidate_nonsemantic'
    && item.catalog_document?.source_url));
  assert.ok(layer.relations.some((relation) => relation.type === 'source_order_adjacent'));
  assert.ok(layer.relations.some((relation) => relation.type === 'surface_co_observed_in_item'));
  assert.ok(layer.relations.every((relation) => relation.semantic === false && relation.influence_claim_allowed === false));
  assert.equal(layer.star_projection.node_semantics, 'concept_observation_episode_not_document');
  assert.equal(layer.star_projection.time_semantics, 'year_is_single_spatial_coordinate_not_a_second_timeline');
  assert.equal(
    layer.star_projection.projection_policy.grain,
    'one_strongest_bounded_observation_per_concept_year_subject_facet',
  );
  assert.equal(
    layer.star_projection.episodes.length,
    layer.counts.projected_concept_year_observations,
  );
  assert.ok(layer.star_projection.episodes.length < layer.concept_observations.length);
  assert.equal(layer.star_projection.counts.episodes, layer.star_projection.episodes.length);
  assert.equal(layer.star_projection.counts.evidence, layer.star_projection.evidence.length);
  assert.equal(
    layer.star_projection.counts.lineage_edges + layer.star_projection.counts.cross_edges,
    layer.star_projection.edges.length,
  );
  const evidenceIds = new Set(layer.star_projection.evidence.map((evidence) => evidence.id));
  const episodeIds = new Set(layer.star_projection.episodes.map((episode) => episode.id));
  assert.equal(evidenceIds.size, layer.star_projection.evidence.length);
  assert.equal(episodeIds.size, layer.star_projection.episodes.length);
  assert.ok(layer.star_projection.episodes.every((episode) =>
    ['ocr_surface_candidate_nonsemantic', 'catalog_title_candidate_nonsemantic']
      .includes(episode.observation_class)
    && episode.citation_allowed === false
    && episode.claim_policy.display_level === 'uniform_star'
    && episode.evidence_ids.length > 0
    && episode.evidence_ids.every((id) => evidenceIds.has(id))));
  assert.ok(layer.star_projection.edges.every((edge) =>
    episodeIds.has(edge.source)
    && episodeIds.has(edge.target)
    && edge.semantic === false
    && edge.citation_allowed === false
    && edge.influence_claim_allowed === false));
});

test('one star projection now contains a historical and current course-name chain for all 12 subject facets', () => {
  const facets = [
    '语文', '数学', '外语', '思想政治与道德法治', '历史', '历史与社会',
    '地理', '科学类', '技术', '劳动', '艺术', '体育与健康',
  ];
  for (const facet of facets) {
    const episodes = layer.star_projection.episodes.filter((episode) =>
      episode.visibility_facets.includes(facet)
      && episode.category === '学科与课程名称');
    assert.ok(episodes.some((episode) => episode.time.year < 2001), `${facet} lacks a historical node`);
    assert.ok(episodes.some((episode) => episode.time.year >= 2001), `${facet} lacks a current node`);
  }
  assert.ok(layer.star_projection.edges.length > 0);
  assert.ok(layer.star_projection.edges.every((edge) => !String(edge.label || '').includes('虚线')));
});

test('the production UI projects OCR observations into one star map and keeps documents in the archive', () => {
  assert.doesNotMatch(html, /id="century-timeline"|id="century-track"|百年文件时间轴/);
  assert.match(app, /century-observation-layer\.json/);
  assert.match(app, /conceptGraph\.episodes = \[\.\.\.conceptGraph\.episodes, \.\.\.centuryLayer\.star_projection\.episodes\]/);
  assert.match(app, /path === '\/timeline' \|\| path === '\/archive'/);
  assert.match(app, /history\.replaceState\(\{\}, '', `\/archive/);
  assert.match(app, /path\.startsWith\('\/historical\/'\)/);
  assert.match(app, /候选层边界/);
  assert.match(app, /扫描物理页/);
  assert.doesNotMatch(styles, /\.century-timeline \{|\.century-track \{|\.century-node\./);
  assert.match(styles, /\.century-workspace \{/);
});
