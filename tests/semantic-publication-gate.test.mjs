import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  applySemanticPagePublication,
  createSemanticPublicationGate,
  semanticDocumentDisposition,
  semanticPageDisposition,
  validateSemanticPublicationPolicy,
} from '../scripts/semantic-publication-gate.mjs';
import {
  acceptedConceptPages,
  createConceptPublicationGate,
} from '../scripts/concept-page-publication.mjs';
import { sha256Text } from '../scripts/page-publication-gate.mjs';

const root = new URL('../', import.meta.url);
const [catalog, queue, policy, schema] = await Promise.all([
  readFile(new URL('data/catalog.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('data/ocr-queue.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('data/semantic-publication-policy.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('data/semantic-publication-policy.schema.json', root), 'utf8').then(JSON.parse),
]);
const catalogById = new Map(catalog.documents.map((record) => [record.id, record]));
const realGate = createSemanticPublicationGate({ policy, records: catalog.documents });
const digest = (label) => sha256Text(`fixture:${label}`);

function expandedPages(controls) {
  const pages = new Set();
  for (const control of controls) {
    for (let page = control.page_start; page <= control.page_end; page += 1) {
      pages.add(`${control.document_id}:${page}`);
    }
  }
  return pages;
}

function syntheticPolicy({
  status = 'resolved_after_review',
  attestations = [
    'language_specific_ocr',
    'source_image_comparison',
    'row_alignment_verified',
    'online_same_edition_checked',
    'version_match_verified',
  ],
} = {}) {
  return {
    schema_version: 1,
    policy: 'fail_closed_semantic_publication_v1',
    reviewed_by: 'fixture-auditor',
    reviewed_at: '2026-07-16T15:39:23.463Z',
    quality_profiles: {
      'russian-glossary': {
        minimum_meaningful_characters_when_text_expected: 20,
        forbidden_unicode_scripts: ['Hiragana', 'Hangul', 'Tibetan'],
        minimum_required_script_characters: { Cyrillic: 10 },
        tabular_alignment_required: true,
        required_resolution_attestations: [
          'language_specific_ocr',
          'source_image_comparison',
          'row_alignment_verified',
          'online_same_edition_checked',
          'version_match_verified',
        ],
      },
    },
    document_aliases: [],
    page_controls: [{
      control_id: 'fixture-russian-page',
      document_id: 'russian-fixture',
      source_artifact_sha256: digest('russian-source'),
      page_count: 1,
      page_start: 1,
      page_end: 1,
      quality_profile: 'russian-glossary',
      status,
      reasons: ['glossary_row_alignment_unverified'],
      source_image_text_expected: true,
      boundary_basis: 'fixture boundary',
      resolution_requirements: [
        'language_specific_ocr',
        'source_image_comparison',
        'row_alignment_verified',
        'online_same_edition_checked',
        'version_match_verified',
      ],
      resolution_attestations: status === 'resolved_after_review' ? attestations : [],
      reviewed_by: 'fixture-auditor',
      reviewed_at: '2026-07-16T15:39:23.463Z',
      resolved_by: status === 'resolved_after_review' ? 'fixture-editor' : null,
      resolved_at: status === 'resolved_after_review' ? '2026-07-16T16:00:00Z' : null,
      note: 'fixture',
    }],
  };
}

test('real r6 policy binds exact defect pages, full glossary ranges, Japanese rows, and duplicate identity', () => {
  assert.equal(schema.properties.schema_version.const, 1);
  assert.equal(realGate.page_controls.length, 21);
  assert.equal(realGate.aliasById.size, 1);
  assert.equal(expandedPages(realGate.page_controls).size, 179);

  const missedPages = expandedPages(realGate.page_controls.filter((control) =>
    control.reasons.includes('ocr_missing_or_severely_incomplete')));
  assert.deepEqual([...missedPages].sort(), [
    'ictr-bb00e7fd186f:78',
    'ictr-d39597b0d7f5:61',
    'ictr-d39597b0d7f5:82',
    'ictr-d39597b0d7f5:83',
    'ictr-d39597b0d7f5:85',
    'ictr-ddd18cff2338:231',
    'moe-2011-02:81',
    'moe-2022-06:102',
    'moe-2022-06:106',
    'moe-2022-06:124',
    'moe-2022-06:130',
  ].sort());

  assert.deepEqual(realGate.page_controls
    .filter((control) => control.quality_profile === 'russian-glossary')
    .map((control) => [control.document_id, control.page_start, control.page_end]), [
    ['ictr-3db457c6f361', 39, 86],
    ['ictr-d39597b0d7f5', 59, 99],
    ['moe-2011-04', 37, 72],
    ['moe-2022-08', 61, 100],
  ]);
  assert.deepEqual(realGate.page_controls
    .filter((control) => control.quality_profile === 'japanese-parallel-table')
    .map((control) => [control.document_id, control.page_start]), [
    ['ictr-f985431f376f', 54],
    ['ictr-f985431f376f', 60],
    ['ictr-f985431f376f', 61],
  ]);

  const alias = catalogById.get('ictr-6c6df9d121ac');
  const canonical = catalogById.get('moe-2022-17');
  assert.equal(alias.checksum_sha256, canonical.checksum_sha256);
  assert.deepEqual(semanticDocumentDisposition(realGate, alias), {
    excluded: true,
    relation: 'exact_source_duplicate',
    canonical_document_id: 'moe-2022-17',
    source_artifact_sha256: canonical.checksum_sha256,
  });
  assert.deepEqual(semanticDocumentDisposition(realGate, canonical).alternate_document_ids, ['ictr-6c6df9d121ac']);
});

test('moe-2011-01 visual defects bind exact catalog identity and profile-specific resolution gates', () => {
  const record = catalogById.get('moe-2011-01');
  const controls = realGate.page_controls
    .filter((control) => control.document_id === record.id)
    .sort((left, right) => left.page_start - right.page_start);

  assert.deepEqual(controls.map((control) => ({
    control_id: control.control_id,
    source_artifact_sha256: control.source_artifact_sha256,
    page_count: control.page_count,
    page_start: control.page_start,
    page_end: control.page_end,
    quality_profile: control.quality_profile,
    reasons: control.reasons,
  })), [
    {
      control_id: 'r6-structured-table-moe-2011-01-p049',
      source_artifact_sha256: record.checksum_sha256,
      page_count: record.page_count,
      page_start: 49,
      page_end: 49,
      quality_profile: 'structured-table-page',
      reasons: ['table_structure_collapsed', 'row_column_alignment_lost'],
    },
    {
      control_id: 'r6-exact-character-moe-2011-01-p065',
      source_artifact_sha256: record.checksum_sha256,
      page_count: record.page_count,
      page_start: 65,
      page_end: 65,
      quality_profile: 'exact-character-page',
      reasons: ['exact_character_mismatch'],
    },
  ]);
  assert.equal(realGate.quality_profiles['structured-table-page'].tabular_alignment_required, true);
  assert.ok(realGate.quality_profiles['structured-table-page']
    .required_resolution_attestations.includes('row_alignment_verified'));
  assert.ok(realGate.quality_profiles['exact-character-page']
    .required_resolution_attestations.includes('exact_character_verified'));
  assert.equal(
    schema.$defs.qualityProfile.properties.required_resolution_attestations.items.type,
    'string',
  );
});

test('moe-2022-03 visual defects bind exact catalog identity and structure-specific resolution gates', () => {
  const record = catalogById.get('moe-2022-03');
  const controls = realGate.page_controls
    .filter((control) => control.document_id === record.id)
    .sort((left, right) => left.page_start - right.page_start);

  assert.deepEqual(controls.map((control) => ({
    control_id: control.control_id,
    source_artifact_sha256: control.source_artifact_sha256,
    page_count: control.page_count,
    page_start: control.page_start,
    page_end: control.page_end,
    quality_profile: control.quality_profile,
    reasons: control.reasons,
  })), [
    {
      control_id: 'r6-structured-table-moe-2022-03-p075',
      source_artifact_sha256: record.checksum_sha256,
      page_count: record.page_count,
      page_start: 75,
      page_end: 75,
      quality_profile: 'structured-table-page',
      reasons: ['column_order_reversed', 'row_column_alignment_lost'],
    },
    {
      control_id: 'r6-running-header-moe-2022-03-p109',
      source_artifact_sha256: record.checksum_sha256,
      page_count: record.page_count,
      page_start: 109,
      page_end: 109,
      quality_profile: 'running-header-page',
      reasons: ['running_header_promoted_to_heading'],
    },
  ]);
  assert.ok(realGate.quality_profiles['structured-table-page']
    .required_resolution_attestations.includes('row_alignment_verified'));
  assert.ok(realGate.quality_profiles['running-header-page']
    .required_resolution_attestations.includes('running_header_removed'));
});

test('all OCR queue records remain document-level citation false', () => {
  for (const queueRecord of queue.documents) {
    const catalogRecord = catalogById.get(queueRecord.id);
    assert.ok(catalogRecord, `${queueRecord.id} missing from catalog`);
    assert.equal(catalogRecord.citation_allowed, false, `${queueRecord.id} must remain non-citable`);
  }
});

test('unresolved page controls override an accepted page and remove its semantic payload', () => {
  const record = catalogById.get('ictr-f985431f376f');
  const page = applySemanticPagePublication({
    gate: realGate,
    record,
    page: {
      page_number: 61,
      review_status: 'accepted',
      display_allowed: true,
      citation_allowed: true,
      uncertainty_note: null,
    },
    rawText: 'こえ 声 ことば 言葉 こころ 心 さかな 魚 さくら 桜 しごと 仕事',
  });
  assert.equal(page.semantic_excluded, true);
  assert.equal(page.display_allowed, false);
  assert.equal(page.citation_allowed, false);
  assert.equal(page.review_status, 'unresolved_fail_closed');
  assert.match(page.uncertainty_note, /r6-japanese-row-shift-ictr-f985-p061/);
});

test('moe-2011-01 controls preemptively override future accepted pages without a received candidate', () => {
  const record = catalogById.get('moe-2011-01');
  for (const [pageNumber, controlId, qualityProfile] of [
    [49, 'r6-structured-table-moe-2011-01-p049', 'structured-table-page'],
    [65, 'r6-exact-character-moe-2011-01-p065', 'exact-character-page'],
  ]) {
    const page = applySemanticPagePublication({
      gate: realGate,
      record,
      page: {
        page_number: pageNumber,
        review_status: 'accepted',
        display_allowed: true,
        citation_allowed: true,
        uncertainty_note: null,
      },
    });
    assert.equal(page.semantic_excluded, true);
    assert.equal(page.display_allowed, false);
    assert.equal(page.citation_allowed, false);
    assert.equal(page.review_status, 'unresolved_fail_closed');
    assert.deepEqual(page.semantic_control_ids, [controlId]);
    assert.deepEqual(page.semantic_quality_profiles, [qualityProfile]);
    assert.match(page.uncertainty_note, new RegExp(controlId));
  }
});

test('moe-2022-03 controls preemptively override future accepted pages without a received candidate', () => {
  const record = catalogById.get('moe-2022-03');
  for (const [pageNumber, controlId, qualityProfile] of [
    [75, 'r6-structured-table-moe-2022-03-p075', 'structured-table-page'],
    [109, 'r6-running-header-moe-2022-03-p109', 'running-header-page'],
  ]) {
    const page = applySemanticPagePublication({
      gate: realGate,
      record,
      page: {
        page_number: pageNumber,
        review_status: 'accepted',
        display_allowed: true,
        citation_allowed: true,
        uncertainty_note: null,
      },
    });
    assert.equal(page.semantic_excluded, true);
    assert.equal(page.display_allowed, false);
    assert.equal(page.citation_allowed, false);
    assert.equal(page.review_status, 'unresolved_fail_closed');
    assert.deepEqual(page.semantic_control_ids, [controlId]);
    assert.deepEqual(page.semantic_quality_profiles, [qualityProfile]);
    assert.match(page.uncertainty_note, new RegExp(controlId));
  }
});

test('extensible hard rules reject short text and unexpected scripts even after review attestations', () => {
  const record = {
    id: 'russian-fixture',
    checksum_sha256: digest('russian-source'),
    page_count: 1,
  };
  const gate = createSemanticPublicationGate({
    policy: syntheticPolicy(),
    records: [record],
  });
  const clean = semanticPageDisposition({
    gate,
    record,
    pageNumber: 1,
    rawText: 'абитуриент поступать университет 学生 报考 大学 课程 学习 评价',
  });
  assert.equal(clean.blocked, false);

  const short = semanticPageDisposition({
    gate,
    record,
    pageNumber: 1,
    rawText: 'слово 词',
  });
  assert.equal(short.blocked, true);
  assert.ok(short.block_reasons.some((reason) => reason.includes('meaningful_characters_below_20')));

  const anomalous = semanticPageDisposition({
    gate,
    record,
    pageNumber: 1,
    rawText: 'абитуриент поступать университет 学生 报考 大学 དང 课程 学习 评价',
  });
  assert.equal(anomalous.blocked, true);
  assert.ok(anomalous.block_reasons.some((reason) => reason.endsWith('forbidden_script:Tibetan')));
});

test('tabular controls cannot be marked resolved without row and version attestations', () => {
  const missingRowReview = syntheticPolicy({
    attestations: [
      'language_specific_ocr',
      'source_image_comparison',
      'online_same_edition_checked',
      'version_match_verified',
    ],
  });
  assert.throws(
    () => validateSemanticPublicationPolicy(missingRowReview),
    /missing attestation row_alignment_verified/,
  );
});

test('exact-character controls cannot be resolved without exact character verification', () => {
  const missingExactCharacter = structuredClone(policy);
  const control = missingExactCharacter.page_controls.find(
    (candidate) => candidate.control_id === 'r6-exact-character-moe-2011-01-p065',
  );
  control.status = 'resolved_after_review';
  control.resolution_attestations = control.resolution_requirements
    .filter((attestation) => attestation !== 'exact_character_verified');
  control.resolved_by = 'fixture-editor';
  control.resolved_at = '2026-07-16T16:30:00Z';
  assert.throws(
    () => validateSemanticPublicationPolicy(missingExactCharacter),
    /missing attestation exact_character_verified/,
  );

  control.resolution_attestations.push('exact_character_verified');
  assert.doesNotThrow(() => validateSemanticPublicationPolicy(missingExactCharacter));
});

test('moe-2022-03 controls cannot resolve without row alignment or running-header removal', () => {
  for (const [controlId, missingAttestation] of [
    ['r6-structured-table-moe-2022-03-p075', 'row_alignment_verified'],
    ['r6-running-header-moe-2022-03-p109', 'running_header_removed'],
  ]) {
    const incompleteReview = structuredClone(policy);
    const control = incompleteReview.page_controls.find(
      (candidate) => candidate.control_id === controlId,
    );
    control.status = 'resolved_after_review';
    control.resolution_attestations = control.resolution_requirements
      .filter((attestation) => attestation !== missingAttestation);
    control.resolved_by = 'fixture-editor';
    control.resolved_at = '2026-07-16T16:35:00Z';
    assert.throws(
      () => validateSemanticPublicationPolicy(incompleteReview),
      new RegExp(`missing attestation ${missingAttestation}`),
    );
  }
});

test('catalog hash or page-count drift invalidates the semantic policy', () => {
  const record = {
    id: 'russian-fixture',
    checksum_sha256: digest('wrong-source'),
    page_count: 1,
  };
  assert.throws(
    () => createSemanticPublicationGate({ policy: syntheticPolicy(), records: [record] }),
    /source artifact hash drift/,
  );
});

test('concept projection rejects alias manifests and removes unresolved controlled pages from its revision', () => {
  const alias = catalogById.get('ictr-6c6df9d121ac');
  const canonical = catalogById.get('moe-2022-08');
  const aliasManifest = {
    schema_version: 1,
    policy: 'fail_closed_page_publication_v1',
    documents: [{
      document_id: alias.id,
      source_artifact_sha256: alias.checksum_sha256,
      acceptance_status: 'accepted_page_manifest',
      reviewed_by: 'fixture',
      reviewed_at: '2026-07-16T16:00:00Z',
      pages: Array.from({ length: alias.page_count }, (_, index) => ({
        page_number: index + 1,
        source_page_sha256: digest(`alias-source-page-${index + 1}`),
        final_text_sha256: digest(`alias-final-page-${index + 1}`),
        evidence_bundle_sha256: digest(`alias-evidence-${index + 1}`),
        stable_locator: `${alias.id}:page:${index + 1}`,
        review_status: 'accepted',
        display_allowed: index === 0,
        citation_allowed: false,
      })),
    }],
  };
  assert.throws(() => createConceptPublicationGate({
    manifest: aliasManifest,
    semanticPolicy: policy,
    records: catalog.documents,
  }), /exact duplicate alias cannot have an accepted OCR page manifest/);

  const rawPages = Array.from({ length: canonical.page_count }, (_, index) => `第${index + 1}页`);
  const controlledManifest = {
    schema_version: 1,
    policy: 'fail_closed_page_publication_v1',
    documents: [{
      document_id: canonical.id,
      source_artifact_sha256: canonical.checksum_sha256,
      acceptance_status: 'accepted_page_manifest',
      reviewed_by: 'fixture',
      reviewed_at: '2026-07-16T16:00:00Z',
      pages: rawPages.map((text, index) => ({
        page_number: index + 1,
        source_page_sha256: digest(`canonical-source-page-${index + 1}`),
        final_text_sha256: sha256Text(text),
        evidence_bundle_sha256: digest(`canonical-evidence-${index + 1}`),
        stable_locator: `${canonical.id}:page:${index + 1}`,
        review_status: 'accepted',
        display_allowed: index + 1 === 61,
        citation_allowed: false,
      })),
    }],
  };
  const conceptGate = createConceptPublicationGate({
    manifest: controlledManifest,
    semanticPolicy: policy,
    records: catalog.documents,
  });
  assert.deepEqual(conceptGate.revision_projection, []);
  assert.deepEqual(acceptedConceptPages({
    gate: conceptGate,
    record: canonical,
    sourceArtifactSha256: canonical.checksum_sha256,
    documentCitationAllowed: false,
  }), []);
});

test('both builders consume the same semantic policy before paragraph or concept derivation', async () => {
  const [corpusBuilder, conceptBuilder] = await Promise.all([
    readFile(new URL('scripts/build-corpus.mjs', root), 'utf8'),
    readFile(new URL('scripts/build-concept-evolution.mjs', root), 'utf8'),
  ]);
  assert.match(corpusBuilder, /createSemanticPublicationGate/);
  assert.match(corpusBuilder, /if \(pageGate\.semantic_excluded\)[\s\S]*?continue;/);
  assert.match(corpusBuilder, /semanticDocumentDisposition\(semanticPublicationGate, record\)\.excluded/);
  assert.match(conceptBuilder, /semanticPolicy: semanticPublicationPolicy/);
  assert.match(conceptBuilder, /canonicalCatalogDocuments/);
  assert.match(conceptBuilder, /semanticPublicationGate/);
  assert.match(conceptBuilder, /exact_source_deduplicated_canonical/);
});
