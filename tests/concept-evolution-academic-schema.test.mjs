import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { materializeAcademicGraph, verifyGraphIndexShards } from '../scripts/graph-shards.mjs';

const root = new URL('../', import.meta.url);
const artifactPath = (environmentName, fallback) => process.env[environmentName]
  ? path.resolve(fileURLToPath(root), process.env[environmentName])
  : new URL(fallback, root);
const core = JSON.parse(await readFile(artifactPath('CONCEPT_GRAPH_OUTPUT_PATH', 'public/data/concept-evolution.json'), 'utf8'));
const academicArtifactPath = artifactPath('CONCEPT_ACADEMIC_OUTPUT_PATH', 'public/data/concept-evolution-academic.json');
const academicIndex = JSON.parse(await readFile(academicArtifactPath, 'utf8'));
const academicPathname = academicArtifactPath instanceof URL ? fileURLToPath(academicArtifactPath) : academicArtifactPath;
const publicRoot = path.dirname(path.dirname(academicPathname));
await verifyGraphIndexShards(academicIndex, publicRoot);
const graph = await materializeAcademicGraph(academicIndex, publicRoot);
const compendiumBoundaries = JSON.parse(
  await readFile(new URL('../data/compendium-item-boundaries.json', import.meta.url), 'utf8'),
);
const byId = (name) => new Map(graph[name].map((item) => [item.id, item]));
const concepts = byId('concepts');
const senses = byId('concept_senses');
const surfaces = byId('surface_forms');
const lines = byId('curriculum_lines');
const works = byId('works');
const editions = byId('editions');
const occurrences = byId('occurrences');
const evidence = byId('evidence');
const episodes = byId('episodes');
const relationReviews = byId('relation_reviews');
const ontologyScopes = byId('ontology_scopes');
const ontologyNodes = byId('ontology_nodes');
const ontologyEvidence = byId('ontology_evidence');
const taxonomy = new Map(graph.subject_taxonomy.map((item) => [item.source_label, item]));
const subjectAudit = new Map(graph.subject_entity_audit.map((item) => [item.document_id, item]));

test('v2 academic entities coexist with the legacy frontend envelope', () => {
  assert.equal(core.schema_version, 1);
  assert.equal(graph.schema_version, 2);
  assert.equal(graph.academic_schema_version, 2);
  assert.equal(core.build_revision, graph.build_revision);
  assert.equal(core.academic_model_ref.build_revision, graph.build_revision);
  for (const name of [
    'concept_senses', 'surface_forms', 'curriculum_lines', 'works', 'editions', 'revisions',
    'embedded_items', 'occurrences', 'relations', 'relation_reviews', 'coverage_cells',
    'editorial_audit', 'episodes', 'edges', 'evidence', 'subject_taxonomy', 'subject_entity_audit',
    'ontology_scopes', 'ontology_nodes', 'ontology_relations', 'ontology_evidence',
  ]) assert.ok(Array.isArray(graph[name]), `${name} missing`);
  assert.deepEqual(graph.edges.map((edge) => edge.id), graph.relations.map((relation) => relation.id));
});

test('entity IDs are unique and occurrence evidence is referentially complete', () => {
  for (const name of [
    'concepts', 'concept_senses', 'surface_forms', 'curriculum_lines', 'works', 'editions',
    'revisions', 'embedded_items', 'occurrences', 'episodes', 'relations', 'relation_reviews',
    'evidence', 'coverage_cells',
    'ontology_scopes', 'ontology_nodes', 'ontology_relations', 'ontology_evidence',
  ]) assert.equal(byId(name).size, graph[name].length, `${name} has duplicate IDs`);

  for (const occurrence of graph.occurrences) {
    assert.ok(concepts.has(occurrence.concept_id));
    assert.ok(senses.has(occurrence.concept_sense_id));
    assert.ok(surfaces.has(occurrence.surface_form_id));
    assert.ok(lines.has(occurrence.curriculum_line_id));
    assert.ok(works.has(occurrence.work_id));
    assert.ok(editions.has(occurrence.edition_id));
    assert.ok(evidence.get(occurrence.evidence_id).occurrence_ids.includes(occurrence.id));
    assert.ok(occurrence.position.end > occurrence.position.start);
    assert.equal(occurrence.section_context.normative_role, 'unknown');
  }
});

