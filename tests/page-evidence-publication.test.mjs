import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';

import {
  IMAGE_ONLINE_ADJUDICATION_BASIS,
  preparePageReviewSigningPayload,
  recomputeAuditPage,
  renderPdfPage,
  sha256Buffer,
  stableJson,
  validatePageEvidenceRelease,
} from '../scripts/page-evidence-publication.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'page-evidence-tests-'));
const baseFixture = path.join(temporaryRoot, 'base');
const adjudicatedFixture = path.join(temporaryRoot, 'adjudicated-base');
const reviewerId = 'fixture-reviewer';
const decidedAt = '2026-07-18T12:00:00.000Z';
const documentId = 'fixture-document';

function writeJson(root, locator, value) {
  const target = path.join(root, locator);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(root, locator) {
  return JSON.parse(readFileSync(path.join(root, locator), 'utf8'));
}

function writeText(root, locator, text) {
  const target = path.join(root, locator);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
}

function artifactRef(root, locator) {
  const buffer = readFileSync(path.join(root, locator));
  return { locator, sha256: sha256Buffer(buffer), bytes: buffer.length };
}

function minimalPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length 43 >>\nstream\nBT /F1 14 Tf 20 100 Td (Evidence Page) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n%fixture\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body, 'binary'));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'binary');
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (let index = 1; index <= objects.length; index += 1) {
    body += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'binary');
}

function auditReport(primaryText, vision) {
  const recomputed = recomputeAuditPage({ primaryText, visionSidecar: vision });
  const { witness_text: ignoredWitness, critical_fields: ignoredFields, ...pageFields } = recomputed;
  return {
    schema_version: 1,
    primary_engine: 'fixture primary OCR',
    independent_witness: 'Apple Vision VNRecognizeTextRequest accurate zh-Hans',
    policy: {},
    page_range: [1, 1],
    summary: {
      pages: 1,
      automatic_witness_pass: recomputed.gate === 'automatic_witness_pass' ? 1 : 0,
      manual_image_review_required: recomputed.gate === 'manual_image_review_required' ? 1 : 0,
      blank_page_visual_confirmation_required: recomputed.gate === 'blank_page_visual_confirmation_required' ? 1 : 0,
      unresolved_fail_closed: recomputed.gate === 'unresolved_fail_closed' ? 1 : 0,
    },
    pages: [{ page: 1, ...pageFields }],
  };
}

function versionIdentity() {
  return {
    title: 'Fixture curriculum standard',
    issuing_body_or_author: 'Fixture Ministry',
    year_or_publication_context: '2022-04-21',
    version_label: '2022 edition',
    section_or_item_locator: `${documentId}:page:1`,
  };
}

function makeCatalog(sourceRef, { pageCount = 1, citationAllowed = true } = {}) {
  return {
    schema_version: 1,
    generated_at: decidedAt,
    source_policy: 'fixture',
    counts: { documents: 1 },
    documents: [{
      id: documentId,
      title: 'Fixture curriculum standard',
      issued_by: 'Fixture Ministry',
      published_date: '2022-04-21',
      version_label: '2022 edition',
      local_cache_path: sourceRef.locator,
      page_count: pageCount,
      checksum_sha256: sourceRef.sha256,
      citation_allowed: citationAllowed,
      text_quality_status: 'ocr_required',
    }],
  };
}

function makeSemanticPolicy(sourceRef, { pageCount = 1 } = {}) {
  return {
    schema_version: 1,
    policy: 'fail_closed_semantic_publication_v1',
    reviewed_by: reviewerId,
    reviewed_at: decidedAt,
    quality_profiles: {
      'fixture-page': {
        minimum_meaningful_characters_when_text_expected: 1,
        forbidden_unicode_scripts: [],
        minimum_required_script_characters: {},
        tabular_alignment_required: false,
        required_resolution_attestations: ['image_verified'],
      },
    },
    document_aliases: [],
    page_controls: [{
      control_id: 'fixture-control',
      document_id: documentId,
      source_artifact_sha256: sourceRef.sha256,
      page_count: pageCount,
      page_start: 1,
      page_end: 1,
      quality_profile: 'fixture-page',
      status: 'resolved_after_review',
      reasons: ['fixture_quality_gate'],
      source_image_text_expected: true,
      boundary_basis: 'Fixture page requires exact image/OCR/online review.',
      resolution_requirements: ['image_verified'],
      resolution_attestations: ['image_verified'],
      reviewed_by: reviewerId,
      reviewed_at: decidedAt,
      resolved_by: reviewerId,
      resolved_at: decidedAt,
      note: 'Fixture control resolved by the signed page decision.',
    }],
  };
}

