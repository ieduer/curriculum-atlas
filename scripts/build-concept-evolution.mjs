#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('../', import.meta.url).pathname);
const textRoot = path.join(root, '.cache/text');
const ocrRoot = path.join(root, '.cache/ocr-production');
const outputPath = process.env.CONCEPT_GRAPH_OUTPUT_PATH
  ? path.resolve(root, process.env.CONCEPT_GRAPH_OUTPUT_PATH)
  : path.join(root, 'public/data/concept-evolution.json');
const qualityPath = process.env.CONCEPT_QUALITY_OUTPUT_PATH
  ? path.resolve(root, process.env.CONCEPT_QUALITY_OUTPUT_PATH)
  : path.join(root, 'data/concept-evolution-quality.json');

const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), 'utf8'));
const [catalog, lexicon, queue] = await Promise.all([
  readJson('data/catalog.json'), readJson('data/concept-lexicon.json'), readJson('data/ocr-queue.json'),
]);
const catalogById = new Map(catalog.documents.map((record) => [record.id, record]));
const queueById = new Map(queue.documents.map((record) => [record.id, record]));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function normalizeBlock(value) {
  return String(value || '').replace(/\u0000/g, '').replace(/[ \t]+/g, ' ')
    .replace(/\n+/g, ' ').replace(/\s+([，。；：！？、])/g, '$1').trim();
}

function meaningfulCharacters(value) {
  return (String(value || '').match(/[\p{Script=Han}A-Za-z0-9]/gu) || []).length;
}

function useful(value) {
  const length = meaningfulCharacters(value);
  return value.length >= 24 && value.length <= 2200 && length / Math.max(1, value.length) > .55 && !/^(目\s*录|contents?)$/i.test(value);
}

function yearFor(record) {
  const match = String(record.issued_date || record.published_date || record.version_label || '').match(/(19|20)\d{2}/);
  return match ? Number(match[0]) : null;
}

function effectiveCitationAllowed(record) {
  if (record.citation_allowed === true) return true;
  if (record.citation_allowed === false) return false;
  return ['html', 'catalog', 'pdf_in_zip'].includes(record.file_format) || record.id.startsWith('neea-2019-');
}

function schoolType(record) {
  if (/培智|盲校|聋校|特殊教育/.test(`${record.title || ''}${record.stage || ''}`)) return '特殊教育';
  return '普通教育';
}

function normalizedStage(record) {
  const value = `${record.stage || ''}${record.title || ''}`;
  if (/小学/.test(value)) return '小学';
  if (/初中/.test(value)) return '初中';
  if (/义务教育/.test(value)) return '义务教育';
  if (/高中/.test(value)) return '高中';
  return record.stage || '学段待核';
}

function lineFor(record) {
  const stage = normalizedStage(record);
  const type = record.document_type || '课程文件';
  const school = schoolType(record);
  return { id: sha256(`${school}|${stage}|${type}`).slice(0, 12), stage, school_type: school, document_type: type };
}

function subjectsFor(concept, subject) {
  return concept.subjects.includes('*') || concept.subjects.includes(subject);
}

function surfacesFor(concept) {
  return [...new Set([concept.label, ...(concept.aliases || [])])].sort((left, right) => right.length - left.length || left.localeCompare(right, 'zh-CN'));
}

function matchParagraph(body, subject) {
  const candidates = [];
  for (const concept of lexicon.concepts) {
    if (!subjectsFor(concept, subject)) continue;
    for (const surface of surfacesFor(concept)) {
      let offset = 0;
      while (offset < body.length) {
        const index = body.indexOf(surface, offset);
        if (index < 0) break;
        candidates.push({ concept, surface, start: index, end: index + surface.length });
        offset = index + Math.max(1, surface.length);
      }
    }
  }
  candidates.sort((left, right) => (right.end - right.start) - (left.end - left.start) || left.start - right.start);
  const accepted = [];
  for (const item of candidates) {
    if (accepted.some((other) => item.start < other.end && item.end > other.start)) continue;
    accepted.push(item);
  }
  return accepted.sort((left, right) => left.start - right.start);
}

