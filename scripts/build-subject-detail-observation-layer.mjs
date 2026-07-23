#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE_PATH = path.join(ROOT, 'data/subject-detail-observation-source.json');
const FAMILY_CONFIG_PATH = path.join(ROOT, 'data/concept-evolution-families.json');
const CATALOG_PATH = path.join(ROOT, 'data/catalog.json');
const OCR_ROOT = path.join(ROOT, '.cache/ocr-production');
const OUTPUT_PATH = path.join(ROOT, 'public/data/subject-detail-observation-layer.json');

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

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function compactText(markdown) {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function exactCount(text, surface) {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(surface, offset)) !== -1) {
    count += 1;
    offset += surface.length;
  }
  return count;
}

function snippetFor(content, surface) {
  const offset = content.indexOf(surface);
  const start = Math.max(0, offset - 72);
  const end = Math.min(content.length, offset + surface.length + 118);
  return content.slice(start, end).replace(/\s+/g, ' ').trim();
}

function failedPageCount(failedPages) {
  if (Array.isArray(failedPages)) return failedPages.length;
  if (failedPages && typeof failedPages === 'object') return Object.keys(failedPages).length;
  return 0;
}

function subjectEntity(facet) {
  return {
    canonical: facet,
    entity_kind: 'subject',
    classification: 'general_curriculum_subject',
    facet_eligible: true,
    source_label: facet,
    facet,
    family: facet,
    course_family: null,
    related_subjects: [],
    stable_subject_id: `subject-detail:${sha256(facet).slice(0, 16)}`,
    stable_course_id: null,
    official_code: null,
    authority: 'source_bound_complete_ocr_candidate',
    course_variant: null,
    lineage_family: facet,
  };
}

function buildEpisode({ concept, source, document, state, pageHits, meaningfulCharacters }) {
  const mentionCount = pageHits.reduce((sum, item) => sum + item.mention_count, 0);
  const evidenceHits = [...pageHits]
    .sort((left, right) =>
      Number(right.heading_hit) - Number(left.heading_hit)
      || right.mention_count - left.mention_count
      || left.page - right.page)
    .slice(0, source.maximumEvidencePages);
  const id = `subject-detail:${source.documentId}:${concept.id}`;
  const subject = subjectEntity(source.facet);
  return {
    id,
    concept_id: concept.id,
    concept_sense_id: `sense:${concept.id}:undifferentiated`,
    label: concept.label,
    aliases: concept.aliases || [],
    category: concept.category,
    ontology_node_id: null,
    subject,
    scope_entity: { ...subject },
    course_entity: null,
    visibility_facets: [source.facet],
    visibility_policy: 'controlled_subject_detail_facet',
    curriculum_line: {
      id: `line:subject-detail:${source.documentId}:${sha256(source.facet).slice(0, 10)}`,
      subject: source.facet,
      course: null,
      scope_entity_label: source.facet,
      subject_entity_kind: 'subject',
      subject_classification: 'general_curriculum_subject',
      stage: document.stage,
      source_stage: document.stage,
      school_type: 'general_education',
      school_subtype: null,
      document_type: document.document_type,
      jurisdiction: document.country || '中国',
      issuing_body: document.issued_by || null,
    },
    work_id: `work:${source.documentId}`,
    edition_id: `edition:${source.documentId}`,
    embedded_item_id: null,
    time: {
      year: source.year,
      precision: 'year',
      basis: 'controlled_version_source_year',
    },
    edition: {
      identity_id: `edition:${source.documentId}`,
      version_label: document.version_label || `${source.year}年版本`,
      preferred_document_id: source.documentId,
      alternate_document_ids: [],
      base_edition_year: source.year,
      revision_year: null,
      identity_status: 'source_bound_complete_ocr_candidate',
    },
    observation: {
      status: 'ocr_complete_pending_audit',
      observation_class: 'subject_detail_ocr_candidate_nonsemantic',
      semantic: false,
      match_type: 'exact_surface',
      roles: ['unknown'],
      mention_count: mentionCount,
      local_unique_mention_count: mentionCount,
      unique_section_count: null,
      normalized_per_10k: meaningfulCharacters
        ? Number((mentionCount * 10_000 / meaningfulCharacters).toFixed(4))
        : 0,
      heading_hit: pageHits.some((item) => item.heading_hit),
      definition_hit: null,
      common_boilerplate_only: false,
      frequency: {
        numerator: mentionCount,
        numerator_unit: 'exact_surface_occurrences_in_complete_ocr_candidate',
        denominator: meaningfulCharacters,
        denominator_unit: 'non_whitespace_ocr_characters',
        exclusions: [],
        comparability: 'within_edition_descriptive_only',
        interpretation: null,
      },
      visual_strength: Number(Math.min(1, 0.42 + Math.log2(mentionCount + 1) * 0.11).toFixed(4)),
      visual_strength_basis: 'within_candidate_display_scaling_not_historical_magnitude',
    },
    evidence_ids: evidenceHits.map((hit) =>
      `subject-detail:${source.documentId}:p${hit.page}:${concept.id}`),
    coverage: {
      coverage_cell_id: `subject-detail-coverage:edition:${source.documentId}`,
      usable_pages: state.page_count,
      total_pages: state.page_count,
      complete: true,
      coverage_kind: 'source_hash_bound_complete_document_ocr',
      negative_claim_eligible: false,
    },
    claim_policy: {
      display_level: 'uniform_star',
      quotation_allowed: false,
      semantic_relation_allowed: false,
      historical_superlative_allowed: false,
      first_appearance_allowed: false,
      disappearance_allowed: false,
    },
    candidate_page_hits: evidenceHits,
  };
}

