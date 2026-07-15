#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const textRoot = path.join(root, '.cache/text');
const ocrRoot = path.join(root, '.cache/ocr-production');
const outputPath = process.env.CONCEPT_GRAPH_OUTPUT_PATH
  ? path.resolve(root, process.env.CONCEPT_GRAPH_OUTPUT_PATH)
  : path.join(root, 'public/data/concept-evolution.json');
const academicOutputPath = process.env.CONCEPT_ACADEMIC_OUTPUT_PATH
  ? path.resolve(root, process.env.CONCEPT_ACADEMIC_OUTPUT_PATH)
  : path.join(path.dirname(outputPath), `${path.basename(outputPath, '.json')}-academic.json`);
const qualityPath = process.env.CONCEPT_QUALITY_OUTPUT_PATH
  ? path.resolve(root, process.env.CONCEPT_QUALITY_OUTPUT_PATH)
  : path.join(root, 'data/concept-evolution-quality.json');

const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), 'utf8'));
const readOptionalJson = async (relative, fallback) => {
  try { return await readJson(relative); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
};
const [catalog, lexicon, queue, model, ingestManifest] = await Promise.all([
  readJson('data/catalog.json'),
  readJson('data/concept-lexicon.json'),
  readJson('data/ocr-queue.json'),
  readJson('data/concept-model-v2.json'),
  readOptionalJson('data/ingest-manifest.json', { entries: [] }),
]);

if (model.schema_version !== 2) throw new Error('data/concept-model-v2.json must use schema_version 2');

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const sha256Bytes = (value) => createHash('sha256').update(value).digest('hex');
const compactId = (prefix, value, length = 16) => `${prefix}:${sha256(value).slice(0, length)}`;
const inputFingerprints = Object.fromEntries(await Promise.all([
  ['catalog_sha256', 'data/catalog.json'],
  ['queue_sha256', 'data/ocr-queue.json'],
  ['concept_model_sha256', 'data/concept-model-v2.json'],
  ['lexicon_sha256', 'data/concept-lexicon.json'],
  ['builder_sha256', 'scripts/build-concept-evolution.mjs'],
  ['validator_sha256', 'scripts/validate-concept-evolution.mjs'],
].map(async ([key, relativePath]) => [key, sha256Bytes(await readFile(path.join(root, relativePath)))])));
const academicSchema = 'curriculum-concept-evolution-academic-v2';
const catalogById = new Map(catalog.documents.map((record) => [record.id, record]));
const queueById = new Map(queue.documents.map((record) => [record.id, record]));
const ingestById = new Map((ingestManifest.entries || []).map((entry) => [entry.id, entry]));
const conceptById = new Map(lexicon.concepts.map((concept) => [concept.id, concept]));

function normalizeBlock(value) {
  return String(value || '').replace(/\u0000/g, '').replace(/[ \t]+/g, ' ')
    .replace(/\n+/g, ' ').replace(/\s+([，。；：！？、])/g, '$1').trim();
}

function meaningfulCharacters(value) {
  return (String(value || '').match(/[\p{Script=Han}A-Za-z0-9]/gu) || []).length;
}

function useful(value) {
  const length = meaningfulCharacters(value);
  return value.length >= 24 && value.length <= 2200 && length / Math.max(1, value.length) > .55
    && !/^(目\s*录|contents?)$/i.test(value);
}

function excerpt(body, start, length) {
  const left = Math.max(0, start - 72);
  const right = Math.min(body.length, start + length + 168);
  return `${left ? '…' : ''}${body.slice(left, right)}${right < body.length ? '…' : ''}`;
}

async function exists(value) {
  try { await access(value); return true; } catch { return false; }
}

function yearFrom(...values) {
  for (const value of values) {
    const match = String(value || '').match(/(?:18|19|20)\d{2}/);
    if (match) return Number(match[0]);
  }
  return null;
}

function versionYears(record) {
  const label = String(record.version_label || record.title || '');
  const versionMatch = label.match(/((?:18|19|20)\d{2})\s*年?版/);
  const revisionMatch = label.match(/((?:18|19|20)\d{2})\s*年?修订/);
  return {
    base_edition_year: versionMatch ? Number(versionMatch[1]) : null,
    revision_year: revisionMatch ? Number(revisionMatch[1]) : null,
  };
}

function observationTime(record) {
  const years = versionYears(record);
  const issuedYear = yearFrom(record.issued_date);
  const publishedYear = yearFrom(record.published_date);
  if (years.revision_year) return { year: years.revision_year, basis: 'revision_year_in_version_label' };
  if (issuedYear) return { year: issuedYear, basis: 'document_issued_year' };
  if (years.base_edition_year) return { year: years.base_edition_year, basis: 'edition_year_in_version_label' };
  if (publishedYear) return { year: publishedYear, basis: 'document_published_year' };
  const titleYear = yearFrom(record.title);
  return titleYear ? { year: titleYear, basis: 'year_in_document_title' } : { year: null, basis: 'unknown' };
}

function effectiveCitationAllowed(record) {
  if (record.citation_allowed === true) return true;
  if (record.citation_allowed === false) return false;
  return ['html', 'catalog', 'pdf_in_zip'].includes(record.file_format) || record.id.startsWith('neea-2019-');
}

function normalizedStage(record) {
  const value = `${record.stage || ''}${record.title || ''}`;
  if (/义务教育/.test(value)) return '义务教育';
  if (/普通高中|高中/.test(value)) return '高中';
  if (/初中/.test(value)) return '初中';
  if (/小学/.test(value)) return '小学';
  return record.stage || 'unknown';
}

function schoolTypeDetails(record, historical = false) {
  const value = `${record.title || ''}${record.stage || ''}`;
  if (historical) return { school_type: 'historical_school_system', school_subtype: null };
  if (/盲校/.test(value)) return { school_type: 'special_education', school_subtype: 'school_for_the_blind' };
  if (/聋校/.test(value)) return { school_type: 'special_education', school_subtype: 'school_for_the_deaf' };
  if (/培智/.test(value)) return { school_type: 'special_education', school_subtype: 'school_for_students_with_intellectual_disabilities' };
  if (/特殊教育/.test(value)) return { school_type: 'special_education', school_subtype: 'unspecified' };
  return { school_type: 'general_education', school_subtype: null };
}

const facetEntityKinds = new Set(['subject', 'assessment_subject']);
const isFacetEntity = (entity) => facetEntityKinds.has(entity?.entity_kind) && entity?.facet_eligible === true;

function subjectEntity(record) {
  const sourceLabel = record.subject || 'unknown';
  const entry = model.document_entity_overrides?.[record.id] || model.subject_taxonomy?.[sourceLabel];
  if (!entry) {
    return {
      canonical: sourceLabel,
      source_label: sourceLabel,
      entity_kind: 'unclassified',
      classification: 'taxonomy_mapping_missing',
      facet_eligible: false,
      family: null,
      stable_subject_id: null,
      official_code: null,
      authority: null,
    };
  }
  let family = null;
  for (const [candidate, members] of Object.entries(model.subject_families || {})) {
    if (members.includes(entry.canonical) || members.includes(sourceLabel)) { family = candidate; break; }
  }
  let courseFamily = null;
  for (const [candidate, members] of Object.entries(model.course_families || {})) {
    if (members.includes(entry.canonical) || members.includes(sourceLabel)) { courseFamily = candidate; break; }
  }
  const officialCode = ['subject', 'curriculum_course'].includes(entry.entity_kind)
    ? model.official_subject_codes?.[entry.canonical] || null : null;
  const specialExtension = model.special_education_2016_reviewed_extensions?.includes(entry.canonical);
  return {
    ...entry,
    source_label: sourceLabel,
    family,
    course_family: courseFamily,
    related_subjects: model.course_to_subject_links?.[entry.canonical] || model.course_to_subject_links?.[sourceLabel] || [],
    stable_subject_id: entry.stable_subject_id || (isFacetEntity(entry) ? compactId('subject', entry.canonical) : null),
    stable_course_id: entry.stable_course_id || (entry.entity_kind === 'curriculum_course' ? compactId('course', entry.canonical) : null),
    official_code: officialCode,
    authority: officialCode ? 'JY/T 0644—2022' : specialExtension ? '教育部2016三类特殊教育学校义务教育课程标准答问受控扩展' : entry.classification === 'special_education_curriculum_course' ? '课程教材研究所官方目录受控扩展' : 'project_controlled_taxonomy_pending_code_alignment',
    course_variant: entry.course_variant || null,
    lineage_family: entry.lineage_family || family || courseFamily,
  };
}

function subjectsFor(concept, entity) {
  return concept.subjects.includes('*')
    || concept.subjects.includes(entity.canonical)
    || concept.subjects.includes(entity.source_label)
    || entity.related_subjects?.some((subject) => concept.subjects.includes(subject));
}

function episodeSubject(entity) {
  if (isFacetEntity(entity)) return entity;
  return {
    canonical: null,
    source_label: entity.source_label,
    stable_subject_id: null,
    entity_kind: entity.entity_kind,
    classification: entity.classification,
    facet_eligible: false,
    official_code: null,
    authority: entity.authority,
    family: null,
    course_variant: null,
    lineage_family: null,
  };
}

const surfaceForms = [];
const surfaceFormsByConcept = new Map();
for (const concept of lexicon.concepts) {
  const rawForms = [concept.label, ...(concept.aliases || [])];
  for (let index = 0; index < rawForms.length; index += 1) {
    const form = rawForms[index];
    const override = model.surface_form_overrides?.[`${concept.id}::${form}`];
    const canonical = index === 0;
    const surface = {
      id: compactId('surface', `${concept.id}|${form}`),
      concept_id: concept.id,
      form,
      form_type: canonical ? 'canonical_label' : override?.form_type || 'unclassified_alias',
      script: /[\p{Script=Han}]/u.test(form) ? 'Han' : 'mixed_or_other',
      automatic_match_allowed: canonical ? true : override?.automatic_match_allowed === true,
      review_status: canonical ? 'lexicon_canonical_seed' : override?.review_status || 'classification_required',
      valid_from_year: null,
      valid_to_year: null,
      source_evidence_ids: [],
    };
    surfaceForms.push(surface);
    if (!surfaceFormsByConcept.has(concept.id)) surfaceFormsByConcept.set(concept.id, []);
    surfaceFormsByConcept.get(concept.id).push(surface);
  }
}

const automaticSurfaces = surfaceForms.filter((surface) => surface.automatic_match_allowed)
  .sort((left, right) => right.form.length - left.form.length || left.form.localeCompare(right.form, 'zh-CN'));

function matchParagraph(body, entity) {
  const candidates = [];
  for (const surface of automaticSurfaces) {
    const concept = conceptById.get(surface.concept_id);
    if (!concept || !subjectsFor(concept, entity)) continue;
    let offset = 0;
    while (offset < body.length) {
      const start = body.indexOf(surface.form, offset);
      if (start < 0) break;
      candidates.push({ concept, surface, start, end: start + surface.form.length });
      offset = start + Math.max(1, surface.form.length);
    }
  }
  candidates.sort((left, right) => (right.end - right.start) - (left.end - left.start)
    || left.start - right.start || left.surface.id.localeCompare(right.surface.id));
  const accepted = [];
  for (const candidate of candidates) {
    if (accepted.some((item) => candidate.start < item.end && candidate.end > item.start)) continue;
    accepted.push(candidate);
  }
  return accepted.sort((left, right) => left.start - right.start);
}

const rawSubjectLabels = [...new Set([
  ...catalog.documents.map((record) => record.subject),
  ...queue.documents.map((record) => record.subject),
  ...Object.keys(model.subject_taxonomy || {}),
].filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-CN'));

const subjectTaxonomy = rawSubjectLabels.map((sourceLabel) => {
  const classified = subjectEntity({ id: `taxonomy:${sourceLabel}`, subject: sourceLabel });
  return {
    source_label: sourceLabel,
    canonical: classified.canonical,
    stable_subject_id: classified.stable_subject_id,
    stable_course_id: classified.stable_course_id,
    entity_kind: classified.entity_kind,
    classification: classified.classification,
    facet_eligible: classified.facet_eligible,
    official_code: classified.official_code,
    authority: classified.authority,
    family: classified.family,
    course_family: classified.course_family,
    related_subjects: classified.related_subjects,
    course_variant: classified.course_variant,
    lineage_family: classified.lineage_family,
    source_document_count: catalog.documents.filter((record) => record.subject === sourceLabel).length,
    source_queue_document_count: queue.documents.filter((record) => record.subject === sourceLabel).length,
  };
});
const subjectEntityAudit = catalog.documents.map((record) => {
  const entity = subjectEntity(record);
  return {
    document_id: record.id,
    document_title: record.title,
    source_label: entity.source_label,
    canonical: entity.canonical,
    stable_subject_id: entity.stable_subject_id,
    stable_course_id: entity.stable_course_id,
    entity_kind: entity.entity_kind,
    classification: entity.classification,
    facet_eligible: entity.facet_eligible,
    official_code: entity.official_code,
    authority: entity.authority,
    course_variant: entity.course_variant,
    course_family: entity.course_family,
    related_subjects: entity.related_subjects,
    lineage_family: entity.lineage_family,
    mapping_basis: model.document_entity_overrides?.[record.id] ? 'document_entity_override' : 'source_label_taxonomy',
  };
}).sort((left, right) => left.document_id.localeCompare(right.document_id));

const canonicalSubjects = [...new Set(catalog.documents.map(subjectEntity)
  .filter(isFacetEntity)
  .map((entity) => entity.canonical))].sort((left, right) => left.localeCompare(right, 'zh-CN'));

const conceptSenses = [];
const senseByConcept = new Map();
for (const concept of lexicon.concepts) {
  const sense = {
    id: `sense:${concept.id}:undifferentiated`,
    concept_id: concept.id,
    sense_status: 'undifferentiated_unresolved',
    subject_scope: null,
    usage_context_location: 'occurrences_and_episodes',
    definition: null,
    definition_source_evidence_ids: [],
    broader_sense_ids: [],
    narrower_sense_ids: [],
    valid_from_year: null,
    valid_to_year: null,
    review_status: 'undifferentiated_unresolved',
    reviewed_by: null,
    reviewed_at: null,
  };
  conceptSenses.push(sense);
  senseByConcept.set(concept.id, sense);
}

const curriculumLineById = new Map();
function curriculumLineFor(record, entity, historical = false, stageOverride = null) {
  const school = schoolTypeDetails(record, historical);
  const line = {
    id: '',
    subject: isFacetEntity(entity) ? entity.canonical : null,
    course: entity.entity_kind === 'curriculum_course' ? entity.canonical : null,
    scope_entity_label: entity.canonical,
    subject_entity_kind: entity.entity_kind,
    subject_classification: entity.classification,
    stage: stageOverride || normalizedStage(record),
    source_stage: record.stage || null,
    school_type: school.school_type,
    school_subtype: school.school_subtype,
    document_type: historical ? 'embedded_item' : record.document_type || 'unknown',
    jurisdiction: record.country || '中国',
    issuing_body: record.issued_by || null,
  };
  line.id = compactId('line', JSON.stringify(line));
  if (!curriculumLineById.has(line.id)) curriculumLineById.set(line.id, line);
  return curriculumLineById.get(line.id);
}

const worksById = new Map();
const editionsById = new Map();
const revisions = [];
const editionByDocumentId = new Map();
for (const record of catalog.documents) {
  const entity = subjectEntity(record);
  const line = curriculumLineFor(record, entity);
  const workId = `work:${record.id}`;
  const editionId = `edition:${record.id}`;
  const years = versionYears(record);
  const time = observationTime(record);
  const sourceArtifact = ingestById.get(record.id);
  worksById.set(workId, {
    id: workId,
    canonical_title: record.title,
    subject: entity,
    course_entity: entity.entity_kind === 'curriculum_course' ? entity : null,
    curriculum_line_id: line.id,
    issuer: record.issued_by || null,
    jurisdiction: record.country || '中国',
    document_ids: [record.id],
    identity_status: 'document_scoped_not_deduplicated',
    parent_work_id: null,
  });
  const edition = {
    id: editionId,
    work_id: workId,
    curriculum_line_id: line.id,
    document_id: record.id,
    version_label: record.version_label || null,
    base_edition_year: years.base_edition_year,
    revision_year: years.revision_year,
    observation_year: time.year,
    observation_year_basis: time.basis,
    issued_date: record.issued_date || null,
    published_date: record.published_date || null,
    effective_date: null,
    source_artifact_sha256: record.checksum_sha256 || sourceArtifact?.source_sha256 || null,
    identity_status: 'document_scoped_not_deduplicated',
    alternate_document_ids: [],
    embedded_item_id: null,
  };
  editionsById.set(editionId, edition);
  editionByDocumentId.set(record.id, edition);
  if (years.revision_year) {
    revisions.push({
      id: `revision:${record.id}:${years.revision_year}`,
      edition_id: editionId,
      work_id: workId,
      base_edition_year: years.base_edition_year,
      revision_year: years.revision_year,
      revision_label: record.version_label || null,
      relation_status: 'version_label_explicit',
      source_document_id: record.id,
      editor_reviewed: false,
      reviewed_by: null,
      reviewed_at: null,
    });
  }
}

const allTextDocuments = [];
const eligibleDocuments = [];
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
      paragraphs.push({
        body,
        ordinal,
        physical_page: pageIndex + 1,
        body_sha256: sha256(body),
        meaningful_characters: meaningfulCharacters(body),
        text_reuse_cluster_id: null,
      });
    }
  }
  const characters = paragraphs.reduce((sum, paragraph) => sum + paragraph.meaningful_characters, 0);
  const usablePages = pages.filter((page) => meaningfulCharacters(page) >= 24).length;
  const item = { record, entity: subjectEntity(record), pages, paragraphs, characters, usablePages, time: observationTime(record) };
  allTextDocuments.push(item);
  if (characters >= lexicon.matching_policy.minimum_meaningful_document_characters && item.time.year) eligibleDocuments.push(item);
}

