import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const EXPECTED_SHA256 = '3ef0ec8a30b5a950211202658df07d99f5427f750f8ba0c3cfda12736b7bd71a';
const PRIMARY_SOURCE_ID = 'source:moe-2022-chinese-pdf';
const MIRROR_SOURCE_ID = 'source:ictr-2022-chinese-pdf';

const EXPECTED_CORE_TERMS = [
  '文化自信',
  '语言运用',
  '思维能力',
  '审美创造',
];

const EXPECTED_PRACTICES = [
  '识字与写字',
  '阅读与鉴赏',
  '表达与交流',
  '梳理与探究',
];

const EXPECTED_TASK_GROUPS = [
  '语言文字积累与梳理',
  '实用性阅读与交流',
  '文学阅读与创意表达',
  '思辨性阅读与表达',
  '整本书阅读',
  '跨学科学习',
];

const EXPECTED_TASK_STRUCTURE = [
  {
    label: '基础型学习任务群',
    members: ['语言文字积累与梳理'],
  },
  {
    label: '发展型学习任务群',
    members: ['实用性阅读与交流', '文学阅读与创意表达', '思辨性阅读与表达'],
  },
  {
    label: '拓展型学习任务群',
    members: ['整本书阅读', '跨学科学习'],
  },
];

const EXPECTED_STAGES = [
  '第一学段（1～2年级）',
  '第二学段（3～4年级）',
  '第三学段（5～6年级）',
  '第四学段（7～9年级）',
];

const EXPECTED_CONTEXTS = [
  '日常生活',
  '文学体验',
  '跨学科学习',
];

const EXPECTED_GOALS = [
  '在语文学习过程中，培养爱国主义、集体主义、社会主义思想道德，逐步形成正确的世界观、人生观、价值观。',
  '热爱国家通用语言文字，感受语言文字及作品的独特价值，认识中华文化的丰厚博大，汲取智慧，弘扬社会主义先进文化、革命文化、中华优秀传统文化，建立文化自信。',
  '关心社会文化生活，积极参与和组织校园、社区等文化活动，发展交流、合作、探究等实践能力，增强社会责任意识。感受多样文化，吸收人类优秀文化的精华。',
  '认识和书写常用汉字，学会汉语拼音，能说普通话。主动积累、梳理基本的语言材料和语言经验，逐步形成良好的语感，初步领悟语言文字运用规律。学会使用常用的语文工具书，运用多种媒介学习语文，初步掌握基本的语文学习方法，养成良好的学习习惯。',
  '学会运用多种阅读方法，具有独立阅读能力。能阅读日常的书报杂志，初步鉴赏文学作品，能借助工具书阅读浅易文言文。学会倾听与表达，初步学会用口头语言文明地进行人际沟通和社会交往。能根据需要，用书面语言具体明确、文从字顺地表达自己的见闻、体验和想法。',
  '积极观察、感知生活，发展联想和想象，激发创造潜能，丰富语言经验，培养语言直觉，提高语言表现力和创造力，提高形象思维能力。',
  '乐于探索，勤于思考，初步掌握比较、分析、概括、推理等思维方法，辩证地思考问题，有理有据、负责任地表达自己的观点，养成实事求是、崇尚真知的态度。',
  '感受语言文字的美，感悟作品的思想内涵和艺术价值，能结合自己的经验，理解、欣赏和初步评价语言文字作品，丰富自己的情感体验和精神世界。',
  '能借助不同媒介表达自己的见闻和感受，学习发现美、表现美和创造美，形成健康的审美情趣。',
];

const EXPECTED_CLAIM_IDS = [
  'claim:core-competencies',
  'claim:language-practices',
  'claim:learning-task-groups',
  'claim:academic-quality-stages',
  'claim:academic-quality-contexts',
  'claim:overall-goals',
];