async function loadSourceDocument(sourceRow, catalogById, maximumEvidencePages) {
  const document = catalogById.get(sourceRow.document_id);
  requireValue(document, `source document is absent from catalog: ${sourceRow.document_id}`);
  const statePath = path.join(OCR_ROOT, sourceRow.document_id, 'state.json');
  const stateBytes = await readFile(statePath);
  const state = JSON.parse(stateBytes);
  requireValue(state.document_id === sourceRow.document_id, `OCR state id mismatch: ${sourceRow.document_id}`);
  requireValue(state.source_sha256 === document.checksum_sha256, `source hash mismatch: ${sourceRow.document_id}`);
  requireValue(state.page_count === document.page_count, `page count mismatch: ${sourceRow.document_id}`);
  requireValue(Array.isArray(state.completed_pages)
    && state.completed_pages.length === state.page_count, `OCR document is incomplete: ${sourceRow.document_id}`);
  requireValue(failedPageCount(state.failed_pages) === 0, `OCR document has failed pages: ${sourceRow.document_id}`);

  const pages = [];
  for (let pageNumber = 1; pageNumber <= state.page_count; pageNumber += 1) {
    requireValue(state.completed_pages[pageNumber - 1] === pageNumber,
      `completed page sequence breaks at ${sourceRow.document_id} p.${pageNumber}`);
    const markdownPath = path.join(
      OCR_ROOT,
      sourceRow.document_id,
      'pages',
      String(pageNumber).padStart(4, '0'),
      'content.md',
    );
    const markdown = await readFile(markdownPath);
    requireValue(
      sha256(markdown) === state.pages[String(pageNumber)].content_markdown_sha256,
      `OCR content hash mismatch at ${sourceRow.document_id} p.${pageNumber}`,
    );
    const content = compactText(markdown.toString('utf8'));
    pages.push({
      page: pageNumber,
      content,
      content_sha256: sha256(markdown),
      character_count: content.replace(/\s/g, '').length,
    });
  }
  return {
    facet: sourceRow.facet,
    year: Number(sourceRow.year),
    documentId: sourceRow.document_id,
    maximumEvidencePages,
    document,
    state,
    stateSha256: sha256(stateBytes),
    pages,
    meaningfulCharacters: pages.reduce((sum, item) => sum + item.character_count, 0),
  };
}