function excerpt(body, start, length) {
  const left = Math.max(0, start - 72);
  const right = Math.min(body.length, start + length + 168);
  return `${left ? '…' : ''}${body.slice(left, right)}${right < body.length ? '…' : ''}`;
}

async function exists(value) {
  try { await access(value); return true; } catch { return false; }
}

const parsedDocuments = [];
const usableTextDocuments = [];
for (const record of catalog.documents) {
  const textPath = path.join(textRoot, `${record.id}.txt`);
  if (!(await exists(textPath))) continue;
  const raw = await readFile(textPath, 'utf8');
  const pages = raw.split('\f');
  const paragraphs = [];
  let ordinal = 0;
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    for (const candidate of pages[pageIndex].split(/\n\s*\n/)) {
      const body = normalizeBlock(candidate);
      if (!useful(body)) continue;
      ordinal += 1;
      paragraphs.push({ body, ordinal, page_number: pageIndex + 1, body_sha256: sha256(body) });
    }
  }
  const characters = meaningfulCharacters(paragraphs.map((item) => item.body).join(''));
  if (characters < lexicon.matching_policy.minimum_meaningful_document_characters) continue;
  usableTextDocuments.push({ record, pages, paragraphs, characters });
  const year = yearFor(record);
  if (!year) continue;
  parsedDocuments.push({ record, year, pages, paragraphs, characters });
}

const hashDocuments = new Map();
for (const document of parsedDocuments) {
  for (const hash of new Set(document.paragraphs.map((item) => item.body_sha256))) {
    if (!hashDocuments.has(hash)) hashDocuments.set(hash, new Set());
    hashDocuments.get(hash).add(document.record.id);
  }
}
const boilerplateHashes = new Set([...hashDocuments.entries()]
  .filter(([, ids]) => ids.size >= lexicon.matching_policy.common_boilerplate_document_threshold)
  .map(([hash]) => hash));

const evidence = [];
const observations = new Map();
let boilerplateMatchCount = 0;

function observationKey(conceptId, subject, lineId, year) {
  return `${conceptId}\u0000${subject}\u0000${lineId}\u0000${year}`;
}

function addObservation(key, seed, item) {
  if (!observations.has(key)) observations.set(key, { ...seed, evidence_ids: [], mention_count: 0, section_ids: new Set(), document_ids: new Set(), meaningful_characters: 0 });
  const target = observations.get(key);
  target.evidence_ids.push(item.evidence.id);
  target.mention_count += item.mentionCount;
  target.section_ids.add(`${item.evidence.document_id}:${item.evidence.paragraph_ordinal || item.evidence.physical_pdf_page}`);
  target.document_ids.add(item.evidence.document_id);
  target.meaningful_characters += item.documentCharacters || 0;
  evidence.push(item.evidence);
}

