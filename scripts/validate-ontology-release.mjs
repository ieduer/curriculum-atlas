#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  bindAcceptedOcrDocument,
  isNativeTextRecord,
  validatePagePublicationManifest,
} from './page-publication-gate.mjs';
import {
  applySemanticPagePublication,
  createSemanticPublicationGate,
  semanticDocumentDisposition,
} from './semantic-publication-gate.mjs';
import {
  canonicalParagraphBody,
  canonicalParagraphBodySha256,
  isCanonicalParagraphBody,
} from './canonical-paragraph-text.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MANIFEST = 'data/ontology-release-manifest.json';
const EXPECTED_PUBLIC_ONTOLOGY_NODES = 169;
const PUBLIC_BASELINE_ARTIFACT_PATH = 'data/release-baselines/ontology-public-v2.json';
const SUBJECT_FACETS = Object.freeze([
  '语文',
  '数学',
  '外语',
  '思想政治与道德法治',
  '历史',
  '历史与社会',
  '地理',
  '科学类',
  '技术',
  '劳动',
  '艺术',
  '体育与健康',
]);
const INPUT_PATHS = Object.freeze({
  candidate: 'data/ontology-candidates/zh-compulsory-2022.json',
  page_publication: 'data/page-publication-manifest.json',
  online_verification: 'data/online-verification/zh-compulsory-2022-claims.json',
  catalog: 'data/catalog.json',
  semantic_publication: 'data/semantic-publication-policy.json',
  formal_ontology: 'data/concept-ontology.json',
  public_core: 'public/data/concept-evolution.json',
  public_academic: 'public/data/concept-evolution-academic.json',
});
const CROSS_VERSION_RELATIONS = new Set([
  'reframed_by',
  'split_into',
  'merged_from',
  'replaced_by',
]);
const NODE_TYPE_ASSERTION_TYPES = Object.freeze({
  subject_model: ['official_structure'],
  competency_framework: ['official_structure'],
  core_competency_dimension: ['official_structure', 'student_ability'],
  course_goal: ['course_goal'],
  practice_framework: ['official_structure'],
  practice_domain: ['practice_domain'],
  content_organizer: ['official_structure', 'task_group'],
  task_group: ['task_group'],
  task_requirement: ['task_requirement'],
  student_ability: ['student_ability'],
  ability_descriptor: ['student_ability', 'performance_indicator'],
  language_activity: ['practice_domain', 'student_ability'],
  quality_framework: ['official_structure'],
  quality_level: ['quality_context', 'performance_indicator'],
  quality_context: ['quality_context'],
  quality_dimension: ['quality_dimension'],
  performance_indicator: ['performance_indicator'],
  official_term: ['presence', 'definition'],
  curriculum_construct: ['definition', 'official_structure'],
  editorial_container: ['official_structure'],
});
const CANDIDATE_TYPE_NODE_TYPES = Object.freeze({
  subject_model_candidate: ['subject_model'],
  competency_candidate: ['competency_framework', 'core_competency_dimension'],
  overall_goal_candidate: ['course_goal', 'student_ability'],
  practice_domain_candidate: ['practice_framework', 'practice_domain', 'language_activity'],
  content_theme_candidate: ['content_organizer', 'official_term'],
  task_group_candidate: ['content_organizer', 'task_group', 'task_requirement'],
  quality_structure_candidate: [
    'quality_framework',
    'quality_level',
    'quality_context',
    'quality_dimension',
    'performance_indicator',
  ],
  stage_requirement_candidate: ['task_requirement', 'student_ability', 'ability_descriptor'],
  stage_practice_requirement_cluster_candidate: ['task_requirement', 'student_ability', 'ability_descriptor'],
});
const EMPTY_REASON_CODES = Object.freeze([
  'empty_release',
  'no_accepted_leaf_nodes',
  'page_publication_empty',
  'candidate_remains_fail_closed',
  'public_graph_unchanged',
]);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function jsonPointer(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported schema reference: ${ref}`);
  return ref.slice(2).split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((value, part) => value?.[part], root);
}

function schemaErrors(value, schema, rootSchema, location = '$') {
  const errors = [];
  const add = (message) => errors.push(`schema:${location}: ${message}`);

  if (schema.$ref) {
    const target = jsonPointer(rootSchema, schema.$ref);
    if (!target) return [`schema:${location}: unresolved reference ${schema.$ref}`];
    return schemaErrors(value, target, rootSchema, location);
  }

  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    add(`must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) {
    add(`must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`);
  }

  if (schema.type) {
    const actual = valueType(value);
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.includes(actual)) {
      add(`must be type ${allowed.join('|')}; received ${actual}`);
      return errors;
    }
  }

  if (isObject(value)) {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`schema:${location}.${key}: required property is missing`);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) errors.push(`schema:${location}.${key}: additional property is forbidden`);
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (key in value) errors.push(...schemaErrors(value[key], childSchema, rootSchema, `${location}.${key}`));
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) add(`must contain at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) add(`must contain at most ${schema.maxItems} items`);
    if (schema.uniqueItems) {
      const serialized = value.map((entry) => JSON.stringify(entry));
      if (new Set(serialized).size !== serialized.length) add('must contain unique items');
    }
    if (schema.items) {
      value.forEach((entry, index) => {
        errors.push(...schemaErrors(entry, schema.items, rootSchema, `${location}[${index}]`));
      });
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) add(`must have length >= ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) add(`must match ${schema.pattern}`);
    if (schema.format === 'date-time'
      && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
        || Number.isNaN(Date.parse(value)))) {
      add('must be an RFC3339 UTC date-time');
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) add(`must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) add(`must be <= ${schema.maximum}`);
  }

  return errors;
}

function issue(errors, condition, code, detail) {
  if (!condition) errors.push(`${code}: ${detail}`);
}

function uniqueMap(items, key, errors, label) {
  const result = new Map();
  for (const item of items || []) {
    const value = item?.[key];
    if (result.has(value)) errors.push(`duplicate_${label}: ${value}`);
    else result.set(value, item);
  }
  return result;
}

function exactSet(actual, expected) {
  return actual.length === expected.length
    && new Set(actual).size === actual.length
    && expected.every((value) => actual.includes(value));
}

export function makeJsonArtifact(relativePath, json) {
  const raw = Buffer.from(`${JSON.stringify(json, null, 2)}\n`);
  return { path: relativePath, raw, json, sha256: sha256(raw) };
}

async function readArtifact(root, relativePath) {
  const raw = await readFile(path.join(root, relativePath));
  return {
    path: relativePath,
    raw,
    json: JSON.parse(raw.toString('utf8')),
    sha256: sha256(raw),
  };
}

function runGit(root, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const detail = Buffer.from(result.stderr || '').toString('utf8').trim();
    throw new Error(`immutable ontology baseline Git read failed (${args.join(' ')}): ${detail || `exit ${result.status}`}`);
  }
  return result;
}

function exactObjectKeys(value, expected) {
  return isObject(value) && exactSet(Object.keys(value).sort(), [...expected].sort());
}

function ontologyNodeCount(key, json) {
  if (key === 'formal_ontology') return json.nodes?.length;
  return json.ontology_nodes?.length;
}

export function loadImmutablePublicBaseline(root = PROJECT_ROOT) {
  const additionCommits = runGit(root, [
    'log', '--format=%H', '--diff-filter=A', '--', PUBLIC_BASELINE_ARTIFACT_PATH,
  ]).stdout.toString('utf8').trim().split(/\s+/).filter(Boolean);
  if (additionCommits.length !== 1) {
    throw new Error(`immutable ontology baseline needs one addition commit; found ${additionCommits.length}`);
  }
  const anchorCommit = additionCommits[0];
  const head = runGit(root, ['rev-parse', 'HEAD']).stdout.toString('utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(anchorCommit) || !/^[0-9a-f]{40}$/.test(head)) {
    throw new Error('immutable ontology baseline requires exact Git commit ids');
  }
  const anchorAncestor = runGit(root, ['merge-base', '--is-ancestor', anchorCommit, head], {
    allowFailure: true,
  });
  if (anchorAncestor.status !== 0 || anchorCommit === head) {
    throw new Error('immutable ontology baseline must be committed before the validating release code');
  }

  const raw = runGit(root, ['show', `${anchorCommit}:${PUBLIC_BASELINE_ARTIFACT_PATH}`]).stdout;
  let baseline;
  try {
    baseline = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new Error(`immutable ontology baseline is not valid JSON: ${error.message}`);
  }
  if (!exactObjectKeys(baseline, [
    'schema_version', 'baseline_id', 'policy', 'source_commit', 'source_tree', 'artifacts',
  ])
    || baseline.schema_version !== 1
    || baseline.policy !== 'immutable_git_object_v1'
    || baseline.baseline_id !== `ontology-public-baseline:${baseline.source_commit}`
    || !/^[0-9a-f]{40}$/.test(baseline.source_commit)
    || !/^[0-9a-f]{40}$/.test(baseline.source_tree)
    || !exactObjectKeys(baseline.artifacts, ['formal_ontology', 'public_core', 'public_academic'])) {
    throw new Error('immutable ontology baseline contract is invalid');
  }
  const sourceAncestor = runGit(root, [
    'merge-base', '--is-ancestor', baseline.source_commit, anchorCommit,
  ], { allowFailure: true });
  if (sourceAncestor.status !== 0) {
    throw new Error('immutable ontology baseline source is not an ancestor of its frozen artifact');
  }
  const sourceTree = runGit(root, ['rev-parse', `${baseline.source_commit}^{tree}`])
    .stdout.toString('utf8').trim();
  if (sourceTree !== baseline.source_tree) {
    throw new Error('immutable ontology baseline source tree does not match its Git object');
  }

  const artifacts = {};
  for (const key of ['formal_ontology', 'public_core', 'public_academic']) {
    const entry = baseline.artifacts[key];
    const expectedPath = INPUT_PATHS[key];
    if (!exactObjectKeys(entry, ['path', 'sha256', 'ontology_node_count'])
      || entry.path !== expectedPath
      || !/^[0-9a-f]{64}$/.test(entry.sha256)
      || entry.ontology_node_count !== EXPECTED_PUBLIC_ONTOLOGY_NODES) {
      throw new Error(`immutable ontology baseline ${key} contract is invalid`);
    }
    const sourceRaw = runGit(root, ['show', `${baseline.source_commit}:${entry.path}`]).stdout;
    let sourceJson;
    try {
      sourceJson = JSON.parse(sourceRaw.toString('utf8'));
    } catch (error) {
      throw new Error(`immutable ontology baseline ${key} source JSON is invalid: ${error.message}`);
    }
    if (sha256(sourceRaw) !== entry.sha256
      || ontologyNodeCount(key, sourceJson) !== entry.ontology_node_count) {
      throw new Error(`immutable ontology baseline ${key} does not match source commit bytes`);
    }
    artifacts[key] = Object.freeze({ ...entry });
  }
  return Object.freeze({
    path: PUBLIC_BASELINE_ARTIFACT_PATH,
    anchor_commit: anchorCommit,
    artifact_sha256: sha256(raw),
    source_commit: baseline.source_commit,
    source_tree: baseline.source_tree,
    artifacts: Object.freeze(artifacts),
  });
}

function paragraphKey(documentId, ordinal) {
  return `${documentId}\u0000${ordinal}`;
}

async function loadCanonicalParagraphs(root, artifacts) {
  const pageManifest = validatePagePublicationManifest(artifacts.page_publication.json);
  const records = artifacts.catalog.json.documents || [];
  const recordById = new Map(records.map((record) => [record.id, record]));
  const semanticGate = createSemanticPublicationGate({
    policy: artifacts.semantic_publication.json,
    records,
  });
  const paragraphs = new Map();

  for (const document of pageManifest.documents) {
    const record = recordById.get(document.document_id);
    if (!record) throw new Error(`ontology release canonical text: unknown catalog document ${document.document_id}`);
    if (isNativeTextRecord(record)) {
      throw new Error(`ontology release canonical text: OCR page manifest cannot replace native text ${record.id}`);
    }
    if (semanticDocumentDisposition(semanticGate, record).excluded) {
      throw new Error(`ontology release canonical text: exact duplicate alias is excluded ${record.id}`);
    }
    if (record.checksum_sha256 !== document.source_artifact_sha256) {
      throw new Error(`ontology release canonical text: source artifact drift for ${record.id}`);
    }

    const raw = await readFile(path.join(root, '.cache/text', `${record.id}.txt`), 'utf8');
    const rawPages = raw.split('\f');
    const acceptedPages = bindAcceptedOcrDocument({
      record,
      sourceArtifactSha256: record.checksum_sha256,
      rawPages,
      manifestDocument: document,
      documentCitationAllowed: record.citation_allowed === true,
    }).map((page, index) => applySemanticPagePublication({
      gate: semanticGate,
      record,
      page,
      rawText: rawPages[index],
    }));

    let ordinal = 0;
    for (let pageIndex = 0; pageIndex < rawPages.length; pageIndex += 1) {
      const page = acceptedPages[pageIndex];
      if (page.semantic_excluded) continue;
      const blocks = rawPages[pageIndex].split(/\n\s*\n/);
      for (const block of blocks) {
        const body = canonicalParagraphBody(block);
        if (!isCanonicalParagraphBody(body)) continue;
        ordinal += 1;
        paragraphs.set(paragraphKey(record.id, ordinal), {
          document_id: record.id,
          ordinal,
          physical_page: page.page_number,
          body,
          body_sha256: canonicalParagraphBodySha256(body),
          source_artifact_sha256: page.source_artifact_sha256,
          source_page_sha256: page.source_page_sha256,
          final_text_sha256: page.page_final_text_sha256,
          evidence_bundle_sha256: page.evidence_bundle_sha256,
          display_allowed: page.display_allowed === true,
          citation_allowed: page.citation_allowed === true,
        });
      }
    }
  }
  return { page_manifest: pageManifest, canonical_paragraphs: paragraphs };
}

export async function loadOntologyReleaseContext(root = PROJECT_ROOT) {
  const entries = await Promise.all(Object.entries(INPUT_PATHS)
    .map(async ([key, relativePath]) => [key, await readArtifact(root, relativePath)]));
  const artifacts = Object.fromEntries(entries);
  const canonical = await loadCanonicalParagraphs(root, artifacts);
  return {
    root,
    schema: JSON.parse(await readFile(path.join(root, 'data/ontology-release.schema.json'), 'utf8')),
    artifacts,
    public_baseline: loadImmutablePublicBaseline(root),
    builder_source: await readFile(path.join(root, 'scripts/build-concept-evolution.mjs'), 'utf8'),
    ...canonical,
  };
}

function validateFingerprints(manifest, context, errors) {
  for (const [key, expectedPath] of Object.entries(INPUT_PATHS)) {
    const declared = manifest.input_fingerprints[key];
    const artifact = context.artifacts[key];
    issue(errors, declared.path === expectedPath, 'fingerprint_path_drift', `${key} must bind ${expectedPath}`);
    issue(errors, declared.sha256 === artifact.sha256, 'fingerprint_sha256_mismatch', `${key} bytes do not match the manifest`);
  }

  const baseline = context.public_baseline?.artifacts || {};
  for (const key of ['formal_ontology', 'public_core', 'public_academic']) {
    const baselineEntry = baseline[key];
    issue(errors, Boolean(baselineEntry), 'public_graph_immutable_baseline_missing', `${key} has no frozen Git-object baseline`);
    if (!baselineEntry) continue;
    issue(errors, context.artifacts[key].sha256 === baselineEntry.sha256,
      'public_graph_baseline_hash_mismatch', `${key} differs from the code-reviewed immutable baseline`);
    issue(errors, manifest.input_fingerprints[key].sha256 === baselineEntry.sha256,
      'public_graph_baseline_declaration_mismatch', `${key} manifest digest differs from the immutable baseline`);
  }

  const formalCount = context.artifacts.formal_ontology.json.nodes?.length;
  const coreCount = context.artifacts.public_core.json.ontology_nodes?.length;
  const academicCount = context.artifacts.public_academic.json.ontology_nodes?.length;
  issue(errors, formalCount === EXPECTED_PUBLIC_ONTOLOGY_NODES,
    'formal_ontology_count_drift', `expected ${EXPECTED_PUBLIC_ONTOLOGY_NODES}, received ${formalCount}`);
  issue(errors, coreCount === EXPECTED_PUBLIC_ONTOLOGY_NODES,
    'public_core_count_drift', `expected ${EXPECTED_PUBLIC_ONTOLOGY_NODES}, received ${coreCount}`);
  issue(errors, academicCount === EXPECTED_PUBLIC_ONTOLOGY_NODES,
    'public_academic_count_drift', `expected ${EXPECTED_PUBLIC_ONTOLOGY_NODES}, received ${academicCount}`);
  issue(errors, formalCount === coreCount && coreCount === academicCount,
    'public_ontology_parity_error', `formal/core/academic counts are ${formalCount}/${coreCount}/${academicCount}`);

  for (const [key, count] of [
    ['formal_ontology', formalCount],
    ['public_core', coreCount],
    ['public_academic', academicCount],
  ]) {
    issue(errors, manifest.input_fingerprints[key].ontology_node_count === count,
      'declared_ontology_count_mismatch', `${key} count is not bound to the inspected artifact`);
  }
}

function validateSourceLock(manifest, context, errors) {
  const candidate = context.artifacts.candidate.json;
  const online = context.artifacts.online_verification.json;
  const source = candidate.source_identity || {};
  const onlineIdentity = online.document_identity || {};
  const sourceHash = manifest.input_fingerprints.source_artifact_sha256;
  const scopes = uniqueMap(manifest.scopes, 'scope_id', errors, 'scope_id');

  issue(errors, manifest.scopes.length === 1, 'unsupported_scope_bundle',
    'v1 binds one exact candidate/page/online evidence bundle; additional scopes require a new schema version');
  issue(errors, source.source_artifact_sha256 === sourceHash, 'candidate_source_hash_mismatch', 'candidate source hash differs');
  issue(errors, onlineIdentity.source_artifact_sha256 === sourceHash, 'online_source_hash_mismatch', 'online source hash differs');
  issue(errors, source.document_id === onlineIdentity.document_id, 'document_identity_mismatch', 'candidate and online document ids differ');
  issue(errors, source.subject_facet === onlineIdentity.subject, 'subject_identity_mismatch', 'candidate and online subjects differ');
  issue(errors, source.stage === onlineIdentity.stage, 'stage_identity_mismatch', 'candidate and online stages differ');
  issue(errors, source.school_type === onlineIdentity.school_type, 'school_type_identity_mismatch', 'candidate and online school types differ');
  issue(errors, source.version_label === onlineIdentity.version_label, 'version_identity_mismatch', 'candidate and online versions differ');

  for (const scope of scopes.values()) {
    issue(errors, scope.document_id === source.document_id, 'scope_document_mismatch', `${scope.scope_id} document differs from the bound source`);
    issue(errors, scope.subject_facet === source.subject_facet, 'scope_subject_mismatch', `${scope.scope_id} subject differs from the bound source`);
    issue(errors, scope.stage === source.stage, 'scope_stage_mismatch', `${scope.scope_id} stage differs from the bound source`);
    issue(errors, scope.school_type === source.school_type, 'scope_school_type_mismatch', `${scope.scope_id} school type differs from the bound source`);
    issue(errors, scope.version_label === source.version_label, 'scope_version_mismatch', `${scope.scope_id} version differs from the bound source`);
    issue(errors, scope.edition_id === `edition:${source.document_id}`, 'scope_edition_mismatch', `${scope.scope_id} edition id is not source-bound`);
    issue(errors, scope.source_artifact_sha256 === sourceHash, 'scope_source_hash_mismatch', `${scope.scope_id} source hash differs`);
  }

  issue(errors, candidate.publication_status === 'candidate_fail_closed',
    'candidate_promotion_flag_open', 'candidate layer must remain fail closed');
  for (const key of [
    'ontology_merge_allowed',
    'concept_evolution_build_allowed',
    'public_data_update_allowed',
    'publication_gate_changed',
    'deployment_allowed',
  ]) {
    issue(errors, candidate.release_boundary?.[key] === false,
      'candidate_promotion_flag_open', `candidate release_boundary.${key} must remain false`);
  }
  issue(errors, online.release_boundary?.publication_unlock === false,
    'online_publication_unlock_open', 'online verification is evidence, not a release switch');
  issue(errors, online.release_boundary?.builder_input_allowed === false,
    'online_builder_unlock_open', 'online verification cannot become a builder input directly');

  return scopes;
}

function candidateNodes(candidate) {
  return (candidate.node_groups || []).flatMap((group) => group.nodes || []);
}

function candidateProvenance(candidate, errors) {
  const nodes = new Map();
  const children = new Map();
  for (const group of candidate.node_groups || []) {
    for (const node of group.nodes || []) {
      if (nodes.has(node.id)) errors.push(`duplicate_candidate_node_id: ${node.id}`);
      else nodes.set(node.id, {
        ...node,
        group_id: group.group_id,
        candidate_node_type: group.node_type,
        parent_relation_policy: group.parent_relation_policy,
      });
      if (node.parent_id !== null) {
        if (!children.has(node.parent_id)) children.set(node.parent_id, []);
        children.get(node.parent_id).push(node.id);
      }
    }
  }
  const anchors = uniqueMap(candidate.evidence_anchors, 'id', errors, 'candidate_anchor_id');
  return { nodes, anchors, children };
}

function validateFacetCoverage(manifest, context, errors) {
  const rows = uniqueMap(manifest.facet_coverage, 'subject_facet', errors, 'facet_coverage_subject');
  issue(errors, exactSet([...rows.keys()], SUBJECT_FACETS), 'facet_coverage_set_drift',
    'facet coverage must contain each controlled facet exactly once');

  const formal = context.artifacts.formal_ontology.json;
  const scopeById = new Map((formal.scopes || []).map((scope) => [scope.id, scope]));
  const releasedNodes = new Map(SUBJECT_FACETS.map((facet) => [facet, 0]));
  const releasedScopes = new Map(SUBJECT_FACETS.map((facet) => [facet, 0]));
  const candidateNodeCounts = new Map(SUBJECT_FACETS.map((facet) => [facet, 0]));
  const candidateScopeCounts = new Map(SUBJECT_FACETS.map((facet) => [facet, 0]));

  for (const scope of formal.scopes || []) {
    releasedScopes.set(scope.subject_facet, (releasedScopes.get(scope.subject_facet) || 0) + 1);
  }
  for (const node of formal.nodes || []) {
    const facet = scopeById.get(node.scope_id)?.subject_facet;
    if (facet) releasedNodes.set(facet, (releasedNodes.get(facet) || 0) + 1);
  }

  const candidate = context.artifacts.candidate.json;
  const candidateFacet = candidate.source_identity?.subject_facet;
  const candidateCount = candidateNodes(candidate).length;
  if (candidateFacet && candidateCount > 0) {
    candidateNodeCounts.set(candidateFacet, candidateCount);
    candidateScopeCounts.set(candidateFacet, 1);
  }

  for (const facet of SUBJECT_FACETS) {
    const row = rows.get(facet);
    if (!row) continue;
    const expectedReleasedNodes = releasedNodes.get(facet) || 0;
    const expectedReleasedScopes = releasedScopes.get(facet) || 0;
    const expectedCandidateNodes = candidateNodeCounts.get(facet) || 0;
    const expectedCandidateScopes = candidateScopeCounts.get(facet) || 0;
    const expectedStatus = expectedReleasedNodes > 0
      ? 'released' : expectedCandidateNodes > 0 ? 'candidate' : 'not_started';
    issue(errors, row.released_node_count === expectedReleasedNodes,
      'facet_released_node_count_mismatch', `${facet} expected ${expectedReleasedNodes}`);
    issue(errors, row.released_scope_count === expectedReleasedScopes,
      'facet_released_scope_count_mismatch', `${facet} expected ${expectedReleasedScopes}`);
    issue(errors, row.candidate_node_count === expectedCandidateNodes,
      'facet_candidate_node_count_mismatch', `${facet} expected ${expectedCandidateNodes}`);
    issue(errors, row.candidate_scope_count === expectedCandidateScopes,
      'facet_candidate_scope_count_mismatch', `${facet} expected ${expectedCandidateScopes}`);
    issue(errors, row.status === expectedStatus,
      'facet_status_mismatch', `${facet} must be ${expectedStatus}, not ${row.status}`);
    if (expectedReleasedNodes === 0 && expectedCandidateNodes === 0) {
      issue(errors, row.status === 'not_started', 'fabricated_zero_coverage', `${facet} has no reviewed or candidate nodes`);
    }
  }
}

function validateOnlineEvidenceInvariant(online, errors) {
  const sources = uniqueMap(online.sources, 'source_id', errors, 'online_source_id');
  for (const source of sources.values()) {
    if (source.evidence_role === 'same_artifact_mirror') {
      issue(errors, source.independent_text_decision === false,
        'mirror_independence_error', `${source.source_id} is a byte-identical mirror`);
      issue(errors, typeof source.same_artifact_as === 'string' && sources.has(source.same_artifact_as),
        'mirror_parent_missing', `${source.source_id} does not resolve its primary artifact`);
    }
    if (source.evidence_role === 'version_mismatch') {
      issue(errors, source.independent_text_decision === false,
        'version_mismatch_promoted', `${source.source_id} cannot be independent evidence`);
    }
  }
  for (const equivalence of online.artifact_equivalence || []) {
    if (equivalence.classification === 'same_artifact_mirror') {
      issue(errors, equivalence.independent_evidence_increment === 0,
        'mirror_evidence_inflation', 'same artifact mirror must add zero independent evidence');
    }
  }
  return sources;
}

function validateAssertions(manifest, context, scopes, pageManifest, provenance, errors) {
  const assertions = uniqueMap(manifest.assertions, 'assertion_id', errors, 'assertion_id');
  const resolved = new Map();
  const online = context.artifacts.online_verification.json;
  const onlineSources = validateOnlineEvidenceInvariant(online, errors);
  const claims = uniqueMap(online.claims, 'claim_id', errors, 'online_claim_id');
  const mismatchSources = new Set((online.version_mismatch_controls || []).map((control) => control.source_id));
  const blockedPages = new Set((context.artifacts.candidate.json.excluded_page_controls || [])
    .map((control) => control.physical_page));
  const pageDocuments = new Map((pageManifest.documents || []).map((document) => [document.document_id, document]));
  const catalogRecords = new Map((context.artifacts.catalog.json.documents || []).map((record) => [record.id, record]));

  for (const assertion of assertions.values()) {
    const scope = scopes.get(assertion.scope_id);
    issue(errors, Boolean(scope), 'assertion_scope_missing', `${assertion.assertion_id} scope is unknown`);
    if (!scope) continue;
    issue(errors, assertion.document_id === scope.document_id,
      'assertion_document_mismatch', `${assertion.assertion_id} document differs from its scope`);
    issue(errors, assertion.edition_id === scope.edition_id,
      'assertion_edition_mismatch', `${assertion.assertion_id} edition differs from its scope`);
    issue(errors, assertion.version_relation === 'exact_document_exact_edition',
      'assertion_version_mismatch', `${assertion.assertion_id} is not exact-edition evidence`);
    issue(errors, assertion.end_offset > assertion.start_offset,
      'assertion_offset_error', `${assertion.assertion_id} end_offset must exceed start_offset`);
    issue(errors, !blockedPages.has(assertion.physical_page),
      'blocked_page_reference', `${assertion.assertion_id} references unresolved physical page ${assertion.physical_page}`);

    const candidateNode = provenance.nodes.get(assertion.node_binding.candidate_node_id);
    const candidateAnchor = provenance.anchors.get(assertion.candidate_anchor_id);
    issue(errors, Boolean(candidateNode), 'candidate_node_missing', `${assertion.assertion_id} candidate node is unknown`);
    issue(errors, Boolean(candidateAnchor), 'candidate_anchor_missing', `${assertion.assertion_id} candidate anchor is unknown`);
    if (candidateNode && candidateAnchor) {
      issue(errors, candidateNode.evidence_anchor_ids?.includes(candidateAnchor.id),
        'candidate_anchor_not_bound_to_node', `${candidateAnchor.id} does not support ${candidateNode.id}`);
      issue(errors, candidateAnchor.physical_pages?.includes(assertion.physical_page),
        'candidate_anchor_page_mismatch', `${candidateAnchor.id} does not cover page ${assertion.physical_page}`);
    }

    if (manifest.publication_state === 'reviewed_release') {
      issue(errors, assertion.adjudication === 'accepted',
        'unresolved_assertion', `${assertion.assertion_id} must be accepted`);
      issue(errors, assertion.citation_allowed === true,
        'assertion_citation_closed', `${assertion.assertion_id} cannot back a release node`);
      issue(errors, assertion.uncertainty_note === null,
        'accepted_assertion_uncertain', `${assertion.assertion_id} retains an uncertainty note`);
    }

    const pageDocument = pageDocuments.get(assertion.document_id);
    issue(errors, Boolean(pageDocument), 'page_document_not_accepted', `${assertion.assertion_id} document has no accepted page manifest`);
    if (pageDocument) {
      issue(errors, pageDocument.acceptance_status === 'accepted_page_manifest',
        'page_document_not_accepted', `${assertion.assertion_id} document acceptance status is invalid`);
      issue(errors, pageDocument.source_artifact_sha256 === scope.source_artifact_sha256,
        'page_document_source_mismatch', `${assertion.assertion_id} document hash differs from its scope`);
      const record = catalogRecords.get(assertion.document_id);
      issue(errors, Boolean(record), 'catalog_document_missing', `${assertion.assertion_id} document is absent from the catalog`);
      if (record) {
        issue(errors, record.checksum_sha256 === scope.source_artifact_sha256,
          'catalog_source_mismatch', `${assertion.assertion_id} catalog artifact differs from its scope`);
        issue(errors, record.page_count === pageDocument.pages.length,
          'catalog_page_count_mismatch', `${assertion.assertion_id} accepted page manifest is not the complete document`);
        if (manifest.publication_state === 'reviewed_release') {
          issue(errors, record.citation_allowed === true,
            'catalog_citation_gate_closed', `${assertion.assertion_id} catalog document remains non-citable`);
        }
      }
      const page = (pageDocument.pages || []).find((entry) => entry.page_number === assertion.physical_page);
      issue(errors, Boolean(page), 'page_not_accepted', `${assertion.assertion_id} physical page is absent`);
      if (page) {
        issue(errors, page.review_status === 'accepted' && page.display_allowed === true && page.citation_allowed === true,
          'page_not_accepted', `${assertion.assertion_id} page is not display-and-citation accepted`);
        issue(errors, page.source_page_sha256 === assertion.source_page_sha256,
          'source_page_hash_mismatch', `${assertion.assertion_id} page image hash differs`);
        issue(errors, page.final_text_sha256 === assertion.final_text_sha256,
          'final_text_hash_mismatch', `${assertion.assertion_id} final text hash differs`);
        issue(errors, page.evidence_bundle_sha256 === assertion.evidence_bundle_sha256,
          'evidence_bundle_hash_mismatch', `${assertion.assertion_id} evidence bundle hash differs`);
      }
    }

    const paragraph = context.canonical_paragraphs?.get(paragraphKey(
      assertion.document_id,
      assertion.paragraph_ordinal,
    ));
    issue(errors, Boolean(paragraph), 'canonical_paragraph_missing', `${assertion.assertion_id} paragraph is absent from canonical final text`);
    if (paragraph) {
      issue(errors, paragraph.physical_page === assertion.physical_page,
        'canonical_paragraph_page_mismatch', `${assertion.assertion_id} ordinal resolves to page ${paragraph.physical_page}`);
      issue(errors, paragraph.display_allowed === true && paragraph.citation_allowed === true,
        'canonical_paragraph_gate_closed', `${assertion.assertion_id} canonical paragraph is not display-and-citation accepted`);
      issue(errors, paragraph.source_artifact_sha256 === scope.source_artifact_sha256,
        'canonical_paragraph_source_mismatch', `${assertion.assertion_id} canonical paragraph source differs`);
      issue(errors, paragraph.source_page_sha256 === assertion.source_page_sha256,
        'canonical_paragraph_page_hash_mismatch', `${assertion.assertion_id} canonical page image differs`);
      issue(errors, paragraph.final_text_sha256 === assertion.final_text_sha256,
        'canonical_paragraph_final_text_mismatch', `${assertion.assertion_id} canonical final text differs`);
      issue(errors, paragraph.evidence_bundle_sha256 === assertion.evidence_bundle_sha256,
        'canonical_paragraph_evidence_mismatch', `${assertion.assertion_id} canonical evidence bundle differs`);
      const bodySha256 = canonicalParagraphBodySha256(paragraph.body);
      issue(errors, paragraph.body_sha256 === bodySha256 && assertion.paragraph_body_sha256 === bodySha256,
        'canonical_paragraph_body_hash_mismatch', `${assertion.assertion_id} paragraph body bytes are not bound`);

      const assertionRangeValid = assertion.start_offset >= 0
        && assertion.end_offset > assertion.start_offset
        && assertion.end_offset <= paragraph.body.length;
      issue(errors, assertionRangeValid,
        'assertion_offset_error', `${assertion.assertion_id} offsets leave the canonical paragraph`);
      const assertedText = assertionRangeValid
        ? paragraph.body.slice(assertion.start_offset, assertion.end_offset)
        : '';
      issue(errors, sha256(assertedText) === assertion.asserted_text_sha256,
        'asserted_text_hash_mismatch', `${assertion.assertion_id} digest does not match the canonical substring`);

      const binding = assertion.node_binding;
      const labelRangeValid = binding.label_start_offset >= assertion.start_offset
        && binding.label_end_offset > binding.label_start_offset
        && binding.label_end_offset <= assertion.end_offset;
      const definitionRangeValid = binding.definition_start_offset >= assertion.start_offset
        && binding.definition_end_offset > binding.definition_start_offset
        && binding.definition_end_offset <= assertion.end_offset;
      issue(errors, labelRangeValid, 'node_label_offset_error', `${assertion.assertion_id} label offsets leave its accepted assertion`);
      issue(errors, definitionRangeValid, 'node_definition_offset_error', `${assertion.assertion_id} definition offsets leave its accepted assertion`);
      resolved.set(assertion.assertion_id, { assertion, paragraph, asserted_text: assertedText });
    }

    const onlineBindings = assertion.online_evidence_bindings || [];
    const bindingClaimIds = onlineBindings.map((binding) => binding.claim_id);
    const bindingSourceIds = [...new Set(onlineBindings
      .flatMap((binding) => binding.independent_source_ids || []))];
    issue(errors, exactSet(bindingClaimIds, assertion.online_claim_ids),
      'online_claim_binding_set_mismatch', `${assertion.assertion_id} claim ids are not exactly content-bound`);
    issue(errors, exactSet(bindingSourceIds, assertion.independent_online_source_ids),
      'online_source_binding_set_mismatch', `${assertion.assertion_id} source ids are not exactly claim-bound`);

    for (const binding of onlineBindings) {
      const claim = claims.get(binding.claim_id);
      issue(errors, Boolean(claim), 'online_claim_missing', `${assertion.assertion_id} references ${binding.claim_id}`);
      if (!claim) continue;
      issue(errors, claim.verification_status === 'independently_crosschecked',
        'online_claim_unresolved', `${binding.claim_id} is ${claim.verification_status}`);
      issue(errors, claim.normative === true,
        'online_claim_not_normative', `${binding.claim_id} is not a normative source-text claim`);
      issue(errors, binding.source_image_page === assertion.physical_page
        && claim.source_image_pages?.includes(assertion.physical_page),
      'online_claim_page_mismatch', `${binding.claim_id} is not verified on physical page ${assertion.physical_page}`);
      issue(errors, binding.candidate_anchor_id === assertion.candidate_anchor_id,
        'online_claim_anchor_mismatch', `${binding.claim_id} is not bound to ${assertion.candidate_anchor_id}`);
      const exactSupport = new Set((claim.crosschecks || [])
        .filter((entry) => entry.role === 'independent_exact_support' && entry.independent_for_claim === true)
        .map((entry) => entry.source_id));
      const selected = (binding.independent_source_ids || [])
        .filter((sourceId) => exactSupport.has(sourceId));
      issue(errors, selected.length >= 2 && selected.length === binding.independent_source_ids.length,
        'insufficient_independent_online_evidence', `${assertion.assertion_id}/${binding.claim_id} has ${selected.length} exactly bound independent sources`);

      const resolvedAssertion = resolved.get(assertion.assertion_id);
      const semanticTerms = new Set([candidateNode?.label]);
      for (const childId of provenance.children.get(candidateNode?.id) || []) {
        semanticTerms.add(provenance.nodes.get(childId)?.label);
      }
      const exactTerms = new Set(claim.exact_terms || []);
      const anchorTerms = new Set(candidateAnchor?.candidate_terms || []);
      const boundTerms = new Set();
      for (const termBinding of binding.term_bindings || []) {
        const rangeValid = Boolean(resolvedAssertion)
          && termBinding.start_offset >= assertion.start_offset
          && termBinding.end_offset > termBinding.start_offset
          && termBinding.end_offset <= assertion.end_offset;
        issue(errors, rangeValid,
          'online_term_offset_error', `${assertion.assertion_id}/${binding.claim_id}/${termBinding.term} leaves the accepted assertion`);
        const boundText = rangeValid
          ? resolvedAssertion.paragraph.body.slice(termBinding.start_offset, termBinding.end_offset)
          : '';
        issue(errors, boundText === termBinding.term && sha256(boundText) === termBinding.text_sha256,
          'online_term_text_mismatch', `${assertion.assertion_id}/${binding.claim_id}/${termBinding.term} is not the canonical substring`);
        issue(errors, exactTerms.has(termBinding.term),
          'online_term_not_in_claim', `${termBinding.term} is absent from ${binding.claim_id}.exact_terms`);
        issue(errors, anchorTerms.has(termBinding.term),
          'online_term_not_in_candidate_anchor', `${termBinding.term} is absent from ${assertion.candidate_anchor_id}.candidate_terms`);
        issue(errors, semanticTerms.has(termBinding.term),
          'online_claim_candidate_semantic_mismatch', `${termBinding.term} is not ${candidateNode?.id} or one of its direct candidate members`);
        boundTerms.add(termBinding.term);
      }
      issue(errors, boundTerms.size > 0,
        'online_claim_without_exact_term', `${assertion.assertion_id}/${binding.claim_id} has no exact canonical term binding`);
    }

    for (const sourceId of assertion.independent_online_source_ids || []) {
      const source = onlineSources.get(sourceId);
      issue(errors, Boolean(source), 'online_source_missing', `${assertion.assertion_id} references ${sourceId}`);
      if (!source) continue;
      issue(errors, source.evidence_role === 'independent_text'
        && source.independent_text_decision === true
        && source.version_relation === 'exact_2022_edition'
        && source.same_artifact_as === null,
      'online_source_not_independent', `${sourceId} is not exact-edition independent text`);
      issue(errors, !mismatchSources.has(sourceId),
        'version_mismatch_source_used', `${sourceId} is quarantined by version mismatch controls`);
    }
  }
  return { assertions, resolved };
}

function validateNodes(manifest, scopes, assertionResult, provenance, errors) {
  const { assertions, resolved } = assertionResult;
  const nodes = uniqueMap(manifest.nodes, 'id', errors, 'node_id');
  const childCounts = new Map([...nodes.keys()].map((id) => [id, 0]));
  const releasedByCandidateId = new Map();

  for (const node of nodes.values()) {
    issue(errors, scopes.has(node.scope_id), 'node_scope_missing', `${node.id} scope is unknown`);
    issue(errors, !node.id.startsWith('candidate:'), 'candidate_id_promoted_directly', `${node.id} reuses a candidate identity`);
    const candidate = provenance.nodes.get(node.candidate_node_id);
    issue(errors, Boolean(candidate), 'candidate_node_missing', `${node.id} candidate provenance is unknown`);
    if (releasedByCandidateId.has(node.candidate_node_id)) {
      errors.push(`duplicate_candidate_promotion: ${node.candidate_node_id}`);
    } else releasedByCandidateId.set(node.candidate_node_id, node);
    if (candidate) {
      issue(errors, candidate.label === node.label,
        'candidate_label_drift', `${node.id} label differs from ${candidate.id}`);
      issue(errors, CANDIDATE_TYPE_NODE_TYPES[candidate.candidate_node_type]?.includes(node.node_type),
        'candidate_node_type_mismatch', `${node.id} type is incompatible with ${candidate.candidate_node_type}`);
      issue(errors, candidate.lexical_concept_id === node.lexical_concept_id,
        'candidate_lexical_concept_mismatch', `${node.id} lexical identity differs from ${candidate.id}`);
      issue(errors, typeof candidate.normative_role_candidate === 'string'
        && candidate.normative_role_candidate === node.normative_role
        && node.candidate_normative_role === candidate.normative_role_candidate,
      'candidate_normative_role_mismatch', `${node.id} normative role is not exactly candidate-bound`);
      const expectedCandidateParentRelation = candidate.parent_id === null
        ? null
        : candidate.parent_relation_policy?.relation_type_candidate;
      issue(errors, node.candidate_parent_id === candidate.parent_id,
        'candidate_parent_id_mismatch', `${node.id} candidate parent provenance differs from ${candidate.id}`);
      issue(errors, node.candidate_parent_relation === expectedCandidateParentRelation,
        'candidate_parent_relation_mismatch', `${node.id} candidate parent relation provenance differs from ${candidate.id}`);
    }

    for (const assertionId of node.source_assertion_ids || []) {
      const assertion = assertions.get(assertionId);
      issue(errors, Boolean(assertion), 'node_assertion_missing', `${node.id} references ${assertionId}`);
      if (assertion) {
        issue(errors, assertion.scope_id === node.scope_id,
          'node_assertion_cross_scope', `${node.id} and ${assertionId} use different scopes`);
        issue(errors, assertion.adjudication === 'accepted',
          'node_assertion_unaccepted', `${node.id} references a non-accepted assertion`);
      }
    }
    const fieldBinding = resolved.get(node.field_binding_assertion_id);
    issue(errors, Boolean(fieldBinding),
      'node_field_binding_missing', `${node.id} has no resolved field-binding assertion`);
    issue(errors, node.source_assertion_ids.includes(node.field_binding_assertion_id),
      'node_field_binding_not_in_sources', `${node.id} field binding is absent from source_assertion_ids`);
    if (fieldBinding) {
      const binding = fieldBinding.assertion.node_binding;
      issue(errors, binding.node_id === node.id,
        'node_binding_id_mismatch', `${node.id} binding points to ${binding.node_id}`);
      issue(errors, binding.candidate_node_id === node.candidate_node_id,
        'node_binding_candidate_mismatch', `${node.id} binding candidate differs`);
      issue(errors, binding.node_type === node.node_type,
        'node_type_binding_mismatch', `${node.id} type is not bound by its accepted assertion`);
      issue(errors, binding.lexical_concept_id === node.lexical_concept_id,
        'node_lexical_binding_mismatch', `${node.id} lexical identity is not bound by its accepted assertion`);
      issue(errors, binding.candidate_normative_role === node.candidate_normative_role
        && binding.candidate_normative_role === node.normative_role,
      'node_normative_binding_mismatch', `${node.id} normative role is not bound by its accepted assertion`);
      issue(errors, binding.candidate_parent_id === node.candidate_parent_id,
        'node_candidate_parent_binding_mismatch', `${node.id} candidate parent id is not assertion-bound`);
      issue(errors, binding.candidate_parent_relation === node.candidate_parent_relation,
        'node_candidate_parent_relation_binding_mismatch', `${node.id} candidate parent relation is not assertion-bound`);
      issue(errors, NODE_TYPE_ASSERTION_TYPES[node.node_type]?.includes(fieldBinding.assertion.assertion_type),
        'node_type_assertion_mismatch', `${node.id} type is incompatible with assertion class ${fieldBinding.assertion.assertion_type}`);
      const label = fieldBinding.paragraph.body.slice(binding.label_start_offset, binding.label_end_offset);
      const definition = fieldBinding.paragraph.body.slice(
        binding.definition_start_offset,
        binding.definition_end_offset,
      );
      issue(errors, label === node.label,
        'node_label_not_in_canonical_text', `${node.id} label is not the bound canonical substring`);
      issue(errors, definition === node.definition,
        'node_definition_not_in_canonical_text', `${node.id} definition is not the bound canonical substring`);
    }

  }

  for (const node of nodes.values()) {
    const candidate = provenance.nodes.get(node.candidate_node_id);
    if (candidate?.parent_id === null) {
      issue(errors, node.parent_id === null,
        'candidate_root_parent_fabricated', `${node.id} adds a parent absent from candidate provenance`);
    } else if (candidate) {
      const releasedCandidateParent = releasedByCandidateId.get(candidate.parent_id);
      issue(errors, Boolean(releasedCandidateParent),
        'candidate_parent_not_promoted', `${node.id} cannot drop candidate parent ${candidate.parent_id}`);
      issue(errors, node.parent_id === releasedCandidateParent?.id,
        'candidate_parent_mismatch', `${node.id} parent does not exactly follow candidate provenance`);
    }

    if (node.parent_id !== null) {
      const parent = nodes.get(node.parent_id);
      issue(errors, Boolean(parent), 'dangling_parent', `${node.id} parent ${node.parent_id} does not exist`);
      if (parent) {
        issue(errors, parent.scope_id === node.scope_id,
          'cross_scope_parent', `${node.id} parent belongs to ${parent.scope_id}`);
        childCounts.set(parent.id, (childCounts.get(parent.id) || 0) + 1);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) {
      errors.push(`parent_cycle: cycle reaches ${id}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const parentId = nodes.get(id)?.parent_id;
    if (parentId && nodes.has(parentId)) visit(parentId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of nodes.keys()) visit(id);

  const leaves = [...nodes.values()].filter((node) => (childCounts.get(node.id) || 0) === 0);
  const acceptedNodes = [...nodes.values()].filter((node) => node.citation_allowed === true
    && node.review_status === 'editor_reviewed'
    && node.label_kind === 'official_term'
    && node.source_assertion_ids.length > 0
    && node.source_assertion_ids.every((id) => assertions.get(id)?.adjudication === 'accepted')
    && resolved.has(node.field_binding_assertion_id));
  const acceptedLeaves = leaves.filter((node) => acceptedNodes.includes(node));

  if (manifest.publication_state === 'reviewed_release') {
    for (const node of nodes.values()) {
      issue(errors, acceptedNodes.includes(node),
        'node_without_accepted_provenance', `${node.id} is not fully candidate-and-assertion bound`);
    }
    for (const leaf of leaves) {
      issue(errors, acceptedLeaves.includes(leaf), 'leaf_without_accepted_assertion', `${leaf.id} is not an accepted scholarly leaf`);
    }
    issue(errors, acceptedLeaves.length > 0, 'no_accepted_leaf_nodes', 'reviewed releases need at least one accepted leaf');
  }

  return { nodes, leaves, acceptedNodes, acceptedLeaves };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function canonicalStatementSupportsRelation(relationType, statement, sourceLabel, targetLabel) {
  const text = statement.replace(/\s+/g, '');
  const source = escapeRegExp(sourceLabel.replace(/\s+/g, ''));
  const target = escapeRegExp(targetLabel.replace(/\s+/g, ''));
  const between = '.{0,64}';
  const tests = {
    supports: [
      new RegExp(`${source}${between}(?:支持|支撑|促进|保障|有助于|服务于)${between}${target}`),
      new RegExp(`${target}${between}(?:依托|基于|以)${between}${source}${between}(?:为基础|为支撑|为保障)`),
    ],
    related_to: [
      new RegExp(`${source}${between}(?:与|和)${between}${target}${between}(?:相关|联系|相互作用)`),
      new RegExp(`${target}${between}(?:与|和)${between}${source}${between}(?:相关|联系|相互作用)`),
    ],
    reframed_by: [
      new RegExp(`${source}${between}(?:被|由)${between}${target}${between}(?:重构|重述|重新表述)`),
      new RegExp(`${target}${between}(?:重构|重述|重新表述)${between}${source}`),
    ],
    split_into: [new RegExp(`${source}${between}(?:拆分|分化|细分)${between}(?:为|成)${between}${target}`)],
    merged_from: [new RegExp(`${source}${between}(?:合并|整合)${between}(?:自|于|来自)${between}${target}`)],
    replaced_by: [
      new RegExp(`${source}${between}(?:被|由)${between}${target}${between}(?:取代|替代)`),
      new RegExp(`${target}${between}(?:取代|替代)${between}${source}`),
    ],
  };
  return (tests[relationType] || []).some((pattern) => pattern.test(text));
}

function validateRelations(manifest, scopes, assertionResult, nodes, errors) {
  const { assertions, resolved } = assertionResult;
  const relations = uniqueMap(manifest.relations, 'id', errors, 'relation_id');
  for (const relation of relations.values()) {
    const source = nodes.get(relation.source);
    const target = nodes.get(relation.target);
    issue(errors, Boolean(source), 'relation_source_missing', `${relation.id} source ${relation.source} is missing`);
    issue(errors, Boolean(target), 'relation_target_missing', `${relation.id} target ${relation.target} is missing`);
    issue(errors, relation.source !== relation.target, 'relation_self_loop', `${relation.id} is a self-loop`);
    for (const scopeId of relation.scope_ids || []) {
      issue(errors, scopes.has(scopeId), 'relation_scope_missing', `${relation.id} references ${scopeId}`);
    }
    issue(errors, sha256(relation.assertion_basis) === relation.assertion_basis_sha256,
      'relation_basis_hash_mismatch', `${relation.id} assertion basis bytes are not bound`);
    const relationAssertions = (relation.evidence_assertion_ids || []).map((id) => assertions.get(id));
    issue(errors, relationAssertions.every(Boolean), 'relation_assertion_missing', `${relation.id} has dangling evidence`);
    issue(errors, relationAssertions.every((entry) => entry?.adjudication === 'accepted'),
      'relation_assertion_unaccepted', `${relation.id} has non-accepted evidence`);

    const boundAssertionIds = [...new Set((relation.content_bindings || []).map((binding) => binding.assertion_id))];
    issue(errors, exactSet(boundAssertionIds, relation.evidence_assertion_ids),
      'relation_content_evidence_set_mismatch', `${relation.id} evidence ids and content bindings differ`);
    const roles = new Set();
    const relationStatements = [];
    for (const binding of relation.content_bindings || []) {
      roles.add(binding.evidence_role);
      const resolvedAssertion = resolved.get(binding.assertion_id);
      issue(errors, Boolean(resolvedAssertion),
        'relation_content_assertion_unresolved', `${relation.id}/${binding.assertion_id} lacks canonical text`);
      if (!resolvedAssertion) continue;
      const { assertion, paragraph } = resolvedAssertion;
      const rangeValid = binding.text_start_offset >= assertion.start_offset
        && binding.text_end_offset > binding.text_start_offset
        && binding.text_end_offset <= assertion.end_offset;
      issue(errors, rangeValid,
        'relation_content_offset_error', `${relation.id}/${binding.assertion_id} leaves the accepted assertion`);
      const boundText = rangeValid
        ? paragraph.body.slice(binding.text_start_offset, binding.text_end_offset)
        : '';
      issue(errors, sha256(boundText) === binding.text_sha256,
        'relation_content_hash_mismatch', `${relation.id}/${binding.assertion_id} digest differs from canonical text`);
      if (binding.evidence_role === 'source_endpoint' && source) {
        issue(errors, binding.assertion_id === source.field_binding_assertion_id && boundText === source.label,
          'relation_source_content_mismatch', `${relation.id} source endpoint is not content-bound`);
      }
      if (binding.evidence_role === 'target_endpoint' && target) {
        issue(errors, binding.assertion_id === target.field_binding_assertion_id && boundText === target.label,
          'relation_target_content_mismatch', `${relation.id} target endpoint is not content-bound`);
      }
      if (binding.evidence_role === 'relation_statement' && source && target) {
        relationStatements.push(boundText);
        issue(errors, boundText.includes(source.label) && boundText.includes(target.label),
          'relation_statement_content_mismatch', `${relation.id} canonical statement does not name both endpoints`);
      }
    }
    issue(errors, roles.has('source_endpoint') && roles.has('target_endpoint'),
      'relation_endpoint_content_missing', `${relation.id} needs canonical content for both endpoints`);
    issue(errors, relation.provenance_mode === 'explicit_canonical_statement_v1',
      'relation_provenance_mode_invalid', `${relation.id} lacks controlled relation provenance`);
    issue(errors, relationStatements.length === 1,
      'relation_statement_cardinality_error', `${relation.id} needs exactly one canonical relation statement`);
    if (source && target && relationStatements.length === 1) {
      issue(errors, relation.assertion_basis === relationStatements[0],
        'relation_basis_not_canonical_statement', `${relation.id} assertion_basis is not the exact canonical relation statement`);
      issue(errors, canonicalStatementSupportsRelation(
        relation.relation_type,
        relationStatements[0],
        source.label,
        target.label,
      ), 'relation_semantics_not_supported', `${relation.id} type or direction is not explicitly stated in canonical text`);
    }

    if (!source || !target) continue;
    const endpointScopes = [...new Set([source.scope_id, target.scope_id])];
    if (CROSS_VERSION_RELATIONS.has(relation.relation_type)) {
      issue(errors, endpointScopes.length === 2 && relation.scope_ids.length === 2,
        'cross_version_two_sided_evidence_required', `${relation.id} must join two explicit scopes`);
      issue(errors, exactSet(relation.scope_ids, endpointScopes),
        'cross_version_scope_mismatch', `${relation.id} scope list differs from its endpoints`);
      const evidenceScopes = new Set(relationAssertions.filter(Boolean).map((entry) => entry.scope_id));
      issue(errors, endpointScopes.every((scopeId) => evidenceScopes.has(scopeId)),
        'cross_version_two_sided_evidence_required', `${relation.id} lacks accepted evidence from both scopes`);
      const editions = new Set(endpointScopes.map((scopeId) => scopes.get(scopeId)?.edition_id));
      issue(errors, editions.size === 2, 'cross_version_distinct_editions_required', `${relation.id} does not span two editions`);
      issue(errors, relation.reviewer?.method === 'manual_cross_version_review',
        'cross_version_manual_review_required', `${relation.id} lacks an explicit cross-version reviewer`);
    } else {
      issue(errors, roles.has('relation_statement'),
        'relation_statement_content_missing', `${relation.id} needs an exact canonical relation statement`);
      issue(errors, endpointScopes.length === 1 && relation.scope_ids.length === 1
        && relation.scope_ids[0] === endpointScopes[0],
      'within_scope_relation_mismatch', `${relation.id} must stay inside one scope`);
      issue(errors, relationAssertions.every((entry) => entry?.scope_id === endpointScopes[0]),
        'relation_assertion_cross_scope', `${relation.id} evidence leaves its endpoint scope`);
    }
  }
  return relations;
}

function validateBuilderIsolation(manifest, context, errors) {
  issue(errors, !/ontology-candidates|ontology-release(?:-manifest|\.schema)?/.test(context.builder_source),
    'builder_reads_unreviewed_bridge', 'build-concept-evolution must not read candidates or the release bridge in this batch');
  for (const artifactKey of ['public_core', 'public_academic']) {
    const fingerprints = context.artifacts[artifactKey].json.input_fingerprints || {};
    issue(errors, !Object.keys(fingerprints).some((key) => /candidate|ontology_release/.test(key)),
      'public_builder_candidate_fingerprint', `${artifactKey} exposes an unreviewed candidate/release input`);
  }
  issue(errors, manifest.input_fingerprints.public_core.ontology_node_count === EXPECTED_PUBLIC_ONTOLOGY_NODES
    && manifest.input_fingerprints.public_academic.ontology_node_count === EXPECTED_PUBLIC_ONTOLOGY_NODES,
  'public_graph_count_changed', 'this bridge batch must preserve 169 public ontology nodes');
}

function validateEmptyState(manifest, context, errors) {
  const gate = manifest.release_gate;
  issue(errors, manifest.builder_input_allowed === false, 'empty_builder_unlock', 'empty release cannot enter the builder');
  issue(errors, manifest.public_data_update_allowed === false, 'empty_public_update_unlock', 'empty release cannot update public data');
  issue(errors, manifest.assertions.length === 0, 'empty_release_has_assertions', 'empty release must have no assertions');
  issue(errors, manifest.nodes.length === 0, 'empty_release_has_nodes', 'empty release must have no nodes');
  issue(errors, manifest.relations.length === 0, 'empty_release_has_relations', 'empty release must have no relations');
  issue(errors, manifest.negative_historical_assertions.length === 0,
    'negative_historical_assertion_forbidden', 'v1 does not publish negative historical claims');
  issue(errors, gate.release_authorized === false, 'empty_release_authorized', 'empty release cannot be authorized');
  issue(errors, gate.candidate_nodes_promoted === 0, 'empty_release_promoted_nodes', 'no candidate node may be promoted');
  issue(errors, gate.accepted_leaf_nodes === 0, 'empty_release_accepted_leaves', 'empty release has no accepted leaves');
  issue(errors, gate.source_controls_resolved === false, 'empty_source_controls_claimed', 'source controls remain unresolved');
  issue(errors, gate.complete_historical_coverage === false, 'complete_history_fabricated', 'historical coverage is incomplete');
  issue(errors, gate.negative_historical_assertions_allowed === false,
    'negative_history_unlock', 'negative historical assertions must remain disabled');
  issue(errors, gate.reviewed_by === null && gate.reviewed_at === null,
    'empty_release_fake_reviewer', 'empty release must not fabricate an approval');
  issue(errors, exactSet(gate.reason_codes, EMPTY_REASON_CODES),
    'empty_reason_codes_drift', 'empty release reason codes must state every active block');
  issue(errors, (context.artifacts.page_publication.json.documents || []).length === 0,
    'page_publication_not_empty', 'the pinned fail-closed example expects zero accepted page documents');
}

function validateReviewedState(manifest, nodeResult, errors) {
  const gate = manifest.release_gate;
  issue(errors, manifest.builder_input_allowed === true, 'reviewed_builder_gate_closed', 'reviewed release is not enabled for explicit integration');
  issue(errors, manifest.public_data_update_allowed === true, 'reviewed_public_gate_closed', 'reviewed release is not enabled for explicit integration');
  issue(errors, gate.release_authorized === true, 'reviewed_release_not_authorized', 'reviewer authorization is missing');
  issue(errors, gate.source_controls_resolved === true, 'source_controls_unresolved', 'reviewed release retains source controls');
  issue(errors, typeof gate.reviewed_by === 'string' && gate.reviewed_by.length > 0 && typeof gate.reviewed_at === 'string',
    'release_reviewer_missing', 'reviewed release needs reviewer identity and time');
  issue(errors, gate.candidate_nodes_promoted === manifest.nodes.length,
    'promoted_node_count_mismatch', `declared ${gate.candidate_nodes_promoted}, actual ${manifest.nodes.length}`);
  issue(errors, gate.accepted_leaf_nodes === nodeResult.acceptedLeaves.length,
    'accepted_leaf_count_mismatch', `declared ${gate.accepted_leaf_nodes}, actual ${nodeResult.acceptedLeaves.length}`);
  issue(errors, gate.complete_historical_coverage === false,
    'complete_history_fabricated', 'current corpus is not complete historical coverage');
  issue(errors, gate.negative_historical_assertions_allowed === false,
    'negative_history_unlock', 'v1 only permits positive, source-bound assertions');
}

export function validateOntologyRelease(manifest, context) {
  const errors = schemaErrors(manifest, context.schema, context.schema);
  if (errors.length > 0) {
    return {
      valid: false,
      publishable: false,
      publication_state: manifest?.publication_state || null,
      errors,
    };
  }

  let pageManifest = { documents: [] };
  try {
    pageManifest = validatePagePublicationManifest(context.artifacts.page_publication.json);
  } catch (error) {
    errors.push(`page_manifest_contract_invalid: ${error.message}`);
  }

  validateFingerprints(manifest, context, errors);
  const scopes = validateSourceLock(manifest, context, errors);
  validateFacetCoverage(manifest, context, errors);
  validateBuilderIsolation(manifest, context, errors);
  const provenance = candidateProvenance(context.artifacts.candidate.json, errors);
  const assertionResult = validateAssertions(manifest, context, scopes, pageManifest, provenance, errors);
  const nodeResult = validateNodes(manifest, scopes, assertionResult, provenance, errors);
  const relations = validateRelations(manifest, scopes, assertionResult, nodeResult.nodes, errors);

  issue(errors, manifest.negative_historical_assertions.length === 0,
    'negative_historical_assertion_forbidden', 'v1 requires complete coverage before a new policy can admit negative claims');
  issue(errors, context.artifacts.public_academic.json.coverage?.complete_historical_coverage === false,
    'academic_coverage_contract_drift', 'public academic graph must explicitly deny complete historical coverage');
  issue(errors, context.artifacts.public_academic.json.coverage?.negative_claim_eligible === false,
    'negative_claim_gate_drift', 'public academic graph must explicitly deny negative claims');

  if (manifest.publication_state === 'empty_fail_closed') validateEmptyState(manifest, context, errors);
  else validateReviewedState(manifest, nodeResult, errors);

  const publishable = errors.length === 0
    && manifest.publication_state === 'reviewed_release'
    && manifest.release_gate.release_authorized === true
    && nodeResult.acceptedLeaves.length > 0;
  return {
    valid: errors.length === 0,
    publishable,
    publication_state: manifest.publication_state,
    counts: {
      scopes: scopes.size,
      assertions: assertionResult.assertions.size,
      nodes: nodeResult.nodes.size,
      leaves: nodeResult.leaves.length,
      accepted_leaves: nodeResult.acceptedLeaves.length,
      relations: relations.size,
      public_ontology_nodes: context.artifacts.public_academic.json.ontology_nodes.length,
    },
    facet_coverage: manifest.facet_coverage,
    builder_isolated: !/ontology-candidates|ontology-release(?:-manifest|\.schema)?/.test(context.builder_source),
    immutable_public_baseline: {
      artifact_path: context.public_baseline?.path || null,
      anchor_commit: context.public_baseline?.anchor_commit || null,
      source_commit: context.public_baseline?.source_commit || null,
      artifact_sha256: context.public_baseline?.artifact_sha256 || null,
    },
    errors,
  };
}

export function assertOntologyReleaseGate(report, { requirePublishable = false } = {}) {
  if (!report?.valid) {
    const error = new Error(`ontology release bridge is invalid: ${(report?.errors || ['missing report']).join('; ')}`);
    error.report = report;
    throw error;
  }
  if (requirePublishable && !report.publishable) {
    const error = new Error('ontology release bridge is valid but not publishable');
    error.report = report;
    throw error;
  }
  return true;
}

export async function validateOntologyReleaseFile({
  root = PROJECT_ROOT,
  manifest = DEFAULT_MANIFEST,
  requirePublishable = false,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const manifestPath = path.resolve(resolvedRoot, manifest);
  if (manifestPath !== resolvedRoot && !manifestPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('ontology release manifest must remain inside the project root');
  }
  const value = JSON.parse(await readFile(manifestPath, 'utf8'));
  const context = await loadOntologyReleaseContext(resolvedRoot);
  const report = validateOntologyRelease(value, context);
  assertOntologyReleaseGate(report, { requirePublishable });
  return report;
}

function parseArgs(argv) {
  const options = { manifest: DEFAULT_MANIFEST, requirePublishable: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--require-publishable') options.requirePublishable = true;
    else if (arg === '--manifest') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--manifest requires a path');
      options.manifest = value;
      index += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  try {
    const report = await validateOntologyReleaseFile({
      root: PROJECT_ROOT,
      manifest: options.manifest,
      requirePublishable: options.requirePublishable,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    if (error.report) process.stdout.write(`${JSON.stringify(error.report, null, 2)}\n`);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`ontology-release validation failed: ${error.message}\n`);
    process.exitCode = 2;
  });
}
