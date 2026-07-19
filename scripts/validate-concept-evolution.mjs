#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConceptPublicationGate } from './concept-page-publication.mjs';
import { validateCompendiumItemBoundaries } from './validate-compendium-item-boundaries.mjs';
import { isNativeTextRecord } from './page-publication-gate.mjs';
import { semanticDocumentDisposition } from './semantic-publication-gate.mjs';
import { validateCorpusManifest } from './import-corpus.mjs';
import {
  GRAPH_SHARD_MAX_BYTES,
  GRAPH_SHARD_TRANSPORT,
  materializeAcademicGraph,
  verifyGraphIndexShards,
} from './graph-shards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const graphPath = process.env.CONCEPT_GRAPH_OUTPUT_PATH
  ? path.resolve(root, process.env.CONCEPT_GRAPH_OUTPUT_PATH)
  : path.join(root, 'public/data/concept-evolution.json');
const qualityPath = process.env.CONCEPT_QUALITY_OUTPUT_PATH
  ? path.resolve(root, process.env.CONCEPT_QUALITY_OUTPUT_PATH)
  : path.join(root, 'data/concept-evolution-quality.json');
const academicPath = process.env.CONCEPT_ACADEMIC_OUTPUT_PATH
  ? path.resolve(root, process.env.CONCEPT_ACADEMIC_OUTPUT_PATH)
  : path.join(path.dirname(graphPath), `${path.basename(graphPath, '.json')}-academic.json`);
const coreText = await readFile(graphPath, 'utf8');
const academicText = await readFile(academicPath, 'utf8');
const core = JSON.parse(coreText);
const academicIndex = JSON.parse(academicText);
await verifyGraphIndexShards(core, path.dirname(path.dirname(graphPath)));
await verifyGraphIndexShards(academicIndex, path.dirname(path.dirname(academicPath)));
const graph = await materializeAcademicGraph(academicIndex, path.dirname(path.dirname(academicPath)));
const quality = JSON.parse(await readFile(qualityPath, 'utf8'));
const model = JSON.parse(await readFile(path.join(root, 'data/concept-model-v2.json'), 'utf8'));
const catalog = JSON.parse(await readFile(path.join(root, 'data/catalog.json'), 'utf8'));
const pagePublicationManifest = JSON.parse(await readFile(path.join(root, 'data/page-publication-manifest.json'), 'utf8'));
const semanticPublicationPolicy = JSON.parse(
  await readFile(path.join(root, 'data/semantic-publication-policy.json'), 'utf8'),
);
const compendiumItemBoundaries = JSON.parse(
  await readFile(path.join(root, 'data/compendium-item-boundaries.json'), 'utf8'),
);
const onlineVerificationSamples = JSON.parse(
  await readFile(path.join(root, 'data/online-verification-samples.json'), 'utf8'),
);
const queue = JSON.parse(await readFile(path.join(root, 'data/ocr-queue.json'), 'utf8'));
const corpusManifest = validateCorpusManifest(JSON.parse(
  await readFile(path.join(root, 'data/corpus-chunks/manifest.json'), 'utf8'),
));
const compendiumBoundaryValidation = validateCompendiumItemBoundaries(compendiumItemBoundaries, {
  catalog,
  queue,
  onlineVerifications: onlineVerificationSamples,
});
const conceptPublicationGate = createConceptPublicationGate({
  manifest: pagePublicationManifest,
  semanticPolicy: semanticPublicationPolicy,
  records: catalog.documents,
});
const semanticPublicationGate = conceptPublicationGate.semantic_gate;
const catalogById = new Map(catalog.documents.map((record) => [record.id, record]));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const currentBuildLogicSha256 = {
  builder_sha256: sha256(await readFile(path.join(root, 'scripts/build-concept-evolution.mjs'))),
  graph_sharder_sha256: sha256(await readFile(path.join(root, 'scripts/graph-shards.mjs'))),
  concept_publication_gate_sha256: sha256(await readFile(path.join(root, 'scripts/concept-page-publication.mjs'))),
  page_publication_gate_sha256: sha256(await readFile(path.join(root, 'scripts/page-publication-gate.mjs'))),
  semantic_publication_policy_sha256: sha256(
    await readFile(path.join(root, 'data/semantic-publication-policy.json')),
  ),
  semantic_publication_gate_sha256: sha256(
    await readFile(path.join(root, 'scripts/semantic-publication-gate.mjs')),
  ),
  compendium_item_boundaries_sha256: sha256(
    await readFile(path.join(root, 'data/compendium-item-boundaries.json')),
  ),
  compendium_item_boundary_gate_sha256: sha256(
    await readFile(path.join(root, 'scripts/validate-compendium-item-boundaries.mjs')),
  ),
  compendium_item_publication_gate_sha256: sha256(
    await readFile(path.join(root, 'scripts/compendium-item-publication.mjs')),
  ),
  online_verification_samples_sha256: sha256(
    await readFile(path.join(root, 'data/online-verification-samples.json')),
  ),
  corpus_manifest_gate_sha256: sha256(
    await readFile(path.join(root, 'scripts/import-corpus.mjs')),
  ),
  validator_sha256: sha256(await readFile(path.join(root, 'scripts/validate-concept-evolution.mjs'))),
};

const failures = [];
const fail = (condition, message) => { if (!condition) failures.push(message); };
fail(compendiumBoundaryValidation.valid, `compendium item boundary gate failed: ${JSON.stringify(compendiumBoundaryValidation.errors)}`);
const facetEntityKinds = new Set(['subject', 'assessment_subject']);
const isFacetEntity = (item) => facetEntityKinds.has(item?.entity_kind) && item?.facet_eligible === true;
const arrays = [
  'subject_taxonomy', 'subject_entity_audit', 'subject_facets', 'concepts', 'concept_senses', 'surface_forms',
  'curriculum_lines', 'works', 'editions', 'revisions', 'embedded_items', 'occurrences',
  'episodes', 'relations', 'relation_reviews', 'edges', 'evidence', 'coverage_cells',
  'editorial_audit', 'ontology_scopes', 'ontology_nodes', 'ontology_relations', 'ontology_evidence',
];
for (const name of arrays) fail(Array.isArray(graph[name]), `${name}: missing array`);

fail(core.schema_version === 1, 'legacy transport schema_version must remain 1');
fail(graph.schema_version === 2, 'academic artifact schema_version must be 2');
fail(core.academic_schema_version === 2, 'core academic_schema_version must be 2');
fail(graph.academic_schema_version === 2, 'academic_schema_version must be 2');
fail(quality.academic_schema_version === 2, 'quality academic_schema_version must be 2');
fail(core.ontology_schema_version === 1 && graph.ontology_schema_version === 1, 'ontology schema version must be 1');
for (const name of ['ontology_scopes', 'ontology_nodes', 'ontology_relations', 'ontology_evidence']) {
  fail(Array.isArray(core[name]), `core ${name}: missing array`);
}
fail(graph.build_revision === quality.build_revision, 'quality/build revision mismatch');
fail(core.build_revision === graph.build_revision, 'core/academic build revision mismatch');
fail(core.academic_model_ref?.build_revision === graph.build_revision, 'core academic reference revision mismatch');
fail(core.academic_model_ref?.sha256 === sha256(academicText), 'core academic reference hash mismatch');
fail(core.transport_profile === GRAPH_SHARD_TRANSPORT && academicIndex.transport_profile === GRAPH_SHARD_TRANSPORT,
  'graph transport profile mismatch');
