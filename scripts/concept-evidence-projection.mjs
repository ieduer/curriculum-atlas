export function coreConceptEvidenceProjection(item) {
  return {
    id: item.id,
    document_id: item.document_id,
    embedded_item_id: item.embedded_item_id,
    document_title: item.document_title,
    source_locator: item.source_locator,
    physical_pdf_page: item.physical_pdf_page,
    printed_page: item.printed_page,
    paragraph_ordinal: item.paragraph_ordinal,
    matched_surface: item.matched_surface,
    snippet: item.snippet,
    source_artifact_sha256: item.source_artifact_sha256,
    source_page_sha256: item.source_page_sha256,
    final_text_sha256: item.final_text_sha256,
    evidence_bundle_sha256: item.evidence_bundle_sha256,
    stable_locator: item.stable_locator,
    publication_basis: item.publication_basis,
    semantic_claim_allowed: item.semantic_claim_allowed,
    evidence_status: item.evidence_status,
    citation_allowed: item.citation_allowed,
    uncertainty_note: item.uncertainty_note,
  };
}