for (const document of parsedDocuments) {
  const { record, year, paragraphs, characters, pages } = document;
  const line = lineFor(record);
  const docMatches = new Map();
  for (const paragraph of paragraphs) {
    const matches = matchParagraph(paragraph.body, record.subject);
    const counts = new Map();
    for (const match of matches) {
      if (boilerplateHashes.has(paragraph.body_sha256)) { boilerplateMatchCount += 1; continue; }
      if (!counts.has(match.concept.id)) counts.set(match.concept.id, { concept: match.concept, items: [] });
      counts.get(match.concept.id).items.push(match);
    }
    for (const { concept, items } of counts.values()) {
      if (!docMatches.has(concept.id)) docMatches.set(concept.id, { concept, evidence: [], mentionCount: 0 });
      const target = docMatches.get(concept.id);
      target.mentionCount += items.length;
      if (target.evidence.length < 3) {
        const first = items[0];
        target.evidence.push({ paragraph, first, mentionCount: items.length });
      }
    }
  }
  for (const { concept, evidence: docEvidence, mentionCount } of docMatches.values()) {
    const status = effectiveCitationAllowed(record) ? 'citation_ready' : 'source_text_candidate';
    const key = observationKey(concept.id, record.subject, line.id, year);
    const seed = {
      concept, subject: record.subject, line, year, time_basis: 'document_issued_or_version_year', status,
      version_label: record.version_label || null, preferred_document_id: record.id, usable_pages: pages.filter((page) => meaningfulCharacters(page) >= 24).length,
      total_pages: record.page_count || pages.length, source_complete: Boolean(record.page_count && pages.length >= record.page_count * .95),
    };
    for (let index = 0; index < docEvidence.length; index += 1) {
      const { paragraph, first } = docEvidence[index];
      const evidenceId = `e:${record.id}:p${paragraph.ordinal}:${concept.id}`;
      addObservation(key, seed, {
        mentionCount: index === 0 ? mentionCount : 0,
        documentCharacters: index === 0 ? characters : 0,
        evidence: {
          id: evidenceId, document_id: record.id, document_title: record.title, parent_compendium_id: null,
          physical_pdf_page: paragraph.page_number, printed_page: null, paragraph_ordinal: paragraph.ordinal,
          source_locator: `第${paragraph.page_number}页·段${paragraph.ordinal}`, body_sha256: paragraph.body_sha256,
          scan_image_sha256: null, primary_ocr_sha256: null, witness_sha256: null,
          matched_surface: first.surface, snippet: excerpt(paragraph.body, first.start, first.surface.length), match_type: 'exact_surface',
          evidence_status: status, edition_match_status: 'document_metadata_match', citation_allowed: status === 'citation_ready',
        },
      });
    }
  }
}

const reviewFiles = (await readdir(path.join(root, 'data'))).filter((name) => /^ocr-review-.*\.json$/.test(name));
const reviews = new Map();
for (const file of reviewFiles) {
  const review = await readJson(`data/${file}`);
  for (const page of review.pages || []) reviews.set(`${review.document_id}:${page.physical_page}`, page);
}

for (const [documentId, queueRecord] of queueById) {
  const statePath = path.join(ocrRoot, documentId, 'state.json');
  if (!(await exists(statePath))) continue;
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  for (const pageNumber of state.completed_pages || []) {
    const contentPath = path.join(ocrRoot, documentId, 'pages', String(pageNumber).padStart(4, '0'), 'content.md');
    if (!(await exists(contentPath))) continue;
    const rawBody = await readFile(contentPath, 'utf8');
    const body = normalizeBlock(rawBody);
    const review = reviews.get(`${documentId}:${pageNumber}`);
    const firstHeading = rawBody.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
    if (/目录/.test(firstHeading)) continue;
    if (!review && !/^#{1,3}\s+/.test(firstHeading)) continue;
    const yearMatch = body.slice(0, 1200).match(/(?:^|[^\d])((?:18|19|20)\d{2})(?:\s*年|[）)])/);
    if (!yearMatch) continue;
    const year = Number(yearMatch[1]);
    const record = catalogById.get(documentId) || queueRecord;
    const matches = matchParagraph(body, queueRecord.subject);
    const byConcept = new Map();
    for (const match of matches) {
      if (!byConcept.has(match.concept.id)) byConcept.set(match.concept.id, { concept: match.concept, items: [] });
      byConcept.get(match.concept.id).items.push(match);
    }
    const reviewed = review?.decision === 'human_image_review_pass_non_citation';
    const status = reviewed ? 'verified_non_citation' : review?.decision === 'human_judgment_with_warning' ? 'conflict' : 'ocr_candidate';
    const stage = /蒙学堂/.test(body) ? '蒙学堂' : /小学堂|小学/.test(body) ? '小学' : /中学堂|中学/.test(body) ? '中学' : '篇目学段待核';
    const line = { id: sha256(`历史学制|${stage}|汇编内嵌篇目`).slice(0, 12), stage, school_type: '历史学制', document_type: '汇编内嵌篇目' };
    for (const { concept, items } of byConcept.values()) {
      const key = observationKey(concept.id, queueRecord.subject, line.id, year);
      const pageState = state.pages?.[String(pageNumber)] || {};
      const evidenceId = `e:${documentId}:pdf${pageNumber}:${concept.id}`;
      addObservation(key, {
        concept, subject: queueRecord.subject, line, year, time_basis: 'embedded_item_display_year', status,
        version_label: null, preferred_document_id: documentId, usable_pages: 1, total_pages: 1, source_complete: true,
      }, {
        mentionCount: items.length, documentCharacters: meaningfulCharacters(body),
        evidence: {
          id: evidenceId, document_id: documentId, document_title: record.title, parent_compendium_id: documentId,
          physical_pdf_page: pageNumber, printed_page: review?.printed_page || null, paragraph_ordinal: null,
          source_locator: `PDF物理页 ${pageNumber}`, body_sha256: sha256(body),
          scan_image_sha256: review?.rendered_image_sha256 || pageState.rendered_image_sha256 || null,
          primary_ocr_sha256: review?.primary_ocr_sha256 || pageState.content_markdown_sha256 || null,
          witness_sha256: review?.vision_text_sha256 || null, matched_surface: items[0].surface,
          snippet: excerpt(body, items[0].start, items[0].surface.length), match_type: 'exact_surface',
          evidence_status: status, edition_match_status: review ? 'scan_identity_reviewed_online_version_not_exact' : 'not_matched',
          citation_allowed: false, uncertainty_note: review?.uncertainty_note || 'OCR candidate; exact edition and wording are not released.',
        },
      });
    }
  }
}