const hashDocuments = new Map();
for (const document of eligibleDocuments) {
  for (const hash of new Set(document.paragraphs.map((paragraph) => paragraph.body_sha256))) {
    if (!hashDocuments.has(hash)) hashDocuments.set(hash, new Set());
    hashDocuments.get(hash).add(document.record.id);
  }
}
const textReuseClusters = [];
const reuseClusterByHash = new Map();
for (const [hash, documentIds] of hashDocuments) {
  if (documentIds.size < lexicon.matching_policy.common_boilerplate_document_threshold) continue;
  const cluster = {
    id: compactId('reuse', hash),
    exact_text_sha256: hash,
    document_ids: [...documentIds].sort(),
    document_count: documentIds.size,
    status: 'shared_text_candidate',
    editor_reviewed: false,
  };
  textReuseClusters.push(cluster);
  reuseClusterByHash.set(hash, cluster);
}
for (const document of eligibleDocuments) {
  for (const paragraph of document.paragraphs) {
    paragraph.text_reuse_cluster_id = reuseClusterByHash.get(paragraph.body_sha256)?.id || null;
  }
  document.eligibleCharacters = document.paragraphs
    .filter((paragraph) => !paragraph.text_reuse_cluster_id)
    .reduce((sum, paragraph) => sum + paragraph.meaningful_characters, 0);
}

