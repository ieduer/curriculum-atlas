import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXPECTED_SOURCE = Object.freeze({
  document_id: 'moe-2022-03',
  title: '义务教育语文课程标准（2022年版）',
  subject_facet: '语文',
  stage: '义务教育',
  school_type: 'ordinary_general_education',
  version_label: '2022年版',
  issued_by: '中华人民共和国教育部',
  source_artifact_sha256: '3ef0ec8a30b5a950211202658df07d99f5427f750f8ba0c3cfda12736b7bd71a',
  source_bytes: 20618661,
  page_count: 109,
  local_cache_path: '.cache/sources/moe-2022-03.pdf',
});

const EXPECTED_GROUPS = Object.freeze({
  'group:m0-root': { family: 'root', milestone: 'M0', node_type: 'subject_model_candidate', count: 1 },
  'group:m0-core-competency': { family: 'core_competency', milestone: 'M0', node_type: 'competency_candidate', count: 5 },
  'group:m0-overall-goals': { family: 'overall_goals', milestone: 'M0', node_type: 'overall_goal_candidate', count: 10 },
  'group:m0-practices': { family: 'practices', milestone: 'M0', node_type: 'practice_domain_candidate', count: 5 },
  'group:m0-themes': { family: 'themes', milestone: 'M0', node_type: 'content_theme_candidate', count: 4 },
  'group:m0-task-groups': { family: 'task_groups', milestone: 'M0', node_type: 'task_group_candidate', count: 10 },
  'group:m0-academic-quality': { family: 'academic_quality', milestone: 'M0', node_type: 'quality_structure_candidate', count: 8 },
  'group:m1-stage-requirements': { family: 'stage_requirements', milestone: 'M1', node_type: 'stage_requirement_candidate', count: 5 },
  'group:m1-stage-practice-clusters': {
    family: 'stage_practice_clusters',
    milestone: 'M1',
    node_type: 'stage_practice_requirement_cluster_candidate',
    count: 16,
  },
});

const EXPECTED_FAMILY_LABELS = Object.freeze({
  root: ['义务教育语文课程概念候选体系（2022年版）'],
  core_competency: ['核心素养', '文化自信', '语言运用', '思维能力', '审美创造'],
  overall_goals: ['总目标', ...Array.from({ length: 9 }, (_, index) => `总目标第${index + 1}项`)],
  practices: ['语文实践活动', '识字与写字', '阅读与鉴赏', '表达与交流', '梳理与探究'],
  themes: ['主题与载体形式', '中华优秀传统文化', '革命文化', '社会主义先进文化'],
  task_groups: [
    '语文学习任务群',
    '基础型学习任务群',
    '发展型学习任务群',
    '拓展型学习任务群',
    '语言文字积累与梳理',
    '实用性阅读与交流',
    '文学阅读与创意表达',
    '思辨性阅读与表达',
    '整本书阅读',
    '跨学科学习',
  ],
  academic_quality: [
    '学业质量',
    '第一学段学业质量',
    '第二学段学业质量',
    '第三学段学业质量',
    '第四学段学业质量',
    '日常生活情境',
    '文学体验情境',
    '跨学科学习情境',
  ],
  stage_requirements: ['学段要求', '第一学段要求', '第二学段要求', '第三学段要求', '第四学段要求'],
  stage_practice_clusters: Array.from({ length: 4 }, (_, stageIndex) => (
    ['识字与写字', '阅读与鉴赏', '表达与交流', '梳理与探究']
      .map((domain) => `第${['一', '二', '三', '四'][stageIndex]}学段·${domain}要求簇`)
  )).flat(),
});

