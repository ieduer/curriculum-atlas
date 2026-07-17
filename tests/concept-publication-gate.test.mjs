import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptedConceptPages,
  bindConceptDocumentText,
  conceptFrequencyDenominators,
  conceptObservationIdentity,
  conceptOcrObservationPolicy,
  createConceptPublicationGate,
} from '../scripts/concept-page-publication.mjs';
import { sha256Text } from '../scripts/page-publication-gate.mjs';

const digest = (label) => sha256Text(`fixture:${label}`);
const sourceA = digest('edition-a');
const sourceB = digest('edition-b');
const pageTexts = [
  '未发布页内容可以变化，且不得进入任何概念、频率或修订指纹。',
  '显示候选页包含语言文字运用等词面，但不得成为可引用或语义关系。',
  '引用接受页包含阅读与鉴赏等词面，并由页面级证据链精确绑定。',
];

const ocrRecord = {
  id: 'ocr-2001-a',
  file_format: 'pdf_scan',
  text_quality_status: 'ocr_required',
  citation_allowed: true,
};
const secondEdition = { ...ocrRecord, id: 'ocr-2001-b' };

function manifest({ unresolvedSourcePage = digest('page-1'), unresolvedFinalText = digest('unreleased-text'), acceptedFinalText = sha256Text(pageTexts[1]) } = {}) {
  return {
    schema_version: 1,
    policy: 'fail_closed_page_publication_v1',
    documents: [{
      document_id: ocrRecord.id,
      source_artifact_sha256: sourceA,
      acceptance_status: 'accepted_page_manifest',
      reviewed_by: 'fixture-reviewer',
      reviewed_at: '2026-07-16T12:00:00Z',
      pages: [
        {
          page_number: 1,
          source_page_sha256: unresolvedSourcePage,
          final_text_sha256: unresolvedFinalText,
          evidence_bundle_sha256: digest('evidence-1'),
          stable_locator: `${ocrRecord.id}:page:1`,
          review_status: 'unresolved_fail_closed',
          display_allowed: false,
          citation_allowed: false,
          uncertainty_note: '版本或字词尚未核定。',
        },
        {
          page_number: 2,
          source_page_sha256: digest('page-2'),
          final_text_sha256: acceptedFinalText,
          evidence_bundle_sha256: digest('evidence-2'),
          stable_locator: `${ocrRecord.id}:page:2`,
          review_status: 'accepted',
          display_allowed: true,
          citation_allowed: false,
          uncertainty_note: '可显示观察，不可引用。',
        },
        {
          page_number: 3,
          source_page_sha256: digest('page-3'),
          final_text_sha256: sha256Text(pageTexts[2]),
          evidence_bundle_sha256: digest('evidence-3'),
          stable_locator: `${ocrRecord.id}:page:3`,
          review_status: 'accepted',
          display_allowed: true,
          citation_allowed: true,
        },
      ],
    }],
  };
}

test('unaccepted OCR pages do not enter the concept projection or its revision fingerprint', () => {
  const gateA = createConceptPublicationGate({ manifest: manifest(), records: [ocrRecord, secondEdition] });
  const gateB = createConceptPublicationGate({
    manifest: manifest({ unresolvedSourcePage: digest('changed-page-1'), unresolvedFinalText: digest('changed-unreleased-text') }),
    records: [ocrRecord, secondEdition],
  });
  assert.deepEqual(gateA.revision_projection.map((page) => page.page_number), [2, 3]);
  assert.equal(gateA.revision_sha256, gateB.revision_sha256);

  const acceptedPages = acceptedConceptPages({
    gate: gateA,
    record: ocrRecord,
    sourceArtifactSha256: sourceA,
    documentCitationAllowed: true,
  });
  const boundA = bindConceptDocumentText({ pages: acceptedPages, rawPages: pageTexts });
  const boundB = bindConceptDocumentText({ pages: acceptedPages, rawPages: ['完全不同的未发布内容', pageTexts[1], pageTexts[2]] });
  assert.deepEqual(boundA, boundB);
  assert.deepEqual(boundA.map((page) => page.page_number), [2, 3]);
});

