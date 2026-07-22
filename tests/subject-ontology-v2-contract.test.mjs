import assert from 'node:assert/strict';
import {
  createHash,
  generateKeyPairSync,
  sign as signMessage,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_FACETS,
  buildIndependentCoverageCatalog,
  computeRelationDiffSha256,
  deriveFacetCoverageAuthority,
  prepareGovernedReviewSigningPayload,
  prepareRelationAdjudicationSigningPayload,
  resolveSubjectOntologyEvidenceForTest,
  subjectOntologyObjectSha256ForTest,
  validateSubjectOntologyFixtureForTest,
  validateSubjectOntologyV2,
  validateSubjectOntologyV2PromotionForRelease,
} from '../scripts/validate-subject-ontology-v2.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const H = (value) => createHash('sha256').update(value).digest('hex');
const POLICY_SHA = H('ontology-review-policy-v2');
const REVIEWER_REGISTRY_SHA = H('reviewers');
const CORPUS_MANIFEST_SHA = H('corpus-manifest');
const CORPUS_FINGERPRINT = H('corpus-fingerprint');
const PAGE_MANIFEST_SHA = H('page-manifest');
const AS_OF_DATE = '2002-12-31';

function review(reviewer = 'reviewer-a', policy = POLICY_SHA) {
  return {
    reviewer_id: reviewer,
    reviewed_at: '2026-07-22T05:00:00Z',
    policy_revision_sha256: policy,
    decision: 'accepted',
  };
}

function withoutReview(value) {
  const { review: _review, ...subject } = value;
  return subject;
}

function signedGovernedReview(reviewKind, subject, privateKey, reviewer = 'governed-reviewer') {
  const value = {
    policy: 'signed_subject_ontology_governed_review_v1',
    reviewer_id: reviewer,
    reviewed_at: '2026-07-22T05:00:00Z',
    policy_revision_sha256: REVIEWER_REGISTRY_SHA,
    decision: 'accepted',
    reviewer_role: 'semantic_resolution',
    signature_algorithm: 'Ed25519',
    signed_payload_sha256: '',
    signature_base64: '',
  };
  const prepared = prepareGovernedReviewSigningPayload({ reviewKind, subject, review: value });
  value.signed_payload_sha256 = prepared.payload_sha256;
  value.signature_base64 = signMessage(
    null,
    Buffer.from(prepared.payload_text, 'utf8'),
    privateKey,
  ).toString('base64');
  return value;
}

function gate(negative = true) {
  return {
    mode: 'explicit_promotion',
    builder_input_allowed: true,
    public_data_update_allowed: true,
    semantic_claims_allowed: true,
    negative_historical_assertions_allowed: negative,
    reason_codes: ['all_evidence_and_coverage_gates_passed'],
  };
}

function zeroFacet(facet) {
  return {
    ...facet,
    status: 'not_started',
    scope_files: [],
    coverage: {
      scope_count: 0,
      concept_count: 0,
      semantic_relation_count: 0,
      current_ordinary_scope_complete: false,
      historical_coverage_complete: false,
      unknown_or_unresolved: true,
      reason_codes: ['not_started'],
    },
  };
}

function page(documentId, physicalPage, target) {
  const anchors = {
    title: target.title,
    issuing_body_or_author: target.issuer,
    year_or_publication_context: target.year,
    version_label: target.version,
    section_or_item_locator: `${documentId}:page:${physicalPage}`,
  };
  return {
    document_id: documentId,
    physical_page: physicalPage,
    bundle_sha256: H(`bundle:${documentId}:${physicalPage}`),
    signed_reviewer_payload_sha256: H(`signed:${documentId}:${physicalPage}`),
    reviewer_id: 'page-reviewer',
    reviewed_at: '2026-07-22T04:00:00Z',
    citation_allowed: true,
    display_allowed: true,
    review_status: 'accepted',
    online_claims: [
      {
        claim_id: `${documentId}:official`,
        version_match: 'exact_document_exact_edition',
        version_anchors: anchors,
        canonical_origin: 'https://official.example.test',
        canonical_publisher: 'Ministry publisher',
        independence_group: 'ministry-origin',
        capture_body_sha256: H(`official-body:${documentId}`),
        supporting_slice_sha256: H(`official-slice:${documentId}`),
      },
      {
        claim_id: `${documentId}:academic`,
        version_match: 'exact_document_exact_edition',
        version_anchors: anchors,
        canonical_origin: 'https://academic.example.test',
        canonical_publisher: 'University press',
        independence_group: 'university-origin',
        capture_body_sha256: H(`academic-body:${documentId}`),
        supporting_slice_sha256: H(`academic-slice:${documentId}`),
      },
    ],
  };
}

