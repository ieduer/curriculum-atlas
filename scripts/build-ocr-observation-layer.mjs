#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

function parseArgs(argv) {
  const args = { runStatuses: [], activeProgress: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith('--') || !value || value.startsWith('--')) throw new Error(`Invalid argument: ${flag}`);
    if (flag === '--run-status') args.runStatuses.push(resolve(value));
    else if (flag === '--active-progress') args.activeProgress.push(value);
    else args[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  return args;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function exactCount(text, surface) {
  if (!surface) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(surface, offset)) !== -1) {
    count += 1;
    offset += surface.length;
  }
  return count;
}

function compactText(markdown) {
  return markdown.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function publicDocumentTitle(id, catalogById) {
  if (catalogById.has(id)) return catalogById.get(id).title;
  const labels = {
    'legacy-compendium-arts-labor': '历史课程文件汇编·艺术与劳动卷',
    'legacy-compendium-biology': '历史课程文件汇编·生物卷',
    'legacy-compendium-chemistry': '历史课程文件汇编·化学卷',
    'legacy-compendium-chinese': '历史课程文件汇编·语文卷',
    'legacy-compendium-english': '历史课程文件汇编·英语卷',
    'legacy-compendium-general-primary': '历史课程文件汇编·小学综合卷',
    'legacy-compendium-geography': '历史课程文件汇编·地理卷',
    'legacy-compendium-history': '历史课程文件汇编·历史卷',
    'legacy-compendium-mathematics': '历史课程文件汇编·数学卷',
    'legacy-compendium-physics': '历史课程文件汇编·物理卷',
    'legacy-compendium-plans': '历史课程文件汇编·课程方案卷',
    'legacy-compendium-politics': '历史课程文件汇编·政治卷',
  };
  return labels[id] || id;
}

function parseActiveProgress(items) {
  const result = new Map();
  for (const item of items) {
    const match = item.match(/^([a-z0-9-]+)=(\d+)\/(\d+)$/);
    requireValue(match, `Invalid --active-progress value: ${item}`);
    const completedPages = Number(match[2]);
    const pageCount = Number(match[3]);
    requireValue(completedPages >= 0 && completedPages <= pageCount, `Invalid active progress range: ${item}`);
    result.set(match[1], { completedPages, pageCount });
  }
  return result;
}

function mergeRunStatusDocuments(statuses, catalogById, activeProgress) {
  const merged = new Map();
  for (const status of statuses) {
    for (const [id, row] of Object.entries(status.documents || {})) {
      merged.set(id, {
        id,
        title: publicDocumentTitle(id, catalogById),
        status: row.status,
        page_count: Number(row.page_count || 0),
        completed_pages: row.status === 'complete' ? Number(row.page_count || 0) : null,
        completed_at: row.completed_at || null,
      });
    }
  }
  for (const [id, progress] of activeProgress) {
    const current = merged.get(id) || { id, title: publicDocumentTitle(id, catalogById) };
    merged.set(id, {
      ...current,
      status: 'active',
      page_count: progress.pageCount,
      completed_pages: progress.completedPages,
      completed_at: null,
    });
  }
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function createCandidateEpisode(concept, pageHits, meaningfulCharacters) {
  const mentionCount = pageHits.reduce((sum, page) => sum + page.mention_count, 0);
  const normalized = meaningfulCharacters ? Number((mentionCount * 10_000 / meaningfulCharacters).toFixed(4)) : 0;
  const visualStrength = Number(Math.min(1, .34 + Math.log2(mentionCount + 1) * .13).toFixed(4));
  return {
    id: `ocr-candidate:moe-2022-03:${concept.id}`,
    concept_id: concept.id,
    concept_sense_id: `sense:${concept.id}:undifferentiated`,
    label: concept.label,
    aliases: concept.aliases || [],
    category: concept.category,
    ontology_node_id: null,
    subject: {
      canonical: '语文', entity_kind: 'subject', classification: 'general_curriculum_subject', facet_eligible: true,
      source_label: '语文', facet: '语文', family: '语文', course_family: null, related_subjects: [],
      stable_subject_id: 'subject:bb651061c153bcbb', stable_course_id: null, official_code: 'SB0101',
      authority: 'JY/T 0644—2022', course_variant: null, lineage_family: '语文',
    },
    scope_entity: {
      canonical: '语文', entity_kind: 'subject', classification: 'general_curriculum_subject', facet_eligible: true,
      source_label: '语文', facet: '语文', family: '语文', course_family: null, related_subjects: [],
      stable_subject_id: 'subject:bb651061c153bcbb', stable_course_id: null, official_code: 'SB0101',
      authority: 'JY/T 0644—2022', course_variant: null, lineage_family: '语文',
    },
    course_entity: null,
    visibility_facets: ['语文'],
    visibility_policy: 'direct_subject_facet',
    curriculum_line: {
      id: 'line:moe-2022-03:chinese', subject: '语文', course: null, scope_entity_label: '语文',
      subject_entity_kind: 'subject', subject_classification: 'general_curriculum_subject', stage: '义务教育',
      source_stage: '义务教育', school_type: 'general_education', school_subtype: null, document_type: '课程标准',
      jurisdiction: '中国', issuing_body: '中华人民共和国教育部',
    },
    work_id: 'work:moe-2022-03',
    edition_id: 'edition:moe-2022-03',
    embedded_item_id: null,
    time: { year: 2022, precision: 'year', basis: 'document_issued_year' },
    edition: {
      identity_id: 'edition:moe-2022-03', version_label: '2022年版', preferred_document_id: 'moe-2022-03',
      alternate_document_ids: [], base_edition_year: 2022, revision_year: null, identity_status: 'source_bound_ocr_candidate',
    },
    observation: {
      status: 'ocr_complete_pending_audit', observation_class: 'ocr_candidate_nonsemantic', semantic: false,
      match_type: 'exact_surface', roles: ['unknown'], mention_count: mentionCount,
      local_unique_mention_count: mentionCount, unique_section_count: null, normalized_per_10k: normalized,
      heading_hit: pageHits.some((page) => page.heading_hit), definition_hit: null, common_boilerplate_only: false,
      frequency: {
        numerator: mentionCount, numerator_unit: 'exact_surface_occurrences_in_complete_ocr_candidate',
        denominator: meaningfulCharacters, denominator_unit: 'non_whitespace_ocr_characters', exclusions: [],
        comparability: 'within_edition_descriptive_only', interpretation: null,
      },
      visual_strength: visualStrength, visual_strength_basis: 'within_candidate_display_scaling_not_historical_magnitude',
    },
    evidence_ids: pageHits.map((page) => `ocr-candidate:moe-2022-03:p${page.page}:${concept.id}`),
    coverage: {
      coverage_cell_id: 'ocr-coverage:edition:moe-2022-03', usable_pages: 109, total_pages: 109,
      complete: true, negative_claim_eligible: false,
    },
    claim_policy: {
      display_level: 'candidate_dashed', quotation_allowed: false, semantic_relation_allowed: false,
      historical_superlative_allowed: false, first_appearance_allowed: false, disappearance_allowed: false,
    },
    candidate_page_hits: pageHits,
  };
}

function buildEdges(candidates, baseEpisodes) {
  const edges = [];
  for (const candidate of candidates) {
    const previous = baseEpisodes
      .filter((episode) => episode.concept_id === candidate.concept_id
        && episode.subject?.canonical === '语文'
        && episode.curriculum_line?.school_type === 'general_education'
        && Number(episode.time?.year) < 2022)
      .sort((left, right) => Number(right.time.year) - Number(left.time.year) || right.id.localeCompare(left.id))[0];
    if (!previous) continue;
    edges.push({
      id: `ocr-lineage:${previous.id}:${candidate.id}`,
      source: previous.id,
      target: candidate.id,
      type: 'next_observed',
      mode: 'lineage',
      status: 'ocr_candidate_pending_audit',
      assertion_type: 'next_lexical_observation_in_current_display_layer',
      semantic: false,
      directionality: 'directed_by_observation_year',
      editor_reviewed: false,
      source_evidence_ids: previous.evidence_ids || [],
      target_evidence_ids: candidate.evidence_ids,
      influence_claim_allowed: false,
      claim_boundary: '连接线只表示当前资料层中的下一次词面观察；不表示首次出现、取代、影响、因果或义项连续。',
    });
  }

  const pairCounts = new Map();
  const candidatesByPage = new Map();
  for (const candidate of candidates) {
    for (const hit of candidate.candidate_page_hits) {
      if (!candidatesByPage.has(hit.page)) candidatesByPage.set(hit.page, []);
      candidatesByPage.get(hit.page).push(candidate);
    }
  }
  for (const pageCandidates of candidatesByPage.values()) {
    const ordered = [...pageCandidates].sort((left, right) => left.id.localeCompare(right.id));
    for (let left = 0; left < ordered.length; left += 1) {
      for (let right = left + 1; right < ordered.length; right += 1) {
        const key = `${ordered[left].id}|${ordered[right].id}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }
  const cooccurrence = [...pairCounts.entries()]
    .filter(([, pages]) => pages >= 2)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 60);
  for (const [pair, pageCount] of cooccurrence) {
    const [source, target] = pair.split('|');
    edges.push({
      id: `ocr-cooccurrence:${sha256(pair).slice(0, 16)}`,
      source,
      target,
      type: 'page_cooccurrence',
      mode: 'cross',
      status: 'ocr_candidate_pending_audit',
      assertion_type: 'same_physical_page_surface_cooccurrence',
      semantic: false,
      directionality: 'undirected',
      editor_reviewed: false,
      metric: { shared_page_count: pageCount },
      influence_claim_allowed: false,
      claim_boundary: '连线只表示两个词面在同一 OCR 页共同出现；不表示概念关系、影响或因果。',
    });
  }
  return edges;
}

const args = parseArgs(process.argv.slice(2));
requireValue(args.ocrRoot, '--ocr-root is required');
requireValue(args.observedAt && !Number.isNaN(Date.parse(args.observedAt)), '--observed-at must be an ISO timestamp');
requireValue(args.runStatuses.length > 0, 'At least one --run-status is required');

const projectRoot = resolve(new URL('..', import.meta.url).pathname);
const graphPath = resolve(args.graph || join(projectRoot, 'public/data/concept-evolution.json'));
const catalogPath = resolve(args.catalog || join(projectRoot, 'data/catalog.json'));
const outputPath = resolve(args.output || join(projectRoot, 'public/data/ocr-observation-layer.json'));
const ocrRoot = resolve(args.ocrRoot);
const [graph, catalog, state, ...runStatuses] = await Promise.all([
  readJson(graphPath),
  readJson(catalogPath),
  readJson(join(ocrRoot, 'state.json')),
  ...args.runStatuses.map(readJson),
]);
const catalogById = new Map((catalog.documents || []).map((document) => [document.id, document]));
const document = catalogById.get(state.document_id);
requireValue(document, `Document ${state.document_id} is absent from catalog`);
requireValue(state.document_id === 'moe-2022-03', `Unsupported OCR document: ${state.document_id}`);
requireValue(state.source_sha256 === document.checksum_sha256, 'OCR source SHA does not match catalog');
requireValue(state.page_count === document.page_count, 'OCR page count does not match catalog');
requireValue(Array.isArray(state.completed_pages) && state.completed_pages.length === state.page_count, 'OCR document is incomplete');
requireValue(Object.keys(state.failed_pages || {}).length === 0, 'OCR document has failed pages');

const pages = [];
for (let page = 1; page <= state.page_count; page += 1) {
  requireValue(state.completed_pages[page - 1] === page, `OCR completed page sequence breaks at page ${page}`);
  const markdownPath = join(ocrRoot, 'pages', String(page).padStart(4, '0'), 'content.md');
  const markdown = await readFile(markdownPath);
  requireValue(sha256(markdown) === state.pages[String(page)].content_markdown_sha256, `OCR content hash mismatch at page ${page}`);
  const content = compactText(markdown.toString('utf8'));
  pages.push({ page, content, content_sha256: sha256(markdown), character_count: content.replace(/\s/g, '').length });
}
const meaningfulCharacters = pages.reduce((sum, page) => sum + page.character_count, 0);
  const candidateConcepts = (graph.concepts || []).filter((concept) => (concept.subjects || []).some((subject) => subject === '*' || subject === '语文'));
const candidates = [];
for (const concept of candidateConcepts) {
  const surfaces = [...new Set([concept.label, ...(concept.aliases || [])].filter((surface) => typeof surface === 'string' && surface.length >= 2))];
  const pageHits = pages.flatMap((page) => {
    const surfaceCounts = surfaces.map((surface) => ({ surface, count: exactCount(page.content, surface) })).filter((item) => item.count > 0);
    const mentionCount = surfaceCounts.reduce((sum, item) => sum + item.count, 0);
    if (!mentionCount) return [];
    const headingHit = page.content.split('\n').some((line) => /^#{1,6}\s/.test(line) && surfaces.some((surface) => line.includes(surface)));
    const matchedSurface = surfaceCounts[0].surface;
    const matchOffset = page.content.indexOf(matchedSurface);
    const snippetStart = Math.max(0, matchOffset - 70);
    const snippetEnd = Math.min(page.content.length, matchOffset + matchedSurface.length + 110);
    const snippet = page.content.slice(snippetStart, snippetEnd).replace(/\s+/g, ' ').trim();
    return [{ page: page.page, mention_count: mentionCount, heading_hit: headingHit, matched_surface: matchedSurface, snippet }];
  });
  if (pageHits.length) candidates.push(createCandidateEpisode(concept, pageHits, meaningfulCharacters));
}
candidates.sort((left, right) => left.concept_id.localeCompare(right.concept_id));
const activeProgress = parseActiveProgress(args.activeProgress);
const documents = mergeRunStatusDocuments(runStatuses, catalogById, activeProgress);
const completeDocuments = documents.filter((item) => item.status === 'complete');
const artifact = {
  schema_version: 1,
  artifact_profile: 'curriculum-ocr-observation-layer-v1',
  observed_at: new Date(args.observedAt).toISOString(),
  assertion_boundary: '本层只发布来源绑定且全页完成的 OCR 词面观察和待核全文；不可引用，不进入证据 AI，不支持首次、消失、取代、影响、因果或义项连续等历史判断。',
  source: {
    document_id: state.document_id,
    document_title: document.title,
    source_sha256: state.source_sha256,
    state_sha256: sha256(await readFile(join(ocrRoot, 'state.json'))),
    page_count: state.page_count,
    completed_pages: state.completed_pages.length,
    failed_pages: 0,
    ocr_status: 'ocr_complete_pending_audit',
    citation_allowed: false,
    pipeline: state.configuration,
    run_status_inputs: await Promise.all(args.runStatuses.map(async (path) => ({ filename: basename(path), sha256: sha256(await readFile(path)) }))),
  },
  pipeline_summary: {
    complete_documents: completeDocuments.length,
    complete_pages: completeDocuments.reduce((sum, item) => sum + item.page_count, 0),
    active_documents: documents.filter((item) => item.status === 'active').length,
    total_documents: documents.length,
  },
  documents,
  pages,
  concepts: candidates.map((candidate) => ({
    id: candidate.concept_id,
    label: candidate.label,
    category: candidate.category,
    mention_count: candidate.observation.mention_count,
    page_count: candidate.candidate_page_hits.length,
  })),
  episodes: candidates,
  evidence: candidates.flatMap((candidate) => candidate.candidate_page_hits.map((hit) => ({
    id: `ocr-candidate:moe-2022-03:p${hit.page}:${candidate.concept_id}`,
    document_id: 'moe-2022-03',
    document_title: document.title,
    page_number: hit.page,
    source_locator: `PDF p.${hit.page} · OCR待核`,
    matched_surface: hit.matched_surface,
    snippet: hit.snippet,
    citation_allowed: false,
    observation_class: 'ocr_candidate_nonsemantic',
  }))),
  edges: buildEdges(candidates, graph.episodes || []),
  counts: {
    pages: pages.length,
    meaningful_characters: meaningfulCharacters,
    concept_candidates: candidates.length,
    lineage_edges: 0,
    cooccurrence_edges: 0,
  },
};
artifact.counts.lineage_edges = artifact.edges.filter((edge) => edge.mode === 'lineage').length;
artifact.counts.cooccurrence_edges = artifact.edges.filter((edge) => edge.mode === 'cross').length;
await writeFile(outputPath, `${JSON.stringify(artifact)}\n`, 'utf8');
console.log(JSON.stringify({ output: outputPath, ...artifact.counts, pipeline: artifact.pipeline_summary }, null, 2));