test('Chinese deep ontology is edition-scoped, evidence-resolved, and fail-closed', () => {
  assert.equal(graph.ontology_schema_version, 1);
  assert.equal(graph.ontology_nodes.length, 169);
  assert.equal(graph.ontology_evidence.length, 21);
  assert.equal(graph.ontology_nodes.filter((node) => node.node_type === 'course_goal').length, 12);
  assert.equal(graph.ontology_nodes.filter((node) => node.node_type === 'student_ability').length, 15);
  assert.equal(graph.ontology_nodes.filter((node) => node.node_type === 'task_group').length, 18);
  assert.equal(graph.ontology_nodes.filter((node) => node.node_type === 'quality_level').length, 5);
  assert.equal(graph.ontology_nodes.filter((node) => node.node_type === 'official_term').length, 34);
  assert.equal(graph.ontology_nodes.filter((node) => node.node_type === 'ability_descriptor').length, 21);
  assert.equal(graph.ontology_nodes.filter((node) => node.node_type === 'task_requirement').length, 38);
  assert.equal(graph.ontology_nodes.some((node) => node.node_type === 'performance_indicator'), false);

  for (const anchor of graph.ontology_evidence) {
    assert.equal(anchor.citation_allowed, true);
    assert.equal(anchor.evidence_status, 'citation_ready');
    assert.ok(anchor.document_id && anchor.paragraph_ordinal && anchor.source_artifact_sha256 && anchor.body_sha256);
  }
  for (const node of graph.ontology_nodes) {
    assert.ok(ontologyScopes.has(node.scope_id));
    assert.ok((node.evidence_anchor_ids || []).every((id) => ontologyEvidence.has(id)));
    if (node.parent_id) assert.ok(ontologyNodes.has(node.parent_id));
    if (['official_term', 'ability_descriptor', 'task_requirement'].includes(node.node_type)) {
      assert.ok(Array.isArray(node.source_terms) && node.source_terms.length > 0);
      assert.equal(new Set(node.source_terms).size, node.source_terms.length);
      assert.ok(node.definition.length >= 12);
    }
  }
  const historical = ontologyNodes.get('zh-three-dimensional-goals');
  assert.equal(ontologyScopes.get(historical.scope_id).school_type, 'special_education_school_for_the_blind');
  const blindIntegratedGoals = graph.ontology_nodes.filter((node) => node.normative_role === 'integrated_course_goal');
  assert.equal(blindIntegratedGoals.length, 10);
  assert.ok(blindIntegratedGoals.every((node) => node.scope_id === historical.scope_id && node.parent_id === historical.id));
  assert.ok(blindIntegratedGoals.every((node) => !['zh-goal-knowledge-ability', 'zh-goal-process-method', 'zh-goal-emotion-attitude-values'].includes(node.parent_id)));
  const crossVersion = graph.ontology_relations.find((relation) => relation.id === 'zh-rel-three-goals-reframed');
  assert.equal(crossVersion.assertion_status, 'cross_version_reviewed_relation');
  assert.equal(crossVersion.evidence_anchor_ids.length, 2);
  assert.ok(graph.ontology_nodes.filter((node) => node.node_type === 'quality_dimension')
    .every((node) => node.review_status === 'reviewed_inference'));

  let maximumDepth = 0;
  for (const node of graph.ontology_nodes) {
    let depth = 0;
    let cursor = node;
    while (cursor.parent_id) {
      depth += 1;
      cursor = ontologyNodes.get(cursor.parent_id);
    }
    maximumDepth = Math.max(maximumDepth, depth);
  }
  assert.ok(maximumDepth >= 4);
});