fail(Buffer.byteLength(coreText) <= GRAPH_SHARD_MAX_BYTES, 'core graph index exceeds shard cap');
fail(Buffer.byteLength(academicText) <= GRAPH_SHARD_MAX_BYTES, 'academic graph index exceeds shard cap');
fail(quality.passed === true, 'quality report is not passing');
fail(graph.input_fingerprints?.ocr_concept_publication_sha256 === conceptPublicationGate.revision_sha256, 'OCR concept publication fingerprint mismatch');
fail(core.input_fingerprints?.ocr_concept_publication_sha256 === conceptPublicationGate.revision_sha256, 'core OCR concept publication fingerprint mismatch');
fail(quality.input_fingerprints?.ocr_concept_publication_sha256 === conceptPublicationGate.revision_sha256, 'quality OCR concept publication fingerprint mismatch');
fail(graph.input_fingerprints?.semantic_publication_revision_sha256 === semanticPublicationGate.revision_sha256, 'semantic publication fingerprint mismatch');
fail(core.input_fingerprints?.semantic_publication_revision_sha256 === semanticPublicationGate.revision_sha256, 'core semantic publication fingerprint mismatch');
fail(quality.input_fingerprints?.semantic_publication_revision_sha256 === semanticPublicationGate.revision_sha256, 'quality semantic publication fingerprint mismatch');
for (const [label, artifact] of [['academic', graph], ['core', core], ['quality', quality]]) {
  fail(artifact.input_fingerprints?.corpus_manifest_sha256 === corpusManifest.manifest_sha256,
    `${label} corpus manifest fingerprint mismatch`);
  fail(artifact.input_fingerprints?.corpus_release_fingerprint_sha256 === corpusManifest.release_fingerprint_sha256,
    `${label} corpus release fingerprint mismatch`);
}
fail(graph.coverage?.ocr_display_accepted_pages === conceptPublicationGate.revision_projection.length, 'OCR display-accepted coverage count mismatch');
fail(graph.coverage?.compendium_item_candidates === compendiumBoundaryValidation.counts.items,
  'compendium candidate coverage count mismatch');
fail(graph.coverage?.compendium_display_verified_items === compendiumBoundaryValidation.counts.display_allowed
  && graph.coverage?.compendium_citation_verified_items === compendiumBoundaryValidation.counts.citation_allowed
  && graph.coverage?.compendium_semantic_reviewed_items === compendiumBoundaryValidation.counts.semantic_claim_allowed,
'compendium publication coverage counts mismatch');
fail(graph.coverage?.catalog_alias_documents === semanticPublicationGate.aliasById.size, 'catalog alias coverage count mismatch');
fail(graph.coverage?.catalog_documents === catalog.documents.length - semanticPublicationGate.aliasById.size, 'canonical catalog coverage count mismatch');
for (const [key, value] of Object.entries(currentBuildLogicSha256)) {
  fail(graph.input_fingerprints?.[key] === value, `${key}: academic build logic hash drift`);
  fail(core.input_fingerprints?.[key] === value, `${key}: core build logic hash drift`);
  fail(quality.input_fingerprints?.[key] === value, `${key}: quality build logic hash drift`);
}
fail(graph.coverage?.negative_claim_eligible === false, 'graph-level negative claim gate is open');
fail(graph.course_families && typeof graph.course_families === 'object' && !Array.isArray(graph.course_families), 'course_families: missing object');
fail(graph.course_to_subject_links && typeof graph.course_to_subject_links === 'object' && !Array.isArray(graph.course_to_subject_links), 'course_to_subject_links: missing object');

function index(collectionName) {
  const values = graph[collectionName] || [];
  const result = new Map(values.map((item) => [item.id, item]));
  fail(result.size === values.length, `${collectionName}: duplicate IDs`);
  return result;
}

const concepts = index('concepts');
const senses = index('concept_senses');
const surfaces = index('surface_forms');
const lines = index('curriculum_lines');
const works = index('works');
const editions = index('editions');
const revisions = index('revisions');
const embeddedItems = index('embedded_items');
const compendiumBoundaryItems = compendiumItemBoundaries.documents.flatMap((document) => document.items
  .map((item) => ({ ...item, boundary_document: document })));
const compendiumBoundaryItemById = new Map(compendiumBoundaryItems.map((item) => [item.item_id, item]));
const publishableCompendiumBoundaryIds = new Set(
  compendiumBoundaryItems.filter((item) => item.display_allowed).map((item) => item.item_id),
);
const occurrences = index('occurrences');
const episodes = index('episodes');
const relations = index('relations');
const relationReviews = index('relation_reviews');
const evidence = index('evidence');
const coverageCells = index('coverage_cells');
const ontologyScopes = index('ontology_scopes');
const ontologyNodes = index('ontology_nodes');
const ontologyRelations = index('ontology_relations');
const ontologyEvidence = index('ontology_evidence');
const relationEndpointIds = new Set(graph.relations.flatMap((relation) => [relation.source, relation.target]));
const publishedOcrPageByKey = new Map(conceptPublicationGate.revision_projection
  .map((page) => [`${page.document_id}:${page.page_number}`, page]));

