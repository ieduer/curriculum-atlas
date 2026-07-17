import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { validateCandidateLayer } from '../scripts/validate-ontology-candidate-layer.mjs';

const projectRoot = new URL('../', import.meta.url);
const [layer, schema, catalog, lexicon] = await Promise.all([
  readFile(new URL('data/ontology-candidates/zh-compulsory-2022.json', projectRoot), 'utf8').then(JSON.parse),
  readFile(new URL('data/ontology-candidates/candidate-layer.schema.json', projectRoot), 'utf8').then(JSON.parse),
  readFile(new URL('data/catalog.json', projectRoot), 'utf8').then(JSON.parse),
  readFile(new URL('data/concept-lexicon.json', projectRoot), 'utf8').then(JSON.parse),
]);

function validate(value) {
  return validateCandidateLayer(value, { catalog, lexicon });
}

function nodes(value = layer) {
  return value.node_groups.flatMap((group) => group.nodes.map((node) => ({
    ...node,
    family: group.family,
    milestone: group.milestone,
    node_type: group.node_type,
    relation: group.parent_relation_policy,
  })));
}

test('2022 ordinary compulsory Chinese candidate layer validates as M0 43 and M1 cumulative 64', () => {
  const report = validate(layer);
  assert.deepEqual({
    valid: report.valid,
    m0: report.m0_nodes,
    m1Added: report.m1_added_nodes,
    total: report.cumulative_nodes,
    parentRelations: report.parent_relation_candidates,
    editorialAlignments: report.editorial_alignment_candidates,
  }, {
    valid: true,
    m0: 43,
    m1Added: 21,
    total: 64,
    parentRelations: 63,
    editorialAlignments: 16,
  });
  assert.deepEqual(report.family_counts, {
    root: 1,
    core_competency: 5,
    overall_goals: 10,
    practices: 5,
    themes: 4,
    task_groups: 10,
    academic_quality: 8,
    stage_requirements: 5,
    stage_practice_clusters: 16,
  });
});

test('schema and data bind the exact moe-2022-03 artifact and remain publication-ineligible', () => {
  assert.equal(schema.properties.source_identity.properties.document_id.const, 'moe-2022-03');
  assert.equal(schema.properties.source_identity.properties.source_artifact_sha256.const,
    '3ef0ec8a30b5a950211202658df07d99f5427f750f8ba0c3cfda12736b7bd71a');
  assert.equal(schema.properties.source_identity.properties.page_count.const, 109);
  assert.equal(schema.properties.publication_status.const, 'candidate_fail_closed');
  assert.equal(schema.$defs.candidateNode.properties.citation_allowed.const, false);
  assert.equal(schema.$defs.editorialAlignment.properties.semantic_relation_allowed.const, false);
  assert.equal(layer.release_boundary.ontology_merge_allowed, false);
  assert.equal(layer.release_boundary.public_data_update_allowed, false);
  assert.equal(layer.release_boundary.publication_gate_changed, false);
  assert.equal(layer.release_boundary.deployment_allowed, false);
});

test('every node and every candidate relationship is fail closed', () => {
  const allNodes = nodes();
  assert.equal(allNodes.length, 64);
  assert.ok(allNodes.every((node) => node.citation_allowed === false));
  assert.ok(allNodes.every((node) => node.publication_status === 'candidate_fail_closed'));
  assert.ok(allNodes.filter((node) => node.parent_id !== null)
    .every((node) => node.relation.semantic_relation_allowed === false));
  assert.ok(layer.editorial_alignments.every((relation) => relation.semantic_relation_allowed === false));
  assert.ok(layer.editorial_alignments.every((relation) => relation.review_status === 'reviewed_inference'));
});

test('version isolation excludes blind-school and high-school ontology scopes', () => {
  assert.equal(layer.version_isolation.scope_id, 'candidate-scope:zh-compulsory-2022-ordinary');
  assert.equal(layer.version_isolation.exact_edition_only, true);
  assert.equal(layer.version_isolation.ordinary_school_only, true);
  assert.equal(layer.version_isolation.cross_scope_merge_allowed, false);
  assert.ok(layer.version_isolation.forbidden_scope_ids.includes('scope:zh-2016-blind'));
  assert.ok(layer.version_isolation.forbidden_scope_ids.includes('scope:zh-hs-2020'));
  assert.ok(layer.version_isolation.forbidden_document_ids.includes('moe-hs-2020-02'));
  assert.ok(layer.version_isolation.forbidden_school_types.includes('special_education_school_for_the_blind'));
});

test('quality stages are not high-school quality levels and cross-disciplinary senses stay separate', () => {
  const byId = new Map(nodes().map((node) => [node.id, node]));
  const qualityStages = nodes().filter((node) => /^candidate:zh-compulsory-2022-quality-stage-[1-4]$/.test(node.id));
  assert.equal(qualityStages.length, 4);
  assert.ok(qualityStages.every((node) => node.label.endsWith('学段学业质量')));
  assert.equal(nodes().some((node) => /学业质量水平[一二三四五]/.test(node.label)), false);
  assert.equal(nodes().some((node) => node.node_type.includes('quality_level')), false);

  const task = byId.get('candidate:zh-compulsory-2022-task-cross-disciplinary-learning');
  const context = byId.get('candidate:zh-compulsory-2022-quality-context-cross-disciplinary-learning');
  assert.notEqual(task.id, context.id);
  assert.equal(task.parent_id, 'candidate:zh-compulsory-2022-task-level-extension');
  assert.equal(context.parent_id, 'candidate:zh-compulsory-2022-academic-quality');
  assert.equal(task.lexical_concept_id, null);
  assert.equal(context.lexical_concept_id, null);
});

