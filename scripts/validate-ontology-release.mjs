#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MANIFEST = 'data/ontology-release-manifest.json';
const EXPECTED_PUBLIC_ONTOLOGY_NODES = 169;
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

export async function loadOntologyReleaseContext(root = PROJECT_ROOT) {
  const entries = await Promise.all(Object.entries(INPUT_PATHS)
    .map(async ([key, relativePath]) => [key, await readArtifact(root, relativePath)]));
  return {
    root,
    schema: JSON.parse(await readFile(path.join(root, 'data/ontology-release.schema.json'), 'utf8')),
    artifacts: Object.fromEntries(entries),
    builder_source: await readFile(path.join(root, 'scripts/build-concept-evolution.mjs'), 'utf8'),
  };
}

function validateFingerprints(manifest, context, errors) {
  for (const [key, expectedPath] of Object.entries(INPUT_PATHS)) {
    const declared = manifest.input_fingerprints[key];
    const artifact = context.artifacts[key];
    issue(errors, declared.path === expectedPath, 'fingerprint_path_drift', `${key} must bind ${expectedPath}`);
    issue(errors, declared.sha256 === artifact.sha256, 'fingerprint_sha256_mismatch', `${key} bytes do not match the manifest`);
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

function validateAssertions(manifest, context, scopes, errors) {
  const assertions = uniqueMap(manifest.assertions, 'assertion_id', errors, 'assertion_id');
  const pageManifest = context.artifacts.page_publication.json;
  const online = context.artifacts.online_verification.json;
  const onlineSources = validateOnlineEvidenceInvariant(online, errors);
  const claims = uniqueMap(online.claims, 'claim_id', errors, 'online_claim_id');
  const mismatchSources = new Set((online.version_mismatch_controls || []).map((control) => control.source_id));
  const blockedPages = new Set((context.artifacts.candidate.json.excluded_page_controls || [])
    .map((control) => control.physical_page));
  const pageDocuments = new Map((pageManifest.documents || []).map((document) => [document.document_id, document]));

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

    for (const claimId of assertion.online_claim_ids || []) {
      const claim = claims.get(claimId);
      issue(errors, Boolean(claim), 'online_claim_missing', `${assertion.assertion_id} references ${claimId}`);
      if (!claim) continue;
      issue(errors, claim.verification_status === 'independently_crosschecked',
        'online_claim_unresolved', `${claimId} is ${claim.verification_status}`);
      const exactSupport = new Set((claim.crosschecks || [])
        .filter((entry) => entry.role === 'independent_exact_support' && entry.independent_for_claim === true)
        .map((entry) => entry.source_id));
      const selected = (assertion.independent_online_source_ids || [])
        .filter((sourceId) => exactSupport.has(sourceId));
      issue(errors, selected.length >= 2,
        'insufficient_independent_online_evidence', `${assertion.assertion_id}/${claimId} has ${selected.length} exact independent sources`);
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
  return assertions;
}

function validateNodes(manifest, scopes, assertions, errors) {
  const nodes = uniqueMap(manifest.nodes, 'id', errors, 'node_id');
  const childCounts = new Map([...nodes.keys()].map((id) => [id, 0]));

  for (const node of nodes.values()) {
    issue(errors, scopes.has(node.scope_id), 'node_scope_missing', `${node.id} scope is unknown`);
    issue(errors, !node.id.startsWith('candidate:'), 'candidate_id_promoted_directly', `${node.id} reuses a candidate identity`);
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
  const acceptedLeaves = leaves.filter((node) => node.citation_allowed === true
    && node.review_status === 'editor_reviewed'
    && node.label_kind === 'official_term'
    && node.source_assertion_ids.length > 0
    && node.source_assertion_ids.every((id) => assertions.get(id)?.adjudication === 'accepted'));

  if (manifest.publication_state === 'reviewed_release') {
    for (const leaf of leaves) {
      issue(errors, acceptedLeaves.includes(leaf), 'leaf_without_accepted_assertion', `${leaf.id} is not an accepted scholarly leaf`);
    }
    issue(errors, acceptedLeaves.length > 0, 'no_accepted_leaf_nodes', 'reviewed releases need at least one accepted leaf');
  }

  return { nodes, leaves, acceptedLeaves };
}

function validateRelations(manifest, scopes, assertions, nodes, errors) {
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
    const relationAssertions = (relation.evidence_assertion_ids || []).map((id) => assertions.get(id));
    issue(errors, relationAssertions.every(Boolean), 'relation_assertion_missing', `${relation.id} has dangling evidence`);
    issue(errors, relationAssertions.every((entry) => entry?.adjudication === 'accepted'),
      'relation_assertion_unaccepted', `${relation.id} has non-accepted evidence`);

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

  validateFingerprints(manifest, context, errors);
  const scopes = validateSourceLock(manifest, context, errors);
  validateFacetCoverage(manifest, context, errors);
  validateBuilderIsolation(manifest, context, errors);
  const assertions = validateAssertions(manifest, context, scopes, errors);
  const nodeResult = validateNodes(manifest, scopes, assertions, errors);
  const relations = validateRelations(manifest, scopes, assertions, nodeResult.nodes, errors);

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
      assertions: assertions.size,
      nodes: nodeResult.nodes.size,
      leaves: nodeResult.leaves.length,
      accepted_leaves: nodeResult.acceptedLeaves.length,
      relations: relations.size,
      public_ontology_nodes: context.artifacts.public_academic.json.ontology_nodes.length,
    },
    facet_coverage: manifest.facet_coverage,
    builder_isolated: !/ontology-candidates|ontology-release(?:-manifest|\.schema)?/.test(context.builder_source),
    errors,
  };
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
  const manifestPath = path.resolve(PROJECT_ROOT, options.manifest);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const context = await loadOntologyReleaseContext(PROJECT_ROOT);
  const report = validateOntologyRelease(manifest, context);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.valid || (options.requirePublishable && !report.publishable)) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`ontology-release validation failed: ${error.message}\n`);
    process.exitCode = 2;
  });
}