async function buildArtifact(sourceConfig, familyConfig, catalog) {
  requireValue(
    sourceConfig.schema_version === 1
      && sourceConfig.artifact_profile === 'curriculum-subject-detail-observation-source-v1'
      && Array.isArray(sourceConfig.version_sources)
      && sourceConfig.version_sources.length > 0,
    'subject detail source config failed structural validation',
  );
  requireValue(
    familyConfig.schema_version === 3
      && Array.isArray(familyConfig.detailed_concepts)
      && familyConfig.detailed_concepts.length > 0,
    'concept family config has no detailed concepts',
  );
  const maximumEvidencePages = Number(
    sourceConfig.projection_policy?.maximum_evidence_pages_per_observation,
  );
  requireValue(Number.isInteger(maximumEvidencePages) && maximumEvidencePages > 0,
    'maximum evidence pages must be a positive integer');
  const catalogById = new Map(catalog.documents.map((document) => [document.id, document]));
  const currentDetailedConcepts = familyConfig.detailed_concepts
    .filter((concept) => !concept.id.startsWith('detail-pre2001-'));
  const sources = [];
  for (const sourceRow of sourceConfig.version_sources) {
    sources.push(await loadSourceDocument(sourceRow, catalogById, maximumEvidencePages));
  }

  const episodes = [];
  const evidence = [];
  for (const concept of currentDetailedConcepts) {
    requireValue(
      concept.id
        && concept.label
        && Array.isArray(concept.visibility_facets)
        && concept.visibility_facets.length === 1,
      `invalid detailed concept: ${concept.id || 'unknown'}`,
    );
    const facet = concept.visibility_facets[0];
    const surfaces = [...new Set([concept.label, ...(concept.aliases || [])]
      .filter((surface) => typeof surface === 'string' && surface.length >= 2))];
    for (const source of sources.filter((item) => item.facet === facet)) {
      const pageHits = source.pages.flatMap((page) => {
        const surfaceCounts = surfaces
          .map((surface) => ({ surface, count: exactCount(page.content, surface) }))
          .filter((item) => item.count > 0);
        if (!surfaceCounts.length) return [];
        const mentionCount = surfaceCounts.reduce((sum, item) => sum + item.count, 0);
        const matchedSurface = surfaceCounts
          .sort((left, right) => right.count - left.count || left.surface.localeCompare(right.surface, 'zh-CN'))[0]
          .surface;
        return [{
          page: page.page,
          mention_count: mentionCount,
          heading_hit: page.content.split('\n').some((line) =>
            /^#{1,6}\s/.test(line) && surfaces.some((surface) => line.includes(surface))),
          matched_surface: matchedSurface,
          snippet: snippetFor(page.content, matchedSurface),
          content_sha256: page.content_sha256,
        }];
      });
      if (!pageHits.length) continue;
      const episode = buildEpisode({
        concept,
        source,
        document: source.document,
        state: source.state,
        pageHits,
        meaningfulCharacters: source.meaningfulCharacters,
      });
      episodes.push(episode);
      for (const hit of episode.candidate_page_hits) {
        evidence.push({
          id: `subject-detail:${source.documentId}:p${hit.page}:${concept.id}`,
          document_id: source.documentId,
          document_title: source.document.title,
          page_number: hit.page,
          source_locator: `PDF p.${hit.page} · OCR待核`,
          matched_surface: hit.matched_surface,
          snippet: hit.snippet,
          content_sha256: hit.content_sha256,
          citation_allowed: false,
          semantic_claim_allowed: false,
          observation_class: 'subject_detail_ocr_candidate_nonsemantic',
        });
      }
    }
  }
  episodes.sort((left, right) =>
    Number(left.time.year) - Number(right.time.year)
    || left.visibility_facets[0].localeCompare(right.visibility_facets[0], 'zh-CN')
    || left.concept_id.localeCompare(right.concept_id, 'en')
    || left.id.localeCompare(right.id, 'en'));
  evidence.sort((left, right) =>
    left.document_id.localeCompare(right.document_id, 'en')
    || left.page_number - right.page_number
    || left.id.localeCompare(right.id, 'en'));

  const observedConceptIds = new Set(episodes.map((episode) => episode.concept_id));
  const missingConcepts = currentDetailedConcepts
    .filter((concept) => !observedConceptIds.has(concept.id))
    .map((concept) => concept.id);
  requireValue(missingConcepts.length === 0,
    `controlled concepts have no exact OCR observation: ${missingConcepts.join(', ')}`);
  const facetCounts = [...new Set(sourceConfig.version_sources.map((item) => item.facet))]
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
    .map((facet) => ({
      facet,
      source_documents: sources.filter((item) => item.facet === facet).length,
      concepts: new Set(episodes
        .filter((episode) => episode.visibility_facets.includes(facet))
        .map((episode) => episode.concept_id)).size,
      episodes: episodes.filter((episode) => episode.visibility_facets.includes(facet)).length,
    }));
  requireValue(facetCounts.length === 12, `expected 12 subject facets, received ${facetCounts.length}`);

  return {
    schema_version: 1,
    artifact_profile: 'curriculum-subject-detail-observation-layer-v1',
    observed_at: sourceConfig.observed_at,
    publication_status: 'candidate_fail_closed',
    assertion_boundary: sourceConfig.assertion_boundary,
    projection_policy: sourceConfig.projection_policy,
    node_semantics: 'subject_detail_concept_observation_episode_not_document',
    time_semantics: 'year_is_single_spatial_coordinate_not_a_second_timeline',
    sources: sources.map((source) => ({
      document_id: source.documentId,
      document_title: source.document.title,
      facet: source.facet,
      year: source.year,
      version_label: source.document.version_label,
      stage: source.document.stage,
      source_sha256: source.state.source_sha256,
      state_sha256: source.stateSha256,
      page_count: source.state.page_count,
      completed_pages: source.state.completed_pages.length,
      failed_pages: 0,
      meaningful_characters: source.meaningfulCharacters,
      ocr_status: 'ocr_complete_pending_audit',
      citation_allowed: false,
    })).sort((left, right) =>
      left.facet.localeCompare(right.facet, 'zh-CN')
      || left.year - right.year
      || left.document_id.localeCompare(right.document_id, 'en')),
    facet_counts: facetCounts,
    concepts: currentDetailedConcepts.map((concept) => ({
      id: concept.id,
      label: concept.label,
      category: concept.category,
      visibility_facets: concept.visibility_facets,
      observed_years: [...new Set(episodes
        .filter((episode) => episode.concept_id === concept.id)
        .map((episode) => Number(episode.time.year)))].sort((left, right) => left - right),
      episode_count: episodes.filter((episode) => episode.concept_id === concept.id).length,
    })),
    episodes,
    evidence,
    edges: [],
    counts: {
      subject_facets: facetCounts.length,
      source_documents: sources.length,
      source_pages: sources.reduce((sum, source) => sum + source.state.page_count, 0),
      meaningful_characters: sources.reduce((sum, source) => sum + source.meaningfulCharacters, 0),
      controlled_concepts: currentDetailedConcepts.length,
      observed_concepts: observedConceptIds.size,
      episodes: episodes.length,
      evidence: evidence.length,
      first_year: Math.min(...episodes.map((episode) => Number(episode.time.year))),
      last_year: Math.max(...episodes.map((episode) => Number(episode.time.year))),
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [sourceConfig, familyConfig, catalog] = await Promise.all([
    readFile(SOURCE_PATH, 'utf8').then(JSON.parse),
    readFile(FAMILY_CONFIG_PATH, 'utf8').then(JSON.parse),
    readFile(CATALOG_PATH, 'utf8').then(JSON.parse),
  ]);
  const artifact = await buildArtifact(sourceConfig, familyConfig, catalog);
  const expected = stableJson(artifact);
  if (options.check) {
    const actual = await readFile(OUTPUT_PATH, 'utf8');
    if (actual !== expected) {
      throw new Error('public/data/subject-detail-observation-layer.json is stale; run npm run details:build');
    }
    process.stdout.write(
      `Subject detail layer verified: ${artifact.counts.subject_facets} facets, `
      + `${artifact.counts.observed_concepts} concepts, ${artifact.counts.episodes} episodes.\n`,
    );
    return;
  }
  await writeFile(OUTPUT_PATH, expected);
  process.stdout.write(
    `Subject detail layer built: ${artifact.counts.subject_facets} facets, `
    + `${artifact.counts.observed_concepts} concepts, ${artifact.counts.episodes} episodes.\n`,
  );
}

await main();