test('lexical reuse is exact and language use does not inherit the high-school language-use sense', () => {
  const bound = new Map(nodes().filter((node) => node.lexical_concept_id !== null)
    .map((node) => [node.id, node.lexical_concept_id]));
  assert.equal(bound.size, 11);
  assert.equal(bound.get('candidate:zh-compulsory-2022-core-competency'), 'core-competency');
  assert.equal(bound.get('candidate:zh-compulsory-2022-cultural-confidence'), 'cultural-confidence');
  assert.equal(bound.get('candidate:zh-compulsory-2022-practice-literacy-writing'), 'literacy-writing');
  assert.equal(bound.get('candidate:zh-compulsory-2022-practice-reading-appreciation'), 'reading-appreciation');
  assert.equal(bound.get('candidate:zh-compulsory-2022-practice-expression-communication'), 'expression-communication');
  assert.equal(bound.get('candidate:zh-compulsory-2022-practice-sorting-inquiry'), 'sorting-inquiry');
  assert.equal(bound.get('candidate:zh-compulsory-2022-task-groups'), 'learning-task-group');
  assert.equal(bound.get('candidate:zh-compulsory-2022-task-practical-reading'), 'practical-reading-communication');
  assert.equal(bound.get('candidate:zh-compulsory-2022-task-speculative-reading'), 'speculative-reading-expression');
  assert.equal(bound.get('candidate:zh-compulsory-2022-task-whole-book-reading'), 'whole-book-reading');
  assert.equal(bound.get('candidate:zh-compulsory-2022-academic-quality'), 'academic-quality');
  assert.equal(nodes().find((node) => node.id === 'candidate:zh-compulsory-2022-language-use').lexical_concept_id, null);
  assert.equal([...bound.values()].includes('language-use'), false);
});

test('page evidence has image, OCR, same-edition online and version gates, with pages 75 and 109 excluded', () => {
  for (const anchor of layer.evidence_anchors) {
    assert.equal(anchor.citation_allowed, false);
    assert.equal(anchor.triangulation_gate.source_page_image_status, 'pending_full_review');
    assert.equal(anchor.triangulation_gate.ocr_text_status, 'candidate_unaccepted');
    assert.equal(anchor.triangulation_gate.same_edition_online_text_status, 'artifact_match_only_text_pending');
    assert.equal(anchor.triangulation_gate.version_match_status, 'verified_exact_artifact');
    assert.equal(anchor.triangulation_gate.overall_status, 'blocked');
    assert.equal(anchor.physical_pages.some((page) => page === 75 || page === 109), false);
  }
  assert.deepEqual(layer.excluded_page_controls.map((control) => [
    control.physical_page,
    control.control_id,
    control.required_attestation,
  ]), [
    [75, 'r6-structured-table-moe-2022-03-p075', 'row_alignment_verified'],
    [109, 'r6-running-header-moe-2022-03-p109', 'running_header_removed'],
  ]);
});

test('validator rejects any attempt to open citation, semantics, version scope or quality-level contamination', () => {
  const citationOpen = structuredClone(layer);
  citationOpen.node_groups[1].nodes[0].citation_allowed = true;
  assert.throws(() => validate(citationOpen), /citation gate unexpectedly open/);

  const semanticOpen = structuredClone(layer);
  semanticOpen.editorial_alignments[0].semantic_relation_allowed = true;
  assert.throws(() => validate(semanticOpen), /semantic relation unexpectedly open/);

  const highSchoolBinding = structuredClone(layer);
  highSchoolBinding.node_groups[1].nodes[2].lexical_concept_id = 'language-use';
  assert.throws(() => validate(highSchoolBinding), /lexical binding drift/);

  const qualityLevelLeak = structuredClone(layer);
  qualityLevelLeak.node_groups[6].nodes[1].label = '学业质量水平一';
  assert.throws(() => validate(qualityLevelLeak), /academic_quality labels drift|numbered quality levels leaked/);

  const blockedPageEvidence = structuredClone(layer);
  blockedPageEvidence.evidence_anchors[0].physical_pages = [75];
  assert.throws(() => validate(blockedPageEvidence), /references preemptively blocked page 75/);

  const wrongSource = structuredClone(layer);
  wrongSource.source_identity.source_artifact_sha256 = '0'.repeat(64);
  assert.throws(() => validate(wrongSource), /source_identity.source_artifact_sha256 drift/);
});

test('stage-practice requirement clusters remain a complete reviewed-inference four-by-four matrix', () => {
  const clusters = nodes().filter((node) => node.family === 'stage_practice_clusters');
  assert.equal(clusters.length, 16);
  assert.ok(clusters.every((node) => node.review_status === 'reviewed_inference'));
  assert.ok(clusters.every((node) => node.relation.review_status === 'reviewed_inference'));
  assert.ok(clusters.every((node) => node.relation.semantic_relation_allowed === false));

  const sourceCounts = new Map();
  const targetCounts = new Map();
  for (const alignment of layer.editorial_alignments) {
    sourceCounts.set(alignment.source, (sourceCounts.get(alignment.source) || 0) + 1);
    targetCounts.set(alignment.target, (targetCounts.get(alignment.target) || 0) + 1);
  }
  assert.equal(sourceCounts.size, 16);
  assert.ok([...sourceCounts.values()].every((count) => count === 1));
  assert.equal(targetCounts.size, 4);
  assert.ok([...targetCounts.values()].every((count) => count === 4));
});
