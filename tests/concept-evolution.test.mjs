import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const graph = JSON.parse(await readFile(new URL('public/data/concept-evolution.json', root), 'utf8'));
const app = await readFile(new URL('public/app.js', root), 'utf8');
const atlas = await readFile(new URL('public/atlas.js', root), 'utf8');
const episodes = new Map(graph.episodes.map((item) => [item.id, item]));
const evidence = new Map(graph.evidence.map((item) => [item.id, item]));

test('every star is a concept episode rather than a document record', () => {
  assert.ok(graph.episodes.length > 0);
  assert.ok(graph.episodes.every((episode) => episode.concept_id && (episode.subject.canonical || episode.scope_entity?.canonical) && episode.curriculum_line.id && episode.time.year));
  assert.match(app, /setData\(state\.conceptGraph\)/);
  assert.doesNotMatch(atlas, /kind:\s*'document'|node\.doc|this\.documents/);
});

test('solid stars have paragraph-level citation evidence', () => {
  const solid = graph.episodes.filter((episode) => episode.claim_policy.display_level === 'solid');
  assert.ok(solid.length > 0);
  for (const episode of solid) {
    assert.equal(episode.observation.status, 'citation_ready');
    assert.ok(episode.evidence_ids.some((id) => evidence.get(id)?.citation_allowed === true && evidence.get(id)?.paragraph_ordinal));
  }
});

test('OCR observations stay non-quotable and outside formal lineage edges', () => {
  const ocr = graph.episodes.filter((episode) => episode.claim_policy.display_level !== 'solid');
  assert.ok(ocr.length > 0);
  for (const episode of ocr) {
    assert.equal(episode.claim_policy.quotation_allowed, false);
    assert.equal(episode.claim_policy.historical_superlative_allowed, false);
    assert.ok(episode.evidence_ids.every((id) => evidence.get(id)?.citation_allowed === false));
    assert.ok(graph.edges.every((edge) => edge.source !== episode.id && edge.target !== episode.id));
  }
});

test('automatic lineage only joins the same concept, subject, and curriculum line', () => {
  for (const edge of graph.edges.filter((item) => item.type === 'next_observed')) {
    const source = episodes.get(edge.source);
    const target = episodes.get(edge.target);
    assert.equal(source.concept_id, target.concept_id);
    assert.equal(source.subject.canonical, target.subject.canonical);
    assert.equal(source.curriculum_line.id, target.curriculum_line.id);
    assert.equal(edge.editor_reviewed, false);
    assert.match(edge.claim_boundary, /current citation-ready corpus/);
  }
});