const EXPECTED_CONFLICTS = new Map([
  ['conflict:page-9-life-basis', {
    page: 9,
    kind: 'local_ocr_omission',
    rejected: '以生活基础',
    accepted: '以生活为基础',
  }],
  ['conflict:page-9-task-carrier', {
    page: 9,
    kind: 'local_ocr_omission',
    rejected: '以学习任务载体',
    accepted: '以学习任务为载体',
  }],
  ['conflict:page-13-culture-word', {
    page: 13,
    kind: 'local_ocr_substitution',
    rejected: '感受多样化',
    accepted: '感受多样文化',
  }],
  ['conflict:page-13-goal6-raise', {
    page: 13,
    kind: 'online_transcription_variant',
    rejected: '提升形象思维能力',
    accepted: '提高形象思维能力',
  }],
  ['conflict:page-44-quality-basis', {
    page: 44,
    kind: 'local_ocr_omission',
    rejected: '核心素养评价提供基本依据',
    accepted: '为核心素养评价提供基本依据',
  }],
]);

const EXPECTED_MISMATCHES = new Map([
  ['source:hep-2025-revision', 'edition_revision'],
  ['source:moe-highschool-2020', 'education_stage'],
  ['source:ictr-blindschool-2016', 'school_type'],
]);

const EXPECTED_FORBIDDEN_USES = [
  'wording_adjudication',
  'concept_identity_merge',
  'publication_unlock',
];

const EXPECTED_ALIGNMENT = [
  { goal_numbers: [1], target_label: '立德树人' },
  { goal_numbers: [2, 3], target_label: '文化自信' },
  { goal_numbers: [4, 5], target_label: '语言运用' },
  { goal_numbers: [6, 7], target_label: '思维能力' },
  { goal_numbers: [8, 9], target_label: '审美创造' },
];

