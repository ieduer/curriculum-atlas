import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { materializeAcademicGraph, verifyGraphIndexShards } from '../scripts/graph-shards.mjs';

const root = new URL('../', import.meta.url);
const publicRoot = fileURLToPath(new URL('public/', root));
const core = JSON.parse(await readFile(new URL('public/data/concept-evolution.json', root), 'utf8'));
const academicIndex = JSON.parse(await readFile(new URL('public/data/concept-evolution-academic.json', root), 'utf8'));
await verifyGraphIndexShards(core, publicRoot);
const graph = await materializeAcademicGraph(academicIndex, publicRoot);
const app = await readFile(new URL('public/app.js', root), 'utf8');
const atlas = await readFile(new URL('public/atlas.js', root), 'utf8');
const episodes = new Map(graph.episodes.map((item) => [item.id, item]));
const evidence = new Map(graph.evidence.map((item) => [item.id, item]));

test('every star is a concept episode rather than a document record', () => {
  assert.ok(core.episodes.length > 0);
  assert.ok(core.episodes.every((episode) => episode.concept_id && (episode.subject.canonical || episode.scope_entity?.canonical) && episode.curriculum_line.id && episode.time.year));
  assert.match(app, /setData\(state\.conceptGraph\)/);
  assert.doesNotMatch(atlas, /kind:\s*'document'|node\.doc|this\.documents/);
});

test('initial cosmos uses compact stubs while all details stay in immutable lazy shards', () => {
  assert.equal(core.evidence.length, 0);
  assert.equal(core.ontology_nodes.length, 0);
  assert.ok(core.episodes.every((episode) => episode.detail_shard_ids.length > 0));
  assert.ok(core.shard_manifest.assets.every((asset) => asset.bytes <= 512 * 1024));
  assert.ok(Buffer.byteLength(JSON.stringify(core)) <= 512 * 1024);
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
  if (graph.coverage.ocr_display_accepted_pages === 0) {
    assert.deepEqual(ocr, []);
    return;
  }
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
