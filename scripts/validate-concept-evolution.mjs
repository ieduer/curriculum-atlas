#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('../', import.meta.url).pathname);
const graphPath = process.env.CONCEPT_GRAPH_OUTPUT_PATH
  ? path.resolve(root, process.env.CONCEPT_GRAPH_OUTPUT_PATH)
  : path.join(root, 'public/data/concept-evolution.json');
const qualityPath = process.env.CONCEPT_QUALITY_OUTPUT_PATH
  ? path.resolve(root, process.env.CONCEPT_QUALITY_OUTPUT_PATH)
  : path.join(root, 'data/concept-evolution-quality.json');
const graph = JSON.parse(await readFile(graphPath, 'utf8'));
const quality = JSON.parse(await readFile(qualityPath, 'utf8'));
const episodes = new Map(graph.episodes.map((item) => [item.id, item]));
const evidence = new Map(graph.evidence.map((item) => [item.id, item]));
const failures = [];
const fail = (condition, message) => { if (!condition) failures.push(message); };

fail(graph.schema_version === 1, 'unsupported schema_version');
fail(graph.build_revision === quality.build_revision, 'quality/build revision mismatch');
fail(quality.passed === true, 'quality report is not passing');
fail(episodes.size === graph.episodes.length, 'duplicate episode IDs');
fail(evidence.size === graph.evidence.length, 'duplicate evidence IDs');

for (const episode of graph.episodes) {
  fail(Number.isInteger(episode.time?.year) && episode.time.year >= 1800 && episode.time.year <= 2030, `${episode.id}: invalid year`);
  fail(Boolean(episode.curriculum_line?.id && episode.edition?.identity_id), `${episode.id}: missing line or edition identity`);
  fail(episode.evidence_ids.length > 0 && episode.evidence_ids.every((id) => evidence.has(id)), `${episode.id}: missing evidence`);
  if (episode.claim_policy.display_level === 'solid') {
    fail(episode.observation.status === 'citation_ready', `${episode.id}: solid status is not citation_ready`);
    fail(episode.evidence_ids.some((id) => evidence.get(id)?.citation_allowed === true && evidence.get(id)?.evidence_status === 'citation_ready'), `${episode.id}: solid has no citation-ready paragraph evidence`);
  } else {
    fail(episode.claim_policy.quotation_allowed === false, `${episode.id}: non-solid episode is quotable`);
  }
  fail(episode.coverage.negative_claim_eligible === false, `${episode.id}: negative history claim enabled on incomplete corpus`);
  fail(episode.claim_policy.historical_superlative_allowed === false, `${episode.id}: historical superlative enabled`);
}

for (const edge of graph.edges) {
  const source = episodes.get(edge.source);
  const target = episodes.get(edge.target);
  fail(Boolean(source && target), `${edge.id}: endpoint missing`);
  if (edge.type === 'next_observed' && source && target) {
    fail(source.concept_id === target.concept_id, `${edge.id}: lineage joins different concepts`);
    fail(source.subject.canonical === target.subject.canonical, `${edge.id}: lineage joins different subjects`);
    fail(source.curriculum_line.id === target.curriculum_line.id, `${edge.id}: lineage joins different curriculum lines`);
    fail(source.observation.status === 'citation_ready' && target.observation.status === 'citation_ready', `${edge.id}: lineage uses non-citation episode`);
  }
}

for (const item of graph.evidence) {
  fail(Boolean(item.document_id && item.source_locator && item.body_sha256), `${item.id}: incomplete locator/hash`);
  if (item.evidence_status !== 'citation_ready') fail(item.citation_allowed === false, `${item.id}: candidate evidence is citation allowed`);
}

if (failures.length) {
  console.error(JSON.stringify({ passed: false, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ passed: true, episodes: graph.episodes.length, edges: graph.edges.length, evidence: graph.evidence.length, build_revision: graph.build_revision }));
