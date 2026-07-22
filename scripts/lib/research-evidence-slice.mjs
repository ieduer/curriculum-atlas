import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

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
export const DEFAULT_RESEARCH_EVIDENCE_SCHEMA = JSON.parse(readFileSync(
  new URL('../../data/research-evidence/research-evidence-slice.schema.json', import.meta.url),
  'utf8',
));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
}

export function canonicalJson(value) {
  return JSON.stringify(sorted(value));
}

function strictUtf8(raw) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return null;
  }
}

function isPdfBytes(raw) {
  return Buffer.isBuffer(raw)
    && raw.length >= 12
    && raw.subarray(0, 5).toString('ascii') === '%PDF-'
    && raw.subarray(Math.max(0, raw.length - 1024)).includes(Buffer.from('%%EOF'));
}

function isPngBytes(raw) {
  return Buffer.isBuffer(raw)
    && raw.length >= 33
    && raw.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    && raw.subarray(12, 16).toString('ascii') === 'IHDR';
}

function strictHtml(raw) {
  const decoded = strictUtf8(raw);
  if (decoded === null || /\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f]/u.test(decoded)) return null;
  const trimmed = decoded.replace(/^\ufeff/u, '').trim();
  if (!/^(?:<!doctype\s+html\b[^>]*>\s*)?<html\b[^>]*>/iu.test(trimmed)
      || !/<\/html\s*>\s*$/iu.test(trimmed)) return null;
  return decoded;
}

function normalizedHttpsUrl(value) {
  if (typeof value !== 'string' || value !== value.trim()
    || /[\u0000-\u0020\u007f\\]/u.test(value) || value.includes('#')) return null;
  const rawAuthority = value.match(/^https:\/\/([^/?#]*)/iu)?.[1];
  if (rawAuthority === undefined || rawAuthority.includes('@')) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) return null;
    parsed.hostname = parsed.hostname.toLowerCase().replace(/\.$/u, '');
    parsed.pathname = parsed.pathname.replace(/%([0-9a-f]{2})/giu, (encoded, hexadecimal) => {
      const character = String.fromCharCode(Number.parseInt(hexadecimal, 16));
      return /^[A-Za-z0-9._~-]$/u.test(character) ? character : `%${hexadecimal.toUpperCase()}`;
    });
    const sortedSearch = [...parsed.searchParams.entries()]
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
        leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
      ));
    parsed.search = '';
    for (const [key, entryValue] of sortedSearch) parsed.searchParams.append(key, entryValue);
    return parsed.href;
  } catch {
    return null;
  }
}

function workIdentity(document) {
  return {
    role: document.role,
    document_id: document.document_id,
    title: document.title,
    version_label: document.version_label,
    sort_year: document.sort_year,
    issued_by: document.issued_by,
    subject: document.subject,
    stage: document.stage,
    document_type: document.document_type,
    source_artifact_sha256: document.source_artifact_sha256,
    primary_source_id: document.primary_source_id,
    version_identity_source_id: document.version_identity_source_id,
  };
}

function sourceContract(source) {
  return {
    source_id: source.source_id,
    title: source.title,
    publisher: source.publisher,
    url: source.url,
    authority_class: source.authority_class,
    evidence_role: source.evidence_role,
    version_relation: source.version_relation,
    independently_counts_for_text: source.independently_counts_for_text,
    witness_scope: source.witness_scope,
    same_artifact_as: source.same_artifact_as,
    document_binding: source.document_binding,
    resource: source.resource,
    canonical_text_sha256: source.canonical_text_sha256,
    spans: source.spans,
  };
}