const EXPECTED_LEXICAL_BINDINGS = Object.freeze({
  'candidate:zh-compulsory-2022-core-competency': 'core-competency',
  'candidate:zh-compulsory-2022-cultural-confidence': 'cultural-confidence',
  'candidate:zh-compulsory-2022-practice-literacy-writing': 'literacy-writing',
  'candidate:zh-compulsory-2022-practice-reading-appreciation': 'reading-appreciation',
  'candidate:zh-compulsory-2022-practice-expression-communication': 'expression-communication',
  'candidate:zh-compulsory-2022-practice-sorting-inquiry': 'sorting-inquiry',
  'candidate:zh-compulsory-2022-task-groups': 'learning-task-group',
  'candidate:zh-compulsory-2022-task-practical-reading': 'practical-reading-communication',
  'candidate:zh-compulsory-2022-task-speculative-reading': 'speculative-reading-expression',
  'candidate:zh-compulsory-2022-task-whole-book-reading': 'whole-book-reading',
  'candidate:zh-compulsory-2022-academic-quality': 'academic-quality',
});

const EXPECTED_ANCHORS = Object.freeze([
  'anchor:zh-compulsory-2022-toc-p006',
  'anchor:zh-compulsory-2022-course-nature-p008',
  'anchor:zh-compulsory-2022-core-competency-p011-p012',
  'anchor:zh-compulsory-2022-overall-goals-p013-p014',
  'anchor:zh-compulsory-2022-stage-requirements-p014-p023',
  'anchor:zh-compulsory-2022-themes-task-groups-p025-p027',
  'anchor:zh-compulsory-2022-task-language-p027',
  'anchor:zh-compulsory-2022-task-practical-p030',
  'anchor:zh-compulsory-2022-task-literary-p033',
  'anchor:zh-compulsory-2022-task-speculative-p036',
  'anchor:zh-compulsory-2022-task-whole-book-p038',
  'anchor:zh-compulsory-2022-task-cross-disciplinary-p041',
  'anchor:zh-compulsory-2022-quality-p044-p050',
]);

const EXPECTED_RISKS = Object.freeze([
  'risk:toc-body-confusion-p006',
  'risk:running-furniture',
  'risk:goal-stage-boundary-p013-p014',
  'risk:stage-range-segmentation-p014-p023',
  'risk:theme-task-boundary-p025-p027',
  'risk:task-group-heading-scope',
  'risk:quality-composite-segmentation-p044-p050',
  'risk:quality-stage-not-numbered-level',
  'risk:known-structured-table-defect-p075',
  'risk:known-running-header-defect-p109',
]);

const PRACTICE_TARGETS = Object.freeze({
  'literacy-writing': 'candidate:zh-compulsory-2022-practice-literacy-writing',
  'reading-appreciation': 'candidate:zh-compulsory-2022-practice-reading-appreciation',
  'expression-communication': 'candidate:zh-compulsory-2022-practice-expression-communication',
  'sorting-inquiry': 'candidate:zh-compulsory-2022-practice-sorting-inquiry',
});

const STAGE_REQUIREMENT_ANCHOR = 'anchor:zh-compulsory-2022-stage-requirements-p014-p023';
const ROOT_NODE_ID = 'candidate:zh-compulsory-2022';
const BLOCKED_PAGES = new Set([75, 109]);