test('unresolved lexical concepts are not split into empty subject pseudo-senses', () => {
  assert.equal(graph.concept_senses.length, graph.concepts.length);
  for (const concept of graph.concepts) {
    const conceptSenses = graph.concept_senses.filter((sense) => sense.concept_id === concept.id);
    assert.equal(conceptSenses.length, 1);
    assert.equal(conceptSenses[0].sense_status, 'undifferentiated_unresolved');
    assert.equal(conceptSenses[0].subject_scope, null);
    assert.equal(conceptSenses[0].definition, null);
  }
});

test('blind and deaf curriculum lines are not merged', () => {
  const blind = graph.editions.find((edition) => edition.document_id === 'ictr-42b373aa14b0');
  const deaf = graph.editions.find((edition) => edition.document_id === 'ictr-3bc52aa82371');
  assert.ok(blind && deaf);
  assert.notEqual(blind.id, deaf.id);
  assert.notEqual(blind.curriculum_line_id, deaf.curriculum_line_id);
  assert.equal(lines.get(blind.curriculum_line_id).school_subtype, 'school_for_the_blind');
  assert.equal(lines.get(deaf.curriculum_line_id).school_subtype, 'school_for_the_deaf');
});

test('explicit edition and revision years remain separate', () => {
  const edition = graph.editions.find((item) => item.document_id === 'moe-hs-2020-02');
  assert.ok(edition);
  assert.equal(edition.base_edition_year, 2017);
  assert.equal(edition.revision_year, 2020);
  assert.equal(edition.observation_year, 2020);
  assert.ok(graph.revisions.some((revision) => revision.edition_id === edition.id
    && revision.base_edition_year === 2017 && revision.revision_year === 2020));
});

test('frequency is descriptive within an edition and repeated text is marked, not dropped', () => {
  assert.ok(graph.text_reuse_clusters.length > 0);
  assert.ok(graph.occurrences.some((occurrence) => occurrence.text_reuse_cluster_id));
  for (const episode of graph.episodes) {
    const frequency = episode.observation.frequency;
    assert.equal(frequency.numerator, episode.observation.local_unique_mention_count);
    assert.equal(frequency.denominator_unit, 'eligible_meaningful_characters');
    assert.equal(frequency.comparability, 'within_edition_descriptive_only');
    assert.equal(frequency.interpretation, null);
    assert.ok(episode.observation.local_unique_mention_count <= episode.observation.mention_count);
  }
});

test('surface forms distinguish spelling variants from semantic or historical candidates', () => {
  const byForm = new Map(graph.surface_forms.map((surface) => [`${surface.concept_id}|${surface.form}`, surface]));
  assert.equal(byForm.get('teaching-learning-assessment|教-学-评一致性').form_type, 'orthographic_variant');
  assert.equal(byForm.get('teaching-learning-assessment|教-学-评一致性').automatic_match_allowed, true);
  for (const key of ['guowen-subject|国文课程', 'guoyu-subject|国语课程', 'data-analysis|数据分析能力']) {
    assert.equal(byForm.get(key).automatic_match_allowed, false, key);
  }
});