const taxonomyBySourceLabel = new Map(graph.subject_taxonomy.map((item) => [item.source_label, item]));
fail(taxonomyBySourceLabel.size === graph.subject_taxonomy.length, 'subject_taxonomy: duplicate source labels');
for (const item of graph.subject_taxonomy) {
  fail(Boolean(item.source_label && item.canonical), `subject taxonomy ${item.source_label}: missing labels`);
  fail(item.entity_kind !== 'unclassified', `subject taxonomy ${item.source_label}: unclassified`);
  fail(item.facet_eligible === facetEntityKinds.has(item.entity_kind), `subject taxonomy ${item.source_label}: facet eligibility/entity kind mismatch`);
  if (isFacetEntity(item)) {
    const members = model.subject_facet_groups?.[item.facet];
    fail(Array.isArray(members) && (members.includes(item.source_label) || members.includes(item.canonical)), `subject taxonomy ${item.source_label}: display facet missing or mismatched`);
  } else fail(item.facet === null, `subject taxonomy ${item.source_label}: non-subject leaked into display facet`);
  if (item.entity_kind === 'curriculum_course') {
    fail(Boolean(item.stable_course_id && item.course_family) && item.stable_subject_id === null, `course taxonomy ${item.source_label}: course identity/family missing or subject identity leaked`);
    fail(Array.isArray(item.related_subjects), `course taxonomy ${item.source_label}: related subjects missing`);
  }
}
fail(new Set(graph.subject_facets).size === graph.subject_facets.length, 'subject_facets: duplicates');
const expectedSubjectFacets = Object.keys(model.subject_facet_groups || {});
fail(JSON.stringify(graph.subject_facets) === JSON.stringify(expectedSubjectFacets), `subject_facets: expected controlled display groups ${expectedSubjectFacets.join(', ')}`);
for (const facet of graph.subject_facets) {
  const eligible = graph.subject_taxonomy.some((item) => item.facet === facet && isFacetEntity(item))
    || graph.works.some((work) => work.subject?.facet === facet && isFacetEntity(work.subject));
  fail(eligible, `subject facet ${facet}: no controlled subject classification`);
}
const subjectAuditByDocument = new Map(graph.subject_entity_audit.map((item) => [item.document_id, item]));
fail(subjectAuditByDocument.size === graph.subject_entity_audit.length, 'subject_entity_audit: duplicate document IDs');
for (const item of graph.subject_entity_audit) {
  fail(Boolean(item.document_id && item.source_label && item.canonical && item.entity_kind && item.classification && item.mapping_basis), `${item.document_id}: incomplete subject entity audit`);
  fail(item.facet_eligible === facetEntityKinds.has(item.entity_kind), `${item.document_id}: audit facet eligibility/entity kind mismatch`);
  fail(isFacetEntity(item) ? graph.subject_facets.includes(item.facet) : item.facet === null, `${item.document_id}: audit display facet mismatch`);
  if (!isFacetEntity(item)) for (const episode of graph.episodes.filter((candidate) => editions.get(candidate.edition_id)?.document_id === item.document_id)) {
    fail(episode.subject?.canonical === null && episode.subject?.facet_eligible === false && episode.scope_entity?.entity_kind === item.entity_kind, `${item.document_id}: non-facet episode leaked into subject facet`);
    if (item.entity_kind === 'curriculum_course') {
      fail(episode.course_entity?.entity_kind === 'curriculum_course' && episode.course_entity?.canonical === item.canonical, `${item.document_id}: course episode lacks explicit course_entity`);
    }
  }
}
const catalogEntityCounts = {
  subject: graph.subject_entity_audit.filter(isFacetEntity).length,
  course: graph.subject_entity_audit.filter((item) => item.entity_kind === 'curriculum_course').length,
  scope: graph.subject_entity_audit.filter((item) => !isFacetEntity(item) && item.entity_kind !== 'curriculum_course' && item.entity_kind !== 'unclassified').length,
  unclassified: graph.subject_entity_audit.filter((item) => item.entity_kind === 'unclassified').length,
};
fail(graph.subject_entity_audit.length === 196, `catalog classifications: expected 196, got ${graph.subject_entity_audit.length}`);
fail(catalogEntityCounts.subject === 160 && catalogEntityCounts.course === 16 && catalogEntityCounts.scope === 20 && catalogEntityCounts.unclassified === 0,
  `catalog classifications: expected 160/16/20/0, got ${catalogEntityCounts.subject}/${catalogEntityCounts.course}/${catalogEntityCounts.scope}/${catalogEntityCounts.unclassified}`);

const sourceValue = (value) => graph.subject_taxonomy.find((item) => item.source_label === value);
for (const value of ['课程方案', '考试大纲', '考试评价', '综合', '艺术与劳动']) {
  fail(sourceValue(value)?.entity_kind !== 'subject' && sourceValue(value)?.facet_eligible === false, `${value}: non-subject source value entered subject facet`);
}
fail(sourceValue('普通高级中学 体育体育与健康')?.canonical === '体育与健康', 'damaged 体育 source label not normalized');
fail(sourceValue('初中科学')?.canonical === '科学', '初中科学 not normalized to 科学');
fail(sourceValue('文科数学')?.canonical === '数学' && sourceValue('文科数学')?.course_variant === 'humanities_track', '文科数学 course variant lost');
fail(sourceValue('理科数学')?.canonical === '数学' && sourceValue('理科数学')?.course_variant === 'science_track', '理科数学 course variant lost');
fail(sourceValue('生物')?.stable_subject_id === sourceValue('生物学')?.stable_subject_id, '生物/生物学 stable subject identity diverged');
fail(sourceValue('信息技术')?.lineage_family === sourceValue('信息科技')?.lineage_family, '信息技术/信息科技 lineage family diverged');
fail(sourceValue('信息技术')?.stable_subject_id !== sourceValue('信息科技')?.stable_subject_id, '信息技术/信息科技 were silently merged without continuity review');
fail(sourceValue('综合实践活动')?.entity_kind === 'curriculum_course' && sourceValue('综合实践活动')?.facet_eligible === false
  && sourceValue('综合实践活动')?.official_code === 'SB0801', '综合实践活动 SB0801 curriculum-course classification missing');
fail(sourceValue('综合实践活动')?.course_family === '综合实践课程' && sourceValue('综合实践活动')?.family === null, '综合实践活动 was silently grouped into a subject family');
fail(sourceValue('汉语')?.entity_kind === 'assessment_subject' && sourceValue('汉语')?.facet_eligible === true
  && sourceValue('汉语')?.classification === 'assessment_subject' && sourceValue('汉语')?.canonical === '汉语'
  && sourceValue('汉语')?.facet === '语文', '汉语 exact identity or 语文 display grouping is invalid');
for (const name of ['英语', '日语', '俄语', '德语', '法语', '西班牙语']) fail(sourceValue(name)?.facet === '外语', `${name}: foreign-language display grouping missing`);
for (const name of ['思想政治', '思想品德', '道德与法治', '品德与生活', '品德与社会']) fail(sourceValue(name)?.facet === '思想政治与道德法治', `${name}: civics display grouping missing`);
for (const name of ['信息技术', '信息科技', '通用技术']) fail(sourceValue(name)?.facet === '技术', `${name}: technology display grouping missing`);
for (const name of ['科学', '初中科学', '物理', '化学', '生物', '生物学']) fail(sourceValue(name)?.facet === '科学类', `${name}: science display grouping missing`);
for (const item of graph.subject_taxonomy.filter((entry) => entry.classification === 'special_education_curriculum_course')) {
  fail(item.official_code === null && Boolean(item.authority), `${item.source_label}: special-education extension has invented SB code or missing authority`);
}
for (const name of ['定向行走', '综合康复', '社会适应', '沟通与交往', '律动', '生活语文', '生活数学', '生活适应', '劳动技能', '运动与保健', '艺术休闲']) {
  fail(/2016/.test(sourceValue(name)?.authority || ''), `${name}: 2016 MOE special-education provenance missing`);
}
const canonicalCourses = [...new Set(graph.subject_taxonomy.filter((item) => item.entity_kind === 'curriculum_course').map((item) => item.canonical))];
const controlledCanonicalSubjects = new Set(graph.subject_taxonomy.filter(isFacetEntity).map((item) => item.canonical));
fail(canonicalCourses.length === 17, `course taxonomy: expected 17 canonical courses, got ${canonicalCourses.length}`);
for (const course of canonicalCourses) {
  const links = graph.course_to_subject_links?.[course];
  fail(Array.isArray(links), `${course}: course-to-subject links missing`);
  for (const subject of links || []) fail(controlledCanonicalSubjects.has(subject), `${course}: linked subject ${subject} is not a controlled subject identity`);
}
const requiredOfficialCodes = {
  语文: 'SB0101', 英语: 'SB0102', 俄语: 'SB0103', 日语: 'SB0104', 德语: 'SB0105', 法语: 'SB0106', 西班牙语: 'SB0107',
  数学: 'SB0201', 思想品德: 'SB0302', 品德与社会: 'SB0304', 历史与社会: 'SB0306', 历史: 'SB0307', 地理: 'SB0308',
  道德与法治: 'SB0309', 思想政治: 'SB0310', 物理: 'SB0401', 化学: 'SB0402', 生物学: 'SB0403', 科学: 'SB0404',
  信息技术: 'SB0502', 通用技术: 'SB0504', 劳动: 'SB0505', 信息科技: 'SB0506', 艺术: 'SB0601', 音乐: 'SB0602', 美术: 'SB0603',
  体育与健康: 'SB0702', 综合实践活动: 'SB0801',
};
for (const [name, code] of Object.entries(requiredOfficialCodes)) {
  const expectedKind = name === '综合实践活动' ? 'curriculum_course' : 'subject';
  const entries = graph.subject_taxonomy.filter((item) => item.canonical === name && item.entity_kind === expectedKind);
  fail(entries.length > 0 && entries.every((item) => item.official_code === code && item.authority === 'JY/T 0644—2022'), `${name}: exact official code ${code} missing`);
}
for (const documentId of ['ictr-d692b0ff2e6c', 'ictr-197f8a2e1cca']) {
  fail(subjectAuditByDocument.get(documentId)?.mapping_basis === 'document_entity_override' && subjectAuditByDocument.get(documentId)?.entity_kind === 'subject', `${documentId}: 综合 source-label correction missing`);
}