function exactEvidence(scopeId, edition, body, paragraphOrdinal, physicalPage) {
  const matchedText = '语言文字运用';
  const start = body.indexOf(matchedText);
  const currentPage = page(edition.document_id, physicalPage, {
    title: edition.title,
    issuer: '教育部',
    year: edition.issued_date.slice(0, 4),
    version: edition.version_label,
  });
  return {
    evidence: {
      evidence_id: `evidence:${edition.document_id}`,
      scope_id: scopeId,
      edition_id: edition.edition_id,
      document_id: edition.document_id,
      physical_page: physicalPage,
      paragraph_ordinal: paragraphOrdinal,
      body_sha256: H(body),
      start_utf16: start,
      end_utf16: start + matchedText.length,
      matched_text: matchedText,
      matched_text_sha256: H(matchedText),
      canonical_page_evidence: {
        release_manifest_sha256: PAGE_MANIFEST_SHA,
        bundle_sha256: currentPage.bundle_sha256,
        signed_reviewer_payload_sha256: currentPage.signed_reviewer_payload_sha256,
        reviewer_id: currentPage.reviewer_id,
        reviewed_at: currentPage.reviewed_at,
        online_claim_ids: currentPage.online_claims.map((claim) => claim.claim_id),
      },
      corpus_release: {
        release_id: 'corpus-aaaaaaaaaaaaaaaaaaaaaaaa',
        manifest_sha256: CORPUS_MANIFEST_SHA,
        release_fingerprint_sha256: CORPUS_FINGERPRINT,
      },
    },
    paragraph: {
      corpus_release_id: 'corpus-aaaaaaaaaaaaaaaaaaaaaaaa',
      document_id: edition.document_id,
      edition_id: edition.edition_id,
      paragraph_ordinal: paragraphOrdinal,
      physical_page: physicalPage,
      body,
      body_sha256: H(body),
      citation_allowed: true,
      display_allowed: true,
    },
    page: currentPage,
  };
}

function hierarchyAndConcepts(prefix, evidenceId) {
  const families = ['goal', 'content_task', 'capability', 'literacy', 'academic_quality'];
  return {
    hierarchies: families.map((family) => ({
      family,
      status: 'applicable',
      reviewed_complete: true,
      root_concept_ids: [`concept:${prefix}:${family}`],
      reason: null,
    })),
    concepts: families.map((family) => ({
      concept_id: `concept:${prefix}:${family}`,
      family,
      parent_concept_id: null,
      label: `${prefix}-${family}`,
      sense_id: `sense:${prefix}:${family}`,
      status: 'reviewed',
      evidence_ids: [evidenceId],
    })),
  };
}

function makeScope({ id, record, evidence, predecessor = null, current = false }) {
  const hierarchy = hierarchyAndConcepts(record.document_id, evidence.evidence_id);
  const value = {
    schema_version: 2,
    artifact_kind: 'subject_ontology_scope',
    contract_id: 'subject-ontology-v2',
    scope_id: id,
    facet_id: record.facet_id,
    subject: {
      source_label: record.source_label,
      canonical_label: record.subject_label,
      subject_id: record.subject_id,
    },
    work: { work_id: record.work_id, title: record.work_title },
    edition: {
      edition_id: record.edition_id,
      document_id: record.document_id,
      version_label: record.version_label,
      issued_date: record.issued_date,
      source_artifact_sha256: record.source_artifact_sha256,
      valid_from_year: record.valid_from_year,
      valid_to_year: record.valid_to_year,
    },
    scope_dimensions: {
      population: record.population,
      document_function: record.document_function,
      stage: record.stage,
    },
    status: 'reviewed_release',
    lineage_assertion: predecessor ? {
      kind: 'revision',
      assertion_type: 'exact_edition_revision',
      assertion_text: `${record.edition_id} revises ${predecessor.editionId}`,
      assertion_sha256: H(`${record.edition_id} revises ${predecessor.editionId}`),
      predecessor_scope_id: predecessor.scopeId,
      predecessor_edition_id: predecessor.editionId,
      coverage_universe_id: null,
      evidence_roles: [
        { role: 'predecessor_version', scope_id: predecessor.scopeId, edition_id: predecessor.editionId, evidence_ids: [predecessor.evidenceId] },
        { role: 'current_version', scope_id: id, edition_id: record.edition_id, evidence_ids: [evidence.evidence_id] },
      ],
      review: review(),
    } : {
      kind: 'first_edition',
      assertion_type: 'first_edition_in_bounded_catalog_universe',
      assertion_text: `${record.edition_id} is first only inside universe:historical`,
      assertion_sha256: H(`${record.edition_id} is first only inside universe:historical`),
      predecessor_scope_id: null,
      predecessor_edition_id: null,
      coverage_universe_id: 'universe:historical',
      evidence_roles: [
        { role: 'first_edition_identity', scope_id: id, edition_id: record.edition_id, evidence_ids: [evidence.evidence_id] },
      ],
      review: review(),
    },
    ...hierarchy,
    evidence: [evidence],
    relations: [],
    coverage: {
      current_ordinary_status: current ? 'human_reviewed_complete' : 'incomplete_unknown',
      current_ordinary_universe_id: current ? 'universe:current' : null,
      historical_status: 'human_reviewed_complete',
      historical_universe_id: 'universe:historical',
      negative_claim_eligible: true,
    },
    unresolved_items: [],
    release_gate: gate(true),
    review: review(),
  };
  Object.defineProperty(value, '__registry_path', {
    value: `data/ontologies/chinese-language/${record.document_id}.json`,
    enumerable: false,
  });
  return value;
}