function validateSourceRegistry(manifest, registry, errors) {
  const documents = Array.isArray(registry?.documents) ? registry.documents : [];
  const sources = Array.isArray(registry?.sources) ? registry.sources : [];
  const evidenceIds = Array.isArray(registry?.evidence_ids) ? registry.evidence_ids : [];
  const assertionIds = Array.isArray(registry?.assertion_ids) ? registry.assertion_ids : [];
  const shapeValid = exactKeys(registry, [
    'schema_version', 'policy', 'slice_id', 'research_corpus_rowset_sha256',
    'documents', 'sources', 'evidence_ids', 'assertion_ids',
  ])
    && SHA256.test(registry?.research_corpus_rowset_sha256 || '')
    && Array.isArray(registry?.documents)
    && documents.every((entry) => exactKeys(entry, ['document_id', 'work_identity_sha256'])
      && ID.test(entry.document_id || '') && SHA256.test(entry.work_identity_sha256 || ''))
    && new Set(documents.map((entry) => entry.document_id)).size === documents.length
    && Array.isArray(registry?.sources)
    && sources.every((entry) => exactKeys(entry, ['source_id', 'source_contract_sha256'])
      && ID.test(entry.source_id || '') && SHA256.test(entry.source_contract_sha256 || ''))
    && new Set(sources.map((entry) => entry.source_id)).size === sources.length
    && Array.isArray(registry?.evidence_ids)
    && evidenceIds.every((id) => ID.test(id || ''))
    && new Set(evidenceIds).size === evidenceIds.length
    && Array.isArray(registry?.assertion_ids)
    && assertionIds.every((id) => ID.test(id || ''))
    && new Set(assertionIds).size === assertionIds.length;
  if (!shapeValid
      || registry.schema_version !== 1
      || registry.policy !== 'git_pinned_research_source_registry_v1'
      || registry.slice_id !== manifest.slice_id) {
    addError(errors, 'source_registry_invalid', '$registry', 'exact Git-pinned source registry required');
    return;
  }
  const expectedDocuments = new Map(documents.map((entry) => [entry.document_id, entry]));
  const expectedSources = new Map(sources.map((entry) => [entry.source_id, entry]));
  expect(errors,
    JSON.stringify((manifest.documents || []).map((entry) => entry.document_id))
      === JSON.stringify(documents.map((entry) => entry.document_id)),
    'source_registry_document_scope_mismatch', '$.documents', 'document scope differs from Git-pinned registry');
  expect(errors,
    JSON.stringify((manifest.online_sources || []).map((entry) => entry.source_id))
      === JSON.stringify(sources.map((entry) => entry.source_id)),
    'source_registry_source_scope_mismatch', '$.online_sources', 'source scope differs from Git-pinned registry');
  expect(errors,
    JSON.stringify((manifest.evidence || []).map((entry) => entry.evidence_id))
      === JSON.stringify(evidenceIds),
    'source_registry_evidence_scope_mismatch', '$.evidence', 'evidence scope differs from Git-pinned registry');
  expect(errors,
    JSON.stringify((manifest.assertions || []).map((entry) => entry.assertion_id))
      === JSON.stringify(assertionIds),
    'source_registry_assertion_scope_mismatch', '$.assertions', 'assertion scope differs from Git-pinned registry');
  for (const document of manifest.documents || []) {
    expect(errors,
      expectedDocuments.get(document.document_id)?.work_identity_sha256
        === sha256(canonicalJson(workIdentity(document))),
      'work_version_identity_registry_mismatch', `$.documents[${document.document_id}]`, document.document_id);
  }
  for (const source of manifest.online_sources || []) {
    expect(errors,
      expectedSources.get(source.source_id)?.source_contract_sha256
        === sha256(canonicalJson(sourceContract(source))),
      'source_contract_registry_mismatch', `$.online_sources[${source.source_id}]`, source.source_id);
  }
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

function schemaLocation(instancePath = '') {
  if (!instancePath) return '$';
  return `$${instancePath.replace(/\/([0-9]+)/g, '[$1]').replace(/\/([^/[]+)/g, '.$1')}`;
}

function validateJsonSchema(manifest, schema, errors) {
  try {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    if (validate(manifest)) return;
    for (const error of validate.errors || []) {
      addError(
        errors,
        `json_schema_${error.keyword}`,
        schemaLocation(error.instancePath),
        `${error.message || 'schema validation failed'} ${JSON.stringify(error.params || {})}`,
      );
    }
  } catch (error) {
    addError(errors, 'json_schema_definition_invalid', '$schema', error.message);
  }
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

function assertionBundle(assertion, evidenceById, requiredConflictIds) {
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
    unresolved_conflict_ids: requiredConflictIds,
  };
}

export function researchCorpusRowsetSha256(database, manifest) {
  const documentIds = [...new Set((manifest.documents || []).map((item) => item.document_id))].sort();
  const paragraphIds = [...new Set((manifest.evidence || []).map((item) => item.paragraph_id))]
    .filter(Number.isInteger).sort((left, right) => left - right);
  const pageKeys = new Set((manifest.evidence || [])
    .map((item) => `${item.document_id}\u0000${item.physical_pdf_page}`));
  const placeholders = (items) => items.map(() => '?').join(',');
  const documentColumns = [
    'id', 'title', 'subject', 'stage', 'document_type', 'version_label', 'issued_by',
    'sort_year', 'checksum_sha256', 'text_quality_status', 'citation_allowed', 'corpus_release_id',
  ];
  const classificationColumns = [
    'document_id', 'taxonomy_entity_kind', 'canonical_subject', 'display_facet',
  ];
  const paragraphColumns = [
    'id', 'document_id', 'ordinal', 'page_number', 'body', 'body_sha256', 'display_allowed',
    'citation_allowed', 'source_artifact_sha256', 'page_final_text_sha256',
    'provenance_locator', 'corpus_release_id',
  ];
  const pageGateColumns = [
    'document_id', 'page_number', 'source_artifact_sha256', 'final_text_sha256',
    'stable_locator', 'publication_basis', 'review_status', 'display_allowed',
    'citation_allowed', 'corpus_release_id',
  ];
  const rows = {
    documents: documentIds.length
      ? database.prepare(`SELECT ${documentColumns.join(',')} FROM documents WHERE id IN (${placeholders(documentIds)}) ORDER BY id`).all(...documentIds)
      : [],
    document_classifications: documentIds.length
      ? database.prepare(`SELECT ${classificationColumns.join(',')} FROM document_classifications WHERE document_id IN (${placeholders(documentIds)}) ORDER BY document_id`).all(...documentIds)
      : [],
    paragraphs: paragraphIds.length
      ? database.prepare(`SELECT ${paragraphColumns.join(',')} FROM paragraphs WHERE id IN (${placeholders(paragraphIds)}) ORDER BY id`).all(...paragraphIds)
      : [],
    page_publication_gates: documentIds.length
      ? database.prepare(`SELECT ${pageGateColumns.join(',')} FROM page_publication_gates WHERE document_id IN (${placeholders(documentIds)}) ORDER BY document_id,page_number`).all(...documentIds)
        .filter((item) => pageKeys.has(`${item.document_id}\u0000${item.page_number}`))
      : [],
  };
  return sha256(canonicalJson(rows));
}

export function buildResearchSourceRegistry(manifest, database) {
  return {
    schema_version: 1,
    policy: 'git_pinned_research_source_registry_v1',
    slice_id: manifest.slice_id,
    research_corpus_rowset_sha256: researchCorpusRowsetSha256(database, manifest),
    documents: manifest.documents.map((document) => ({
      document_id: document.document_id,
      work_identity_sha256: sha256(canonicalJson(workIdentity(document))),
    })),
    sources: manifest.online_sources.map((source) => ({
      source_id: source.source_id,
      source_contract_sha256: sha256(canonicalJson(sourceContract(source))),
    })),
    evidence_ids: manifest.evidence.map((item) => item.evidence_id),
    assertion_ids: manifest.assertions.map((item) => item.assertion_id),
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

function validateOnlineSources({ manifest, documentById, resourcePaths, errors }) {
  const sourceById = uniqueMap(manifest.online_sources, 'source_id', errors, '$.online_sources');
  const spanById = new Map();
  const primaryHashes = new Map();
  const resolvedSources = new Map();
  const sourceBindingValid = new Map();
  const invalidIndependentSourceIds = new Set();
  const independentRawHashes = new Map();
  const independentCanonicalHashes = new Map();
  const independentUrls = new Map();
  const resourceIds = new Map();
  const semanticSpanKeys = new Map();

  const registerUnique = (index, key, sourceId, code, location) => {
    if (!key) return;
    const previous = index.get(key);
    if (previous) {
      addError(errors, code, location, `${sourceId} duplicates ${previous}`);
      invalidIndependentSourceIds.add(previous);
      invalidIndependentSourceIds.add(sourceId);
      return;
    }
    index.set(key, sourceId);
  };

  for (const [sourceId, source] of sourceById) {
    const location = `$.online_sources[${sourceId}]`;
    expect(errors, SOURCE_ROLES.has(source.evidence_role), 'source_role_invalid', `${location}.evidence_role`, String(source.evidence_role));
    expect(errors, WITNESS_SCOPES.has(source.witness_scope), 'witness_scope_invalid', `${location}.witness_scope`, String(source.witness_scope));
    const normalizedUrl = normalizedHttpsUrl(source.url);
    expect(errors, Boolean(normalizedUrl), 'source_url_invalid', `${location}.url`, String(source.url));
    expect(errors, isObject(source.resource) && ID.test(source.resource?.resource_id || ''), 'source_resource_invalid', `${location}.resource`, 'resource_id required');
    expect(errors, SHA256.test(source.resource?.sha256 || ''), 'source_sha256_invalid', `${location}.resource.sha256`, String(source.resource?.sha256));
    expect(errors, Array.isArray(source.spans), 'source_spans_not_array', `${location}.spans`, 'required array');
    expect(errors, Array.isArray(source.limitations) && source.limitations.length > 0, 'source_limitations_missing', `${location}.limitations`, 'at least one limitation required');
    registerUnique(
      resourceIds,
      source.resource?.resource_id,
      sourceId,
      'duplicate_source_resource_id',
      `${location}.resource.resource_id`,
    );

    const binding = source.document_binding;
    const document = documentById.get(binding?.document_id);
    const bindingShapeValid = exactKeys(binding, [
      'document_id',
      'version_label',
      'source_artifact_sha256',
      'version_identity_source_id',
    ]);
    const bindingValid = bindingShapeValid
      && Boolean(document)
      && binding.version_label === document.version_label
      && binding.source_artifact_sha256 === document.source_artifact_sha256
      && binding.version_identity_source_id === document.version_identity_source_id;
    expect(errors, bindingShapeValid, 'source_document_binding_shape_invalid', `${location}.document_binding`, sourceId);
    expect(errors, Boolean(document), 'source_document_binding_document_missing', `${location}.document_binding.document_id`, String(binding?.document_id));
    expect(errors, !document || binding?.version_label === document.version_label, 'source_document_binding_version_mismatch', `${location}.document_binding.version_label`, sourceId);
    expect(errors, !document || binding?.source_artifact_sha256 === document.source_artifact_sha256, 'source_document_binding_artifact_mismatch', `${location}.document_binding.source_artifact_sha256`, sourceId);
    expect(errors, !document || binding?.version_identity_source_id === document.version_identity_source_id, 'source_document_binding_identity_mismatch', `${location}.document_binding.version_identity_source_id`, sourceId);
    sourceBindingValid.set(sourceId, bindingValid);

    const raw = safeResource(resourcePaths, source.resource?.resource_id, errors, `${location}.resource`);
    let resourceBytesVerified = false;
    if (raw && SHA256.test(source.resource?.sha256 || '')) {
      resourceBytesVerified = sha256(raw) === source.resource.sha256;
      expect(errors, resourceBytesVerified, 'source_resource_sha256_mismatch', `${location}.resource.sha256`, sourceId);
    }

    if (source.resource?.media_type === 'application/pdf' && raw) {
      expect(errors, isPdfBytes(raw), 'pdf_resource_magic_invalid', `${location}.resource.media_type`, sourceId);
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
      expect(errors, bindingValid, 'independent_source_document_binding_invalid', `${location}.document_binding`, sourceId);
      expect(errors, source.resource?.media_type === 'text/html',
        'independent_text_media_type_invalid', `${location}.resource.media_type`, String(source.resource?.media_type));
    }

    let canonicalBody = null;
    let canonicalBodyVerified = false;
    if (source.resource?.media_type === 'text/html' && raw) {
      const html = strictHtml(raw);
      expect(errors, html !== null, 'html_resource_structure_invalid', `${location}.resource.media_type`, sourceId);
      if (html !== null) canonicalBody = canonicalizeHtmlText(html);
      const canonicalHashValid = SHA256.test(source.canonical_text_sha256 || '');
      const canonicalHashMatches = canonicalHashValid
        && canonicalBody !== null
        && sha256(canonicalBody) === source.canonical_text_sha256;
      expect(errors, canonicalHashValid, 'online_body_sha256_invalid', `${location}.canonical_text_sha256`, sourceId);
      expect(errors, canonicalHashMatches, 'online_body_sha256_mismatch', `${location}.canonical_text_sha256`, sourceId);
      canonicalBodyVerified = resourceBytesVerified && canonicalHashMatches;
    } else {
      expect(errors, source.canonical_text_sha256 === null, 'binary_source_has_canonical_text_sha256', `${location}.canonical_text_sha256`, sourceId);
    }
    if (source.independently_counts_for_text === true) {
      expect(errors, canonicalBodyVerified, 'independent_text_body_unverified', `${location}.resource`, sourceId);
      if (!canonicalBodyVerified || source.resource?.media_type !== 'text/html') {
        invalidIndependentSourceIds.add(sourceId);
      }
    }

    if (source.independently_counts_for_text === true) {
      registerUnique(
        independentRawHashes,
        source.resource?.sha256,
        sourceId,
        'duplicate_independent_snapshot_bytes',
        `${location}.resource.sha256`,
      );
      registerUnique(
        independentCanonicalHashes,
        source.canonical_text_sha256,
        sourceId,
        'duplicate_independent_canonical_text',
        `${location}.canonical_text_sha256`,
      );
      registerUnique(
        independentUrls,
        normalizedUrl,
        sourceId,
        'duplicate_independent_source_url',
        `${location}.url`,
      );
    }

    for (const [index, span] of (source.spans || []).entries()) {
      const spanLocation = `${location}.spans[${index}]`;
      const spanId = span?.span_id;
      expect(errors, typeof spanId === 'string' && ID.test(spanId), 'online_span_id_invalid', `${spanLocation}.span_id`, String(spanId));
      if (spanById.has(spanId)) addError(errors, 'duplicate_online_span_id', `${spanLocation}.span_id`, spanId);
      else spanById.set(spanId, { source, span });
      expect(errors, ['version_identity', 'exact_text_witness', 'transcription_conflict'].includes(span?.purpose), 'online_span_purpose_invalid', `${spanLocation}.purpose`, String(span?.purpose));
      expect(errors,
        span?.purpose === 'version_identity' ? span?.evidence_id === null : typeof span?.evidence_id === 'string',
        'online_span_evidence_binding_invalid', `${spanLocation}.evidence_id`, String(span?.evidence_id));
      expect(errors, Number.isInteger(span?.utf16_start) && span.utf16_start >= 0, 'online_span_start_invalid', `${spanLocation}.utf16_start`, String(span?.utf16_start));
      expect(errors, Number.isInteger(span?.utf16_end) && span.utf16_end > span.utf16_start, 'online_span_end_invalid', `${spanLocation}.utf16_end`, String(span?.utf16_end));
      expect(errors, typeof span?.exact_text === 'string' && span.exact_text.length > 0, 'online_span_text_missing', `${spanLocation}.exact_text`, 'required');
      expect(errors, sha256(span?.exact_text || '') === span?.exact_text_sha256, 'online_span_sha256_mismatch', `${spanLocation}.exact_text_sha256`, String(spanId));
      expect(errors, Number.isInteger(span?.occurrence_index) && span.occurrence_index >= 0, 'online_span_occurrence_invalid', `${spanLocation}.occurrence_index`, String(span?.occurrence_index));
      const semanticKey = canonicalJson({
        source_id: sourceId,
        document_id: source.document_binding?.document_id ?? null,
        source_artifact_sha256: source.document_binding?.source_artifact_sha256 ?? null,
        utf16_start: span?.utf16_start ?? null,
        utf16_end: span?.utf16_end ?? null,
        exact_text_sha256: span?.exact_text_sha256 ?? null,
      });
      const previousSemanticSpan = semanticSpanKeys.get(semanticKey);
      expect(errors, !previousSemanticSpan, 'duplicate_semantic_online_span', spanLocation,
        previousSemanticSpan ? `${spanId} aliases ${previousSemanticSpan}` : String(spanId));
      if (!previousSemanticSpan) semanticSpanKeys.set(semanticKey, spanId);
      const spanBodyVerified = canonicalBodyVerified
        && Number.isInteger(span?.utf16_start)
        && Number.isInteger(span?.utf16_end)
        && canonicalBody.slice(span.utf16_start, span.utf16_end) === span.exact_text
        && occurrences(canonicalBody, span.exact_text)[span.occurrence_index] === span.utf16_start;
      if (canonicalBody !== null && Number.isInteger(span?.utf16_start) && Number.isInteger(span?.utf16_end)) {
        expect(errors,
          canonicalBody.slice(span.utf16_start, span.utf16_end) === span.exact_text,
          'online_span_text_mismatch', spanLocation, String(spanId));
        const positions = occurrences(canonicalBody, span.exact_text);
        expect(errors,
          positions[span.occurrence_index] === span.utf16_start,
          'online_span_occurrence_mismatch', `${spanLocation}.occurrence_index`, String(spanId));
      }
      if (source.independently_counts_for_text === true && !spanBodyVerified) {
        invalidIndependentSourceIds.add(sourceId);
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
    resolvedSources.set(sourceId, {
      raw: resourceBytesVerified ? Buffer.from(raw) : null,
      raw_sha256: raw ? sha256(raw) : null,
      canonical_body: canonicalBody,
    });
  }

  for (const [sourceId, source] of sourceById) {
    const identitySource = sourceById.get(source.document_binding?.version_identity_source_id);
    expect(errors,
      ['official_version_identity', 'official_version_identity_with_policy_text'].includes(identitySource?.evidence_role),
      'source_document_binding_identity_source_invalid',
      `$.online_sources[${sourceId}].document_binding.version_identity_source_id`,
      String(source.document_binding?.version_identity_source_id));
    if (['official_version_identity', 'official_version_identity_with_policy_text'].includes(source.evidence_role)) {
      expect(errors,
        source.document_binding?.version_identity_source_id === sourceId,
        'version_identity_source_not_self_bound',
        `$.online_sources[${sourceId}].document_binding.version_identity_source_id`,
        sourceId);
    }
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
  return {
    sourceById,
    spanById,
    resolvedSources,
    sourceBindingValid,
    invalidIndependentSourceIds,
  };
}

function validateCorpus({ manifest, resourcePaths, sourceRegistry, errors }) {
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
      expect(errors,
        SHA256.test(sourceRegistry?.research_corpus_rowset_sha256 || '')
          && researchCorpusRowsetSha256(database, manifest) === sourceRegistry.research_corpus_rowset_sha256,
        'corpus_research_rowset_registry_mismatch', '$.corpus.resource_id',
        'research rows differ from the Git-pinned registry');
    } catch (error) {
      addError(errors, 'corpus_database_open_failed', '$.corpus.resource_id', error.message);
      database?.close();
      database = null;
    }
  }
  return { database, corpusManifest };
}

function validateDocuments({ manifest, documentById, database, sourceById, errors }) {
  const roles = manifest.documents?.map((item) => item.role).sort() || [];
  expect(errors, JSON.stringify(roles) === JSON.stringify(['from', 'to']), 'document_roles_invalid', '$.documents', roles.join(','));
  const fromDocument = manifest.documents?.find((item) => item.role === 'from');
  const toDocument = manifest.documents?.find((item) => item.role === 'to');
  expect(errors,
    Number.isSafeInteger(fromDocument?.sort_year)
      && Number.isSafeInteger(toDocument?.sort_year)
      && fromDocument.sort_year < toDocument.sort_year,
    'document_chronology_invalid', '$.documents',
    `${String(fromDocument?.sort_year)} !< ${String(toDocument?.sort_year)}`);
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
    expect(errors, primary?.document_binding?.document_id === documentId, 'document_primary_source_binding_mismatch', `${location}.primary_source_id`, String(expected.primary_source_id));
    const identity = sourceById.get(expected.version_identity_source_id);
    expect(errors, ['official_version_identity', 'official_version_identity_with_policy_text'].includes(identity?.evidence_role), 'document_version_identity_source_invalid', `${location}.version_identity_source_id`, String(expected.version_identity_source_id));
    expect(errors, identity?.document_binding?.document_id === documentId, 'document_version_identity_binding_mismatch', `${location}.version_identity_source_id`, String(expected.version_identity_source_id));
  }
  return documentById;
}

function validateEvidence({
  manifest,
  database,
  documentById,
  sourceById,
  spanById,
  sourceBindingValid,
  invalidIndependentSourceIds,
  resolvedSources,
  resourcePaths,
  renderPageImage,
  errors,
}) {
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
    expect(errors, evidence.page_image?.media_type === 'image/png', 'evidence_page_image_media_type_invalid', `${location}.page_image.media_type`, String(evidence.page_image?.media_type));
    expect(errors, SHA256.test(evidence.page_image?.sha256 || ''), 'evidence_page_image_sha256_invalid', `${location}.page_image.sha256`, evidenceId);
    expect(errors, evidence.page_image?.rendered_from_source_artifact_sha256 === evidence.source_artifact_sha256, 'evidence_page_image_source_mismatch', `${location}.page_image.rendered_from_source_artifact_sha256`, evidenceId);
    const renderer = evidence.page_image?.renderer;
    expect(errors,
      exactKeys(renderer, ['name', 'version', 'sha256', 'command_contract', 'execution_binding']),
      'evidence_page_image_renderer_identity_invalid', `${location}.page_image.renderer`, evidenceId);
    expect(errors, renderer?.name === 'pdftoppm', 'evidence_page_image_renderer_name_invalid', `${location}.page_image.renderer.name`, String(renderer?.name));
    expect(errors, /^pdftoppm version [0-9]+\.[0-9]+\.[0-9]+$/u.test(renderer?.version || ''), 'evidence_page_image_renderer_version_invalid', `${location}.page_image.renderer.version`, String(renderer?.version));
    expect(errors, SHA256.test(renderer?.sha256 || ''), 'evidence_page_image_renderer_sha256_invalid', `${location}.page_image.renderer.sha256`, String(renderer?.sha256));
    expect(errors, renderer?.command_contract === 'pdftoppm_png_single_page_v1', 'evidence_page_image_renderer_command_invalid', `${location}.page_image.renderer.command_contract`, String(renderer?.command_contract));
    expect(errors, renderer?.execution_binding === 'verified_private_read_only_copy_v1', 'evidence_page_image_renderer_execution_binding_invalid', `${location}.page_image.renderer.execution_binding`, String(renderer?.execution_binding));
    expect(errors, evidence.page_image?.dpi === 240, 'evidence_page_image_dpi_invalid', `${location}.page_image.dpi`, String(evidence.page_image?.dpi));
    const pageImage = safeResource(resourcePaths, evidence.page_image?.resource_id, errors, `${location}.page_image.resource_id`);
    if (pageImage && SHA256.test(evidence.page_image?.sha256 || '')) {
      expect(errors, sha256(pageImage) === evidence.page_image.sha256, 'evidence_page_image_sha256_mismatch', `${location}.page_image.sha256`, evidenceId);
      expect(errors, isPngBytes(pageImage), 'evidence_page_image_magic_invalid', `${location}.page_image.media_type`, evidenceId);
      const primarySource = sourceById.get(document?.primary_source_id);
      const pdfBytes = resolvedSources.get(primarySource?.source_id)?.raw;
      if (typeof renderPageImage !== 'function') {
        addError(errors, 'evidence_page_renderer_unavailable', `${location}.page_image`, evidenceId);
      } else if (!Buffer.isBuffer(pdfBytes)) {
        addError(errors, 'evidence_page_source_pdf_missing', `${location}.page_image`, evidenceId);
      } else {
        try {
          const rendered = renderPageImage({
            pdfBytes: Buffer.from(pdfBytes),
            page: evidence.physical_pdf_page,
            dpi: evidence.page_image.dpi,
            document,
            evidence,
          });
          expect(errors, Buffer.isBuffer(rendered), 'evidence_page_render_invalid', `${location}.page_image`, evidenceId);
          if (Buffer.isBuffer(rendered)) {
            expect(errors, isPngBytes(rendered), 'evidence_page_render_magic_invalid', `${location}.page_image`, evidenceId);
            expect(errors, rendered.equals(pageImage), 'evidence_page_render_mismatch', `${location}.page_image`, evidenceId);
          }
        } catch (error) {
          addError(errors, 'evidence_page_render_failed', `${location}.page_image`, `${evidenceId}: ${error.message}`);
        }
      }
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
      expect(errors, binding.span.evidence_id === evidenceId, 'evidence_online_witness_id_binding_mismatch', `${location}.online_witness_span_ids`, spanId);
      expect(errors, binding.span.exact_text === evidence.exact_text, 'evidence_online_witness_text_mismatch', `${location}.online_witness_span_ids`, spanId);
      expect(errors, binding.source.independently_counts_for_text === true, 'evidence_online_witness_not_independent', `${location}.online_witness_span_ids`, spanId);
      const bindingMatchesEvidence = sourceBindingValid.get(binding.source.source_id) === true
        && binding.source.document_binding.document_id === evidence.document_id
        && binding.source.document_binding.version_label === document?.version_label
        && binding.source.document_binding.source_artifact_sha256 === evidence.source_artifact_sha256
        && binding.source.document_binding.version_identity_source_id === document?.version_identity_source_id;
      expect(errors, bindingMatchesEvidence, 'evidence_online_witness_document_binding_mismatch', `${location}.online_witness_span_ids`, spanId);
      const independentValid = binding.source.independently_counts_for_text === true
        && !invalidIndependentSourceIds.has(binding.source.source_id)
        && bindingMatchesEvidence;
      if (independentValid && binding.span.exact_text === evidence.exact_text) {
        independentWitnesses += 1;
        if (binding.source.witness_scope === 'exact_document_text'
          && binding.source.version_relation === 'exact_document_exact_edition') {
          exactDocumentWitnesses += 1;
        }
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
      expect(errors, binding.span.evidence_id === evidenceId, 'evidence_online_conflict_id_binding_mismatch', `${location}.online_conflict_span_ids`, spanId);
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
  const conflictIdsByEvidenceId = new Map();
  const conflictIdsBySpanId = new Map();
  for (const [conflictId, conflict] of conflictById) {
    const location = `$.conflicts[${conflictId}]`;
    const evidence = evidenceById.get(conflict.evidence_id);
    expect(errors, Boolean(evidence), 'conflict_evidence_missing', `${location}.evidence_id`, String(conflict.evidence_id));
    expect(errors, conflict.status === 'unresolved_fail_closed', 'conflict_status_invalid', `${location}.status`, String(conflict.status));
    expect(errors, typeof conflict.note === 'string' && conflict.note.length > 0, 'conflict_note_missing', `${location}.note`, 'required');
    expect(errors, Array.isArray(conflict.source_span_ids) && conflict.source_span_ids.length > 0, 'conflict_spans_missing', `${location}.source_span_ids`, 'required');
    if (evidence) {
      const ids = conflictIdsByEvidenceId.get(evidence.evidence_id) || [];
      ids.push(conflictId);
      conflictIdsByEvidenceId.set(evidence.evidence_id, ids);
    }
    for (const spanId of conflict.source_span_ids || []) {
      const spanConflictIds = conflictIdsBySpanId.get(spanId) || [];
      spanConflictIds.push(conflictId);
      conflictIdsBySpanId.set(spanId, spanConflictIds);
      const binding = spanById.get(spanId);
      expect(errors, Boolean(binding), 'conflict_span_missing', `${location}.source_span_ids`, spanId);
      if (binding && evidence) {
        expect(errors, binding.span.purpose === 'transcription_conflict', 'conflict_span_purpose_invalid', `${location}.source_span_ids`, spanId);
        expect(errors, binding.span.exact_text !== evidence.exact_text, 'conflict_span_text_not_different', `${location}.source_span_ids`, spanId);
        expect(errors, evidence.online_conflict_span_ids.includes(spanId), 'conflict_span_not_bound_to_evidence', `${location}.source_span_ids`, spanId);
      }
    }
  }
  for (const [evidenceId, evidence] of evidenceById) {
    for (const spanId of evidence.online_conflict_span_ids || []) {
      const conflictIds = conflictIdsBySpanId.get(spanId) || [];
      expect(errors, conflictIds.length === 1, 'evidence_conflict_span_coverage_invalid', `$.evidence[${evidenceId}].online_conflict_span_ids`, `${spanId} is covered by ${conflictIds.length} conflicts`);
      if (conflictIds.length === 1) {
        expect(errors, conflictById.get(conflictIds[0])?.evidence_id === evidenceId, 'evidence_conflict_span_wrong_evidence', `$.evidence[${evidenceId}].online_conflict_span_ids`, spanId);
      }
    }
  }
  for (const [spanId, binding] of spanById) {
    if (binding.span.purpose === 'version_identity') continue;
    const boundEvidence = evidenceById.get(binding.span.evidence_id);
    expect(errors, Boolean(boundEvidence), 'online_span_bound_evidence_missing',
      `$.online_sources[${binding.source.source_id}].spans[${spanId}]`, String(binding.span.evidence_id));
    if (boundEvidence) {
      expect(errors,
        binding.source.document_binding?.document_id === boundEvidence.document_id
          && binding.source.document_binding?.source_artifact_sha256 === boundEvidence.source_artifact_sha256,
        'online_span_document_artifact_binding_mismatch',
        `$.online_sources[${binding.source.source_id}].spans[${spanId}]`, spanId);
    }
    if (binding.span.purpose === 'exact_text_witness') {
      const witnessReferences = [...evidenceById.values()]
        .flatMap((item) => item.online_witness_span_ids || [])
        .filter((candidate) => candidate === spanId).length;
      expect(errors, witnessReferences === 1, 'exact_text_witness_coverage_invalid',
        `$.online_sources[${binding.source.source_id}].spans[${spanId}]`,
        `${spanId} is referenced ${witnessReferences} times`);
      expect(errors, binding.span.exact_text === boundEvidence?.exact_text,
        'exact_text_witness_bound_text_mismatch',
        `$.online_sources[${binding.source.source_id}].spans[${spanId}]`, spanId);
      continue;
    }
    if (binding.span.purpose !== 'transcription_conflict') continue;
    const conflictIds = conflictIdsBySpanId.get(spanId) || [];
    expect(errors, conflictIds.length === 1,
      'transcription_conflict_span_coverage_invalid',
      `$.online_sources[${binding.source.source_id}].spans[${spanId}]`,
      `${spanId} is covered by ${conflictIds.length} conflicts`);
    if (conflictIds.length !== 1) continue;
    const conflict = conflictById.get(conflictIds[0]);
    const evidence = evidenceById.get(conflict?.evidence_id);
    const evidenceSpanCount = (evidence?.online_conflict_span_ids || [])
      .filter((candidate) => candidate === spanId).length;
    expect(errors, evidenceSpanCount === 1,
      'transcription_conflict_evidence_binding_invalid',
      `$.conflicts[${conflictIds[0]}].source_span_ids`,
      `${spanId} is bound ${evidenceSpanCount} times by evidence ${String(conflict?.evidence_id)}`);
    expect(errors,
      binding.source.document_binding?.document_id === evidence?.document_id
        && binding.source.document_binding?.version_label
          === manifest.documents.find((item) => item.document_id === evidence?.document_id)?.version_label
        && binding.source.document_binding?.source_artifact_sha256 === evidence?.source_artifact_sha256
        && binding.span.evidence_id === evidence?.evidence_id,
      'transcription_conflict_document_binding_mismatch',
      `$.conflicts[${conflictIds[0]}].source_span_ids`,
      spanId);
  }
  for (const ids of conflictIdsByEvidenceId.values()) ids.sort();
  return { conflictById, conflictIdsByEvidenceId };
}

function validateAssertions({
  manifest,
  documentById,
  sourceById,
  evidenceById,
  evidenceResults,
  conflictById,
  conflictIdsByEvidenceId,
  errors,
}) {
  const assertionById = uniqueMap(manifest.assertions, 'assertion_id', errors, '$.assertions');
  const results = [];
  for (const [assertionId, assertion] of assertionById) {
    const location = `$.assertions[${assertionId}]`;
    expect(errors, documentById.has(assertion.from_document_id), 'assertion_from_document_missing', `${location}.from_document_id`, String(assertion.from_document_id));
    expect(errors, documentById.has(assertion.to_document_id), 'assertion_to_document_missing', `${location}.to_document_id`, String(assertion.to_document_id));
    expect(errors, documentById.get(assertion.from_document_id)?.role === 'from', 'assertion_from_document_role_invalid', `${location}.from_document_id`, String(assertion.from_document_id));
    expect(errors, documentById.get(assertion.to_document_id)?.role === 'to', 'assertion_to_document_role_invalid', `${location}.to_document_id`, String(assertion.to_document_id));
    expect(errors, Array.isArray(assertion.from_evidence_ids) && assertion.from_evidence_ids.length > 0, 'assertion_from_evidence_missing', `${location}.from_evidence_ids`, 'required');
    expect(errors, Array.isArray(assertion.to_evidence_ids) && assertion.to_evidence_ids.length > 0, 'assertion_to_evidence_missing', `${location}.to_evidence_ids`, 'required');
    const evidenceIds = [...(assertion.from_evidence_ids || []), ...(assertion.to_evidence_ids || [])];
    const requiredConflictIds = [...new Set(evidenceIds.flatMap((id) => conflictIdsByEvidenceId.get(id) || []))].sort();
    for (const id of evidenceIds) expect(errors, evidenceById.has(id), 'assertion_evidence_missing', location, id);
    for (const id of assertion.from_evidence_ids || []) expect(errors, evidenceById.get(id)?.document_id === assertion.from_document_id, 'assertion_from_evidence_document_mismatch', location, id);
    for (const id of assertion.to_evidence_ids || []) expect(errors, evidenceById.get(id)?.document_id === assertion.to_document_id, 'assertion_to_evidence_document_mismatch', location, id);
    expect(errors, Array.isArray(assertion.version_identity_source_ids) && assertion.version_identity_source_ids.length === 2, 'assertion_version_identity_pair_invalid', `${location}.version_identity_source_ids`, 'exactly two required');
    for (const id of assertion.version_identity_source_ids || []) expect(errors, ['official_version_identity', 'official_version_identity_with_policy_text'].includes(sourceById.get(id)?.evidence_role), 'assertion_version_identity_source_invalid', location, id);
    const expectedIdentitySourceIds = [
      documentById.get(assertion.from_document_id)?.version_identity_source_id,
      documentById.get(assertion.to_document_id)?.version_identity_source_id,
    ];
    expect(errors,
      JSON.stringify(assertion.version_identity_source_ids) === JSON.stringify(expectedIdentitySourceIds),
      'assertion_version_identity_binding_mismatch', `${location}.version_identity_source_ids`,
      `expected ${JSON.stringify(expectedIdentitySourceIds)}`);
    expect(errors, Array.isArray(assertion.unresolved_conflict_ids), 'assertion_conflicts_not_array', `${location}.unresolved_conflict_ids`, 'required array');
    for (const id of assertion.unresolved_conflict_ids || []) expect(errors, conflictById.has(id), 'assertion_conflict_missing', location, id);
    expect(errors,
      JSON.stringify(assertion.unresolved_conflict_ids) === JSON.stringify(requiredConflictIds),
      'assertion_required_conflicts_mismatch', `${location}.unresolved_conflict_ids`,
      `expected ${JSON.stringify(requiredConflictIds)}`);
    expect(errors, SHA256.test(assertion.evidence_bundle_sha256 || ''), 'assertion_bundle_sha256_invalid', `${location}.evidence_bundle_sha256`, String(assertion.evidence_bundle_sha256));
    expect(errors,
      sha256(canonicalJson(assertionBundle(assertion, evidenceById, requiredConflictIds))) === assertion.evidence_bundle_sha256,
      'assertion_bundle_sha256_mismatch', `${location}.evidence_bundle_sha256`, assertionId);
    const expectedSemanticStatuses = [
      'exact-source-supported',
      ...(requiredConflictIds.length > 0 ? ['online-version-conflict'] : []),
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
    if (requiredConflictIds.length > 0) blockers.unshift('unresolved_transcription_conflict');
    blockers.push('pending_signed_editor_review');
    results.push({
      assertion_id: assertionId,
      evidence_ids: evidenceIds,
      evidence_bundle_sha256: assertion.evidence_bundle_sha256,
      semantic_statuses: assertion.semantic_statuses,
      release_gate: assertion.release_gate,
      research_evidence_ready: allEvidenceResolved
        && exactDocumentWitnessesComplete
        && requiredConflictIds.length === 0,
      publication_eligible: false,
      blockers,
    });
  }
  return results;
}

export function validateResearchEvidenceSlice({
  manifest,
  resourcePaths,
  schema = DEFAULT_RESEARCH_EVIDENCE_SCHEMA,
  sourceRegistry,
  renderPageImage,
}) {
  const errors = [];
  validateJsonSchema(manifest, schema, errors);
  validateManifestBoundary(manifest, errors);
  if (!isObject(manifest)) {
    return { valid: false, evidence_integrity_valid: false, errors, assertions: [] };
  }
  validateSourceRegistry(manifest, sourceRegistry, errors);
  const documentById = uniqueMap(manifest.documents, 'document_id', errors, '$.documents');
  const online = validateOnlineSources({ manifest, documentById, resourcePaths, errors });
  const corpus = validateCorpus({ manifest, resourcePaths, sourceRegistry, errors });
  validateDocuments({
    manifest,
    documentById,
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
    sourceBindingValid: online.sourceBindingValid,
    invalidIndependentSourceIds: online.invalidIndependentSourceIds,
    resolvedSources: online.resolvedSources,
    resourcePaths,
    renderPageImage,
    errors,
  });
  const conflicts = validateConflicts({
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
    conflictById: conflicts.conflictById,
    conflictIdsByEvidenceId: conflicts.conflictIdsByEvidenceId,
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
