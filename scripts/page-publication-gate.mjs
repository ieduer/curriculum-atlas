import { createHash } from 'node:crypto';

export const PAGE_PUBLICATION_SCHEMA_VERSION = 1;
export const PAGE_PUBLICATION_POLICY = 'fail_closed_page_publication_v1';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DOCUMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function fail(message) {
  throw new Error(`page publication manifest: ${message}`);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
}

function requireExactKeys(value, label, required, optional = []) {
  requireObject(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label}.${key} is not allowed`);
  }
}

function requireString(value, label, pattern = null) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string`);
  if (pattern && !pattern.test(value)) fail(`${label} has an invalid format`);
  return value;
}

function requireSha256(value, label) {
  return requireString(value, label, SHA256_PATTERN);
}

function requireIsoTimestamp(value, label) {
  requireString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || Number.isNaN(Date.parse(value))) {
    fail(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return value;
}

function optionalBoolean(value, label) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
}

export function sha256Text(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function isNativeTextRecord(record) {
  return record.text_quality_status === 'official_native_text';
}

export function validatePagePublicationManifest(manifest) {
  requireExactKeys(
    manifest,
    'root',
    ['schema_version', 'policy', 'documents'],
    ['$schema'],
  );
  if (manifest.schema_version !== PAGE_PUBLICATION_SCHEMA_VERSION) {
    fail(`schema_version must equal ${PAGE_PUBLICATION_SCHEMA_VERSION}`);
  }
  if (manifest.policy !== PAGE_PUBLICATION_POLICY) {
    fail(`policy must equal ${PAGE_PUBLICATION_POLICY}`);
  }
  if (!Array.isArray(manifest.documents)) fail('documents must be an array');

  const documentIds = new Set();
  const documents = manifest.documents.map((document, documentIndex) => {
    const documentLabel = `documents[${documentIndex}]`;
    requireExactKeys(document, documentLabel, [
      'document_id',
      'source_artifact_sha256',
      'acceptance_status',
      'reviewed_by',
      'reviewed_at',
      'pages',
    ]);
    const documentId = requireString(document.document_id, `${documentLabel}.document_id`, DOCUMENT_ID_PATTERN);
    if (documentIds.has(documentId)) fail(`${documentLabel}.document_id is duplicated`);
    documentIds.add(documentId);
    if (document.acceptance_status !== 'accepted_page_manifest') {
      fail(`${documentLabel}.acceptance_status must equal accepted_page_manifest`);
    }
    requireSha256(document.source_artifact_sha256, `${documentLabel}.source_artifact_sha256`);
    requireString(document.reviewed_by, `${documentLabel}.reviewed_by`);
    requireIsoTimestamp(document.reviewed_at, `${documentLabel}.reviewed_at`);
    if (!Array.isArray(document.pages) || document.pages.length === 0) {
      fail(`${documentLabel}.pages must be a non-empty array`);
    }

    const pages = document.pages.map((page, pageIndex) => {
      const pageLabel = `${documentLabel}.pages[${pageIndex}]`;
      requireExactKeys(page, pageLabel, [
        'page_number',
        'source_page_sha256',
        'final_text_sha256',
        'evidence_bundle_sha256',
        'stable_locator',
        'review_status',
      ], ['display_allowed', 'citation_allowed', 'uncertainty_note']);
      if (!Number.isInteger(page.page_number) || page.page_number !== pageIndex + 1) {
        fail(`${pageLabel}.page_number must be the contiguous 1-based page number ${pageIndex + 1}`);
      }
      requireSha256(page.source_page_sha256, `${pageLabel}.source_page_sha256`);
      requireSha256(page.final_text_sha256, `${pageLabel}.final_text_sha256`);
      requireSha256(page.evidence_bundle_sha256, `${pageLabel}.evidence_bundle_sha256`);
      const expectedLocator = `${documentId}:page:${page.page_number}`;
      if (page.stable_locator !== expectedLocator) {
        fail(`${pageLabel}.stable_locator must equal ${expectedLocator}`);
      }
      if (!['accepted', 'unresolved_fail_closed'].includes(page.review_status)) {
        fail(`${pageLabel}.review_status is invalid`);
      }
      const displayAllowed = optionalBoolean(page.display_allowed, `${pageLabel}.display_allowed`);
      const citationAllowed = optionalBoolean(page.citation_allowed, `${pageLabel}.citation_allowed`);
      if (citationAllowed && !displayAllowed) fail(`${pageLabel} cannot allow citation while display is closed`);
      if (displayAllowed && page.review_status !== 'accepted') {
        fail(`${pageLabel} cannot allow display before accepted review`);
      }
      const uncertaintyNote = page.uncertainty_note === undefined || page.uncertainty_note === null
        ? null
        : requireString(page.uncertainty_note, `${pageLabel}.uncertainty_note`);
      if (page.review_status === 'unresolved_fail_closed' && !uncertaintyNote) {
        fail(`${pageLabel}.uncertainty_note is required for unresolved_fail_closed`);
      }
      return {
        ...page,
        display_allowed: displayAllowed,
        citation_allowed: citationAllowed,
        uncertainty_note: uncertaintyNote,
      };
    });
    return { ...document, pages };
  });

  return {
    schema_version: PAGE_PUBLICATION_SCHEMA_VERSION,
    policy: PAGE_PUBLICATION_POLICY,
    documents,
  };
}

export function bindAcceptedOcrDocument({
  record,
  sourceArtifactSha256,
  rawPages,
  manifestDocument,
  documentCitationAllowed,
}) {
  if (!manifestDocument) fail(`${record.id}: accepted page manifest is required before reading OCR text`);
  requireSha256(sourceArtifactSha256, `${record.id}.sourceArtifactSha256`);
  if (manifestDocument.document_id !== record.id) fail(`${record.id}: manifest document identity mismatch`);
  if (manifestDocument.source_artifact_sha256 !== sourceArtifactSha256) {
    fail(`${record.id}: source artifact hash drift`);
  }
  if (!Array.isArray(rawPages) || rawPages.length !== manifestDocument.pages.length) {
    fail(`${record.id}: final text page count does not match the accepted manifest`);
  }
  if (Number.isInteger(record.page_count) && record.page_count !== rawPages.length) {
    fail(`${record.id}: final text page count does not match catalog page_count`);
  }

  return manifestDocument.pages.map((page, index) => {
    const actualFinalTextSha256 = sha256Text(rawPages[index]);
    if (actualFinalTextSha256 !== page.final_text_sha256) {
      fail(`${record.id}: page ${page.page_number} final text hash drift`);
    }
    if (page.citation_allowed && !documentCitationAllowed) {
      fail(`${record.id}: page ${page.page_number} citation is open while the document gate is closed`);
    }
    return {
      page_number: page.page_number,
      source_artifact_sha256: sourceArtifactSha256,
      source_page_sha256: page.source_page_sha256,
      page_final_text_sha256: page.final_text_sha256,
      evidence_bundle_sha256: page.evidence_bundle_sha256,
      stable_locator: page.stable_locator,
      review_status: page.review_status,
      reviewed_by: manifestDocument.reviewed_by,
      reviewed_at: manifestDocument.reviewed_at,
      uncertainty_note: page.uncertainty_note,
      display_allowed: page.display_allowed,
      citation_allowed: page.citation_allowed && documentCitationAllowed,
    };
  });
}

export function paragraphProvenanceLocator(documentId, pageNumber, blockNumber, bodySha256) {
  requireString(documentId, 'paragraph.document_id', DOCUMENT_ID_PATTERN);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) fail('paragraph.page_number must be positive');
  if (!Number.isInteger(blockNumber) || blockNumber < 1) fail('paragraph.block_number must be positive');
  requireSha256(bodySha256, 'paragraph.body_sha256');
  return `${documentId}:page:${pageNumber}:block:${blockNumber}:body:${bodySha256}`;
}