const statusRank = { citation_ready: 4, verified_non_citation: 3, source_text_candidate: 2, conflict: 1, ocr_candidate: 0 };
const episodes = [...observations.values()].map((item) => {
  const statuses = item.evidence_ids.map((id) => evidence.find((entry) => entry.id === id)?.evidence_status).filter(Boolean);
  const status = statuses.sort((left, right) => statusRank[right] - statusRank[left])[0] || item.status;
  const rate = item.meaningful_characters ? item.mention_count / item.meaningful_characters * 10000 : null;
  const identity = sha256(`${item.subject}|${item.line.id}|${item.year}|${item.version_label || ''}`).slice(0, 16);
  return {
    id: `concept:${item.concept.id}:${sha256(`${item.subject}|${item.line.id}|${item.year}`).slice(0, 12)}`,
    concept_id: item.concept.id, label: item.concept.label, aliases: item.concept.aliases || [], category: item.concept.category,
    subject: { canonical: item.subject, source_label: item.subject, family: item.subject },
    curriculum_line: item.line,
    time: { year: item.year, precision: 'year', basis: item.time_basis },
    edition: { identity_id: identity, version_label: item.version_label, preferred_document_id: item.preferred_document_id, alternate_document_ids: [...item.document_ids].filter((id) => id !== item.preferred_document_id) },
    observation: {
      status, match_type: 'exact_surface', roles: [item.concept.category], mention_count: item.mention_count,
      unique_section_count: item.section_ids.size, normalized_per_10k: rate === null ? null : Number(rate.toFixed(4)),
      heading_hit: false, definition_hit: false, common_boilerplate_only: false,
    },
    evidence_ids: [...new Set(item.evidence_ids)],
    coverage: { usable_pages: item.usable_pages, total_pages: item.total_pages, complete: item.source_complete, negative_claim_eligible: false },
    claim_policy: {
      display_level: status === 'citation_ready' ? 'solid' : status === 'verified_non_citation' ? 'reviewed_ring' : status === 'conflict' ? 'warning_ring' : 'candidate_dashed',
      quotation_allowed: status === 'citation_ready', historical_superlative_allowed: false,
    },
  };
}).sort((left, right) => left.time.year - right.time.year || left.subject.canonical.localeCompare(right.subject.canonical, 'zh-CN') || left.label.localeCompare(right.label, 'zh-CN'));