test('automatic relations have independently resolvable endpoint evidence and no semantic claim', () => {
  assert.ok(graph.relations.length > 0);
  for (const relation of graph.relations) {
    const source = episodes.get(relation.source);
    const target = episodes.get(relation.target);
    assert.ok(source && target);
    assert.ok(relation.source_evidence_ids.length > 0);
    assert.ok(relation.target_evidence_ids.length > 0);
    assert.ok(relation.source_evidence_ids.every((id) => source.evidence_ids.includes(id) && evidence.has(id)));
    assert.ok(relation.target_evidence_ids.every((id) => target.evidence_ids.includes(id) && evidence.has(id)));
    assert.equal(relation.semantic, false);
    assert.equal(relation.influence_claim_allowed, false);
    assert.ok(relationReviews.has(relation.relation_review_id));
    if (relation.type === 'next_observed') {
      assert.equal(source.concept_sense_id, target.concept_sense_id);
      assert.equal(source.curriculum_line.id, target.curriculum_line.id);
      assert.ok(target.time.year > source.time.year);
      assert.equal(relation.metric.interpretation, null);
    } else {
      assert.equal(relation.type, 'co_observed');
      assert.equal(relation.directionality, 'symmetric');
      assert.equal(relation.metric, null);
    }
  }
});

test('coverage and claim policy cannot assert first appearance or disappearance', () => {
  assert.equal(graph.coverage.negative_claim_eligible, false);
  assert.ok(graph.coverage_cells.every((cell) => cell.negative_claim_eligible === false && cell.alias_search_complete === false));
  for (const episode of graph.episodes) {
    assert.equal(episode.claim_policy.first_appearance_allowed, false);
    assert.equal(episode.claim_policy.disappearance_allowed, false);
    assert.equal(episode.claim_policy.historical_superlative_allowed, false);
  }
});

test('compendium observations require verified full-item boundaries and stay within their page range', () => {
  const ocrEvidence = graph.evidence.filter((item) => item.embedded_item_id !== null);
  const publishedBoundaries = compendiumBoundaries.documents.flatMap((document) => document.items
    .filter((item) => item.display_allowed)
    .map((item) => [item.item_id, { document, item }]));
  const boundaryById = new Map(publishedBoundaries);
  assert.equal(graph.coverage.compendium_item_candidates, 61);
  assert.equal(graph.coverage.compendium_display_verified_items, boundaryById.size);
  assert.equal(graph.embedded_items.length, boundaryById.size);
  for (const item of graph.embedded_items) {
    const boundary = boundaryById.get(item.id);
    assert.ok(boundary);
    assert.equal(item.identity_status, 'verified_full_item');
    assert.equal(item.physical_page_start, boundary.item.candidate_physical_page_start);
    assert.equal(item.physical_page_end, boundary.item.candidate_physical_page_end);
    assert.ok(item.physical_page_end >= item.physical_page_start);
  }
  for (const item of ocrEvidence) {
    const boundary = boundaryById.get(item.embedded_item_id);
    assert.ok(boundary);
    assert.ok(item.physical_pdf_page >= boundary.item.candidate_physical_page_start);
    assert.ok(item.physical_pdf_page <= boundary.item.candidate_physical_page_end);
    assert.equal(item.semantic_claim_allowed, false);
    if (item.citation_allowed) assert.equal(boundary.item.citation_allowed, true);
  }
});