function governedInputs() {
  const catalog = {
    generated_at: `${AS_OF_DATE}T00:00:00Z`,
    documents: [
      {
        id: 'doc-old', subject: '语文', title: '语文课程标准（2000年版）', document_type: '课程标准',
        stage: '义务教育', version_label: '2000年版', issued_date: '2000-01-01',
        checksum_sha256: H('pdf:doc-old'), current_status: 'superseded',
      },
      {
        id: 'doc-new', subject: '语文', title: '语文课程标准（2001年版）', document_type: '课程标准',
        stage: '义务教育', version_label: '2001年版', issued_date: '2001-01-01',
        checksum_sha256: H('pdf:doc-new'), current_status: 'current_with_revision_watch',
      },
    ],
  };
  const subjectFacetGroups = Object.fromEntries(CANONICAL_FACETS.map((facet) => [facet.label, []]));
  subjectFacetGroups['语文'] = ['语文'];
  const taxonomy = {
    subject_taxonomy: {
      语文: {
        canonical: '语文', stable_subject_id: 'subject:chinese', entity_kind: 'subject',
        classification: 'ordinary_subject', facet_eligible: true,
      },
    },
    subject_facet_groups: subjectFacetGroups,
    document_entity_overrides: {},
  };
  const sources = catalog.documents.flatMap((document) => [1, 2].map((number) => ({
    document_id: document.id,
    provider: `provider-${number}`,
    source_page_url: `https://source${number}.example.test/${document.id}`,
    source_url: `https://source${number}.example.test/${document.id}.pdf`,
    checksum_sha256: document.checksum_sha256,
    access_status: 'available',
    is_primary: number === 1,
  })));
  return { catalog, taxonomy, provenance: { sources } };
}

function sealOntologyArtifacts(value) {
  value.context.ontology_artifacts.index.object_sha256 = subjectOntologyObjectSha256ForTest(value.index);
  for (const scope of value.scopes) {
    const path = scope.__registry_path;
    const identity = value.context.ontology_artifacts.scope_files.find((row) => row.path === path);
    identity.object_sha256 = subjectOntologyObjectSha256ForTest(scope);
  }
  return value;
}

