import {
  isNativeTextRecord,
  sha256Text,
  validatePagePublicationManifest,
} from './page-publication-gate.mjs';
import {
  applySemanticPagePublication,
  createSemanticPublicationGate,
  semanticDocumentDisposition,
  semanticPageScope,
} from './semantic-publication-gate.mjs';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(`concept page publication gate: ${message}`);
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) fail(`${label} must be a SHA-256 digest`);
}

export function createConceptPublicationGate({ manifest, semanticPolicy = null, records }) {
  const normalized = validatePagePublicationManifest(manifest);
  const recordById = new Map(records.map((record) => [record.id, record]));
  const documentById = new Map();
  const semanticGate = semanticPolicy
    ? createSemanticPublicationGate({ policy: semanticPolicy, records })
    : null;

  for (const document of normalized.documents) {
    const record = recordById.get(document.document_id);
    if (!record) fail(`${document.document_id}: manifest references an unknown catalog document`);
    if (semanticGate && semanticDocumentDisposition(semanticGate, record).excluded) {
      fail(`${document.document_id}: exact duplicate alias cannot have an accepted OCR page manifest`);
    }
    if (isNativeTextRecord(record)) fail(`${document.document_id}: native official text must not be overridden by an OCR page manifest`);
    documentById.set(document.document_id, document);
  }

  const revisionProjection = normalized.documents.flatMap((document) => document.pages
    .filter((page) => page.display_allowed)
    .filter((page) => {
      if (!semanticGate) return true;
      const record = recordById.get(document.document_id);
      const scope = semanticPageScope({ gate: semanticGate, record, pageNumber: page.page_number });
      return !scope.document_excluded && scope.unresolved_controls.length === 0;
    })
    .map((page) => ({
      document_id: document.document_id,
      source_artifact_sha256: document.source_artifact_sha256,
      page_number: page.page_number,
      source_page_sha256: page.source_page_sha256,
      final_text_sha256: page.final_text_sha256,
      evidence_bundle_sha256: page.evidence_bundle_sha256,
      stable_locator: page.stable_locator,
      citation_allowed: page.citation_allowed,
      reviewed_by: document.reviewed_by,
      reviewed_at: document.reviewed_at,
      uncertainty_note: page.uncertainty_note,
    })));

  return {
    schema_version: normalized.schema_version,
    policy: normalized.policy,
    documentById,
    semantic_gate: semanticGate,
    semantic_publication_revision_sha256: semanticGate?.revision_sha256 || null,
    revision_projection: revisionProjection,
    revision_sha256: sha256Text(JSON.stringify({
      semantic_publication_revision_sha256: semanticGate?.revision_sha256 || null,
      pages: revisionProjection,
    })),
  };
}

export function acceptedConceptPages({
  gate,
  record,
  sourceArtifactSha256,
  documentCitationAllowed,
}) {
  if (gate.semantic_gate && semanticDocumentDisposition(gate.semantic_gate, record).excluded) return [];
  const manifestDocument = gate.documentById.get(record.id);
  if (!manifestDocument) return [];
  requireSha256(sourceArtifactSha256, `${record.id}.sourceArtifactSha256`);
  if (manifestDocument.source_artifact_sha256 !== sourceArtifactSha256) {
    fail(`${record.id}: source artifact hash drift or cross-edition binding`);
  }

  return manifestDocument.pages.filter((page) => page.display_allowed)
    .filter((page) => {
      if (!gate.semantic_gate) return true;
      const scope = semanticPageScope({ gate: gate.semantic_gate, record, pageNumber: page.page_number });
      return !scope.document_excluded && scope.unresolved_controls.length === 0;
    })
    .map((page) => {
    if (page.citation_allowed && !documentCitationAllowed) {
      fail(`${record.id}: page ${page.page_number} citation is open while the document gate is closed`);
    }
    return {
      document_id: record.id,
      page_number: page.page_number,
      source_artifact_sha256: sourceArtifactSha256,
      source_page_sha256: page.source_page_sha256,
      final_text_sha256: page.final_text_sha256,
      evidence_bundle_sha256: page.evidence_bundle_sha256,
      stable_locator: page.stable_locator,
      review_status: page.review_status,
      reviewed_by: manifestDocument.reviewed_by,
      reviewed_at: manifestDocument.reviewed_at,
      uncertainty_note: page.uncertainty_note,
      display_allowed: true,
      citation_allowed: page.citation_allowed && documentCitationAllowed,
      publication_basis: 'accepted_ocr_page_manifest',
    };
  });
}

export function bindConceptPageText(page, rawText, { semanticGate = null, record = null } = {}) {
  if (!page?.display_allowed) fail('cannot bind text for a page whose display gate is closed');
  if (typeof rawText !== 'string') fail(`${page.document_id}: page ${page.page_number} final text is missing`);
  const actual = sha256Text(rawText);
  if (actual !== page.final_text_sha256) {
    fail(`${page.document_id}: page ${page.page_number} final text hash drift`);
  }
  const bound = { ...page, raw_text: rawText };
  if (!semanticGate) return bound;
  if (!record) fail(`${page.document_id}: semantic publication binding requires the catalog record`);
  return applySemanticPagePublication({
    gate: semanticGate,
    record,
    page: bound,
    rawText,
  });
}

export function bindConceptDocumentText({ pages, rawPages, semanticGate = null, record = null }) {
  if (!Array.isArray(rawPages)) fail('rawPages must be an array');
  return pages
    .map((page) => bindConceptPageText(
      page,
      rawPages[page.page_number - 1],
      { semanticGate, record },
    ))
    .filter((page) => page.display_allowed);
}

export function conceptOcrObservationPolicy(page, { forceNonCitation = false } = {}) {
  if (!page?.display_allowed) fail('cannot create an OCR observation policy for a display-closed page');
  const citationReady = page.citation_allowed && !forceNonCitation;
  return {
    evidence_status: citationReady ? 'citation_ready' : 'verified_non_citation',
    observation_class: citationReady ? 'citation_ready' : 'nonsemantic_candidate',
    semantic: false,
    semantic_relation_allowed: citationReady,
    quotation_allowed: citationReady,
  };
}

export function conceptFrequencyDenominators(paragraphs) {
  const totals = { citation_ready: 0, nonsemantic_candidate: 0 };
  for (const paragraph of paragraphs) {
    if (paragraph.text_reuse_cluster_id) continue;
    const observationClass = paragraph.citation_allowed ? 'citation_ready' : 'nonsemantic_candidate';
    totals[observationClass] += paragraph.meaningful_characters;
  }
  return totals;
}

export function conceptObservationIdentity({ conceptId, senseId, lineId, editionId, year, observationClass }) {
  if (!['citation_ready', 'nonsemantic_candidate'].includes(observationClass)) {
    fail(`invalid concept observation class: ${observationClass}`);
  }
  return [conceptId, senseId, lineId, editionId, year, observationClass].join('|');
}