function placeholderDecision({ adjudicated = false, semanticControlSha256 } = {}) {
  return {
    schema_version: 1,
    policy: 'signed_page_review_decision_v1',
    reviewer_id: reviewerId,
    decided_at: decidedAt,
    disposition: 'accepted_citation',
    display_allowed: true,
    citation_allowed: true,
    online_same_version_status: 'verified_independent',
    critical_fields_complete: true,
    critical_field_decisions: [{
      field_id: 'year',
      status: adjudicated ? 'image_online_adjudicated' : 'verified_exact',
      accepted_text: '2022',
      basis: adjudicated
        ? IMAGE_ONLINE_ADJUDICATION_BASIS
        : 'source image, primary OCR, Apple Vision, and two exact-edition online page witnesses',
      deviating_engines: adjudicated ? ['primary_ocr'] : [],
      note: adjudicated ? 'Primary OCR read the final character as Z; scan and exact-edition witnesses show 2.' : null,
    }],
    semantic_control_ids: ['fixture-control'],
    semantic_control_bindings: [{
      control_id: 'fixture-control',
      control_sha256: semanticControlSha256,
    }],
    uncertainty_note: null,
    signature_algorithm: 'Ed25519',
    signed_payload_sha256: '0'.repeat(64),
    signature_base64: Buffer.alloc(64).toString('base64'),
  };
}

function refreshChain(root) {
  const bundle = readJson(root, 'evidence/bundle.json');
  for (const [key, ref] of Object.entries(bundle.artifacts)) {
    const target = path.join(root, ref.locator);
    try {
      bundle.artifacts[key] = artifactRef(root, ref.locator);
    } catch {
      // Missing-file attacks intentionally keep the prior immutable reference.
    }
  }
  writeJson(root, 'evidence/bundle.json', bundle);
  const decision = readJson(root, 'evidence/decision.json');
  const pageManifest = readJson(root, 'data/page-publication-manifest.json');
  const document = pageManifest.documents[0];
  const page = document.pages[0];
  document.source_artifact_sha256 = bundle.artifacts.source_pdf.sha256;
  document.reviewed_by = decision.reviewer_id;
  document.reviewed_at = decision.decided_at;
  page.source_page_sha256 = bundle.rendered_page.sha256;
  page.final_text_sha256 = bundle.artifacts.final_text.sha256;
  page.evidence_bundle_sha256 = artifactRef(root, 'evidence/bundle.json').sha256;
  page.review_status = decision.disposition === 'unresolved_fail_closed' ? 'unresolved_fail_closed' : 'accepted';
  page.display_allowed = decision.display_allowed;
  page.citation_allowed = decision.citation_allowed;
  page.uncertainty_note = decision.uncertainty_note;
  writeJson(root, 'data/page-publication-manifest.json', pageManifest);
  const release = readJson(root, 'release.json');
  release.authority_registry = artifactRef(root, 'evidence/reviewer-authorities.json');
  release.bindings.catalog = artifactRef(root, 'data/catalog.json');
  release.bindings.page_publication_manifest = artifactRef(root, 'data/page-publication-manifest.json');
  release.bindings.semantic_publication_policy = artifactRef(root, 'data/semantic-publication-policy.json');
  release.bindings.online_verification_standard = artifactRef(root, 'data/online-verification-standard.json');
  release.bundles[0].bundle = artifactRef(root, 'evidence/bundle.json');
  writeJson(root, 'release.json', release);
}

