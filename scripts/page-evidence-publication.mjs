import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  validatePagePublicationManifest,
} from './page-publication-gate.mjs';
import {
  createSemanticPublicationGate,
} from './semantic-publication-gate.mjs';

export const PAGE_EVIDENCE_SCHEMA_VERSION = 1;
export const PAGE_EVIDENCE_POLICY = 'immutable_page_evidence_release_v1';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DOCUMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const REVIEWER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const PUBLICATION_DISPOSITIONS = new Set([
  'unresolved_fail_closed',
  'accepted_display_non_citation',
  'accepted_citation',
]);
const ONLINE_STATUS_VALUES = new Set([
  'verified_independent',
  'single_source_only',
  'not_found',
  'conflict',
]);
const EXACT_ONLINE_VERSION = 'exact_document_exact_edition';
export const IMAGE_ONLINE_ADJUDICATION_BASIS = [
  'source_scan_image',
  'adjudicated_final_text',
  'signed_human_review',
  'two_independent_exact_edition_online',
].join('+');

function fail(message) {
  throw new Error(`page evidence publication: ${message}`);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
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
  return value;
}

function requireString(value, label, pattern = null) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${label} must be a non-empty string`);
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

function requireSha256(value, label) {
  return requireString(value, label, SHA256_PATTERN);
}

function requireIsoUtc(value, label) {
  requireString(value, label);
  if (!ISO_UTC_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    fail(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return value;
}

function requireNullableString(value, label) {
  if (value === null) return null;
  return requireString(value, label);
}

function requireUniqueStrings(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
  }
  const seen = new Set();
  return value.map((entry, index) => {
    const text = requireString(entry, `${label}[${index}]`);
    if (seen.has(text)) fail(`${label} contains duplicate value ${text}`);
    seen.add(text);
    return text;
  });
}

export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepEqual(left, right) {
  return stableJson(left) === stableJson(right);
}

function normalizeLocator(locator, label) {
  requireString(locator, label);
  if (locator.includes('\\') || locator.includes('\0') || path.isAbsolute(locator)) {
    fail(`${label} must be a portable project-relative locator`);
  }
  const normalized = path.posix.normalize(locator);
  if (normalized !== locator || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    fail(`${label} must not contain traversal or normalization aliases`);
  }
  return locator;
}

function rootInfo(root) {
  const lexicalRoot = path.resolve(root);
  const actualRoot = realpathSync(lexicalRoot);
  return { lexicalRoot, actualRoot };
}

function resolveBoundPath(root, locator, label) {
  const normalized = normalizeLocator(locator, `${label}.locator`);
  const { lexicalRoot, actualRoot } = rootInfo(root);
  const lexicalPath = path.resolve(lexicalRoot, normalized);
  if (lexicalPath !== lexicalRoot && !lexicalPath.startsWith(`${lexicalRoot}${path.sep}`)) {
    fail(`${label}.locator escapes the project root`);
  }
  let actualPath;
  try {
    actualPath = realpathSync(lexicalPath);
  } catch (error) {
    fail(`${label}.locator is missing: ${error.code || error.message}`);
  }
  if (actualPath !== actualRoot && !actualPath.startsWith(`${actualRoot}${path.sep}`)) {
    fail(`${label}.locator resolves outside the project root`);
  }
  return { locator: normalized, path: actualPath };
}

function readRegularFileStable(absolutePath, label) {
  const descriptor = openSync(absolutePath, 'r');
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) fail(`${label} must resolve to a regular file`);
    const buffer = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || buffer.length !== after.size) {
      fail(`${label} changed while it was being verified`);
    }
    return buffer;
  } finally {
    closeSync(descriptor);
  }
}

function normalizeArtifactRef(ref, label) {
  requireExactKeys(ref, label, ['locator', 'sha256', 'bytes']);
  return {
    locator: normalizeLocator(ref.locator, `${label}.locator`),
    sha256: requireSha256(ref.sha256, `${label}.sha256`),
    bytes: requireInteger(ref.bytes, `${label}.bytes`, 1),
  };
}

export function readBoundArtifact({ root, ref, label = 'artifact', allowEmpty = false }) {
  const normalized = normalizeArtifactRef(ref, label);
  const resolved = resolveBoundPath(root, normalized.locator, label);
  const buffer = readRegularFileStable(resolved.path, label);
  if (!allowEmpty && buffer.length === 0) fail(`${label} must not be empty`);
  const actual = {
    locator: normalized.locator,
    sha256: sha256Buffer(buffer),
    bytes: buffer.length,
  };
  if (actual.sha256 !== normalized.sha256) fail(`${label}.sha256 does not match the actual file`);
  if (actual.bytes !== normalized.bytes) fail(`${label}.bytes does not match the actual file`);
  return { ...actual, path: resolved.path, buffer };
}

function parseJsonBuffer(buffer, label) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function readBoundJson({ root, ref, label }) {
  const artifact = readBoundArtifact({ root, ref, label });
  return { artifact, value: parseJsonBuffer(artifact.buffer, label) };
}

function executableCandidates(explicitPath) {
  if (explicitPath) return [explicitPath];
  if (process.env.PAGE_EVIDENCE_RENDERER) return [process.env.PAGE_EVIDENCE_RENDERER];
  const fromPath = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, 'mutool'));
  return ['/opt/homebrew/bin/mutool', ...fromPath];
}

function locateRenderer(explicitPath) {
  const candidate = executableCandidates(explicitPath).find((entry) => existsSync(entry));
  if (!candidate) fail('MuPDF mutool renderer is unavailable');
  const actualPath = realpathSync(candidate);
  const descriptor = openSync(actualPath, 'r');
  try {
    if (!fstatSync(descriptor).isFile()) fail('MuPDF mutool renderer must be a regular file');
  } finally {
    closeSync(descriptor);
  }
  return actualPath;
}

function runRenderer(rendererPath, args, label) {
  const result = spawnSync(rendererPath, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) fail(`${label} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = `${result.stderr || result.stdout || ''}`.trim().slice(0, 800);
    fail(`${label} failed with exit ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return `${result.stdout || ''}${result.stderr || ''}`.trim();
}

export function inspectMutoolRenderer(rendererPath = null) {
  const actualPath = locateRenderer(rendererPath);
  const buffer = readRegularFileStable(actualPath, 'renderer binary');
  const version = runRenderer(actualPath, ['-v'], 'mutool version');
  requireString(version, 'renderer version');
  return {
    path: actualPath,
    sha256: sha256Buffer(buffer),
    bytes: buffer.length,
    version,
  };
}

function pdfPageCount(rendererPath, sourcePath) {
  const output = runRenderer(rendererPath, ['info', sourcePath, '1'], 'PDF page count inspection');
  const match = output.match(/^Pages:\s+(\d+)\s*$/m);
  if (!match) fail('mutool info did not report an unambiguous PDF page count');
  return Number(match[1]);
}

function pngDimensions(buffer, label) {
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
    fail(`${label} is not a PNG with a readable IHDR`);
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export function renderPdfPage({ sourcePath, pageNumber, dpi, rendererPath = null }) {
  requireInteger(pageNumber, 'pageNumber', 1);
  requireInteger(dpi, 'dpi', 72);
  if (dpi > 600) fail('dpi must be <= 600');
  const renderer = inspectMutoolRenderer(rendererPath);
  const pageCount = pdfPageCount(renderer.path, sourcePath);
  if (pageNumber > pageCount) fail(`physical PDF page ${pageNumber} exceeds actual page count ${pageCount}`);
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'curriculum-page-evidence-'));
  const outputPath = path.join(temporaryDirectory, 'page.png');
  try {
    runRenderer(
      renderer.path,
      ['draw', '-q', '-F', 'png', '-r', String(dpi), '-o', outputPath, sourcePath, String(pageNumber)],
      'deterministic page render',
    );
    const buffer = readRegularFileStable(outputPath, 'temporary rendered page');
    const dimensions = pngDimensions(buffer, 'temporary rendered page');
    return {
      renderer,
      page_count: pageCount,
      sha256: sha256Buffer(buffer),
      bytes: buffer.length,
      width: dimensions.width,
      height: dimensions.height,
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function textual(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^[#>*+\-]+/gm, '')
    .normalize('NFKC');
}

export function normalizeOcrComparisonText(value) {
  return textual(value).replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '').toLocaleLowerCase('zh-CN');
}

function normalizedSnapshotText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('zh-CN');
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
    const rightCharacter = right.charCodeAt(row - 1);
    for (let column = 1; column <= left.length; column += 1) {
      const substitution = previous[column - 1]
        + (left.charCodeAt(column - 1) === rightCharacter ? 0 : 1);
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, substitution);
    }
    [previous, current] = [current, previous];
  }
  return previous[left.length];
}

function sameHeading(left, right) {
  const normalizedLeft = normalizeOcrComparisonText(left);
  const normalizedRight = normalizeOcrComparisonText(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft === normalizedRight
    || normalizedLeft.includes(normalizedRight)
    || normalizedRight.includes(normalizedLeft);
}

function normalizeCriticalFields(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const ids = new Set();
  return value.map((field, index) => {
    const fieldLabel = `${label}[${index}]`;
    requireExactKeys(field, fieldLabel, ['field_id', 'kind', 'primary', 'witness']);
    const fieldId = requireString(field.field_id, `${fieldLabel}.field_id`);
    if (ids.has(fieldId)) fail(`${label} contains duplicate field_id ${fieldId}`);
    ids.add(fieldId);
    return {
      field_id: fieldId,
      kind: requireString(field.kind, `${fieldLabel}.kind`),
      primary: requireString(field.primary, `${fieldLabel}.primary`),
      witness: requireString(field.witness, `${fieldLabel}.witness`),
    };
  });
}

export function recomputeAuditPage({ primaryText, visionSidecar }) {
  requireObject(visionSidecar, 'vision sidecar');
  if (!Array.isArray(visionSidecar.lines)) fail('vision sidecar.lines must be an array');
  const witnessText = visionSidecar.lines.map((line, index) => {
    requireObject(line, `vision sidecar.lines[${index}]`);
    requireString(line.text, `vision sidecar.lines[${index}].text`);
    return line.text;
  }).join('\n');
  const primaryNormalized = normalizeOcrComparisonText(primaryText);
  const witnessNormalized = normalizeOcrComparisonText(witnessText);
  const distance = editDistance(primaryNormalized, witnessNormalized);
  const agreement = 1 - distance / Math.max(1, primaryNormalized.length, witnessNormalized.length);
  const primaryNumbers = numbers(primaryText);
  const witnessNumbers = numbers(witnessText);
  const numericExact = deepEqual(primaryNumbers, witnessNumbers);
  const titleExact = sameHeading(heading(primaryText), heading(witnessText));
  const criticalFields = normalizeCriticalFields(visionSidecar.critical_fields, 'vision sidecar.critical_fields');
  const criticalFieldsExact = criticalFields.length > 0 && criticalFields.every((field) => {
    const primaryValue = normalizeOcrComparisonText(field.primary);
    const witnessValue = normalizeOcrComparisonText(field.witness);
    return primaryValue.length > 0 && primaryValue === witnessValue;
  });
  const tableDetected = /<table\b|<tr\b|<td\b/i.test(primaryText);
  const confidences = visionSidecar.lines
    .map((line) => Number(line.confidence))
    .filter(Number.isFinite);
  const averageVisionConfidence = confidences.length
    ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
    : 0;
  let gate = 'unresolved_fail_closed';
  if (!primaryNormalized && !witnessNormalized) gate = 'blank_page_visual_confirmation_required';
  else if (agreement >= 0.995 && numericExact && titleExact && criticalFieldsExact
    && !tableDetected && averageVisionConfidence >= 0.8) gate = 'automatic_witness_pass';
  else if (agreement >= 0.985 && titleExact) gate = 'manual_image_review_required';
  return {
    witness_text: witnessText,
    primary_sha256: sha256Buffer(Buffer.from(primaryText, 'utf8')),
    witness_sha256: sha256Buffer(Buffer.from(witnessText, 'utf8')),
    normalized_character_agreement: Number(agreement.toFixed(6)),
    edit_distance: distance,
    primary_character_count: primaryNormalized.length,
    witness_character_count: witnessNormalized.length,
    title_exact: titleExact,
    primary_heading: heading(primaryText),
    witness_heading: heading(witnessText),
    numeric_sequence_exact: numericExact,
    primary_numbers: primaryNumbers,
    witness_numbers: witnessNumbers,
    critical_fields: criticalFields,
    critical_fields_declared: criticalFields.length,
    critical_fields_exact: criticalFieldsExact,
    table_detected: tableDetected,
    average_vision_confidence: Number(averageVisionConfidence.toFixed(6)),
    low_confidence_line_count: confidences.filter((value) => value < 0.8).length,
    gate,
  };
}

function normalizeVersionIdentity(value, label) {
  requireExactKeys(value, label, [
    'title',
    'issuing_body_or_author',
    'year_or_publication_context',
    'version_label',
    'section_or_item_locator',
  ]);
  return {
    title: requireString(value.title, `${label}.title`),
    issuing_body_or_author: requireString(value.issuing_body_or_author, `${label}.issuing_body_or_author`),
    year_or_publication_context: requireString(value.year_or_publication_context, `${label}.year_or_publication_context`),
    version_label: requireString(value.version_label, `${label}.version_label`),
    section_or_item_locator: requireString(value.section_or_item_locator, `${label}.section_or_item_locator`),
  };
}

export function catalogVersionIdentity(record, pageNumber) {
  requireObject(record, 'catalog record');
  requireString(record.id, 'catalog record.id', DOCUMENT_ID_PATTERN);
  requireInteger(pageNumber, 'physical PDF page', 1);
  return {
    title: requireString(record.title, `${record.id}.title`),
    issuing_body_or_author: requireString(
      record.issued_by || record.author,
      `${record.id}.issued_by_or_author`,
    ),
    year_or_publication_context: requireString(
      record.published_date || record.issued_date || record.year || record.version_label,
      `${record.id}.year_or_publication_context`,
    ),
    version_label: requireString(record.version_label, `${record.id}.version_label`),
    section_or_item_locator: `${record.id}:page:${pageNumber}`,
  };
}

function catalogRecords(catalog) {
  requireExactKeys(catalog, 'catalog', [
    'schema_version',
    'generated_at',
    'source_policy',
    'counts',
    'documents',
  ]);
  if (!Array.isArray(catalog.documents)) fail('catalog.documents must be an array');
  const ids = new Set();
  for (const [index, record] of catalog.documents.entries()) {
    requireObject(record, `catalog.documents[${index}]`);
    const id = requireString(record.id, `catalog.documents[${index}].id`, DOCUMENT_ID_PATTERN);
    if (ids.has(id)) fail(`catalog contains duplicate document id ${id}`);
    ids.add(id);
    if (typeof record.citation_allowed !== 'boolean') fail(`${id}.citation_allowed must be a boolean`);
  }
  return catalog.documents;
}

function normalizeReleaseManifest(manifest) {
  requireExactKeys(manifest, 'release', [
    'schema_version',
    'policy',
    'status',
    'authority_registry',
    'bindings',
    'bundles',
    'expected_publication',
    'unresolved_reasons',
  ], ['$schema']);
  if (manifest.schema_version !== PAGE_EVIDENCE_SCHEMA_VERSION) fail('release.schema_version must equal 1');
  if (manifest.policy !== PAGE_EVIDENCE_POLICY) fail(`release.policy must equal ${PAGE_EVIDENCE_POLICY}`);
  if (!['unresolved_fail_closed', 'publication_candidate'].includes(manifest.status)) {
    fail('release.status is invalid');
  }
  normalizeArtifactRef(manifest.authority_registry, 'release.authority_registry');
  requireExactKeys(manifest.bindings, 'release.bindings', [
    'catalog',
    'page_publication_manifest',
    'semantic_publication_policy',
    'online_verification_standard',
  ]);
  for (const [key, ref] of Object.entries(manifest.bindings)) {
    normalizeArtifactRef(ref, `release.bindings.${key}`);
  }
  if (!Array.isArray(manifest.bundles)) fail('release.bundles must be an array');
  const bundleKeys = new Set();
  for (const [index, entry] of manifest.bundles.entries()) {
    const label = `release.bundles[${index}]`;
    requireExactKeys(entry, label, ['document_id', 'page_number', 'stable_locator', 'bundle']);
    const documentId = requireString(entry.document_id, `${label}.document_id`, DOCUMENT_ID_PATTERN);
    const pageNumber = requireInteger(entry.page_number, `${label}.page_number`, 1);
    if (entry.stable_locator !== `${documentId}:page:${pageNumber}`) {
      fail(`${label}.stable_locator does not bind its document and physical page`);
    }
    normalizeArtifactRef(entry.bundle, `${label}.bundle`);
    const key = `${documentId}:${pageNumber}`;
    if (bundleKeys.has(key)) fail(`release contains duplicate page bundle ${key}`);
    bundleKeys.add(key);
  }
  requireExactKeys(manifest.expected_publication, 'release.expected_publication', [
    'documents',
    'pages',
    'display_pages',
    'citation_pages',
    'resolved_semantic_controls',
  ]);
  for (const [key, value] of Object.entries(manifest.expected_publication)) {
    requireInteger(value, `release.expected_publication.${key}`, 0);
  }
  const unresolvedReasons = requireUniqueStrings(
    manifest.unresolved_reasons,
    'release.unresolved_reasons',
    { allowEmpty: true },
  );
  if (manifest.status === 'unresolved_fail_closed' && unresolvedReasons.length === 0) {
    fail('release.unresolved_reasons must explain a fail-closed release');
  }
  if (manifest.status === 'publication_candidate' && unresolvedReasons.length > 0) {
    fail('publication_candidate cannot retain unresolved_reasons');
  }
  return manifest;
}

function normalizeAuthorityRegistry(registry) {
  requireExactKeys(registry, 'authority registry', ['schema_version', 'policy', 'reviewers'], ['$schema']);
  if (registry.schema_version !== 1) fail('authority registry.schema_version must equal 1');
  if (registry.policy !== 'pinned_ed25519_page_reviewers_v1') {
    fail('authority registry.policy must equal pinned_ed25519_page_reviewers_v1');
  }
  if (!Array.isArray(registry.reviewers)) fail('authority registry.reviewers must be an array');
  const byId = new Map();
  const reviewers = registry.reviewers.map((reviewer, index) => {
    const label = `authority registry.reviewers[${index}]`;
    requireExactKeys(reviewer, label, [
      'reviewer_id',
      'display_name',
      'status',
      'valid_from',
      'valid_until',
      'scopes',
      'public_key_pem',
    ]);
    const reviewerId = requireString(reviewer.reviewer_id, `${label}.reviewer_id`, REVIEWER_ID_PATTERN);
    if (byId.has(reviewerId)) fail(`authority registry contains duplicate reviewer ${reviewerId}`);
    if (!['active', 'revoked'].includes(reviewer.status)) fail(`${label}.status is invalid`);
    const validFrom = requireIsoUtc(reviewer.valid_from, `${label}.valid_from`);
    const validUntil = reviewer.valid_until === null
      ? null
      : requireIsoUtc(reviewer.valid_until, `${label}.valid_until`);
    if (validUntil && Date.parse(validUntil) <= Date.parse(validFrom)) fail(`${label} validity range is empty`);
    const scopes = requireUniqueStrings(reviewer.scopes, `${label}.scopes`, { allowEmpty: false });
    for (const scope of scopes) {
      if (!['page_display', 'page_citation', 'semantic_resolution'].includes(scope)) {
        fail(`${label}.scopes contains invalid scope ${scope}`);
      }
    }
    const normalized = {
      reviewer_id: reviewerId,
      display_name: requireString(reviewer.display_name, `${label}.display_name`),
      status: reviewer.status,
      valid_from: validFrom,
      valid_until: validUntil,
      scopes,
      public_key_pem: requireString(reviewer.public_key_pem, `${label}.public_key_pem`),
    };
    try {
      const key = createPublicKey(normalized.public_key_pem);
      if (key.asymmetricKeyType !== 'ed25519') fail(`${label}.public_key_pem must be an Ed25519 public key`);
    } catch (error) {
      if (String(error.message).startsWith('page evidence publication:')) throw error;
      fail(`${label}.public_key_pem is invalid: ${error.message}`);
    }
    byId.set(reviewerId, normalized);
    return normalized;
  });
  return { ...registry, reviewers, byId };
}

function normalizeBundle(bundle) {
  requireExactKeys(bundle, 'bundle', [
    'schema_version',
    'policy',
    'document_id',
    'physical_pdf_page',
    'page_count',
    'stable_locator',
    'version_identity',
    'rendered_page',
    'artifacts',
  ], ['$schema']);
  if (bundle.schema_version !== 1) fail('bundle.schema_version must equal 1');
  if (bundle.policy !== 'immutable_page_evidence_bundle_v1') {
    fail('bundle.policy must equal immutable_page_evidence_bundle_v1');
  }
  const documentId = requireString(bundle.document_id, 'bundle.document_id', DOCUMENT_ID_PATTERN);
  const pageNumber = requireInteger(bundle.physical_pdf_page, 'bundle.physical_pdf_page', 1);
  const pageCount = requireInteger(bundle.page_count, 'bundle.page_count', 1);
  if (pageNumber > pageCount) fail('bundle.physical_pdf_page exceeds bundle.page_count');
  if (bundle.stable_locator !== `${documentId}:page:${pageNumber}`) {
    fail('bundle.stable_locator does not bind the document and physical page');
  }
  normalizeVersionIdentity(bundle.version_identity, 'bundle.version_identity');
  requireExactKeys(bundle.rendered_page, 'bundle.rendered_page', [
    'mode',
    'command_contract',
    'renderer_sha256',
    'renderer_version',
    'dpi',
    'format',
    'sha256',
    'bytes',
    'width',
    'height',
  ]);
  if (bundle.rendered_page.mode !== 'reproducible_render_v1') {
    fail('bundle.rendered_page.mode must equal reproducible_render_v1');
  }
  if (bundle.rendered_page.command_contract !== 'mutool_draw_png_page_v1') {
    fail('bundle.rendered_page.command_contract must equal mutool_draw_png_page_v1');
  }
  if (bundle.rendered_page.format !== 'png') fail('bundle.rendered_page.format must equal png');
  requireSha256(bundle.rendered_page.renderer_sha256, 'bundle.rendered_page.renderer_sha256');
  requireString(bundle.rendered_page.renderer_version, 'bundle.rendered_page.renderer_version');
  requireInteger(bundle.rendered_page.dpi, 'bundle.rendered_page.dpi', 72);
  if (bundle.rendered_page.dpi > 600) fail('bundle.rendered_page.dpi must be <= 600');
  requireSha256(bundle.rendered_page.sha256, 'bundle.rendered_page.sha256');
  requireInteger(bundle.rendered_page.bytes, 'bundle.rendered_page.bytes', 1);
  requireInteger(bundle.rendered_page.width, 'bundle.rendered_page.width', 1);
  requireInteger(bundle.rendered_page.height, 'bundle.rendered_page.height', 1);
  const artifactKeys = [
    'source_pdf',
    'primary_result',
    'primary_content',
    'primary_state',
    'vision_sidecar',
    'audit',
    'final_text',
    'online_claims',
    'reviewer_decision',
  ];
  requireExactKeys(bundle.artifacts, 'bundle.artifacts', artifactKeys);
  for (const key of artifactKeys) normalizeArtifactRef(bundle.artifacts[key], `bundle.artifacts.${key}`);
  return bundle;
}

function expectedAuditPageSubset(audit) {
  return {
    primary_sha256: audit.primary_sha256,
    witness_sha256: audit.witness_sha256,
    normalized_character_agreement: audit.normalized_character_agreement,
    edit_distance: audit.edit_distance,
    primary_character_count: audit.primary_character_count,
    witness_character_count: audit.witness_character_count,
    title_exact: audit.title_exact,
    primary_heading: audit.primary_heading,
    witness_heading: audit.witness_heading,
    numeric_sequence_exact: audit.numeric_sequence_exact,
    primary_numbers: audit.primary_numbers,
    witness_numbers: audit.witness_numbers,
    critical_fields_declared: audit.critical_fields_declared,
    critical_fields_exact: audit.critical_fields_exact,
    table_detected: audit.table_detected,
    average_vision_confidence: audit.average_vision_confidence,
    low_confidence_line_count: audit.low_confidence_line_count,
    gate: audit.gate,
  };
}

function validateAuditObject(auditReport, physicalPage, recomputed) {
  requireObject(auditReport, 'audit report');
  if (auditReport.schema_version !== 1) fail('audit report.schema_version must equal 1');
  if (!Array.isArray(auditReport.pages)) fail('audit report.pages must be an array');
  const matching = auditReport.pages.filter((page) => page?.page === physicalPage);
  if (matching.length !== 1) fail(`audit report must contain exactly one object for physical page ${physicalPage}`);
  const actualPage = matching[0];
  if (!deepEqual(expectedAuditPageSubset(actualPage), expectedAuditPageSubset(recomputed))) {
    fail(`audit report page ${physicalPage} does not match recomputed OCR/Vision comparison`);
  }
  if (Array.isArray(auditReport.page_range)) {
    if (auditReport.page_range.length !== 2
      || physicalPage < auditReport.page_range[0]
      || physicalPage > auditReport.page_range[1]) {
      fail('audit report.page_range does not contain the bound physical page');
    }
  }
  if (auditReport.summary) {
    const gates = [
      'automatic_witness_pass',
      'manual_image_review_required',
      'blank_page_visual_confirmation_required',
      'unresolved_fail_closed',
    ];
    const expectedSummary = { pages: auditReport.pages.length };
    for (const gate of gates) expectedSummary[gate] = auditReport.pages.filter((page) => page.gate === gate).length;
    if (!deepEqual(auditReport.summary, expectedSummary)) fail('audit report.summary is not derived from its page objects');
  }
  return actualPage;
}

function validatePrimaryObjects({ record, bundle, sourceArtifact, primaryResult, primaryContent, primaryState, rendered }) {
  const documentId = bundle.document_id;
  const pageNumber = bundle.physical_pdf_page;
  requireObject(primaryResult, 'primary result');
  requireObject(primaryState, 'primary state');
  if (primaryState.document_id !== documentId) fail('primary state.document_id mismatch');
  if (primaryState.source_sha256 !== sourceArtifact.sha256) fail('primary state.source_sha256 mismatch');
  if (primaryState.page_count !== rendered.page_count) fail('primary state.page_count mismatch');
  if (!Array.isArray(primaryState.completed_pages) || !primaryState.completed_pages.includes(pageNumber)) {
    fail('primary state does not mark the physical page complete');
  }
  const failedPages = primaryState.failed_pages;
  if (Array.isArray(failedPages) ? failedPages.includes(pageNumber) : Boolean(failedPages?.[String(pageNumber)])) {
    fail('primary state marks the physical page failed');
  }
  const pageState = primaryState.pages?.[String(pageNumber)];
  requireObject(pageState, `primary state.pages.${pageNumber}`);
  if (pageState.physical_pdf_page !== pageNumber) fail('primary state physical page mismatch');
  if (pageState.result_json_sha256 !== bundle.artifacts.primary_result.sha256) {
    fail('primary state result hash does not match the actual bound primary result');
  }
  if (pageState.content_markdown_sha256 !== bundle.artifacts.primary_content.sha256) {
    fail('primary state content hash does not match the actual bound primary content');
  }
  requireSha256(pageState.rendered_image_sha256, 'primary state rendered_image_sha256');
  if (!['ocr_complete_pending_audit', 'accepted_after_audit'].includes(pageState.status)) {
    fail('primary state page status is not a completed OCR state');
  }
  if (pageState.citation_eligible !== false) fail('primary state citation_eligible must remain false');
  const configuredDpi = primaryState.configuration?.dpi;
  if (configuredDpi !== bundle.rendered_page.dpi) fail('primary state OCR DPI differs from the reproducible render DPI');
  const expectedImageName = `page-${String(pageNumber).padStart(4, '0')}.png`;
  if (typeof primaryResult.input_path !== 'string' || path.basename(primaryResult.input_path) !== expectedImageName) {
    fail(`primary result.input_path must identify ${expectedImageName}`);
  }
  if (primaryResult.width !== rendered.width || primaryResult.height !== rendered.height) {
    fail('primary result dimensions differ from the reproducible source-page render');
  }
  if (record.page_count !== rendered.page_count) fail('catalog page_count differs from the actual PDF');
  if (typeof primaryContent !== 'string') fail('primary content must be UTF-8 text');
}

function validateVisionSidecar({ bundle, sourceArtifact, visionSidecar, rendered }) {
  requireObject(visionSidecar, 'vision sidecar');
  if (visionSidecar.schema_version !== 2) fail('vision sidecar.schema_version must equal 2');
  if (visionSidecar.document_id !== bundle.document_id) fail('vision sidecar.document_id mismatch');
  if (visionSidecar.physical_pdf_page !== bundle.physical_pdf_page) {
    fail('vision sidecar.physical_pdf_page mismatch');
  }
  if (visionSidecar.source_pdf_sha256 !== sourceArtifact.sha256) {
    fail('vision sidecar.source_pdf_sha256 mismatch');
  }
  if (visionSidecar.rendered_image_sha256 !== rendered.sha256) {
    fail('vision sidecar.rendered_image_sha256 differs from the fresh PDF render');
  }
  if (visionSidecar.rendered_image_bytes !== rendered.bytes) {
    fail('vision sidecar.rendered_image_bytes differs from the fresh PDF render');
  }
  if (visionSidecar.engine_configuration?.render_dpi !== bundle.rendered_page.dpi) {
    fail('vision sidecar render DPI differs from the evidence bundle');
  }
  if (typeof visionSidecar.engine !== 'string' || !/Apple Vision|VNRecognizeTextRequest/i.test(visionSidecar.engine)) {
    fail('vision sidecar.engine must identify Apple Vision independent OCR');
  }
  if (visionSidecar.citation_allowed !== false) fail('vision sidecar.citation_allowed must remain false');
  if (!Array.isArray(visionSidecar.lines)) fail('vision sidecar.lines must be an array');
  for (const [index, line] of visionSidecar.lines.entries()) {
    requireExactKeys(line, `vision sidecar.lines[${index}]`, ['confidence', 'text']);
    if (!Number.isFinite(Number(line.confidence)) || Number(line.confidence) < 0 || Number(line.confidence) > 1) {
      fail(`vision sidecar.lines[${index}].confidence must be between 0 and 1`);
    }
    if (typeof line.text !== 'string') fail(`vision sidecar.lines[${index}].text must be a string`);
  }
  return normalizeCriticalFields(visionSidecar.critical_fields, 'vision sidecar.critical_fields');
}

function validateOnlineClaims({ root, onlineClaims, bundle }) {
  requireExactKeys(onlineClaims, 'online claims', [
    'schema_version',
    'policy',
    'document_id',
    'physical_pdf_page',
    'stable_locator',
    'target_version',
    'same_version_status',
    'claims',
  ], ['$schema']);
  if (onlineClaims.schema_version !== 1) fail('online claims.schema_version must equal 1');
  if (onlineClaims.policy !== 'version_aware_online_page_claims_v1') {
    fail('online claims.policy must equal version_aware_online_page_claims_v1');
  }
  if (onlineClaims.document_id !== bundle.document_id) fail('online claims.document_id mismatch');
  if (onlineClaims.physical_pdf_page !== bundle.physical_pdf_page) {
    fail('online claims.physical_pdf_page mismatch');
  }
  if (onlineClaims.stable_locator !== bundle.stable_locator) fail('online claims.stable_locator mismatch');
  const targetVersion = normalizeVersionIdentity(onlineClaims.target_version, 'online claims.target_version');
  if (!deepEqual(targetVersion, bundle.version_identity)) {
    fail('online claims.target_version differs from the exact catalog/PDF version identity');
  }
  if (!ONLINE_STATUS_VALUES.has(onlineClaims.same_version_status)) {
    fail('online claims.same_version_status is invalid');
  }
  if (!Array.isArray(onlineClaims.claims)) fail('online claims.claims must be an array');
  const ids = new Set();
  const claims = onlineClaims.claims.map((claim, index) => {
    const label = `online claims.claims[${index}]`;
    requireExactKeys(claim, label, [
      'claim_id',
      'document_id',
      'physical_pdf_page',
      'stable_locator',
      'url',
      'publisher',
      'source_type',
      'retrieved_at',
      'version_match',
      'observed_version',
      'snapshot',
      'supporting_text',
      'supporting_text_sha256',
    ]);
    const claimId = requireString(claim.claim_id, `${label}.claim_id`);
    if (ids.has(claimId)) fail(`online claims contains duplicate claim_id ${claimId}`);
    ids.add(claimId);
    if (claim.document_id !== bundle.document_id
      || claim.physical_pdf_page !== bundle.physical_pdf_page
      || claim.stable_locator !== bundle.stable_locator) {
      fail(`${label} is not bound to the same actual PDF page`);
    }
    let url;
    try {
      url = new URL(requireString(claim.url, `${label}.url`));
    } catch (error) {
      fail(`${label}.url is invalid: ${error.message}`);
    }
    if (url.protocol !== 'https:') fail(`${label}.url must use HTTPS`);
    const publisher = requireString(claim.publisher, `${label}.publisher`);
    const sourceType = requireString(claim.source_type, `${label}.source_type`);
    if (!['official', 'official_archive', 'academic', 'scholarly_database', 'official_library'].includes(sourceType)) {
      fail(`${label}.source_type is not an official or academic source class`);
    }
    requireIsoUtc(claim.retrieved_at, `${label}.retrieved_at`);
    if (![
      EXACT_ONLINE_VERSION,
      'exact_document_revision_uncertain',
      'same_work_different_edition',
      'stable_fact_only',
      'not_matched',
    ].includes(claim.version_match)) fail(`${label}.version_match is invalid`);
    const observedVersion = normalizeVersionIdentity(claim.observed_version, `${label}.observed_version`);
    if (claim.version_match === EXACT_ONLINE_VERSION && !deepEqual(observedVersion, targetVersion)) {
      fail(`${label} claims an exact edition but its observed version is different`);
    }
    if (claim.version_match !== EXACT_ONLINE_VERSION && deepEqual(observedVersion, targetVersion)) {
      fail(`${label} labels an exact observed version as non-exact`);
    }
    const snapshot = readBoundArtifact({ root, ref: claim.snapshot, label: `${label}.snapshot` });
    const supportingText = requireString(claim.supporting_text, `${label}.supporting_text`);
    const supportingHash = sha256Buffer(Buffer.from(supportingText, 'utf8'));
    if (claim.supporting_text_sha256 !== supportingHash) {
      fail(`${label}.supporting_text_sha256 does not match the actual supporting text`);
    }
    const normalizedSnapshot = normalizedSnapshotText(decodeUtf8(snapshot.buffer, `${label}.snapshot`));
    const normalizedSupport = normalizedSnapshotText(supportingText);
    if (!normalizedSnapshot.includes(normalizedSupport)) {
      fail(`${label}.supporting_text is absent from the bound online snapshot`);
    }
    return {
      claim_id: claimId,
      document_id: claim.document_id,
      physical_pdf_page: claim.physical_pdf_page,
      stable_locator: claim.stable_locator,
      url: url.toString(),
      host: url.hostname.replace(/^www\./i, '').toLocaleLowerCase('en-US'),
      publisher,
      publisher_key: publisher.normalize('NFKC').trim().toLocaleLowerCase('zh-CN'),
      source_type: sourceType,
      retrieved_at: claim.retrieved_at,
      version_match: claim.version_match,
      observed_version: observedVersion,
      snapshot: {
        locator: snapshot.locator,
        sha256: snapshot.sha256,
        bytes: snapshot.bytes,
        normalized_sha256: sha256Buffer(Buffer.from(normalizedSnapshot, 'utf8')),
      },
      supporting_text: supportingText,
      supporting_text_sha256: supportingHash,
    };
  });
  const exactClaims = claims.filter((claim) => claim.version_match === EXACT_ONLINE_VERSION);
  if (onlineClaims.same_version_status === 'verified_independent') {
    if (exactClaims.length < 2) fail('verified_independent requires at least two exact-edition page claims');
    if (new Set(exactClaims.map((claim) => claim.host)).size !== exactClaims.length) {
      fail('verified_independent claims reuse the same source host');
    }
    if (new Set(exactClaims.map((claim) => claim.publisher_key)).size !== exactClaims.length) {
      fail('verified_independent claims reuse the same publisher');
    }
    if (new Set(exactClaims.map((claim) => claim.snapshot.normalized_sha256)).size !== exactClaims.length) {
      fail('verified_independent claims are same-content mirrors');
    }
  } else if (onlineClaims.same_version_status === 'single_source_only') {
    if (exactClaims.length !== 1) fail('single_source_only requires exactly one exact-edition page claim');
  } else if (onlineClaims.same_version_status === 'not_found') {
    if (onlineClaims.claims.length !== 0) fail('not_found must not contain an unverified text claim');
  } else if (onlineClaims.same_version_status === 'conflict') {
    if (onlineClaims.claims.length === 0) fail('conflict must retain the conflicting source evidence');
    if (exactClaims.length >= 2) fail('conflict cannot contain two independently verified exact-edition claims');
  }
  return {
    target_version: targetVersion,
    same_version_status: onlineClaims.same_version_status,
    claims,
    exact_claims: exactClaims,
  };
}

function normalizeReviewDecision(decision) {
  requireExactKeys(decision, 'review decision', [
    'schema_version',
    'policy',
    'reviewer_id',
    'decided_at',
    'disposition',
    'display_allowed',
    'citation_allowed',
    'online_same_version_status',
    'critical_fields_complete',
    'critical_field_decisions',
    'semantic_control_ids',
    'semantic_control_bindings',
    'uncertainty_note',
    'signature_algorithm',
    'signed_payload_sha256',
    'signature_base64',
  ], ['$schema']);
  if (decision.schema_version !== 1) fail('review decision.schema_version must equal 1');
  if (decision.policy !== 'signed_page_review_decision_v1') {
    fail('review decision.policy must equal signed_page_review_decision_v1');
  }
  const reviewerId = requireString(decision.reviewer_id, 'review decision.reviewer_id', REVIEWER_ID_PATTERN);
  const decidedAt = requireIsoUtc(decision.decided_at, 'review decision.decided_at');
  if (!PUBLICATION_DISPOSITIONS.has(decision.disposition)) fail('review decision.disposition is invalid');
  const displayAllowed = requireBoolean(decision.display_allowed, 'review decision.display_allowed');
  const citationAllowed = requireBoolean(decision.citation_allowed, 'review decision.citation_allowed');
  if (citationAllowed && !displayAllowed) fail('review decision cannot allow citation while display is closed');
  if (!ONLINE_STATUS_VALUES.has(decision.online_same_version_status)) {
    fail('review decision.online_same_version_status is invalid');
  }
  const criticalFieldsComplete = requireBoolean(
    decision.critical_fields_complete,
    'review decision.critical_fields_complete',
  );
  if (!Array.isArray(decision.critical_field_decisions)) {
    fail('review decision.critical_field_decisions must be an array');
  }
  const fieldIds = new Set();
  const criticalFieldDecisions = decision.critical_field_decisions.map((field, index) => {
    const label = `review decision.critical_field_decisions[${index}]`;
    requireExactKeys(field, label, [
      'field_id',
      'status',
      'accepted_text',
      'basis',
      'deviating_engines',
      'note',
    ]);
    const fieldId = requireString(field.field_id, `${label}.field_id`);
    if (fieldIds.has(fieldId)) fail(`review decision repeats critical field ${fieldId}`);
    fieldIds.add(fieldId);
    if (!['verified_exact', 'image_online_adjudicated', 'human_judgment_with_warning'].includes(field.status)) {
      fail(`${label}.status is invalid`);
    }
    const deviatingEngines = requireUniqueStrings(
      field.deviating_engines,
      `${label}.deviating_engines`,
      { allowEmpty: true },
    );
    for (const engine of deviatingEngines) {
      if (!['primary_ocr', 'vision_ocr'].includes(engine)) {
        fail(`${label}.deviating_engines contains invalid engine ${engine}`);
      }
    }
    const note = requireNullableString(field.note, `${label}.note`);
    if (field.status !== 'verified_exact' && !note) {
      fail(`${label}.note is required for an adjudication or human judgment warning`);
    }
    return {
      field_id: fieldId,
      status: field.status,
      accepted_text: requireString(field.accepted_text, `${label}.accepted_text`),
      basis: requireString(field.basis, `${label}.basis`),
      deviating_engines: deviatingEngines,
      note,
    };
  });
  const semanticControlIds = requireUniqueStrings(
    decision.semantic_control_ids,
    'review decision.semantic_control_ids',
    { allowEmpty: true },
  );
  if (!Array.isArray(decision.semantic_control_bindings)) {
    fail('review decision.semantic_control_bindings must be an array');
  }
  const semanticBindingIds = new Set();
  const semanticControlBindings = decision.semantic_control_bindings.map((binding, index) => {
    const label = `review decision.semantic_control_bindings[${index}]`;
    requireExactKeys(binding, label, ['control_id', 'control_sha256']);
    const controlId = requireString(binding.control_id, `${label}.control_id`);
    if (semanticBindingIds.has(controlId)) fail(`review decision repeats semantic binding ${controlId}`);
    semanticBindingIds.add(controlId);
    return {
      control_id: controlId,
      control_sha256: requireSha256(binding.control_sha256, `${label}.control_sha256`),
    };
  });
  if (!deepEqual([...semanticControlIds].sort(), [...semanticBindingIds].sort())) {
    fail('review decision semantic_control_ids and semantic_control_bindings differ');
  }
  const uncertaintyNote = requireNullableString(decision.uncertainty_note, 'review decision.uncertainty_note');
  if (decision.signature_algorithm !== 'Ed25519') fail('review decision.signature_algorithm must equal Ed25519');
  requireSha256(decision.signed_payload_sha256, 'review decision.signed_payload_sha256');
  const signature = requireString(decision.signature_base64, 'review decision.signature_base64');
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) {
    fail('review decision.signature_base64 must be canonical base64 for an Ed25519 signature');
  }
  const signatureBytes = Buffer.from(signature, 'base64');
  if (signatureBytes.length !== 64 || signatureBytes.toString('base64') !== signature) {
    fail('review decision.signature_base64 must decode canonically to an Ed25519 signature');
  }
  return {
    schema_version: 1,
    policy: decision.policy,
    reviewer_id: reviewerId,
    decided_at: decidedAt,
    disposition: decision.disposition,
    display_allowed: displayAllowed,
    citation_allowed: citationAllowed,
    online_same_version_status: decision.online_same_version_status,
    critical_fields_complete: criticalFieldsComplete,
    critical_field_decisions: criticalFieldDecisions,
    semantic_control_ids: semanticControlIds,
    semantic_control_bindings: semanticControlBindings,
    uncertainty_note: uncertaintyNote,
    signature_algorithm: decision.signature_algorithm,
    signed_payload_sha256: decision.signed_payload_sha256,
    signature_base64: signature,
    signature_bytes: signatureBytes,
  };
}

function validateDecisionSemantics({ decision, criticalFields, online, audit, finalText, record }) {
  if (decision.online_same_version_status !== online.same_version_status) {
    fail('review decision online status differs from the recomputed online evidence status');
  }
  const decisionsById = new Map(decision.critical_field_decisions.map((field) => [field.field_id, field]));
  const declaredIds = new Set(criticalFields.map((field) => field.field_id));
  if (decisionsById.size !== declaredIds.size || [...declaredIds].some((id) => !decisionsById.has(id))) {
    fail('review decision critical fields do not exactly cover the Vision sidecar declarations');
  }
  for (const field of criticalFields) {
    const reviewed = decisionsById.get(field.field_id);
    if (!reviewed) continue;
    const accepted = normalizeOcrComparisonText(reviewed.accepted_text);
    if (!accepted || !normalizeOcrComparisonText(finalText).includes(accepted)) {
      fail(`reviewed critical field ${field.field_id} is absent from final_text`);
    }
    if (reviewed.status === 'verified_exact') {
      if (accepted !== normalizeOcrComparisonText(field.primary)
        || accepted !== normalizeOcrComparisonText(field.witness)) {
        fail(`critical field ${field.field_id} is marked exact but OCR and Vision do not agree`);
      }
      if (reviewed.deviating_engines.length > 0) {
        fail(`critical field ${field.field_id} is exact and cannot name a deviating engine`);
      }
    } else {
      const actualDeviations = [];
      if (accepted !== normalizeOcrComparisonText(field.primary)) actualDeviations.push('primary_ocr');
      if (accepted !== normalizeOcrComparisonText(field.witness)) actualDeviations.push('vision_ocr');
      if (!deepEqual([...reviewed.deviating_engines].sort(), actualDeviations.sort())) {
        fail(`critical field ${field.field_id} does not record the exact deviating OCR engines`);
      }
      if (reviewed.status === 'image_online_adjudicated') {
        if (actualDeviations.length === 0) {
          fail(`critical field ${field.field_id} has no OCR conflict requiring image/online adjudication`);
        }
        if (reviewed.basis !== IMAGE_ONLINE_ADJUDICATION_BASIS) {
          fail(`critical field ${field.field_id} lacks the structured image/online adjudication basis`);
        }
        const supportingExactClaims = online.exact_claims.filter((claim) => (
          normalizeOcrComparisonText(claim.supporting_text).includes(accepted)
        ));
        if (supportingExactClaims.length < 2) {
          fail(`critical field ${field.field_id} requires two independent exact-edition online supporting texts containing the adjudicated value`);
        }
      }
    }
  }
  if (decision.disposition === 'unresolved_fail_closed') {
    if (decision.display_allowed || decision.citation_allowed) fail('unresolved decision must close display and citation');
    if (!decision.uncertainty_note) fail('unresolved decision must retain a human-readable uncertainty note');
  } else {
    if (!decision.display_allowed) fail('accepted decision must allow display');
    if (!decision.critical_fields_complete || criticalFields.length === 0) {
      fail('accepted decision requires a non-empty, explicitly complete critical_fields declaration');
    }
    if (decision.disposition === 'accepted_display_non_citation') {
      if (decision.citation_allowed) fail('accepted_display_non_citation cannot allow citation');
      if (!decision.uncertainty_note) {
        fail('accepted_display_non_citation must explain the remaining uncertainty');
      }
    }
    if (decision.disposition === 'accepted_citation') {
      if (!decision.citation_allowed) fail('accepted_citation must allow citation');
      if (!record.citation_allowed) fail('document-level catalog citation_allowed gate is closed');
      if (online.same_version_status !== 'verified_independent') {
        fail('accepted citation requires two independent same-version online page claims');
      }
      if (decision.uncertainty_note) fail('accepted citation cannot retain unresolved uncertainty');
      if (decision.critical_field_decisions.some((field) => (
        !['verified_exact', 'image_online_adjudicated'].includes(field.status)
      ))) {
        fail('accepted citation requires every critical field to be exact or image/online adjudicated');
      }
      if (audit.table_detected) fail('table pages remain citation-blocked pending cell-level evidence support');
    }
  }
}

function artifactIdentity(artifact) {
  return {
    locator: artifact.locator,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
  };
}

function decisionSigningFields(decision) {
  return {
    schema_version: decision.schema_version,
    policy: decision.policy,
    reviewer_id: decision.reviewer_id,
    decided_at: decision.decided_at,
    disposition: decision.disposition,
    display_allowed: decision.display_allowed,
    citation_allowed: decision.citation_allowed,
    online_same_version_status: decision.online_same_version_status,
    critical_fields_complete: decision.critical_fields_complete,
    critical_field_decisions: decision.critical_field_decisions,
    semantic_control_ids: decision.semantic_control_ids,
    semantic_control_bindings: decision.semantic_control_bindings,
    uncertainty_note: decision.uncertainty_note,
    signature_algorithm: decision.signature_algorithm,
  };
}

function buildSigningPayload({
  bundle,
  rendered,
  artifacts,
  audit,
  criticalFields,
  online,
  decision,
  record,
}) {
  return {
    schema_version: 1,
    policy: 'immutable_actual_page_review_payload_v1',
    document_id: bundle.document_id,
    physical_pdf_page: bundle.physical_pdf_page,
    page_count: bundle.page_count,
    stable_locator: bundle.stable_locator,
    version_identity: bundle.version_identity,
    document_gate: {
      document_id: record.id,
      source_pdf_sha256: artifacts.source_pdf.sha256,
      page_count: record.page_count,
      citation_allowed: record.citation_allowed,
    },
    rendered_page: {
      mode: 'reproducible_render_v1',
      command_contract: 'mutool_draw_png_page_v1',
      renderer_sha256: rendered.renderer.sha256,
      renderer_version: rendered.renderer.version,
      dpi: bundle.rendered_page.dpi,
      format: 'png',
      sha256: rendered.sha256,
      bytes: rendered.bytes,
      width: rendered.width,
      height: rendered.height,
    },
    artifacts: Object.fromEntries(
      Object.entries(artifacts)
        .filter(([key]) => key !== 'reviewer_decision')
        .map(([key, artifact]) => [key, artifactIdentity(artifact)]),
    ),
    reviewer_decision_locator: bundle.artifacts.reviewer_decision.locator,
    recomputed_audit: expectedAuditPageSubset(audit),
    critical_fields: criticalFields,
    online_evidence: {
      target_version: online.target_version,
      same_version_status: online.same_version_status,
      claims: online.claims.map((claim) => ({
        claim_id: claim.claim_id,
        document_id: claim.document_id,
        physical_pdf_page: claim.physical_pdf_page,
        stable_locator: claim.stable_locator,
        url: claim.url,
        publisher: claim.publisher,
        source_type: claim.source_type,
        retrieved_at: claim.retrieved_at,
        version_match: claim.version_match,
        observed_version: claim.observed_version,
        snapshot: claim.snapshot,
        supporting_text: claim.supporting_text,
        supporting_text_sha256: claim.supporting_text_sha256,
      })),
    },
    decision: decisionSigningFields(decision),
  };
}

function decodeUtf8(buffer, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    fail(`${label} is not valid UTF-8: ${error.message}`);
  }
}

function inspectBundleInputs({ root, bundle: rawBundle, record, rendererPath, decisionOverride = null }) {
  const bundle = normalizeBundle(rawBundle);
  if (bundle.document_id !== record.id) fail('bundle.document_id differs from the catalog record');
  if (bundle.page_count !== record.page_count) fail('bundle.page_count differs from the catalog record');
  const expectedVersion = catalogVersionIdentity(record, bundle.physical_pdf_page);
  if (!deepEqual(bundle.version_identity, expectedVersion)) {
    fail('bundle.version_identity is not derived from the exact catalog record and physical page');
  }
  const artifacts = {};
  for (const [key, ref] of Object.entries(bundle.artifacts)) {
    if (key === 'reviewer_decision' && decisionOverride) continue;
    artifacts[key] = readBoundArtifact({ root, ref, label: `bundle.artifacts.${key}` });
  }
  if (bundle.artifacts.source_pdf.locator !== normalizeLocator(record.local_cache_path, `${record.id}.local_cache_path`)) {
    fail('bundle source PDF locator differs from the catalog source locator');
  }
  if (artifacts.source_pdf.buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    fail('bound source_pdf is not an actual PDF file');
  }
  if (artifacts.source_pdf.sha256 !== (record.checksum_sha256 || record.source_sha256)) {
    fail('actual source PDF hash differs from the catalog source hash');
  }
  const rendered = renderPdfPage({
    sourcePath: artifacts.source_pdf.path,
    pageNumber: bundle.physical_pdf_page,
    dpi: bundle.rendered_page.dpi,
    rendererPath,
  });
  if (rendered.page_count !== bundle.page_count) fail('actual PDF page count differs from bundle.page_count');
  const declaredRender = bundle.rendered_page;
  const actualRender = {
    renderer_sha256: rendered.renderer.sha256,
    renderer_version: rendered.renderer.version,
    sha256: rendered.sha256,
    bytes: rendered.bytes,
    width: rendered.width,
    height: rendered.height,
  };
  const expectedRender = {
    renderer_sha256: declaredRender.renderer_sha256,
    renderer_version: declaredRender.renderer_version,
    sha256: declaredRender.sha256,
    bytes: declaredRender.bytes,
    width: declaredRender.width,
    height: declaredRender.height,
  };
  if (!deepEqual(actualRender, expectedRender)) {
    fail('bundle rendered_page does not match a fresh deterministic render from the bound source PDF');
  }
  const primaryResult = parseJsonBuffer(artifacts.primary_result.buffer, 'primary result');
  const primaryContent = decodeUtf8(artifacts.primary_content.buffer, 'primary content');
  const primaryState = parseJsonBuffer(artifacts.primary_state.buffer, 'primary state');
  validatePrimaryObjects({
    record,
    bundle,
    sourceArtifact: artifacts.source_pdf,
    primaryResult,
    primaryContent,
    primaryState,
    rendered,
  });
  const visionSidecar = parseJsonBuffer(artifacts.vision_sidecar.buffer, 'vision sidecar');
  const criticalFields = validateVisionSidecar({
    bundle,
    sourceArtifact: artifacts.source_pdf,
    visionSidecar,
    rendered,
  });
  const recomputedAudit = recomputeAuditPage({ primaryText: primaryContent, visionSidecar });
  const auditReport = parseJsonBuffer(artifacts.audit.buffer, 'audit report');
  validateAuditObject(auditReport, bundle.physical_pdf_page, recomputedAudit);
  const finalText = decodeUtf8(artifacts.final_text.buffer, 'final text');
  if (normalizeOcrComparisonText(finalText).length === 0) fail('final text has no meaningful OCR content');
  const onlineClaims = parseJsonBuffer(artifacts.online_claims.buffer, 'online claims');
  const online = validateOnlineClaims({ root, onlineClaims, bundle });
  const rawDecision = decisionOverride
    || parseJsonBuffer(artifacts.reviewer_decision.buffer, 'review decision');
  const decision = normalizeReviewDecision(rawDecision);
  validateDecisionSemantics({
    decision,
    criticalFields,
    online,
    audit: recomputedAudit,
    finalText,
    record,
  });
  const payload = buildSigningPayload({
    bundle,
    rendered,
    artifacts,
    audit: recomputedAudit,
    criticalFields,
    online,
    decision,
    record,
  });
  const stablePayload = stableJson(payload);
  return {
    bundle,
    artifacts,
    rendered,
    primaryResult,
    primaryContent,
    primaryState,
    visionSidecar,
    criticalFields,
    audit: recomputedAudit,
    finalText,
    online,
    decision,
    payload,
    payload_text: stablePayload,
    payload_sha256: sha256Buffer(Buffer.from(stablePayload, 'utf8')),
  };
}

export function preparePageReviewSigningPayload({ root, bundle, record, decision, rendererPath = null }) {
  const inspected = inspectBundleInputs({
    root,
    bundle,
    record,
    rendererPath,
    decisionOverride: decision,
  });
  return {
    payload: inspected.payload,
    payload_text: inspected.payload_text,
    payload_sha256: inspected.payload_sha256,
  };
}

function validateReviewerSignature({ inspected, authorities }) {
  const { decision } = inspected;
  const reviewer = authorities.byId.get(decision.reviewer_id);
  if (!reviewer) fail(`review decision names unknown reviewer ${decision.reviewer_id}`);
  if (reviewer.status !== 'active') fail(`reviewer ${decision.reviewer_id} is not active`);
  const decidedAt = Date.parse(decision.decided_at);
  if (decidedAt < Date.parse(reviewer.valid_from)
    || (reviewer.valid_until && decidedAt > Date.parse(reviewer.valid_until))) {
    fail(`reviewer ${decision.reviewer_id} was not valid at decided_at`);
  }
  const requiredScopes = new Set(['page_display']);
  if (decision.citation_allowed) requiredScopes.add('page_citation');
  if (decision.semantic_control_ids.length > 0) requiredScopes.add('semantic_resolution');
  for (const scope of requiredScopes) {
    if (!reviewer.scopes.includes(scope)) fail(`reviewer ${decision.reviewer_id} lacks ${scope} scope`);
  }
  if (decision.signed_payload_sha256 !== inspected.payload_sha256) {
    fail('review decision signed_payload_sha256 differs from the recomputed actual-object payload');
  }
  let verified = false;
  try {
    verified = verifySignature(
      null,
      Buffer.from(inspected.payload_text, 'utf8'),
      createPublicKey(reviewer.public_key_pem),
      decision.signature_bytes,
    );
  } catch (error) {
    fail(`review decision signature verification failed: ${error.message}`);
  }
  if (!verified) fail('review decision Ed25519 signature is invalid');
  return reviewer;
}

function validateManifestPageBinding({ manifestDocument, manifestPage, inspected }) {
  const { bundle, artifacts, rendered, decision } = inspected;
  if (manifestDocument.document_id !== bundle.document_id
    || manifestPage.page_number !== bundle.physical_pdf_page
    || manifestPage.stable_locator !== bundle.stable_locator) {
    fail('page publication manifest points to a different page than its evidence bundle');
  }
  if (manifestDocument.source_artifact_sha256 !== artifacts.source_pdf.sha256) {
    fail('page publication source artifact hash differs from the actual source PDF');
  }
  if (manifestPage.source_page_sha256 !== rendered.sha256) {
    fail('page publication source_page_sha256 differs from a fresh PDF render');
  }
  if (manifestPage.final_text_sha256 !== artifacts.final_text.sha256) {
    fail('page publication final_text_sha256 differs from the actual adjudicated text');
  }
  if (manifestDocument.reviewed_by !== decision.reviewer_id
    || manifestDocument.reviewed_at !== decision.decided_at) {
    fail('page publication reviewer identity/time differs from the signed decision');
  }
  const expectedReviewStatus = decision.disposition === 'unresolved_fail_closed'
    ? 'unresolved_fail_closed'
    : 'accepted';
  if (manifestPage.review_status !== expectedReviewStatus
    || manifestPage.display_allowed !== decision.display_allowed
    || manifestPage.citation_allowed !== decision.citation_allowed) {
    fail('page publication flags differ from the signed reviewer decision');
  }
  if ((manifestPage.uncertainty_note || null) !== decision.uncertainty_note) {
    fail('page publication uncertainty note differs from the signed reviewer decision');
  }
}

function validateOnlineVerificationStandard(standard) {
  requireObject(standard, 'online verification standard');
  if (standard.schema_version !== 1
    || standard.name !== 'scan_ocr_online_version_aware_triangulation') {
    fail('online verification standard identity is invalid');
  }
  const requiredIdentityFields = new Set(standard.required_identity_fields || []);
  for (const field of [
    'title',
    'issuing_body_or_author',
    'year_or_publication_context',
    'version_label',
    'section_or_item_locator',
  ]) {
    if (!requiredIdentityFields.has(field)) fail(`online verification standard omits identity field ${field}`);
  }
  const editionStatuses = new Set(standard.edition_match_statuses || []);
  for (const status of [
    EXACT_ONLINE_VERSION,
    'exact_document_revision_uncertain',
    'same_work_different_edition',
    'stable_fact_only',
    'not_matched',
  ]) {
    if (!editionStatuses.has(status)) fail(`online verification standard omits edition status ${status}`);
  }
  const forbidden = Array.isArray(standard.gates?.forbidden) ? standard.gates.forbidden.join('\n') : '';
  if (!/newer edition/i.test(forbidden) || !/whole document/i.test(forbidden)) {
    fail('online verification standard must forbid cross-edition replacement and sample-based document promotion');
  }
  const releaseRule = standard.ocr_witness_thresholds?.document_release;
  if (typeof releaseRule !== 'string' || !/Every published page/i.test(releaseRule)) {
    fail('online verification standard must retain a per-page release rule');
  }
}

function releaseManifestFromPath(root, evidenceManifestPath) {
  const locator = normalizeLocator(evidenceManifestPath, 'evidence manifest path');
  const resolved = resolveBoundPath(root, locator, 'evidence manifest');
  const buffer = readRegularFileStable(resolved.path, 'evidence manifest');
  return {
    locator,
    path: resolved.path,
    sha256: sha256Buffer(buffer),
    bytes: buffer.length,
    value: parseJsonBuffer(buffer, 'evidence manifest'),
  };
}

function controlsForPage(semanticGate, documentId, pageNumber) {
  return (semanticGate.controlsByDocumentId.get(documentId) || [])
    .filter((control) => pageNumber >= control.page_start && pageNumber <= control.page_end);
}

function validateSemanticDecisionBinding({ semanticGate, record, manifestPage, inspected }) {
  const controls = controlsForPage(semanticGate, record.id, manifestPage.page_number);
  const expectedResolvedIds = controls
    .filter((control) => control.status === 'resolved_after_review')
    .map((control) => control.control_id)
    .sort();
  const signedIds = [...inspected.decision.semantic_control_ids].sort();
  if (!deepEqual(expectedResolvedIds, signedIds)) {
    fail(`${record.id}: page ${manifestPage.page_number} signed semantic controls differ from actual resolved controls`);
  }
  const signedBindings = new Map(
    inspected.decision.semantic_control_bindings.map((binding) => [binding.control_id, binding.control_sha256]),
  );
  for (const control of controls) {
    if (control.status === 'unresolved_fail_closed' && manifestPage.display_allowed) {
      fail(`${control.control_id}: unresolved semantic policy still blocks page display`);
    }
    if (control.status === 'resolved_after_review') {
      const actualControlSha256 = sha256Buffer(Buffer.from(stableJson(control), 'utf8'));
      if (signedBindings.get(control.control_id) !== actualControlSha256) {
        fail(`${control.control_id}: signed semantic control binding differs from the actual policy object`);
      }
      if (!manifestPage.display_allowed) fail(`${control.control_id}: a resolved control must bind a display-accepted page`);
      if (control.resolved_by !== inspected.decision.reviewer_id
        || control.resolved_at !== inspected.decision.decided_at) {
        fail(`${control.control_id}: semantic resolution reviewer/time differs from the page signature`);
      }
    }
  }
}

export function validatePageEvidenceRelease({
  root = process.cwd(),
  evidenceManifestPath = 'scripts/page-evidence/fail-closed-manifest.json',
  requirePublishable = false,
  authorityRegistrySha256 = process.env.PAGE_EVIDENCE_AUTHORITY_SHA256 || null,
  rendererPath = null,
} = {}) {
  const releaseFile = releaseManifestFromPath(root, evidenceManifestPath);
  const release = normalizeReleaseManifest(releaseFile.value);
  const authorityRead = readBoundJson({
    root,
    ref: release.authority_registry,
    label: 'release.authority_registry',
  });
  const authorities = normalizeAuthorityRegistry(authorityRead.value);
  const bindingObjects = {};
  const bindingArtifacts = {};
  for (const [key, ref] of Object.entries(release.bindings)) {
    const bound = readBoundJson({ root, ref, label: `release.bindings.${key}` });
    bindingObjects[key] = bound.value;
    bindingArtifacts[key] = bound.artifact;
  }
  const records = catalogRecords(bindingObjects.catalog);
  const recordById = new Map(records.map((record) => [record.id, record]));
  const pagePublication = validatePagePublicationManifest(bindingObjects.page_publication_manifest);
  const semanticGate = createSemanticPublicationGate({
    policy: bindingObjects.semantic_publication_policy,
    records,
  });
  validateOnlineVerificationStandard(bindingObjects.online_verification_standard);

  const publicationByKey = new Map();
  const publicationDocuments = new Map();
  for (const document of pagePublication.documents) {
    const record = recordById.get(document.document_id);
    if (!record) fail(`${document.document_id}: page publication document is absent from catalog`);
    if (semanticGate.aliasById.has(record.id)) fail(`${record.id}: exact-source alias cannot be independently published`);
    if (document.pages.length !== record.page_count) {
      fail(`${record.id}: page publication must list the complete actual PDF page range, not a partial page list`);
    }
    publicationDocuments.set(record.id, document);
    for (const page of document.pages) publicationByKey.set(`${record.id}:${page.page_number}`, { document, page, record });
  }

  const bundleEntryByKey = new Map(
    release.bundles.map((entry) => [`${entry.document_id}:${entry.page_number}`, entry]),
  );
  if (bundleEntryByKey.size !== publicationByKey.size) {
    fail('release bundle index must exactly equal the complete page-publication page set');
  }
  for (const key of bundleEntryByKey.keys()) {
    if (!publicationByKey.has(key)) fail(`release includes unreferenced evidence bundle ${key}`);
  }

  const inspectedByKey = new Map();
  for (const [key, publication] of publicationByKey.entries()) {
    const entry = bundleEntryByKey.get(key);
    if (!entry) fail(`${key}: page-publication entry has no verified evidence bundle`);
    const bundleRead = readBoundJson({
      root,
      ref: entry.bundle,
      label: `release bundle ${key}`,
    });
    if (entry.stable_locator !== publication.page.stable_locator) {
      fail(`${key}: release bundle index stable locator mismatch`);
    }
    if (publication.page.evidence_bundle_sha256 !== bundleRead.artifact.sha256) {
      fail(`${key}: page-publication evidence_bundle_sha256 differs from the actual bundle file`);
    }
    const inspected = inspectBundleInputs({
      root,
      bundle: bundleRead.value,
      record: publication.record,
      rendererPath,
    });
    if (inspected.bundle.document_id !== entry.document_id
      || inspected.bundle.physical_pdf_page !== entry.page_number
      || inspected.bundle.stable_locator !== entry.stable_locator) {
      fail(`${key}: release bundle index does not match the actual bundle object`);
    }
    validateReviewerSignature({ inspected, authorities });
    validateManifestPageBinding({
      manifestDocument: publication.document,
      manifestPage: publication.page,
      inspected,
    });
    validateSemanticDecisionBinding({
      semanticGate,
      record: publication.record,
      manifestPage: publication.page,
      inspected,
    });
    inspectedByKey.set(key, { ...inspected, bundle_artifact: bundleRead.artifact });
  }

  const resolvedControls = semanticGate.page_controls.filter((control) => control.status === 'resolved_after_review');
  for (const control of resolvedControls) {
    for (let pageNumber = control.page_start; pageNumber <= control.page_end; pageNumber += 1) {
      const key = `${control.document_id}:${pageNumber}`;
      const publication = publicationByKey.get(key);
      if (!publication || !publication.page.display_allowed || !inspectedByKey.has(key)) {
        fail(`${control.control_id}: resolved semantic page ${pageNumber} lacks a verified display-accepted bundle`);
      }
    }
  }

  const derivedCounts = {
    documents: publicationDocuments.size,
    pages: publicationByKey.size,
    display_pages: [...publicationByKey.values()].filter(({ page }) => page.display_allowed).length,
    citation_pages: [...publicationByKey.values()].filter(({ page }) => page.citation_allowed).length,
    resolved_semantic_controls: resolvedControls.length,
  };
  if (!deepEqual(release.expected_publication, derivedCounts)) {
    fail('release.expected_publication is self-reported and differs from recomputed publication objects');
  }
  const isZeroRelease = Object.values(derivedCounts).every((count) => count === 0)
    && release.bundles.length === 0;
  if (release.status === 'unresolved_fail_closed' && !isZeroRelease) {
    fail('unresolved_fail_closed phase-one manifest must remain zero-bundle and zero-publication');
  }
  if (release.status === 'publication_candidate') {
    if (derivedCounts.pages === 0 || derivedCounts.display_pages !== derivedCounts.pages) {
      fail('publication_candidate must contain at least one complete document with every page display-accepted');
    }
    if ([...publicationByKey.values()].some(({ page }) => page.review_status !== 'accepted')) {
      fail('publication_candidate contains an unresolved page');
    }
  }

  const needsPinnedAuthority = release.status === 'publication_candidate'
    || derivedCounts.display_pages > 0
    || derivedCounts.citation_pages > 0
    || derivedCounts.resolved_semantic_controls > 0;
  if (authorityRegistrySha256 !== null && authorityRegistrySha256 !== undefined) {
    requireSha256(authorityRegistrySha256, 'authorityRegistrySha256');
    if (authorityRegistrySha256 !== authorityRead.artifact.sha256) {
      fail('external authority registry SHA-256 pin differs from the actual registry');
    }
  }
  if (needsPinnedAuthority && !authorityRegistrySha256) {
    fail('non-zero publication requires an external PAGE_EVIDENCE_AUTHORITY_SHA256 pin');
  }
  const publishable = release.status === 'publication_candidate'
    && needsPinnedAuthority
    && Boolean(authorityRegistrySha256)
    && derivedCounts.pages > 0
    && derivedCounts.display_pages === derivedCounts.pages;
  if (requirePublishable && !publishable) {
    fail('promotion requires a valid publication_candidate with complete display pages and pinned reviewer authority');
  }
  return {
    valid: true,
    publishable,
    status: release.status,
    manifest: {
      locator: releaseFile.locator,
      sha256: releaseFile.sha256,
      bytes: releaseFile.bytes,
    },
    authority_registry_sha256: authorityRead.artifact.sha256,
    bindings: Object.fromEntries(
      Object.entries(bindingArtifacts).map(([key, artifact]) => [key, artifactIdentity(artifact)]),
    ),
    counts: derivedCounts,
    unresolved_reasons: release.unresolved_reasons,
  };
}
