export function evidenceIdentityId(evidence) {
  return evidence?.embedded_item_id || evidence?.document_id || null;
}

export function evidenceIdentityHref(evidence, paragraphId = null) {
  const id = evidenceIdentityId(evidence);
  if (!id) return null;
  const anchor = Number.isSafeInteger(paragraphId) && paragraphId > 0 ? `#p-${paragraphId}` : '';
  return `/document/${encodeURIComponent(id)}${anchor}`;
}