function fixture() {
  const governed = governedInputs();
  const coverageCatalog = buildIndependentCoverageCatalog(governed);
  const coverageAuthority = deriveFacetCoverageAuthority({
    catalog: governed.catalog,
    taxonomy: governed.taxonomy,
    coverageCatalog,
  });
  const oldRecord = coverageCatalog.find((record) => record.document_id === 'doc-old');
  const newRecord = coverageCatalog.find((record) => record.document_id === 'doc-new');
  const oldEdition = { ...governed.catalog.documents[0], ...oldRecord, title: governed.catalog.documents[0].title };
  const newEdition = { ...governed.catalog.documents[1], ...newRecord, title: governed.catalog.documents[1].title };
  const oldExact = exactEvidence('scope:old', oldEdition, '课程目标：语言文字运用。', 1, 10);
  const newExact = exactEvidence('scope:new', newEdition, '课程目标：语言文字运用能力。', 1, 11);
  const oldScope = makeScope({ id: 'scope:old', record: oldRecord, evidence: oldExact.evidence });
  const newScope = makeScope({
    id: 'scope:new', record: newRecord, evidence: newExact.evidence, current: true,
    predecessor: {
      scopeId: oldScope.scope_id,
      editionId: oldScope.edition.edition_id,
      evidenceId: oldExact.evidence.evidence_id,
    },
  });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const governedKeys = generateKeyPairSync('ed25519');
  const context = {
    context_kind: 'test_fixture_v2',
    prepared_release: {
      git_head: 'a'.repeat(40),
      source_tree_sha256: H('source-tree'),
      corpus_release_id: oldExact.evidence.corpus_release.release_id,
      corpus_manifest_sha256: oldExact.evidence.corpus_release.manifest_sha256,
      corpus_release_fingerprint_sha256: oldExact.evidence.corpus_release.release_fingerprint_sha256,
    },
    source_bindings: {
      taxonomy_sha256: H('taxonomy'),
      catalog_sha256: H('catalog'),
      provenance_sha256: H('provenance'),
      corpus_manifest_file_sha256: H('corpus-file'),
      reviewer_registry_sha256: REVIEWER_REGISTRY_SHA,
      online_source_registry_sha256: H('sources'),
      online_verification_standard_sha256: H('online-standard'),
    },
    ontology_artifacts: {
      index: {
        path: 'data/ontologies/index.json', sha256: H('index-bytes'), bytes: 1,
        object_sha256: H('unsealed-index'),
      },
      scope_files: [oldScope, newScope].map((scope) => ({
        path: scope.__registry_path,
        sha256: H(`scope-bytes:${scope.scope_id}`),
        bytes: 1,
        object_sha256: H(`unsealed:${scope.scope_id}`),
      })),
    },
    page_evidence: {
      manifest_sha256: PAGE_MANIFEST_SHA,
      policy_revision_sha256: POLICY_SHA,
      pages: [oldExact.page, newExact.page],
    },
    paragraphs: [oldExact.paragraph, newExact.paragraph],
    coverage_catalog: coverageCatalog,
    coverage_authority: coverageAuthority,
    reviewer_registry: [
      {
        reviewer_id: 'relation-reviewer',
        display_name: 'Relation Reviewer',
        status: 'active',
        valid_from: '2026-01-01T00:00:00Z',
        valid_until: null,
        scopes: ['semantic_resolution'],
        public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      },
      {
        reviewer_id: 'governed-reviewer',
        display_name: 'Governed Ontology Reviewer',
        status: 'active',
        valid_from: '2026-01-01T00:00:00Z',
        valid_until: null,
        scopes: ['semantic_resolution'],
        public_key_pem: governedKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      },
    ],
  };
  const resolved = new Map([
    [oldExact.evidence.evidence_id, resolveSubjectOntologyEvidenceForTest(oldScope, oldExact.evidence, context)],
    [newExact.evidence.evidence_id, resolveSubjectOntologyEvidenceForTest(newScope, newExact.evidence, context)],
  ]);
  const relation = {
    relation_id: 'relation:rename-old-new',
    relation_type: 'rename',
    assertion_text: 'The reviewed exact-edition term changes across the two editions.',
    source_endpoints: [{
      scope_id: oldScope.scope_id,
      edition_id: oldScope.edition.edition_id,
      sense_id: oldScope.concepts[0].sense_id,
      evidence_ids: [oldExact.evidence.evidence_id],
    }],
    target_endpoints: [{
      scope_id: newScope.scope_id,
      edition_id: newScope.edition.edition_id,
      sense_id: newScope.concepts[0].sense_id,
      evidence_ids: [newExact.evidence.evidence_id],
    }],
    relation_diff_sha256: '',
    adjudication: {
      policy: 'signed_subject_ontology_relation_adjudication_v1',
      reviewer_id: 'relation-reviewer',
      decided_at: '2026-07-22T05:00:00Z',
      semantic_basis_code: 'equivalent_meaning_lexical_change',
      signature_algorithm: 'Ed25519',
      signed_payload_sha256: '',
      signature_base64: '',
    },
    review: review('relation-reviewer', REVIEWER_REGISTRY_SHA),
  };
  const preparedAdjudication = prepareRelationAdjudicationSigningPayload(relation, resolved);
  relation.adjudication.signed_payload_sha256 = preparedAdjudication.payload_sha256;
  relation.adjudication.signature_base64 = signMessage(
    null,
    Buffer.from(preparedAdjudication.payload_text, 'utf8'),
    privateKey,
  ).toString('base64');
  relation.relation_diff_sha256 = computeRelationDiffSha256(relation, resolved);
  newScope.relations.push(relation);

  const currentDecisions = [
    { document_id: 'doc-old', disposition: 'excluded', reason_code: 'not_current_as_of_catalog' },
    { document_id: 'doc-new', disposition: 'included', reason_code: 'included_exact_scope' },
  ];
  const historicalDecisions = [
    { document_id: 'doc-old', disposition: 'included', reason_code: 'included_exact_scope' },
    { document_id: 'doc-new', disposition: 'included', reason_code: 'included_exact_scope' },
  ];
  const universe = (id, purpose, decisions, includedScopeIds) => ({
    universe_id: id,
    facet_id: 'facet:chinese-language',
    purpose,
    as_of_date: AS_OF_DATE,
    subject_ids: ['subject:chinese'],
    start_year: 2000,
    end_year: 2002,
    population: 'ordinary_general_education',
    document_functions: ['curriculum_standard', 'teaching_syllabus', 'assessment_specification'],
    included_scope_ids: includedScopeIds,
    catalog_decisions: decisions,
    review: review('coverage-reviewer'),
  });
  const facets = CANONICAL_FACETS.map(zeroFacet);
  facets[0] = {
    ...facets[0],
    status: 'reviewed_release',
    scope_files: [oldScope.__registry_path, newScope.__registry_path],
    coverage: {
      scope_count: 2,
      concept_count: 10,
      semantic_relation_count: 1,
      current_ordinary_scope_complete: true,
      historical_coverage_complete: true,
      unknown_or_unresolved: false,
      reason_codes: ['governed_catalog_universe_reviewed'],
    },
  };
  const index = {
    schema_version: 2,
    artifact_kind: 'subject_ontology_index',
    contract_id: 'subject-ontology-v2',
    status: 'promotion_candidate',
    bindings: {
      taxonomy: { path: 'data/concept-model-v2.json', sha256: H('taxonomy') },
      catalog: { path: 'data/catalog.json', sha256: H('catalog') },
      provenance: { path: 'data/document-sources.json', sha256: H('provenance') },
      corpus_manifest: {
        path: 'data/corpus-chunks/manifest.json',
        sha256: H('corpus-file'),
        release_id: context.prepared_release.corpus_release_id,
        release_fingerprint_sha256: context.prepared_release.corpus_release_fingerprint_sha256,
        manifest_sha256: context.prepared_release.corpus_manifest_sha256,
      },
      page_evidence_manifest: { path: 'scripts/page-evidence/fail-closed-manifest.json', sha256: PAGE_MANIFEST_SHA },
      reviewer_registry: { path: 'scripts/page-evidence/reviewer-authorities.json', sha256: REVIEWER_REGISTRY_SHA },
      online_source_registry: { path: 'scripts/page-evidence/online-source-identities.json', sha256: H('sources') },
      online_verification_standard: { path: 'data/online-verification-standard.json', sha256: H('online-standard') },
      validation_report_path: 'data/subject-ontology-v2-validation.json',
    },
    canonical_facets: facets,
    coverage_universes: [
      universe('universe:current', 'current_ordinary', currentDecisions, [newScope.scope_id]),
      universe('universe:historical', 'historical_negative_claim', historicalDecisions, [oldScope.scope_id, newScope.scope_id]),
    ],
    release_gate: gate(true),
  };
  for (const universeValue of index.coverage_universes) {
    universeValue.review = signedGovernedReview(
      'coverage_universe',
      withoutReview(universeValue),
      governedKeys.privateKey,
    );
  }
  for (const scope of [oldScope, newScope]) {
    scope.lineage_assertion.review = signedGovernedReview(
      'lineage',
      { scope_id: scope.scope_id, ...withoutReview(scope.lineage_assertion) },
      governedKeys.privateKey,
    );
  }
  for (const scope of [oldScope, newScope]) {
    scope.review = signedGovernedReview('scope', withoutReview(scope), governedKeys.privateKey);
  }
  const result = sealOntologyArtifacts({
    index,
    scopes: [oldScope, newScope],
    context,
    resolved,
    governed,
  });
  Object.defineProperty(result, '__governed_private_key', {
    value: governedKeys.privateKey,
    enumerable: false,
  });
  return result;
}

