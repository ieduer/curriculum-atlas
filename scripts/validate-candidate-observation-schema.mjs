#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const schema = JSON.parse(await readFile(resolve(root, 'data/candidate-observation-layer.schema.json'), 'utf8'));
const sources = [
  ['ocr', 'public/data/ocr-observation-layer.json', (value) => value.episodes],
  ['subject_detail', 'public/data/subject-detail-observation-layer.json', (value) => value.episodes],
  ['pre2001_subject_detail', 'public/data/pre2001-subject-detail-observation-layer.json', (value) => value.episodes],
  ['century', 'public/data/century-observation-layer.json', (value) => value.star_projection.episodes],
];
const errors = [];
let checked = 0;

function requireValue(condition, source, id, field, expected, observed) {
  if (!condition) errors.push({ source, id, field, expected, observed });
}

for (const [source, path, select] of sources) {
  const value = JSON.parse(await readFile(resolve(root, path), 'utf8'));
  for (const episode of select(value)) {
    checked += 1;
    requireValue(typeof episode.id === 'string' && episode.id.length > 0, source, episode.id, 'id', 'non-empty string', episode.id);
    requireValue(typeof episode.concept_id === 'string' && episode.concept_id.length > 0, source, episode.id, 'concept_id', 'non-empty string', episode.concept_id);
    requireValue(typeof episode.label === 'string' && episode.label.length > 0, source, episode.id, 'label', 'non-empty string', episode.label);
    requireValue(Array.isArray(episode.visibility_facets)
      && (episode.visibility_policy === 'global_only'
        ? episode.visibility_facets.length === 0
        : episode.visibility_facets.length > 0)
      && new Set(episode.visibility_facets).size === episode.visibility_facets.length,
    source, episode.id, 'visibility_facets', 'unique; empty only for global_only', episode.visibility_facets);
    requireValue(Number.isInteger(episode.time?.year)
      && episode.time.year >= schema.properties.time.properties.year.minimum
      && episode.time.year <= schema.properties.time.properties.year.maximum,
    source, episode.id, 'time.year', 'integer 1902..2022', episode.time?.year);
    requireValue(episode.observation?.semantic === false, source, episode.id, 'observation.semantic', false, episode.observation?.semantic);
    requireValue(Array.isArray(episode.evidence_ids) && episode.evidence_ids.length > 0
      && new Set(episode.evidence_ids).size === episode.evidence_ids.length,
    source, episode.id, 'evidence_ids', 'non-empty unique array', episode.evidence_ids);
    requireValue(episode.coverage?.negative_claim_eligible === false,
      source, episode.id, 'coverage.negative_claim_eligible', false, episode.coverage?.negative_claim_eligible);
    for (const [field, property] of Object.entries(schema.properties.claim_policy.properties)) {
      requireValue(episode.claim_policy?.[field] === property.const,
        source, episode.id, `claim_policy.${field}`, property.const, episode.claim_policy?.[field]);
    }
  }
}

if (errors.length) {
  for (const error of errors.slice(0, 20)) console.error(JSON.stringify(error));
  throw new Error(`${errors.length} candidate observation schema violations across ${checked} episodes`);
}
console.log(`PASS ${checked} candidate episodes satisfy ${schema.$id}`);
