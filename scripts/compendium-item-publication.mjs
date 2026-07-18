import { createHash } from 'node:crypto';

import {
  canonicalCompendiumTitle,
  compendiumPageSetSha256,
} from './validate-compendium-item-boundaries.mjs';

const CORPUS_RELEASE_PATTERN = /^corpus-[a-f0-9]{24}$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(item, message) {
  throw new Error(`${item.item_id}: ${message}`);
}

export function verifyCompendiumHeadingEvidence({
  documentBoundary,
  item,
  primaryBytes,
  witnessBytes,
  acceptedPage = null,
}) {
  const heading = item.body_heading;
  if (heading?.verification_status !== 'image_primary_witness_verified') {
    fail(item, 'body heading evidence is not verified');
  }
  const primary = Buffer.isBuffer(primaryBytes) ? primaryBytes : Buffer.from(primaryBytes);
  const witnessRaw = Buffer.isBuffer(witnessBytes) ? witnessBytes : Buffer.from(witnessBytes);
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

export function verifyCompendiumItemPageEvidence({
  documentBoundary,
  item,
  boundPages,
  rawPages,
  currentCorpusReleaseId,
}) {
  if (!CORPUS_RELEASE_PATTERN.test(currentCorpusReleaseId || '')) {
    fail(item, 'current corpus release identity is invalid');
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
    pagePublicationReleaseId: currentCorpusReleaseId,
    physicalPageStart: item.candidate_physical_page_start,
    physicalPageEnd: item.candidate_physical_page_end,
    pages: boundPages,
  });
  const evidence = item.page_evidence;
  if (!['all_pages_display_verified', 'all_pages_citation_verified'].includes(evidence?.verification_status)
    || evidence.page_publication_release_id !== currentCorpusReleaseId
    || evidence.physical_page_start !== item.candidate_physical_page_start
    || evidence.physical_page_end !== item.candidate_physical_page_end
    || evidence.page_set_sha256 !== pageSetSha256
    || evidence.accepted_page_count !== boundPages.length) {
    fail(item, 'page evidence is stale or not bound to the current corpus release');
  }
  if (evidence.verification_status === 'all_pages_citation_verified'
    && !boundPages.every((page) => page.citation_allowed === true)) {
    fail(item, 'all-pages citation claim exceeds the page publication gate');
  }
  const fullItemRawTextSha256 = sha256(rawPages.join('\f'));
  if (item.online_verification.verification_status === 'same_edition_exact_text_verified'
    && item.online_verification.primary_item_text_sha256 !== fullItemRawTextSha256) {
    fail(item, 'same-edition online comparison is bound to stale primary text');
  }
  return { page_set_sha256: pageSetSha256, full_item_raw_text_sha256: fullItemRawTextSha256 };
}