const maxRate = new Map();
for (const episode of episodes) maxRate.set(episode.concept_id, Math.max(maxRate.get(episode.concept_id) || 0, episode.observation.normalized_per_10k || 0));
for (const episode of episodes) {
  const maximum = maxRate.get(episode.concept_id) || 1;
  episode.observation.visual_strength = Number((.28 + .72 * Math.sqrt((episode.observation.normalized_per_10k || 0) / maximum)).toFixed(4));
}

const edges = [];
const groups = Map.groupBy(episodes.filter((episode) => episode.observation.status === 'citation_ready'),
  (episode) => `${episode.concept_id}|${episode.subject.canonical}|${episode.curriculum_line.id}`);
for (const group of groups.values()) {
  group.sort((left, right) => left.time.year - right.time.year || left.id.localeCompare(right.id));
  for (let index = 1; index < group.length; index += 1) {
    const source = group[index - 1];
    const target = group[index];
    const sourceRate = source.observation.normalized_per_10k || 0;
    const targetRate = target.observation.normalized_per_10k || 0;
    const ratio = sourceRate ? targetRate / sourceRate : null;
    edges.push({
      id: `edge:${sha256(`${source.id}|${target.id}|next_observed`).slice(0, 16)}`, source: source.id, target: target.id,
      type: 'next_observed', mode: 'lineage', status: 'automatic_observation', editor_reviewed: false,
      metric: { source_per_10k: sourceRate, target_per_10k: targetRate, ratio: ratio === null ? null : Number(ratio.toFixed(4)), interpretation: ratio !== null && ratio >= 1.35 ? 'observed_more_frequently' : ratio !== null && ratio <= .74 ? 'observed_less_frequently' : 'frequency_not_materially_changed' },
      claim_boundary: 'The edge means next observed in the current citation-ready corpus, not legal succession or causal evolution.',
    });
  }
}

const byConceptYear = Map.groupBy(episodes.filter((episode) => episode.observation.status === 'citation_ready'), (episode) => `${episode.concept_id}|${episode.time.year}`);
for (const group of byConceptYear.values()) {
  const subjects = [...new Map(group.map((episode) => [episode.subject.canonical, episode])).values()].sort((a, b) => a.subject.canonical.localeCompare(b.subject.canonical, 'zh-CN'));
  for (let index = 1; index < subjects.length; index += 1) {
    const source = subjects[index - 1];
    const target = subjects[index];
    edges.push({
      id: `edge:${sha256(`${source.id}|${target.id}|co_observed`).slice(0, 16)}`, source: source.id, target: target.id,
      type: 'co_observed', mode: 'cross', status: 'automatic_observation', editor_reviewed: false,
      metric: null, claim_boundary: 'The same exact concept surface is observed across subjects in the same year; no influence or causal relation is asserted.',
    });
  }
}