for (const sense of graph.concept_senses) {
  fail(concepts.has(sense.concept_id), `${sense.id}: concept missing`);
  fail(sense.subject_scope === null, `${sense.id}: unresolved sense was spuriously split by subject`);
  fail(sense.sense_status === 'undifferentiated_unresolved', `${sense.id}: unresolved sense status missing`);
  fail(sense.definition === null || typeof sense.definition === 'string', `${sense.id}: invalid definition`);
  if (sense.definition === null) fail(sense.definition_source_evidence_ids.length === 0, `${sense.id}: null definition has evidence`);
  fail(['undifferentiated_unresolved', 'editor_reviewed'].includes(sense.review_status), `${sense.id}: invalid review status`);
  if (sense.review_status !== 'editor_reviewed') {
    fail(sense.reviewed_by === null && sense.reviewed_at === null, `${sense.id}: unreviewed sense has reviewer metadata`);
  }
}
for (const concept of graph.concepts) {
  fail(graph.concept_senses.filter((sense) => sense.concept_id === concept.id).length === 1, `${concept.id}: unresolved concept has multiple pseudo-senses`);
}

for (const surface of graph.surface_forms) {
  fail(concepts.has(surface.concept_id), `${surface.id}: concept missing`);
  fail(Boolean(surface.form && surface.form_type && surface.review_status), `${surface.id}: incomplete classification`);
  if (['semantically_related_form', 'historically_related_form', 'unclassified_alias'].includes(surface.form_type)) {
    fail(surface.automatic_match_allowed === false, `${surface.id}: semantic/historical/unclassified form is auto-matchable`);
  }
  fail(Array.isArray(surface.source_evidence_ids), `${surface.id}: source evidence IDs missing`);
}

for (const line of graph.curriculum_lines) {
  fail(Boolean(line.scope_entity_label && line.subject_entity_kind && line.stage && line.school_type && line.document_type), `${line.id}: incomplete curriculum line identity`);
  fail(facetEntityKinds.has(line.subject_entity_kind) ? Boolean(line.subject) : line.subject === null, `${line.id}: non-facet label was placed in subject field`);
  fail(line.subject_entity_kind === 'curriculum_course' ? Boolean(line.course) : line.course === null, `${line.id}: course line identity mismatch`);
  fail(['subject', 'assessment_subject', 'curriculum_course', 'cross_cutting_framework', 'assessment_domain', 'source_collection'].includes(line.subject_entity_kind), `${line.id}: invalid subject entity kind`);
}

for (const work of graph.works) {
  fail(lines.has(work.curriculum_line_id), `${work.id}: curriculum line missing`);
  if (work.parent_work_id !== null) fail(works.has(work.parent_work_id), `${work.id}: parent work missing`);
  fail(Boolean(work.subject?.canonical && work.subject?.entity_kind), `${work.id}: subject/entity classification missing`);
  fail(work.subject.entity_kind === 'curriculum_course'
    ? work.course_entity?.stable_course_id === work.subject.stable_course_id
    : work.course_entity === null, `${work.id}: explicit course entity mismatch`);
  const canonicalDocumentId = work.id.startsWith('work:') ? work.id.slice('work:'.length) : null;
  const canonicalRecord = catalogById.get(canonicalDocumentId);
  const disposition = canonicalRecord
    ? semanticDocumentDisposition(semanticPublicationGate, canonicalRecord)
    : null;
  if (disposition?.alternate_document_ids?.length) {
    fail(work.identity_status === 'exact_source_deduplicated_canonical', `${work.id}: exact duplicate canonical status missing`);
    fail(JSON.stringify(work.document_ids) === JSON.stringify([
      canonicalDocumentId,
      ...disposition.alternate_document_ids,
    ]), `${work.id}: exact duplicate aliases are not bound to the canonical work`);
    for (const aliasDocumentId of disposition.alternate_document_ids) {
      fail(!works.has(`work:${aliasDocumentId}`), `${work.id}: alias created a duplicate work`);
    }
  } else {
    fail(work.identity_status.includes('not_deduplicated'), `${work.id}: unsafe deduplication status`);
  }
}

for (const edition of graph.editions) {
  fail(works.has(edition.work_id), `${edition.id}: work missing`);
  fail(lines.has(edition.curriculum_line_id), `${edition.id}: curriculum line missing`);
  fail(edition.effective_date === null, `${edition.id}: unknown effective date was inferred`);
  if (edition.embedded_item_id !== null) {
    fail(embeddedItems.has(edition.embedded_item_id), `${edition.id}: embedded item missing`);
    const boundary = compendiumBoundaryItemById.get(edition.embedded_item_id);
    const boundaryItem = embeddedItems.get(edition.embedded_item_id);
    fail(boundary?.display_allowed === true
      && edition.id === `edition:${edition.embedded_item_id}`
      && edition.identity_status === 'verified_compendium_item_edition_boundary'
      && edition.document_id === boundary.boundary_document.document_id
      && edition.observation_year === boundary.display_year
      && edition.observation_year_basis === boundary.year_basis
      && edition.source_artifact_sha256 === boundary.boundary_document.source_artifact_sha256,
    `${edition.id}: compendium edition identity drift`);
    const work = works.get(edition.work_id);
    fail(work?.identity_status === 'verified_compendium_item_boundary'
      && work?.canonical_title === boundaryItem?.title
      && work?.parent_work_id === boundaryItem?.parent_work_id,
    `${edition.id}: compendium work identity drift`);
  }
  if (edition.revision_year !== null) {
    fail(graph.revisions.some((revision) => revision.edition_id === edition.id && revision.revision_year === edition.revision_year), `${edition.id}: revision record missing`);
  }
  const disposition = semanticDocumentDisposition(
    semanticPublicationGate,
    catalogById.get(edition.document_id) || { id: edition.document_id },
  );
  if (disposition.alternate_document_ids?.length) {
    fail(edition.identity_status === 'exact_source_deduplicated_canonical', `${edition.id}: exact duplicate canonical status missing`);
    fail(JSON.stringify(edition.alternate_document_ids) === JSON.stringify(disposition.alternate_document_ids),
      `${edition.id}: alternate document ids do not match semantic policy`);
  }
}

