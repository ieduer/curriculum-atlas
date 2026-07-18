#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripExactTrailingPrintedPage } from './preview-ocr-page-furniture-impact.mjs';
import { validateOcrPageFurnitureApprovals } from './validate-ocr-page-furniture-approvals.mjs';
import {
  pathIsWithin,
  readPinnedRegularFileReceipt,
} from './lib/safe-local-evidence.mjs';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DOCUMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SCOPED_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
const EDITION_STATUSES = new Set([
  'exact_document_exact_edition',
  'exact_document_revision_uncertain',
  'same_work_different_edition',
  'stable_fact_only',
  'not_matched',
]);
const VERIFICATION_STATUSES = new Set([
  'verified_exact',
  'verified_stable_fact_only',
  'version_variant_reference_only',
  'conflict_requires_review',
  'human_judgment_with_warning',
  'unresolved_fail_closed',
]);
const DECISION_SCOPES = new Set(['whole_page', 'embedded_item', 'stable_fact']);
const ONLINE_AUTHORITY_CLASSES = new Set(['official', 'government', 'academic', 'university', 'library']);
const ONLINE_ARTIFACT_RELATIONS = new Set([
  'independent_transcription',
  'different_artifact_same_edition',
  'same_artifact_mirror',
  'stable_fact_reference',
  'different_edition_reference',
]);
const PAGE_TYPES = new Set(['prose', 'table', 'mixed']);
const TABLE_SOURCE_FORMATS = new Set(['html', 'markdown_pipe', 'flattened_text', 'manual_grid']);
const SNAPSHOT_SCOPES = new Set(['whole_page', 'embedded_item', 'stable_fact_excerpt', 'context_excerpt']);
const ACCEPTED_TEXT_RELATIONS = new Set([
  'normalized_exact',
  'snapshot_contains_accepted_text',
  'accepted_text_contains_snapshot',
  'structured_conflicts_resolved',
]);
const STRICT_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const REQUIRED_IDENTITY_FIELDS = [
  'title',
  'issuing_body_or_author',
  'year_or_publication_context',
  'version_label',
  'section_or_item_locator',
];

function fail(message) {
  throw new Error(`OCR triangulation audit: ${message}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function requireString(value, label, pattern = null) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string`);
  if (pattern && !pattern.test(value)) fail(`${label} has an invalid format`);
  return value;
}

function requireInteger(value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) fail(`${label} must be an integer >= ${minimum}`);
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
}