function jsonPointer(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported schema reference: ${ref}`);
  return ref
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((value, part) => value?.[part], root);
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function schemaErrors(value, schema, rootSchema, path = '$') {
  const errors = [];
  const add = (message) => errors.push(`${path}: ${message}`);

  if (schema.$ref) {
    const target = jsonPointer(rootSchema, schema.$ref);
    if (!target) return [`${path}: unresolved schema reference ${schema.$ref}`];
    return schemaErrors(value, target, rootSchema, path);
  }

  if (schema.oneOf) {
    const branchResults = schema.oneOf.map((branch) => schemaErrors(value, branch, rootSchema, path));
    const matchingBranches = branchResults.filter((branch) => branch.length === 0).length;
    if (matchingBranches !== 1) add(`must match exactly one oneOf branch; matched ${matchingBranches}`);
    return errors;
  }

  if ('const' in schema && !isDeepStrictEqual(value, schema.const)) {
    add(`must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((entry) => isDeepStrictEqual(value, entry))) {
    add(`must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`);
  }

  if (schema.type) {
    const actualType = valueType(value);
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowedTypes.includes(actualType)) {
      add(`must be type ${allowedTypes.join('|')}; received ${actualType}`);
      return errors;
    }
  }

  if (valueType(value) === 'object') {
    for (const requiredKey of schema.required || []) {
      if (!(requiredKey in value)) errors.push(`${path}.${requiredKey}: required property is missing`);
    }
    if (schema.additionalProperties === false) {
      const allowedKeys = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) {
        if (!allowedKeys.has(key)) errors.push(`${path}.${key}: additional property is forbidden`);
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (key in value) errors.push(...schemaErrors(value[key], childSchema, rootSchema, `${path}.${key}`));
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) add(`must contain at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) add(`must contain at most ${schema.maxItems} items`);
    if (schema.uniqueItems) {
      const serialized = value.map((item) => JSON.stringify(item));
      if (new Set(serialized).size !== serialized.length) add('must contain unique items');
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...schemaErrors(item, schema.items, rootSchema, `${path}[${index}]`));
      });
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) add(`must have length >= ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) add(`must match ${schema.pattern}`);
    if (schema.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) add('must use YYYY-MM-DD date format');
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) add(`must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) add(`must be <= ${schema.maximum}`);
  }

  return errors;
}

function orderedEqual(actual, expected) {
  return isDeepStrictEqual(actual, expected);
}

function setEqual(actual, expected) {
  return actual.length === expected.length
    && actual.every((item) => expected.includes(item));
}

function collectPublicationUnlocks(value, path = '$', result = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPublicationUnlocks(item, `${path}[${index}]`, result));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'publication_unlock') result.push({ path: `${path}.${key}`, value: child });
      collectPublicationUnlocks(child, `${path}.${key}`, result);
    }
  }
  return result;
}

function semanticErrors(artifact, schema) {
  const errors = [];
  const check = (condition, code, detail) => {
    if (!condition) errors.push(`${code}: ${detail}`);
  };

  const sources = new Map((artifact.sources || []).map((source) => [source.source_id, source]));
  const claims = new Map((artifact.claims || []).map((claim) => [claim.claim_id, claim]));
  const conflicts = new Map((artifact.transcription_conflicts || []).map((conflict) => [conflict.conflict_id, conflict]));

  check(sources.size === (artifact.sources || []).length, 'duplicate_source_id', 'source_id values must be unique');
  check(claims.size === (artifact.claims || []).length, 'duplicate_claim_id', 'claim_id values must be unique');
  check(conflicts.size === (artifact.transcription_conflicts || []).length, 'duplicate_conflict_id', 'conflict_id values must be unique');
  check(orderedEqual([...claims.keys()], EXPECTED_CLAIM_IDS), 'claim_inventory_drift', 'the six claim IDs and their order are fixed');

  const primary = sources.get(PRIMARY_SOURCE_ID);
  check(Boolean(primary), 'missing_primary_source', PRIMARY_SOURCE_ID);
  check(primary?.evidence_role === 'primary_artifact', 'primary_role_drift', 'primary source must remain primary_artifact');
  check(primary?.artifact_sha256 === EXPECTED_SHA256, 'primary_sha256_drift', 'primary PDF SHA-256 changed');
  check(primary?.version_relation === 'exact_2022_edition', 'primary_version_drift', 'primary source must remain exact 2022 edition');
  check(primary?.independent_text_decision === false, 'primary_independence_error', 'primary artifact cannot count as its own independent online witness');

  const mirror = sources.get(MIRROR_SOURCE_ID);
  check(Boolean(mirror), 'missing_same_artifact_mirror', MIRROR_SOURCE_ID);
  check(mirror?.evidence_role === 'same_artifact_mirror', 'mirror_role_drift', 'ICTR copy must remain same_artifact_mirror');
  check(mirror?.artifact_sha256 === EXPECTED_SHA256, 'mirror_sha256_drift', 'ICTR mirror SHA-256 must equal primary');
  check(mirror?.same_artifact_as === PRIMARY_SOURCE_ID, 'mirror_identity_drift', 'ICTR mirror must point to the MOE primary artifact');
  check(mirror?.independent_text_decision === false, 'mirror_independence_error', 'same-artifact mirror cannot count as independent evidence');

  check((artifact.artifact_equivalence || []).length === 1, 'artifact_equivalence_count', 'exactly one MOE/ICTR equivalence record is required');
  const equivalence = artifact.artifact_equivalence?.[0];
  check(equivalence?.canonical_source_id === PRIMARY_SOURCE_ID, 'equivalence_primary_drift', 'unexpected canonical source');
  check(equivalence?.mirror_source_id === MIRROR_SOURCE_ID, 'equivalence_mirror_drift', 'unexpected mirror source');
  check(equivalence?.sha256 === EXPECTED_SHA256, 'equivalence_sha256_drift', 'equivalence SHA-256 changed');
  check(equivalence?.classification === 'same_artifact_mirror', 'equivalence_classification_drift', 'mirror classification changed');
  check(equivalence?.independent_evidence_increment === 0, 'mirror_evidence_inflation', 'same-artifact mirror must add zero independent evidence');

  for (const source of artifact.sources || []) {
    check(source.url?.startsWith('https://'), 'non_https_source', source.source_id);
    check(source.publication_unlock === false, 'source_unlock_forbidden', source.source_id);
    if (source.independent_text_decision) {
      check(source.evidence_role === 'independent_text', 'invalid_independent_source_role', source.source_id);
      check(source.version_relation === 'exact_2022_edition', 'invalid_independent_source_version', source.source_id);
      check(source.artifact_sha256 === null, 'independent_source_artifact_confusion', source.source_id);
    }
    if (source.evidence_role === 'version_mismatch' || source.evidence_role === 'same_artifact_mirror') {
      check(source.independent_text_decision === false, 'quarantined_source_promoted', source.source_id);
    }
  }

  for (const claim of artifact.claims || []) {
    check(claim.normative === true, 'claim_normative_drift', claim.claim_id);
    check(claim.publication_unlock === false, 'claim_unlock_forbidden', claim.claim_id);
    for (const item of claim.ordered_items || []) {
      check(item.publication_unlock === false, 'ordered_item_unlock_forbidden', `${claim.claim_id} item ${item.position}`);
    }
    for (const conflictId of claim.conflict_ids || []) {
      check(conflicts.has(conflictId), 'unknown_claim_conflict', `${claim.claim_id}: ${conflictId}`);
    }
    for (const crosscheck of claim.crosschecks || []) {
      const source = sources.get(crosscheck.source_id);
      check(Boolean(source), 'unknown_crosscheck_source', `${claim.claim_id}: ${crosscheck.source_id}`);
      if (crosscheck.role === 'independent_exact_support') {
        check(crosscheck.independent_for_claim === true, 'independent_crosscheck_flag_error', `${claim.claim_id}: ${crosscheck.source_id}`);
        check(source?.independent_text_decision === true, 'independent_crosscheck_source_error', `${claim.claim_id}: ${crosscheck.source_id}`);
        check(source?.version_relation === 'exact_2022_edition', 'independent_crosscheck_version_error', `${claim.claim_id}: ${crosscheck.source_id}`);
      }
      check(source?.evidence_role !== 'version_mismatch', 'version_mismatch_used_for_claim', `${claim.claim_id}: ${crosscheck.source_id}`);
    }
    if (claim.verification_status === 'independently_crosschecked') {
      const independentCount = claim.crosschecks.filter((crosscheck) => crosscheck.role === 'independent_exact_support').length;
      check(independentCount >= 2, 'insufficient_independent_crosschecks', `${claim.claim_id}: ${independentCount}`);
    }
  }

  check(orderedEqual(claims.get('claim:core-competencies')?.exact_terms, EXPECTED_CORE_TERMS), 'core_terms_drift', 'four core competency labels changed');
  check(orderedEqual(claims.get('claim:language-practices')?.exact_terms, EXPECTED_PRACTICES), 'practice_terms_drift', 'four practice labels changed');

  const taskClaim = claims.get('claim:learning-task-groups');
  check(orderedEqual(taskClaim?.exact_terms, EXPECTED_TASK_GROUPS), 'task_group_terms_drift', 'six task-group labels changed');
  const taskStructure = taskClaim?.structure?.map(({ label, members }) => ({ label, members }));
  check(orderedEqual(taskStructure, EXPECTED_TASK_STRUCTURE), 'task_group_structure_drift', 'three-layer 1+3+2 structure changed');

  check(orderedEqual(claims.get('claim:academic-quality-stages')?.exact_terms, EXPECTED_STAGES), 'quality_stage_terms_drift', 'four stage labels or grade ranges changed');
  check(orderedEqual(claims.get('claim:academic-quality-contexts')?.exact_terms, EXPECTED_CONTEXTS), 'quality_context_terms_drift', 'three context labels changed');

  const goalClaim = claims.get('claim:overall-goals');
  check(goalClaim?.verification_status === 'partial_conflicted', 'goal_status_inflation', 'nine goals must remain partial_conflicted');
  check(goalClaim?.claim_type === 'ordered_goal_list', 'goal_claim_type_drift', 'nine goals must remain an ordered list');
  check(orderedEqual(goalClaim?.ordered_items?.map((item) => item.position), [1, 2, 3, 4, 5, 6, 7, 8, 9]), 'goal_position_drift', 'goal positions must be 1 through 9');
  check(orderedEqual(goalClaim?.ordered_items?.map((item) => item.text), EXPECTED_GOALS), 'goal_text_drift', 'one or more goal texts changed');
  check(goalClaim?.ordered_items?.[5]?.text.includes('提高形象思维能力'), 'goal6_correct_reading_missing', 'goal 6 must use 提高形象思维能力');
  check(!goalClaim?.ordered_items?.[5]?.text.includes('提升形象思维能力'), 'goal6_known_error_restored', 'goal 6 online mistranscription was reintroduced');
  check(goalClaim?.crosschecks?.some((item) => item.source_id === 'source:nmg-goals-interpretation' && item.role === 'conflicting_transcription' && item.independent_for_claim === false), 'goal_conflict_witness_missing', 'NMG transcription conflict must remain explicit');
  check(goalClaim?.crosschecks?.some((item) => item.source_id === 'source:pep-goal6-2024-06' && item.role === 'partial_support' && item.independent_for_claim === true), 'goal6_partial_witness_missing', 'PEP goal 6 support must remain scoped as partial');

  check((artifact.version_mismatch_controls || []).length === EXPECTED_MISMATCHES.size, 'version_mismatch_count', 'exactly three mismatch controls are required');
  for (const [sourceId, dimension] of EXPECTED_MISMATCHES) {
    const control = artifact.version_mismatch_controls?.find((item) => item.source_id === sourceId);
    const source = sources.get(sourceId);
    check(Boolean(control), 'missing_version_mismatch_control', sourceId);
    check(control?.classification === 'version_mismatch', 'mismatch_classification_drift', sourceId);
    check(control?.mismatch_dimension === dimension, 'mismatch_dimension_drift', sourceId);
    check(setEqual(control?.forbidden_uses || [], EXPECTED_FORBIDDEN_USES), 'mismatch_forbidden_uses_drift', sourceId);
    check(control?.publication_unlock === false, 'mismatch_unlock_forbidden', sourceId);
    check(source?.evidence_role === 'version_mismatch', 'mismatch_source_role_drift', sourceId);
    check(source?.independent_text_decision === false, 'mismatch_source_promoted', sourceId);
  }

  check((artifact.transcription_conflicts || []).length === EXPECTED_CONFLICTS.size, 'transcription_conflict_count', 'exactly five source-image-wins records are required');
  for (const [conflictId, expected] of EXPECTED_CONFLICTS) {
    const conflict = conflicts.get(conflictId);
    check(Boolean(conflict), 'missing_transcription_conflict', conflictId);
    check(conflict?.physical_pdf_page === expected.page, 'conflict_page_drift', conflictId);
    check(conflict?.conflict_kind === expected.kind, 'conflict_kind_drift', conflictId);
    check(conflict?.rejected_reading === expected.rejected, 'conflict_rejected_reading_drift', conflictId);
    check(conflict?.accepted_reading === expected.accepted, 'conflict_accepted_reading_drift', conflictId);
    check(conflict?.decision === 'source_image_wins', 'conflict_decision_drift', conflictId);
    check(conflict?.source_image_status === 'human_verified', 'conflict_image_status_drift', conflictId);
    check(conflict?.publication_unlock === false, 'conflict_unlock_forbidden', conflictId);
    check(conflict?.evidence_source_ids?.includes(PRIMARY_SOURCE_ID), 'conflict_primary_image_missing', conflictId);
    for (const sourceId of conflict?.evidence_source_ids || []) {
      check(sources.has(sourceId), 'unknown_conflict_source', `${conflictId}: ${sourceId}`);
    }
  }

  check((artifact.interpretive_alignments || []).length === 1, 'interpretive_alignment_count', 'exactly one quarantined alignment is expected');
  const alignment = artifact.interpretive_alignments?.[0];
  check(alignment?.source_id === 'source:nmg-goals-interpretation', 'alignment_source_drift', 'unexpected alignment source');
  check(alignment?.status === 'interpretive_nonexclusive', 'alignment_status_drift', 'alignment must remain interpretive and nonexclusive');
  check(alignment?.normative === false, 'alignment_normative_promotion', 'interpretive alignment cannot become normative');
  check(alignment?.semantic_relation_allowed === false, 'alignment_semantic_promotion', 'interpretive alignment cannot create semantic relations');
  check(alignment?.publication_unlock === false, 'alignment_unlock_forbidden', 'interpretive alignment cannot unlock publication');
  check(orderedEqual(alignment?.mappings, EXPECTED_ALIGNMENT), 'alignment_mapping_drift', 'goal-to-core interpretive mapping changed');

  const unlocks = collectPublicationUnlocks(artifact);
  for (const unlock of unlocks) {
    check(unlock.value === false, 'publication_unlock_true', unlock.path);
  }

  check(schema?.$defs?.publicationLocked?.const === false, 'schema_publication_lock_drift', 'publicationLocked must be const false');
  check(schema?.$defs?.claim?.properties?.normative?.const === true, 'schema_claim_normative_drift', 'claim normative must be const true');
  check(schema?.$defs?.interpretiveAlignment?.properties?.normative?.const === false, 'schema_alignment_normative_drift', 'interpretive alignment normative must be const false');
  check(schema?.$defs?.interpretiveAlignment?.properties?.semantic_relation_allowed?.const === false, 'schema_alignment_relation_drift', 'interpretive alignment semantic relation must be const false');
  check(schema?.$defs?.artifactEquivalence?.properties?.independent_evidence_increment?.const === 0, 'schema_mirror_increment_drift', 'same-artifact evidence increment must be const zero');
  check(schema?.$defs?.transcriptionConflict?.properties?.decision?.const === 'source_image_wins', 'schema_conflict_decision_drift', 'conflict decision must be source_image_wins');

  return errors;
}

export function validateZhCompulsory2022OnlineVerification(artifact, schema) {
  const errors = [
    ...schemaErrors(artifact, schema, schema),
    ...semanticErrors(artifact, schema),
  ];

  const independentSources = artifact.sources?.filter((source) => source.independent_text_decision).length || 0;
  const lockedClaims = artifact.claims?.filter((claim) => claim.publication_unlock === false).length || 0;

  return {
    valid: errors.length === 0,
    artifact_id: artifact.artifact_id,
    document_id: artifact.document_identity?.document_id,
    counts: {
      sources: artifact.sources?.length || 0,
      independent_sources: independentSources,
      claims: artifact.claims?.length || 0,
      locked_claims: lockedClaims,
      version_mismatches: artifact.version_mismatch_controls?.length || 0,
      transcription_conflicts: artifact.transcription_conflicts?.length || 0,
      interpretive_alignments: artifact.interpretive_alignments?.length || 0,
    },
    publication_unlock: false,
    errors,
  };
}

export async function loadAndValidateZhCompulsory2022OnlineVerification(
  artifactPath = fileURLToPath(new URL('../data/online-verification/zh-compulsory-2022-claims.json', import.meta.url)),
  schemaPath = fileURLToPath(new URL('../data/online-verification/zh-compulsory-2022-claims.schema.json', import.meta.url)),
) {
  const [artifact, schema] = await Promise.all([
    readFile(artifactPath, 'utf8').then(JSON.parse),
    readFile(schemaPath, 'utf8').then(JSON.parse),
  ]);
  return validateZhCompulsory2022OnlineVerification(artifact, schema);
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const report = await loadAndValidateZhCompulsory2022OnlineVerification(
    process.argv[2] ? resolve(process.argv[2]) : undefined,
    process.argv[3] ? resolve(process.argv[3]) : undefined,
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.valid) process.exitCode = 1;
}
