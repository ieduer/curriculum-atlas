#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CONFIG_PATH = path.join(ROOT, 'data/concept-evolution-families.json');
const LEXICON_PATH = path.join(ROOT, 'data/concept-lexicon.json');
const CORE_PATH = path.join(ROOT, 'public/data/concept-evolution.json');
const OCR_PATH = path.join(ROOT, 'public/data/ocr-observation-layer.json');
const CENTURY_PATH = path.join(ROOT, 'public/data/century-observation-layer.json');
const OUTPUT_PATH = path.join(ROOT, 'public/data/concept-evolution-families.json');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseArgs(argv) {
  if (argv.length === 0) return { check: false };
  if (argv.length === 1 && argv[0] === '--check') return { check: true };
  throw new Error(`unknown arguments: ${argv.join(' ')}`);
}

function representativeByYear(episodes) {
  const byYear = new Map();
  for (const episode of episodes) {
    const year = Number(episode.time?.year);
    if (!Number.isFinite(year)) continue;
    const previous = byYear.get(year);
    const strength = Number(episode.observation?.visual_strength) || 0;
    const previousStrength = Number(previous?.observation?.visual_strength) || 0;
    if (!previous || strength > previousStrength || (strength === previousStrength && episode.id.localeCompare(previous.id, 'en') < 0)) {
      byYear.set(year, episode);
    }
  }
  return [...byYear.values()].sort((left, right) =>
    Number(left.time.year) - Number(right.time.year) || left.id.localeCompare(right.id, 'en'));
}

function edgeId(parts) {
  return `evolution-family:${sha256(parts.join('|')).slice(0, 20)}`;
}