for (const revision of graph.revisions) {
  fail(editions.has(revision.edition_id) && works.has(revision.work_id), `${revision.id}: edition/work missing`);
  fail(Number.isInteger(revision.revision_year), `${revision.id}: revision year missing`);
  fail(revision.relation_status === 'version_label_explicit', `${revision.id}: revision not explicitly sourced`);
}

for (const item of graph.embedded_items) {
  const boundary = compendiumBoundaryItemById.get(item.id);
  fail(works.has(item.parent_work_id), `${item.id}: parent work missing`);
  fail(boundary?.display_allowed === true, `${item.id}: no publishable compendium boundary`);
  if (!boundary) continue;
  fail(item.parent_document_id === boundary.boundary_document.document_id
    && item.parent_item_id === boundary.parent_item_id
    && item.item_kind === boundary.item_kind,
  `${item.id}: parent document/item identity drift`);
  fail(item.title === boundary.title && item.raw_title === boundary.raw_title,
    `${item.id}: reviewed title drift`);
  fail(item.identity_status === 'verified_full_item'
    && item.physical_page_start === boundary.candidate_physical_page_start
    && item.physical_page_end === boundary.candidate_physical_page_end
    && item.printed_page_start === boundary.printed_page_start,
  `${item.id}: verified full-item range drift`);
  fail(item.display_year === boundary.display_year && item.year_basis === boundary.year_basis
    && item.stage === boundary.section,
  `${item.id}: reviewed time/stage drift`);
  fail(item.page_publication_release_id === boundary.page_evidence.page_publication_release_id
    && item.page_set_sha256 === boundary.page_evidence.page_set_sha256,
  `${item.id}: page release evidence drift`);
  fail(/^page-gate-[a-f0-9]{24}$/.test(item.page_publication_release_id)
    && item.corpus_release_id === corpusManifest.release_id,
  `${item.id}: page/corpus release identity drift`);
  fail(item.online_verification_status === boundary.online_verification.verification_status
    && JSON.stringify(item.online_source_ids) === JSON.stringify(boundary.online_verification.source_ids),
  `${item.id}: online evidence drift`);
  fail(item.citation_allowed === boundary.citation_allowed
    && item.semantic_claim_allowed === boundary.semantic_claim_allowed,
  `${item.id}: item claim gate drift`);
  fail(item.end_boundary_basis === (boundary.sequence < boundary.boundary_document.items.length
    ? 'next_verified_body_heading' : 'source_artifact_document_end'),
  `${item.id}: end-boundary basis drift`);
  fail(item.semantic_claim_allowed === false || item.citation_allowed === true,
    `${item.id}: semantic claim exceeds citation gate`);
  if (!item.semantic_claim_allowed) fail(Boolean(item.uncertainty_note), `${item.id}: uncertainty note missing`);
}
fail(embeddedItems.size === publishableCompendiumBoundaryIds.size
  && [...publishableCompendiumBoundaryIds].every((id) => embeddedItems.has(id)),
'embedded items do not exactly equal the publishable compendium boundary set');

for (const occurrence of graph.occurrences) {
  fail(concepts.has(occurrence.concept_id), `${occurrence.id}: concept missing`);
  fail(senses.has(occurrence.concept_sense_id), `${occurrence.id}: concept sense missing`);
  fail(surfaces.has(occurrence.surface_form_id), `${occurrence.id}: surface form missing`);
  fail(lines.has(occurrence.curriculum_line_id) && works.has(occurrence.work_id) && editions.has(occurrence.edition_id), `${occurrence.id}: identity references missing`);
  fail(evidence.has(occurrence.evidence_id), `${occurrence.id}: evidence missing`);
  if (occurrence.embedded_item_id !== null) fail(embeddedItems.has(occurrence.embedded_item_id), `${occurrence.id}: embedded item missing`);
  if (occurrence.embedded_item_id !== null) {
    const item = embeddedItems.get(occurrence.embedded_item_id);
    fail(occurrence.position?.physical_page >= item?.physical_page_start
      && occurrence.position?.physical_page <= item?.physical_page_end,
    `${occurrence.id}: occurrence escaped its verified item range`);
    fail(occurrence.semantic_claim_allowed === false,
      `${occurrence.id}: automatic compendium lexical occurrence became semantic`);
  }
  fail(Number.isInteger(occurrence.year) && occurrence.year >= 1800 && occurrence.year <= 2030, `${occurrence.id}: invalid year`);
  fail(Number.isInteger(occurrence.position?.start) && Number.isInteger(occurrence.position?.end) && occurrence.position.end > occurrence.position.start, `${occurrence.id}: invalid offsets`);
  fail(occurrence.section_context?.section_type === 'unknown' && occurrence.section_context?.normative_role === 'unknown', `${occurrence.id}: unknown section/role was inferred`);
  fail(occurrence.match_type === 'exact_surface', `${occurrence.id}: unsupported automatic match type`);
  fail(evidence.get(occurrence.evidence_id)?.occurrence_ids.includes(occurrence.id), `${occurrence.id}: evidence reverse link missing`);
  if (evidence.get(occurrence.evidence_id)?.publication_basis === 'accepted_ocr_page_manifest') {
    fail(occurrence.publication_basis === 'accepted_ocr_page_manifest', `${occurrence.id}: OCR occurrence lacks accepted publication basis`);
    fail(occurrence.semantic_claim_allowed === false, `${occurrence.id}: OCR occurrence was promoted to semantic evidence`);
  }
}