test('subject facet is controlled while courses, frameworks, domains, and collections stay separate', () => {
  for (const episode of graph.episodes) {
    if (episode.subject.facet_eligible === true) {
      assert.ok(['subject', 'assessment_subject'].includes(episode.subject.entity_kind));
      assert.equal(episode.subject.facet_eligible, true);
      assert.ok(graph.subject_facets.includes(episode.subject.facet));
      assert.equal(episode.course_entity, null);
    } else {
      assert.equal(episode.subject.canonical, null);
      assert.equal(episode.subject.facet_eligible, false);
      assert.ok(episode.scope_entity.canonical);
      if (episode.scope_entity.entity_kind === 'curriculum_course') {
        assert.equal(episode.course_entity.entity_kind, 'curriculum_course');
        assert.equal(episode.course_entity.canonical, episode.scope_entity.canonical);
      } else assert.equal(episode.course_entity, null);
    }
  }
  assert.deepEqual(graph.subject_facets, ['语文', '数学', '外语', '思想政治与道德法治', '历史', '历史与社会', '地理', '科学类', '技术', '劳动', '艺术', '体育与健康']);
  assert.ok(graph.episodes.some((episode) => episode.scope_entity.entity_kind === 'cross_cutting_framework'));
  for (const value of ['课程方案', '考试大纲', '考试评价', '综合', '艺术与劳动']) {
    assert.notEqual(taxonomy.get(value).entity_kind, 'subject');
    assert.equal(taxonomy.get(value).facet_eligible, false);
  }
  assert.equal(taxonomy.get('综合实践活动').entity_kind, 'curriculum_course');
  assert.equal(taxonomy.get('综合实践活动').facet_eligible, false);
  assert.equal(taxonomy.get('综合实践活动').official_code, 'SB0801');
  assert.equal(taxonomy.get('综合实践活动').course_family, '综合实践课程');
  assert.equal(taxonomy.get('综合实践活动').family, null);
  assert.equal(taxonomy.get('汉语').entity_kind, 'assessment_subject');
  assert.equal(taxonomy.get('汉语').facet_eligible, true);
  assert.equal(taxonomy.get('汉语').classification, 'assessment_subject');
  assert.equal(taxonomy.get('汉语').canonical, '汉语');
  assert.equal(taxonomy.get('汉语').facet, '语文');
  assert.equal(taxonomy.get('普通高级中学 体育体育与健康').canonical, '体育与健康');
  assert.equal(taxonomy.get('初中科学').canonical, '科学');
  assert.equal(taxonomy.get('文科数学').course_variant, 'humanities_track');
  assert.equal(taxonomy.get('理科数学').course_variant, 'science_track');
  assert.equal(taxonomy.get('生物').stable_subject_id, taxonomy.get('生物学').stable_subject_id);
  assert.equal(taxonomy.get('信息技术').lineage_family, taxonomy.get('信息科技').lineage_family);
  assert.notEqual(taxonomy.get('信息技术').stable_subject_id, taxonomy.get('信息科技').stable_subject_id);
  for (const name of ['英语', '日语', '俄语', '德语', '法语', '西班牙语']) assert.equal(taxonomy.get(name).facet, '外语', name);
  for (const name of ['思想政治', '思想品德', '道德与法治', '品德与生活', '品德与社会']) assert.equal(taxonomy.get(name).facet, '思想政治与道德法治', name);
  for (const name of ['信息技术', '信息科技', '通用技术']) assert.equal(taxonomy.get(name).facet, '技术', name);
  for (const name of ['科学', '初中科学', '物理', '化学', '生物', '生物学']) assert.equal(taxonomy.get(name).facet, '科学类', name);
  assert.equal(subjectAudit.get('ictr-d692b0ff2e6c').canonical, '思想品德');
  assert.equal(subjectAudit.get('ictr-197f8a2e1cca').canonical, '音乐');
  const courseLabels = [
    '定向行走', '综合康复', '社会适应', '沟通与交往', '律动', '康复训练', '生活适应', '劳动技能',
    '运动与保健', '艺术休闲', '美工', '绘画与手工', '唱游与律动', '生活语文', '生活数学', '技术',
  ];
  for (const label of courseLabels) {
    assert.equal(taxonomy.get(label).entity_kind, 'curriculum_course', label);
    assert.equal(taxonomy.get(label).facet_eligible, false, label);
    assert.ok(taxonomy.get(label).stable_course_id, label);
    assert.ok(taxonomy.get(label).course_family, label);
    assert.ok(Array.isArray(graph.course_to_subject_links[label]), label);
  }
  const counts = {
    subject: graph.subject_entity_audit.filter((item) => item.facet_eligible).length,
    course: graph.subject_entity_audit.filter((item) => item.entity_kind === 'curriculum_course').length,
    scope: graph.subject_entity_audit.filter((item) => !item.facet_eligible && item.entity_kind !== 'curriculum_course').length,
  };
  assert.deepEqual(counts, { subject: 160, course: 16, scope: 20 });
});
