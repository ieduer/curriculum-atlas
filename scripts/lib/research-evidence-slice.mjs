import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9:._-]*$/;
const EXACT_VERSION_RELATIONS = new Set([
  'exact_document_exact_edition',
  'same_artifact_exact_edition',
  'official_release_same_edition',
]);
const SOURCE_ROLES = new Set([
  'primary_artifact',
  'official_version_identity',
  'official_version_identity_with_policy_text',
  'independent_text_transcription',
  'independent_policy_correspondence',
  'integrity_only_same_artifact',
]);
const WITNESS_SCOPES = new Set([
  'artifact_identity_only',
  'version_identity_only',
  'exact_document_text',
  'same_version_policy_text',
  'artifact_integrity_only',
]);
const PUBLICATION_KEYS = Object.freeze([
  'builder_input_allowed',
  'public_compare_allowed',
  'public_star_allowed',
  'ai_citation_allowed',
  'discussion_claim_citation_allowed',
]);
const SEMANTIC_STATUS_VALUES = new Set([
  'exact-source-supported',
  'online-version-conflict',
  'editor-review-pending',
]);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
}

export function canonicalJson(value) {
  return JSON.stringify(sorted(value));
}

function decodeHtmlEntities(value) {
  const named = {
    amp: '&', apos: "'", ensp: ' ', emsp: ' ', gt: '>', hellip: '…',
    lt: '<', nbsp: ' ', ndash: '–', mdash: '—', quot: '"', thinsp: ' ',
  };
  return value
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (match, encoded) => {
      const radix = encoded[0].toLowerCase() === 'x' ? 16 : 10;
      const digits = radix === 16 ? encoded.slice(1) : encoded;
      const codepoint = Number.parseInt(digits, radix);
      if (!Number.isInteger(codepoint) || codepoint < 0 || codepoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codepoint);
      } catch {
        return match;
      }
    })
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}

