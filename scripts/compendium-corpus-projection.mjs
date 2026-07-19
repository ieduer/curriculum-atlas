export function buildCompendiumCorpusProjection(boundaries, corpusReleaseId) {
  const rows = [];
  const byDocument = new Map();
  for (const document of boundaries.documents || []) {
    const items = (document.items || []).filter((item) => item.display_allowed === true);
    const activeItemIds = new Set(items.map((item) => item.item_id));
    const documentRows = [];
    for (const item of items) {
      if (item.parent_item_id && !activeItemIds.has(item.parent_item_id)) {
        throw new Error(`${item.item_id}: active attachment lacks its published parent item`);
      }
      const row = {
        id: item.item_id,
        parent_document_id: document.document_id,
        parent_item_id: item.parent_item_id,
        sequence: item.sequence,
        item_kind: item.item_kind,
        title: item.title,
        raw_title: item.raw_title,
        stage: item.section,
        display_year: item.display_year,
        year_basis: item.year_basis,
        physical_page_start: item.candidate_physical_page_start,
        physical_page_end: item.candidate_physical_page_end,
        printed_page_start: item.printed_page_start,
        issuing_body: item.issuing_body,
        identity_status: item.identity_status,
        page_publication_release_id: item.page_evidence.page_publication_release_id,
        page_set_sha256: item.page_evidence.page_set_sha256,
        item_citation_entitlement_sha256: item.page_evidence.item_citation_entitlement_sha256,
        online_verification_status: item.online_verification.verification_status,
        online_source_ids_json: JSON.stringify(item.online_verification.source_ids),
        display_allowed: 1,
        citation_allowed: item.citation_allowed ? 1 : 0,
        semantic_claim_allowed: item.semantic_claim_allowed ? 1 : 0,
        uncertainty_note: item.uncertainty_note,
        corpus_release_id: corpusReleaseId,
      };
      rows.push(row);
      documentRows.push(row);
    }
    documentRows.sort((left, right) => left.physical_page_start - right.physical_page_start);
    byDocument.set(document.document_id, documentRows);
  }
  return { rows, byDocument };
}

export function compendiumItemForPage(projection, documentId, pageNumber) {
  const matches = (projection.byDocument.get(documentId) || []).filter(
    (item) => pageNumber >= item.physical_page_start && pageNumber <= item.physical_page_end,
  );
  if (matches.length > 1) throw new Error(`${documentId}: page ${pageNumber} is assigned to multiple embedded items`);
  return matches[0] || null;
}
