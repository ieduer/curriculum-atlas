import { createHash } from 'node:crypto';

export const COMPENDIUM_TOC_PAGE_RECEIPT_POLICY = 'compendium_toc_page_evidence_bundle_v1';
export const COMPENDIUM_TOC_ENTRY_RECEIPT_POLICY = 'compendium_toc_entry_evidence_v1';
export const COMPENDIUM_ITEM_CITATION_POLICY = 'compendium_item_scoped_citation_entitlement_v1';
export const COMPENDIUM_STABLE_ITEM_ID_POLICY = 'compendium_stable_item_identity_v1';

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function compendiumTocPageReceiptProjection({
  documentId,
  sourceArtifactSha256,
  pageNumber,
  primaryTextSha256,
  sourceImageSha256,
  visionWitnessSha256,
}) {
  return {
    policy: COMPENDIUM_TOC_PAGE_RECEIPT_POLICY,
    document_id: documentId,
    source_artifact_sha256: sourceArtifactSha256,
    physical_pdf_page: pageNumber,
    primary_text_sha256: primaryTextSha256,
    source_image_sha256: sourceImageSha256,
    vision_witness_sha256: visionWitnessSha256,
  };
}

export function compendiumTocPageReceiptSha256(value) {
  return sha256Bytes(JSON.stringify(compendiumTocPageReceiptProjection(value)));
}

export function compendiumTocEntryReceiptProjection({
  documentId,
  sourceArtifactSha256,
  tocPageNumber,
  tocPageEvidenceBundleSha256,
  sourceLine,
  section,
  displayYear,
  rawTitle,
  printedPageStart,
}) {
  return {
    policy: COMPENDIUM_TOC_ENTRY_RECEIPT_POLICY,
    document_id: documentId,
    source_artifact_sha256: sourceArtifactSha256,
    toc_physical_page: tocPageNumber,
    toc_page_evidence_bundle_sha256: tocPageEvidenceBundleSha256,
    source_line: sourceLine,
    source_line_sha256: sha256Bytes(sourceLine),
    section,
    display_year: displayYear,
    raw_title: rawTitle,
    printed_page_start: printedPageStart,
  };
}

export function compendiumTocEntryReceiptSha256(value) {
  return sha256Bytes(JSON.stringify(compendiumTocEntryReceiptProjection(value)));
}

export function compendiumStableItemId({
  documentId,
  sourceArtifactSha256,
  tocEntryReceiptSha256,
}) {
  if (!/^[a-z0-9][a-z0-9-]+$/.test(documentId || '')
    || !/^[a-f0-9]{64}$/.test(sourceArtifactSha256 || '')
    || !/^[a-f0-9]{64}$/.test(tocEntryReceiptSha256 || '')) {
    throw new Error('compendium stable item identity input is invalid');
  }
  const identity = sha256Bytes(JSON.stringify({
    policy: COMPENDIUM_STABLE_ITEM_ID_POLICY,
    parent_document_id: documentId,
    source_artifact_sha256: sourceArtifactSha256,
    toc_entry_receipt_sha256: tocEntryReceiptSha256,
  })).slice(0, 24);
  return `embedded:${documentId}:${identity}`;
}

export function onlineRegistryStatusForCompendium(status) {
  const mapping = {
    same_edition_exact_text_verified: 'verified_exact',
    different_edition_stable_facts_only: 'verified_stable_fact_only',
  };
  return mapping[status] || null;
}

export function compendiumItemCitationEntitlementSha256({
  itemId,
  parentDocumentId,
  sourceArtifactSha256,
  pageSetSha256,
  primaryItemTextSha256,
  onlineTextSha256,
  onlineSourceIds,
}) {
  return sha256Bytes(JSON.stringify({
    policy: COMPENDIUM_ITEM_CITATION_POLICY,
    item_id: itemId,
    parent_document_id: parentDocumentId,
    source_artifact_sha256: sourceArtifactSha256,
    page_set_sha256: pageSetSha256,
    primary_item_text_sha256: primaryItemTextSha256,
    online_text_sha256: onlineTextSha256,
    online_source_ids: [...onlineSourceIds].sort(),
  }));
}
