#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCUMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const AUDIT_FILE_PATTERN = /^audit-(\d+)-(\d+)\.json$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MANUAL_REVIEW_AGREEMENT_MIN = 0.985;
const AUTOMATIC_VISION_CONFIDENCE_MIN = 0.8;
const GATES = new Set([
  'automatic_witness_pass',
  'manual_image_review_required',
  'blank_page_visual_confirmation_required',
  'unresolved_fail_closed',
]);
const PRIORITY_ORDER = [
  { rank: 1, code: 'table_reconstruction' },
  { rank: 2, code: 'title_or_numeric_conflict' },
  { rank: 3, code: 'low_character_agreement' },
  { rank: 4, code: 'manual_image_review' },
  { rank: 5, code: 'blank_visual_confirmation' },
];

function fail(message) {
  throw new Error(`OCR review queue: ${message}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function toPortableRelative(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label, { allowEmpty = false, pattern = null } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    fail(`${label} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }
  if (pattern && !pattern.test(value)) fail(`${label} has an invalid format`);
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
}

function requireInteger(value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    fail(`${label} must be an integer >= ${minimum}`);
  }
  return value;
}

function requireUnitNumber(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${label} must be a finite number between 0 and 1`);
  }
  return value;
}

function requireStringArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value.map((item, index) => requireString(item, `${label}[${index}]`, { allowEmpty: true }));
}

function requireField(object, key, label) {
  if (!Object.hasOwn(object, key)) fail(`${label}.${key} is required`);
  return object[key];
}

function priorityFor(page) {
  if (page.table.detected) return PRIORITY_ORDER[0];
  if (page.gate === 'blank_page_visual_confirmation_required') return PRIORITY_ORDER[4];
  if (!page.title.exact || !page.numeric.exact) return PRIORITY_ORDER[1];
  if (page.agreement < MANUAL_REVIEW_AGREEMENT_MIN) return PRIORITY_ORDER[2];
  if (page.gate === 'manual_image_review_required') return PRIORITY_ORDER[3];
  fail(`${page.stable_locator} has no review priority for gate ${page.gate}`);
}

function reasonsFor(page) {
  const reasons = [];
  if (page.table.detected) reasons.push('table_detected_cell_by_cell_review_required');
  if (!page.numeric.exact) reasons.push('numeric_sequence_conflict');
  if (!page.title.exact && page.gate !== 'blank_page_visual_confirmation_required') {
    reasons.push('title_conflict');
  }
  if (page.agreement < MANUAL_REVIEW_AGREEMENT_MIN) {
    reasons.push('normalized_character_agreement_below_manual_threshold');
  }
  if (page.confidence.average_vision < AUTOMATIC_VISION_CONFIDENCE_MIN) {
    reasons.push('vision_average_confidence_below_automatic_threshold');
  }
  if (page.critical_fields.declared === 0) reasons.push('critical_fields_not_declared');
  else if (!page.critical_fields.exact) reasons.push('critical_fields_conflict');
  if (page.gate === 'unresolved_fail_closed') reasons.push('unresolved_fail_closed');
  if (page.gate === 'manual_image_review_required') reasons.push('manual_image_review_required');
  if (page.gate === 'blank_page_visual_confirmation_required') {
    reasons.push('blank_page_visual_confirmation_required');
  }
  return reasons;
}

function expectedGateFor(page) {
  if (page.character_counts.primary === 0 && page.character_counts.witness === 0) {
    return 'blank_page_visual_confirmation_required';
  }
  if (page.agreement >= 0.995
    && page.numeric.exact
    && page.title.exact
    && page.critical_fields.declared > 0
    && page.critical_fields.exact
    && !page.table.detected
    && page.confidence.average_vision >= AUTOMATIC_VISION_CONFIDENCE_MIN) {
    return 'automatic_witness_pass';
  }
  if (page.agreement >= MANUAL_REVIEW_AGREEMENT_MIN && page.title.exact) {
    return 'manual_image_review_required';
  }
  return 'unresolved_fail_closed';
}

function normalizeAuditPage(documentId, auditPath, pageValue) {
  const label = `${auditPath}.pages`;
  const page = requireObject(pageValue, label);
  const pageNumber = requireInteger(requireField(page, 'page', label), `${label}.page`, 1);
  const stableLocator = `${documentId}:page:${pageNumber}`;
  const gate = requireString(requireField(page, 'gate', label), `${label}.gate`);
  if (!GATES.has(gate)) fail(`${label}.gate is invalid: ${gate}`);

  const normalized = {
    document_id: documentId,
    page: pageNumber,
    stable_locator: stableLocator,
    gate,
    agreement: requireUnitNumber(
      requireField(page, 'normalized_character_agreement', label),
      `${label}.normalized_character_agreement`,
    ),
    character_counts: {
      primary: requireInteger(
        requireField(page, 'primary_character_count', label),
        `${label}.primary_character_count`,
      ),
      witness: requireInteger(
        requireField(page, 'witness_character_count', label),
        `${label}.witness_character_count`,
      ),
    },
    title: {
      exact: requireBoolean(requireField(page, 'title_exact', label), `${label}.title_exact`),
      primary_heading: requireString(
        requireField(page, 'primary_heading', label),
        `${label}.primary_heading`,
        { allowEmpty: true },
      ),
      witness_heading: requireString(
        requireField(page, 'witness_heading', label),
        `${label}.witness_heading`,
        { allowEmpty: true },
      ),
    },
    numeric: {
      exact: requireBoolean(
        requireField(page, 'numeric_sequence_exact', label),
        `${label}.numeric_sequence_exact`,
      ),
      primary_sequence: requireStringArray(
        requireField(page, 'primary_numbers', label),
        `${label}.primary_numbers`,
      ),
      witness_sequence: requireStringArray(
        requireField(page, 'witness_numbers', label),
        `${label}.witness_numbers`,
      ),
    },
    table: {
      detected: requireBoolean(requireField(page, 'table_detected', label), `${label}.table_detected`),
    },
    confidence: {
      average_vision: requireUnitNumber(
        requireField(page, 'average_vision_confidence', label),
        `${label}.average_vision_confidence`,
      ),
      low_confidence_line_count: requireInteger(
        requireField(page, 'low_confidence_line_count', label),
        `${label}.low_confidence_line_count`,
      ),
    },
    critical_fields: {
      declared: requireInteger(
        requireField(page, 'critical_fields_declared', label),
        `${label}.critical_fields_declared`,
      ),
      exact: requireBoolean(
        requireField(page, 'critical_fields_exact', label),
        `${label}.critical_fields_exact`,
      ),
    },
    primary: {
      paths: [requireString(requireField(page, 'primary_path', label), `${label}.primary_path`)],
      sha256: requireString(
        requireField(page, 'primary_sha256', label),
        `${label}.primary_sha256`,
        { pattern: SHA256_PATTERN },
      ),
    },
    witness: {
      paths: [requireString(requireField(page, 'witness_path', label), `${label}.witness_path`)],
      sha256: requireString(
        requireField(page, 'witness_sha256', label),
        `${label}.witness_sha256`,
        { pattern: SHA256_PATTERN },
      ),
    },
  };
  const expectedGate = expectedGateFor(normalized);
  if (gate !== expectedGate) {
    fail(`${stableLocator} gate ${gate} does not match recomputed gate ${expectedGate}`);
  }

  const priority = gate === 'automatic_witness_pass' ? null : priorityFor(normalized);
  return {
    ...normalized,
    priority,
    reasons: gate === 'automatic_witness_pass' ? [] : reasonsFor(normalized),
    source_audit_paths: [auditPath],
  };
}

function validateAuditReport(documentId, auditPath, filenameRange, value) {
  const report = requireObject(value, auditPath);
  if (requireField(report, 'schema_version', auditPath) !== 1) {
    fail(`${auditPath}.schema_version must equal 1`);
  }
  const pageRange = requireField(report, 'page_range', auditPath);
  if (!Array.isArray(pageRange) || pageRange.length !== 2) {
    fail(`${auditPath}.page_range must contain exactly two integers`);
  }
  const start = requireInteger(pageRange[0], `${auditPath}.page_range[0]`, 1);
  const end = requireInteger(pageRange[1], `${auditPath}.page_range[1]`, 1);
  if (start > end) fail(`${auditPath}.page_range start must not exceed end`);
  if (start !== filenameRange.start || end !== filenameRange.end) {
    fail(`${auditPath}.page_range does not match its filename`);
  }

  const pages = requireField(report, 'pages', auditPath);
  if (!Array.isArray(pages) || pages.length === 0) fail(`${auditPath}.pages must be a non-empty array`);
  if (pages.length !== end - start + 1) {
    fail(`${auditPath}.pages does not cover the complete declared page_range`);
  }
  const summary = requireObject(requireField(report, 'summary', auditPath), `${auditPath}.summary`);
  if (requireInteger(requireField(summary, 'pages', `${auditPath}.summary`), `${auditPath}.summary.pages`) !== pages.length) {
    fail(`${auditPath}.summary.pages does not match pages.length`);
  }

  const normalizedPages = pages.map((page, index) => {
    const normalized = normalizeAuditPage(documentId, auditPath, page);
    const expectedPage = start + index;
    if (normalized.page !== expectedPage) {
      fail(`${auditPath}.pages[${index}].page must equal contiguous page ${expectedPage}`);
    }
    return normalized;
  });
  for (const gate of GATES) {
    const declared = requireInteger(
      requireField(summary, gate, `${auditPath}.summary`),
      `${auditPath}.summary.${gate}`,
    );
    const actual = normalizedPages.filter((page) => page.gate === gate).length;
    if (declared !== actual) fail(`${auditPath}.summary.${gate} does not match page gates`);
  }
  return normalizedPages;
}

async function discoverAuditFiles(witnessRoot) {
  let documentEntries;
  try {
    documentEntries = await readdir(witnessRoot, { withFileTypes: true });
  } catch (error) {
    fail(`cannot read witness root ${witnessRoot}: ${error.message}`);
  }

  const auditFiles = [];
  for (const documentEntry of documentEntries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => compareText(left.name, right.name))) {
    const documentId = requireString(documentEntry.name, 'document_id', { pattern: DOCUMENT_ID_PATTERN });
    const auditsRoot = path.join(witnessRoot, documentId, 'audits');
    let auditEntries;
    try {
      auditEntries = await readdir(auditsRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      fail(`cannot read audits directory ${auditsRoot}: ${error.message}`);
    }
    for (const entry of auditEntries.sort((left, right) => compareText(left.name, right.name))) {
      if (!entry.name.startsWith('audit-') || !entry.name.endsWith('.json')) continue;
      const match = entry.name.match(AUDIT_FILE_PATTERN);
      if (!match) fail(`${documentId}/audits/${entry.name} has an invalid audit filename`);
      if (!entry.isFile()) fail(`${documentId}/audits/${entry.name} must be a regular file`);
      auditFiles.push({
        documentId,
        absolutePath: path.join(auditsRoot, entry.name),
        relativePath: `${documentId}/audits/${entry.name}`,
        filenameRange: {
          start: Number(match[1]),
          end: Number(match[2]),
        },
      });
    }
  }
  if (auditFiles.length === 0) fail(`no */audits/audit-*.json files found under ${witnessRoot}`);
  return auditFiles;
}

function comparablePage(page) {
  const {
    source_audit_paths: ignoredAuditPaths,
    primary,
    witness,
    ...comparable
  } = page;
  return {
    ...comparable,
    primary: { sha256: primary.sha256 },
    witness: { sha256: witness.sha256 },
  };
}

function countBy(items, keySelector, orderedKeys) {
  return Object.fromEntries(orderedKeys.map((key) => [
    key,
    items.filter((item) => keySelector(item) === key).length,
  ]));
}

export async function buildOcrReviewQueue({ witnessRoot }) {
  const resolvedWitnessRoot = path.resolve(requireString(witnessRoot, 'witnessRoot'));
  const auditFiles = await discoverAuditFiles(resolvedWitnessRoot);
  const sourceFiles = [];
  const uniquePages = new Map();
  let inputPageRecords = 0;

  for (const auditFile of auditFiles) {
    let raw;
    try {
      raw = await readFile(auditFile.absolutePath, 'utf8');
    } catch (error) {
      fail(`cannot read ${auditFile.relativePath}: ${error.message}`);
    }
    let report;
    try {
      report = JSON.parse(raw);
    } catch (error) {
      fail(`${auditFile.relativePath} contains invalid JSON: ${error.message}`);
    }
    sourceFiles.push({
      path: auditFile.relativePath,
      sha256: sha256(raw),
    });
    const pages = validateAuditReport(
      auditFile.documentId,
      auditFile.relativePath,
      auditFile.filenameRange,
      report,
    );
    inputPageRecords += pages.length;
    for (const page of pages) {
      const existing = uniquePages.get(page.stable_locator);
      if (!existing) {
        uniquePages.set(page.stable_locator, page);
        continue;
      }
      if (JSON.stringify(comparablePage(existing)) !== JSON.stringify(comparablePage(page))) {
        fail(
          `conflicting duplicate page record for ${page.stable_locator} in `
          + `${existing.source_audit_paths.join(', ')} and ${page.source_audit_paths.join(', ')}`,
        );
      }
      existing.source_audit_paths = [...new Set([
        ...existing.source_audit_paths,
        ...page.source_audit_paths,
      ])].sort(compareText);
      existing.primary.paths = [...new Set([
        ...existing.primary.paths,
        ...page.primary.paths,
      ])].sort(compareText);
      existing.witness.paths = [...new Set([
        ...existing.witness.paths,
        ...page.witness.paths,
      ])].sort(compareText);
    }
  }

  const allUniquePages = [...uniquePages.values()].sort((left, right) => (
    compareText(left.document_id, right.document_id)
    || left.page - right.page
  ));
  const queue = allUniquePages
    .filter((page) => page.gate !== 'automatic_witness_pass')
    .sort((left, right) => (
      left.priority.rank - right.priority.rank
      || compareText(left.document_id, right.document_id)
      || left.page - right.page
    ));
  const priorityCodes = PRIORITY_ORDER.map((priority) => priority.code);
  const gateOrder = [
    'unresolved_fail_closed',
    'manual_image_review_required',
    'blank_page_visual_confirmation_required',
  ];

  return {
    schema_version: 1,
    artifact_type: 'ocr_review_queue',
    policy: {
      input_mode: 'read_only_audit_snapshot',
      publication_mutation: 'none',
      automatic_witness_pass_in_queue: false,
      duplicate_pages: 'collapse only hash-and-review-equivalent page evidence, retaining path aliases; conflicting duplicates fail closed',
      corrupt_or_incomplete_audits: 'fail the build and do not emit a replacement artifact',
      manual_review_agreement_min: MANUAL_REVIEW_AGREEMENT_MIN,
      automatic_vision_confidence_min: AUTOMATIC_VISION_CONFIDENCE_MIN,
      priority_order: PRIORITY_ORDER,
    },
    source_snapshot: {
      audit_file_count: sourceFiles.length,
      sha256: sha256(sourceFiles.map((file) => `${file.path}\0${file.sha256}`).join('\n')),
    },
    summary: {
      input_page_records: inputPageRecords,
      unique_pages: allUniquePages.length,
      duplicate_page_records: inputPageRecords - allUniquePages.length,
      queued_pages: queue.length,
      automatic_witness_pass_excluded: allUniquePages.length - queue.length,
      queued_by_priority: countBy(queue, (page) => page.priority.code, priorityCodes),
      queued_by_gate: countBy(queue, (page) => page.gate, gateOrder),
    },
    queue,
  };
}

export function parseOcrReviewQueueArgs(argv) {
  const values = {};
  const allowed = new Set(['--witness-root', '--output']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!allowed.has(argument)) fail(`unexpected argument: ${argument}`);
    if (Object.hasOwn(values, argument)) fail(`duplicate argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`missing value for ${argument}`);
    values[argument] = value;
    index += 1;
  }
  if (!values['--witness-root']) fail('--witness-root is required');
  if (!values['--output']) fail('--output is required');
  return {
    witnessRoot: values['--witness-root'],
    outputPath: values['--output'],
  };
}

export async function writeOcrReviewQueue({ witnessRoot, outputPath }) {
  const resolvedWitnessRoot = path.resolve(requireString(witnessRoot, 'witnessRoot'));
  const resolvedOutputPath = path.resolve(requireString(outputPath, 'outputPath'));
  const outputRelativeToWitness = path.relative(resolvedWitnessRoot, resolvedOutputPath);
  if (outputRelativeToWitness === ''
    || (!outputRelativeToWitness.startsWith(`..${path.sep}`) && outputRelativeToWitness !== '..')) {
    fail('output must be outside the read-only witness root');
  }
  const artifact = await buildOcrReviewQueue({ witnessRoot: resolvedWitnessRoot });
  await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return artifact;
}

async function main() {
  const options = parseOcrReviewQueueArgs(process.argv.slice(2));
  const artifact = await writeOcrReviewQueue(options);
  process.stdout.write(`${JSON.stringify(artifact.summary)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