function invariant(condition, message) {
  if (!condition) throw new Error(`Ontology candidate layer: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unique(values, label) {
  const set = new Set(values);
  invariant(set.size === values.length, `${label} contains duplicates`);
  return set;
}

function exactSet(actual, expected, label) {
  const actualSet = unique(actual, label);
  const expectedSet = new Set(expected);
  invariant(actualSet.size === expectedSet.size
    && [...expectedSet].every((value) => actualSet.has(value)), `${label} drift`);
}

function exactFalseObject(value, keys, label) {
  invariant(isObject(value), `${label} must be an object`);
  for (const key of keys) invariant(value[key] === false, `${label}.${key} must equal false`);
}

function validateSourceIdentity(layer, catalog) {
  const source = layer.source_identity;
  invariant(isObject(source), 'source_identity is missing');
  for (const [key, expected] of Object.entries(EXPECTED_SOURCE)) {
    invariant(source[key] === expected, `source_identity.${key} drift`);
  }
  invariant(source.citation_allowed === false, 'source identity must remain non-citable');
  invariant(source.online_same_edition_check?.exact_official_artifact_confirmed === true,
    'exact official artifact confirmation is missing');
  invariant(source.online_same_edition_check?.independent_online_text_confirmed === false,
    'independent online text must remain unconfirmed');
  invariant(source.online_same_edition_check?.status === 'artifact_match_only',
    'online same-edition status must remain artifact_match_only');

  const record = catalog?.documents?.find((item) => item.id === EXPECTED_SOURCE.document_id);
  invariant(record, `catalog record ${EXPECTED_SOURCE.document_id} is missing`);
  const catalogChecks = {
    title: EXPECTED_SOURCE.title,
    subject: EXPECTED_SOURCE.subject_facet,
    stage: EXPECTED_SOURCE.stage,
    version_label: EXPECTED_SOURCE.version_label,
    issued_by: EXPECTED_SOURCE.issued_by,
    checksum_sha256: EXPECTED_SOURCE.source_artifact_sha256,
    page_count: EXPECTED_SOURCE.page_count,
    local_cache_path: EXPECTED_SOURCE.local_cache_path,
    citation_allowed: false,
  };
  for (const [key, expected] of Object.entries(catalogChecks)) {
    invariant(record[key] === expected, `catalog ${EXPECTED_SOURCE.document_id}.${key} drift`);
  }
}

function validateIsolationAndRelease(layer) {
  invariant(layer.schema_version === 1, 'schema_version must equal 1');
  invariant(layer.candidate_layer_id === 'candidate-layer:zh-compulsory-2022-v1', 'candidate_layer_id drift');
  invariant(layer.publication_status === 'candidate_fail_closed', 'top-level publication must remain fail closed');

  const isolation = layer.version_isolation;
  invariant(isolation?.scope_id === 'candidate-scope:zh-compulsory-2022-ordinary', 'ordinary 2022 scope id drift');
  invariant(isolation?.exact_edition_only === true, 'exact-edition isolation is required');
  invariant(isolation?.ordinary_school_only === true, 'ordinary-school isolation is required');
  invariant(isolation?.cross_scope_merge_allowed === false, 'cross-scope merge must remain blocked');
  invariant(isolation?.same_label_implies_same_sense === false, 'same labels must not imply cross-version identity');
  exactSet(isolation?.forbidden_scope_ids || [], ['scope:zh-2016-blind', 'scope:zh-hs-2020'], 'forbidden_scope_ids');
  exactSet(isolation?.forbidden_document_ids || [], ['ictr-42b373aa14b0', 'moe-hs-2020-02'], 'forbidden_document_ids');
  exactSet(isolation?.forbidden_school_types || [], ['special_education_school_for_the_blind'], 'forbidden_school_types');
  exactSet(isolation?.forbidden_stages || [], ['高中'], 'forbidden_stages');

  exactFalseObject(layer.release_boundary, [
    'ontology_merge_allowed',
    'concept_evolution_build_allowed',
    'public_data_update_allowed',
    'publication_gate_changed',
    'deployment_allowed',
    'nodes_citation_allowed_must_equal',
    'relations_semantic_relation_allowed_must_equal',
  ], 'release_boundary');

  exactFalseObject(layer.semantic_guards, [
    'overall_goals_may_map_to_core_competency_dimensions',
    'quality_stage_descriptions_are_numbered_quality_levels',
    'quality_context_cross_disciplinary_node_may_equal_task_group_node',
    'language_use_may_bind_high_school_language_use_lexeme',
  ], 'semantic_guards');
  exactSet(layer.semantic_guards?.forbidden_quality_level_labels || [], [
    '学业质量水平一',
    '学业质量水平二',
    '学业质量水平三',
    '学业质量水平四',
    '学业质量水平五',
  ], 'forbidden_quality_level_labels');

  invariant(layer.milestones?.M0?.added_node_count === 43
    && layer.milestones?.M0?.cumulative_node_count === 43, 'M0 count contract drift');
  invariant(layer.milestones?.M1?.added_node_count === 21
    && layer.milestones?.M1?.cumulative_node_count === 64, 'M1 count contract drift');

  exactSet(layer.triangulation_policy?.required_parties || [], [
    'source_page_image',
    'ocr_text_with_independent_witness',
    'same_edition_online_text',
  ], 'triangulation required parties');
  invariant(layer.triangulation_policy?.exact_version_match_required === true,
    'exact version match must be required');
  invariant(layer.triangulation_policy?.unresolved_candidate_must_remain_non_citable === true,
    'unresolved candidates must remain non-citable');
  invariant(layer.triangulation_policy?.raw_image_is_truth_source === true,
    'source page image must remain the truth source');
}

function validatePageEvidence(layer) {
  exactSet((layer.page_risks || []).map((item) => item.id), EXPECTED_RISKS, 'page risk ids');
  const risks = new Map(layer.page_risks.map((risk) => [risk.id, risk]));
  for (const risk of layer.page_risks) {
    invariant(Array.isArray(risk.physical_pages) && risk.physical_pages.length > 0, `${risk.id} has no pages`);
    unique(risk.physical_pages, `${risk.id} pages`);
    for (const page of risk.physical_pages) {
      invariant(Number.isInteger(page) && page >= 1 && page <= EXPECTED_SOURCE.page_count, `${risk.id} page out of range`);
    }
    invariant(['medium', 'high', 'critical'].includes(risk.severity), `${risk.id} severity is invalid`);
    invariant(typeof risk.category === 'string' && risk.category.length > 0, `${risk.id} category is missing`);
    invariant(typeof risk.disposition === 'string' && risk.disposition.length > 0, `${risk.id} disposition is missing`);
  }

  const controlByPage = new Map((layer.excluded_page_controls || []).map((control) => [control.physical_page, control]));
  invariant(controlByPage.size === 2, 'excluded page controls must contain exactly pages 75 and 109');
  const expectedControls = {
    75: ['r6-structured-table-moe-2022-03-p075', 'row_alignment_verified'],
    109: ['r6-running-header-moe-2022-03-p109', 'running_header_removed'],
  };
  for (const [pageText, [controlId, attestation]] of Object.entries(expectedControls)) {
    const control = controlByPage.get(Number(pageText));
    invariant(control?.control_id === controlId, `excluded page ${pageText} control drift`);
    invariant(control?.required_attestation === attestation, `excluded page ${pageText} attestation drift`);
    invariant(control?.citation_allowed === false, `excluded page ${pageText} must remain non-citable`);
  }

  exactSet((layer.evidence_anchors || []).map((anchor) => anchor.id), EXPECTED_ANCHORS, 'evidence anchor ids');
  const anchors = new Map(layer.evidence_anchors.map((anchor) => [anchor.id, anchor]));
  for (const anchor of layer.evidence_anchors) {
    invariant(anchor.citation_allowed === false, `${anchor.id} must remain non-citable`);
    invariant(Array.isArray(anchor.physical_pages) && anchor.physical_pages.length > 0, `${anchor.id} has no physical pages`);
    unique(anchor.physical_pages, `${anchor.id} physical pages`);
    for (const page of anchor.physical_pages) {
      invariant(Number.isInteger(page) && page >= 1 && page <= EXPECTED_SOURCE.page_count, `${anchor.id} page out of range`);
      invariant(!BLOCKED_PAGES.has(page), `${anchor.id} references preemptively blocked page ${page}`);
    }
    invariant(Array.isArray(anchor.section_path) && anchor.section_path.length > 0, `${anchor.id} section path missing`);
    invariant(Array.isArray(anchor.candidate_terms) && anchor.candidate_terms.length > 0, `${anchor.id} candidate terms missing`);
    invariant(Array.isArray(anchor.risk_ids) && anchor.risk_ids.length > 0, `${anchor.id} risk ids missing`);
    for (const riskId of anchor.risk_ids) invariant(risks.has(riskId), `${anchor.id} references unknown risk ${riskId}`);
    const gate = anchor.triangulation_gate;
    invariant(gate?.source_page_image_status === 'pending_full_review', `${anchor.id} source image gate unexpectedly open`);
    invariant(gate?.ocr_text_status === 'candidate_unaccepted', `${anchor.id} OCR gate unexpectedly open`);
    invariant(gate?.same_edition_online_text_status === 'artifact_match_only_text_pending',
      `${anchor.id} online-text gate unexpectedly open`);
    invariant(gate?.version_match_status === 'verified_exact_artifact', `${anchor.id} version identity drift`);
    invariant(gate?.overall_status === 'blocked', `${anchor.id} overall gate must remain blocked`);
  }
  invariant(anchors.get('anchor:zh-compulsory-2022-toc-p006')?.evidence_role === 'navigation_only',
    'page 6 table of contents must remain navigation-only');
  return anchors;
}

function flattenNodes(layer) {
  invariant(Array.isArray(layer.node_groups), 'node_groups is missing');
  exactSet(layer.node_groups.map((group) => group.group_id), Object.keys(EXPECTED_GROUPS), 'node group ids');
  const records = [];
  for (const group of layer.node_groups) {
    const expected = EXPECTED_GROUPS[group.group_id];
    invariant(group.family === expected.family, `${group.group_id} family drift`);
    invariant(group.milestone === expected.milestone, `${group.group_id} milestone drift`);
    invariant(group.node_type === expected.node_type, `${group.group_id} node type drift`);
    invariant(Array.isArray(group.nodes) && group.nodes.length === expected.count, `${group.group_id} node count drift`);
    if (group.group_id === 'group:m0-root') {
      invariant(group.parent_relation_policy === null, 'root group must not declare a parent relation');
    } else {
      const relation = group.parent_relation_policy;
      invariant(isObject(relation), `${group.group_id} parent relation policy is missing`);
      invariant(relation.semantic_relation_allowed === false, `${group.group_id} semantic parent relation must remain blocked`);
      if (group.group_id === 'group:m1-stage-practice-clusters') {
        invariant(relation.relation_type_candidate === 'editorial_cluster_candidate'
          && relation.assertion_basis === 'editorial_model'
          && relation.review_status === 'reviewed_inference',
        'stage-practice cluster parent relation must remain a reviewed inference');
      } else {
        invariant(relation.relation_type_candidate === 'contains_candidate', `${group.group_id} relation type drift`);
        invariant(relation.review_status === 'candidate_extracted', `${group.group_id} relation review status drift`);
      }
    }
    records.push(...group.nodes.map((node) => ({
      ...node,
      family: group.family,
      milestone: group.milestone,
      node_type: group.node_type,
      parent_relation_policy: group.parent_relation_policy,
    })));
  }
  return records;
}

function validateNodes(layer, anchors, lexicon) {
  const nodes = flattenNodes(layer);
  const nodeIds = unique(nodes.map((node) => node.id), 'node ids');
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  invariant(nodes.length === 64, 'candidate node total must equal 64');
  invariant(nodes.filter((node) => node.milestone === 'M0').length === 43, 'M0 must contain exactly 43 nodes');
  invariant(nodes.filter((node) => node.milestone === 'M1').length === 21, 'M1 must add exactly 21 nodes');

  for (const [family, labels] of Object.entries(EXPECTED_FAMILY_LABELS)) {
    exactSet(nodes.filter((node) => node.family === family).map((node) => node.label), labels, `${family} labels`);
  }

  const rootNodes = nodes.filter((node) => node.parent_id === null);
  invariant(rootNodes.length === 1 && rootNodes[0].id === ROOT_NODE_ID, 'candidate layer must have exactly one root');
  let parentRelationCount = 0;
  for (const node of nodes) {
    invariant(/^candidate:zh-compulsory-2022/.test(node.id), `${node.id} escapes the version scope`);
    invariant(typeof node.label === 'string' && node.label.length > 0, `${node.id} label is missing`);
    invariant(node.citation_allowed === false, `${node.id} citation gate unexpectedly open`);
    invariant(node.publication_status === 'candidate_fail_closed', `${node.id} publication status unexpectedly open`);
    invariant(node.definition_candidate === null || typeof node.definition_candidate === 'string',
      `${node.id} definition_candidate is invalid`);
    invariant(Array.isArray(node.evidence_anchor_ids) && node.evidence_anchor_ids.length > 0,
      `${node.id} evidence anchors are missing`);
    for (const anchorId of node.evidence_anchor_ids) invariant(anchors.has(anchorId), `${node.id} unknown anchor ${anchorId}`);
    invariant(node.evidence_anchor_ids.some((anchorId) => anchors.get(anchorId)?.evidence_role !== 'navigation_only'),
      `${node.id} relies only on navigation evidence`);

    if (node.parent_id === null) {
      invariant(node.id === ROOT_NODE_ID && node.review_status === 'editorial_container',
        `${node.id} invalid root review state`);
    } else {
      parentRelationCount += 1;
      invariant(nodeIds.has(node.parent_id), `${node.id} parent ${node.parent_id} is missing`);
      invariant(node.parent_relation_policy?.semantic_relation_allowed === false,
        `${node.id} parent semantic relation unexpectedly open`);
      const parent = nodeById.get(node.parent_id);
      invariant((parent.milestone === 'M0' ? 0 : 1) <= (node.milestone === 'M0' ? 0 : 1),
        `${node.id} depends on a later milestone parent`);
    }
    if (node.family === 'stage_practice_clusters') {
      invariant(node.review_status === 'reviewed_inference', `${node.id} must remain reviewed_inference`);
    } else if (node.id !== ROOT_NODE_ID) {
      invariant(node.review_status === 'candidate_extracted', `${node.id} must remain candidate_extracted`);
    }
  }
  invariant(parentRelationCount === 63, 'candidate parent relation count must equal 63');

  for (const node of nodes) {
    const visited = new Set([node.id]);
    let cursor = node;
    while (cursor.parent_id !== null) {
      invariant(!visited.has(cursor.parent_id), `${node.id} parent cycle`);
      visited.add(cursor.parent_id);
      cursor = nodeById.get(cursor.parent_id);
    }
  }

  const lexicalPolicy = layer.lexical_reuse_policy;
  invariant(lexicalPolicy?.exact_reuse_only === true, 'lexical reuse must require exact identity');
  invariant(lexicalPolicy?.unspecified_binding_must_be_null === true, 'unspecified lexical bindings must be null');
  exactSet(lexicalPolicy?.allowed_lexical_concept_ids || [], Object.values(EXPECTED_LEXICAL_BINDINGS),
    'allowed lexical concept ids');
  exactSet(lexicalPolicy?.forbidden_lexical_concept_ids || [], ['language-use'], 'forbidden lexical concept ids');
  const lexiconIds = new Set((lexicon?.concepts || []).map((item) => item.id));
  for (const node of nodes) {
    const expected = EXPECTED_LEXICAL_BINDINGS[node.id] ?? null;
    invariant(node.lexical_concept_id === expected, `${node.id} lexical binding drift`);
    if (node.lexical_concept_id !== null) {
      invariant(lexiconIds.has(node.lexical_concept_id), `${node.id} lexical id missing from concept lexicon`);
      invariant(node.lexical_concept_id !== 'language-use', `${node.id} illegally reuses high-school language-use`);
    }
  }

  const goalFramework = 'candidate:zh-compulsory-2022-overall-goals';
  for (const node of nodes.filter((item) => /^candidate:zh-compulsory-2022-overall-goal-\d{2}$/.test(item.id))) {
    invariant(node.parent_id === goalFramework, `${node.id} must not be mapped to a core competency dimension`);
  }

  const forbiddenQualityLabels = new Set(layer.semantic_guards.forbidden_quality_level_labels);
  invariant(!nodes.some((node) => forbiddenQualityLabels.has(node.label)
    || /quality-level/.test(node.id)
    || node.node_type.includes('quality_level')), 'numbered quality levels leaked into the compulsory model');
  invariant(nodes.filter((node) => /^candidate:zh-compulsory-2022-quality-stage-[1-4]$/.test(node.id)).length === 4,
    'academic quality must contain four stage descriptions');

  const taskCross = nodeById.get('candidate:zh-compulsory-2022-task-cross-disciplinary-learning');
  const qualityCross = nodeById.get('candidate:zh-compulsory-2022-quality-context-cross-disciplinary-learning');
  invariant(taskCross && qualityCross && taskCross.id !== qualityCross.id, 'cross-disciplinary task and quality context must be distinct');
  invariant(taskCross.parent_id === 'candidate:zh-compulsory-2022-task-level-extension',
    'cross-disciplinary task group parent drift');
  invariant(qualityCross.parent_id === 'candidate:zh-compulsory-2022-academic-quality',
    'cross-disciplinary quality context parent drift');
  invariant(taskCross.lexical_concept_id === null && qualityCross.lexical_concept_id === null,
    'cross-disciplinary senses must not be silently unified through a lexeme');

  return { nodes, nodeById, parentRelationCount };
}

function validateEditorialAlignments(layer, nodeById, anchors) {
  invariant(Array.isArray(layer.editorial_alignments) && layer.editorial_alignments.length === 16,
    'editorial alignments must equal the four-by-four stage-practice matrix');
  unique(layer.editorial_alignments.map((item) => item.id), 'editorial alignment ids');
  const sourceCounts = new Map();
  const targetCounts = new Map();
  for (const alignment of layer.editorial_alignments) {
    invariant(alignment.relation_type_candidate === 'models_practice_domain_requirement_cluster',
      `${alignment.id} relation type drift`);
    invariant(alignment.assertion_basis === 'editorial_model', `${alignment.id} assertion basis drift`);
    invariant(alignment.review_status === 'reviewed_inference', `${alignment.id} must remain reviewed_inference`);
    invariant(alignment.semantic_relation_allowed === false, `${alignment.id} semantic relation unexpectedly open`);
    const source = nodeById.get(alignment.source);
    const target = nodeById.get(alignment.target);
    invariant(source?.family === 'stage_practice_clusters', `${alignment.id} source is not a stage-practice cluster`);
    invariant(target?.family === 'practices' && target.id !== 'candidate:zh-compulsory-2022-practices',
      `${alignment.id} target is not a concrete practice domain`);
    const match = alignment.source.match(/^candidate:zh-compulsory-2022-stage-([1-4])-(literacy-writing|reading-appreciation|expression-communication|sorting-inquiry)$/);
    invariant(match, `${alignment.id} source id is outside the four-by-four matrix`);
    invariant(alignment.target === PRACTICE_TARGETS[match[2]], `${alignment.id} target does not match its practice suffix`);
    invariant(source.parent_id === `candidate:zh-compulsory-2022-stage-requirement-${match[1]}`,
      `${alignment.id} source stage parent drift`);
    exactSet(alignment.evidence_anchor_ids || [], [STAGE_REQUIREMENT_ANCHOR], `${alignment.id} evidence anchors`);
    invariant(anchors.has(STAGE_REQUIREMENT_ANCHOR), `${alignment.id} stage requirement anchor missing`);
    sourceCounts.set(alignment.source, (sourceCounts.get(alignment.source) || 0) + 1);
    targetCounts.set(alignment.target, (targetCounts.get(alignment.target) || 0) + 1);
  }
  invariant(sourceCounts.size === 16 && [...sourceCounts.values()].every((count) => count === 1),
    'each stage-practice cluster must have exactly one editorial alignment');
  exactSet([...targetCounts.keys()], Object.values(PRACTICE_TARGETS), 'editorial alignment practice targets');
  invariant([...targetCounts.values()].every((count) => count === 4),
    'each practice domain must receive exactly four stage alignments');
}

export function validateCandidateLayer(layer, { catalog, lexicon } = {}) {
  invariant(isObject(layer), 'candidate layer must be an object');
  invariant(isObject(catalog), 'catalog is required');
  invariant(isObject(lexicon), 'concept lexicon is required');
  validateSourceIdentity(layer, catalog);
  validateIsolationAndRelease(layer);
  const anchors = validatePageEvidence(layer);
  const { nodes, nodeById, parentRelationCount } = validateNodes(layer, anchors, lexicon);
  validateEditorialAlignments(layer, nodeById, anchors);

  const familyCounts = Object.fromEntries(Object.keys(EXPECTED_FAMILY_LABELS)
    .map((family) => [family, nodes.filter((node) => node.family === family).length]));
  return {
    valid: true,
    candidate_layer_id: layer.candidate_layer_id,
    document_id: layer.source_identity.document_id,
    source_artifact_sha256: layer.source_identity.source_artifact_sha256,
    publication_status: layer.publication_status,
    m0_nodes: nodes.filter((node) => node.milestone === 'M0').length,
    m1_added_nodes: nodes.filter((node) => node.milestone === 'M1').length,
    cumulative_nodes: nodes.length,
    parent_relation_candidates: parentRelationCount,
    editorial_alignment_candidates: layer.editorial_alignments.length,
    semantic_relations_allowed: 0,
    citation_allowed_nodes: 0,
    evidence_anchors: anchors.size,
    excluded_pages: [...BLOCKED_PAGES].sort((a, b) => a - b),
    family_counts: familyCounts,
  };
}

export async function verifyLocalSource(sourcePath, sourceIdentity) {
  const [bytes, metadata] = await Promise.all([readFile(sourcePath), stat(sourcePath)]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  invariant(metadata.size === sourceIdentity.source_bytes, `local source byte count drift: ${metadata.size}`);
  invariant(sha256 === sourceIdentity.source_artifact_sha256, `local source SHA-256 drift: ${sha256}`);
  return { source_path: path.resolve(sourcePath), source_bytes: metadata.size, source_sha256: sha256 };
}

function parseArgs(argv) {
  const allowed = new Set(['--candidate', '--catalog', '--lexicon', '--source']);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    invariant(allowed.has(key), `unknown argument ${key}`);
    invariant(typeof value === 'string' && value.length > 0, `${key} requires a value`);
    values[key.slice(2)] = value;
  }
  return values;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = parseArgs(process.argv.slice(2));
  const candidatePath = path.resolve(root, args.candidate || 'data/ontology-candidates/zh-compulsory-2022.json');
  const catalogPath = path.resolve(root, args.catalog || 'data/catalog.json');
  const lexiconPath = path.resolve(root, args.lexicon || 'data/concept-lexicon.json');
  const [layer, catalog, lexicon] = await Promise.all(
    [candidatePath, catalogPath, lexiconPath].map((file) => readFile(file, 'utf8').then(JSON.parse)),
  );
  const report = validateCandidateLayer(layer, { catalog, lexicon });
  if (args.source) report.local_source = await verifyLocalSource(path.resolve(root, args.source), layer.source_identity);
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