test('display-only OCR is an explicitly nonsemantic non-citable observation candidate', () => {
  const gate = createConceptPublicationGate({ manifest: manifest(), records: [ocrRecord, secondEdition] });
  const [displayOnly, citationReady] = acceptedConceptPages({
    gate,
    record: ocrRecord,
    sourceArtifactSha256: sourceA,
    documentCitationAllowed: true,
  });
  assert.deepEqual(conceptOcrObservationPolicy(displayOnly), {
    evidence_status: 'verified_non_citation',
    observation_class: 'nonsemantic_candidate',
    semantic: false,
    semantic_relation_allowed: false,
    quotation_allowed: false,
  });
  assert.equal(displayOnly.source_page_sha256, digest('page-2'));
  assert.equal(displayOnly.final_text_sha256, sha256Text(pageTexts[1]));
  assert.equal(displayOnly.evidence_bundle_sha256, digest('evidence-2'));
  assert.equal(displayOnly.stable_locator, `${ocrRecord.id}:page:2`);
  assert.equal(conceptOcrObservationPolicy(citationReady).quotation_allowed, true);
  assert.notEqual(
    conceptObservationIdentity({ conceptId: 'c', senseId: 's', lineId: 'l', editionId: 'e', year: 2001, observationClass: 'nonsemantic_candidate' }),
    conceptObservationIdentity({ conceptId: 'c', senseId: 's', lineId: 'l', editionId: 'e', year: 2001, observationClass: 'citation_ready' }),
  );
  assert.deepEqual(conceptFrequencyDenominators([
    { citation_allowed: false, meaningful_characters: 100, text_reuse_cluster_id: null },
    { citation_allowed: true, meaningful_characters: 20, text_reuse_cluster_id: null },
    { citation_allowed: true, meaningful_characters: 999, text_reuse_cluster_id: 'reuse:excluded' },
  ]), { citation_ready: 20, nonsemantic_candidate: 100 });
});

test('accepted OCR final-text hash drift fails closed while unresolved-page drift is ignored', () => {
  const gate = createConceptPublicationGate({ manifest: manifest(), records: [ocrRecord, secondEdition] });
  const pages = acceptedConceptPages({
    gate,
    record: ocrRecord,
    sourceArtifactSha256: sourceA,
    documentCitationAllowed: true,
  });
  assert.throws(
    () => bindConceptDocumentText({ pages, rawPages: [pageTexts[0], '被篡改的已发布文本', pageTexts[2]] }),
    /page 2 final text hash drift/,
  );
});

test('source hash and document identity prevent cross-edition or cross-document binding', () => {
  const gate = createConceptPublicationGate({ manifest: manifest(), records: [ocrRecord, secondEdition] });
  assert.throws(() => acceptedConceptPages({
    gate,
    record: ocrRecord,
    sourceArtifactSha256: sourceB,
    documentCitationAllowed: true,
  }), /source artifact hash drift or cross-edition binding/);
  assert.deepEqual(acceptedConceptPages({
    gate,
    record: secondEdition,
    sourceArtifactSha256: sourceB,
    documentCitationAllowed: true,
  }), []);
});

test('an accepted page changes the revision fingerprint and cannot open citation past the document gate', () => {
  const gateA = createConceptPublicationGate({ manifest: manifest(), records: [ocrRecord, secondEdition] });
  const gateB = createConceptPublicationGate({
    manifest: manifest({ acceptedFinalText: digest('new-accepted-page-text') }),
    records: [ocrRecord, secondEdition],
  });
  assert.notEqual(gateA.revision_sha256, gateB.revision_sha256);
  assert.throws(() => acceptedConceptPages({
    gate: gateA,
    record: ocrRecord,
    sourceArtifactSha256: sourceA,
    documentCitationAllowed: false,
  }), /citation is open while the document gate is closed/);
});

test('native official text cannot be replaced by an OCR publication manifest', () => {
  assert.throws(() => createConceptPublicationGate({
    manifest: manifest(),
    records: [{ ...ocrRecord, file_format: 'html', text_quality_status: 'official_native_text' }],
  }), /native official text must not be overridden/);
});
