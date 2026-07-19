import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  canonicalCompendiumTitle,
  compendiumPageSetSha256,
} from './validate-compendium-item-boundaries.mjs';
import {
  compendiumItemCitationEntitlementSha256,
  compendiumTocEntryReceiptSha256,
  compendiumTocPageReceiptSha256,
} from './compendium-evidence-receipt.mjs';

const PAGE_PUBLICATION_RELEASE_PATTERN = /^page-gate-[a-f0-9]{24}$/;

const allowed = (value) => value === true || value === 1;

export function effectiveParagraphCitationAllowed({
  paragraphAllowed,
  pageAllowed,
  documentAllowed,
  embeddedItemId = null,
  itemAllowed = false,
}) {
  if (!allowed(paragraphAllowed) || !allowed(pageAllowed)) return false;
  return embeddedItemId ? allowed(itemAllowed) : allowed(documentAllowed);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(item, message) {
  throw new Error(`${item.item_id}: ${message}`);
}

async function readPageArtifacts({ documentId, pageNumber, ocrRoot, witnessRoot }) {
  const primaryPath = path.join(
    ocrRoot,
    documentId,
    'pages',
    String(pageNumber).padStart(4, '0'),
    'content.md',
  );
  const witnessPath = path.join(
    witnessRoot,
    documentId,
    'vision',
    `page-${String(pageNumber).padStart(3, '0')}.json`,
  );
  const sourceImagePath = path.join(
    witnessRoot,
    documentId,
    'images',
    `page-${String(pageNumber).padStart(3, '0')}.png`,
  );
  const [primaryBytes, witnessBytes, sourceImageBytes] = await Promise.all([
    readFile(primaryPath),
    readFile(witnessPath),
    readFile(sourceImagePath),
  ]);
  return { primaryBytes, witnessBytes, sourceImageBytes };
}

export async function verifyCompendiumTocEvidenceArtifacts({
  documentBoundary,
  ocrRoot,
  witnessRoot,
}) {
  const pageEvidenceByNumber = new Map();
  for (const pageEvidence of documentBoundary.toc_evidence.physical_pages) {
    const pageNumber = pageEvidence.page_number;
    const { primaryBytes, witnessBytes, sourceImageBytes } = await readPageArtifacts({
      documentId: documentBoundary.document_id,
      pageNumber,
      ocrRoot,
      witnessRoot,
    });
    let witness;
    try {
      witness = JSON.parse(witnessBytes.toString('utf8'));
    } catch {
      throw new Error(`${documentBoundary.document_id}: TOC page ${pageNumber} Vision witness is not valid JSON`);
    }
    const primaryTextSha256 = sha256(primaryBytes);
    const sourceImageSha256 = sha256(sourceImageBytes);
    const visionWitnessSha256 = sha256(witnessBytes);
    const evidenceBundleSha256 = compendiumTocPageReceiptSha256({
      documentId: documentBoundary.document_id,
      sourceArtifactSha256: documentBoundary.source_artifact_sha256,
      pageNumber,
      primaryTextSha256,
      sourceImageSha256,
      visionWitnessSha256,
    });
    if (witness.document_id !== documentBoundary.document_id
      || witness.physical_pdf_page !== pageNumber
      || witness.source_pdf_sha256 !== documentBoundary.source_artifact_sha256
      || witness.rendered_image_sha256 !== sourceImageSha256
      || pageEvidence.primary_text_sha256 !== primaryTextSha256
      || pageEvidence.source_image_sha256 !== sourceImageSha256
      || pageEvidence.vision_witness_sha256 !== visionWitnessSha256
      || pageEvidence.evidence_bundle_sha256 !== evidenceBundleSha256) {
      throw new Error(`${documentBoundary.document_id}: TOC page ${pageNumber} image/primary/Vision receipt drifted`);
    }
    pageEvidenceByNumber.set(pageNumber, {
      evidence_bundle_sha256: evidenceBundleSha256,
      primary_lines: primaryBytes.toString('utf8').split(/\r?\n/).map((line) => line.trim()),
    });
  }

  for (const item of documentBoundary.items) {
    const tocPage = pageEvidenceByNumber.get(item.toc_physical_page);
    const entry = item.toc_entry_evidence;
    if (!tocPage || entry.toc_page_evidence_bundle_sha256 !== tocPage.evidence_bundle_sha256) {
      fail(item, 'TOC entry is not bound to its verified physical page');
    }
    const exactLineMatches = tocPage.primary_lines.filter((line) => line === entry.source_line).length;
    const entryReceiptSha256 = compendiumTocEntryReceiptSha256({
      documentId: documentBoundary.document_id,
      sourceArtifactSha256: documentBoundary.source_artifact_sha256,
      tocPageNumber: item.toc_physical_page,
      tocPageEvidenceBundleSha256: tocPage.evidence_bundle_sha256,
      sourceLine: entry.source_line,
      section: item.section,
      displayYear: item.display_year,
      rawTitle: item.raw_title,
      printedPageStart: item.printed_page_start,
    });
    if (exactLineMatches !== 1
      || entry.source_line_sha256 !== sha256(entry.source_line)
      || entry.entry_receipt_sha256 !== entryReceiptSha256
      || item.toc_entry_sha256 !== entryReceiptSha256) {
      fail(item, 'TOC source line or item receipt drifted from the actual primary page');
    }
  }

  return {
    document_id: documentBoundary.document_id,
    verified_toc_pages: pageEvidenceByNumber.size,
    verified_toc_entries: documentBoundary.items.length,
  };
}

export function verifyCompendiumHeadingEvidence({
  documentBoundary,
  item,
  primaryBytes,
  witnessBytes,
  sourceImageBytes,
  acceptedPage = null,
}) {
  const heading = item.body_heading;
  if (heading?.verification_status !== 'image_primary_witness_verified') {
    fail(item, 'body heading evidence is not verified');
  }
  const primary = Buffer.isBuffer(primaryBytes) ? primaryBytes : Buffer.from(primaryBytes);
  const witnessRaw = Buffer.isBuffer(witnessBytes) ? witnessBytes : Buffer.from(witnessBytes);
  const imageRaw = Buffer.isBuffer(sourceImageBytes) ? sourceImageBytes : Buffer.from(sourceImageBytes || []);
  let witness;
  try {
    witness = JSON.parse(witnessRaw.toString('utf8'));
  } catch {
    fail(item, 'body heading witness is not valid JSON');
  }
  const markdownHeadings = primary.toString('utf8').split(/\r?\n/)
    .map((line) => /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1] || null)
    .filter(Boolean);
  const witnessLines = (witness.lines || []).map((line) => line.text)
    .filter((line) => typeof line === 'string');
  if (!markdownHeadings.some((line) => canonicalCompendiumTitle(line) === item.title)
    || !witnessLines.some((line) => canonicalCompendiumTitle(line) === item.title)
    || canonicalCompendiumTitle(heading.exact_text) !== item.title
    || heading.primary_ocr_sha256 !== sha256(primary)
    || heading.witness_sha256 !== sha256(witnessRaw)
    || heading.source_image_sha256 !== sha256(imageRaw)
    || heading.source_image_sha256 !== witness.rendered_image_sha256
    || witness.document_id !== documentBoundary.document_id
    || witness.physical_pdf_page !== heading.physical_page
    || witness.source_pdf_sha256 !== documentBoundary.source_artifact_sha256) {
    fail(item, 'body heading image/primary/witness evidence drifted');
  }
  if (acceptedPage && (acceptedPage.document_id !== documentBoundary.document_id
    || acceptedPage.page_number !== heading.physical_page
    || acceptedPage.source_artifact_sha256 !== documentBoundary.source_artifact_sha256
    || acceptedPage.final_text_sha256 !== heading.primary_ocr_sha256
    || acceptedPage.source_page_sha256 !== heading.source_image_sha256)) {
    fail(item, 'body heading is not bound to the accepted page evidence');
  }
  return {
    raw_text: primary.toString('utf8'),
    primary_ocr_sha256: heading.primary_ocr_sha256,
    witness_sha256: heading.witness_sha256,
    witness,
  };
}