function crossWorkFixture() {
  const value = fixture();
  const oldScope = value.scopes[0];
  const newScope = value.scopes[1];
  const oldRecord = value.context.coverage_catalog.find((record) => record.document_id === oldScope.edition.document_id);
  const newRecord = value.context.coverage_catalog.find((record) => record.document_id === newScope.edition.document_id);
  oldRecord.work_id = 'work:independent-earlier-standard';
  oldScope.work.work_id = oldRecord.work_id;
  newRecord.predecessor_document_id = null;
  newRecord.lineage_kind = 'first_edition';
  const assertionText = `${newScope.edition.edition_id} is first only inside universe:historical`;
  newScope.lineage_assertion = {
    kind: 'first_edition',
    assertion_type: 'first_edition_in_bounded_catalog_universe',
    assertion_text: assertionText,
    assertion_sha256: H(assertionText),
    predecessor_scope_id: null,
    predecessor_edition_id: null,
    coverage_universe_id: 'universe:historical',
    evidence_roles: [{
      role: 'first_edition_identity',
      scope_id: newScope.scope_id,
      edition_id: newScope.edition.edition_id,
      evidence_ids: [newScope.evidence[0].evidence_id],
    }],
    review: null,
  };
  newScope.lineage_assertion.review = signedGovernedReview(
    'lineage',
    { scope_id: newScope.scope_id, ...withoutReview(newScope.lineage_assertion) },
    value.__governed_private_key,
  );
  const relation = newScope.relations[0];
  relation.cross_subject_exception = {
    dimensions: ['work'],
    rationale: 'The exact-edition relation intentionally compares two separately governed curriculum works.',
    review: null,
  };
  relation.cross_subject_exception.review = signedGovernedReview(
    'cross_subject_exception',
    { relation_id: relation.relation_id, ...withoutReview(relation.cross_subject_exception) },
    value.__governed_private_key,
  );
  relation.relation_diff_sha256 = computeRelationDiffSha256(relation, value.resolved);
  for (const scope of value.scopes) {
    scope.review = signedGovernedReview('scope', withoutReview(scope), value.__governed_private_key);
  }
  return sealOntologyArtifacts(value);
}

function validatePromotion(value, { reseal = true } = {}) {
  if (reseal) sealOntologyArtifacts(value);
  return validateSubjectOntologyFixtureForTest(value);
}

test('checked-in v2 index is exact, zero-data, and ordinary fail-closed', () => {
  const result = validateSubjectOntologyV2({ rootDir: root });
  assert.equal(result.valid, true);
  assert.equal(result.publishable, false);
  assert.equal(result.counts.facets, 12);
  assert.equal(result.counts.scopes, 0);
  assert.equal(result.release_boundary.frontend_consumer_allowed, false);
  assert.equal(result.release_boundary.r2_consumer_allowed, false);
  assert.equal(result.release_boundary.release_builder_desired_manifest_only, true);
});

test('reviewed two-edition promotion fixture passes governed evidence, coverage, lineage, and relation gates', () => {
  const result = validatePromotion(fixture());
  assert.deepEqual(result, {
    valid: true,
    publishable: true,
    facets: 12,
    scopes: 2,
    coverage_universes: 2,
    concepts: 10,
    relations: 1,
  });
});

test('a committed non-empty promotion is constructable without scope self-reference', () => {
  const value = fixture();
  for (const scope of value.scopes) {
    for (const evidence of scope.evidence) {
      assert.equal(
        Object.hasOwn(evidence, 'prepared_release'),
        false,
        'scope evidence must not embed the current Git commit or source-tree identity',
      );
    }
  }
  const scopeObjectDigests = value.scopes.map(subjectOntologyObjectSha256ForTest);
  value.context.prepared_release.git_head = 'b'.repeat(40);
  value.context.prepared_release.source_tree_sha256 = H('post-commit-source-tree');
  assert.deepEqual(value.scopes.map(subjectOntologyObjectSha256ForTest), scopeObjectDigests);
  assert.equal(validatePromotion(value).publishable, true);
});

