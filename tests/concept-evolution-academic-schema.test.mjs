import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const core = JSON.parse(await readFile(new URL('public/data/concept-evolution.json', root), 'utf8'));
const graph = JSON.parse(await readFile(new URL('public/data/concept-evolution-academic.json', root), 'utf8'));
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
  ]) assert.ok(Array.isArray(graph[name]), `${name} missing`);
  assert.deepEqual(graph.edges.map((edge) => edge.id), graph.relations.map((relation) => relation.id));
});

test('entity IDs are unique and occurrence evidence is referentially complete', () => {
  for (const name of [
    'concepts', 'concept_senses', 'surface_forms', 'curriculum_lines', 'works', 'editions',
    'revisions', 'embedded_items', 'occurrences', 'episodes', 'relations', 'relation_reviews',
    'evidence', 'coverage_cells',
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

test('OCR page fragments remain incomplete and non-quotable', () => {
  assert.ok(graph.embedded_items.length > 0);
  const ocrEvidence = graph.evidence.filter((item) => item.embedded_item_id !== null);
  assert.ok(ocrEvidence.length > 0);
  assert.ok(ocrEvidence.every((item) => item.citation_allowed === false
    && item.citation_gate.document_allowed === false
    && item.citation_gate.paragraph_allowed === false));
  for (const item of graph.embedded_items) {
    assert.equal(item.physical_page_start, item.physical_page_end);
    assert.match(item.identity_status, /page_fragment/);
  }
});

test('subject facet is controlled and excludes frameworks, assessment, and collections', () => {
  for (const episode of graph.episodes) {
    if (episode.subject.entity_kind === 'subject') {
      assert.equal(episode.subject.facet_eligible, true);
      assert.ok(graph.subject_facets.includes(episode.subject.canonical));
    } else {
      assert.equal(episode.subject.canonical, null);
      assert.equal(episode.subject.facet_eligible, false);
      assert.ok(episode.scope_entity.canonical);
    }
  }
  assert.ok(graph.episodes.some((episode) => episode.scope_entity.entity_kind === 'cross_cutting_framework'));
  for (const value of ['课程方案', '考试大纲', '考试评价', '综合', '艺术与劳动']) {
    assert.notEqual(taxonomy.get(value).entity_kind, 'subject');
    assert.equal(taxonomy.get(value).facet_eligible, false);
  }
  assert.equal(taxonomy.get('综合实践活动').official_code, 'SB0801');
  assert.equal(taxonomy.get('综合实践活动').lineage_family, '综合实践活动');
  assert.equal(taxonomy.get('综合实践活动').family, null);
  assert.equal(taxonomy.get('汉语').classification, 'assessment_subject');
  assert.equal(taxonomy.get('汉语').canonical, '汉语');
  assert.equal(taxonomy.get('普通高级中学 体育体育与健康').canonical, '体育与健康');
  assert.equal(taxonomy.get('初中科学').canonical, '科学');
  assert.equal(taxonomy.get('文科数学').course_variant, 'humanities_track');
  assert.equal(taxonomy.get('理科数学').course_variant, 'science_track');
  assert.equal(taxonomy.get('生物').stable_subject_id, taxonomy.get('生物学').stable_subject_id);
  assert.equal(taxonomy.get('信息技术').lineage_family, taxonomy.get('信息科技').lineage_family);
  assert.notEqual(taxonomy.get('信息技术').stable_subject_id, taxonomy.get('信息科技').stable_subject_id);
  assert.equal(subjectAudit.get('ictr-d692b0ff2e6c').canonical, '思想品德');
  assert.equal(subjectAudit.get('ictr-197f8a2e1cca').canonical, '音乐');
});