const citationReadyEvidence = new Set(evidence.filter((item) => item.evidence_status === 'citation_ready' && item.citation_allowed).map((item) => item.id));
const completedOcrPages = [];
for (const document of queue.documents) {
  const statePath = path.join(ocrRoot, document.id, 'state.json');
  if (await exists(statePath)) completedOcrPages.push(...(JSON.parse(await readFile(statePath, 'utf8')).completed_pages || []).map((page) => `${document.id}:${page}`));
}
const inputRevision = sha256(JSON.stringify({ catalog: catalog.generated_at, lexicon, queue: queue.generated_at, episodeIds: episodes.map((item) => item.id), evidenceHashes: evidence.map((item) => item.body_sha256 || item.primary_ocr_sha256) }));
const graph = {
  schema_version: 1,
  build_revision: inputRevision,
  assertion_boundary: '基于当前已核语料的概念观察图；不是完整课程史，不宣称绝对首次、消失、取代或因果演进。',
  coverage: {
    catalog_documents: catalog.documents.length, citation_ready_catalog_documents: catalog.counts?.citation_ready || catalog.documents.filter(effectiveCitationAllowed).length,
    meaningful_citation_ready_documents: usableTextDocuments.filter((item) => effectiveCitationAllowed(item.record)).length,
    year_identified_meaningful_citation_ready_documents: parsedDocuments.filter((item) => effectiveCitationAllowed(item.record)).length,
    meaningful_source_text_documents: usableTextDocuments.length,
    verified_meaningful_characters: usableTextDocuments.filter((item) => effectiveCitationAllowed(item.record)).reduce((sum, item) => sum + item.characters, 0),
    ocr_queue_documents: queue.counts.documents, ocr_queue_pages: queue.counts.pages, ocr_completed_pages: completedOcrPages.length,
    citation_ready_episodes: episodes.filter((item) => item.observation.status === 'citation_ready').length,
    verified_non_citation_episodes: episodes.filter((item) => item.observation.status === 'verified_non_citation').length,
    source_text_candidate_episodes: episodes.filter((item) => item.observation.status === 'source_text_candidate').length,
    ocr_candidate_episodes: episodes.filter((item) => ['ocr_candidate', 'conflict'].includes(item.observation.status)).length,
    concept_count: new Set(episodes.map((item) => item.concept_id)).size,
    subject_count: new Set(episodes.map((item) => item.subject.canonical)).size,
    min_year: Math.min(...episodes.map((item) => item.time.year)), max_year: Math.max(...episodes.map((item) => item.time.year)),
    common_boilerplate_matches_excluded: boilerplateMatchCount,
    complete_historical_coverage: false,
  },
  concepts: lexicon.concepts,
  episodes,
  edges,
  evidence,
};

const checks = [
  { id: 'unique_episode_ids', passed: new Set(episodes.map((item) => item.id)).size === episodes.length },
  { id: 'unique_evidence_ids', passed: new Set(evidence.map((item) => item.id)).size === evidence.length },
  { id: 'solid_has_citation_ready_evidence', passed: episodes.filter((item) => item.claim_policy.display_level === 'solid').every((item) => item.evidence_ids.some((id) => citationReadyEvidence.has(id))) },
  { id: 'non_solid_not_quotable', passed: episodes.filter((item) => item.claim_policy.display_level !== 'solid').every((item) => !item.claim_policy.quotation_allowed) },
  { id: 'all_edges_resolve', passed: edges.every((edge) => episodes.some((item) => item.id === edge.source) && episodes.some((item) => item.id === edge.target)) },
  { id: 'no_negative_historical_claims', passed: episodes.every((item) => !item.coverage.negative_claim_eligible && !item.claim_policy.historical_superlative_allowed) },
];
const quality = {
  schema_version: 1, build_revision: inputRevision, passed: checks.every((item) => item.passed), checks,
  release_boundary: graph.assertion_boundary,
  unresolved: [
    `${queue.counts.pages - completedOcrPages.length} OCR pages remain`,
    'Semantic rename, split, merge and influence edges require editor-reviewed dual-ended evidence.',
    'Source-text candidates remain hollow until paragraph-level citation gates pass.',
  ],
};
if (!quality.passed) throw new Error(`Concept graph quality gates failed: ${JSON.stringify(checks.filter((item) => !item.passed))}`);
await mkdir(path.dirname(outputPath), { recursive: true });
await Promise.all([
  writeFile(`${outputPath}.tmp`, `${JSON.stringify(graph, null, 2)}\n`),
  writeFile(`${qualityPath}.tmp`, `${JSON.stringify(quality, null, 2)}\n`),
]);
await Promise.all([rename(`${outputPath}.tmp`, outputPath), rename(`${qualityPath}.tmp`, qualityPath)]);
console.log(JSON.stringify({ episodes: episodes.length, edges: edges.length, evidence: evidence.length, coverage: graph.coverage }));