const coverageCellByEdition = new Map();
for (const record of catalog.documents) {
  const edition = editionByDocumentId.get(record.id);
  const text = allTextDocuments.find((item) => item.record.id === record.id);
  const entity = subjectEntity(record);
  const expectedPages = Number.isInteger(record.page_count) ? record.page_count : null;
  const usablePages = text?.usablePages || 0;
  const complete = expectedPages !== null && expectedPages > 0 && usablePages >= Math.ceil(expectedPages * .95);
  const cell = {
    id: `coverage:${edition.id}`,
    entity_kind: entity.entity_kind,
    subject_id: isFacetEntity(entity) ? entity.stable_subject_id : null,
    canonical_subject: isFacetEntity(entity) ? entity.canonical : null,
    course_entity: entity.entity_kind === 'curriculum_course' ? {
      course_id: entity.stable_course_id,
      canonical_course: entity.canonical,
      course_family: entity.course_family,
      related_subjects: entity.related_subjects,
    } : null,
    scope_entity: {
      entity_kind: entity.entity_kind,
      canonical_label: entity.canonical,
      source_label: entity.source_label,
      classification: entity.classification,
    },
    curriculum_line_id: edition.curriculum_line_id,
    work_id: edition.work_id,
    edition_id: edition.id,
    embedded_item_id: null,
    expected_pages: expectedPages,
    usable_pages: usablePages,
    meaningful_characters: text?.characters || 0,
    eligible_meaningful_characters: text?.eligibleCharacters ?? 0,
    complete,
    alias_search_complete: false,
    lexical_search_scope: 'automatic_surface_forms_only',
    citation_gate: effectiveCitationAllowed(record) ? 'document_policy_allows_paragraph_candidates' : 'document_policy_blocks_quotation',
    negative_claim_eligible: false,
    missing_reasons: [
      ...(text ? [] : ['source_text_unavailable']),
      ...(expectedPages === null ? ['expected_page_count_unknown'] : []),
      ...(!complete ? ['full_document_coverage_not_established'] : []),
      'semantic_surface_review_incomplete',
    ],
  };
  coverageCellByEdition.set(edition.id, cell);
}

const evidence = [];
const evidenceById = new Map();
const occurrences = [];
const occurrenceById = new Map();
const observationGroups = new Map();

function observationKey(conceptId, senseId, lineId, editionId, year) {
  return [conceptId, senseId, lineId, editionId, year].join('|');
}

function ensureObservation(seed) {
  const key = observationKey(seed.concept.id, seed.sense.id, seed.line.id, seed.edition.id, seed.year);
  if (!observationGroups.has(key)) {
    observationGroups.set(key, {
      ...seed,
      evidence_ids: new Set(),
      occurrence_ids: [],
      surface_form_ids: new Set(),
      mention_count: 0,
      local_unique_mention_count: 0,
    });
  }
  return observationGroups.get(key);
}

