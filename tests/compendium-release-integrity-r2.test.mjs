import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  effectiveParagraphCitationAllowed,
  verifyCompendiumItemPageEvidence,
} from '../scripts/compendium-item-publication.mjs';
import { compendiumStableItemId } from '../scripts/compendium-evidence-receipt.mjs';
import { compendiumPageSetSha256 } from '../scripts/validate-compendium-item-boundaries.mjs';
import { coreConceptEvidenceProjection } from '../scripts/concept-evidence-projection.mjs';
import { loadAllDocumentIdentities } from '../public/document-pagination.js';
import {
  buildCommentThread,
  commentReplyTarget,
} from '../public/comment-thread.js';
import { evidenceIdentityHref } from '../public/identity-links.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');

test('effective paragraph citation gate requires the page and the identity-specific entitlement', () => {
  assert.equal(effectiveParagraphCitationAllowed({
    paragraphAllowed: true, pageAllowed: true, documentAllowed: true,
  }), true);
  assert.equal(effectiveParagraphCitationAllowed({
    paragraphAllowed: true, pageAllowed: false, documentAllowed: true,
  }), false, 'ordinary page=0/document=1 must fail closed');
  assert.equal(effectiveParagraphCitationAllowed({
    paragraphAllowed: true, pageAllowed: true, documentAllowed: false,
  }), false, 'ordinary page=1/document=0 must fail closed');
  assert.equal(effectiveParagraphCitationAllowed({
    paragraphAllowed: true, pageAllowed: true, documentAllowed: false,
    embeddedItemId: 'embedded:carrier:0123456789abcdef01234567', itemAllowed: true,
  }), true, 'an embedded item does not inherit the parent document citation gate');
  assert.equal(effectiveParagraphCitationAllowed({
    paragraphAllowed: true, pageAllowed: false, documentAllowed: true,
    embeddedItemId: 'embedded:carrier:0123456789abcdef01234567', itemAllowed: true,
  }), false, 'embedded page=0/item=1 must fail closed');
  assert.equal(effectiveParagraphCitationAllowed({
    paragraphAllowed: true, pageAllowed: true, documentAllowed: true,
    embeddedItemId: 'embedded:carrier:0123456789abcdef01234567', itemAllowed: false,
  }), false, 'embedded page=1/item=0/parent=1 must fail closed');
});

test('all_pages_citation_verified means every bound page is citation-allowed', () => {
  const releaseId = `page-gate-${'a'.repeat(24)}`;
  const documentBoundary = {
    document_id: 'carrier',
    source_artifact_sha256: 'b'.repeat(64),
  };
  const rawPages = ['第一页', '第二页'];
  const boundPages = rawPages.map((text, index) => ({
    document_id: documentBoundary.document_id,
    page_number: index + 1,
    source_artifact_sha256: documentBoundary.source_artifact_sha256,
    source_page_sha256: digest(`image-${index}`),
    final_text_sha256: digest(text),
    evidence_bundle_sha256: digest(`bundle-${index}`),
    stable_locator: `carrier:page:${index + 1}`,
    display_allowed: true,
    citation_allowed: index === 0,
  }));
  const pageSetSha256 = compendiumPageSetSha256({
    documentId: documentBoundary.document_id,
    sourceArtifactSha256: documentBoundary.source_artifact_sha256,
    pagePublicationReleaseId: releaseId,
    physicalPageStart: 1,
    physicalPageEnd: 2,
    pages: boundPages,
  });
  const item = {
    item_id: 'embedded:carrier:0123456789abcdef01234567',
    candidate_physical_page_start: 1,
    candidate_physical_page_end: 2,
    page_evidence: {
      verification_status: 'all_pages_citation_verified',
      page_publication_release_id: releaseId,
      physical_page_start: 1,
      physical_page_end: 2,
      accepted_page_count: 2,
      page_set_sha256: pageSetSha256,
      item_citation_entitlement_sha256: 'c'.repeat(64),
    },
    online_verification: {
      verification_status: 'same_edition_exact_text_verified',
      primary_item_text_sha256: digest(rawPages.join('\f')),
      online_text_sha256: 'd'.repeat(64),
      source_ids: ['source:one'],
    },
  };
  assert.throws(() => verifyCompendiumItemPageEvidence({
    documentBoundary,
    item,
    boundPages,
    rawPages,
    currentPagePublicationReleaseId: releaseId,
  }), /every bound page is not citation-allowed/);
});

test('compendium item identity is content-derived and independent from sequence', () => {
  const input = {
    documentId: 'carrier',
    sourceArtifactSha256: 'a'.repeat(64),
    tocEntryReceiptSha256: 'b'.repeat(64),
  };
  const id = compendiumStableItemId(input);
  assert.match(id, /^embedded:carrier:[a-f0-9]{24}$/);
  assert.equal(compendiumStableItemId({ ...input, sequence: 99 }), id);
  assert.notEqual(compendiumStableItemId({ ...input, tocEntryReceiptSha256: 'c'.repeat(64) }), id);
});

test('documents pagination exhausts 256 identities without gaps or duplicates', async () => {
  const identities = Array.from({ length: 256 }, (_, index) => ({ id: `identity-${String(index).padStart(3, '0')}` }));
  const requests = [];
  const documents = await loadAllDocumentIdentities(async ({ limit, cursor }) => {
    requests.push({ limit, cursor });
    const offset = cursor ? Number(Buffer.from(cursor, 'base64url').toString('utf8')) : 0;
    const page = identities.slice(offset, offset + limit);
    const next = offset + page.length;
    return {
      documents: page,
      total: identities.length,
      hasMore: next < identities.length,
      cursor: next < identities.length ? Buffer.from(String(next)).toString('base64url') : null,
    };
  }, { pageSize: 100 });
  assert.deepEqual(documents.map((item) => item.id), identities.map((item) => item.id));
  assert.deepEqual(requests.map((item) => item.limit), [100, 100, 100]);
});

test('graph evidence deep links prefer embedded item identities', () => {
  const projected = coreConceptEvidenceProjection({
    id: 'evidence:one',
    document_id: 'carrier',
    embedded_item_id: 'embedded:carrier:0123456789abcdef01234567',
    document_title: '篇目',
  });
  assert.equal(projected.embedded_item_id, 'embedded:carrier:0123456789abcdef01234567');
  assert.equal(evidenceIdentityHref({
    document_id: 'carrier', embedded_item_id: 'embedded:carrier:0123456789abcdef01234567',
  }), '/document/embedded%3Acarrier%3A0123456789abcdef01234567');
  assert.equal(evidenceIdentityHref({ document_id: 'carrier' }, 42), '/document/carrier#p-42');
});

test('comment replies retain parent identity and deterministic hierarchy', () => {
  const comments = [
    { id: 'child', parent_id: 'root', paragraph_id: 42, body: 'reply' },
    { id: 'root', parent_id: null, body: 'topic' },
    { id: 'orphan', parent_id: 'missing', body: 'orphan' },
  ];
  const thread = buildCommentThread(comments);
  assert.deepEqual(thread.map((item) => item.id), ['root', 'orphan']);
  assert.deepEqual(thread[0].children.map((item) => item.id), ['child']);
  assert.deepEqual(commentReplyTarget(comments[0]), { parentId: 'child', paragraphId: 42, label: 'reply' });
});