for (const item of graph.evidence) {
  fail(Boolean(item.document_id && item.source_locator && item.body_sha256), `${item.id}: incomplete locator/hash`);
  fail(concepts.has(item.concept_id) && senses.has(item.concept_sense_id), `${item.id}: concept/sense missing`);
  fail(works.has(item.work_id) && editions.has(item.edition_id), `${item.id}: work/edition missing`);
  fail(item.occurrence_ids.length > 0 && item.occurrence_ids.every((id) => occurrences.has(id)), `${item.id}: occurrence links missing`);
  fail(item.match_offsets.length > 0 && item.match_offsets.every((offset) => Number.isInteger(offset.start) && offset.end > offset.start && surfaces.has(offset.surface_form_id)), `${item.id}: match offsets invalid`);
  fail(item.section_context?.section_type === 'unknown' && item.section_context?.normative_role === 'unknown', `${item.id}: section/role inference not allowed`);
  fail(item.online_verification_id === null || typeof item.online_verification_id === 'string', `${item.id}: invalid online verification ID`);
  if (item.embedded_item_id !== null) {
    const embedded = embeddedItems.get(item.embedded_item_id);
    const boundary = compendiumBoundaryItemById.get(item.embedded_item_id);
    fail(item.physical_pdf_page >= embedded?.physical_page_start
      && item.physical_pdf_page <= embedded?.physical_page_end,
    `${item.id}: evidence escaped its verified item range`);
    fail(item.document_id === embedded?.parent_document_id
      && item.parent_compendium_id === embedded?.parent_document_id,
    `${item.id}: compendium evidence parent drift`);
    fail(item.citation_allowed === true ? boundary?.citation_allowed === true : true,
      `${item.id}: evidence citation exceeds the item gate`);
    fail(item.online_verification_id === null
      || boundary?.online_verification.source_ids.includes(item.online_verification_id),
    `${item.id}: online verification ID is outside the reviewed item sources`);
    fail(item.witness_sha256 && /^[a-f0-9]{64}$/.test(item.witness_sha256),
      `${item.id}: compendium page witness hash is missing`);
    fail(item.semantic_claim_allowed === false,
      `${item.id}: automatic compendium evidence became semantic`);
  }
  if (item.evidence_status !== 'citation_ready') {
    fail(item.citation_allowed === false, `${item.id}: candidate evidence is citation allowed`);
    fail(item.citation_gate?.paragraph_allowed === false, `${item.id}: candidate paragraph citation gate is open`);
    if (item.publication_basis !== 'accepted_ocr_page_manifest') {
      fail(item.citation_gate?.document_allowed === false, `${item.id}: non-OCR candidate document citation gate is open`);
    }
  }
  const sourceRecord = catalogById.get(item.document_id);
  const ocrDerived = sourceRecord ? !isNativeTextRecord(sourceRecord) : item.embedded_item_id !== null;
  if (ocrDerived) {
    const page = publishedOcrPageByKey.get(`${item.document_id}:${item.physical_pdf_page}`);
    fail(item.publication_basis === 'accepted_ocr_page_manifest', `${item.id}: OCR evidence lacks accepted page publication basis`);
    fail(Boolean(page), `${item.id}: OCR evidence page is absent from the display-accepted manifest projection`);
    if (page) {
      fail(item.source_artifact_sha256 === page.source_artifact_sha256, `${item.id}: OCR source artifact hash drift`);
      fail(item.source_page_sha256 === page.source_page_sha256, `${item.id}: OCR source page hash drift`);
      fail(item.final_text_sha256 === page.final_text_sha256, `${item.id}: OCR final text hash drift`);
      fail(item.evidence_bundle_sha256 === page.evidence_bundle_sha256, `${item.id}: OCR evidence bundle hash drift`);
      fail(item.stable_locator === page.stable_locator, `${item.id}: OCR stable locator drift`);
      fail(item.citation_allowed === item.citation_gate?.paragraph_allowed && (!item.citation_allowed || page.citation_allowed),
        `${item.id}: OCR citation state exceeds or contradicts the accepted page manifest`);
    }
    fail(item.semantic_claim_allowed === false, `${item.id}: OCR lexical evidence was promoted to semantic evidence`);
  }
}

function expectedVisibilityFacets(episode) {
  if (episode.subject?.facet_eligible === true) return [episode.subject.facet];
  if (episode.scope_entity?.entity_kind !== 'curriculum_course') return [];
  return [...new Set((episode.scope_entity.related_subjects || []).flatMap((subject) => graph.subject_taxonomy
    .filter((item) => isFacetEntity(item) && (item.source_label === subject || item.canonical === subject))
    .map((item) => item.facet)))];
}

for (const episode of graph.episodes) {
  fail(concepts.has(episode.concept_id) && senses.has(episode.concept_sense_id), `${episode.id}: concept/sense missing`);
  if (episode.subject?.facet_eligible === true) {
    fail(facetEntityKinds.has(episode.subject.entity_kind), `${episode.id}: invalid facet-bearing entity kind`);
    fail(episode.subject?.facet_eligible === true && Boolean(episode.subject.canonical), `${episode.id}: subject facet metadata invalid`);
    fail(graph.subject_facets.includes(episode.subject.facet), `${episode.id}: display facet absent from controlled groups`);
    fail(episode.course_entity === null, `${episode.id}: facet episode has course entity`);
  } else {
    fail(episode.subject?.facet_eligible === false && episode.subject?.canonical === null, `${episode.id}: scope entered subject facet`);
    fail(Boolean(episode.scope_entity?.canonical && episode.scope_entity?.entity_kind), `${episode.id}: scope entity metadata missing`);
    fail(episode.scope_entity.entity_kind === 'curriculum_course'
      ? episode.course_entity?.stable_course_id === episode.scope_entity.stable_course_id
      : episode.course_entity === null, `${episode.id}: explicit course entity mismatch`);
  }
  fail(lines.has(episode.curriculum_line?.id) && works.has(episode.work_id) && editions.has(episode.edition_id), `${episode.id}: line/work/edition missing`);
  fail(episode.edition?.identity_id === episode.edition_id, `${episode.id}: incompatible edition identity`);
  fail(Array.isArray(episode.visibility_facets), `${episode.id}: visibility facets missing`);
  fail(JSON.stringify([...episode.visibility_facets].sort()) === JSON.stringify(expectedVisibilityFacets(episode).sort()), `${episode.id}: visibility facets are not provenance-derived`);
  fail(episode.subject?.facet_eligible === true
    ? episode.visibility_policy === 'direct_subject_facet'
    : episode.visibility_facets.length ? episode.visibility_policy === 'reviewed_course_relation' : episode.visibility_policy === 'global_only', `${episode.id}: visibility policy mismatch`);
  fail(Number.isInteger(episode.time?.year) && episode.time.year >= 1800 && episode.time.year <= 2030, `${episode.id}: invalid year`);
  fail(episode.evidence_ids.length > 0 && episode.evidence_ids.every((id) => evidence.has(id)), `${episode.id}: evidence missing`);
  const episodeEvidence = episode.evidence_ids.map((id) => evidence.get(id));
  const citationClasses = new Set(episodeEvidence.map((item) => item.citation_allowed));
  fail(citationClasses.size === 1, `${episode.id}: citation-ready and display-only evidence were merged into one frequency episode`);
  fail(episode.occurrence_ids.length > 0 && episode.occurrence_ids.every((id) => occurrences.has(id)), `${episode.id}: occurrences missing`);
  fail(episode.observation?.roles?.length === 1 && episode.observation.roles[0] === 'unknown', `${episode.id}: normative role inferred`);
  const frequency = episode.observation?.frequency;
  fail(Number.isInteger(frequency?.numerator) && frequency.numerator >= 0, `${episode.id}: frequency numerator invalid`);
  fail(Number.isInteger(frequency?.denominator) && frequency.denominator >= 0, `${episode.id}: frequency denominator invalid`);
  fail(frequency?.denominator_unit === 'eligible_meaningful_characters', `${episode.id}: denominator unit missing`);
  fail(frequency?.comparability === 'within_edition_descriptive_only' && frequency?.interpretation === null, `${episode.id}: cross-edition interpretation asserted`);
  fail(episode.observation.local_unique_mention_count <= episode.observation.mention_count, `${episode.id}: local count exceeds total`);
  if (episode.claim_policy.display_level === 'solid') {
    fail(episode.observation.status === 'citation_ready', `${episode.id}: solid status is not citation_ready`);
    fail(episode.evidence_ids.some((id) => evidence.get(id)?.citation_allowed === true && evidence.get(id)?.evidence_status === 'citation_ready'), `${episode.id}: solid has no citation-ready evidence`);
  } else {
    fail(episode.claim_policy.quotation_allowed === false, `${episode.id}: non-solid episode is quotable`);
    fail(episode.observation.observation_class === 'nonsemantic_candidate' && episode.observation.semantic === false,
      `${episode.id}: display-only episode is not explicitly nonsemantic`);
    fail(episode.claim_policy.semantic_relation_allowed === false && !relationEndpointIds.has(episode.id),
      `${episode.id}: display-only episode entered a relation`);
  }
  fail(episode.coverage.negative_claim_eligible === false, `${episode.id}: negative history claim enabled`);
  fail(episode.claim_policy.historical_superlative_allowed === false, `${episode.id}: historical superlative enabled`);
  fail(episode.claim_policy.first_appearance_allowed === false, `${episode.id}: first appearance claim enabled`);
  fail(episode.claim_policy.disappearance_allowed === false, `${episode.id}: disappearance claim enabled`);
}