function registerEvidence(item) {
  if (evidenceById.has(item.id)) throw new Error(`duplicate evidence id ${item.id}`);
  evidence.push(item);
  evidenceById.set(item.id, item);
}

function registerOccurrence(item) {
  if (occurrenceById.has(item.id)) throw new Error(`duplicate occurrence id ${item.id}`);
  occurrences.push(item);
  occurrenceById.set(item.id, item);
}

for (const document of eligibleDocuments) {
  const { record, entity, paragraphs, time } = document;
  const edition = editionByDocumentId.get(record.id);
  const work = worksById.get(edition.work_id);
  const line = curriculumLineById.get(edition.curriculum_line_id);
  const coverageCell = coverageCellByEdition.get(edition.id);
  const status = effectiveCitationAllowed(record) ? 'citation_ready' : 'source_text_candidate';
  for (const paragraph of paragraphs) {
    const matches = matchParagraph(paragraph.body, entity);
    const matchesByConcept = Map.groupBy(matches, (match) => match.concept.id);
    for (const [conceptId, conceptMatches] of matchesByConcept) {
      const concept = conceptById.get(conceptId);
      const sense = senseByConcept.get(conceptId);
      if (!sense) throw new Error(`missing undifferentiated concept sense for ${conceptId}`);
      const evidenceId = `e:${record.id}:p${paragraph.ordinal}:${conceptId}`;
      const occurrenceIds = [];
      for (const match of conceptMatches) {
        const occurrence = {
          id: compactId('occ', `${record.id}|${paragraph.ordinal}|${match.start}|${match.surface.id}`),
          concept_id: conceptId,
          concept_sense_id: sense.id,
          surface_form_id: match.surface.id,
          curriculum_line_id: line.id,
          work_id: work.id,
          edition_id: edition.id,
          embedded_item_id: null,
          evidence_id: evidenceId,
          document_id: record.id,
          year: time.year,
          position: { physical_page: paragraph.physical_page, paragraph_ordinal: paragraph.ordinal, start: match.start, end: match.end },
          section_context: { chapter_path: null, section_heading: null, section_type: 'unknown', normative_role: 'unknown' },
          match_type: 'exact_surface',
          text_reuse_cluster_id: paragraph.text_reuse_cluster_id,
          status,
        };
        registerOccurrence(occurrence);
        occurrenceIds.push(occurrence.id);
      }
      const first = conceptMatches[0];
      const citationAllowed = status === 'citation_ready';
      registerEvidence({
        id: evidenceId,
        concept_id: conceptId,
        concept_sense_id: sense.id,
        surface_form_ids: [...new Set(conceptMatches.map((match) => match.surface.id))],
        occurrence_ids: occurrenceIds,
        document_id: record.id,
        document_title: record.title,
        work_id: work.id,
        edition_id: edition.id,
        embedded_item_id: null,
        parent_compendium_id: null,
        physical_pdf_page: paragraph.physical_page,
        printed_page: null,
        paragraph_ordinal: paragraph.ordinal,
        source_locator: `第${paragraph.physical_page}页·段${paragraph.ordinal}`,
        body_sha256: paragraph.body_sha256,
        source_artifact_sha256: edition.source_artifact_sha256,
        scan_image_sha256: null,
        primary_ocr_sha256: null,
        witness_sha256: null,
        extraction_engine: record.text_quality_status === 'official_native_text' ? 'native_pdf_text' : null,
        matched_surface: first.surface.form,
        match_offsets: conceptMatches.map((match) => ({ surface_form_id: match.surface.id, start: match.start, end: match.end })),
        snippet: excerpt(paragraph.body, first.start, first.surface.form.length),
        match_type: 'exact_surface',
        section_context: { chapter_path: null, section_heading: null, section_type: 'unknown', normative_role: 'unknown' },
        text_reuse_cluster_id: paragraph.text_reuse_cluster_id,
        evidence_status: status,
        edition_match_status: 'catalog_document_identity_only',
        online_verification_id: null,
        citation_gate: {
          document_allowed: citationAllowed,
          paragraph_allowed: citationAllowed,
          basis: 'corpus_import_policy_document_status_propagated',
        },
        citation_allowed: citationAllowed,
        uncertainty_note: citationAllowed ? null : 'Document-level citation gate is closed; lexical observation is non-quotable.',
      });
      const observation = ensureObservation({
        concept, sense, subject: episodeSubject(entity), scope_entity: entity, line, work, edition, embedded_item_id: null,
        year: time.year, time_basis: time.basis, status, coverageCell,
      });
      observation.evidence_ids.add(evidenceId);
      observation.occurrence_ids.push(...occurrenceIds);
      for (const match of conceptMatches) observation.surface_form_ids.add(match.surface.id);
      observation.mention_count += conceptMatches.length;
      if (!paragraph.text_reuse_cluster_id) observation.local_unique_mention_count += conceptMatches.length;
    }
  }
}

const reviewFiles = (await readdir(path.join(root, 'data'))).filter((name) => /^ocr-review-.*\.json$/.test(name));
const reviewByPage = new Map();
for (const file of reviewFiles) {
  const reviewFile = await readJson(`data/${file}`);
  for (const page of reviewFile.pages || []) {
    reviewByPage.set(`${reviewFile.document_id}:${page.physical_page}`, {
      page,
      engines: reviewFile.engines || {},
      online_evidence_count: (reviewFile.online_evidence || []).length,
    });
  }
}