test('unsigned or unregistered promotion-authorizing reviews are rejected', () => {
  for (const { make, selectReview } of [
    { make: fixture, selectReview: (value) => value.scopes[0].review },
    { make: fixture, selectReview: (value) => value.scopes[0].lineage_assertion.review },
    { make: fixture, selectReview: (value) => value.index.coverage_universes[0].review },
    { make: crossWorkFixture, selectReview: (value) => value.scopes[1].relations[0].cross_subject_exception.review },
  ]) {
    const unsigned = make();
    delete selectReview(unsigned).signature_base64;
    assert.throws(
      () => validatePromotion(unsigned),
      /field set mismatch|signed governed review|review signature/i,
    );

    const unregistered = make();
    selectReview(unregistered).reviewer_id = 'unregistered-reviewer';
    assert.throws(
      () => validatePromotion(unregistered),
      /not registered in the pinned reviewer registry/i,
    );
  }

  const wrongRole = fixture();
  wrongRole.context.reviewer_registry.find((reviewer) => reviewer.reviewer_id === 'governed-reviewer').scopes = ['page_display'];
  assert.throws(() => validatePromotion(wrongRole), /not active and semantic_resolution-authorized/);

  const expired = fixture();
  expired.context.reviewer_registry.find((reviewer) => reviewer.reviewer_id === 'governed-reviewer').valid_until = '2026-07-22T04:59:59Z';
  assert.throws(() => validatePromotion(expired), /outside the pinned validity interval/);

  const payloadDrift = fixture();
  payloadDrift.scopes[0].concepts[0].label = 'unsigned post-review semantic drift';
  assert.throws(() => validatePromotion(payloadDrift), /payload digest differs from current subject/);
});

test('schema, index, loader, and desired manifest share one canonical ontology path contract', async () => {
  const paths = await import('../scripts/lib/subject-ontology-paths.mjs');
  const index = JSON.parse(await readFile(new URL('../data/ontologies/index.json', import.meta.url), 'utf8'));
  const schema = JSON.parse(await readFile(new URL('../data/schemas/subject-ontology-v2.schema.json', import.meta.url), 'utf8'));
  const scopePattern = schema.$defs.facet.properties.scope_files.items.pattern;
  for (const facet of index.canonical_facets) {
    const slug = facet.facet_id.slice('facet:'.length);
    assert.equal(facet.directory, `data/ontologies/${slug}`);
    for (const scopePath of facet.scope_files) {
      assert.equal(paths.assertCanonicalSubjectOntologyScopePath(scopePath, { facetSlug: slug }), scopePath);
    }
  }
  assert.equal(scopePattern, paths.SUBJECT_ONTOLOGY_SCOPE_PATH_PATTERN_SOURCE);
  assert.equal(
    paths.assertCanonicalSubjectOntologyScopePath('data/ontologies/chinese-language/example.json', {
      facetSlug: 'chinese-language',
    }),
    'data/ontologies/chinese-language/example.json',
  );
  assert.throws(() => paths.assertCanonicalSubjectOntologyScopePath('./chinese-language/example.json'));
  assert.throws(() => paths.assertCanonicalSubjectOntologyScopePath('data/ontologies/facets/chinese-language/example.json'));
});

test('promotion cannot receive in-memory objects outside the canonical release builder', () => {
  const value = fixture();
  assert.throws(
    () => validateSubjectOntologyV2PromotionForRelease({
      rootDir: root,
      index: value.index,
      scopes: value.scopes,
      context: value.context,
    }),
    /reachable only from the canonical release builder materialization/,
  );
});

test('immutable prepared ontology artifact identities reject post-materialization index or scope mutation', () => {
  const scopeMutation = fixture();
  scopeMutation.scopes[0].concepts[0].label = 'forged after materialization';
  assert.throws(
    () => validatePromotion(scopeMutation, { reseal: false }),
    /object differs from the immutable prepared Git artifact/,
  );

  const indexMutation = fixture();
  indexMutation.index.canonical_facets[0].coverage.reason_codes = ['forged'];
  assert.throws(
    () => validatePromotion(indexMutation, { reseal: false }),
    /promotion index object differs from the immutable prepared Git artifact/,
  );
});

test('adversary cannot add a same-commit online snapshot self-attestation', () => {
  const value = fixture();
  value.scopes[0].evidence[0].online_snapshot = {
    source_id: 'caller-authored', body_sha256: H('forged'), accepted: true,
  };
  assert.throws(() => validatePromotion(value), /field set mismatch.*online_snapshot/);
});

test('adversary cannot reuse an origin, publisher, or independence group as two witnesses', () => {
  for (const field of ['canonical_origin', 'canonical_publisher', 'independence_group']) {
    const value = fixture();
    const claims = value.context.page_evidence.pages[0].online_claims;
    claims[1][field] = claims[0][field];
    assert.throws(
      () => validatePromotion(value),
      new RegExp(`reuse the same ${field === 'canonical_origin' ? 'origin' : field === 'canonical_publisher' ? 'publisher' : 'independence group'}`),
    );
  }
});