async function createBaseFixture(root, { adjudicated = false } = {}) {
  mkdirSync(path.join(root, 'evidence'), { recursive: true });
  mkdirSync(path.join(root, 'data'), { recursive: true });
  writeFileSync(path.join(root, 'evidence/source.pdf'), minimalPdf());
  const sourceRef = artifactRef(root, 'evidence/source.pdf');
  const rendered = renderPdfPage({ sourcePath: path.join(root, 'evidence/source.pdf'), pageNumber: 1, dpi: 144 });
  const primaryText = adjudicated ? '课程目标 202Z\n语言文字运用' : '课程目标 2022\n语言文字运用';
  const finalText = '课程目标 2022\n语言文字运用';
  writeText(root, 'evidence/primary-content.md', primaryText);
  const primaryResult = {
    input_path: '/temporary/page-0001.png',
    width: rendered.width,
    height: rendered.height,
    model_settings: { fixture: true },
    parsing_res_list: [],
  };
  writeJson(root, 'evidence/primary-result.json', primaryResult);
  const primaryResultRef = artifactRef(root, 'evidence/primary-result.json');
  const primaryContentRef = artifactRef(root, 'evidence/primary-content.md');
  const primaryState = {
    schema_version: 1,
    document_id: documentId,
    source_path: path.join(root, 'evidence/source.pdf'),
    source_sha256: sourceRef.sha256,
    page_count: 1,
    configuration: { dpi: 144 },
    completed_pages: [1],
    failed_pages: {},
    pages: {
      1: {
        status: 'ocr_complete_pending_audit',
        physical_pdf_page: 1,
        rendered_image_sha256: rendered.sha256,
        result_json_sha256: primaryResultRef.sha256,
        content_markdown_sha256: primaryContentRef.sha256,
        citation_eligible: false,
      },
    },
  };
  writeJson(root, 'evidence/primary-state.json', primaryState);
  const vision = {
    schema_version: 2,
    document_id: documentId,
    physical_pdf_page: 1,
    source_pdf_sha256: sourceRef.sha256,
    rendered_image_sha256: rendered.sha256,
    rendered_image_bytes: rendered.bytes,
    engine: 'Apple Vision VNRecognizeTextRequest accurate zh-Hans',
    engine_configuration: { render_dpi: 144 },
    lines: [
      { confidence: 0.99, text: '课程目标 2022' },
      { confidence: 0.99, text: '语言文字运用' },
    ],
    critical_fields: [{
      field_id: 'year',
      kind: 'date_or_version',
      primary: adjudicated ? '202Z' : '2022',
      witness: '2022',
    }],
    citation_allowed: false,
  };
  writeJson(root, 'evidence/vision.json', vision);
  writeJson(root, 'evidence/audit.json', auditReport(primaryText, vision));
  writeText(root, 'evidence/final-text.md', finalText);
  writeText(root, 'evidence/online-official.txt', `${finalText}\n官方同版页面记录。`);
  writeText(root, 'evidence/online-academic.txt', `学术档案独立核查。\n${finalText}\n版本页定位完成。`);
  const version = versionIdentity();
  const supportingText = finalText;
  const onlineClaims = {
    schema_version: 1,
    policy: 'version_aware_online_page_claims_v1',
    document_id: documentId,
    physical_pdf_page: 1,
    stable_locator: `${documentId}:page:1`,
    target_version: version,
    same_version_status: 'verified_independent',
    claims: [
      {
        claim_id: 'official-page',
        document_id: documentId,
        physical_pdf_page: 1,
        stable_locator: `${documentId}:page:1`,
        url: 'https://official.example.edu/standard/page-1',
        publisher: 'Fixture Ministry',
        source_type: 'official',
        retrieved_at: decidedAt,
        version_match: 'exact_document_exact_edition',
        observed_version: version,
        snapshot: artifactRef(root, 'evidence/online-official.txt'),
        supporting_text: supportingText,
        supporting_text_sha256: sha256Buffer(Buffer.from(supportingText, 'utf8')),
      },
      {
        claim_id: 'academic-page',
        document_id: documentId,
        physical_pdf_page: 1,
        stable_locator: `${documentId}:page:1`,
        url: 'https://journal.example.org/archive/page-1',
        publisher: 'Fixture Academic Archive',
        source_type: 'academic',
        retrieved_at: decidedAt,
        version_match: 'exact_document_exact_edition',
        observed_version: version,
        snapshot: artifactRef(root, 'evidence/online-academic.txt'),
        supporting_text: supportingText,
        supporting_text_sha256: sha256Buffer(Buffer.from(supportingText, 'utf8')),
      },
    ],
  };
  writeJson(root, 'evidence/online-claims.json', onlineClaims);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const authorities = {
    schema_version: 1,
    policy: 'pinned_ed25519_page_reviewers_v1',
    reviewers: [{
      reviewer_id: reviewerId,
      display_name: 'Fixture Reviewer',
      status: 'active',
      valid_from: '2026-01-01T00:00:00.000Z',
      valid_until: null,
      scopes: ['page_display', 'page_citation', 'semantic_resolution'],
      public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }),
    }],
  };
  writeJson(root, 'evidence/reviewer-authorities.json', authorities);
  const catalog = makeCatalog(sourceRef);
  writeJson(root, 'data/catalog.json', catalog);
  const semanticPolicy = makeSemanticPolicy(sourceRef);
  writeJson(root, 'data/semantic-publication-policy.json', semanticPolicy);
  writeFileSync(
    path.join(root, 'data/online-verification-standard.json'),
    readFileSync(path.join(repositoryRoot, 'data/online-verification-standard.json')),
  );
  const semanticControlSha256 = sha256Buffer(
    Buffer.from(stableJson(semanticPolicy.page_controls[0]), 'utf8'),
  );
  const decision = placeholderDecision({ adjudicated, semanticControlSha256 });
  const bundle = {
    schema_version: 1,
    policy: 'immutable_page_evidence_bundle_v1',
    document_id: documentId,
    physical_pdf_page: 1,
    page_count: 1,
    stable_locator: `${documentId}:page:1`,
    version_identity: version,
    rendered_page: {
      mode: 'reproducible_render_v1',
      command_contract: 'mutool_draw_png_page_v1',
      renderer_sha256: rendered.renderer.sha256,
      renderer_version: rendered.renderer.version,
      dpi: 144,
      format: 'png',
      sha256: rendered.sha256,
      bytes: rendered.bytes,
      width: rendered.width,
      height: rendered.height,
    },
    artifacts: {
      source_pdf: sourceRef,
      primary_result: primaryResultRef,
      primary_content: primaryContentRef,
      primary_state: artifactRef(root, 'evidence/primary-state.json'),
      vision_sidecar: artifactRef(root, 'evidence/vision.json'),
      audit: artifactRef(root, 'evidence/audit.json'),
      final_text: artifactRef(root, 'evidence/final-text.md'),
      online_claims: artifactRef(root, 'evidence/online-claims.json'),
      reviewer_decision: { locator: 'evidence/decision.json', sha256: '0'.repeat(64), bytes: 1 },
    },
  };
  const prepared = preparePageReviewSigningPayload({ root, bundle, record: catalog.documents[0], decision });
  decision.signed_payload_sha256 = prepared.payload_sha256;
  decision.signature_base64 = sign(null, Buffer.from(prepared.payload_text, 'utf8'), privateKey).toString('base64');
  writeJson(root, 'evidence/decision.json', decision);
  bundle.artifacts.reviewer_decision = artifactRef(root, 'evidence/decision.json');
  writeJson(root, 'evidence/bundle.json', bundle);
  const pageManifest = {
    schema_version: 1,
    policy: 'fail_closed_page_publication_v1',
    documents: [{
      document_id: documentId,
      source_artifact_sha256: sourceRef.sha256,
      acceptance_status: 'accepted_page_manifest',
      reviewed_by: reviewerId,
      reviewed_at: decidedAt,
      pages: [{
        page_number: 1,
        source_page_sha256: rendered.sha256,
        final_text_sha256: artifactRef(root, 'evidence/final-text.md').sha256,
        evidence_bundle_sha256: artifactRef(root, 'evidence/bundle.json').sha256,
        stable_locator: `${documentId}:page:1`,
        review_status: 'accepted',
        display_allowed: true,
        citation_allowed: true,
        uncertainty_note: null,
      }],
    }],
  };
  writeJson(root, 'data/page-publication-manifest.json', pageManifest);
  const release = {
    schema_version: 1,
    policy: 'immutable_page_evidence_release_v1',
    status: 'publication_candidate',
    authority_registry: artifactRef(root, 'evidence/reviewer-authorities.json'),
    bindings: {
      catalog: artifactRef(root, 'data/catalog.json'),
      page_publication_manifest: artifactRef(root, 'data/page-publication-manifest.json'),
      semantic_publication_policy: artifactRef(root, 'data/semantic-publication-policy.json'),
      online_verification_standard: artifactRef(root, 'data/online-verification-standard.json'),
    },
    bundles: [{
      document_id: documentId,
      page_number: 1,
      stable_locator: `${documentId}:page:1`,
      bundle: artifactRef(root, 'evidence/bundle.json'),
    }],
    expected_publication: {
      documents: 1,
      pages: 1,
      display_pages: 1,
      citation_pages: 1,
      resolved_semantic_controls: 1,
    },
    unresolved_reasons: [],
  };
  writeJson(root, 'release.json', release);
}