function buildArtifact(config, lexicon, graphs) {
  if (config.schema_version !== 1
    || config.artifact_profile !== 'curriculum-century-concept-families-v1'
    || config.concept_tier?.id !== 'language-practice-domain'
    || !Array.isArray(config.families)
    || !Array.isArray(config.historical_concepts)) {
    throw new Error('concept evolution family config failed structural validation');
  }
  const concepts = new Map([
    ...lexicon.concepts.map((concept) => [concept.id, concept]),
    ...config.historical_concepts.map((concept) => [concept.id, concept]),
  ]);
  const familyByConcept = new Map();
  for (const family of config.families) {
    if (!family.id || !family.label || !Array.isArray(family.concept_ids) || family.concept_ids.length < 2) {
      throw new Error(`invalid concept family: ${family.id || 'unknown'}`);
    }
    for (const conceptId of family.concept_ids) {
      if (!concepts.has(conceptId)) throw new Error(`${family.id} references unknown concept ${conceptId}`);
      if (familyByConcept.has(conceptId)) throw new Error(`${conceptId} belongs to more than one same-tier family`);
      familyByConcept.set(conceptId, family.id);
    }
    for (const transition of family.transitions || []) {
      if (!family.concept_ids.includes(transition.source_concept_id)
        || !family.concept_ids.includes(transition.target_concept_id)
        || !transition.label) {
        throw new Error(`${family.id} contains an invalid transition`);
      }
    }
  }

  const episodes = [];
  const episodeIds = new Set();
  for (const graph of graphs) {
    for (const episode of graph.episodes || []) {
      if (episodeIds.has(episode.id)) continue;
      episodeIds.add(episode.id);
      episodes.push(episode);
    }
  }
  const relevantEpisodes = episodes.filter((episode) => familyByConcept.has(episode.concept_id));
  const memberships = relevantEpisodes.map((episode) => ({
    episode_id: episode.id,
    concept_id: episode.concept_id,
    family_id: familyByConcept.get(episode.concept_id),
    concept_tier_id: config.concept_tier.id,
    year: Number(episode.time.year),
  })).sort((left, right) =>
    left.year - right.year || left.family_id.localeCompare(right.family_id, 'en')
    || left.concept_id.localeCompare(right.concept_id, 'en') || left.episode_id.localeCompare(right.episode_id, 'en'));

  const edges = [];
  const familySummaries = config.families.map((family) => {
    const familyEpisodes = relevantEpisodes.filter((episode) => familyByConcept.get(episode.concept_id) === family.id);
    const episodesByConcept = new Map(family.concept_ids.map((conceptId) => [conceptId, []]));
    for (const episode of familyEpisodes) episodesByConcept.get(episode.concept_id).push(episode);
    const representatives = new Map(
      [...episodesByConcept].map(([conceptId, items]) => [conceptId, representativeByYear(items)]),
    );

    for (const [conceptId, items] of representatives) {
      for (let index = 1; index < items.length; index += 1) {
        const source = items[index - 1];
        const target = items[index];
        edges.push({
          id: edgeId([family.id, conceptId, source.id, target.id, 'observed_again']),
          source: source.id,
          target: target.id,
          family_id: family.id,
          type: 'same_surface_observed_again',
          mode: 'evolution',
          label: '同词再现',
          source_year: Number(source.time.year),
          target_year: Number(target.time.year),
          semantic: false,
          citation_allowed: false,
          influence_claim_allowed: false,
          claim_boundary: '只表示同一受控词面在当前资料层中的下一次年份观察，不表示连续存在、首次出现、影响或因果。',
        });
      }
    }

    for (const transition of family.transitions || []) {
      const sources = representatives.get(transition.source_concept_id) || [];
      const targets = representatives.get(transition.target_concept_id) || [];
      const candidates = [];
      for (const source of sources) {
        for (const target of targets) {
          const gap = Number(target.time.year) - Number(source.time.year);
          if (gap >= 0) candidates.push({ source, target, gap });
        }
      }
      candidates.sort((left, right) =>
        left.gap - right.gap
        || Number(right.source.time.year) - Number(left.source.time.year)
        || left.source.id.localeCompare(right.source.id, 'en')
        || left.target.id.localeCompare(right.target.id, 'en'));
      const pair = candidates[0];
      if (!pair) continue;
      edges.push({
        id: edgeId([family.id, transition.source_concept_id, transition.target_concept_id, pair.source.id, pair.target.id]),
        source: pair.source.id,
        target: pair.target.id,
        family_id: family.id,
        type: 'editorial_correspondence',
        mode: 'evolution',
        label: transition.label,
        source_year: Number(pair.source.time.year),
        target_year: Number(pair.target.time.year),
        semantic: false,
        citation_allowed: false,
        influence_claim_allowed: false,
        claim_boundary: config.assertion_boundary,
      });
    }

    const observedConcepts = family.concept_ids.filter((conceptId) => (episodesByConcept.get(conceptId) || []).length > 0);
    const years = familyEpisodes.map((episode) => Number(episode.time.year)).filter(Number.isFinite);
    return {
      id: family.id,
      label: family.label,
      definition: family.definition,
      concept_tier_id: config.concept_tier.id,
      concept_ids: family.concept_ids,
      observed_concepts: observedConcepts.map((conceptId) => ({
        id: conceptId,
        label: concepts.get(conceptId).label,
        first_observed_year: Math.min(...episodesByConcept.get(conceptId).map((episode) => Number(episode.time.year))),
        last_observed_year: Math.max(...episodesByConcept.get(conceptId).map((episode) => Number(episode.time.year))),
        episode_count: episodesByConcept.get(conceptId).length,
      })),
      first_observed_year: years.length ? Math.min(...years) : null,
      last_observed_year: years.length ? Math.max(...years) : null,
      episode_count: familyEpisodes.length,
    };
  });

  edges.sort((left, right) =>
    left.family_id.localeCompare(right.family_id, 'en')
    || left.source_year - right.source_year
    || left.target_year - right.target_year
    || left.id.localeCompare(right.id, 'en'));
  if (familySummaries.some((family) => family.observed_concepts.length < 2
    || family.first_observed_year >= 2001
    || family.last_observed_year < 2001)) {
    throw new Error('every published family must cross the historical/current boundary with at least two observed concepts');
  }
  return {
    schema_version: 1,
    artifact_profile: 'curriculum-concept-evolution-families-v1',
    concept_tier: config.concept_tier,
    assertion_boundary: config.assertion_boundary,
    publication_status: 'editorial_correspondence_noncausal',
    families: familySummaries,
    episode_memberships: memberships,
    edges,
    counts: {
      families: familySummaries.length,
      configured_concepts: familyByConcept.size,
      observed_concepts: new Set(memberships.map((item) => item.concept_id)).size,
      episode_memberships: memberships.length,
      same_surface_edges: edges.filter((edge) => edge.type === 'same_surface_observed_again').length,
      correspondence_edges: edges.filter((edge) => edge.type === 'editorial_correspondence').length,
      first_year: Math.min(...memberships.map((item) => item.year)),
      last_year: Math.max(...memberships.map((item) => item.year)),
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [config, lexicon, core, ocr, century] = await Promise.all([
    readFile(CONFIG_PATH, 'utf8').then(JSON.parse),
    readFile(LEXICON_PATH, 'utf8').then(JSON.parse),
    readFile(CORE_PATH, 'utf8').then(JSON.parse),
    readFile(OCR_PATH, 'utf8').then(JSON.parse),
    readFile(CENTURY_PATH, 'utf8').then(JSON.parse),
  ]);
  const artifact = buildArtifact(config, lexicon, [
    core,
    ocr,
    century.star_projection,
  ]);
  const expected = stableJson(artifact);
  if (options.check) {
    const actual = await readFile(OUTPUT_PATH, 'utf8');
    if (actual !== expected) throw new Error('public/data/concept-evolution-families.json is stale; run npm run families:build');
    process.stdout.write(`Concept families verified: ${artifact.counts.families} families, ${artifact.counts.episode_memberships} episode memberships.\n`);
    return;
  }
  await writeFile(OUTPUT_PATH, expected);
  process.stdout.write(`Concept families built: ${artifact.counts.families} families, ${artifact.counts.episode_memberships} episode memberships.\n`);
}

await main();