test('adversary cannot omit any of the five exact version anchors', () => {
  const value = fixture();
  delete value.context.page_evidence.pages[0].online_claims[0].version_anchors.version_label;
  assert.throws(() => validatePromotion(value), /five exact version anchors differs/);
});

test('coverage universe rejects an omitted eligible subject', () => {
  const value = fixture();
  const authority = value.context.coverage_authority.facets.find((facet) => facet.facet_id === 'facet:chinese-language');
  authority.eligible_subject_ids.push('subject:classical-chinese');
  assert.throws(() => validatePromotion(value), /complete eligible subject universe differs/);
});

test('coverage universe rejects narrowed periods and caller-extended as-of dates', () => {
  const mutations = [
    (universe) => { universe.start_year = 2001; },
    (universe) => { universe.end_year = 2001; },
    (universe) => { universe.as_of_date = '2003-01-01'; universe.end_year = 2003; },
  ];
  for (const mutate of mutations) {
    const value = fixture();
    mutate(value.index.coverage_universes[0]);
    assert.throws(() => validatePromotion(value), /narrows or extends the governed catalog as-of boundary/);
  }
});

test('current universe rejects obsolete catalog editions relabeled as current', () => {
  const value = fixture();
  const current = value.index.coverage_universes.find((universe) => universe.purpose === 'current_ordinary');
  current.catalog_decisions[0] = {
    document_id: 'doc-old', disposition: 'included', reason_code: 'included_exact_scope',
  };
  current.included_scope_ids = ['scope:old', 'scope:new'];
  assert.throws(() => validatePromotion(value), /disposition is not derived from the governed catalog as-of state/);
});

test('coverage exclusion reasons must be derived from frozen catalog and provenance', () => {
  const value = fixture();
  const historical = value.index.coverage_universes.find((universe) => universe.purpose === 'historical_negative_claim');
  historical.catalog_decisions[1] = {
    document_id: 'doc-new', disposition: 'excluded', reason_code: 'different_population',
  };
  historical.included_scope_ids = ['scope:old'];
  assert.throws(() => validatePromotion(value), /disposition is not derived from the governed catalog as-of state/);
});

test('work identity, title, and validity are governed rather than scope-authored', () => {
  const attacks = [
    (scope) => { scope.work.work_id = 'work:self-authored'; },
    (scope) => { scope.work.title = '自报课程标准'; },
    (scope) => { scope.edition.valid_to_year += 1; },
  ];
  for (const attack of attacks) {
    const value = fixture();
    attack(value.scopes[1]);
    assert.throws(
      () => validatePromotion(value),
      /work identity\/title is not derived|exact edition validity differs/,
    );
  }
});

test('lineage kind and predecessor must match governed work chronology', () => {
  const wrongKind = fixture();
  wrongKind.scopes[1].lineage_assertion.kind = 'first_edition';
  assert.throws(() => validatePromotion(wrongKind), /lineage kind is not derived from the governed catalog work chronology/);

  const wrongPredecessor = fixture();
  wrongPredecessor.context.coverage_catalog.find((record) => record.document_id === 'doc-new').predecessor_document_id = 'doc-forged';
  assert.throws(() => validatePromotion(wrongPredecessor), /revision predecessor is not the distinct exact earlier edition/);
});

test('first-edition and revision assertions require dedicated exact-edition roles', () => {
  const first = fixture();
  first.scopes[0].lineage_assertion.assertion_type = 'unresolved';
  assert.throws(() => validatePromotion(first), /first-edition assertion lacks dedicated bounded content/);

  const revision = fixture();
  revision.scopes[1].lineage_assertion.evidence_roles[0].edition_id = revision.scopes[1].edition.edition_id;
  assert.throws(() => validatePromotion(revision), /lineage role edition mismatch/);

  const emptyEvidence = fixture();
  emptyEvidence.scopes[0].lineage_assertion.evidence_roles[0].evidence_ids = [];
  assert.throws(() => validatePromotion(emptyEvidence), /lacks exact-edition evidence/);

  const wrongUniverse = fixture();
  wrongUniverse.scopes[0].lineage_assertion.coverage_universe_id = 'universe:current';
  assert.throws(() => validatePromotion(wrongUniverse), /independently validated bounded universe/);
});

test('scope identity, hierarchy roots, and cycles are structural rather than self-reported', () => {
  const forgedDimension = fixture();
  forgedDimension.scopes[0].scope_dimensions.stage = '高中';
  assert.throws(() => validatePromotion(forgedDimension), /scope dimensions differ/);

  const missingRoot = fixture();
  missingRoot.scopes[0].hierarchies[0].root_concept_ids = [missingRoot.scopes[0].concepts[1].concept_id];
  assert.throws(() => validatePromotion(missingRoot), /declared roots differs/);

  const cycle = fixture();
  const goal = cycle.scopes[0].concepts[0];
  goal.parent_concept_id = goal.concept_id;
  cycle.scopes[0].hierarchies[0].root_concept_ids = [];
  assert.throws(() => validatePromotion(cycle), /lacks roots|concept cycle/);
});

