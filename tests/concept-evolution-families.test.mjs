import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const [config, artifact, core, ocr, century] = await Promise.all([
  readFile(new URL('data/concept-evolution-families.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/data/concept-evolution-families.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/data/concept-evolution.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/data/ocr-observation-layer.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/data/century-observation-layer.json', root), 'utf8').then(JSON.parse),
]);

test('the century evolution layer uses one explicit concept tier and seven non-overlapping families', () => {
  assert.equal(config.schema_version, 1);
  assert.equal(config.concept_tier.id, 'language-practice-domain');
  assert.equal(config.families.length, 7);
  const configuredIds = config.families.flatMap((family) => family.concept_ids);
  assert.equal(new Set(configuredIds).size, configuredIds.length);
  assert.ok(config.families.every((family) => family.concept_ids.length >= 2));
  assert.ok(config.assertion_boundary.includes('不证明首次出现'));
  assert.ok(config.assertion_boundary.includes('影响或因果'));
});

test('every published family crosses 2001 and includes multiple observed concepts', () => {
  assert.equal(artifact.schema_version, 1);
  assert.equal(artifact.artifact_profile, 'curriculum-concept-evolution-families-v1');
  assert.equal(artifact.publication_status, 'editorial_correspondence_noncausal');
  assert.equal(artifact.counts.families, 7);
  assert.equal(artifact.counts.first_year, 1902);
  assert.equal(artifact.counts.last_year, 2022);
  for (const family of artifact.families) {
    assert.ok(family.first_observed_year < 2001, family.id);
    assert.ok(family.last_observed_year >= 2001, family.id);
    assert.ok(family.observed_concepts.length >= 2, family.id);
    assert.equal(family.concept_tier_id, 'language-practice-domain');
  }
});

test('episode memberships exactly reference real merged star episodes', () => {
  const episodeIds = new Set([
    ...core.episodes,
    ...ocr.episodes,
    ...century.star_projection.episodes,
  ].map((episode) => episode.id));
  const familyIds = new Set(artifact.families.map((family) => family.id));
  assert.equal(new Set(artifact.episode_memberships.map((item) => item.episode_id)).size, artifact.episode_memberships.length);
  assert.ok(artifact.episode_memberships.every((item) =>
    episodeIds.has(item.episode_id)
    && familyIds.has(item.family_id)
    && item.concept_tier_id === 'language-practice-domain'));
});

test('family edges are solid-renderable, chronological, nonsemantic, and noncausal', () => {
  const membershipIds = new Set(artifact.episode_memberships.map((item) => item.episode_id));
  assert.ok(artifact.edges.some((edge) => edge.type === 'same_surface_observed_again'));
  assert.ok(artifact.edges.some((edge) => edge.type === 'editorial_correspondence'));
  assert.ok(artifact.edges.every((edge) =>
    edge.mode === 'evolution'
    && edge.source_year <= edge.target_year
    && membershipIds.has(edge.source)
    && membershipIds.has(edge.target)
    && edge.semantic === false
    && edge.citation_allowed === false
    && edge.influence_claim_allowed === false
    && !String(edge.label).includes('虚线')));
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
