import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_FACETS,
  buildIndependentCoverageCatalog,
  computeRelationDiffSha256,
  resolveSubjectOntologyEvidenceForTest,
  validateSubjectOntologyState,
  validateSubjectOntologyV2,
} from '../scripts/validate-subject-ontology-v2.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const H = (value) => createHash('sha256').update(value).digest('hex');
const POLICY_SHA = H('ontology-review-policy-v2');
const CORPUS_MANIFEST_SHA = H('corpus-manifest');
const CORPUS_FINGERPRINT = H('corpus-fingerprint');
const PAGE_MANIFEST_SHA = H('page-manifest');

function review(reviewer = 'reviewer-a') {
  return {
    reviewer_id: reviewer,
    reviewed_at: '2026-07-22T05:00:00Z',
    policy_revision_sha256: POLICY_SHA,
    decision: 'accepted',
  };
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
      prepared_release: {
        git_head: 'a'.repeat(40),
        source_tree_sha256: H('source-tree'),
        corpus_release_id: 'corpus-aaaaaaaaaaaaaaaaaaaaaaaa',
        corpus_manifest_sha256: CORPUS_MANIFEST_SHA,
        corpus_release_fingerprint_sha256: CORPUS_FINGERPRINT,
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

function scope({ id, documentId, editionId, version, year, endYear, evidence, predecessor = null }) {
  const hierarchy = hierarchyAndConcepts(documentId, evidence.evidence_id);
  const value = {
    schema_version: 2,
    artifact_kind: 'subject_ontology_scope',
    contract_id: 'subject-ontology-v2',
    scope_id: id,
    facet_id: 'facet:chinese-language',
    subject: { source_label: '语文', canonical_label: '语文', subject_id: 'subject:chinese' },
    work: { work_id: 'work:chinese-standard', title: '语文课程标准' },
    edition: {
      edition_id: editionId,
      document_id: documentId,
      version_label: version,
      issued_date: `${year}-01-01`,
      source_artifact_sha256: H(`pdf:${documentId}`),
      valid_from_year: Number(year),
      valid_to_year: endYear,
    },
    scope_dimensions: {
      population: 'ordinary_general_education',
      document_function: 'curriculum_standard',
      stage: '义务教育',
    },
    status: 'reviewed_release',
    lineage_assertion: predecessor ? {
      kind: 'revision',
      assertion_type: 'exact_edition_revision',
      assertion_text: `${editionId} revises ${predecessor.editionId}`,
      assertion_sha256: H(`${editionId} revises ${predecessor.editionId}`),
      predecessor_scope_id: predecessor.scopeId,
      predecessor_edition_id: predecessor.editionId,
      coverage_universe_id: null,
      evidence_roles: [
        { role: 'predecessor_version', scope_id: predecessor.scopeId, edition_id: predecessor.editionId, evidence_ids: [predecessor.evidenceId] },
        { role: 'current_version', scope_id: id, edition_id: editionId, evidence_ids: [evidence.evidence_id] },
      ],
      review: review(),
    } : {
      kind: 'first_edition',
      assertion_type: 'first_edition_in_bounded_catalog_universe',
      assertion_text: `${editionId} is first only inside universe:historical`,
      assertion_sha256: H(`${editionId} is first only inside universe:historical`),
      predecessor_scope_id: null,
      predecessor_edition_id: null,
      coverage_universe_id: 'universe:historical',
      evidence_roles: [
        { role: 'first_edition_identity', scope_id: id, edition_id: editionId, evidence_ids: [evidence.evidence_id] },
      ],
      review: review(),
    },
    ...hierarchy,
    evidence: [evidence],
    relations: [],
    coverage: {
      current_ordinary_status: 'human_reviewed_complete',
      current_ordinary_universe_id: 'universe:current',
      historical_status: 'human_reviewed_complete',
      historical_universe_id: 'universe:historical',
      negative_claim_eligible: true,
    },
    unresolved_items: [],
    release_gate: gate(true),
    review: review(),
  };
  Object.defineProperty(value, '__registry_path', { value: `./chinese-language/${documentId}.json`, enumerable: false });
  return value;
}

function fixture() {
  const oldEdition = {
    title: '语文课程标准（2000年版）',
    edition_id: 'edition:old', document_id: 'doc-old', version_label: '2000年版', issued_date: '2000-01-01',
  };
  const newEdition = {
    title: '语文课程标准（2001年版）',
    edition_id: 'edition:new', document_id: 'doc-new', version_label: '2001年版', issued_date: '2001-01-01',
  };
  const oldExact = exactEvidence('scope:old', oldEdition, '课程目标：语言文字运用。', 1, 10);
  const newExact = exactEvidence('scope:new', newEdition, '课程目标：语言文字运用能力。', 1, 11);
  const oldScope = scope({ id: 'scope:old', documentId: 'doc-old', editionId: oldEdition.edition_id, version: oldEdition.version_label, year: '2000', endYear: 2000, evidence: oldExact.evidence });
  const newScope = scope({
    id: 'scope:new', documentId: 'doc-new', editionId: newEdition.edition_id, version: newEdition.version_label,
    year: '2001', endYear: 2002, evidence: newExact.evidence,
    predecessor: { scopeId: oldScope.scope_id, editionId: oldScope.edition.edition_id, evidenceId: oldExact.evidence.evidence_id },
  });
  const context = {
    context_kind: 'test_fixture_v1',
    prepared_release: oldExact.evidence.prepared_release,
    source_bindings: {
      taxonomy_sha256: H('taxonomy'),
      catalog_sha256: H('catalog'),
      provenance_sha256: H('provenance'),
      corpus_manifest_file_sha256: H('corpus-file'),
      reviewer_registry_sha256: H('reviewers'),
      online_source_registry_sha256: H('sources'),
      online_verification_standard_sha256: H('online-standard'),
    },
    page_evidence: {
      manifest_sha256: PAGE_MANIFEST_SHA,
      policy_revision_sha256: POLICY_SHA,
      pages: [oldExact.page, newExact.page],
    },
    paragraphs: [oldExact.paragraph, newExact.paragraph],
    coverage_catalog: [
      {
        document_id: 'doc-old', edition_id: 'edition:old', version_label: '2000年版',
        issued_date: '2000-01-01',
        source_artifact_sha256: H('pdf:doc-old'), facet_id: 'facet:chinese-language',
        coverage_role: 'subject_edition_candidate', entity_kind: 'subject', classification: 'ordinary_subject', facet_eligible: true,
        source_label: '语文', subject_id: 'subject:chinese', subject_label: '语文', stage: '义务教育', year: 2000,
        population: 'ordinary_general_education', document_function: 'curriculum_standard',
        provenance_count: 2, provenance_sha256: H('old-provenance'), exact_duplicate_alias: false,
      },
      {
        document_id: 'doc-new', edition_id: 'edition:new', version_label: '2001年版',
        issued_date: '2001-01-01',
        source_artifact_sha256: H('pdf:doc-new'), facet_id: 'facet:chinese-language',
        coverage_role: 'subject_edition_candidate', entity_kind: 'subject', classification: 'ordinary_subject', facet_eligible: true,
        source_label: '语文', subject_id: 'subject:chinese', subject_label: '语文', stage: '义务教育', year: 2001,
        population: 'ordinary_general_education', document_function: 'curriculum_standard',
        provenance_count: 2, provenance_sha256: H('new-provenance'), exact_duplicate_alias: false,
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
      scope_id: oldScope.scope_id, edition_id: oldScope.edition.edition_id,
      sense_id: oldScope.concepts[0].sense_id, evidence_ids: [oldExact.evidence.evidence_id],
    }],
    target_endpoints: [{
      scope_id: newScope.scope_id, edition_id: newScope.edition.edition_id,
      sense_id: newScope.concepts[0].sense_id, evidence_ids: [newExact.evidence.evidence_id],
    }],
    relation_diff_sha256: '',
    review: review('relation-reviewer'),
  };
  relation.relation_diff_sha256 = computeRelationDiffSha256(relation, resolved);
  newScope.relations.push(relation);
  const decisions = [
    { document_id: 'doc-old', disposition: 'included', reason_code: 'included_exact_scope' },
    { document_id: 'doc-new', disposition: 'included', reason_code: 'included_exact_scope' },
  ];
  const universe = (id, purpose) => ({
    universe_id: id,
    facet_id: 'facet:chinese-language',
    purpose,
    subject_ids: ['subject:chinese'],
    start_year: 2000,
    end_year: 2002,
    population: 'ordinary_general_education',
    document_functions: ['curriculum_standard'],
    included_scope_ids: [oldScope.scope_id, newScope.scope_id],
    catalog_decisions: structuredClone(decisions),
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
      reason_codes: ['independently_reviewed'],
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
        path: 'data/corpus-chunks/manifest.json', sha256: H('corpus-file'),
        release_id: context.prepared_release.corpus_release_id,
        release_fingerprint_sha256: context.prepared_release.corpus_release_fingerprint_sha256,
        manifest_sha256: context.prepared_release.corpus_manifest_sha256,
      },
      page_evidence_manifest: { path: 'scripts/page-evidence/fail-closed-manifest.json', sha256: PAGE_MANIFEST_SHA },
      reviewer_registry: { path: 'scripts/page-evidence/reviewer-authorities.json', sha256: H('reviewers') },
      online_source_registry: { path: 'scripts/page-evidence/online-source-identities.json', sha256: H('sources') },
      online_verification_standard: { path: 'data/online-verification-standard.json', sha256: H('online-standard') },
      validation_report_path: 'data/subject-ontology-v2-validation.json',
    },
    canonical_facets: facets,
    coverage_universes: [universe('universe:current', 'current_ordinary'), universe('universe:historical', 'historical_negative_claim')],
    release_gate: gate(true),
  };
  const artifacts = {
    taxonomy: { json: {
      subject_taxonomy: { 语文: { canonical: '语文', stable_subject_id: 'subject:chinese', entity_kind: 'subject', facet_eligible: true } },
      subject_facet_groups: { 语文: ['语文'] },
      document_entity_overrides: {},
    } },
    catalog: { json: { documents: [
      { id: 'doc-old', subject: '语文', title: oldEdition.title, document_type: '课程标准', stage: '义务教育', version_label: '2000年版', issued_date: '2000-01-01', checksum_sha256: H('pdf:doc-old') },
      { id: 'doc-new', subject: '语文', title: newEdition.title, document_type: '课程标准', stage: '义务教育', version_label: '2001年版', issued_date: '2001-01-01', checksum_sha256: H('pdf:doc-new') },
    ] } },
  };
  return { index, scopes: [oldScope, newScope], context, artifacts };
}

function validatePromotion(value) {
  return validateSubjectOntologyState({ ...value, mode: 'promotion', allowTestFixture: true });
}

test('checked-in v2 index is exact, zero-data, and ordinary fail-closed', () => {
  const result = validateSubjectOntologyV2({ rootDir: root });
  assert.equal(result.valid, true);
  assert.equal(result.publishable, false);
  assert.equal(result.counts.facets, 12);
  assert.equal(result.counts.scopes, 0);
  assert.equal(result.release_boundary.frontend_consumer_allowed, false);
  assert.equal(result.release_boundary.r2_consumer_allowed, false);
});

test('reviewed two-edition promotion fixture passes all independent evidence gates', () => {
  const result = validatePromotion(fixture());
  assert.deepEqual(result, {
    valid: true, publishable: true, facets: 12, scopes: 2,
    coverage_universes: 2, concepts: 10, relations: 1,
  });
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
    assert.throws(() => validatePromotion(value), new RegExp(`reuse the same ${field === 'canonical_origin' ? 'origin' : field === 'canonical_publisher' ? 'publisher' : 'independence group'}`));
  }
});