const embeddedItems = [];
for (const [documentId, queueRecord] of queueById) {
  const statePath = path.join(ocrRoot, documentId, 'state.json');
  if (!(await exists(statePath))) continue;
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  for (const rawPageNumber of state.completed_pages || []) {
    const pageNumber = Number(rawPageNumber);
    const contentPath = path.join(ocrRoot, documentId, 'pages', String(pageNumber).padStart(4, '0'), 'content.md');
    if (!(await exists(contentPath))) continue;
    const rawBody = await readFile(contentPath, 'utf8');
    const body = normalizeBlock(rawBody);
    const reviewEntry = reviewByPage.get(`${documentId}:${pageNumber}`);
    const review = reviewEntry?.page;
    const firstLine = rawBody.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
    if (/目录/.test(firstLine)) continue;
    if (!review && !/^#{1,3}\s+/.test(firstLine)) continue;
    const yearMatch = body.slice(0, 1200).match(/(?:^|[^\d])((?:18|19|20)\d{2})(?:\s*年|[）)])/);
    if (!yearMatch) continue;
    const year = Number(yearMatch[1]);
    const parentRecord = catalogById.get(documentId) || queueRecord;
    const entity = subjectEntity(parentRecord);
    const title = review?.entity || firstLine.replace(/^#{1,6}\s*/, '') || `第${pageNumber}页篇目`;
    const stage = /蒙学堂/.test(body) ? '蒙学堂' : /小学堂|小学/.test(body) ? '小学' : /中学堂|中学/.test(body) ? '中学' : 'unknown';
    const line = curriculumLineFor({ ...parentRecord, title, stage, document_type: 'embedded_item' }, entity, true, stage);
    const embeddedItemId = `embedded:${documentId}:p${pageNumber}`;
    const workId = `work:${embeddedItemId}`;
    const editionId = `edition:${embeddedItemId}`;
    const parentEdition = editionByDocumentId.get(documentId);
    const parentWorkId = parentEdition?.work_id || null;
    const embeddedItem = {
      id: embeddedItemId,
      parent_document_id: documentId,
      parent_work_id: parentWorkId,
      title,
      identity_status: review ? 'reviewed_page_fragment_not_full_item' : 'ocr_heading_page_fragment_candidate',
      physical_page_start: pageNumber,
      physical_page_end: pageNumber,
      printed_page: review?.printed_page || null,
      display_year: year,
      year_basis: 'display_year_observed_in_page_fragment',
      stage,
      uncertainty_note: review?.uncertainty_note || 'Page-fragment boundary and exact edition identity are not editor-verified.',
    };
    embeddedItems.push(embeddedItem);
    worksById.set(workId, {
      id: workId,
      canonical_title: title,
      subject: entity,
      course_entity: entity.entity_kind === 'curriculum_course' ? entity : null,
      curriculum_line_id: line.id,
      issuer: null,
      jurisdiction: parentRecord.country || '中国',
      document_ids: [documentId],
      identity_status: 'embedded_page_fragment_not_deduplicated',
      parent_work_id: parentWorkId,
    });
    const edition = {
      id: editionId,
      work_id: workId,
      curriculum_line_id: line.id,
      document_id: documentId,
      version_label: null,
      base_edition_year: year,
      revision_year: null,
      observation_year: year,
      observation_year_basis: 'embedded_item_display_year',
      issued_date: null,
      published_date: null,
      effective_date: null,
      source_artifact_sha256: queueRecord.source_sha256 || parentRecord.checksum_sha256 || null,
      identity_status: 'embedded_page_fragment_not_full_edition',
      alternate_document_ids: [],
      embedded_item_id: embeddedItemId,
    };
    editionsById.set(editionId, edition);
    const pageCharacters = meaningfulCharacters(body);
    const coverageCell = {
      id: `coverage:${editionId}`,
      entity_kind: entity.entity_kind,
      subject_id: isFacetEntity(entity) ? entity.stable_subject_id : null,
      canonical_subject: isFacetEntity(entity) ? entity.canonical : null,
      course_entity: entity.entity_kind === 'curriculum_course' ? {
        course_id: entity.stable_course_id,
        canonical_course: entity.canonical,
        course_family: entity.course_family,
        related_subjects: entity.related_subjects,
      } : null,
      scope_entity: {
        entity_kind: entity.entity_kind,
        canonical_label: entity.canonical,
        source_label: entity.source_label,
        classification: entity.classification,
      },
      curriculum_line_id: line.id,
      work_id: workId,
      edition_id: editionId,
      embedded_item_id: embeddedItemId,
      expected_pages: null,
      usable_pages: 1,
      meaningful_characters: pageCharacters,
      eligible_meaningful_characters: pageCharacters,
      complete: false,
      alias_search_complete: false,
      lexical_search_scope: 'automatic_surface_forms_only',
      citation_gate: 'ocr_page_fragment_non_quotable',
      negative_claim_eligible: false,
      missing_reasons: ['full_embedded_item_boundary_not_established', 'exact_edition_online_text_not_established', 'semantic_surface_review_incomplete'],
    };
    coverageCellByEdition.set(editionId, coverageCell);
    const matches = matchParagraph(body, entity);
    const matchesByConcept = Map.groupBy(matches, (match) => match.concept.id);
    const reviewed = review?.decision === 'human_image_review_pass_non_citation';
    const status = reviewed ? 'verified_non_citation'
      : review?.decision === 'human_judgment_with_warning' ? 'conflict' : 'ocr_candidate';
    const pageState = state.pages?.[String(pageNumber)] || {};
    for (const [conceptId, conceptMatches] of matchesByConcept) {
      const concept = conceptById.get(conceptId);
      const sense = senseByConcept.get(conceptId);
      if (!sense) throw new Error(`missing undifferentiated concept sense for ${conceptId}`);
      const evidenceId = `e:${documentId}:pdf${pageNumber}:${conceptId}`;
      const occurrenceIds = [];
      for (const match of conceptMatches) {
        const occurrence = {
          id: compactId('occ', `${documentId}|pdf${pageNumber}|${match.start}|${match.surface.id}`),
          concept_id: conceptId,
          concept_sense_id: sense.id,
          surface_form_id: match.surface.id,
          curriculum_line_id: line.id,
          work_id: workId,
          edition_id: editionId,
          embedded_item_id: embeddedItemId,
          evidence_id: evidenceId,
          document_id: documentId,
          year,
          position: { physical_page: pageNumber, paragraph_ordinal: null, start: match.start, end: match.end },
          section_context: { chapter_path: null, section_heading: null, section_type: 'unknown', normative_role: 'unknown' },
          match_type: 'exact_surface',
          text_reuse_cluster_id: null,
          status,
        };
        registerOccurrence(occurrence);
        occurrenceIds.push(occurrence.id);
      }
      const first = conceptMatches[0];
      registerEvidence({
        id: evidenceId,
        concept_id: conceptId,
        concept_sense_id: sense.id,
        surface_form_ids: [...new Set(conceptMatches.map((match) => match.surface.id))],
        occurrence_ids: occurrenceIds,
        document_id: documentId,
        document_title: parentRecord.title,
        work_id: workId,
        edition_id: editionId,
        embedded_item_id: embeddedItemId,
        parent_compendium_id: documentId,
        physical_pdf_page: pageNumber,
        printed_page: review?.printed_page || null,
        paragraph_ordinal: null,
        source_locator: `PDF物理页 ${pageNumber}`,
        body_sha256: sha256(body),
        source_artifact_sha256: edition.source_artifact_sha256,
        scan_image_sha256: review?.rendered_image_sha256 || pageState.rendered_image_sha256 || null,
        primary_ocr_sha256: review?.primary_ocr_sha256 || pageState.content_markdown_sha256 || null,
        witness_sha256: review?.vision_text_sha256 || null,
        extraction_engine: reviewEntry?.engines?.primary || null,
        matched_surface: first.surface.form,
        match_offsets: conceptMatches.map((match) => ({ surface_form_id: match.surface.id, start: match.start, end: match.end })),
        snippet: excerpt(body, first.start, first.surface.form.length),
        match_type: 'exact_surface',
        section_context: { chapter_path: null, section_heading: null, section_type: 'unknown', normative_role: 'unknown' },
        text_reuse_cluster_id: null,
        evidence_status: status,
        edition_match_status: review ? 'scan_identity_reviewed_online_version_not_exact' : 'not_assessed',
        online_verification_id: null,
        online_stable_fact_witness_count: reviewEntry?.online_evidence_count || 0,
        citation_gate: { document_allowed: false, paragraph_allowed: false, basis: 'ocr_page_fragment_fail_closed' },
        citation_allowed: false,
        uncertainty_note: review?.uncertainty_note || 'OCR candidate; exact edition and wording are not released.',
      });
      const observation = ensureObservation({
        concept, sense, subject: episodeSubject(entity), scope_entity: entity, line, work: worksById.get(workId), edition, embedded_item_id: embeddedItemId,
        year, time_basis: 'embedded_item_display_year', status, coverageCell,
      });
      observation.evidence_ids.add(evidenceId);
      observation.occurrence_ids.push(...occurrenceIds);
      for (const match of conceptMatches) observation.surface_form_ids.add(match.surface.id);
      observation.mention_count += conceptMatches.length;
      observation.local_unique_mention_count += conceptMatches.length;
    }
  }
}

const statusRank = { citation_ready: 4, verified_non_citation: 3, source_text_candidate: 2, conflict: 1, ocr_candidate: 0 };
const episodes = [...observationGroups.values()].map((item) => {
  const evidenceStatuses = [...item.evidence_ids].map((id) => evidenceById.get(id)?.evidence_status).filter(Boolean);
  const status = evidenceStatuses.sort((left, right) => statusRank[right] - statusRank[left])[0] || item.status;
  const denominator = item.coverageCell.eligible_meaningful_characters;
  const rate = denominator > 0 ? item.local_unique_mention_count / denominator * 10000 : null;
  return {
    id: compactId('concept', `${item.sense.id}|${item.line.id}|${item.edition.id}|${item.year}`),
    concept_id: item.concept.id,
    concept_sense_id: item.sense.id,
    label: item.concept.label,
    aliases: item.concept.aliases || [],
    category: item.concept.category,
    subject: item.subject,
    scope_entity: item.scope_entity,
    course_entity: item.scope_entity.entity_kind === 'curriculum_course' ? item.scope_entity : null,
    curriculum_line: item.line,
    work_id: item.work.id,
    edition_id: item.edition.id,
    embedded_item_id: item.embedded_item_id,
    time: { year: item.year, precision: 'year', basis: item.time_basis },
    edition: {
      identity_id: item.edition.id,
      version_label: item.edition.version_label,
      preferred_document_id: item.edition.document_id,
      alternate_document_ids: item.edition.alternate_document_ids,
      base_edition_year: item.edition.base_edition_year,
      revision_year: item.edition.revision_year,
      identity_status: item.edition.identity_status,
    },
    observation: {
      status,
      match_type: 'exact_surface',
      roles: ['unknown'],
      mention_count: item.mention_count,
      local_unique_mention_count: item.local_unique_mention_count,
      unique_section_count: null,
      normalized_per_10k: rate === null ? null : Number(rate.toFixed(4)),
      heading_hit: null,
      definition_hit: null,
      common_boilerplate_only: item.mention_count > 0 && item.local_unique_mention_count === 0,
      frequency: {
        numerator: item.local_unique_mention_count,
        numerator_unit: 'exact_surface_occurrences_excluding_shared_text_candidates',
        denominator,
        denominator_unit: 'eligible_meaningful_characters',
        exclusions: ['exact_text_reuse_clusters_across_threshold_documents'],
        comparability: 'within_edition_descriptive_only',
        interpretation: null,
      },
    },
    occurrence_ids: item.occurrence_ids,
    surface_form_ids: [...item.surface_form_ids],
    evidence_ids: [...item.evidence_ids],
    coverage: {
      coverage_cell_id: item.coverageCell.id,
      usable_pages: item.coverageCell.usable_pages,
      total_pages: item.coverageCell.expected_pages,
      complete: item.coverageCell.complete,
      negative_claim_eligible: false,
    },
    claim_policy: {
      display_level: status === 'citation_ready' ? 'solid'
        : status === 'verified_non_citation' ? 'reviewed_ring'
          : status === 'conflict' ? 'warning_ring' : 'candidate_dashed',
      quotation_allowed: status === 'citation_ready',
      historical_superlative_allowed: false,
      first_appearance_allowed: false,
      disappearance_allowed: false,
    },
  };
}).sort((left, right) => left.time.year - right.time.year
  || String(left.subject.canonical || left.scope_entity.canonical || '').localeCompare(String(right.subject.canonical || right.scope_entity.canonical || ''), 'zh-CN')
  || left.label.localeCompare(right.label, 'zh-CN')
  || left.id.localeCompare(right.id));

const maxRateByConcept = new Map();
for (const episode of episodes) {
  maxRateByConcept.set(episode.concept_id, Math.max(maxRateByConcept.get(episode.concept_id) || 0, episode.observation.normalized_per_10k || 0));
}
for (const episode of episodes) {
  const maximum = maxRateByConcept.get(episode.concept_id) || 1;
  const relative = (episode.observation.normalized_per_10k || 0) / maximum;
  episode.observation.visual_strength = Number((.28 + .72 * Math.sqrt(relative)).toFixed(4));
  episode.observation.visual_strength_basis = 'within_concept_display_scaling_not_historical_magnitude';
}

const relations = [];
const relationReviews = [];
function registerRelation(relation, rationale) {
  const reviewId = `relation-review:${relation.id.slice('relation:'.length)}`;
  relation.relation_review_id = reviewId;
  relations.push(relation);
  relationReviews.push({
    id: reviewId,
    relation_id: relation.id,
    review_status: 'automatic_nonsemantic_observation',
    reviewer: null,
    reviewed_at: null,
    rationale,
    source_evidence_ids: relation.source_evidence_ids,
    target_evidence_ids: relation.target_evidence_ids,
    influence_claim_allowed: false,
  });
}

const citationEpisodes = episodes.filter((episode) => episode.observation.status === 'citation_ready');
const lineageGroups = Map.groupBy(citationEpisodes,
  (episode) => `${episode.concept_sense_id}|${episode.subject.canonical}|${episode.curriculum_line.id}`);
for (const group of lineageGroups.values()) {
  const yearGroups = Map.groupBy(group, (episode) => episode.time.year);
  const unambiguous = [...yearGroups.entries()].filter(([, yearGroup]) => yearGroup.length === 1)
    .map(([, yearGroup]) => yearGroup[0]).sort((left, right) => left.time.year - right.time.year);
  for (let index = 1; index < unambiguous.length; index += 1) {
    const source = unambiguous[index - 1];
    const target = unambiguous[index];
    if (target.time.year <= source.time.year) continue;
    const id = compactId('relation', `${source.id}|${target.id}|next_observed`);
    registerRelation({
      id,
      source: source.id,
      target: target.id,
      type: 'next_observed',
      mode: 'lineage',
      status: 'automatic_nonsemantic_observation',
      assertion_type: 'next_lexical_observation_in_current_corpus',
      semantic: false,
      directionality: 'directed_by_observation_year',
      editor_reviewed: false,
      reviewed_by: null,
      reviewed_at: null,
      source_evidence_ids: source.evidence_ids,
      target_evidence_ids: target.evidence_ids,
      metric: {
        source_per_10k: source.observation.normalized_per_10k,
        target_per_10k: target.observation.normalized_per_10k,
        ratio: null,
        interpretation: null,
        comparability: 'cross_edition_comparability_not_established',
      },
      influence_claim_allowed: false,
      claim_boundary: 'The edge means next observed in the current citation-ready corpus, not first appearance, legal succession, semantic continuity, replacement, or causal evolution.',
    }, 'Generated only between unambiguous consecutive-year lexical observations in one concept sense, subject, and curriculum line.');
  }
}

const coObservedGroups = Map.groupBy(citationEpisodes.filter((episode) => episode.subject.facet_eligible === true), (episode) => `${episode.concept_id}|${episode.time.year}`);
for (const group of coObservedGroups.values()) {
  const bySubject = Map.groupBy(group, (episode) => episode.subject.canonical);
  const representatives = [...bySubject.values()].filter((subjectGroup) => subjectGroup.length === 1)
    .map((subjectGroup) => subjectGroup[0]).sort((left, right) => left.subject.canonical.localeCompare(right.subject.canonical, 'zh-CN'));
  for (let index = 1; index < representatives.length; index += 1) {
    const source = representatives[index - 1];
    const target = representatives[index];
    const id = compactId('relation', `${source.id}|${target.id}|co_observed`);
    registerRelation({
      id,
      source: source.id,
      target: target.id,
      type: 'co_observed',
      mode: 'cross',
      status: 'automatic_nonsemantic_observation',
      assertion_type: 'same_lexical_concept_observed_in_same_year',
      semantic: false,
      directionality: 'symmetric',
      topology: 'display_chain_not_directional',
      editor_reviewed: false,
      reviewed_by: null,
      reviewed_at: null,
      source_evidence_ids: source.evidence_ids,
      target_evidence_ids: target.evidence_ids,
      metric: null,
      influence_claim_allowed: false,
      claim_boundary: 'The same lexical concept is observed across subjects in the same year; the display chain asserts no direction, transfer, influence, or causal relation.',
    }, 'Generated as a symmetric, nonsemantic co-observation with independently resolvable evidence at both endpoints.');
  }
}

const completedOcrPages = [];
for (const document of queue.documents) {
  const statePath = path.join(ocrRoot, document.id, 'state.json');
  if (!(await exists(statePath))) continue;
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  for (const page of state.completed_pages || []) completedOcrPages.push(`${document.id}:${page}`);
}

const years = episodes.map((episode) => episode.time.year);
const inputRevision = sha256(JSON.stringify({
  catalog_generated_at: catalog.generated_at,
  lexicon,
  model,
  queue_generated_at: queue.generated_at,
  completed_ocr_pages: completedOcrPages.sort(),
  evidence_hashes: evidence.map((item) => [item.id, item.body_sha256, item.primary_ocr_sha256]),
}));

const concepts = lexicon.concepts.map((concept) => ({
  ...concept,
  surface_form_ids: (surfaceFormsByConcept.get(concept.id) || []).map((surface) => surface.id),
  concept_sense_ids: conceptSenses.filter((sense) => sense.concept_id === concept.id).map((sense) => sense.id),
}));
const coverageCells = [...coverageCellByEdition.values()].sort((left, right) => left.id.localeCompare(right.id));
const editorialAudit = [
  {
    id: 'audit:automatic-lexical-build-v2',
    audit_type: 'automated_build',
    actor: 'scripts/build-concept-evolution.mjs',
    performed_at: null,
    status: 'machine_generated_requires_editorial_interpretation',
    assertion_boundary: 'Exact surface occurrence is not proof of concept-sense continuity or normative role.',
  },
  {
    id: 'audit:no-negative-history-claims',
    audit_type: 'claim_policy',
    actor: 'data/concept-model-v2.json',
    performed_at: null,
    status: 'enforced',
    assertion_boundary: 'First appearance, disappearance, replacement, influence, and historical superlatives are disabled.',
  },
  {
    id: 'audit:subject-facet-taxonomy',
    audit_type: 'facet_policy',
    actor: 'data/concept-model-v2.json',
    performed_at: null,
    status: 'enforced',
    assertion_boundary: 'Only controlled subject or assessment-subject entries with facet_eligible=true may enter the subject facet; curriculum courses remain separately identified course entities.',
  },
];

const academicGraph = {
  schema_version: 2,
  academic_schema_version: 2,
  artifact_profile: 'curriculum-concept-evolution-academic-v2',
  academic_schema: academicSchema,
  model_kind: model.model_name,
  build_revision: inputRevision,
  input_fingerprints: inputFingerprints,
  assertion_boundary: '基于当前可用语料的词面概念观察图；不是完整课程史，不宣称概念义项连续、绝对首次、消失、取代、影响或因果演进。',
  coverage: {
    catalog_documents: catalog.documents.length,
    citation_ready_catalog_documents: catalog.counts?.citation_ready || catalog.documents.filter(effectiveCitationAllowed).length,
    meaningful_citation_ready_documents: eligibleDocuments.filter((item) => effectiveCitationAllowed(item.record)).length,
    year_identified_meaningful_citation_ready_documents: eligibleDocuments.filter((item) => effectiveCitationAllowed(item.record)).length,
    meaningful_source_text_documents: eligibleDocuments.length,
    verified_meaningful_characters: eligibleDocuments.filter((item) => effectiveCitationAllowed(item.record)).reduce((sum, item) => sum + item.characters, 0),
    ocr_queue_documents: queue.counts.documents,
    ocr_queue_pages: queue.counts.pages,
    ocr_completed_pages: completedOcrPages.length,
    citation_ready_episodes: episodes.filter((item) => item.observation.status === 'citation_ready').length,
    verified_non_citation_episodes: episodes.filter((item) => item.observation.status === 'verified_non_citation').length,
    source_text_candidate_episodes: episodes.filter((item) => item.observation.status === 'source_text_candidate').length,
    ocr_candidate_episodes: episodes.filter((item) => ['ocr_candidate', 'conflict'].includes(item.observation.status)).length,
    concept_count: new Set(episodes.map((item) => item.concept_id)).size,
    subject_count: new Set(episodes.map((item) => item.subject.canonical).filter(Boolean)).size,
    min_year: years.length ? Math.min(...years) : null,
    max_year: years.length ? Math.max(...years) : null,
    common_boilerplate_matches_marked: occurrences.filter((item) => item.text_reuse_cluster_id).length,
    complete_historical_coverage: false,
    negative_claim_eligible: false,
  },
  subject_taxonomy: subjectTaxonomy,
  subject_entity_audit: subjectEntityAudit,
  taxonomy_provenance: model.taxonomy_provenance,
  taxonomy_decision_rules: model.taxonomy_decision_rules,
  course_families: model.course_families,
  course_to_subject_links: model.course_to_subject_links,
  subject_facets: canonicalSubjects,
  concepts,
  concept_senses: conceptSenses,
  surface_forms: surfaceForms,
  curriculum_lines: [...curriculumLineById.values()].sort((left, right) => left.id.localeCompare(right.id)),
  works: [...worksById.values()].sort((left, right) => left.id.localeCompare(right.id)),
  editions: [...editionsById.values()].sort((left, right) => left.id.localeCompare(right.id)),
  revisions: revisions.sort((left, right) => left.id.localeCompare(right.id)),
  embedded_items: embeddedItems.sort((left, right) => left.id.localeCompare(right.id)),
  text_reuse_clusters: textReuseClusters.sort((left, right) => left.id.localeCompare(right.id)),
  occurrences,
  episodes,
  relations,
  relation_reviews: relationReviews,
  edges: relations,
  evidence,
  coverage_cells: coverageCells,
  editorial_audit: editorialAudit,
};

const academicPayload = `${JSON.stringify(academicGraph, null, 2)}\n`;
const academicSha256 = sha256(academicPayload);
const coreEpisodes = episodes.map((episode) => {
  const { occurrence_ids: occurrenceIds, surface_form_ids: surfaceFormIds, ...coreEpisode } = episode;
  return {
    ...coreEpisode,
    academic_episode_id: episode.id,
    evidence_ids: episode.evidence_ids.slice(0, 1),
    academic_counts: { occurrences: occurrenceIds.length, surface_forms: surfaceFormIds.length, evidence: episode.evidence_ids.length },
  };
});
const coreEpisodeById = new Map(coreEpisodes.map((episode) => [episode.id, episode]));
const coreEvidenceIds = new Set(coreEpisodes.flatMap((episode) => episode.evidence_ids));
const coreEvidence = evidence.filter((item) => coreEvidenceIds.has(item.id)).map((item) => ({
  id: item.id,
  document_id: item.document_id,
  document_title: item.document_title,
  source_locator: item.source_locator,
  physical_pdf_page: item.physical_pdf_page,
  printed_page: item.printed_page,
  paragraph_ordinal: item.paragraph_ordinal,
  matched_surface: item.matched_surface,
  snippet: item.snippet,
  evidence_status: item.evidence_status,
  citation_allowed: item.citation_allowed,
  uncertainty_note: item.uncertainty_note,
}));
const coreEdges = relations.map((relation) => ({
  ...relation,
  source_evidence_ids: coreEpisodeById.get(relation.source)?.evidence_ids || [],
  target_evidence_ids: coreEpisodeById.get(relation.target)?.evidence_ids || [],
}));
const graph = {
  schema_version: 1,
  academic_schema_version: 2,
  artifact_profile: 'curriculum-concept-evolution-core-v1',
  academic_schema: academicSchema,
  model_kind: model.model_name,
  build_revision: inputRevision,
  input_fingerprints: inputFingerprints,
  assertion_boundary: academicGraph.assertion_boundary,
  academic_model_ref: {
    path: `/data/${path.basename(academicOutputPath)}`,
    build_revision: inputRevision,
    sha256: academicSha256,
    counts: {
      concepts: concepts.length,
      concept_senses: conceptSenses.length,
      surface_forms: surfaceForms.length,
      curriculum_lines: academicGraph.curriculum_lines.length,
      works: academicGraph.works.length,
      editions: academicGraph.editions.length,
      revisions: revisions.length,
      embedded_items: embeddedItems.length,
      occurrences: occurrences.length,
      episodes: episodes.length,
      relations: relations.length,
      evidence: evidence.length,
      coverage_cells: coverageCells.length,
    },
  },
  coverage: academicGraph.coverage,
  subject_facets: canonicalSubjects,
  course_families: model.course_families,
  course_to_subject_links: model.course_to_subject_links,
  subject_taxonomy: subjectTaxonomy.map((item) => ({
    source_label: item.source_label,
    canonical: item.canonical,
    stable_subject_id: item.stable_subject_id,
    stable_course_id: item.stable_course_id,
    entity_kind: item.entity_kind,
    classification: item.classification,
    facet_eligible: item.facet_eligible,
    official_code: item.official_code,
    family: item.family,
    course_family: item.course_family,
    related_subjects: item.related_subjects,
    course_variant: item.course_variant,
    lineage_family: item.lineage_family,
  })),
  concepts: concepts.map(({ surface_form_ids: surfaceFormIds, concept_sense_ids: conceptSenseIds, ...concept }) => concept),
  episodes: coreEpisodes,
  edges: coreEdges,
  evidence: coreEvidence,
};
const corePayload = `${JSON.stringify(graph, null, 2)}\n`;

const citationReadyEvidence = new Set(evidence.filter((item) => item.evidence_status === 'citation_ready' && item.citation_allowed).map((item) => item.id));
const checks = [
  { id: 'unique_episode_ids', passed: new Set(episodes.map((item) => item.id)).size === episodes.length },
  { id: 'unique_evidence_ids', passed: new Set(evidence.map((item) => item.id)).size === evidence.length },
  { id: 'unique_occurrence_ids', passed: new Set(occurrences.map((item) => item.id)).size === occurrences.length },
  { id: 'subject_taxonomy_complete', passed: subjectTaxonomy.every((item) => item.entity_kind !== 'unclassified') },
  { id: 'subject_facet_is_clean', passed: episodes.every((item) => item.subject.facet_eligible === true
    ? facetEntityKinds.has(item.subject.entity_kind) && Boolean(item.subject.canonical) && canonicalSubjects.includes(item.subject.canonical)
    : item.subject.canonical === null && Boolean(item.scope_entity?.canonical)
      && (item.scope_entity.entity_kind !== 'curriculum_course' || item.course_entity?.canonical === item.scope_entity.canonical)) },
  { id: 'core_payload_under_4mb', passed: Buffer.byteLength(corePayload) < 4 * 1024 * 1024 },
  { id: 'solid_has_citation_ready_evidence', passed: episodes.filter((item) => item.claim_policy.display_level === 'solid').every((item) => item.evidence_ids.some((id) => citationReadyEvidence.has(id))) },
  { id: 'non_solid_not_quotable', passed: episodes.filter((item) => item.claim_policy.display_level !== 'solid').every((item) => !item.claim_policy.quotation_allowed) },
  { id: 'relations_have_dual_evidence', passed: relations.every((item) => item.source_evidence_ids.length > 0 && item.target_evidence_ids.length > 0) },
  { id: 'automatic_relations_nonsemantic', passed: relations.every((item) => item.semantic === false && item.influence_claim_allowed === false) },
  { id: 'no_negative_historical_claims', passed: episodes.every((item) => !item.coverage.negative_claim_eligible && !item.claim_policy.historical_superlative_allowed && !item.claim_policy.first_appearance_allowed && !item.claim_policy.disappearance_allowed) },
];
const quality = {
  schema_version: 1,
  academic_schema_version: 2,
  artifact_profile: 'curriculum-concept-evolution-quality-v1',
  academic_schema: academicSchema,
  model_kind: model.model_name,
  build_revision: inputRevision,
  input_fingerprints: inputFingerprints,
  passed: checks.every((item) => item.passed),
  checks,
  core_bytes: Buffer.byteLength(corePayload),
  academic_bytes: Buffer.byteLength(academicPayload),
  academic_sha256: academicSha256,
  release_boundary: academicGraph.assertion_boundary,
  unresolved: [
    `${Math.max(0, queue.counts.pages - completedOcrPages.length)} OCR pages remain`,
    'Concept-sense definitions and semantic rename, split, merge, replacement, and influence relations require editor-reviewed dual-ended evidence.',
    'Exact repeated-text clusters are marked rather than silently discarded; their editorial classification remains pending.',
    'Source-text candidates remain non-quotable until paragraph-level citation gates pass.',
  ],
};
if (!quality.passed) throw new Error(`Concept graph quality gates failed: ${JSON.stringify(checks.filter((item) => !item.passed))}`);

await mkdir(path.dirname(outputPath), { recursive: true });
await mkdir(path.dirname(academicOutputPath), { recursive: true });
const outputTemp = `${outputPath}.${process.pid}.tmp`;
const academicTemp = `${academicOutputPath}.${process.pid}.tmp`;
const qualityTemp = `${qualityPath}.${process.pid}.tmp`;
await Promise.all([
  writeFile(outputTemp, corePayload),
  writeFile(academicTemp, academicPayload),
  writeFile(qualityTemp, `${JSON.stringify(quality, null, 2)}\n`),
]);
await Promise.all([rename(outputTemp, outputPath), rename(academicTemp, academicOutputPath), rename(qualityTemp, qualityPath)]);
console.log(JSON.stringify({
  academic_schema_version: academicGraph.academic_schema_version,
  core_bytes: Buffer.byteLength(corePayload),
  academic_bytes: Buffer.byteLength(academicPayload),
  academic_path: path.relative(root, academicOutputPath),
  episodes: episodes.length,
  relations: relations.length,
  occurrences: occurrences.length,
  evidence: evidence.length,
  subject_facets: academicGraph.subject_facets.length,
  coverage: academicGraph.coverage,
}));