function requireIsoTimestamp(value, label) {
  requireString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) {
    fail(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return value;
}

function onlineSourceIdentityProjection(source) {
  return {
    source_id: source.source_id,
    publisher: source.publisher,
    source_type: source.source_type,
    authority_class: source.authority_class,
    authority_record_id: source.authority_record_id,
    allowed_hosts: source.allowed_hosts,
    allowed_url_prefixes: source.allowed_url_prefixes,
  };
}

function onlineSourceIdentitySha256(source) {
  return sha256(JSON.stringify(onlineSourceIdentityProjection(source)));
}

function pageTypeBindingSha256(decision, manifestSha = null) {
  return sha256([
    decision.primary_ocr_sha256,
    decision.accepted_text_sha256,
    decision.rendered_image_sha256,
    decision.page_type,
    manifestSha || '',
  ].join('\0'));
}

function tableManifestProjection(manifest) {
  return {
    schema_version: manifest.schema_version,
    source_format: manifest.source_format,
    row_count: manifest.row_count,
    column_count: manifest.column_count,
    cells: manifest.cells.map((cell) => ({
      cell_id: cell.cell_id,
      row: cell.row,
      column: cell.column,
      text: cell.text,
      text_sha256: cell.text_sha256,
    })),
  };
}

function detectTableFormats(value) {
  const text = String(value || '');
  const formats = [];
  if (/<table\b|<tr\b|<t[dh]\b/i.test(text)) formats.push('html');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const pipeLines = lines.filter((line) => (line.match(/\|/g) || []).length >= 2);
  if (pipeLines.length >= 1) formats.push('markdown_pipe');
  const flatLines = lines.filter((line) => {
    const tabs = (line.match(/\t+/g) || []).length;
    const spaces = (line.match(/ {2,}/g) || []).length;
    return tabs >= 2 || spaces >= 2;
  });
  if (flatLines.length >= 1) formats.push('flattened_text');
  return [...new Set(formats)];
}

function extractTableMatrix(value, sourceFormat) {
  const text = String(value || '');
  if (sourceFormat === 'html') {
    const rowMatches = [...text.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    const rawRows = rowMatches.length ? rowMatches.map((match) => match[1]) : [text];
    return rawRows.map((row) => (
      [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map((match) => textual(match[1]).trim())
    )).filter((row) => row.length);
  }
  if (sourceFormat === 'markdown_pipe') {
    return text.split(/\r?\n/).map((line) => {
      const trimmed = line.trim();
      if ((trimmed.match(/\|/g) || []).length < 2) return null;
      const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
      if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
      return cells;
    }).filter(Boolean);
  }
  if (sourceFormat === 'flattened_text') {
    return text.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && /\t+| {2,}/.test(line))
      .map((line) => line.split(/\t+| {2,}/).map((cell) => cell.trim()).filter(Boolean));
  }
  return null;
}

function validateOnlineSourceRegistry(input) {
  const registry = requireObject(input, 'online source registry');
  if (registry.schema_version !== 1) fail('online source registry schema_version must equal 1');
  if (registry.artifact_profile !== 'ocr-online-source-registry-v1') {
    fail('online source registry artifact_profile is invalid');
  }
  const policy = requireObject(registry.policy, 'online source registry policy');
  if (policy.authority_declared_only_here !== true
    || policy.https_only !== true
    || policy.exact_hostname_match !== true) {
    fail('online source registry policy must enforce registry-only authority and exact HTTPS hosts');
  }
  const sources = new Map();
  for (const [index, raw] of requireArray(registry.sources, 'online source registry sources').entries()) {
    const label = `online source registry sources[${index}]`;
    const source = requireObject(raw, label);
    const sourceId = requireString(source.source_id, `${label}.source_id`, SCOPED_ID_PATTERN);
    if (sources.has(sourceId)) fail(`duplicate online source registry source_id ${sourceId}`);
    requireString(source.publisher, `${label}.publisher`);
    requireString(source.source_type, `${label}.source_type`);
    if (!ONLINE_AUTHORITY_CLASSES.has(source.authority_class)) {
      fail(`${label}.authority_class is not controlled official or academic authority`);
    }
    requireString(source.authority_record_id, `${label}.authority_record_id`, SCOPED_ID_PATTERN);
    const hosts = requireArray(source.allowed_hosts, `${label}.allowed_hosts`);
    if (!hosts.length) fail(`${label}.allowed_hosts must not be empty`);
    let previous = '';
    const seenHosts = new Set();
    for (const [hostIndex, rawHost] of hosts.entries()) {
      const host = requireString(rawHost, `${label}.allowed_hosts[${hostIndex}]`).toLowerCase();
      if (host !== rawHost || host.includes('*') || host.includes('/') || host.includes(':')) {
        fail(`${label}.allowed_hosts must contain normalized exact hostnames`);
      }
      if (seenHosts.has(host) || (previous && host.localeCompare(previous, 'en') <= 0)) {
        fail(`${label}.allowed_hosts must be unique and sorted`);
      }
      seenHosts.add(host);
      previous = host;
    }
    const prefixes = requireArray(source.allowed_url_prefixes, `${label}.allowed_url_prefixes`);
    if (!prefixes.length) fail(`${label}.allowed_url_prefixes must not be empty`);
    let previousPrefix = '';
    for (const [prefixIndex, prefix] of prefixes.entries()) {
      requireString(prefix, `${label}.allowed_url_prefixes[${prefixIndex}]`);
      let parsedPrefix;
      try {
        parsedPrefix = new URL(prefix);
      } catch {
        fail(`${label}.allowed_url_prefixes[${prefixIndex}] is invalid`);
      }
      if (parsedPrefix.protocol !== 'https:'
        || parsedPrefix.username
        || parsedPrefix.password
        || parsedPrefix.port
        || parsedPrefix.search
        || parsedPrefix.hash
        || !parsedPrefix.pathname.endsWith('/')
        || parsedPrefix.href !== prefix
        || !hosts.includes(parsedPrefix.hostname.toLowerCase())) {
        fail(`${label}.allowed_url_prefixes must be normalized HTTPS locations on allowed hosts`);
      }
      if (previousPrefix && prefix.localeCompare(previousPrefix, 'en') <= 0) {
        fail(`${label}.allowed_url_prefixes must be unique and sorted`);
      }
      previousPrefix = prefix;
    }
    const declaredIdentity = requireString(
      source.source_identity_sha256,
      `${label}.source_identity_sha256`,
      SHA256_PATTERN,
    );
    if (declaredIdentity !== onlineSourceIdentitySha256(source)) {
      fail(`${sourceId} online source identity SHA-256 drifted`);
    }
    sources.set(sourceId, {
      ...source,
      allowed_hosts: [...hosts],
      allowed_url_prefixes: [...prefixes],
    });
  }
  return sources;
}

function validateTableCellManifest(decision, label) {
  const manifest = decision.table_cell_manifest;
  if (!manifest) return null;
  requireObject(manifest, `${label}.table_cell_manifest`);
  if (manifest.schema_version !== 1) fail(`${label}.table_cell_manifest.schema_version must equal 1`);
  if (!TABLE_SOURCE_FORMATS.has(manifest.source_format)) {
    fail(`${label}.table_cell_manifest.source_format is invalid`);
  }
  const rowCount = requireInteger(manifest.row_count, `${label}.table_cell_manifest.row_count`, 1);
  const columnCount = requireInteger(
    manifest.column_count,
    `${label}.table_cell_manifest.column_count`,
    1,
  );
  const cells = requireArray(manifest.cells, `${label}.table_cell_manifest.cells`);
  if (cells.length !== rowCount * columnCount) {
    fail(`${label}.table_cell_manifest must contain every row and column cell`);
  }
  const ids = new Set();
  const coordinates = new Set();
  const extracted = extractTableMatrix(decision.accepted_text, manifest.source_format);
  if (extracted) {
    if (extracted.length !== rowCount || extracted.some((row) => row.length !== columnCount)) {
      fail(`${label}.table_cell_manifest dimensions do not match accepted table structure`);
    }
  }
  let searchOffset = 0;
  const acceptedNormalized = normalized(decision.accepted_text);
  for (const [index, raw] of cells.entries()) {
    const cellLabel = `${label}.table_cell_manifest.cells[${index}]`;
    const cell = requireObject(raw, cellLabel);
    const cellId = requireString(cell.cell_id, `${cellLabel}.cell_id`, SCOPED_ID_PATTERN);
    if (ids.has(cellId)) fail(`${label}.table_cell_manifest has duplicate cell_id ${cellId}`);
    ids.add(cellId);
    const row = requireInteger(cell.row, `${cellLabel}.row`, 1);
    const column = requireInteger(cell.column, `${cellLabel}.column`, 1);
    if (row > rowCount || column > columnCount) fail(`${cellLabel} coordinate exceeds table bounds`);
    const coordinate = `${row}:${column}`;
    if (coordinates.has(coordinate)) fail(`${label}.table_cell_manifest has duplicate coordinate ${coordinate}`);
    coordinates.add(coordinate);
    const expectedRow = Math.floor(index / columnCount) + 1;
    const expectedColumn = (index % columnCount) + 1;
    if (row !== expectedRow || column !== expectedColumn) {
      fail(`${label}.table_cell_manifest cells must be in complete row-major order`);
    }
    const text = requireString(cell.text, `${cellLabel}.text`);
    if (requireString(cell.text_sha256, `${cellLabel}.text_sha256`, SHA256_PATTERN) !== sha256(text)) {
      fail(`${cellLabel} text SHA-256 drifted`);
    }
    const cellNormalized = normalized(text);
    if (extracted && cellNormalized !== normalized(extracted[row - 1][column - 1])) {
      fail(`${cellLabel} does not match the accepted table cell`);
    }
    const found = acceptedNormalized.indexOf(cellNormalized, searchOffset);
    if (!cellNormalized || found < 0) fail(`${cellLabel} is absent or out of order in accepted_text`);
    searchOffset = found + cellNormalized.length;
  }
  const manifestSha = requireString(
    manifest.manifest_sha256,
    `${label}.table_cell_manifest.manifest_sha256`,
    SHA256_PATTERN,
  );
  if (manifestSha !== sha256(JSON.stringify(tableManifestProjection(manifest)))) {
    fail(`${label}.table_cell_manifest SHA-256 drifted`);
  }
  return manifestSha;
}

function normalizeRelativeEvidencePath(value, label) {
  requireString(value, label);
  const portable = value.replaceAll('\\', '/');
  const normalizedPath = path.posix.normalize(portable);
  if (path.isAbsolute(value)
    || normalizedPath === '.'
    || normalizedPath === '..'
    || normalizedPath.startsWith('../')) {
    fail(`${label} must stay inside the decision-ledger directory`);
  }
  return normalizedPath;
}

function textual(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^[#>*+\-]+/gm, '')
    .normalize('NFKC');
}

function normalized(value) {
  return textual(value).replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '').toLocaleLowerCase('zh-CN');
}

function numbers(value) {
  return textual(value).match(/\d+(?:[.,]\d+)*/g) || [];
}

function heading(value) {
  const lines = textual(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /[\p{Script=Han}A-Za-z]/u.test(line)) || '';
}

function editDistance(left, right) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  if (left.length > right.length) [left, right] = [right, left];
  let previous = new Uint32Array(left.length + 1);
  let current = new Uint32Array(left.length + 1);
  for (let index = 0; index <= left.length; index += 1) previous[index] = index;
  for (let row = 1; row <= right.length; row += 1) {
    current[0] = row;
    const rightChar = right.charCodeAt(row - 1);
    for (let column = 1; column <= left.length; column += 1) {
      const substitution = previous[column - 1]
        + (left.charCodeAt(column - 1) === rightChar ? 0 : 1);
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        substitution,
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[left.length];
}

function sameHeading(left, right) {
  const a = normalized(left);
  const b = normalized(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function comparisonMetrics(primary, witness) {
  const primaryText = normalized(primary);
  const witnessText = normalized(witness);
  const distance = editDistance(primaryText, witnessText);
  const denominator = Math.max(1, primaryText.length, witnessText.length);
  const primaryNumbers = numbers(primary);
  const witnessNumbers = numbers(witness);
  return {
    normalized_character_agreement: Number((1 - distance / denominator).toFixed(6)),
    edit_distance: distance,
    primary_character_count: primaryText.length,
    witness_character_count: witnessText.length,
    numeric_sequence_exact: JSON.stringify(primaryNumbers) === JSON.stringify(witnessNumbers),
    primary_numbers: primaryNumbers,
    witness_numbers: witnessNumbers,
    title_exact: sameHeading(heading(primary), heading(witness)),
    primary_heading: heading(primary),
    witness_heading: heading(witness),
  };
}

function transcriptionGate({ primary, witness, witnessRecord, metrics }) {
  const criticalFields = Array.isArray(witnessRecord.critical_fields)
    ? witnessRecord.critical_fields
    : [];
  const criticalFieldsExact = criticalFields.length > 0 && criticalFields.every((field) => {
    const primaryValue = normalized(field?.primary);
    const witnessValue = normalized(field?.witness);
    return primaryValue.length > 0 && primaryValue === witnessValue;
  });
  const tableFormats = detectTableFormats(primary);
  const tableDetected = tableFormats.length > 0;
  const confidences = witnessRecord.lines
    .map((line) => Number(line.confidence))
    .filter(Number.isFinite);
  const averageVisionConfidence = confidences.length
    ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
    : 0;
  let gate = 'unresolved_fail_closed';
  if (!normalized(primary) && !normalized(witness)) {
    gate = 'blank_page_visual_confirmation_required';
  } else if (metrics.normalized_character_agreement >= 0.995
    && metrics.numeric_sequence_exact
    && metrics.title_exact
    && criticalFieldsExact
    && !tableDetected
    && averageVisionConfidence >= 0.8) {
    gate = 'automatic_witness_pass';
  } else if (metrics.normalized_character_agreement >= 0.985 && metrics.title_exact) {
    gate = 'manual_image_review_required';
  }
  return {
    gate,
    critical_fields_declared: criticalFields.length,
    critical_fields_exact: criticalFieldsExact,
    table_detected: tableDetected,
    table_formats: tableFormats,
    average_vision_confidence: Number(averageVisionConfidence.toFixed(6)),
    low_confidence_line_count: confidences.filter((value) => value < 0.8).length,
  };
}

export function validateOcrPageFurnitureActivation(activation, approvalRaw, approval) {
  const record = requireObject(activation, 'activation ledger');
  if (record.schema_version !== 1) fail('activation ledger schema_version must equal 1');
  if (record.artifact_profile !== 'ocr-page-furniture-activation-v1') {
    fail('activation ledger artifact_profile is invalid');
  }
  if (record.activation_scope !== 'audit_comparison_only') {
    fail('activation_scope must equal audit_comparison_only');
  }
  if (requireString(record.approval_ledger_sha256, 'approval_ledger_sha256', SHA256_PATTERN)
    !== sha256(approvalRaw)) {
    fail('approval ledger SHA-256 drifted');
  }
  const policy = requireObject(record.policy, 'activation policy');
  for (const [key, expected] of [
    ['raw_witness_mutation', 'forbidden'],
    ['raw_primary_mutation', 'forbidden'],
    ['gate_relaxation', 'forbidden'],
    ['publication_effect', 'none'],
  ]) {
    if (policy[key] !== expected) fail(`activation policy ${key} must equal ${expected}`);
  }
  const approvalDocuments = new Map(approval.documents.map((document) => [document.document_id, document]));
  const ruleMap = new Map();
  const seenDocuments = new Set();
  for (const [index, item] of requireArray(record.documents, 'activation documents').entries()) {
    const label = `activation documents[${index}]`;
    const document = requireObject(item, label);
    const documentId = requireString(document.document_id, `${label}.document_id`, DOCUMENT_ID_PATTERN);
    if (seenDocuments.has(documentId)) fail(`duplicate activation document ${documentId}`);
    seenDocuments.add(documentId);
    const approvedDocument = approvalDocuments.get(documentId);
    if (!approvedDocument) fail(`activation document ${documentId} is absent from approval ledger`);
    if (requireString(document.source_pdf_sha256, `${label}.source_pdf_sha256`, SHA256_PATTERN)
      !== approvedDocument.source_pdf_sha256) {
      fail(`${documentId} activation source PDF SHA-256 drifted`);
    }
    if (requireString(document.sidecar_snapshot_sha256, `${label}.sidecar_snapshot_sha256`, SHA256_PATTERN)
      !== approvedDocument.sidecar_snapshot_sha256) {
      fail(`${documentId} activation sidecar snapshot SHA-256 drifted`);
    }
    requireString(document.reviewed_by, `${label}.reviewed_by`);
    requireIsoTimestamp(document.reviewed_at, `${label}.reviewed_at`);
    const approvedRules = new Map(approvedDocument.footer_rules.map((rule) => [rule.rule_id, rule]));
    const activatedIds = requireArray(document.activated_rule_ids, `${label}.activated_rule_ids`);
    if (!activatedIds.length) fail(`${documentId} activated_rule_ids must not be empty`);
    const seenRules = new Set();
    for (const [ruleIndex, rawRuleId] of activatedIds.entries()) {
      const ruleId = requireString(rawRuleId, `${label}.activated_rule_ids[${ruleIndex}]`);
      if (seenRules.has(ruleId)) fail(`duplicate activated rule ${ruleId}`);
      seenRules.add(ruleId);
      const rule = approvedRules.get(ruleId);
      if (!rule) fail(`activated rule ${ruleId} is absent from approval ledger`);
      if (rule.eligible_for_audit_filter !== true
        || rule.removal_scope !== 'audit_comparison_only'
        || rule.approval_status !== 'approved_not_activated') {
        fail(`activated rule ${ruleId} is not eligible for comparison-only activation`);
      }
      ruleMap.set(ruleId, { ...rule, document_id: documentId });
    }
  }
  return ruleMap;
}

function validateDecisionLedger(input, registryRaw, registrySources) {
  const ledger = requireObject(input, 'decision ledger');
  if (ledger.schema_version !== 1) fail('decision ledger schema_version must equal 1');
  if (ledger.artifact_profile !== 'ocr-page-triangulation-decisions-v1') {
    fail('decision ledger artifact_profile is invalid');
  }
  const policy = requireObject(ledger.policy, 'decision policy');
  if (policy.scan_is_primary !== true) fail('decision policy scan_is_primary must be true');
  if (policy.raw_ocr_mutation !== 'forbidden') fail('decision policy raw_ocr_mutation must be forbidden');
  if (policy.search_snippet_as_evidence !== 'forbidden') {
    fail('decision policy search_snippet_as_evidence must be forbidden');
  }
  if (policy.whole_document_sampling_promotion !== 'forbidden') {
    fail('decision policy whole_document_sampling_promotion must be forbidden');
  }
  const hasOnlineEvidence = Array.isArray(ledger.decisions)
    && ledger.decisions.some((decision) => Array.isArray(decision?.online_evidence)
      && decision.online_evidence.length > 0);
  if (hasOnlineEvidence && !registryRaw) fail('online source registry is required for online evidence');
  if (registryRaw && requireString(
    policy.online_source_registry_sha256,
    'decision policy online_source_registry_sha256',
    SHA256_PATTERN,
  ) !== sha256(registryRaw)) {
    fail('online source registry SHA-256 drifted');
  }
  const seen = new Set();
  return requireArray(ledger.decisions, 'decisions').map((raw, index) => {
    const label = `decisions[${index}]`;
    const decision = requireObject(raw, label);
    const decisionId = requireString(decision.decision_id, `${label}.decision_id`);
    if (seen.has(decisionId)) fail(`duplicate decision_id ${decisionId}`);
    seen.add(decisionId);
    const documentId = requireString(decision.document_id, `${label}.document_id`, DOCUMENT_ID_PATTERN);
    const physicalPage = requireInteger(decision.physical_page, `${label}.physical_page`, 1);
    if (!DECISION_SCOPES.has(decision.decision_scope)) fail(`${decisionId} decision_scope is invalid`);
    if (decision.decision_scope === 'embedded_item') {
      if (typeof decision.embedded_item_id !== 'string'
        || !SCOPED_ID_PATTERN.test(decision.embedded_item_id)) {
        fail(`${decisionId} embedded_item_id is required`);
      }
      if (decision.stable_fact_id !== null || decision.stable_fact_span_id !== null) {
        fail(`${decisionId} embedded item must not declare stable-fact identifiers`);
      }
    } else if (decision.decision_scope === 'stable_fact') {
      if (typeof decision.stable_fact_id !== 'string'
        || !SCOPED_ID_PATTERN.test(decision.stable_fact_id)
        || typeof decision.stable_fact_span_id !== 'string'
        || !SCOPED_ID_PATTERN.test(decision.stable_fact_span_id)) {
        fail(`${decisionId} stable_fact_id and stable_fact_span_id are required`);
      }
      if (decision.embedded_item_id !== null) fail(`${decisionId} stable fact must not declare embedded_item_id`);
    } else if (decision.embedded_item_id !== null
      || decision.stable_fact_id !== null
      || decision.stable_fact_span_id !== null) {
      fail(`${decisionId} whole-page decision must not declare scoped identifiers`);
    }
    for (const field of [
      'source_pdf_sha256',
      'rendered_image_sha256',
      'primary_ocr_sha256',
      'vision_text_sha256',
      'accepted_text_sha256',
    ]) {
      requireString(decision[field], `${decisionId}.${field}`, SHA256_PATTERN);
    }
    if (typeof decision.accepted_text !== 'string' || !decision.accepted_text.trim()) {
      fail(`${decisionId}.accepted_text must be non-empty`);
    }
    if (sha256(decision.accepted_text) !== decision.accepted_text_sha256) {
      fail(`${decisionId} accepted text SHA-256 drifted`);
    }
    if (!PAGE_TYPES.has(decision.page_type)) fail(`${decisionId}.page_type is invalid`);
    const tableManifestSha = validateTableCellManifest(decision, decisionId);
    if ((decision.page_type === 'table' || decision.page_type === 'mixed') && !tableManifestSha) {
      fail(`${decisionId}.table_cell_manifest is required for table or mixed pages`);
    }
    if (decision.page_type === 'prose' && decision.table_cell_manifest !== null) {
      fail(`${decisionId}.table_cell_manifest must be null for prose pages`);
    }
    if (requireString(
      decision.page_type_binding_sha256,
      `${decisionId}.page_type_binding_sha256`,
      SHA256_PATTERN,
    ) !== pageTypeBindingSha256(decision, tableManifestSha)) {
      fail(`${decisionId} page-type binding SHA-256 drifted`);
    }
    const identity = requireObject(decision.document_identity, `${decisionId}.document_identity`);
    for (const field of REQUIRED_IDENTITY_FIELDS) {
      requireString(identity[field], `${decisionId}.document_identity.${field}`);
    }
    if (!EDITION_STATUSES.has(decision.edition_match_status)) {
      fail(`${decisionId}.edition_match_status is invalid`);
    }
    if (!VERIFICATION_STATUSES.has(decision.verification_status)) {
      fail(`${decisionId}.verification_status is invalid`);
    }
    const evidence = requireArray(decision.online_evidence, `${decisionId}.online_evidence`);
    const evidenceIds = new Set();
    for (const [evidenceIndex, rawEvidence] of evidence.entries()) {
      const evidenceLabel = `${decisionId}.online_evidence[${evidenceIndex}]`;
      const item = requireObject(rawEvidence, evidenceLabel);
      const sourceId = requireString(item.source_id, `${evidenceLabel}.source_id`);
      if (evidenceIds.has(sourceId)) fail(`${decisionId} has duplicate online source ${sourceId}`);
      evidenceIds.add(sourceId);
      for (const forbiddenField of [
        'publisher',
        'source_type',
        'authority_class',
        'authority_record_id',
        'allowed_hosts',
        'allowed_url_prefixes',
      ]) {
        if (Object.hasOwn(item, forbiddenField)) {
          fail(`${evidenceLabel} must not declare online authority field ${forbiddenField}`);
        }
      }
      const registeredSource = registrySources.get(sourceId);
      if (!registeredSource) fail(`${evidenceLabel}.source_id is absent from controlled registry`);
      if (requireString(
        item.source_identity_sha256,
        `${evidenceLabel}.source_identity_sha256`,
        SHA256_PATTERN,
      ) !== registeredSource.source_identity_sha256) {
        fail(`${evidenceLabel} online source identity SHA-256 drifted`);
      }
      const sourceUrl = requireString(item.source_url, `${evidenceLabel}.source_url`);
      let parsed;
      try {
        parsed = new URL(sourceUrl);
      } catch {
        fail(`${evidenceLabel}.source_url is invalid`);
      }
      if (parsed.protocol !== 'https:') fail(`${evidenceLabel}.source_url must use HTTPS`);
      if (parsed.username || parsed.password || parsed.port) {
        fail(`${evidenceLabel}.source_url must not contain credentials or a non-default port`);
      }
      if (!registeredSource.allowed_hosts.includes(parsed.hostname.toLowerCase())) {
        fail(`${evidenceLabel}.source_url hostname is not allowed by its registry source identity`);
      }
      if (!registeredSource.allowed_url_prefixes.some((prefix) => parsed.href.startsWith(prefix))) {
        fail(`${evidenceLabel}.source_url is outside allowed registry source locations`);
      }
      requireIsoTimestamp(item.retrieved_at, `${evidenceLabel}.retrieved_at`);
      if (!EDITION_STATUSES.has(item.version_match)) fail(`${evidenceLabel}.version_match is invalid`);
      if (!ONLINE_ARTIFACT_RELATIONS.has(item.artifact_relation)) {
        fail(`${evidenceLabel}.artifact_relation is invalid`);
      }
      requireBoolean(item.independent_for_decision, `${evidenceLabel}.independent_for_decision`);
      if (item.artifact_relation === 'same_artifact_mirror' && item.independent_for_decision) {
        fail(`${evidenceLabel} same-artifact mirror cannot be independent`);
      }
      requireString(item.section_locator, `${evidenceLabel}.section_locator`);
      item.content_path = normalizeRelativeEvidencePath(
        item.content_path,
        `${evidenceLabel}.content_path`,
      );
      requireString(item.content_sha256, `${evidenceLabel}.content_sha256`, SHA256_PATTERN);
      const snapshotIdentity = requireObject(item.snapshot_identity, `${evidenceLabel}.snapshot_identity`);
      if (!SNAPSHOT_SCOPES.has(snapshotIdentity.scope)) {
        fail(`${evidenceLabel}.snapshot_identity.scope is invalid`);
      }
      requireString(
        snapshotIdentity.locator_id,
        `${evidenceLabel}.snapshot_identity.locator_id`,
        SCOPED_ID_PATTERN,
      );
      if (decision.decision_scope === 'whole_page'
        && !['whole_page', 'context_excerpt'].includes(snapshotIdentity.scope)) {
        fail(`${evidenceLabel}.snapshot_identity.scope does not match whole-page decision`);
      }
      if (decision.decision_scope === 'embedded_item') {
        if (!['embedded_item', 'context_excerpt'].includes(snapshotIdentity.scope)) {
          fail(`${evidenceLabel}.snapshot_identity.scope does not match embedded item`);
        }
        if (snapshotIdentity.scope === 'embedded_item'
          && snapshotIdentity.locator_id !== decision.embedded_item_id) {
          fail(`${evidenceLabel}.snapshot_identity.locator_id does not match embedded_item_id`);
        }
      }
      if (decision.decision_scope === 'stable_fact') {
        if (!['stable_fact_excerpt', 'context_excerpt'].includes(snapshotIdentity.scope)) {
          fail(`${evidenceLabel}.snapshot_identity.scope does not match stable fact`);
        }
        if (snapshotIdentity.scope === 'stable_fact_excerpt'
          && snapshotIdentity.locator_id !== decision.stable_fact_span_id) {
          fail(`${evidenceLabel}.snapshot_identity.locator_id does not match stable_fact_span_id`);
        }
      }
      requireString(
        snapshotIdentity.text_sha256,
        `${evidenceLabel}.snapshot_identity.text_sha256`,
        SHA256_PATTERN,
      );
      if (!ACCEPTED_TEXT_RELATIONS.has(item.accepted_text_relation)) {
        fail(`${evidenceLabel}.accepted_text_relation is invalid`);
      }
      if (item.conflict_resolution !== null && typeof item.conflict_resolution !== 'object') {
        fail(`${evidenceLabel}.conflict_resolution must be null or an object`);
      }
      if (item.artifact_identity_receipt !== null) {
        const receipt = requireObject(
          item.artifact_identity_receipt,
          `${evidenceLabel}.artifact_identity_receipt`,
        );
        receipt.receipt_path = normalizeRelativeEvidencePath(
          receipt.receipt_path,
          `${evidenceLabel}.artifact_identity_receipt.receipt_path`,
        );
        requireString(
          receipt.receipt_sha256,
          `${evidenceLabel}.artifact_identity_receipt.receipt_sha256`,
          SHA256_PATTERN,
        );
      }
    }
    const human = requireObject(decision.human_review, `${decisionId}.human_review`);
    requireString(human.reviewed_by, `${decisionId}.human_review.reviewed_by`);
    requireIsoTimestamp(human.reviewed_at, `${decisionId}.human_review.reviewed_at`);
    for (const field of [
      'scan_checked',
      'all_engine_conflicts_resolved',
      'critical_fields_checked',
      'table_cells_checked',
    ]) requireBoolean(human[field], `${decisionId}.human_review.${field}`);
    requireString(human.resolution, `${decisionId}.human_review.resolution`);
    if (human.uncertainty_note !== null
      && (typeof human.uncertainty_note !== 'string' || !human.uncertainty_note.trim())) {
      fail(`${decisionId}.human_review.uncertainty_note must be null or non-empty`);
    }
    requireBoolean(decision.citation_allowed, `${decisionId}.citation_allowed`);
    if (decision.citation_allowed) {
      if (decision.decision_scope !== 'whole_page') {
        fail(`${decisionId} citation decision must have whole_page scope`);
      }
      if (decision.edition_match_status !== 'exact_document_exact_edition') {
        fail(`${decisionId} citation decision requires exact document and edition`);
      }
      if (decision.verification_status !== 'verified_exact') {
        fail(`${decisionId} citation decision requires verified_exact status`);
      }
      if (human.scan_checked !== true) fail('citation decision requires scan_checked=true');
      if (human.all_engine_conflicts_resolved !== true) {
        fail('citation decision requires all_engine_conflicts_resolved=true');
      }
      if (human.critical_fields_checked !== true) {
        fail('citation decision requires critical_fields_checked=true');
      }
      if (human.uncertainty_note !== null) fail(`${decisionId} citation decision cannot retain uncertainty`);
    }
    if (decision.verification_status === 'human_judgment_with_warning'
      && !human.uncertainty_note) {
      fail(`${decisionId} warning decision requires uncertainty_note`);
    }
    return { ...decision, document_id: documentId, physical_page: physicalPage };
  });
}

function validateStructuredConflictResolution(decision, evidence, snapshotNormalized, acceptedNormalized) {
  const label = `${decision.decision_id}/${evidence.source_id}`;
  const conflict = requireObject(
    evidence.conflict_resolution,
    `${label}.conflict_resolution`,
  );
  if (conflict.schema_version !== 1) fail(`${label}.conflict_resolution.schema_version must equal 1`);
  requireString(conflict.resolution_id, `${label}.conflict_resolution.resolution_id`, SCOPED_ID_PATTERN);
  if (conflict.comparison_algorithm !== 'nfkc-han-alnum-v1') {
    fail(`${label}.conflict_resolution.comparison_algorithm is invalid`);
  }
  if (requireString(
    conflict.snapshot_normalized_sha256,
    `${label}.conflict_resolution.snapshot_normalized_sha256`,
    SHA256_PATTERN,
  ) !== sha256(snapshotNormalized)) fail(`${label} conflict snapshot identity drifted`);
  if (requireString(
    conflict.accepted_normalized_sha256,
    `${label}.conflict_resolution.accepted_normalized_sha256`,
    SHA256_PATTERN,
  ) !== sha256(acceptedNormalized)) fail(`${label} conflict accepted-text identity drifted`);
  if (requireString(
    conflict.comparison_pair_sha256,
    `${label}.conflict_resolution.comparison_pair_sha256`,
    SHA256_PATTERN,
  ) !== sha256(`${snapshotNormalized}\0${acceptedNormalized}`)) {
    fail(`${label} conflict comparison-pair identity drifted`);
  }
  if (conflict.resolved_against_scan !== true) fail(`${label} conflict must be resolved against scan`);
  if (requireString(
    conflict.rendered_image_sha256,
    `${label}.conflict_resolution.rendered_image_sha256`,
    SHA256_PATTERN,
  ) !== decision.rendered_image_sha256) fail(`${label} conflict scan image identity drifted`);
  requireString(conflict.scan_locator, `${label}.conflict_resolution.scan_locator`);
  requireString(conflict.resolution, `${label}.conflict_resolution.resolution`);
}

async function validateArtifactIdentityReceipt(decision, evidence, baseDirectory, protectedResources) {
  const reference = evidence.artifact_identity_receipt;
  if (!reference) {
    if (evidence.artifact_relation === 'different_artifact_same_edition') {
      fail(`${decision.decision_id}/${evidence.source_id} different-artifact evidence requires an identity receipt`);
    }
    return null;
  }
  const receiptPath = path.resolve(baseDirectory, reference.receipt_path);
  let receiptRead;
  try {
    receiptRead = await readPinnedRegularFileReceipt(receiptPath, {
      label: `${decision.decision_id}/${evidence.source_id} artifact identity receipt`,
      rootPath: baseDirectory,
    });
  } catch (error) {
    fail(error.message);
  }
  protectedResources.files.push(receiptRead);
  protectedResources.onlineDirectories.push({
    canonicalPath: receiptRead.parentCanonicalPath,
    identity: receiptRead.parentIdentity,
  });
  if (sha256(receiptRead.bytes) !== reference.receipt_sha256) {
    fail(`${decision.decision_id}/${evidence.source_id} artifact identity receipt SHA-256 drifted`);
  }
  let receipt;
  try {
    receipt = JSON.parse(receiptRead.bytes.toString('utf8'));
  } catch (error) {
    fail(`${decision.decision_id}/${evidence.source_id} artifact identity receipt JSON is invalid: ${error.message}`);
  }
  const label = `${decision.decision_id}/${evidence.source_id} artifact identity receipt`;
  requireObject(receipt, label);
  if (receipt.schema_version !== 1
    || receipt.artifact_profile !== 'ocr-online-artifact-identity-receipt-v1') {
    fail(`${label} schema or artifact profile is invalid`);
  }
  if (requireString(receipt.source_pdf_sha256, `${label}.source_pdf_sha256`, SHA256_PATTERN)
    !== decision.source_pdf_sha256) fail(`${label} source PDF identity drifted`);
  if (requireString(
    receipt.evidence_snapshot_sha256,
    `${label}.evidence_snapshot_sha256`,
    SHA256_PATTERN,
  ) !== evidence.content_sha256) fail(`${label} evidence snapshot identity drifted`);
  const onlineArtifactSha = requireString(
    receipt.online_artifact_sha256,
    `${label}.online_artifact_sha256`,
    SHA256_PATTERN,
  );
  if (onlineArtifactSha === decision.source_pdf_sha256) {
    fail(`${label} online artifact is the source PDF and cannot be independent`);
  }
  const sourceSequenceSha = requireString(
    receipt.source_page_asset_sequence_sha256,
    `${label}.source_page_asset_sequence_sha256`,
    SHA256_PATTERN,
  );
  const onlineSequenceSha = requireString(
    receipt.online_page_asset_sequence_sha256,
    `${label}.online_page_asset_sequence_sha256`,
    SHA256_PATTERN,
  );
  const sourceCount = requireInteger(receipt.source_page_asset_count, `${label}.source_page_asset_count`, 1);
  const onlineCount = requireInteger(receipt.online_page_asset_count, `${label}.online_page_asset_count`, 1);
  if (sourceSequenceSha === onlineSequenceSha && sourceCount !== onlineCount) {
    fail(`${label} equal page-asset sequence hashes have contradictory counts`);
  }
  const sameSequence = sourceSequenceSha === onlineSequenceSha;
  const expectedResult = sameSequence ? 'same_page_asset_sequence' : 'different_page_asset_sequence';
  if (receipt.identity_result !== expectedResult) fail(`${label} identity_result contradicts page assets`);
  if (sameSequence) {
    if (evidence.independent_for_decision) {
      fail(`${decision.decision_id}/${evidence.source_id} same page-asset sequence cannot be independent`);
    }
    if (evidence.artifact_relation !== 'same_artifact_mirror') {
      fail(`${decision.decision_id}/${evidence.source_id} same page-asset sequence must be a same-artifact mirror`);
    }
  } else if (evidence.artifact_relation === 'different_artifact_same_edition'
    && !evidence.independent_for_decision) {
    fail(`${decision.decision_id}/${evidence.source_id} different artifact is not marked independent`);
  }
  return { identity_result: expectedResult, online_artifact_sha256: onlineArtifactSha };
}

async function validateOnlineEvidenceSnapshots(
  decisions,
  decisionsPath,
  sourcePdfSha,
  protectedResources,
) {
  const baseDirectory = path.dirname(path.resolve(decisionsPath));
  for (const decision of decisions) {
    for (const evidence of decision.online_evidence) {
      const absolutePath = path.resolve(baseDirectory, evidence.content_path);
      let contentRead;
      try {
        contentRead = await readPinnedRegularFileReceipt(absolutePath, {
          label: `${decision.decision_id}/${evidence.source_id} online evidence snapshot`,
          rootPath: baseDirectory,
        });
      } catch (error) {
        fail(error.message);
      }
      protectedResources.files.push(contentRead);
      protectedResources.onlineDirectories.push({
        canonicalPath: contentRead.parentCanonicalPath,
        identity: contentRead.parentIdentity,
      });
      const contentSha = sha256(contentRead.bytes);
      if (contentSha !== evidence.content_sha256) {
        fail(`${decision.decision_id} online evidence content SHA-256 drifted`);
      }
      if (contentSha === sourcePdfSha || contentSha === decision.source_pdf_sha256) {
        fail(`${decision.decision_id} online evidence snapshot must not equal the source PDF`);
      }
      let snapshotText;
      try {
        snapshotText = STRICT_UTF8_DECODER.decode(contentRead.bytes);
      } catch {
        fail(`${decision.decision_id}/${evidence.source_id} online evidence snapshot is not valid UTF-8 text`);
      }
      if (sha256(snapshotText) !== evidence.snapshot_identity.text_sha256) {
        fail(`${decision.decision_id}/${evidence.source_id} snapshot text identity drifted`);
      }
      const snapshotNormalized = normalized(snapshotText);
      const acceptedNormalized = normalized(decision.accepted_text);
      if (!snapshotNormalized) fail(`${decision.decision_id}/${evidence.source_id} snapshot text is empty`);
      let actualRelation = 'structured_conflicts_resolved';
      if (snapshotNormalized === acceptedNormalized) actualRelation = 'normalized_exact';
      else if (snapshotNormalized.includes(acceptedNormalized)) {
        actualRelation = 'snapshot_contains_accepted_text';
      } else if (acceptedNormalized.includes(snapshotNormalized)) {
        actualRelation = 'accepted_text_contains_snapshot';
      }
      if (evidence.accepted_text_relation !== actualRelation) {
        fail(`${decision.decision_id}/${evidence.source_id} accepted-text relation drifted`);
      }
      if (actualRelation === 'structured_conflicts_resolved') {
        if (!evidence.conflict_resolution) {
          fail(`${decision.decision_id}/${evidence.source_id} structured conflict_resolution is required`);
        }
        validateStructuredConflictResolution(
          decision,
          evidence,
          snapshotNormalized,
          acceptedNormalized,
        );
      } else if (evidence.conflict_resolution !== null) {
        fail(`${decision.decision_id}/${evidence.source_id} conflict_resolution must be null without conflict`);
      }
      const artifactIdentity = await validateArtifactIdentityReceipt(
        decision,
        evidence,
        baseDirectory,
        protectedResources,
      );
      evidence.validated_snapshot_relation = actualRelation;
      evidence.validated_artifact_identity = artifactIdentity;
    }
  }
}

function validateDecisionEntitlements(decisions) {
  for (const decision of decisions) {
    if (!decision.citation_allowed) continue;
    const eligible = decision.online_evidence.some((item) => (
      item.version_match === 'exact_document_exact_edition'
      && item.independent_for_decision === true
      && ['independent_transcription', 'different_artifact_same_edition']
        .includes(item.artifact_relation)
      && item.snapshot_identity.scope === 'whole_page'
      && ['normalized_exact', 'snapshot_contains_accepted_text', 'structured_conflicts_resolved']
        .includes(item.validated_snapshot_relation)
      && item.validated_artifact_identity?.identity_result !== 'same_page_asset_sequence'
    ));
    if (!eligible) {
      fail(`${decision.decision_id} citation decision requires an independent exact-edition online transcription`);
    }
  }
}

function pathContains(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function readRegularFileNoFollow(
  filePath,
  label,
  root = null,
  encoding = null,
  protectedResources = null,
) {
  let receipt;
  try {
    receipt = await readPinnedRegularFileReceipt(filePath, {
      label,
      rootPath: root || undefined,
      encoding,
    });
    if (protectedResources) {
      protectedResources.files.push(receipt);
      if (root) {
        protectedResources.evidenceRoots.push({
          canonicalPath: receipt.rootCanonicalPath,
          identity: receipt.rootIdentity,
        });
      }
    }
    return receipt.bytes;
  } catch (error) {
    if (String(error?.message || '').startsWith('OCR triangulation audit:')) throw error;
    fail(error.message);
  }
}

function pageKey(page, width) {
  return String(page).padStart(width, '0');
}

function selectFurnitureRule(documentId, page, rules) {
  const matches = [...rules.values()].filter((rule) => (
    rule.document_id === documentId && page >= rule.start_page && page <= rule.end_page
  ));
  if (matches.length > 1) fail(`${documentId} page ${page} matches multiple activated furniture rules`);
  return matches[0] || null;
}

function bindDecision(decision, actual, tableFormats) {
  const prefix = decision.decision_id;
  if (decision.source_pdf_sha256 !== actual.sourcePdfSha) fail(`${prefix} source PDF SHA-256 drifted`);
  if (decision.rendered_image_sha256 !== actual.imageSha) fail(`${prefix} rendered image SHA-256 drifted`);
  if (decision.primary_ocr_sha256 !== actual.primarySha) fail(`${prefix} primary OCR SHA-256 drifted`);
  if (decision.vision_text_sha256 !== actual.witnessTextSha) fail(`${prefix} vision text SHA-256 drifted`);
  if (tableFormats.length && decision.page_type === 'prose') {
    fail(`${prefix} declared prose but table structure was detected`);
  }
  if (tableFormats.length
    && decision.table_cell_manifest
    && decision.table_cell_manifest.source_format !== 'manual_grid'
    && !tableFormats.includes(decision.table_cell_manifest.source_format)) {
    fail(`${prefix} table manifest source format does not match detected structure`);
  }
  if (decision.citation_allowed && tableFormats.length
    && decision.human_review.table_cells_checked !== true) {
    fail(`${prefix} citation decision for a table requires table_cells_checked=true`);
  }
  return {
    decision_id: decision.decision_id,
    decision_scope: decision.decision_scope,
    edition_match_status: decision.edition_match_status,
    verification_status: decision.verification_status,
    accepted_text_sha256: decision.accepted_text_sha256,
    online_source_ids: decision.online_evidence.map((item) => item.source_id),
    reviewed_by: decision.human_review.reviewed_by,
    reviewed_at: decision.human_review.reviewed_at,
    resolution: decision.human_review.resolution,
    uncertainty_note: decision.human_review.uncertainty_note,
    citation_allowed: decision.citation_allowed,
  };
}

async function buildOcrTriangulationAuditInternal(options) {
  const protectedResources = {
    files: [],
    evidenceRoots: [],
    onlineDirectories: [],
  };
  const documentId = requireString(options.documentId, 'documentId', DOCUMENT_ID_PATTERN);
  const start = requireInteger(options.start, 'start', 1);
  const end = requireInteger(options.end, 'end', start);
  if (end < start) fail('end must be greater than or equal to start');
  const primaryRoot = path.resolve(requireString(options.primaryRoot, 'primaryRoot'));
  const witnessRoot = path.resolve(requireString(options.witnessRoot, 'witnessRoot'));
  const sourcePdfPath = path.resolve(requireString(options.sourcePdfPath, 'sourcePdfPath'));
  const sourcePdfBytes = await readRegularFileNoFollow(
    sourcePdfPath,
    `${documentId} source PDF`,
    null,
    null,
    protectedResources,
  );
  if (sourcePdfBytes.length < 5 || sourcePdfBytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    fail(`${documentId} source PDF does not have a PDF file signature`);
  }
  const actualSourcePdfSha = sha256(sourcePdfBytes);
  if (Boolean(options.approvalLedgerPath) !== Boolean(options.activationLedgerPath)) {
    fail('approval and activation ledgers must be supplied together');
  }

  let furnitureRules = new Map();
  let furnitureBinding = null;
  if (options.approvalLedgerPath) {
    const approvalRaw = await readRegularFileNoFollow(
      options.approvalLedgerPath,
      'approval ledger',
      null,
      'utf8',
      protectedResources,
    );
    const approval = JSON.parse(approvalRaw);
    await validateOcrPageFurnitureApprovals(approval, { witnessRoot });
    const activationRaw = await readRegularFileNoFollow(
      options.activationLedgerPath,
      'activation ledger',
      null,
      'utf8',
      protectedResources,
    );
    const activation = JSON.parse(activationRaw);
    furnitureRules = validateOcrPageFurnitureActivation(activation, approvalRaw, approval);
    furnitureBinding = {
      approval_ledger_sha256: sha256(approvalRaw),
      activation_ledger_sha256: sha256(activationRaw),
      activation_scope: activation.activation_scope,
    };
  }

  let decisions = [];
  let decisionLedgerSha = null;
  let onlineSourceRegistrySha = null;
  if (options.decisionsPath) {
    const resolvedDecisionsPath = path.resolve(options.decisionsPath);
    const raw = await readRegularFileNoFollow(
      resolvedDecisionsPath,
      'decision ledger',
      null,
      'utf8',
      protectedResources,
    );
    let rawLedger;
    try {
      rawLedger = JSON.parse(raw);
    } catch (error) {
      fail(`decision ledger contains invalid JSON: ${error.message}`);
    }
    const hasOnlineEvidence = Array.isArray(rawLedger?.decisions)
      && rawLedger.decisions.some((decision) => Array.isArray(decision?.online_evidence)
        && decision.online_evidence.length > 0);
    if (hasOnlineEvidence && !options.onlineSourceRegistryPath) {
      fail('online source registry is required for online evidence');
    }
    let registryRaw = null;
    let registrySources = new Map();
    if (options.onlineSourceRegistryPath) {
      registryRaw = await readRegularFileNoFollow(
        options.onlineSourceRegistryPath,
        'online source registry',
        null,
        'utf8',
        protectedResources,
      );
      let registry;
      try {
        registry = JSON.parse(registryRaw);
      } catch (error) {
        fail(`online source registry contains invalid JSON: ${error.message}`);
      }
      registrySources = validateOnlineSourceRegistry(registry);
      onlineSourceRegistrySha = sha256(registryRaw);
    }
    decisions = validateDecisionLedger(rawLedger, registryRaw, registrySources);
    await validateOnlineEvidenceSnapshots(
      decisions,
      resolvedDecisionsPath,
      actualSourcePdfSha,
      protectedResources,
    );
    validateDecisionEntitlements(decisions);
    decisionLedgerSha = sha256(raw);
  }
  const decisionsByPage = new Map();
  for (const decision of decisions) {
    if (decision.document_id !== documentId) continue;
    const list = decisionsByPage.get(decision.physical_page) || [];
    list.push(decision);
    decisionsByPage.set(decision.physical_page, list);
  }

  const pages = [];
  let sourcePdfSha = null;
  for (let page = start; page <= end; page += 1) {
    const primaryPath = path.join(primaryRoot, pageKey(page, 4), 'content.md');
    const sidecarPath = path.join(witnessRoot, documentId, 'vision', `page-${pageKey(page, 3)}.json`);
    const imagePath = path.join(witnessRoot, documentId, 'images', `page-${pageKey(page, 3)}.png`);
    const [primary, sidecarRaw, image] = await Promise.all([
      readRegularFileNoFollow(
        primaryPath,
        `${documentId} page ${page} primary OCR`,
        primaryRoot,
        'utf8',
        protectedResources,
      ),
      readRegularFileNoFollow(
        sidecarPath,
        `${documentId} page ${page} Vision sidecar`,
        witnessRoot,
        'utf8',
        protectedResources,
      ),
      readRegularFileNoFollow(
        imagePath,
        `${documentId} page ${page} rendered image`,
        witnessRoot,
        null,
        protectedResources,
      ),
    ]);
    const witnessRecord = requireObject(JSON.parse(sidecarRaw), `${documentId} page ${page} sidecar`);
    if (witnessRecord.document_id !== documentId) fail(`${documentId} page ${page} sidecar document drifted`);
    if (witnessRecord.physical_pdf_page !== page) fail(`${documentId} page ${page} sidecar page drifted`);
    if (witnessRecord.file !== `page-${pageKey(page, 3)}.png`) fail(`${documentId} page ${page} sidecar file drifted`);
    const pageSourceSha = requireString(
      witnessRecord.source_pdf_sha256,
      `${documentId} page ${page} source_pdf_sha256`,
      SHA256_PATTERN,
    );
    if (pageSourceSha !== actualSourcePdfSha) {
      fail(`${documentId} page ${page} source PDF bytes drifted`);
    }
    if (sourcePdfSha && pageSourceSha !== sourcePdfSha) fail(`${documentId} source PDF SHA-256 changed inside range`);
    sourcePdfSha = pageSourceSha;
    const recordedImageSha = requireString(
      witnessRecord.rendered_image_sha256,
      `${documentId} page ${page} rendered_image_sha256`,
      SHA256_PATTERN,
    );
    const imageSha = sha256(image);
    if (recordedImageSha !== imageSha) fail(`${documentId} page ${page} rendered image bytes drifted`);
    const lines = requireArray(witnessRecord.lines, `${documentId} page ${page} lines`);
    const witness = lines.map((line, index) => {
      requireObject(line, `${documentId} page ${page} lines[${index}]`);
      if (typeof line.text !== 'string') fail(`${documentId} page ${page} lines[${index}].text must be a string`);
      return line.text;
    }).join('\n');
    const primarySha = sha256(primary);
    const witnessTextSha = sha256(witness);
    const rawMetrics = comparisonMetrics(primary, witness);
    const rule = selectFurnitureRule(documentId, page, furnitureRules);
    let comparisonPrimary = primary;
    let comparisonWitness = witness;
    let furniture = null;
    if (rule) {
      const printedPage = page + rule.physical_to_printed_offset;
      const filteredPrimary = stripExactTrailingPrintedPage(primary, printedPage);
      const filteredWitness = stripExactTrailingPrintedPage(witness, printedPage);
      if (!filteredWitness.removed) fail(`${rule.rule_id} page ${page} lost its approved exact witness footer`);
      comparisonPrimary = filteredPrimary.value;
      comparisonWitness = filteredWitness.value;
      furniture = {
        rule_id: rule.rule_id,
        printed_page: printedPage,
        primary_footer_removed: filteredPrimary.removed,
        witness_footer_removed: filteredWitness.removed,
        comparison_only: true,
      };
    }
    const metrics = comparisonMetrics(comparisonPrimary, comparisonWitness);
    const transcription = transcriptionGate({
      primary: comparisonPrimary,
      witness: comparisonWitness,
      witnessRecord,
      metrics,
    });
    const actual = {
      sourcePdfSha: pageSourceSha,
      imageSha,
      primarySha,
      witnessTextSha,
    };
    const scopedDecisions = (decisionsByPage.get(page) || []).map((decision) => (
      bindDecision(decision, actual, transcription.table_formats)
    ));
    const citationDecisions = scopedDecisions.filter((decision) => (
      decision.decision_scope === 'whole_page' && decision.citation_allowed
    ));
    if (citationDecisions.length > 1) fail(`${documentId} page ${page} has multiple citation decisions`);
    const warningDecisions = scopedDecisions.filter((decision) => (
      decision.decision_scope === 'whole_page'
      && decision.verification_status === 'human_judgment_with_warning'
      && !decision.citation_allowed
    ));
    if (warningDecisions.length > 1) fail(`${documentId} page ${page} has multiple warning decisions`);
    let release = {
      verification_status: 'unresolved_fail_closed',
      release_gate: 'no_hash_bound_exact_edition_human_decision',
      accepted_text_sha256: null,
      uncertainty_note: null,
      citation_allowed: false,
    };
    if (citationDecisions.length === 1) {
      const decision = citationDecisions[0];
      release = {
        verification_status: 'verified_exact',
        release_gate: 'verified_exact_human_triangulation',
        accepted_text_sha256: decision.accepted_text_sha256,
        uncertainty_note: null,
        citation_allowed: true,
        decision_id: decision.decision_id,
      };
    } else if (warningDecisions.length === 1) {
      const decision = warningDecisions[0];
      release = {
        verification_status: 'human_judgment_with_warning',
        release_gate: 'human_image_judgment_non_citation',
        accepted_text_sha256: decision.accepted_text_sha256,
        uncertainty_note: decision.uncertainty_note,
        citation_allowed: false,
        decision_id: decision.decision_id,
      };
    }
    pages.push({
      physical_page: page,
      primary_path: primaryPath,
      vision_sidecar_path: sidecarPath,
      rendered_image_path: imagePath,
      raw: {
        source_pdf_sha256: pageSourceSha,
        rendered_image_sha256: imageSha,
        primary_ocr_sha256: primarySha,
        vision_sidecar_sha256: sha256(sidecarRaw),
        witness_text_sha256: witnessTextSha,
        ...rawMetrics,
      },
      furniture,
      comparison: {
        primary_text_sha256: sha256(comparisonPrimary),
        witness_text_sha256: sha256(comparisonWitness),
        ...metrics,
      },
      transcription: {
        ...transcription,
        policy: 'thresholds_unchanged_after_source_bound_comparison_filter',
      },
      scoped_decisions: scopedDecisions,
      release,
    });
  }

  const gateCount = (gate) => pages.filter((page) => page.transcription.gate === gate).length;
  const report = {
    schema_version: 2,
    artifact_profile: 'ocr-page-triangulation-audit-v2',
    document_id: documentId,
    source_pdf_sha256: sourcePdfSha,
    source_pdf_bytes: sourcePdfBytes.length,
    page_range: [start, end],
    policy: {
      scan_is_primary: true,
      raw_ocr_and_witness_mutation: 'forbidden',
      furniture_scope: 'comparison_only_and_exact_source_snapshot_bound',
      automatic_threshold_relaxation: 'forbidden',
      online_source_scope: 'exact_edition_for_page_wording_stable_fact_only_for_scoped_facts',
      search_snippets: 'discovery_only_never_evidence',
      citation_gate: 'hash_bound_whole_page_exact_edition_human_triangulation_only',
      unresolved_behavior: 'fail_closed',
    },
    furniture_binding: furnitureBinding,
    decision_ledger_sha256: decisionLedgerSha,
    online_source_registry_sha256: onlineSourceRegistrySha,
    summary: {
      pages: pages.length,
      automatic_witness_pass: gateCount('automatic_witness_pass'),
      manual_image_review_required: gateCount('manual_image_review_required'),
      blank_page_visual_confirmation_required: gateCount('blank_page_visual_confirmation_required'),
      unresolved_fail_closed: gateCount('unresolved_fail_closed'),
      verified_exact_human_triangulation: pages.filter(
        (page) => page.release.release_gate === 'verified_exact_human_triangulation',
      ).length,
      citation_allowed: pages.filter((page) => page.release.citation_allowed).length,
    },
    pages,
  };
  return { report, protectedResources };
}

export async function buildOcrTriangulationAudit(options) {
  return (await buildOcrTriangulationAuditInternal(options)).report;
}

function filesystemIdentity(info) {
  return { dev: String(info.dev), ino: String(info.ino) };
}

function sameFilesystemIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameProtectedFileSnapshot(info, expected) {
  return sameFilesystemIdentity(filesystemIdentity(info), expected)
    && String(info.mode) === expected.mode
    && String(info.nlink) === expected.nlink
    && String(info.size) === expected.size
    && String(info.mtimeNs) === expected.mtimeNs
    && String(info.ctimeNs) === expected.ctimeNs;
}

async function prospectiveCanonicalParent(parentPath) {
  const missing = [];
  let cursor = path.resolve(parentPath);
  while (true) {
    try {
      await lstat(cursor);
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const basename = path.basename(cursor);
      const next = path.dirname(cursor);
      if (next === cursor) throw error;
      missing.unshift(basename);
      cursor = next;
    }
  }
  return path.join(await realpath(cursor), ...missing);
}

async function assertProtectedResourcesUnchanged(protectedResources) {
  const seenFiles = new Set();
  for (const receipt of protectedResources.files) {
    const key = `${receipt.canonicalPath}\0${receipt.fileIdentity.dev}\0${receipt.fileIdentity.ino}`;
    if (seenFiles.has(key)) continue;
    seenFiles.add(key);
    const current = await lstat(receipt.canonicalPath, { bigint: true });
    if (!current.isFile() || !sameProtectedFileSnapshot(current, receipt.fileIdentity)) {
      fail(`protected input identity changed before output: ${receipt.canonicalPath}`);
    }
  }
  const directories = [...protectedResources.evidenceRoots, ...protectedResources.onlineDirectories];
  const seenDirectories = new Set();
  for (const directory of directories) {
    const key = `${directory.canonicalPath}\0${directory.identity.dev}\0${directory.identity.ino}`;
    if (seenDirectories.has(key)) continue;
    seenDirectories.add(key);
    const current = await stat(directory.canonicalPath, { bigint: true });
    if (!current.isDirectory()
      || !sameFilesystemIdentity(filesystemIdentity(current), directory.identity)) {
      fail(`protected evidence directory identity changed before output: ${directory.canonicalPath}`);
    }
  }
}

async function prepareSafeOutput(outputPath, protectedResources) {
  await assertProtectedResourcesUnchanged(protectedResources);
  const requestedParent = path.dirname(outputPath);
  const prospectiveParent = await prospectiveCanonicalParent(requestedParent);
  const evidenceRoots = protectedResources.evidenceRoots;
  const onlineDirectories = protectedResources.onlineDirectories;
  if (evidenceRoots.some((directory) => pathIsWithin(directory.canonicalPath, prospectiveParent))) {
    fail('output must be outside primary and witness evidence roots');
  }
  if (onlineDirectories.some((directory) => pathIsWithin(directory.canonicalPath, prospectiveParent))) {
    fail('output must be outside every online evidence snapshot directory');
  }
  await mkdir(requestedParent, { recursive: true });
  const realOutputParent = await realpath(requestedParent);
  const canonicalOutputPath = path.join(realOutputParent, path.basename(outputPath));
  const parentInfo = await stat(realOutputParent, { bigint: true });
  const parentIdentity = filesystemIdentity(parentInfo);
  for (const receipt of protectedResources.files) {
    if (canonicalOutputPath === receipt.canonicalPath) {
      fail('output must not replace a protected input');
    }
  }
  let outputInfo = null;
  try {
    outputInfo = await lstat(canonicalOutputPath, { bigint: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (outputInfo) {
    if (outputInfo.isSymbolicLink()) fail('output path must not be a symbolic link');
    const outputIdentity = filesystemIdentity(outputInfo);
    if (protectedResources.files.some((receipt) => (
      sameFilesystemIdentity(outputIdentity, receipt.fileIdentity)
    ))) {
      fail('output device/inode aliases a protected input');
    }
  }
  return { canonicalOutputPath, realOutputParent, parentIdentity };
}

export async function writeOcrTriangulationAudit(options) {
  const outputPath = path.resolve(requireString(options.outputPath, 'outputPath'));
  if (pathContains(options.primaryRoot, outputPath) || pathContains(options.witnessRoot, outputPath)) {
    fail('output must be outside primary and witness evidence roots');
  }
  for (const ledgerPath of [
    options.approvalLedgerPath,
    options.activationLedgerPath,
    options.decisionsPath,
  ].filter(Boolean)) {
    if (outputPath === path.resolve(ledgerPath)) fail('output must not replace an input ledger');
  }
  const { report, protectedResources } = await buildOcrTriangulationAuditInternal(options);
  const {
    canonicalOutputPath,
    realOutputParent,
    parentIdentity,
  } = await prepareSafeOutput(outputPath, protectedResources);
  const raw = `${JSON.stringify(report, null, 2)}\n`;
  const temporaryPath = path.join(
    realOutputParent,
    `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(raw, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    const currentParent = filesystemIdentity(await stat(realOutputParent, { bigint: true }));
    if (!sameFilesystemIdentity(parentIdentity, currentParent)) {
      fail('output parent directory identity changed before activation');
    }
    await rename(temporaryPath, canonicalOutputPath);
    const finalParent = filesystemIdentity(await stat(realOutputParent, { bigint: true }));
    if (!sameFilesystemIdentity(parentIdentity, finalParent)) {
      fail('output parent directory identity changed during activation');
    }
  } catch (error) {
    await handle?.close();
    await unlink(temporaryPath).catch((cleanupError) => {
      if (cleanupError?.code !== 'ENOENT') throw cleanupError;
    });
    throw error;
  }
  return report;
}

function parseArgs(argv) {
  const mapping = new Map([
    ['--document', 'documentId'],
    ['--primary-root', 'primaryRoot'],
    ['--witness-root', 'witnessRoot'],
    ['--source-pdf', 'sourcePdfPath'],
    ['--approval-ledger', 'approvalLedgerPath'],
    ['--activation-ledger', 'activationLedgerPath'],
    ['--decisions', 'decisionsPath'],
    ['--online-source-registry', 'onlineSourceRegistryPath'],
    ['--output', 'outputPath'],
    ['--start', 'start'],
    ['--end', 'end'],
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!mapping.has(key)) fail(`unknown argument ${key}`);
    if (!value) fail(`${key} requires a value`);
    const property = mapping.get(key);
    if (options[property] !== undefined) fail(`duplicate argument ${key}`);
    options[property] = value;
  }
  for (const property of [
    'documentId',
    'primaryRoot',
    'witnessRoot',
    'sourcePdfPath',
    'outputPath',
    'start',
    'end',
  ]) {
    if (options[property] === undefined) fail(`${property} is required`);
  }
  options.start = Number(options.start);
  options.end = Number(options.end);
  return options;
}

async function main() {
  const report = await writeOcrTriangulationAudit(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report.summary)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