test('adversary cannot omit any of the five exact version anchors', () => {
  const value = fixture();
  delete value.context.page_evidence.pages[0].online_claims[0].version_anchors.version_label;
  assert.throws(() => validatePromotion(value), /five exact version anchors differs/);
});

test('coverage cannot use another subject to fill a per-subject historical gap', () => {
  const value = fixture();
  for (const universe of value.index.coverage_universes) universe.subject_ids.push('subject:other');
  value.context.coverage_catalog[1].subject_id = 'subject:other';
  value.context.coverage_catalog[1].source_label = '其他语文';
  value.context.coverage_catalog[1].subject_label = '其他语文';
  value.scopes[1].subject = { source_label: '其他语文', canonical_label: '其他语文', subject_id: 'subject:other' };
  value.artifacts.catalog.json.documents[1].subject = '其他语文';
  value.artifacts.taxonomy.json.subject_taxonomy['其他语文'] = {
    canonical: '其他语文', stable_subject_id: 'subject:other', entity_kind: 'subject', facet_eligible: true,
  };
  value.artifacts.taxonomy.json.subject_facet_groups['语文'].push('其他语文');
  assert.throws(() => validatePromotion(value), /per-subject gap|no start coverage|no end coverage/);
});

test('scope-plan works and their internal course or section labels cannot become subject facets', async () => {
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

test('coverage exclusion reasons must be derived from frozen catalog and provenance', () => {
  const value = fixture();
  for (const universe of value.index.coverage_universes) {
    universe.catalog_decisions[1] = { document_id: 'doc-new', disposition: 'excluded', reason_code: 'different_population' };
    universe.included_scope_ids = ['scope:old'];
  }
  assert.throws(() => validatePromotion(value), /exclusion reason is not derived/);
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

test('scope identity, hierarchy roots, and cycles are derived and structural rather than self-reported', () => {
  const forgedYear = fixture();
  forgedYear.scopes[0].edition.valid_from_year = 1999;
  assert.throws(() => validatePromotion(forgedYear), /exact edition differs from frozen catalog identity/);

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

test('relation diff hash invalidates on page bundle, online snapshot, or reviewer-policy drift', () => {
  const mutations = [
    (value) => {
      value.context.page_evidence.pages[1].bundle_sha256 = H('new-bundle');
      value.scopes[1].evidence[0].canonical_page_evidence.bundle_sha256 = H('new-bundle');
    },
    (value) => { value.context.page_evidence.pages[1].online_claims[0].capture_body_sha256 = H('new-online-capture'); },
    (value) => { value.context.page_evidence.policy_revision_sha256 = H('new-review-policy'); },
  ];
  for (const mutate of mutations) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validatePromotion(value), /diff hash does not bind/);
  }
});

test('serialized caller-built immutable contexts are rejected even when fields look complete', () => {
  const value = fixture();
  value.context.context_kind = 'immutable_prepared_release_v1';
  assert.throws(() => validateSubjectOntologyState({ ...value, mode: 'promotion' }), /caller-constructed immutable promotion contexts are forbidden/);
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
});