export function verifyCompendiumPageAssetEvidence({
  documentBoundary,
  pageNumber,
  primaryBytes,
  witnessBytes,
  sourceImageBytes,
  acceptedPage,
}) {
  const primary = Buffer.isBuffer(primaryBytes) ? primaryBytes : Buffer.from(primaryBytes);
  const witnessRaw = Buffer.isBuffer(witnessBytes) ? witnessBytes : Buffer.from(witnessBytes);
  const imageRaw = Buffer.isBuffer(sourceImageBytes) ? sourceImageBytes : Buffer.from(sourceImageBytes);
  let witness;
  try {
    witness = JSON.parse(witnessRaw.toString('utf8'));
  } catch {
    throw new Error(`${documentBoundary.document_id}: page ${pageNumber} Vision witness is not valid JSON`);
  }
  if (witness.document_id !== documentBoundary.document_id
    || witness.physical_pdf_page !== pageNumber
    || witness.source_pdf_sha256 !== documentBoundary.source_artifact_sha256
    || witness.rendered_image_sha256 !== sha256(imageRaw)
    || acceptedPage?.document_id !== documentBoundary.document_id
    || acceptedPage?.page_number !== pageNumber
    || acceptedPage?.source_artifact_sha256 !== documentBoundary.source_artifact_sha256
    || acceptedPage?.source_page_sha256 !== witness.rendered_image_sha256
    || acceptedPage?.final_text_sha256 !== sha256(primary)
    || !/^[a-f0-9]{64}$/.test(acceptedPage?.evidence_bundle_sha256 || '')
    || acceptedPage?.display_allowed !== true) {
    throw new Error(`${documentBoundary.document_id}: page ${pageNumber} image/primary/Vision/page receipt drifted`);
  }
  return {
    primary_ocr_sha256: sha256(primary),
    source_image_sha256: sha256(imageRaw),
    witness_sha256: sha256(witnessRaw),
  };
}