test('rename cannot collapse both endpoints into one exact-edition scope', () => {
  const value = fixture();
  const relation = value.scopes[1].relations[0];
  relation.source_endpoints = structuredClone(relation.target_endpoints);
  assert.throws(() => validatePromotion(value), /distinct exact-edition scopes/);
});

test('changing rename to broaden with identical spans and a recomputed diff still fails signed semantic adjudication', () => {
  const value = fixture();
  const relation = value.scopes[1].relations[0];
  relation.relation_type = 'broaden';
  relation.adjudication.semantic_basis_code = 'broader_target_extension';
  relation.relation_diff_sha256 = computeRelationDiffSha256(relation, value.resolved);
  assert.throws(
    () => validatePromotion(value),
    /signed adjudication payload hash differs|adjudication Ed25519 signature is invalid/,
  );
});

test('relation adjudication is bound to the pinned reviewer registry', () => {
  const value = fixture();
  value.context.reviewer_registry[0].status = 'revoked';
  assert.throws(
    () => validatePromotion(value),
    /adjudicator is not active and semantic_resolution-authorized/,
  );
});

test('relation signature or diff invalidates on page bundle, online snapshot, or reviewer-policy drift', () => {
  const mutations = [
    (value) => {
      value.context.page_evidence.pages[1].bundle_sha256 = H('new-bundle');
      value.scopes[1].evidence[0].canonical_page_evidence.bundle_sha256 = H('new-bundle');
    },
    (value) => { value.context.page_evidence.pages[1].online_claims[0].capture_body_sha256 = H('new-online-capture'); },
    (value) => { value.context.page_evidence.policy_revision_sha256 = H('new-review-policy'); },
    (value) => {
      const replacement = H('new-reviewer-registry');
      value.context.source_bindings.reviewer_registry_sha256 = replacement;
      value.index.bindings.reviewer_registry.sha256 = replacement;
      value.scopes[1].relations[0].review.policy_revision_sha256 = replacement;
    },
  ];
  for (const mutate of mutations) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => validatePromotion(value),
      /signed adjudication payload hash differs|diff hash does not bind|not bound to the pinned reviewer registry/,
    );
  }
});

test('serialized caller-built promotion contexts remain forbidden outside the test-only API', () => {
  const value = fixture();
  value.context.context_kind = 'immutable_prepared_release_v1';
  assert.throws(
    () => validateSubjectOntologyFixtureForTest(value),
    /promotion context must come from the immutable release builder/,
  );
});

test('scope-plan works and internal course or section labels cannot become subject facets', async () => {
  const catalog = JSON.parse(await readFile(new URL('../data/catalog.json', import.meta.url), 'utf8'));
  const taxonomy = JSON.parse(await readFile(new URL('../data/concept-model-v2.json', import.meta.url), 'utf8'));
  const provenance = JSON.parse(await readFile(new URL('../data/document-sources.json', import.meta.url), 'utf8'));
  const frozen = buildIndependentCoverageCatalog({ catalog, taxonomy, provenance });
  const planIds = [
    'ictr-cfb2a39a2016',
    'ictr-8f02447b66ca',
    'ictr-f74769862cc6',
    'ictr-07a04c6c51fd',
  ];
  for (const documentId of planIds) {
    const record = frozen.find((candidate) => candidate.document_id === documentId);
    assert.ok(record, `${documentId} must remain enumerated in the frozen catalog universe`);
    assert.equal(record.coverage_role, 'scope_plan_evidence');
    assert.equal(record.facet_eligible, false);
    assert.equal(record.facet_id, null);
    assert.equal(record.subject_id, null);
  }
  for (const label of ['定向行走', '美工', '沟通与交往']) {
    assert.equal(taxonomy.subject_taxonomy[label].entity_kind, 'curriculum_course');
    assert.equal(taxonomy.subject_taxonomy[label].facet_eligible, false);
  }
  assert.equal(taxonomy.subject_taxonomy['学业质量'], undefined, 'section heading must not be a subject taxonomy entry');
  assert.equal(CANONICAL_FACETS.some((facet) => ['定向行走', '美工', '沟通与交往', '学业质量'].includes(facet.label)), false);
});

test('release inventory registers all v2 data as candidate_fail_closed and keeps it out of R2', async () => {
  const policy = JSON.parse(await readFile(new URL('../data/release-assets-policy.json', import.meta.url), 'utf8'));
  const expected = [
    'data/ontologies/index.json',
    'data/schemas/subject-ontology-v2.schema.json',
    'data/subject-ontology-v2-validation.json',
  ];
  for (const path of expected) {
    const entry = policy.data_inventory.files.find((item) => item.path === path);
    assert.ok(entry, `missing inventory entry ${path}`);
    assert.equal(entry.disposition, 'candidate_fail_closed');
    assert.ok(entry.consumers.includes('subject_ontology_v2_validator'));
    assert.equal(policy.r2.objects.some((object) => object.source === path), false);
  }
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(packageJson.scripts.verify, /ontology:v2:validate/);
  assert.match(packageJson.scripts['release:manifest:ontology-v2:promotion'], /subject-ontology-v2-promotion/);
});
