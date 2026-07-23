import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const [config, artifact, core, ocr, detail, pre2001Detail, century] = await Promise.all([
  readFile(new URL('data/concept-evolution-families.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/data/concept-evolution-families.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/data/concept-evolution.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/data/ocr-observation-layer.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/data/subject-detail-observation-layer.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/data/pre2001-subject-detail-observation-layer.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/data/century-observation-layer.json', root), 'utf8').then(JSON.parse),
]);

test('the evolution layer keeps the existing tiers and adds three explicit same-grain detail tiers', () => {
  assert.equal(config.schema_version, 3);
  assert.deepEqual(config.concept_tiers.map((tier) => tier.id), [
    'language-practice-domain',
    'subject-course-identity',
    'subject-practice-domain',
    'subject-content-domain',
    'subject-ability-domain',
  ]);
  assert.equal(config.families.length, 55);
  const configuredIds = config.families.flatMap((family) => family.concept_ids);
  assert.equal(new Set(configuredIds).size, configuredIds.length);
  assert.ok(config.families.every((family) => family.concept_ids.length >= 1));
  assert.ok(config.assertion_boundary.includes('不证明首次出现'));
  assert.ok(config.assertion_boundary.includes('影响或因果'));
});

test('every family satisfies its disclosed temporal coverage contract', () => {
  assert.equal(artifact.schema_version, 3);
  assert.equal(artifact.artifact_profile, 'curriculum-concept-evolution-families-v3');
  assert.equal(artifact.publication_status, 'editorial_correspondence_noncausal');
  assert.equal(artifact.counts.families, 55);
  assert.equal(artifact.counts.concept_tiers, 5);
  assert.equal(artifact.counts.subject_facets, 12);
  assert.equal(artifact.counts.detailed_families, 36);
  assert.equal(artifact.counts.first_year, 1902);
  assert.equal(artifact.counts.last_year, 2022);
  for (const family of artifact.families) {
    assert.ok(family.observed_concepts.length >= 1, family.id);
    if (family.coverage_contract === 'century_crossing') {
      assert.ok(family.first_observed_year < 2001, family.id);
      assert.ok(family.last_observed_year >= 2001, family.id);
    } else if (family.coverage_contract === 'single_version_2022') {
      assert.equal(family.first_observed_year, 2022, family.id);
      assert.equal(family.last_observed_year, 2022, family.id);
    } else {
      assert.ok(family.first_observed_year < family.last_observed_year, family.id);
    }
  }
});

test('episode memberships exactly reference real merged star episodes', () => {
  const episodeIds = new Set([
    ...core.episodes,
    ...ocr.episodes,
    ...detail.episodes,
    ...pre2001Detail.episodes,
    ...century.star_projection.episodes,
  ].map((episode) => episode.id));
  const familyIds = new Set(artifact.families.map((family) => family.id));
  assert.equal(new Set(artifact.episode_memberships.map((item) => item.episode_id)).size, artifact.episode_memberships.length);
  assert.ok(artifact.episode_memberships.every((item) =>
    episodeIds.has(item.episode_id)
    && familyIds.has(item.family_id)
    && config.concept_tiers.some((tier) => tier.id === item.concept_tier_id)));
});

test('evolution and discipline edges are solid-renderable, chronological, nonsemantic, and noncausal', () => {
  const membershipIds = new Set(artifact.episode_memberships.map((item) => item.episode_id));
  assert.ok(artifact.edges.some((edge) => edge.type === 'same_surface_observed_again'));
  assert.ok(artifact.edges.some((edge) => edge.type === 'editorial_correspondence'));
  assert.equal(artifact.edges.filter((edge) => edge.mode === 'discipline').length, 3);
  assert.ok(artifact.edges.every((edge) =>
    ['evolution', 'discipline'].includes(edge.mode)
    && edge.source_year <= edge.target_year
    && membershipIds.has(edge.source)
    && membershipIds.has(edge.target)
    && edge.semantic === false
    && edge.citation_allowed === false
    && edge.influence_claim_allowed === false
    && !String(edge.label).includes('虚线')));
});

test('history and history-and-society remain separate vertical families with one sourced 1923 grouping', () => {
  const history = config.families.find((family) => family.id === 'subject-course-history');
  const historySociety = config.families.find((family) => family.id === 'subject-course-history-society');
  assert.deepEqual(history.visibility_facets, ['历史']);
  assert.deepEqual(historySociety.visibility_facets, ['历史与社会']);
  assert.ok(!history.concept_ids.includes('course-history-society-social-studies'));
  assert.ok(!history.concept_ids.includes('course-history-society'));
  const disciplineEdges = artifact.edges.filter((edge) => edge.mode === 'discipline');
  assert.equal(new Set(disciplineEdges.map((edge) => edge.relation_id)).size, 1);
  assert.deepEqual(new Set(disciplineEdges.map((edge) => edge.target)), new Set([
    'century-concept:ee14ae3beab9b8d9fcce',
    'century-concept:12ac8689295b54c49eb4',
    'century-concept:7991cde8462d4dc9650f',
  ]));
  assert.ok(disciplineEdges.every((edge) =>
    edge.source === 'century-concept:8cc61f79fe891c5755f2'
    && edge.type === 'integrated_curriculum_contains_disciplines'
    && edge.source_year === 1923
    && edge.target_year === 1923
    && edge.claim_boundary.includes('不表示历史演变成')));
});

test('representative language-practice chains reach from historical surfaces to current domains', () => {
  const familyById = new Map(artifact.families.map((family) => [family.id, family]));
  assert.deepEqual(
    familyById.get('literacy-and-handwriting').observed_concepts.map((concept) => concept.label),
    ['识字', '写字', '识字与写字'],
  );
  assert.deepEqual(
    familyById.get('reading-and-appreciation').observed_concepts.map((concept) => concept.label),
    ['读书', '讲读', '阅读', '阅读与鉴赏'],
  );
  assert.deepEqual(
    familyById.get('language-knowledge-and-use').observed_concepts.map((concept) => concept.label),
    ['文法', '语法', '修辞', '语言文字运用'],
  );
});

test('every display facet has one course-identity family spanning historical OCR and current catalog metadata', () => {
  const expectedFacets = [
    '语文', '数学', '外语', '思想政治与道德法治', '历史', '历史与社会',
    '地理', '科学类', '技术', '劳动', '艺术', '体育与健康',
  ];
  const courseFamilies = artifact.families.filter((family) =>
    family.concept_tier_id === 'subject-course-identity');
  assert.equal(courseFamilies.length, 12);
  assert.deepEqual(courseFamilies.flatMap((family) => family.visibility_facets), expectedFacets);
  assert.ok(courseFamilies.every((family) =>
    family.first_observed_year < 2001
    && family.last_observed_year >= 2001
      && family.observed_concepts.length >= 2));
});

test('all twelve display facets have practice, content, and ability families at one explicit grain', () => {
  const expectedFacets = [
    '语文', '数学', '外语', '思想政治与道德法治', '历史', '历史与社会',
    '地理', '科学类', '技术', '劳动', '艺术', '体育与健康',
  ];
  for (const tier of [
    'subject-practice-domain',
    'subject-content-domain',
    'subject-ability-domain',
  ]) {
    const families = artifact.families.filter((family) => family.concept_tier_id === tier);
    assert.equal(families.length, 12, tier);
    assert.deepEqual(families.flatMap((family) => family.visibility_facets), expectedFacets, tier);
    assert.ok(families.every((family) => family.observed_concepts.length >= 1), tier);
  }
});
