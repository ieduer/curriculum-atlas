#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDocumentClassificationResolver } from './document-classification.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUTPUT_PATH = path.join(ROOT, 'public/data/ocr-observation-layer.json');
const CATALOG_PATH = path.join(ROOT, 'data/catalog.json');
const COVERAGE_PATH = path.join(ROOT, 'data/ocr-coverage-ledger.json');
const GRAPH_PATH = path.join(ROOT, 'public/data/concept-evolution.json');
const YEAR_POLICY_PATH = path.join(ROOT, 'data/ocr-document-year-policy.json');
const SEMANTIC_POLICY_PATH = path.join(ROOT, 'data/semantic-publication-policy.json');
const LOCAL_ROOT = path.join(ROOT, '.cache/ocr-production');
const REMOTE_B3_ROOT = path.join(
  ROOT,
  '.cache/remote-ocr-offload/20260718-b3-final/readback/production-p1-mb16-shard-b-r3/documents',
);
const REMOTE_A2_ROOT = path.join(ROOT, '.cache/remote-ocr-offload/20260723-a2-final-tar');
const FALLBACK_ROOT = path.join(ROOT, '.cache/ocr-generic-fallback-v18');
const OBSERVED_AT = '2026-07-24T06:40:27Z';
const MAX_EVIDENCE_PAGES_PER_EPISODE = 1;
const REMOTE_B3_IDS = new Set([
  'legacy-compendium-arts-labor',
  'legacy-compendium-chemistry',
  'legacy-compendium-chinese',
  'legacy-compendium-history',
  'legacy-compendium-physics',
  'legacy-compendium-plans',
]);
const FALLBACK_IDS = new Set([
  'legacy-compendium-biology',
  'legacy-compendium-general-primary',
]);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function assert(condition, message) {
  if (!condition) throw new Error(`OCR observation layer: ${message}`);
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function compactText(markdown) {
  return String(markdown || '')
    .replace(/\r\n/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function meaningfulCharacters(value) {
  return (String(value).match(/[\p{Script=Han}A-Za-z0-9]/gu) || []).length;
}

function pageSurfaceCounts(content, surfaces) {
  const occupied = [];
  const counts = [];
  const ordered = [...new Set(surfaces.filter((surface) =>
    typeof surface === 'string' && surface.trim().length >= 2))]
    .sort((left, right) => right.length - left.length || left.localeCompare(right, 'zh-CN'));
  for (const surface of ordered) {
    let offset = 0;
    let count = 0;
    while ((offset = content.indexOf(surface, offset)) !== -1) {
      const end = offset + surface.length;
      if (!occupied.some(([start, finish]) => offset < finish && end > start)) {
        occupied.push([offset, end]);
        count += 1;
      }
      offset = end;
    }
    if (count) counts.push({ surface, count });
  }
  return counts;
}

function snippetFor(content, surface) {
  const compact = String(content).replace(/\s+/gu, ' ').trim();
  const offset = compact.indexOf(surface);
  if (offset < 0) return compact.slice(0, 220);
  return compact.slice(Math.max(0, offset - 80), Math.min(compact.length, offset + surface.length + 140));
}

function yearFromMetadata(document, policy) {
  for (const field of policy.metadata_precedence) {
    const match = String(document[field] || '').match(/(?:19|20)\d{2}/u);
    if (match) {
      return {
        year: Number(match[0]),
        precision: field === 'issued_date' || field === 'published_date' ? 'date_field_year' : 'explicit_year',
        basis: `catalog.${field}`,
        rule_id: null,
        evidence: [],
      };
    }
  }
  for (const rule of policy.batch_rules) {
    if (!document.id.startsWith(rule.document_id_prefix)
      || !document.title.startsWith(rule.title_prefix)
      || !rule.title_suffix_any.some((suffix) => document.title.endsWith(suffix))) continue;
    return {
      year: rule.year,
      precision: rule.precision,
      basis: `official_issuance_batch:${rule.rule_id}`,
      rule_id: rule.rule_id,
      evidence: rule.evidence,
    };
  }
  return null;
}

function profileFor(documentId) {
  if (REMOTE_B3_IDS.has(documentId)) {
    return { id: 'frozen_readback_20260718_b3_final', root: REMOTE_B3_ROOT, mode: 'complete_state' };
  }
  if (documentId === 'legacy-compendium-english') {
    return { id: 'frozen_readback_20260723_a2_final', root: REMOTE_A2_ROOT, mode: 'complete_state' };
  }
  if (FALLBACK_IDS.has(documentId)) {
    return { id: 'candidate_hybrid_tesseract_v18', root: FALLBACK_ROOT, mode: 'hybrid_fallback' };
  }
  return { id: 'local_production_snapshot', root: LOCAL_ROOT, mode: 'complete_state' };
}

async function loadCompleteDocument(document, profile) {
  const statePath = path.join(profile.root, document.id, 'state.json');
  const stateRaw = await readFile(statePath);
  const state = JSON.parse(stateRaw);
  assert(state.document_id === document.id, `${document.id} state identity mismatch`);
  assert(state.source_sha256 === document.checksum_sha256, `${document.id} state source hash mismatch`);
  assert(Number(state.page_count) === Number(document.page_count), `${document.id} state page count mismatch`);
  assert((state.completed_pages || []).length === document.page_count,
    `${document.id} selected evidence profile is not complete`);
  assert(Object.keys(state.failed_pages || {}).length === 0,
    `${document.id} selected evidence profile has failed pages`);

  let primaryState = null;
  let primaryCompleted = null;
  let primaryFailed = null;
  if (profile.mode === 'hybrid_fallback') {
    const primaryStateRaw = await readFile(path.join(LOCAL_ROOT, document.id, 'state.json'));
    primaryState = JSON.parse(primaryStateRaw);
    assert(sha256(primaryStateRaw) === state.primary_state_sha256,
      `${document.id} hybrid primary-state hash drift`);
    primaryCompleted = new Set((primaryState.completed_pages || []).map(Number));
    primaryFailed = new Set(Object.keys(primaryState.failed_pages || {}).map(Number));
  }

  const pages = [];
  for (let page = 1; page <= document.page_count; page += 1) {
    let raw;
    let contentSha256;
    let engineClass;
    if (profile.mode !== 'hybrid_fallback'
      || (primaryCompleted.has(page) && !primaryFailed.has(page))) {
      raw = await readFile(path.join(
        profile.mode === 'hybrid_fallback' ? LOCAL_ROOT : profile.root,
        document.id,
        'pages',
        String(page).padStart(4, '0'),
        'content.md',
      ));
      const expected = profile.mode === 'hybrid_fallback'
        ? primaryState.pages?.[String(page)]?.content_markdown_sha256
        : state.pages?.[String(page)]?.content_markdown_sha256;
      assert(expected && sha256(raw) === expected, `${document.id} page ${page} content hash drift`);
      contentSha256 = sha256(raw);
      engineClass = 'paddleocr_vl_structured_candidate';
    } else {
      const pageState = state.pages?.[String(page)];
      assert(pageState, `${document.id} page ${page} hybrid fallback state missing`);
      const sidecarRaw = await readFile(path.join(profile.root, document.id, pageState.sidecar));
      assert(sha256(sidecarRaw) === pageState.sidecar_sha256,
        `${document.id} page ${page} fallback sidecar hash drift`);
      const sidecar = JSON.parse(sidecarRaw);
      assert(sidecar.document_id === document.id
        && sidecar.physical_pdf_page === page
        && sidecar.source_pdf_sha256 === document.checksum_sha256
        && sidecar.citation_allowed === false,
      `${document.id} page ${page} fallback identity mismatch`);
      raw = Buffer.from(`${sidecar.text}\n`);
      assert(sha256(raw) === pageState.text_sha256,
        `${document.id} page ${page} fallback text hash drift`);
      contentSha256 = sha256(raw);
      engineClass = 'tesseract_single_witness_candidate';
    }
    const content = compactText(raw.toString('utf8'));
    pages.push({
      page,
      content,
      content_sha256: contentSha256,
      meaningful_characters: meaningfulCharacters(content),
      engine_class: engineClass,
    });
  }
  return {
    state,
    state_sha256: sha256(stateRaw),
    pages,
    profile,
  };
}

function subjectEntity(graph, document, classification) {
  const taxonomy = graph.subject_taxonomy.find((item) =>
    item.source_label === document.subject
    || (item.canonical === classification.canonical_subject && item.facet === classification.display_facet));
  assert(taxonomy, `${document.id} subject taxonomy mapping missing`);
  return {
    canonical: classification.canonical_subject,
    entity_kind: taxonomy.entity_kind,
    classification: taxonomy.classification,
    facet_eligible: true,
    source_label: document.subject,
    facet: classification.display_facet,
    family: classification.subject_family,
    course_family: taxonomy.course_family,
    related_subjects: taxonomy.related_subjects || [],
    stable_subject_id: taxonomy.stable_subject_id,
    stable_course_id: taxonomy.stable_course_id,
    official_code: taxonomy.official_code,
    authority: taxonomy.authority || 'concept_model_v2',
    course_variant: taxonomy.course_variant,
    lineage_family: taxonomy.lineage_family || classification.subject_family,
  };
}

function createEpisode({
  concept,
  document,
  classification,
  subject,
  yearDisposition,
  pageHits,
  documentCharacters,
}) {
  const mentionCount = pageHits.reduce((sum, page) => sum + page.mention_count, 0);
  const evidenceHits = [...pageHits]
    .sort((left, right) => right.mention_count - left.mention_count || left.page - right.page)
    .slice(0, MAX_EVIDENCE_PAGES_PER_EPISODE);
  const id = `ocr-candidate:${document.id}:${concept.id}`;
  const evidenceIds = evidenceHits.map((hit) =>
    `ocr-evidence:${sha256(`${id}|${hit.page}|${hit.content_sha256}`).slice(0, 20)}`);
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
    visibility_facets: [classification.display_facet],
    visibility_policy: 'controlled_document_subject_facet',
    curriculum_line: {
      id: `line:ocr:${document.id}`,
      subject: classification.canonical_subject,
      course: null,
      scope_entity_label: classification.canonical_subject,
      subject_entity_kind: subject.entity_kind,
      subject_classification: subject.classification,
      stage: document.stage,
      source_stage: document.stage,
      school_type: /特殊教育/u.test(document.stage || '') ? 'special_education' : 'general_education',
      school_subtype: null,
      document_type: document.document_type,
      jurisdiction: '中国',
      issuing_body: document.issued_by,
    },
    work_id: `work:${document.id}`,
    edition_id: `edition:${document.id}`,
    embedded_item_id: null,
    time: {
      year: yearDisposition.year,
      precision: yearDisposition.precision,
      basis: yearDisposition.basis,
    },
    edition: {
      identity_id: `edition:${document.id}`,
      version_label: document.version_label,
      preferred_document_id: document.id,
      alternate_document_ids: [],
      base_edition_year: yearDisposition.year,
      revision_year: null,
      identity_status: 'source_hash_bound_ocr_candidate',
    },
    observation: {
      status: 'ocr_complete_machine_candidate',
      observation_class: 'ocr_candidate_nonsemantic',
      semantic: false,
      match_type: 'longest_surface_nonoverlapping_exact_match',
      roles: ['unknown'],
      mention_count: mentionCount,
      local_unique_mention_count: mentionCount,
      unique_section_count: null,
      normalized_per_10k: documentCharacters
        ? Number((mentionCount * 10_000 / documentCharacters).toFixed(4))
        : 0,
      heading_hit: pageHits.some((page) => page.heading_hit),
      definition_hit: null,
      common_boilerplate_only: false,
      frequency: {
        numerator: mentionCount,
        numerator_unit: 'nonoverlapping_exact_surface_occurrences_in_complete_ocr_candidate',
        denominator: documentCharacters,
        denominator_unit: 'meaningful_ocr_characters',
        exclusions: [],
        comparability: 'within_document_descriptive_only',
        interpretation: null,
      },
      visual_strength: Number(Math.min(0.9, 0.34 + Math.log2(mentionCount + 1) * 0.11).toFixed(4)),
      visual_strength_basis: 'within_candidate_display_scaling_not_historical_magnitude',
    },
    evidence_ids: evidenceIds,
    coverage: {
      coverage_cell_id: `ocr-coverage:edition:${document.id}`,
      usable_pages: document.page_count,
      total_pages: document.page_count,
      complete: true,
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
    candidate_page_hits: pageHits,
    evidence_hits: evidenceHits,
  };
}

function buildEdges(candidates, baseEpisodes) {
  const edges = [];
  const groups = Map.groupBy(candidates, (episode) =>
    `${episode.concept_id}|${episode.visibility_facets[0]}`);
  for (const episodes of groups.values()) {
    const byYear = [...Map.groupBy(episodes, (episode) => episode.time.year).entries()]
      .map(([, rows]) => [...rows].sort((left, right) =>
        right.observation.mention_count - left.observation.mention_count
        || left.id.localeCompare(right.id, 'en'))[0])
      .sort((left, right) => left.time.year - right.time.year || left.id.localeCompare(right.id, 'en'));
    const first = byYear[0];
    if (first) {
      const previous = baseEpisodes
        .filter((episode) => episode.concept_id === first.concept_id
          && episode.visibility_facets?.includes(first.visibility_facets[0])
          && Number(episode.time?.year) < first.time.year)
        .sort((left, right) => Number(right.time.year) - Number(left.time.year)
          || left.id.localeCompare(right.id, 'en'))[0];
      if (previous) byYear.unshift(previous);
    }
    for (let index = 1; index < byYear.length; index += 1) {
      const source = byYear[index - 1];
      const target = byYear[index];
      edges.push({
        id: `ocr-lineage:${sha256(`${source.id}|${target.id}`).slice(0, 18)}`,
        source: source.id,
        target: target.id,
        type: 'next_observed',
        mode: 'lineage',
        status: 'ocr_candidate_machine_bounded',
        assertion_type: 'next_lexical_observation_in_current_display_layer',
        semantic: false,
        citation_allowed: false,
        directionality: 'directed_by_observation_year',
        editor_reviewed: false,
        source_evidence_ids: source.evidence_ids || [],
        target_evidence_ids: target.evidence_ids || [],
        influence_claim_allowed: false,
        claim_boundary: '连接线只表示当前资料层中的下一次词面观察；不表示首次出现、取代、影响、因果或义项连续。',
      });
    }
  }

  const byPage = new Map();
  for (const episode of candidates) {
    for (const hit of episode.evidence_hits) {
      const key = `${episode.edition.preferred_document_id}|${hit.page}`;
      if (!byPage.has(key)) byPage.set(key, []);
      byPage.get(key).push(episode);
    }
  }
  const pairCounts = new Map();
  for (const pageEpisodes of byPage.values()) {
    const rows = [...pageEpisodes].sort((left, right) => left.id.localeCompare(right.id, 'en'));
    for (let left = 0; left < rows.length; left += 1) {
      for (let right = left + 1; right < rows.length; right += 1) {
        const key = `${rows[left].id}|${rows[right].id}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }
  for (const [pair, sharedPages] of [...pairCounts.entries()]
    .filter(([, count]) => count >= 1)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'en'))
    .slice(0, 60)) {
    const [source, target] = pair.split('|');
    edges.push({
      id: `ocr-cooccurrence:${sha256(pair).slice(0, 18)}`,
      source,
      target,
      type: 'page_cooccurrence',
      mode: 'cross',
      status: 'ocr_candidate_machine_bounded',
      assertion_type: 'same_physical_page_surface_cooccurrence',
      semantic: false,
      citation_allowed: false,
      directionality: 'undirected',
      editor_reviewed: false,
      metric: { shared_evidence_page_count: sharedPages },
      influence_claim_allowed: false,
      claim_boundary: '连线只表示两个词面在同一 OCR 证据页共同出现；不表示概念关系、影响或因果。',
    });
  }
  return edges;
}

async function buildArtifact() {
  const [
    catalogRaw,
    coverageRaw,
    graphRaw,
    yearPolicyRaw,
    semanticPolicyRaw,
  ] = await Promise.all([
    readFile(CATALOG_PATH),
    readFile(COVERAGE_PATH),
    readFile(GRAPH_PATH),
    readFile(YEAR_POLICY_PATH),
    readFile(SEMANTIC_POLICY_PATH),
  ]);
  const catalog = JSON.parse(catalogRaw);
  const coverage = JSON.parse(coverageRaw);
  const graph = JSON.parse(graphRaw);
  const yearPolicy = JSON.parse(yearPolicyRaw);
  const semanticPolicy = JSON.parse(semanticPolicyRaw);
  assert(yearPolicy.policy_id === 'curriculum-ocr-document-year-v1',
    'document year policy mismatch');
  const catalogById = new Map(catalog.documents.map((document) => [document.id, document]));
  const aliasIds = new Set(semanticPolicy.document_aliases.map((alias) => alias.alias_document_id));
  const expectedComplete = coverage.documents.filter((document) => document.complete_document);
  const classify = await loadDocumentClassificationResolver(new URL('../', import.meta.url));
  const documents = [];
  const candidates = [];
  const evidence = [];
  let processedPages = 0;
  let processedCharacters = 0;

  for (const coverageDocument of expectedComplete) {
    const document = catalogById.get(coverageDocument.document_id);
    assert(document, `${coverageDocument.document_id} is absent from catalog`);
    const profile = profileFor(document.id);
    const source = await loadCompleteDocument(document, profile);
    processedPages += source.pages.length;
    const documentCharacters = source.pages
      .reduce((sum, page) => sum + page.meaningful_characters, 0);
    processedCharacters += documentCharacters;
    const classification = classify(document);
    const yearDisposition = yearFromMetadata(document, yearPolicy);
    assert(yearDisposition, `${document.id} has no terminal year disposition`);
    assert(yearDisposition.year >= 1902 && yearDisposition.year <= 2022,
      `${document.id} resolved year is outside the star-map scope`);
    let projectionStatus = 'projected';
    if (document.id.startsWith('legacy-compendium-')) {
      projectionStatus = 'bounded_item_projection_required';
    } else if (aliasIds.has(document.id)) {
      projectionStatus = 'exact_source_alias_deduplicated';
    } else if (classification.entity_kind !== 'subject') {
      projectionStatus = 'non_subject_scope_fail_closed';
    }
    const documentReceipt = {
      id: document.id,
      title: document.title,
      source_subject: document.subject,
      canonical_subject: classification.canonical_subject,
      visibility_facets: classification.display_facet ? [classification.display_facet] : [],
      taxonomy_entity_kind: classification.taxonomy_entity_kind,
      source_sha256: document.checksum_sha256,
      page_count: document.page_count,
      completed_pages: source.pages.length,
      failed_pages: 0,
      meaningful_characters: documentCharacters,
      ocr_profile: profile.id,
      state_sha256: source.state_sha256,
      year: yearDisposition.year,
      year_precision: yearDisposition.precision,
      year_basis: yearDisposition.basis,
      year_rule_id: yearDisposition.rule_id,
      projection_status: projectionStatus,
      citation_allowed: false,
      semantic_claim_allowed: false,
    };
    documents.push(documentReceipt);
    if (projectionStatus !== 'projected') continue;

    const subject = subjectEntity(graph, document, classification);
    const eligibleConcepts = graph.concepts.filter((concept) =>
      (concept.subjects || []).includes('*')
      || (concept.subjects || []).includes(document.subject)
      || (concept.subjects || []).includes(classification.canonical_subject));
    for (const concept of eligibleConcepts) {
      const surfaces = [concept.label, ...(concept.aliases || [])];
      const pageHits = source.pages.flatMap((page) => {
        const counts = pageSurfaceCounts(page.content, surfaces);
        if (!counts.length) return [];
        const mentionCount = counts.reduce((sum, item) => sum + item.count, 0);
        return [{
          page: page.page,
          mention_count: mentionCount,
          matched_surface: counts[0].surface,
          surface_counts: counts,
          heading_hit: page.content.split('\n')
            .some((line) => /^#{1,6}\s/u.test(line)
              && counts.some((entry) => line.includes(entry.surface))),
          snippet: snippetFor(page.content, counts[0].surface),
          content_sha256: page.content_sha256,
          engine_class: page.engine_class,
        }];
      });
      if (!pageHits.length) continue;
      const episode = createEpisode({
        concept,
        document,
        classification,
        subject,
        yearDisposition,
        pageHits,
        documentCharacters,
      });
      candidates.push(episode);
      episode.evidence_hits.forEach((hit, index) => evidence.push({
        id: episode.evidence_ids[index],
        document_id: document.id,
        document_title: document.title,
        subject: classification.canonical_subject,
        visibility_facets: [classification.display_facet],
        page_number: hit.page,
        source_locator: `PDF physical p.${hit.page} · OCR候选`,
        matched_surface: hit.matched_surface,
        surface_counts: hit.surface_counts,
        snippet: hit.snippet,
        content_sha256: hit.content_sha256,
        source_pdf_sha256: document.checksum_sha256,
        engine_class: hit.engine_class,
        citation_allowed: false,
        semantic_claim_allowed: false,
        observation_class: 'ocr_candidate_nonsemantic',
      }));
    }
  }
  assert(documents.length === coverage.counts.complete_documents,
    'not every runtime-complete document reached the generic builder');
  assert(processedPages === coverage.counts.complete_document_pages,
    'generic builder complete-page denominator drift');
  assert(documents.every((document) => document.year !== null),
    'generic builder has an unresolved document year');
  candidates.sort((left, right) =>
    left.time.year - right.time.year
    || left.visibility_facets[0].localeCompare(right.visibility_facets[0], 'zh-CN')
    || left.concept_id.localeCompare(right.concept_id, 'en')
    || left.id.localeCompare(right.id, 'en'));
  evidence.sort((left, right) =>
    left.document_id.localeCompare(right.document_id, 'en')
    || left.page_number - right.page_number
    || left.id.localeCompare(right.id, 'en'));
  const edges = buildEdges(candidates, graph.episodes || []);
  const publicEpisodes = candidates.map(({ candidate_page_hits, evidence_hits, ...episode }) => episode);

  return {
    schema_version: 2,
    artifact_profile: 'curriculum-ocr-observation-layer-v2',
    observed_at: OBSERVED_AT,
    publication_status: 'candidate_fail_closed',
    assertion_boundary: 'All runtime-complete OCR documents pass through this builder. Only source-bound, year-resolved, subject-classified exact surfaces become stars. Compendia remain in their bounded-item layer; aliases and non-subject scopes are terminally recorded but not projected. No candidate is quotable or semantic.',
    source: {
      citation_allowed: false,
      semantic_claim_allowed: false,
      coverage_ledger_sha256: sha256(coverageRaw),
      catalog_sha256: sha256(catalogRaw),
      graph_sha256: sha256(graphRaw),
      year_policy_sha256: sha256(yearPolicyRaw),
      semantic_policy_sha256: sha256(semanticPolicyRaw),
    },
    pipeline_summary: {
      complete_documents: documents.length,
      complete_pages: processedPages,
      projected_documents: documents.filter((document) => document.projection_status === 'projected').length,
      bounded_item_documents: documents
        .filter((document) => document.projection_status === 'bounded_item_projection_required').length,
      deduplicated_alias_documents: documents
        .filter((document) => document.projection_status === 'exact_source_alias_deduplicated').length,
      non_subject_scope_documents: documents
        .filter((document) => document.projection_status === 'non_subject_scope_fail_closed').length,
      unresolved_year_documents: 0,
      total_documents: coverage.counts.nominal_documents,
    },
    documents: documents.sort((left, right) => left.id.localeCompare(right.id, 'en')),
    pages: evidence.map((item) => ({
      document_id: item.document_id,
      page: item.page_number,
      content_sha256: item.content_sha256,
      snippet: item.snippet,
      matched_surface: item.matched_surface,
    })),
    concepts: [...Map.groupBy(publicEpisodes, (episode) => episode.concept_id).entries()]
      .map(([conceptId, episodes]) => ({
        id: conceptId,
        label: episodes[0].label,
        category: episodes[0].category,
        document_count: new Set(episodes.map((episode) => episode.edition.preferred_document_id)).size,
        mention_count: episodes.reduce((sum, episode) => sum + episode.observation.mention_count, 0),
        evidence_page_count: episodes.reduce((sum, episode) => sum + episode.evidence_ids.length, 0),
      }))
      .sort((left, right) => left.id.localeCompare(right.id, 'en')),
    episodes: publicEpisodes,
    evidence,
    edges,
    counts: {
      complete_documents: documents.length,
      complete_pages: processedPages,
      meaningful_characters: processedCharacters,
      projected_documents: documents.filter((document) => document.projection_status === 'projected').length,
      concept_candidates: publicEpisodes.length,
      evidence_pages: evidence.length,
      lineage_edges: edges.filter((edge) => edge.mode === 'lineage').length,
      cooccurrence_edges: edges.filter((edge) => edge.mode === 'cross').length,
      unresolved_year_documents: 0,
    },
  };
}

async function main() {
  const check = process.argv.includes('--check');
  const artifact = await buildArtifact();
  const expected = stableJson(artifact);
  if (check) {
    assert(await readFile(OUTPUT_PATH, 'utf8') === expected,
      'checked-in generic OCR observation layer is stale');
  } else {
    await writeFile(OUTPUT_PATH, expected);
  }
  process.stdout.write(`${JSON.stringify(artifact.counts)}\n`);
}

await main();