fail(!graph.episodes.some((episode) => episode.concept_id === 'sports-ability' && episode.scope_entity?.canonical === '综合康复'), 'rehabilitation motor ability was conflated with 体育运动能力');
fail(!graph.episodes.some((episode) => episode.concept_id === 'artistic-expression' && episode.scope_entity?.canonical === '律动'), 'generic 律动艺术表现 was conflated with an art core competency');

const ontologyNodeTypes = new Set([
  'subject_model', 'curriculum_construct', 'language_activity', 'historical_goal_framework', 'historical_goal_dimension',
  'competency_framework', 'core_competency_dimension', 'course_goal', 'practice_framework', 'practice_domain',
  'student_ability', 'content_organizer', 'task_group', 'quality_framework', 'quality_level', 'quality_dimension',
  'official_term', 'ability_descriptor', 'task_requirement',
]);
const sourceBoundOntologyNodeTypes = new Set(['official_term', 'ability_descriptor', 'task_requirement']);
const ontologyRelationTypes = new Set(['component_of', 'operationalizes', 'assesses', 'foundational_for', 'reframed_by', 'develops', 'realized_through']);
for (const scope of graph.ontology_scopes) {
  fail(graph.subject_facets.includes(scope.subject_facet), `${scope.id}: uncontrolled ontology subject facet`);
  if (scope.edition_id !== null) fail(editions.has(scope.edition_id), `${scope.id}: ontology edition missing`);
  fail(Boolean(scope.stage && scope.school_type && scope.version_scope), `${scope.id}: incomplete ontology version scope`);
}
for (const item of graph.ontology_evidence) {
  fail(Boolean(item.document_id && item.edition_id && item.source_locator && item.body_sha256 && item.source_artifact_sha256), `${item.id}: incomplete ontology evidence identity`);
  fail(editions.has(item.edition_id), `${item.id}: ontology evidence edition missing`);
  fail(item.evidence_status === 'citation_ready' && item.citation_allowed === true, `${item.id}: ontology evidence is not citation ready`);
  fail(Array.isArray(item.section_path) && item.section_path.length > 0 && item.required_terms.length > 0, `${item.id}: ontology section path or anchor terms missing`);
  const sourceRecord = catalogById.get(item.document_id);
  if (sourceRecord && !isNativeTextRecord(sourceRecord)) {
    const page = publishedOcrPageByKey.get(`${item.document_id}:${item.physical_pdf_page}`);
    fail(Boolean(page) && page.citation_allowed === true, `${item.id}: OCR ontology anchor lacks a citation-accepted page`);
    fail(item.publication_basis === 'accepted_ocr_page_manifest', `${item.id}: OCR ontology anchor lacks publication basis`);
    if (page) {
      fail(item.source_artifact_sha256 === page.source_artifact_sha256
        && item.source_page_sha256 === page.source_page_sha256
        && item.final_text_sha256 === page.final_text_sha256
        && item.evidence_bundle_sha256 === page.evidence_bundle_sha256
        && item.stable_locator === page.stable_locator, `${item.id}: OCR ontology anchor hash drift`);
    }
  }
}
for (const node of graph.ontology_nodes) {
  fail(ontologyNodeTypes.has(node.node_type), `${node.id}: invalid ontology node type`);
  fail(ontologyScopes.has(node.scope_id), `${node.id}: ontology scope missing`);
  fail(Boolean(node.label && node.definition && node.normative_role), `${node.id}: incomplete ontology semantics`);
  fail(['editor_reviewed', 'reviewed_inference'].includes(node.review_status), `${node.id}: invalid ontology review status`);
  fail(node.evidence_anchor_ids.length > 0 && node.evidence_anchor_ids.every((id) => ontologyEvidence.has(id)), `${node.id}: ontology evidence missing`);
  if (sourceBoundOntologyNodeTypes.has(node.node_type)) {
    fail(Array.isArray(node.source_terms) && node.source_terms.length > 0 && new Set(node.source_terms).size === node.source_terms.length, `${node.id}: source terms missing or duplicated`);
    fail(node.definition.length >= 12, `${node.id}: evidence-scoped definition is too shallow`);
  }
  if (node.lexical_concept_id !== null) fail(concepts.has(node.lexical_concept_id), `${node.id}: linked lexical concept missing`);
  if (node.parent_id !== null) fail(ontologyNodes.has(node.parent_id) && ontologyRelationTypes.has(node.parent_relation), `${node.id}: parent or parent relation missing`);
}
for (const relation of graph.ontology_relations) {
  fail(ontologyRelationTypes.has(relation.type), `${relation.id}: invalid ontology relation type`);
  fail(ontologyNodes.has(relation.source) && ontologyNodes.has(relation.target), `${relation.id}: ontology endpoint missing`);
  fail(ontologyScopes.has(relation.scope_id), `${relation.id}: ontology relation scope missing`);
  fail(relation.evidence_anchor_ids.length > 0 && relation.evidence_anchor_ids.every((id) => ontologyEvidence.has(id)), `${relation.id}: ontology relation evidence missing`);
  if (relation.type === 'reframed_by') {
    fail(new Set(relation.evidence_anchor_ids.map((id) => ontologyEvidence.get(id)?.document_id)).size >= 2, `${relation.id}: cross-version relation lacks dual-source evidence`);
  }
}
fail(graph.ontology_nodes.filter((node) => node.node_type === 'course_goal').length === 12, 'Chinese ontology must expose 12 course goals');
fail(graph.ontology_nodes.filter((node) => node.node_type === 'student_ability').length === 15, 'Chinese ontology must expose 15 practice abilities');
fail(graph.ontology_nodes.filter((node) => node.node_type === 'task_group').length === 18, 'Chinese ontology must expose 18 unique task groups');
fail(graph.ontology_nodes.filter((node) => node.node_type === 'quality_level').length === 5, 'Chinese ontology must expose 5 quality levels');
fail(graph.ontology_nodes.filter((node) => node.node_type === 'official_term').length === 34, 'Chinese ontology must expose 34 source-bound official terms');
fail(graph.ontology_nodes.filter((node) => node.node_type === 'ability_descriptor').length === 21, 'Chinese ontology must expose 21 source-bound ability descriptors');
fail(graph.ontology_nodes.filter((node) => node.node_type === 'task_requirement').length === 38, 'Chinese ontology must expose 38 source-bound task requirements');
const blindIntegratedGoals = graph.ontology_nodes.filter((node) => node.normative_role === 'integrated_course_goal');
fail(blindIntegratedGoals.length === 10, '2016 Blind Chinese must expose 10 integrated overall goals');
fail(blindIntegratedGoals.every((node) => node.scope_id === 'scope:zh-2016-blind' && node.parent_id === 'zh-three-dimensional-goals'), '2016 Blind integrated goals must remain direct, edition-scoped children of the three-dimensional framework');
fail(graph.ontology_nodes.filter((node) => node.node_type === 'quality_dimension').every((node) => node.review_status === 'reviewed_inference'), 'quality dimension alignment must remain an explicit reviewed inference');
fail(!graph.ontology_nodes.some((node) => node.node_type === 'performance_indicator'), 'quality table indicators must remain fail-closed until visual row reconstruction');
let maximumOntologyDepth = 0;
for (const start of graph.ontology_nodes) {
  const visited = new Set();
  let cursor = start;
  let depth = 0;
  while (cursor?.parent_id !== null) {
    fail(!visited.has(cursor.id), `${start.id}: ontology parent cycle`);
    if (visited.has(cursor.id)) break;
    visited.add(cursor.id);
    cursor = ontologyNodes.get(cursor.parent_id);
    depth += 1;
  }
  maximumOntologyDepth = Math.max(maximumOntologyDepth, depth);
}
fail(maximumOntologyDepth >= 4, 'Chinese ontology must expose evidence-scoped paths at least four levels deep');