export function canonicalizeHtmlText(html) {
  return decodeHtmlEntities(String(html)
    .replace(/^\ufeff/, '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|hr)\b[^>]*\/?>|<\/(p|div|section|article|li|tr|td|th|h[1-6])\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ''))
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .trim();
}

function addError(errors, code, location, detail) {
  errors.push({ code, location, detail });
}

function expect(errors, condition, code, location, detail) {
  if (!condition) addError(errors, code, location, detail);
}

function uniqueMap(items, key, errors, location) {
  const result = new Map();
  for (const [index, item] of (Array.isArray(items) ? items : []).entries()) {
    const id = item?.[key];
    if (typeof id !== 'string' || !ID.test(id)) {
      addError(errors, 'invalid_id', `${location}[${index}].${key}`, String(id));
      continue;
    }
    if (result.has(id)) addError(errors, 'duplicate_id', `${location}[${index}].${key}`, id);
    else result.set(id, item);
  }
  return result;
}

function exactKeys(value, keys) {
  return isObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function safeResource(resourcePaths, resourceId, errors, location) {
  const rawPath = resourcePaths?.[resourceId];
  if (typeof rawPath !== 'string' || !path.isAbsolute(rawPath)) {
    addError(errors, 'resource_missing', location, `${resourceId} is not mapped to an absolute path`);
    return null;
  }
  try {
    const state = lstatSync(rawPath);
    if (!state.isFile() || state.isSymbolicLink()) {
      addError(errors, 'resource_not_regular_file', location, resourceId);
      return null;
    }
    return readFileSync(rawPath);
  } catch (error) {
    addError(errors, 'resource_missing', location, `${resourceId}: ${error.code || error.message}`);
    return null;
  }
}

function occurrences(body, needle) {
  const offsets = [];
  let cursor = -1;
  while ((cursor = body.indexOf(needle, cursor + 1)) >= 0) offsets.push(cursor);
  return offsets;
}

function assertionBundle(assertion, evidenceById) {
  return {
    assertion_id: assertion.assertion_id,
    assertion_kind: assertion.assertion_kind,
    dimension: assertion.dimension,
    claim: assertion.claim,
    from_document_id: assertion.from_document_id,
    to_document_id: assertion.to_document_id,
    from_evidence: assertion.from_evidence_ids.map((id) => ({
      evidence_id: id,
      exact_text_sha256: evidenceById.get(id)?.exact_text_sha256 ?? null,
    })),
    to_evidence: assertion.to_evidence_ids.map((id) => ({
      evidence_id: id,
      exact_text_sha256: evidenceById.get(id)?.exact_text_sha256 ?? null,
    })),
    version_identity_source_ids: assertion.version_identity_source_ids,
    unresolved_conflict_ids: assertion.unresolved_conflict_ids,
  };
}

function validateManifestBoundary(manifest, errors) {
  expect(errors, isObject(manifest), 'manifest_not_object', '$', 'manifest must be an object');
  if (!isObject(manifest)) return;
  expect(errors, manifest.schema_version === 1, 'schema_version_mismatch', '$.schema_version', 'expected 1');
  expect(errors, manifest.policy === 'resolved_exact_span_fail_closed_research_slice_v1', 'policy_mismatch', '$.policy', String(manifest.policy));
  expect(errors, typeof manifest.slice_id === 'string' && ID.test(manifest.slice_id), 'slice_id_invalid', '$.slice_id', String(manifest.slice_id));
  expect(errors, manifest.subject_facet === '语文', 'subject_facet_mismatch', '$.subject_facet', String(manifest.subject_facet));
  expect(errors, manifest.school_type === 'ordinary_general_education', 'school_type_mismatch', '$.school_type', String(manifest.school_type));
  expect(errors, manifest.stage === '普通高中', 'stage_mismatch', '$.stage', String(manifest.stage));
  expect(errors, typeof manifest.assertion_boundary === 'string' && manifest.assertion_boundary.length > 0, 'assertion_boundary_missing', '$.assertion_boundary', 'required');
  expect(errors, Array.isArray(manifest.documents) && manifest.documents.length === 2, 'document_pair_required', '$.documents', 'exactly two documents required');
  expect(errors, Array.isArray(manifest.online_sources) && manifest.online_sources.length >= 6, 'online_sources_incomplete', '$.online_sources', 'at least two primary, two identity and two independent sources required');
  expect(errors, Array.isArray(manifest.evidence) && manifest.evidence.length >= 2, 'evidence_incomplete', '$.evidence', 'at least two anchors required');
  expect(errors, Array.isArray(manifest.conflicts), 'conflicts_not_array', '$.conflicts', 'required array');
  expect(errors, Array.isArray(manifest.assertions) && manifest.assertions.length >= 1, 'assertions_incomplete', '$.assertions', 'at least one assertion required');
  expect(errors,
    exactKeys(manifest.release_boundary, ['signed_editor_review_required', 'builder_input_allowed', 'public_data_update_allowed', 'deployment_allowed']),
    'release_boundary_shape_invalid', '$.release_boundary', 'unexpected or missing release boundary key');
  if (isObject(manifest.release_boundary)) {
    expect(errors, manifest.release_boundary.signed_editor_review_required === true, 'signed_review_not_required', '$.release_boundary.signed_editor_review_required', 'must equal true');
    for (const key of ['builder_input_allowed', 'public_data_update_allowed', 'deployment_allowed']) {
      expect(errors, manifest.release_boundary[key] === false, 'release_boundary_not_fail_closed', `$.release_boundary.${key}`, 'must equal false');
    }
  }
}

function validateOnlineSources({ manifest, resourcePaths, errors }) {
  const sourceById = uniqueMap(manifest.online_sources, 'source_id', errors, '$.online_sources');
  const spanById = new Map();
  const primaryHashes = new Map();
  const resolvedSources = new Map();

  for (const [sourceId, source] of sourceById) {
    const location = `$.online_sources[${sourceId}]`;
    expect(errors, SOURCE_ROLES.has(source.evidence_role), 'source_role_invalid', `${location}.evidence_role`, String(source.evidence_role));
    expect(errors, WITNESS_SCOPES.has(source.witness_scope), 'witness_scope_invalid', `${location}.witness_scope`, String(source.witness_scope));
    expect(errors, typeof source.url === 'string' && /^https:\/\//.test(source.url), 'source_url_invalid', `${location}.url`, String(source.url));
    expect(errors, isObject(source.resource) && ID.test(source.resource?.resource_id || ''), 'source_resource_invalid', `${location}.resource`, 'resource_id required');
    expect(errors, SHA256.test(source.resource?.sha256 || ''), 'source_sha256_invalid', `${location}.resource.sha256`, String(source.resource?.sha256));
    expect(errors, Array.isArray(source.spans), 'source_spans_not_array', `${location}.spans`, 'required array');
    expect(errors, Array.isArray(source.limitations) && source.limitations.length > 0, 'source_limitations_missing', `${location}.limitations`, 'at least one limitation required');

    const raw = safeResource(resourcePaths, source.resource?.resource_id, errors, `${location}.resource`);
    if (raw && SHA256.test(source.resource?.sha256 || '')) {
      expect(errors, sha256(raw) === source.resource.sha256, 'source_resource_sha256_mismatch', `${location}.resource.sha256`, sourceId);
    }

    if (source.evidence_role === 'primary_artifact') {
      expect(errors, source.resource?.media_type === 'application/pdf', 'primary_artifact_media_type_invalid', `${location}.resource.media_type`, String(source.resource?.media_type));
      expect(errors, source.independently_counts_for_text === false, 'primary_artifact_marked_independent', `${location}.independently_counts_for_text`, sourceId);
      expect(errors, source.witness_scope === 'artifact_identity_only', 'primary_artifact_scope_invalid', `${location}.witness_scope`, sourceId);
      expect(errors, source.same_artifact_as === null, 'primary_artifact_same_artifact_pointer', `${location}.same_artifact_as`, sourceId);
      primaryHashes.set(sourceId, source.resource?.sha256);
    }
    if (source.evidence_role === 'integrity_only_same_artifact') {
      expect(errors, source.independently_counts_for_text === false, 'same_artifact_marked_independent', `${location}.independently_counts_for_text`, sourceId);
      expect(errors, source.witness_scope === 'artifact_integrity_only', 'integrity_mirror_scope_invalid', `${location}.witness_scope`, sourceId);
      expect(errors, typeof source.same_artifact_as === 'string', 'integrity_mirror_primary_missing', `${location}.same_artifact_as`, sourceId);
    }
    if (source.independently_counts_for_text === true) {
      expect(errors,
        ['independent_text_transcription', 'independent_policy_correspondence', 'official_version_identity_with_policy_text'].includes(source.evidence_role),
        'independent_role_invalid', `${location}.evidence_role`, sourceId);
      expect(errors, source.same_artifact_as === null, 'independent_source_same_artifact_pointer', `${location}.same_artifact_as`, sourceId);
      expect(errors,
        ['exact_document_text', 'same_version_policy_text'].includes(source.witness_scope),
        'independent_witness_scope_invalid', `${location}.witness_scope`, sourceId);
    }

    let canonicalBody = null;
    if (source.resource?.media_type === 'text/html' && raw) {
      canonicalBody = canonicalizeHtmlText(raw.toString('utf8'));
      expect(errors, SHA256.test(source.canonical_text_sha256 || ''), 'online_body_sha256_invalid', `${location}.canonical_text_sha256`, sourceId);
      expect(errors, sha256(canonicalBody) === source.canonical_text_sha256, 'online_body_sha256_mismatch', `${location}.canonical_text_sha256`, sourceId);
    } else {
      expect(errors, source.canonical_text_sha256 === null, 'binary_source_has_canonical_text_sha256', `${location}.canonical_text_sha256`, sourceId);
    }

    for (const [index, span] of (source.spans || []).entries()) {
      const spanLocation = `${location}.spans[${index}]`;
      const spanId = span?.span_id;
      expect(errors, typeof spanId === 'string' && ID.test(spanId), 'online_span_id_invalid', `${spanLocation}.span_id`, String(spanId));
      if (spanById.has(spanId)) addError(errors, 'duplicate_online_span_id', `${spanLocation}.span_id`, spanId);
      else spanById.set(spanId, { source, span });
      expect(errors, ['version_identity', 'exact_text_witness', 'transcription_conflict'].includes(span?.purpose), 'online_span_purpose_invalid', `${spanLocation}.purpose`, String(span?.purpose));
      expect(errors, Number.isInteger(span?.utf16_start) && span.utf16_start >= 0, 'online_span_start_invalid', `${spanLocation}.utf16_start`, String(span?.utf16_start));
      expect(errors, Number.isInteger(span?.utf16_end) && span.utf16_end > span.utf16_start, 'online_span_end_invalid', `${spanLocation}.utf16_end`, String(span?.utf16_end));
      expect(errors, typeof span?.exact_text === 'string' && span.exact_text.length > 0, 'online_span_text_missing', `${spanLocation}.exact_text`, 'required');
      expect(errors, sha256(span?.exact_text || '') === span?.exact_text_sha256, 'online_span_sha256_mismatch', `${spanLocation}.exact_text_sha256`, String(spanId));
      expect(errors, Number.isInteger(span?.occurrence_index) && span.occurrence_index >= 0, 'online_span_occurrence_invalid', `${spanLocation}.occurrence_index`, String(span?.occurrence_index));
      if (canonicalBody !== null && Number.isInteger(span?.utf16_start) && Number.isInteger(span?.utf16_end)) {
        expect(errors,
          canonicalBody.slice(span.utf16_start, span.utf16_end) === span.exact_text,
          'online_span_text_mismatch', spanLocation, String(spanId));
        const positions = occurrences(canonicalBody, span.exact_text);
        expect(errors,
          positions[span.occurrence_index] === span.utf16_start,
          'online_span_occurrence_mismatch', `${spanLocation}.occurrence_index`, String(spanId));
      }
    }
    if (['official_version_identity', 'official_version_identity_with_policy_text'].includes(source.evidence_role)) {
      const expectedScope = source.evidence_role === 'official_version_identity'
        ? 'version_identity_only'
        : 'same_version_policy_text';
      expect(errors, source.witness_scope === expectedScope, 'version_identity_scope_invalid', `${location}.witness_scope`, sourceId);
      expect(errors, source.spans?.some((span) => span.purpose === 'version_identity'), 'version_identity_span_missing', `${location}.spans`, sourceId);
      expect(errors, EXACT_VERSION_RELATIONS.has(source.version_relation), 'version_identity_relation_invalid', `${location}.version_relation`, String(source.version_relation));
    }
    resolvedSources.set(sourceId, { raw_sha256: raw ? sha256(raw) : null, canonical_body: canonicalBody });
  }

  for (const [sourceId, source] of sourceById) {
    if (source.evidence_role !== 'integrity_only_same_artifact' || typeof source.same_artifact_as !== 'string') continue;
    const primary = sourceById.get(source.same_artifact_as);
    expect(errors, primary?.evidence_role === 'primary_artifact', 'integrity_mirror_primary_invalid', `$.online_sources[${sourceId}].same_artifact_as`, source.same_artifact_as);
    expect(errors, primary?.resource?.sha256 === source.resource?.sha256, 'integrity_mirror_sha256_not_equal', `$.online_sources[${sourceId}].resource.sha256`, sourceId);
  }
  const primaryHashSet = new Set(primaryHashes.values());
  for (const [sourceId, source] of sourceById) {
    if (source.independently_counts_for_text === true) {
      expect(errors, !primaryHashSet.has(source.resource?.sha256), 'independent_source_equals_primary_artifact', `$.online_sources[${sourceId}].resource.sha256`, sourceId);
    }
  }
  return { sourceById, spanById, resolvedSources };
}

function validateCorpus({ manifest, resourcePaths, errors }) {
  const corpus = manifest.corpus || {};
  expect(errors, typeof corpus.resource_id === 'string', 'corpus_resource_id_missing', '$.corpus.resource_id', 'required');
  expect(errors, typeof corpus.manifest_resource_id === 'string', 'corpus_manifest_resource_id_missing', '$.corpus.manifest_resource_id', 'required');
  expect(errors, /^corpus-[a-f0-9]{24}$/.test(corpus.release_id || ''), 'corpus_release_id_invalid', '$.corpus.release_id', String(corpus.release_id));
  expect(errors, SHA256.test(corpus.release_fingerprint_sha256 || ''), 'corpus_fingerprint_invalid', '$.corpus.release_fingerprint_sha256', String(corpus.release_fingerprint_sha256));
  expect(errors, SHA256.test(corpus.manifest_sha256 || ''), 'corpus_manifest_sha256_invalid', '$.corpus.manifest_sha256', String(corpus.manifest_sha256));
  const manifestRaw = safeResource(resourcePaths, corpus.manifest_resource_id, errors, '$.corpus.manifest_resource_id');
  let corpusManifest = null;
  if (manifestRaw) {
    expect(errors, sha256(manifestRaw) === corpus.manifest_sha256, 'corpus_manifest_sha256_mismatch', '$.corpus.manifest_sha256', corpus.manifest_resource_id);
    try {
      corpusManifest = JSON.parse(manifestRaw.toString('utf8'));
      expect(errors, corpusManifest.release_id === corpus.release_id, 'corpus_manifest_release_mismatch', '$.corpus.release_id', String(corpusManifest.release_id));
      expect(errors, corpusManifest.release_fingerprint_sha256 === corpus.release_fingerprint_sha256, 'corpus_manifest_fingerprint_mismatch', '$.corpus.release_fingerprint_sha256', String(corpusManifest.release_fingerprint_sha256));
    } catch (error) {
      addError(errors, 'corpus_manifest_json_invalid', '$.corpus.manifest_resource_id', error.message);
    }
  }
  const databasePath = resourcePaths?.[corpus.resource_id];
  const databaseRaw = safeResource(resourcePaths, corpus.resource_id, errors, '$.corpus.resource_id');
  let database = null;
  if (databaseRaw && typeof databasePath === 'string') {
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
      if (corpusManifest) {
        const counts = {
          documents: database.prepare('SELECT COUNT(*) AS count FROM documents').get().count,
          paragraphs: database.prepare('SELECT COUNT(*) AS count FROM paragraphs').get().count,
          page_publication_gates: database.prepare('SELECT COUNT(*) AS count FROM page_publication_gates').get().count,
        };
        for (const [key, actual] of Object.entries(counts)) {
          expect(errors, actual === corpusManifest[key], 'corpus_table_count_mismatch', `$.corpus.${key}`, `${actual} != ${corpusManifest[key]}`);
        }
      }
    } catch (error) {
      addError(errors, 'corpus_database_open_failed', '$.corpus.resource_id', error.message);
      database?.close();
      database = null;
    }
  }
  return { database, corpusManifest };
}

function validateDocuments({ manifest, database, sourceById, errors }) {
  const documentById = uniqueMap(manifest.documents, 'document_id', errors, '$.documents');
  const roles = manifest.documents?.map((item) => item.role).sort() || [];
  expect(errors, JSON.stringify(roles) === JSON.stringify(['from', 'to']), 'document_roles_invalid', '$.documents', roles.join(','));
  if (!database) return documentById;
  const statement = database.prepare(`
    SELECT d.id,d.title,d.subject,d.stage,d.document_type,d.version_label,d.issued_by,d.sort_year,
           d.checksum_sha256,d.text_quality_status,d.citation_allowed,d.corpus_release_id,
           dc.taxonomy_entity_kind,dc.canonical_subject,dc.display_facet
    FROM documents d
    LEFT JOIN document_classifications dc ON dc.document_id=d.id
    WHERE d.id=?
  `);
  for (const [documentId, expected] of documentById) {
    const location = `$.documents[${documentId}]`;
    const row = statement.get(documentId);
    if (!row) {
      addError(errors, 'corpus_document_missing', location, documentId);
      continue;
    }
    for (const key of ['title', 'subject', 'stage', 'document_type', 'version_label', 'issued_by', 'sort_year']) {
      expect(errors, row[key] === expected[key], 'corpus_document_field_mismatch', `${location}.${key}`, `${row[key]} != ${expected[key]}`);
    }
    expect(errors, row.checksum_sha256 === expected.source_artifact_sha256, 'corpus_document_artifact_mismatch', `${location}.source_artifact_sha256`, String(row.checksum_sha256));
    expect(errors, row.corpus_release_id === manifest.corpus.release_id, 'corpus_document_release_mismatch', location, String(row.corpus_release_id));
    expect(errors, row.text_quality_status === 'official_native_text', 'corpus_document_text_quality_not_official', location, String(row.text_quality_status));
    expect(errors, Number(row.citation_allowed) === 1, 'corpus_document_citation_closed', location, documentId);
    expect(errors, row.taxonomy_entity_kind === 'subject' && row.canonical_subject === '语文' && row.display_facet === '语文', 'corpus_document_taxonomy_mismatch', location, documentId);
    const primary = sourceById.get(expected.primary_source_id);
    expect(errors, primary?.evidence_role === 'primary_artifact', 'document_primary_source_invalid', `${location}.primary_source_id`, String(expected.primary_source_id));
    expect(errors, primary?.resource?.sha256 === expected.source_artifact_sha256, 'document_primary_source_hash_mismatch', `${location}.primary_source_id`, String(expected.primary_source_id));
    const identity = sourceById.get(expected.version_identity_source_id);
    expect(errors, ['official_version_identity', 'official_version_identity_with_policy_text'].includes(identity?.evidence_role), 'document_version_identity_source_invalid', `${location}.version_identity_source_id`, String(expected.version_identity_source_id));
  }
  return documentById;
}

function validateEvidence({ manifest, database, documentById, sourceById, spanById, resourcePaths, errors }) {
  const evidenceById = uniqueMap(manifest.evidence, 'evidence_id', errors, '$.evidence');
  const evidenceResults = new Map();
  if (!database) return { evidenceById, evidenceResults };
  const paragraphStatement = database.prepare(`
    SELECT id,document_id,ordinal,page_number,body,body_sha256,display_allowed,citation_allowed,
           source_artifact_sha256,page_final_text_sha256,provenance_locator,corpus_release_id
    FROM paragraphs WHERE id=?
  `);
  const pageStatement = database.prepare(`
    SELECT document_id,page_number,source_artifact_sha256,final_text_sha256,stable_locator,
           publication_basis,review_status,display_allowed,citation_allowed,corpus_release_id
    FROM page_publication_gates WHERE document_id=? AND page_number=?
  `);
  for (const [evidenceId, evidence] of evidenceById) {
    const location = `$.evidence[${evidenceId}]`;
    const document = documentById.get(evidence.document_id);
    expect(errors, Boolean(document), 'evidence_document_missing', `${location}.document_id`, String(evidence.document_id));
    expect(errors, Number.isInteger(evidence.paragraph_id), 'evidence_paragraph_id_invalid', `${location}.paragraph_id`, String(evidence.paragraph_id));
    expect(errors, Number.isInteger(evidence.paragraph_ordinal) && evidence.paragraph_ordinal >= 0, 'evidence_paragraph_ordinal_invalid', `${location}.paragraph_ordinal`, String(evidence.paragraph_ordinal));
    expect(errors, Number.isInteger(evidence.physical_pdf_page) && evidence.physical_pdf_page > 0, 'evidence_page_invalid', `${location}.physical_pdf_page`, String(evidence.physical_pdf_page));
    expect(errors, SHA256.test(evidence.paragraph_body_sha256 || ''), 'evidence_body_sha256_invalid', `${location}.paragraph_body_sha256`, String(evidence.paragraph_body_sha256));
    expect(errors, SHA256.test(evidence.exact_text_sha256 || ''), 'evidence_span_sha256_invalid', `${location}.exact_text_sha256`, String(evidence.exact_text_sha256));
    expect(errors, sha256(evidence.exact_text || '') === evidence.exact_text_sha256, 'evidence_span_sha256_mismatch', `${location}.exact_text_sha256`, evidenceId);
    expect(errors, Number.isInteger(evidence.utf16_start) && evidence.utf16_start >= 0, 'evidence_span_start_invalid', `${location}.utf16_start`, String(evidence.utf16_start));
    expect(errors, Number.isInteger(evidence.utf16_end) && evidence.utf16_end > evidence.utf16_start, 'evidence_span_end_invalid', `${location}.utf16_end`, String(evidence.utf16_end));
    expect(errors, Array.isArray(evidence.online_witness_span_ids) && evidence.online_witness_span_ids.length > 0, 'evidence_missing_independent_online_witness', `${location}.online_witness_span_ids`, evidenceId);
    expect(errors, Array.isArray(evidence.online_conflict_span_ids), 'evidence_online_conflicts_not_array', `${location}.online_conflict_span_ids`, evidenceId);
    expect(errors, isObject(evidence.page_image), 'evidence_page_image_missing', `${location}.page_image`, evidenceId);
    expect(errors, SHA256.test(evidence.page_image?.sha256 || ''), 'evidence_page_image_sha256_invalid', `${location}.page_image.sha256`, evidenceId);
    expect(errors, evidence.page_image?.rendered_from_source_artifact_sha256 === evidence.source_artifact_sha256, 'evidence_page_image_source_mismatch', `${location}.page_image.rendered_from_source_artifact_sha256`, evidenceId);
    expect(errors, typeof evidence.page_image?.renderer === 'string' && evidence.page_image.renderer.length > 0, 'evidence_page_image_renderer_missing', `${location}.page_image.renderer`, evidenceId);
    expect(errors, Number.isInteger(evidence.page_image?.dpi) && evidence.page_image.dpi >= 200, 'evidence_page_image_dpi_too_low', `${location}.page_image.dpi`, String(evidence.page_image?.dpi));
    const pageImage = safeResource(resourcePaths, evidence.page_image?.resource_id, errors, `${location}.page_image.resource_id`);
    if (pageImage && SHA256.test(evidence.page_image?.sha256 || '')) {
      expect(errors, sha256(pageImage) === evidence.page_image.sha256, 'evidence_page_image_sha256_mismatch', `${location}.page_image.sha256`, evidenceId);
    }
    expect(errors, evidence.visual_review?.status === 'machine_assisted_visual_match', 'evidence_visual_review_status_invalid', `${location}.visual_review.status`, String(evidence.visual_review?.status));
    expect(errors, typeof evidence.visual_review?.reviewed_by === 'string' && evidence.visual_review.reviewed_by.length > 0, 'evidence_visual_reviewer_missing', `${location}.visual_review.reviewed_by`, evidenceId);
    expect(errors, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(evidence.visual_review?.reviewed_at || ''), 'evidence_visual_review_time_invalid', `${location}.visual_review.reviewed_at`, String(evidence.visual_review?.reviewed_at));
    expect(errors, typeof evidence.visual_review?.note === 'string' && evidence.visual_review.note.length > 0, 'evidence_visual_review_note_missing', `${location}.visual_review.note`, evidenceId);
    const row = paragraphStatement.get(evidence.paragraph_id);
    if (!row) {
      addError(errors, 'corpus_paragraph_missing', `${location}.paragraph_id`, String(evidence.paragraph_id));
      continue;
    }
    expect(errors, row.document_id === evidence.document_id, 'paragraph_document_mismatch', location, evidenceId);
    expect(errors, Number(row.ordinal) === evidence.paragraph_ordinal, 'paragraph_ordinal_mismatch', location, evidenceId);
    expect(errors, Number(row.page_number) === evidence.physical_pdf_page, 'paragraph_page_mismatch', location, evidenceId);
    expect(errors, sha256(row.body) === evidence.paragraph_body_sha256, 'paragraph_body_sha256_mismatch', location, evidenceId);
    expect(errors, row.body_sha256 === evidence.paragraph_body_sha256, 'paragraph_stored_body_sha256_mismatch', location, evidenceId);
    expect(errors, row.body.slice(evidence.utf16_start, evidence.utf16_end) === evidence.exact_text, 'paragraph_span_text_mismatch', location, evidenceId);
    expect(errors, row.source_artifact_sha256 === evidence.source_artifact_sha256, 'paragraph_artifact_sha256_mismatch', location, evidenceId);
    expect(errors, row.page_final_text_sha256 === evidence.page_final_text_sha256, 'paragraph_page_text_sha256_mismatch', location, evidenceId);
    expect(errors, row.corpus_release_id === manifest.corpus.release_id, 'paragraph_release_mismatch', location, evidenceId);
    expect(errors, Number(row.display_allowed) === 1 && Number(row.citation_allowed) === 1, 'paragraph_publication_gate_closed', location, evidenceId);
    const page = pageStatement.get(evidence.document_id, evidence.physical_pdf_page);
    if (!page) {
      addError(errors, 'page_publication_missing', location, evidenceId);
      continue;
    }
    expect(errors, page.source_artifact_sha256 === evidence.source_artifact_sha256, 'page_publication_artifact_mismatch', location, evidenceId);
    expect(errors, page.final_text_sha256 === evidence.page_final_text_sha256, 'page_publication_text_sha256_mismatch', location, evidenceId);
    expect(errors, page.stable_locator === evidence.page_publication_stable_locator, 'page_publication_locator_mismatch', location, evidenceId);
    expect(errors, page.publication_basis === 'official_native_text' && page.review_status === 'official_native_text', 'page_publication_review_invalid', location, evidenceId);
    expect(errors, Number(page.display_allowed) === 1 && Number(page.citation_allowed) === 1, 'page_publication_gate_closed', location, evidenceId);
    expect(errors, page.corpus_release_id === manifest.corpus.release_id, 'page_publication_release_mismatch', location, evidenceId);

    let independentWitnesses = 0;
    let exactDocumentWitnesses = 0;
    for (const spanId of evidence.online_witness_span_ids || []) {
      const binding = spanById.get(spanId);
      if (!binding) {
        addError(errors, 'evidence_online_witness_span_missing', `${location}.online_witness_span_ids`, spanId);
        continue;
      }
      expect(errors, binding.span.purpose === 'exact_text_witness', 'evidence_online_witness_purpose_invalid', `${location}.online_witness_span_ids`, spanId);
      expect(errors, binding.span.exact_text === evidence.exact_text, 'evidence_online_witness_text_mismatch', `${location}.online_witness_span_ids`, spanId);
      expect(errors, binding.source.independently_counts_for_text === true, 'evidence_online_witness_not_independent', `${location}.online_witness_span_ids`, spanId);
      if (binding.source.independently_counts_for_text === true && binding.span.exact_text === evidence.exact_text) {
        independentWitnesses += 1;
        if (binding.source.witness_scope === 'exact_document_text') exactDocumentWitnesses += 1;
      }
    }
    if ((evidence.online_witness_span_ids || []).length > 0) {
      expect(errors, independentWitnesses > 0, 'evidence_missing_independent_online_witness', `${location}.online_witness_span_ids`, evidenceId);
    }
    for (const spanId of evidence.online_conflict_span_ids || []) {
      const binding = spanById.get(spanId);
      expect(errors, Boolean(binding), 'evidence_online_conflict_span_missing', `${location}.online_conflict_span_ids`, spanId);
      if (!binding) continue;
      expect(errors, binding.span.purpose === 'transcription_conflict', 'evidence_online_conflict_purpose_invalid', `${location}.online_conflict_span_ids`, spanId);
      expect(errors, binding.span.exact_text !== evidence.exact_text, 'evidence_online_conflict_not_conflicting', `${location}.online_conflict_span_ids`, spanId);
    }
    evidenceResults.set(evidenceId, {
      resolved: true,
      independent_witness_count: independentWitnesses,
      exact_document_witness_count: exactDocumentWitnesses,
    });
  }
  return { evidenceById, evidenceResults };
}

function validateConflicts({ manifest, evidenceById, spanById, errors }) {
  const conflictById = uniqueMap(manifest.conflicts, 'conflict_id', errors, '$.conflicts');
  for (const [conflictId, conflict] of conflictById) {
    const location = `$.conflicts[${conflictId}]`;
    const evidence = evidenceById.get(conflict.evidence_id);
    expect(errors, Boolean(evidence), 'conflict_evidence_missing', `${location}.evidence_id`, String(conflict.evidence_id));
    expect(errors, conflict.status === 'unresolved_fail_closed', 'conflict_status_invalid', `${location}.status`, String(conflict.status));
    expect(errors, typeof conflict.note === 'string' && conflict.note.length > 0, 'conflict_note_missing', `${location}.note`, 'required');
    expect(errors, Array.isArray(conflict.source_span_ids) && conflict.source_span_ids.length > 0, 'conflict_spans_missing', `${location}.source_span_ids`, 'required');
    for (const spanId of conflict.source_span_ids || []) {
      const binding = spanById.get(spanId);
      expect(errors, Boolean(binding), 'conflict_span_missing', `${location}.source_span_ids`, spanId);
      if (binding && evidence) {
        expect(errors, binding.span.purpose === 'transcription_conflict', 'conflict_span_purpose_invalid', `${location}.source_span_ids`, spanId);
        expect(errors, binding.span.exact_text !== evidence.exact_text, 'conflict_span_text_not_different', `${location}.source_span_ids`, spanId);
        expect(errors, evidence.online_conflict_span_ids.includes(spanId), 'conflict_span_not_bound_to_evidence', `${location}.source_span_ids`, spanId);
      }
    }
  }
  return conflictById;
}

function validateAssertions({ manifest, documentById, sourceById, evidenceById, evidenceResults, conflictById, errors }) {
  const assertionById = uniqueMap(manifest.assertions, 'assertion_id', errors, '$.assertions');
  const results = [];
  for (const [assertionId, assertion] of assertionById) {
    const location = `$.assertions[${assertionId}]`;
    expect(errors, documentById.has(assertion.from_document_id), 'assertion_from_document_missing', `${location}.from_document_id`, String(assertion.from_document_id));
    expect(errors, documentById.has(assertion.to_document_id), 'assertion_to_document_missing', `${location}.to_document_id`, String(assertion.to_document_id));
    expect(errors, Array.isArray(assertion.from_evidence_ids) && assertion.from_evidence_ids.length > 0, 'assertion_from_evidence_missing', `${location}.from_evidence_ids`, 'required');
    expect(errors, Array.isArray(assertion.to_evidence_ids) && assertion.to_evidence_ids.length > 0, 'assertion_to_evidence_missing', `${location}.to_evidence_ids`, 'required');
    const evidenceIds = [...(assertion.from_evidence_ids || []), ...(assertion.to_evidence_ids || [])];
    for (const id of evidenceIds) expect(errors, evidenceById.has(id), 'assertion_evidence_missing', location, id);
    for (const id of assertion.from_evidence_ids || []) expect(errors, evidenceById.get(id)?.document_id === assertion.from_document_id, 'assertion_from_evidence_document_mismatch', location, id);
    for (const id of assertion.to_evidence_ids || []) expect(errors, evidenceById.get(id)?.document_id === assertion.to_document_id, 'assertion_to_evidence_document_mismatch', location, id);
    expect(errors, Array.isArray(assertion.version_identity_source_ids) && assertion.version_identity_source_ids.length === 2, 'assertion_version_identity_pair_invalid', `${location}.version_identity_source_ids`, 'exactly two required');
    for (const id of assertion.version_identity_source_ids || []) expect(errors, ['official_version_identity', 'official_version_identity_with_policy_text'].includes(sourceById.get(id)?.evidence_role), 'assertion_version_identity_source_invalid', location, id);
    expect(errors, Array.isArray(assertion.unresolved_conflict_ids), 'assertion_conflicts_not_array', `${location}.unresolved_conflict_ids`, 'required array');
    for (const id of assertion.unresolved_conflict_ids || []) expect(errors, conflictById.has(id), 'assertion_conflict_missing', location, id);
    expect(errors, SHA256.test(assertion.evidence_bundle_sha256 || ''), 'assertion_bundle_sha256_invalid', `${location}.evidence_bundle_sha256`, String(assertion.evidence_bundle_sha256));
    expect(errors,
      sha256(canonicalJson(assertionBundle(assertion, evidenceById))) === assertion.evidence_bundle_sha256,
      'assertion_bundle_sha256_mismatch', `${location}.evidence_bundle_sha256`, assertionId);
    const expectedSemanticStatuses = [
      'exact-source-supported',
      ...((assertion.unresolved_conflict_ids || []).length > 0 ? ['online-version-conflict'] : []),
      'editor-review-pending',
    ];
    expect(errors,
      Array.isArray(assertion.semantic_statuses)
        && assertion.semantic_statuses.every((status) => SEMANTIC_STATUS_VALUES.has(status))
        && new Set(assertion.semantic_statuses).size === assertion.semantic_statuses.length,
      'assertion_semantic_statuses_invalid', `${location}.semantic_statuses`, JSON.stringify(assertion.semantic_statuses));
    expect(errors,
      JSON.stringify(assertion.semantic_statuses) === JSON.stringify(expectedSemanticStatuses),
      'assertion_semantic_statuses_mismatch', `${location}.semantic_statuses`, `expected ${JSON.stringify(expectedSemanticStatuses)}`);
    expect(errors, exactKeys(assertion.publication, PUBLICATION_KEYS), 'assertion_publication_shape_invalid', `${location}.publication`, assertionId);
    for (const key of PUBLICATION_KEYS) expect(errors, assertion.publication?.[key] === false, 'assertion_publication_not_fail_closed', `${location}.publication.${key}`, assertionId);
    expect(errors, assertion.review?.status === 'pending_signed_editor_review', 'unsupported_review_state', `${location}.review.status`, String(assertion.review?.status));
    expect(errors, assertion.review?.reviewer_id === null && assertion.review?.decision_resource_id === null, 'unsigned_review_has_identity', `${location}.review`, assertionId);
    expect(errors, typeof assertion.review?.uncertainty_note === 'string' && assertion.review.uncertainty_note.length > 0, 'review_uncertainty_note_missing', `${location}.review.uncertainty_note`, assertionId);

    const expectedGateBlockers = expectedSemanticStatuses.filter((status) => status !== 'exact-source-supported');
    expect(errors,
      exactKeys(assertion.release_gate, ['allowed', 'blocked_by_statuses']),
      'assertion_release_gate_shape_invalid', `${location}.release_gate`, assertionId);
    expect(errors, assertion.release_gate?.allowed === false,
      'assertion_release_gate_open', `${location}.release_gate.allowed`, assertionId);
    expect(errors,
      JSON.stringify(assertion.release_gate?.blocked_by_statuses) === JSON.stringify(expectedGateBlockers),
      'assertion_release_gate_blockers_mismatch', `${location}.release_gate.blocked_by_statuses`,
      `expected ${JSON.stringify(expectedGateBlockers)}`);

    const blockers = [];
    const allEvidenceResolved = evidenceIds.every((id) => evidenceResults.get(id)?.resolved === true);
    const exactDocumentWitnessesComplete = evidenceIds.every((id) => evidenceResults.get(id)?.exact_document_witness_count > 0);
    if (!allEvidenceResolved) blockers.push('evidence_resolution_incomplete');
    if (!exactDocumentWitnessesComplete) blockers.push('independent_exact_document_witness_missing');
    if ((assertion.unresolved_conflict_ids || []).length > 0) blockers.unshift('unresolved_transcription_conflict');
    blockers.push('pending_signed_editor_review');
    results.push({
      assertion_id: assertionId,
      evidence_ids: evidenceIds,
      evidence_bundle_sha256: assertion.evidence_bundle_sha256,
      semantic_statuses: assertion.semantic_statuses,
      release_gate: assertion.release_gate,
      research_evidence_ready: allEvidenceResolved
        && exactDocumentWitnessesComplete
        && assertion.unresolved_conflict_ids.length === 0,
      publication_eligible: false,
      blockers,
    });
  }
  return results;
}

export function validateResearchEvidenceSlice({ manifest, resourcePaths }) {
  const errors = [];
  validateManifestBoundary(manifest, errors);
  if (!isObject(manifest)) {
    return { valid: false, evidence_integrity_valid: false, errors, assertions: [] };
  }
  const online = validateOnlineSources({ manifest, resourcePaths, errors });
  const corpus = validateCorpus({ manifest, resourcePaths, errors });
  const documentById = validateDocuments({
    manifest,
    database: corpus.database,
    sourceById: online.sourceById,
    errors,
  });
  const evidence = validateEvidence({
    manifest,
    database: corpus.database,
    documentById,
    sourceById: online.sourceById,
    spanById: online.spanById,
    resourcePaths,
    errors,
  });
  const conflictById = validateConflicts({
    manifest,
    evidenceById: evidence.evidenceById,
    spanById: online.spanById,
    errors,
  });
  const assertions = validateAssertions({
    manifest,
    documentById,
    sourceById: online.sourceById,
    evidenceById: evidence.evidenceById,
    evidenceResults: evidence.evidenceResults,
    conflictById,
    errors,
  });
  corpus.database?.close();
  return {
    valid: errors.length === 0,
    evidence_integrity_valid: errors.length === 0,
    errors,
    slice_id: manifest.slice_id,
    corpus_release_id: manifest.corpus?.release_id ?? null,
    assertions,
  };
}

export function projectResearchEvidenceSlice({ manifest, validation }) {
  if (!validation?.evidence_integrity_valid || validation.errors?.length) {
    throw new Error('research evidence integrity validation failed; projection is forbidden');
  }
  const evidenceById = new Map(manifest.evidence.map((item) => [item.evidence_id, item]));
  const assertionBindings = validation.assertions.map((result) => {
    const assertion = manifest.assertions.find((item) => item.assertion_id === result.assertion_id);
    return {
      assertion_id: result.assertion_id,
      evidence_ids: result.evidence_ids,
      evidence_bundle_sha256: result.evidence_bundle_sha256,
      semantic_statuses: result.semantic_statuses,
      release_gate: result.release_gate,
      claim: assertion.claim,
      dimension: assertion.dimension,
      from_document_id: assertion.from_document_id,
      to_document_id: assertion.to_document_id,
      research_evidence_ready: result.research_evidence_ready,
      publication_eligible: false,
      blockers: result.blockers,
    };
  });
  const binding = (item, fields) => ({
    assertion_id: item.assertion_id,
    evidence_ids: item.evidence_ids,
    evidence_bundle_sha256: item.evidence_bundle_sha256,
    release_gate: item.release_gate,
    ...fields,
  });
  const projection = {
    schema_version: 1,
    policy: 'shared_assertion_evidence_identity_fail_closed_projection_v1',
    slice_id: manifest.slice_id,
    corpus_release_id: manifest.corpus.release_id,
    source_manifest_sha256: sha256(canonicalJson(manifest)),
    publication_state: 'fail_closed_pending_signed_editor_review',
    assertions: assertionBindings,
    evidence: manifest.evidence.map((item) => ({
      evidence_id: item.evidence_id,
      document_id: item.document_id,
      paragraph_id: item.paragraph_id,
      paragraph_ordinal: item.paragraph_ordinal,
      physical_pdf_page: item.physical_pdf_page,
      utf16_start: item.utf16_start,
      utf16_end: item.utf16_end,
      exact_text: item.exact_text,
      exact_text_sha256: item.exact_text_sha256,
      paragraph_body_sha256: item.paragraph_body_sha256,
      page_publication_stable_locator: item.page_publication_stable_locator,
    })),
    consumer_bindings: {
      compare: assertionBindings.map((item) => binding(item, {
        public_display_allowed: item.release_gate.allowed,
        label: '研究线索（待签名编辑复核）',
      })),
      reader_search: assertionBindings.map((item) => binding(item, {
        public_display_allowed: item.release_gate.allowed,
        anchors: item.evidence_ids.map((id) => {
          const evidence = evidenceById.get(id);
          return {
            evidence_id: id,
            document_id: evidence.document_id,
            paragraph_id: evidence.paragraph_id,
            utf16_start: evidence.utf16_start,
            utf16_end: evidence.utf16_end,
          };
        }),
      })),
      star: assertionBindings.map((item) => binding(item, {
        public_display_allowed: item.release_gate.allowed,
        relation_status: 'candidate_research_observation',
      })),
      ai: assertionBindings.map((item) => binding(item, {
        citation_allowed: item.release_gate.allowed,
        retrieval_allowed: false,
      })),
      discussion: assertionBindings.map((item) => binding(item, {
        target_type: 'research_assertion',
        target_id: item.assertion_id,
        claim_citation_allowed: item.release_gate.allowed,
      })),
    },
  };
  return { ...projection, projection_sha256: sha256(canonicalJson(projection)) };
}