function cloneFixture(name, source = baseFixture) {
  const root = path.join(temporaryRoot, name);
  cpSync(source, root, { recursive: true });
  return root;
}

function authorityPin(root) {
  return artifactRef(root, 'evidence/reviewer-authorities.json').sha256;
}

function validateFixture(root, overrides = {}) {
  return validatePageEvidenceRelease({
    root,
    evidenceManifestPath: 'release.json',
    authorityRegistrySha256: authorityPin(root),
    ...overrides,
  });
}

before(async () => {
  await createBaseFixture(baseFixture);
  await createBaseFixture(adjudicatedFixture, { adjudicated: true });
});

after(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

test('current repository manifest is valid and remains zero-publication fail-closed', () => {
  const result = validatePageEvidenceRelease({ root: repositoryRoot });
  assert.equal(result.valid, true);
  assert.equal(result.publishable, false);
  assert.deepEqual(result.counts, {
    documents: 0,
    pages: 0,
    display_pages: 0,
    citation_pages: 0,
    resolved_semantic_controls: 0,
  });
  assert.throws(
    () => validatePageEvidenceRelease({ root: repositoryRoot, requirePublishable: true }),
    /promotion requires/,
  );
});

test('valid fixture recomputes the real PDF render, OCR, audit, online sources, and reviewer signature', () => {
  const root = cloneFixture('valid');
  const result = validateFixture(root, { requirePublishable: true });
  assert.equal(result.valid, true);
  assert.equal(result.publishable, true);
  assert.equal(existsSync(path.join(root, 'evidence/page.png')), false);
  assert.deepEqual(result.counts, {
    documents: 1,
    pages: 1,
    display_pages: 1,
    citation_pages: 1,
    resolved_semantic_controls: 1,
  });
  assert.throws(
    () => validatePageEvidenceRelease({ root, evidenceManifestPath: 'release.json' }),
    /external PAGE_EVIDENCE_AUTHORITY_SHA256 pin/,
  );
});

test('image plus signed human review and two independent exact-edition texts may adjudicate one OCR engine error', () => {
  const root = cloneFixture('valid-image-online-adjudication', adjudicatedFixture);
  const result = validateFixture(root, { requirePublishable: true });
  assert.equal(result.publishable, true);
  assert.equal(result.counts.citation_pages, 1);
});

test('image/online adjudication cannot unlock from only one exact-edition source', () => {
  const root = cloneFixture('adjudication-single-source', adjudicatedFixture);
  const claims = readJson(root, 'evidence/online-claims.json');
  claims.same_version_status = 'single_source_only';
  claims.claims = claims.claims.slice(0, 1);
  writeJson(root, 'evidence/online-claims.json', claims);
  const decision = readJson(root, 'evidence/decision.json');
  decision.online_same_version_status = 'single_source_only';
  writeJson(root, 'evidence/decision.json', decision);
  refreshChain(root);
  assert.throws(
    () => validateFixture(root),
    /requires two independent exact-edition online supporting texts containing the adjudicated value/,
  );
});

test('image/online adjudication records the exact deviating engine', () => {
  const root = cloneFixture('adjudication-engine-drift', adjudicatedFixture);
  const decision = readJson(root, 'evidence/decision.json');
  decision.critical_field_decisions[0].deviating_engines = ['vision_ocr'];
  writeJson(root, 'evidence/decision.json', decision);
  refreshChain(root);
  assert.throws(() => validateFixture(root), /does not record the exact deviating OCR engines/);
});

test('search snippets are not admissible online evidence for OCR adjudication', () => {
  const root = cloneFixture('adjudication-search-snippet', adjudicatedFixture);
  const claims = readJson(root, 'evidence/online-claims.json');
  claims.claims[1].source_type = 'search_snippet';
  writeJson(root, 'evidence/online-claims.json', claims);
  refreshChain(root);
  assert.throws(() => validateFixture(root), /not an official or academic source class/);
});

test('rejects a plausible-looking fake SHA-256 without trusting its format', () => {
  const root = cloneFixture('fake-hash');
  const release = readJson(root, 'release.json');
  release.bindings.catalog.sha256 = 'a'.repeat(64);
  writeJson(root, 'release.json', release);
  assert.throws(() => validateFixture(root), /sha256 does not match the actual file/);
});

test('rejects a bound file that is missing', () => {
  const root = cloneFixture('missing-file');
  unlinkSync(path.join(root, 'evidence/online-academic.txt'));
  assert.throws(() => validateFixture(root), /locator is missing/);
});

test('rejects an out-of-range physical PDF page before OCR evidence can be promoted', () => {
  const root = cloneFixture('out-of-range');
  assert.throws(
    () => renderPdfPage({ sourcePath: path.join(root, 'evidence/source.pdf'), pageNumber: 2, dpi: 144 }),
    /exceeds actual page count 1/,
  );
});

test('rejects an exact-edition claim whose observed version is different', () => {
  const root = cloneFixture('version-mismatch');
  const claims = readJson(root, 'evidence/online-claims.json');
  claims.claims[1].observed_version.version_label = '2024 revision';
  writeJson(root, 'evidence/online-claims.json', claims);
  refreshChain(root);
  assert.throws(() => validateFixture(root), /claims an exact edition but its observed version is different/);
});

test('rejects same-source and same-content mirrors as independent online witnesses', () => {
  const root = cloneFixture('same-source-mirror');
  const claims = readJson(root, 'evidence/online-claims.json');
  claims.claims[1].url = 'https://official.example.edu/mirror/page-1';
  writeJson(root, 'evidence/online-claims.json', claims);
  refreshChain(root);
  assert.throws(() => validateFixture(root), /reuse the same source host/);
});

test('rejects different-host mirrors with identical normalized snapshot content', () => {
  const root = cloneFixture('same-content-mirror');
  writeText(
    root,
    'evidence/online-academic.txt',
    readFileSync(path.join(root, 'evidence/online-official.txt'), 'utf8'),
  );
  const claims = readJson(root, 'evidence/online-claims.json');
  claims.claims[1].snapshot = artifactRef(root, 'evidence/online-academic.txt');
  writeJson(root, 'evidence/online-claims.json', claims);
  refreshChain(root);
  assert.throws(() => validateFixture(root), /same-content mirrors/);
});

test('rejects accepted publication when critical_fields is empty even if hashes are refreshed', () => {
  const root = cloneFixture('empty-critical-fields');
  const vision = readJson(root, 'evidence/vision.json');
  vision.critical_fields = [];
  writeJson(root, 'evidence/vision.json', vision);
  const primaryText = readFileSync(path.join(root, 'evidence/primary-content.md'), 'utf8');
  writeJson(root, 'evidence/audit.json', auditReport(primaryText, vision));
  const decision = readJson(root, 'evidence/decision.json');
  decision.critical_fields_complete = false;
  decision.critical_field_decisions = [];
  writeJson(root, 'evidence/decision.json', decision);
  refreshChain(root);
  assert.throws(() => validateFixture(root), /non-empty, explicitly complete critical_fields/);
});

test('rejects a fake or unregistered reviewer before trusting the manifest identity', () => {
  const root = cloneFixture('fake-reviewer');
  const decision = readJson(root, 'evidence/decision.json');
  decision.reviewer_id = 'ghost-reviewer';
  writeJson(root, 'evidence/decision.json', decision);
  refreshChain(root);
  assert.throws(() => validateFixture(root), /unknown reviewer ghost-reviewer/);
});

test('rejects an invalid signature from a registered reviewer', () => {
  const root = cloneFixture('invalid-reviewer-signature');
  const decision = readJson(root, 'evidence/decision.json');
  decision.signature_base64 = Buffer.alloc(64, 1).toString('base64');
  writeJson(root, 'evidence/decision.json', decision);
  refreshChain(root);
  assert.throws(() => validateFixture(root), /Ed25519 signature is invalid/);
});

test('document-level citation gate cannot be bypassed by a page decision', () => {
  const root = cloneFixture('document-citation-gate');
  const catalog = readJson(root, 'data/catalog.json');
  catalog.documents[0].citation_allowed = false;
  writeJson(root, 'data/catalog.json', catalog);
  refreshChain(root);
  assert.throws(() => validateFixture(root), /document-level catalog citation_allowed gate is closed/);
});

test('same-batch manifest and evidence edits still fail without a new reviewer signature', () => {
  const root = cloneFixture('same-batch-edit');
  writeText(root, 'evidence/final-text.md', '课程目标 2022\n语言文字运用\n未经签名的同批篡改');
  refreshChain(root);
  assert.throws(() => validateFixture(root), /signed_payload_sha256 differs from the recomputed actual-object payload/);
});

test('same-batch semantic policy edits cannot reuse a signed control id', () => {
  const root = cloneFixture('same-batch-semantic-edit');
  const semantic = readJson(root, 'data/semantic-publication-policy.json');
  semantic.page_controls[0].note = 'Weakened after signature without reviewer authorization.';
  writeJson(root, 'data/semantic-publication-policy.json', semantic);
  refreshChain(root);
  assert.throws(
    () => validateFixture(root),
    /signed semantic control binding differs from the actual policy object/,
  );
});

test('rejects a partial page list even when catalog and semantic manifest hashes are refreshed together', () => {
  const root = cloneFixture('partial-page-list');
  const catalog = readJson(root, 'data/catalog.json');
  catalog.documents[0].page_count = 2;
  writeJson(root, 'data/catalog.json', catalog);
  const semantic = readJson(root, 'data/semantic-publication-policy.json');
  semantic.page_controls[0].page_count = 2;
  writeJson(root, 'data/semantic-publication-policy.json', semantic);
  refreshChain(root);
  assert.throws(() => validateFixture(root), /complete actual PDF page range, not a partial page list/);
});

test('changing reviewer registry and manifest in one batch cannot bypass the external authority pin', () => {
  const root = cloneFixture('registry-batch-edit');
  const originalPin = authorityPin(root);
  const registry = readJson(root, 'evidence/reviewer-authorities.json');
  registry.reviewers[0].display_name = 'Unpinned Replacement';
  writeJson(root, 'evidence/reviewer-authorities.json', registry);
  refreshChain(root);
  assert.throws(
    () => validatePageEvidenceRelease({
      root,
      evidenceManifestPath: 'release.json',
      authorityRegistrySha256: originalPin,
    }),
    /external authority registry SHA-256 pin differs/,
  );
});