for (const cell of graph.coverage_cells) {
  fail(lines.has(cell.curriculum_line_id) && works.has(cell.work_id) && editions.has(cell.edition_id), `${cell.id}: identity references missing`);
  fail(cell.negative_claim_eligible === false, `${cell.id}: negative claim enabled`);
  fail(cell.alias_search_complete === false, `${cell.id}: incomplete alias search declared complete`);
  fail(Boolean(cell.scope_entity?.entity_kind && cell.scope_entity?.canonical_label), `${cell.id}: scope entity missing`);
  if (facetEntityKinds.has(cell.entity_kind)) {
    fail(Boolean(cell.subject_id && cell.canonical_subject), `${cell.id}: subject coverage identity missing`);
    fail(cell.course_entity === null, `${cell.id}: facet coverage has course identity`);
  } else {
    fail(cell.subject_id === null && cell.canonical_subject === null, `${cell.id}: non-subject scope stored in subject fields`);
    fail(cell.entity_kind === 'curriculum_course'
      ? Boolean(cell.course_entity?.course_id && cell.course_entity?.canonical_course)
      : cell.course_entity === null, `${cell.id}: course coverage identity mismatch`);
  }
  if (cell.embedded_item_id !== null) {
    fail(embeddedItems.has(cell.embedded_item_id), `${cell.id}: embedded item missing`);
    const item = embeddedItems.get(cell.embedded_item_id);
    const expectedPages = item.physical_page_end - item.physical_page_start + 1;
    fail(cell.complete === true && cell.expected_pages === expectedPages
      && cell.usable_pages === expectedPages,
    `${cell.id}: full verified item coverage is incomplete`);
    fail(cell.lexical_search_scope === 'automatic_surface_forms_only_full_verified_item',
      `${cell.id}: compendium lexical scope drift`);
  }
}

for (const relation of graph.relations) {
  const source = episodes.get(relation.source);
  const target = episodes.get(relation.target);
  fail(Boolean(source && target), `${relation.id}: endpoint missing`);
  fail(source?.observation?.status === 'citation_ready' && target?.observation?.status === 'citation_ready', `${relation.id}: non-citation episode entered a relation`);
  fail(relation.source_evidence_ids?.length > 0 && relation.source_evidence_ids.every((id) => evidence.has(id) && source?.evidence_ids.includes(id)), `${relation.id}: source endpoint evidence invalid`);
  fail(relation.target_evidence_ids?.length > 0 && relation.target_evidence_ids.every((id) => evidence.has(id) && target?.evidence_ids.includes(id)), `${relation.id}: target endpoint evidence invalid`);
  const review = relationReviews.get(relation.relation_review_id);
  fail(Boolean(review && review.relation_id === relation.id), `${relation.id}: relation review missing`);
  if (relation.semantic === true) {
    fail(relation.editor_reviewed === true && Boolean(relation.reviewed_by && relation.reviewed_at), `${relation.id}: semantic relation lacks editor review`);
    fail(review?.review_status === 'editor_reviewed' && Boolean(review?.rationale), `${relation.id}: semantic review rationale missing`);
  } else {
    fail(relation.influence_claim_allowed === false, `${relation.id}: nonsemantic relation claims influence`);
    fail(['next_observed', 'co_observed'].includes(relation.type), `${relation.id}: invalid automatic relation type`);
  }
  if (relation.type === 'next_observed' && source && target) {
    fail(source.concept_sense_id === target.concept_sense_id, `${relation.id}: lineage joins different concept senses`);
    fail(source.subject.canonical === target.subject.canonical, `${relation.id}: lineage joins different subjects`);
    fail(source.curriculum_line.id === target.curriculum_line.id, `${relation.id}: lineage joins different curriculum lines`);
    fail(target.time.year > source.time.year, `${relation.id}: lineage years are not strictly increasing`);
    fail(relation.metric?.ratio === null && relation.metric?.interpretation === null && relation.metric?.comparability === 'cross_edition_comparability_not_established', `${relation.id}: unsupported frequency interpretation`);
  }
  if (relation.type === 'co_observed') {
    fail(relation.directionality === 'symmetric', `${relation.id}: co-observation is directional`);
    fail(relation.metric === null && relation.influence_claim_allowed === false, `${relation.id}: co-observation claims metric/influence`);
  }
}

fail(graph.edges.length === graph.relations.length && graph.edges.every((edge) => relations.has(edge.id)), 'legacy edges do not mirror relations');

const blindChinese = graph.editions.find((edition) => edition.document_id === 'ictr-42b373aa14b0');
const deafChinese = graph.editions.find((edition) => edition.document_id === 'ictr-3bc52aa82371');
if (blindChinese && deafChinese) {
  fail(blindChinese.id !== deafChinese.id, 'blind/deaf editions were merged');
  fail(blindChinese.curriculum_line_id !== deafChinese.curriculum_line_id, 'blind/deaf curriculum lines were merged');
}
const chinese2020 = graph.editions.find((edition) => edition.document_id === 'moe-hs-2020-02');
if (chinese2020) {
  fail(chinese2020.base_edition_year === 2017 && chinese2020.revision_year === 2020, '2017/2020 Chinese edition revision was not parsed');
}

if (failures.length) {
  console.error(JSON.stringify({ passed: false, failure_count: failures.length, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  passed: true,
  academic_schema_version: graph.academic_schema_version,
  subject_facets: graph.subject_facets.length,
  episodes: graph.episodes.length,
  relations: graph.relations.length,
  occurrences: graph.occurrences.length,
  evidence: graph.evidence.length,
  build_revision: graph.build_revision,
}));