export function verifyCompendiumItemPageEvidence({
  documentBoundary,
  item,
  boundPages,
  rawPages,
  currentPagePublicationReleaseId,
}) {
  if (!PAGE_PUBLICATION_RELEASE_PATTERN.test(currentPagePublicationReleaseId || '')) {
    fail(item, 'current page-publication release identity is invalid');
  }
  if (!Array.isArray(rawPages) || rawPages.length !== boundPages?.length) {
    fail(item, 'primary page text is not complete');
  }
  if (!rawPages.every((rawText, index) => typeof rawText === 'string'
    && sha256(rawText) === boundPages[index]?.final_text_sha256)) {
    fail(item, 'primary page text hash drifted from the accepted page set');
  }
  const pageSetSha256 = compendiumPageSetSha256({
    documentId: documentBoundary.document_id,
    sourceArtifactSha256: documentBoundary.source_artifact_sha256,
    pagePublicationReleaseId: currentPagePublicationReleaseId,
    physicalPageStart: item.candidate_physical_page_start,
    physicalPageEnd: item.candidate_physical_page_end,
    pages: boundPages,
  });
  const evidence = item.page_evidence;
  if (evidence?.verification_status === 'all_pages_citation_verified'
    && !boundPages.every((page) => page?.citation_allowed === true)) {
    fail(item, 'all_pages_citation_verified but every bound page is not citation-allowed');
  }
  if (!['all_pages_display_verified', 'all_pages_citation_verified'].includes(evidence?.verification_status)
    || evidence.page_publication_release_id !== currentPagePublicationReleaseId
    || evidence.physical_page_start !== item.candidate_physical_page_start
    || evidence.physical_page_end !== item.candidate_physical_page_end
    || evidence.page_set_sha256 !== pageSetSha256
    || evidence.accepted_page_count !== boundPages.length) {
    fail(item, 'page evidence is stale or not bound to the current corpus release');
  }
  const fullItemRawTextSha256 = sha256(rawPages.join('\f'));
  if (item.online_verification.verification_status === 'same_edition_exact_text_verified'
    && item.online_verification.primary_item_text_sha256 !== fullItemRawTextSha256) {
    fail(item, 'same-edition online comparison is bound to stale primary text');
  }
  const citationEntitlementSha256 = evidence.verification_status === 'all_pages_citation_verified'
    ? compendiumItemCitationEntitlementSha256({
      itemId: item.item_id,
      parentDocumentId: documentBoundary.document_id,
      sourceArtifactSha256: documentBoundary.source_artifact_sha256,
      pageSetSha256,
      primaryItemTextSha256: fullItemRawTextSha256,
      onlineTextSha256: item.online_verification.online_text_sha256,
      onlineSourceIds: item.online_verification.source_ids,
    })
    : null;
  if (evidence.item_citation_entitlement_sha256 !== citationEntitlementSha256) {
    fail(item, 'item-scoped citation entitlement is missing or stale');
  }
  return {
    page_set_sha256: pageSetSha256,
    full_item_raw_text_sha256: fullItemRawTextSha256,
    item_citation_entitlement_sha256: citationEntitlementSha256,
  };
}

export function compendiumGraphEmbeddedItem({
  item,
  parentDocumentId,
  parentWorkId,
  pageSetSha256,
  pagePublicationReleaseId,
  corpusReleaseId,
  endBoundaryBasis = 'next_verified_body_heading',
}) {
  if (item?.display_allowed !== true) fail(item || { item_id: '<missing>' }, 'graph item is not display-allowed');
  if (!PAGE_PUBLICATION_RELEASE_PATTERN.test(pagePublicationReleaseId || '')
    || item.page_evidence?.page_publication_release_id !== pagePublicationReleaseId) {
    fail(item, 'graph item page-publication release is missing or stale');
  }
  if (!/^[a-f0-9]{64}$/.test(pageSetSha256 || '')
    || item.page_evidence?.page_set_sha256 !== pageSetSha256) {
    fail(item, 'graph item page set is missing or stale');
  }
  if (!/^corpus-[a-f0-9]{24}$/.test(corpusReleaseId || '')) {
    fail(item, 'graph item corpus release is invalid');
  }
  return {
    id: item.item_id,
    parent_document_id: parentDocumentId,
    parent_work_id: parentWorkId,
    parent_item_id: item.parent_item_id,
    item_kind: item.item_kind,
    title: item.title,
    raw_title: item.raw_title,
    identity_status: 'verified_full_item',
    physical_page_start: item.candidate_physical_page_start,
    physical_page_end: item.candidate_physical_page_end,
    printed_page_start: item.printed_page_start,
    display_year: item.display_year,
    year_basis: item.year_basis,
    stage: item.section,
    issuing_body: item.issuing_body,
    end_boundary_basis: endBoundaryBasis,
    page_publication_release_id: pagePublicationReleaseId,
    page_set_sha256: pageSetSha256,
    corpus_release_id: corpusReleaseId,
    online_verification_status: item.online_verification.verification_status,
    online_source_ids: item.online_verification.source_ids,
    citation_allowed: item.citation_allowed,
    semantic_claim_allowed: item.semantic_claim_allowed,
    uncertainty_note: item.uncertainty_note,
  };
}
