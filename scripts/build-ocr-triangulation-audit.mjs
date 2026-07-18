#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripExactTrailingPrintedPage } from './preview-ocr-page-furniture-impact.mjs';
import { validateOcrPageFurnitureApprovals } from './validate-ocr-page-furniture-approvals.mjs';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DOCUMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
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
  const tableDetected = /<table\b|<tr\b|<td\b/i.test(primary);
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

function validateDecisionLedger(input) {
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
      requireString(item.publisher, `${evidenceLabel}.publisher`);
      requireString(item.source_type, `${evidenceLabel}.source_type`);
      if (!ONLINE_AUTHORITY_CLASSES.has(item.authority_class)) {
        fail(`${evidenceLabel}.authority_class is not official or academic`);
      }
      const sourceUrl = requireString(item.source_url, `${evidenceLabel}.source_url`);
      let parsed;
      try {
        parsed = new URL(sourceUrl);
      } catch {
        fail(`${evidenceLabel}.source_url is invalid`);
      }
      if (parsed.protocol !== 'https:') fail(`${evidenceLabel}.source_url must use HTTPS`);
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
      if (!evidence.some((item) => (
        item.version_match === 'exact_document_exact_edition'
        && item.independent_for_decision === true
        && ['independent_transcription', 'different_artifact_same_edition']
          .includes(item.artifact_relation)
      ))) {
        fail(`${decisionId} citation decision requires an independent exact-edition online transcription`);
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

async function validateOnlineEvidenceSnapshots(decisions, decisionsPath) {
  const baseDirectory = path.dirname(path.resolve(decisionsPath));
  const realBaseDirectory = await realpath(baseDirectory);
  for (const decision of decisions) {
    for (const evidence of decision.online_evidence) {
      const absolutePath = path.resolve(baseDirectory, evidence.content_path);
      const relativePath = path.relative(baseDirectory, absolutePath);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        fail(`${decision.decision_id} online evidence path escapes its ledger directory`);
      }
      const realParent = await realpath(path.dirname(absolutePath));
      if (!pathContains(realBaseDirectory, realParent)) {
        fail(`${decision.decision_id} online evidence parent escapes its ledger directory`);
      }
      let handle;
      try {
        handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await handle.stat();
        if (!info.isFile()) fail(`${decision.decision_id} online evidence must be a regular file`);
        const bytes = await handle.readFile();
        if (sha256(bytes) !== evidence.content_sha256) {
          fail(`${decision.decision_id} online evidence content SHA-256 drifted`);
        }
      } catch (error) {
        if (String(error?.message || '').startsWith('OCR triangulation audit:')) throw error;
        fail(`${decision.decision_id} online evidence cannot be read safely: ${error.message}`);
      } finally {
        await handle?.close();
      }
    }
  }
}

function pathContains(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function readRegularFileNoFollow(filePath, label, root = null, encoding = null) {
  const resolvedPath = path.resolve(filePath);
  if (root) {
    const [realRoot, realParent] = await Promise.all([
      realpath(root),
      realpath(path.dirname(resolvedPath)),
    ]);
    if (!pathContains(realRoot, realParent)) fail(`${label} parent escapes its evidence root`);
  }
  let handle;
  try {
    handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) fail(`${label} must be a regular file`);
    return await handle.readFile(encoding ? { encoding } : undefined);
  } catch (error) {
    if (String(error?.message || '').startsWith('OCR triangulation audit:')) throw error;
    fail(`${label} cannot be read safely: ${error.message}`);
  } finally {
    await handle?.close();
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

function bindDecision(decision, actual, tableDetected) {
  const prefix = decision.decision_id;
  if (decision.source_pdf_sha256 !== actual.sourcePdfSha) fail(`${prefix} source PDF SHA-256 drifted`);
  if (decision.rendered_image_sha256 !== actual.imageSha) fail(`${prefix} rendered image SHA-256 drifted`);
  if (decision.primary_ocr_sha256 !== actual.primarySha) fail(`${prefix} primary OCR SHA-256 drifted`);
  if (decision.vision_text_sha256 !== actual.witnessTextSha) fail(`${prefix} vision text SHA-256 drifted`);
  if (decision.citation_allowed && tableDetected && decision.human_review.table_cells_checked !== true) {
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

export async function buildOcrTriangulationAudit(options) {
  const documentId = requireString(options.documentId, 'documentId', DOCUMENT_ID_PATTERN);
  const start = requireInteger(options.start, 'start', 1);
  const end = requireInteger(options.end, 'end', start);
  if (end < start) fail('end must be greater than or equal to start');
  const primaryRoot = path.resolve(requireString(options.primaryRoot, 'primaryRoot'));
  const witnessRoot = path.resolve(requireString(options.witnessRoot, 'witnessRoot'));
  const sourcePdfPath = path.resolve(requireString(options.sourcePdfPath, 'sourcePdfPath'));
  const sourcePdfBytes = await readRegularFileNoFollow(sourcePdfPath, `${documentId} source PDF`);
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
    );
    const approval = JSON.parse(approvalRaw);
    await validateOcrPageFurnitureApprovals(approval, { witnessRoot });
    const activationRaw = await readRegularFileNoFollow(
      options.activationLedgerPath,
      'activation ledger',
      null,
      'utf8',
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
  if (options.decisionsPath) {
    const resolvedDecisionsPath = path.resolve(options.decisionsPath);
    const raw = await readRegularFileNoFollow(
      resolvedDecisionsPath,
      'decision ledger',
      null,
      'utf8',
    );
    decisions = validateDecisionLedger(JSON.parse(raw));
    await validateOnlineEvidenceSnapshots(decisions, resolvedDecisionsPath);
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
      readRegularFileNoFollow(primaryPath, `${documentId} page ${page} primary OCR`, primaryRoot, 'utf8'),
      readRegularFileNoFollow(sidecarPath, `${documentId} page ${page} Vision sidecar`, witnessRoot, 'utf8'),
      readRegularFileNoFollow(imagePath, `${documentId} page ${page} rendered image`, witnessRoot),
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
      bindDecision(decision, actual, transcription.table_detected)
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
  return {
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
}

export async function writeOcrTriangulationAudit(options) {
  const outputPath = path.resolve(requireString(options.outputPath, 'outputPath'));
  if (pathContains(options.primaryRoot, outputPath) || pathContains(options.witnessRoot, outputPath)) {
    fail('output must be outside primary and witness evidence roots');
  }
  for (const inputPath of [
    options.approvalLedgerPath,
    options.activationLedgerPath,
    options.decisionsPath,
  ].filter(Boolean)) {
    if (outputPath === path.resolve(inputPath)) fail('output must not replace an input ledger');
  }
  const report = await buildOcrTriangulationAudit(options);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const [realOutputParent, realPrimaryRoot, realWitnessRoot] = await Promise.all([
    realpath(path.dirname(outputPath)),
    realpath(options.primaryRoot),
    realpath(options.witnessRoot),
  ]);
  if (pathContains(realPrimaryRoot, realOutputParent)
    || pathContains(realWitnessRoot, realOutputParent)) {
    fail('output parent resolves inside primary or witness evidence roots');
  }
  const raw = `${JSON.stringify(report, null, 2)}\n`;
  const temporaryPath = path.join(
    path.dirname(outputPath),
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
    await rename(temporaryPath, outputPath);
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
