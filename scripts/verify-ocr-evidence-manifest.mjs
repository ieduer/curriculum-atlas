#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCUMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VISION_PAGE_PATTERN = /^page-(\d+)\.json$/;
const VISION_TEXT_PATTERN = /^page-(\d+)\.txt$/;
const IMAGE_PAGE_PATTERN = /^page-(\d+)\.png$/;
const AUDIT_PAGE_PATTERN = /^audit-(\d+)-(\d+)\.json$/;
const ERROR_PATH_PATTERN = /(?:^|\/)(?:retries?|errors?|failures?|failed|quarantine)(?:[./_-]|$)/i;
const AUDIT_GATES = new Set([
  'automatic_witness_pass',
  'manual_image_review_required',
  'blank_page_visual_confirmation_required',
  'unresolved_fail_closed',
]);
const EVIDENCE_NAMESPACES = new Set(['vision', 'images', 'audits', 'vision-passes']);

function fail(message) {
  throw new Error(`OCR evidence manifest verifier: ${message}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function portable(value) {
  return value.split(path.sep).join('/');
}

function pageKey(page, width = 3) {
  return String(page).padStart(width, '0');
}

function canonicalVisionName(page) {
  return `page-${pageKey(page)}.json`;
}

function canonicalVisionTextName(page) {
  return `page-${pageKey(page)}.txt`;
}

function canonicalImageName(page) {
  return `page-${pageKey(page)}.png`;
}

function canonicalAuditName(page) {
  return `audit-${pageKey(page, 4)}-${pageKey(page, 4)}.json`;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label, { pattern = null } = {}) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string`);
  if (pattern && !pattern.test(value)) fail(`${label} has an invalid format`);
  return value;
}

function requireInteger(value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    fail(`${label} must be an integer >= ${minimum}`);
  }
  return value;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function inferPage(relativePath) {
  const name = path.posix.basename(relativePath);
  const vision = name.match(/^page-(\d+)/);
  if (vision) return Number(vision[1]);
  const audit = name.match(/^audit-(\d+)/);
  return audit ? Number(audit[1]) : null;
}

function compressPages(pages) {
  const sorted = [...new Set(pages)]
    .filter((page) => Number.isInteger(page) && page >= 1)
    .sort((left, right) => left - right);
  const ranges = [];
  for (const page of sorted) {
    const last = ranges.at(-1);
    if (last && page === last[1] + 1) last[1] = page;
    else ranges.push([page, page]);
  }
  return ranges;
}

class IssueCollector {
  constructor() {
    this.byCode = new Map();
    this.pageCodes = new Map();
  }

  add(code, page = null, count = 1) {
    const record = this.byCode.get(code) || { count: 0, pages: new Set() };
    record.count += count;
    if (Number.isInteger(page) && page >= 1) {
      record.pages.add(page);
      const codes = this.pageCodes.get(page) || new Set();
      codes.add(code);
      this.pageCodes.set(page, codes);
    }
    this.byCode.set(code, record);
  }

  hasPageIssues(page) {
    return Boolean(this.pageCodes.get(page)?.size);
  }

  serialize() {
    return [...this.byCode.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([code, value]) => ({
        code,
        count: value.count,
        page_ranges: compressPages(value.pages),
      }));
  }

  counts() {
    return Object.fromEntries(
      [...this.byCode.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([code, value]) => [code, value.count]),
    );
  }

  get size() {
    return this.byCode.size;
  }
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

async function walkFiles(rootPath, relativeRoot = '') {
  let entries;
  try {
    entries = await readdir(path.join(rootPath, relativeRoot), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { files: new Map(), nonRegular: [] };
    throw error;
  }
  const files = new Map();
  const nonRegular = [];
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const relativePath = portable(path.join(relativeRoot, entry.name));
    if (entry.isDirectory()) {
      const nested = await walkFiles(rootPath, relativePath);
      for (const [key, value] of nested.files) files.set(key, value);
      nonRegular.push(...nested.nonRegular);
    } else if (entry.isFile()) {
      files.set(relativePath, path.join(rootPath, relativePath));
    } else {
      nonRegular.push(relativePath);
    }
  }
  return { files, nonRegular };
}

function pageGroups(files, directory, pattern) {
  const groups = new Map();
  for (const relativePath of files.keys()) {
    if (path.posix.dirname(relativePath) !== directory) continue;
    const match = path.posix.basename(relativePath).match(pattern);
    if (!match) continue;
    const page = Number(match[1]);
    const values = groups.get(page) || [];
    values.push(relativePath);
    groups.set(page, values);
  }
  for (const values of groups.values()) values.sort(compareText);
  return groups;
}

function safeReference(documentRoot, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) return null;
  const normalized = portable(path.normalize(relativePath));
  if (normalized !== relativePath || normalized.startsWith('../') || normalized === '..') return null;
  const absolutePath = path.resolve(documentRoot, relativePath);
  return inside(documentRoot, absolutePath) ? { normalized, absolutePath } : null;
}

function normalizeManifest(raw, manifestPath) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`manifest contains invalid JSON: ${error.message}`);
  }
  const manifest = requireObject(parsed, 'manifest');
  requireInteger(manifest.schema_version, 'manifest.schema_version', 1);
  requireString(manifest.manifest_type, 'manifest.manifest_type');
  if (!Array.isArray(manifest.documents) || manifest.documents.length === 0) {
    fail('manifest.documents must be a non-empty array');
  }
  const seen = new Set();
  const documents = manifest.documents.map((value, index) => {
    const label = `manifest.documents[${index}]`;
    const document = requireObject(value, label);
    const id = requireString(document.id, `${label}.id`, { pattern: DOCUMENT_ID_PATTERN });
    if (seen.has(id)) fail(`manifest has duplicate document id ${id}`);
    seen.add(id);
    const sourceSha = requireString(document.source_sha256, `${label}.source_sha256`, {
      pattern: SHA256_PATTERN,
    });
    const pageCount = requireInteger(document.page_count, `${label}.page_count`, 1);
    const range = requireObject(document.required_page_range, `${label}.required_page_range`);
    if (range.first !== 1 || range.last !== pageCount || range.count !== pageCount) {
      fail(`${label}.required_page_range must exactly cover 1 through page_count`);
    }
    if (document.citation_allowed !== false) fail(`${label}.citation_allowed must be false`);
    return {
      id,
      source_sha256: sourceSha,
      page_count: pageCount,
    };
  }).sort((left, right) => compareText(left.id, right.id));
  const expectedPages = documents.reduce((sum, document) => sum + document.page_count, 0);
  const counts = requireObject(manifest.counts, 'manifest.counts');
  if (counts.selected_documents !== documents.length) {
    fail(`manifest.counts.selected_documents must equal ${documents.length}`);
  }
  if (counts.selected_pages !== expectedPages) {
    fail(`manifest.counts.selected_pages must equal ${expectedPages}`);
  }
  return {
    manifest_path: path.resolve(manifestPath),
    manifest_sha256: sha256(raw),
    documents,
    expected_pages: expectedPages,
  };
}

function visionText(record, issues, page) {
  if (!Array.isArray(record?.lines)) {
    issues.add('VISION_LINES_INVALID', page);
    return null;
  }
  const lines = [];
  for (const line of record.lines) {
    if (!line || typeof line !== 'object' || Array.isArray(line)
      || typeof line.text !== 'string'
      || !Number.isFinite(Number(line.confidence))
      || Number(line.confidence) < 0
      || Number(line.confidence) > 1) {
      issues.add('VISION_LINES_INVALID', page);
      return null;
    }
    lines.push(line.text);
  }
  return lines.join('\n');
}

function summaryMatchesAudit(report, pageRecord) {
  if (!report?.summary || typeof report.summary !== 'object' || Array.isArray(report.summary)) return false;
  if (report.summary.pages !== 1) return false;
  for (const gate of AUDIT_GATES) {
    if (report.summary[gate] !== (pageRecord.gate === gate ? 1 : 0)) return false;
  }
  return true;
}

async function verifyDocument(document, witnessRoot) {
  const issues = new IssueCollector();
  const documentRoot = path.join(witnessRoot, document.id);
  const { files, nonRegular } = await walkFiles(documentRoot);
  const evidenceFiles = new Map(
    [...files.entries()].filter(([relativePath]) => (
      EVIDENCE_NAMESPACES.has(relativePath.split('/')[0])
    )),
  );
  for (const relativePath of nonRegular.filter((value) => (
    EVIDENCE_NAMESPACES.has(value.split('/')[0])
  ))) {
    issues.add('NON_REGULAR_EVIDENCE_ENTRY', inferPage(relativePath));
  }

  const jsonCache = new Map();
  for (const [relativePath, absolutePath] of [...evidenceFiles.entries()].sort(([left], [right]) => compareText(left, right))) {
    if (!relativePath.endsWith('.json')) continue;
    let raw;
    let value = null;
    try {
      raw = await readFile(absolutePath);
      value = JSON.parse(raw.toString('utf8'));
    } catch {
      issues.add('INVALID_JSON', inferPage(relativePath));
    }
    jsonCache.set(relativePath, { raw, value });
    if (value && typeof value === 'object' && !Array.isArray(value)
      && value.error != null && value.error !== false && value.error !== '') {
      issues.add('ERROR_SIDECAR_PRESENT', inferPage(relativePath));
    }
    if (ERROR_PATH_PATTERN.test(relativePath)) {
      issues.add('RETRY_OR_ERROR_SIDECAR_PRESENT', inferPage(relativePath));
    }
  }

  const visionGroups = pageGroups(evidenceFiles, 'vision', VISION_PAGE_PATTERN);
  const visionTextGroups = pageGroups(evidenceFiles, 'vision', VISION_TEXT_PATTERN);
  const imageGroups = pageGroups(evidenceFiles, 'images', IMAGE_PAGE_PATTERN);
  const auditGroups = pageGroups(evidenceFiles, 'audits', AUDIT_PAGE_PATTERN);
  const recognizedJson = new Set();
  const referencedRawFiles = new Set();
  const snapshotEntries = [];

  for (const [page, paths] of visionGroups) {
    paths.forEach((value) => recognizedJson.add(value));
    if (paths.length > 1) issues.add('DUPLICATE_VISION_SIDECAR', page);
    if (!Number.isSafeInteger(page) || page < 1 || page > document.page_count) {
      issues.add('EXTRA_VISION_PAGE', page);
    }
    for (const relativePath of paths) {
      if (path.posix.basename(relativePath) !== canonicalVisionName(page)) {
        issues.add('NONCANONICAL_VISION_JSON', page);
      }
    }
  }
  for (const [page, paths] of visionTextGroups) {
    if (paths.length > 1) issues.add('DUPLICATE_VISION_TEXT', page);
    if (!Number.isSafeInteger(page) || page < 1 || page > document.page_count) {
      issues.add('EXTRA_VISION_TEXT_PAGE', page);
    }
    for (const relativePath of paths) {
      if (path.posix.basename(relativePath) !== canonicalVisionTextName(page)) {
        issues.add('NONCANONICAL_VISION_TEXT', page);
      }
    }
  }
  for (const [page, paths] of imageGroups) {
    if (paths.length > 1) issues.add('DUPLICATE_RENDERED_IMAGE', page);
    if (!Number.isSafeInteger(page) || page < 1 || page > document.page_count) {
      issues.add('EXTRA_RENDERED_IMAGE_PAGE', page);
    }
    for (const relativePath of paths) {
      if (path.posix.basename(relativePath) !== canonicalImageName(page)) {
        issues.add('NONCANONICAL_RENDERED_IMAGE', page);
      }
    }
  }
  for (const [page, paths] of auditGroups) {
    paths.forEach((value) => recognizedJson.add(value));
    const samePagePaths = paths.filter((relativePath) => {
      const match = path.posix.basename(relativePath).match(AUDIT_PAGE_PATTERN);
      return Number(match?.[1]) === Number(match?.[2]);
    });
    if (paths.length > 1 || samePagePaths.length > 1) issues.add('DUPLICATE_AUDIT_SIDECAR', page);
    if (!Number.isSafeInteger(page) || page < 1 || page > document.page_count) {
      issues.add('EXTRA_AUDIT_PAGE', page);
    }
    for (const relativePath of paths) {
      if (path.posix.basename(relativePath) !== canonicalAuditName(page)) {
        issues.add('NONCANONICAL_AUDIT_JSON', page);
      }
    }
  }

  for (let page = 1; page <= document.page_count; page += 1) {
    const visionRelative = `vision/${canonicalVisionName(page)}`;
    const visionTextRelative = `vision/${canonicalVisionTextName(page)}`;
    const imageRelative = `images/${canonicalImageName(page)}`;
    const auditRelative = `audits/${canonicalAuditName(page)}`;
    const visionPath = evidenceFiles.get(visionRelative);
    const visionTextPath = evidenceFiles.get(visionTextRelative);
    const imagePath = evidenceFiles.get(imageRelative);
    const auditPath = evidenceFiles.get(auditRelative);
    let currentWitnessText = null;
    let currentWitnessHash = null;
    let visionRawHash = null;
    let imageHash = null;
    let auditRawHash = null;

    if (!visionPath) {
      issues.add('MISSING_VISION_SIDECAR', page);
    } else {
      const cached = jsonCache.get(visionRelative);
      const record = cached?.value;
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        issues.add('VISION_SIDECAR_INVALID', page);
      } else {
        visionRawHash = cached.raw ? sha256(cached.raw) : null;
        if (record.error != null && record.error !== false && record.error !== '') {
          issues.add('VISION_ERROR_SIDECAR', page);
        }
        if (record.document_id !== document.id) issues.add('VISION_DOCUMENT_ID_MISMATCH', page);
        if (record.physical_pdf_page !== page) issues.add('VISION_PAGE_IDENTITY_MISMATCH', page);
        if (record.source_pdf_sha256 !== document.source_sha256) {
          issues.add('VISION_SOURCE_SHA_MISMATCH', page);
        }
        if (record.file !== canonicalImageName(page)) issues.add('VISION_IMAGE_NAME_MISMATCH', page);
        if (record.citation_allowed !== false) issues.add('VISION_CITATION_FLAG_INVALID', page);
        if (!SHA256_PATTERN.test(String(record.rendered_image_sha256 || ''))) {
          issues.add('VISION_IMAGE_SHA_INVALID', page);
        }
        if (!Number.isInteger(record.rendered_image_bytes) || record.rendered_image_bytes < 1) {
          issues.add('VISION_IMAGE_SIZE_INVALID', page);
        }
        currentWitnessText = visionText(record, issues, page);
        if (currentWitnessText != null) currentWitnessHash = sha256(currentWitnessText);

        if (!record.witness_profile
          || typeof record.witness_profile !== 'object'
          || Array.isArray(record.witness_profile)
          || !SHA256_PATTERN.test(String(record.witness_profile_sha256 || ''))
          || sha256(JSON.stringify(record.witness_profile)) !== record.witness_profile_sha256) {
          issues.add('VISION_PROFILE_BINDING_INVALID', page);
        }
        if (!Array.isArray(record.witness_passes) || record.witness_passes.length === 0) {
          issues.add('VISION_PASS_MANIFEST_INVALID', page);
        } else {
          const seenPasses = new Set();
          let canonicalPass = null;
          for (const pass of record.witness_passes) {
            if (!pass || typeof pass !== 'object' || Array.isArray(pass)
              || typeof pass.pass_id !== 'string' || !pass.pass_id
              || seenPasses.has(pass.pass_id)
              || !Array.isArray(pass.lines)) {
              issues.add('VISION_PASS_MANIFEST_INVALID', page);
              continue;
            }
            seenPasses.add(pass.pass_id);
            if (pass.pass_id === record.line_source_pass_id) canonicalPass = pass;
            const expectedStem = `page-${pageKey(page)}`;
            const expectedSidecar = `vision-passes/${pass.pass_id}/${expectedStem}.json`;
            const expectedText = `vision-passes/${pass.pass_id}/${expectedStem}.txt`;
            if (pass.raw_sidecar_file !== expectedSidecar || pass.raw_text_file !== expectedText) {
              issues.add('VISION_RAW_REFERENCE_INVALID', page);
            }
            for (const [field, expectedPath, expectedHash, kind] of [
              ['raw_sidecar_file', pass.raw_sidecar_file, pass.raw_sidecar_sha256, 'json'],
              ['raw_text_file', pass.raw_text_file, pass.raw_text_sha256, 'text'],
            ]) {
              const safe = safeReference(documentRoot, expectedPath);
              if (!safe || !SHA256_PATTERN.test(String(expectedHash || ''))) {
                issues.add('VISION_RAW_REFERENCE_INVALID', page);
                continue;
              }
              referencedRawFiles.add(safe.normalized);
              const actualPath = evidenceFiles.get(safe.normalized);
              if (!actualPath) {
                issues.add('VISION_RAW_REFERENCE_MISSING', page);
                continue;
              }
              const actualBytes = await readFile(actualPath);
              if (sha256(actualBytes) !== expectedHash) {
                issues.add('VISION_RAW_REFERENCE_STALE', page);
              }
              if (kind === 'json') {
                recognizedJson.add(safe.normalized);
                const rawRecord = jsonCache.get(safe.normalized)?.value;
                if (!rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)
                  || rawRecord.error != null
                  || !Array.isArray(rawRecord.lines)) {
                  issues.add('VISION_RAW_SIDECAR_INVALID', page);
                } else if (JSON.stringify(rawRecord.lines) !== JSON.stringify(pass.lines)) {
                  issues.add('VISION_RAW_LINES_MISMATCH', page);
                }
              } else if (field === 'raw_text_file') {
                const expectedRawText = `${pass.lines.map((line) => line?.text).join('\n')}\n`;
                if (actualBytes.toString('utf8') !== expectedRawText) {
                  issues.add('VISION_RAW_TEXT_MISMATCH', page);
                }
              }
            }
          }
          if (!canonicalPass || record.witness_profile?.canonical_pass_id !== record.line_source_pass_id
            || JSON.stringify(record.lines) !== JSON.stringify(canonicalPass?.lines)) {
            issues.add('VISION_CANONICAL_PASS_MISMATCH', page);
          }
        }
      }
    }

    if (!visionTextPath) {
      issues.add('MISSING_VISION_TEXT', page);
    } else if (currentWitnessText != null) {
      const actualText = await readFile(visionTextPath, 'utf8');
      if (actualText !== `${currentWitnessText}\n`) issues.add('STALE_VISION_TEXT', page);
    }

    if (!imagePath) {
      issues.add('MISSING_RENDERED_IMAGE', page);
    } else {
      const imageInfo = await stat(imagePath);
      imageHash = await hashFile(imagePath);
      const record = jsonCache.get(visionRelative)?.value;
      if (record && typeof record === 'object' && !Array.isArray(record)) {
        if (record.rendered_image_sha256 !== imageHash) issues.add('RENDERED_IMAGE_SHA_MISMATCH', page);
        if (record.rendered_image_bytes !== imageInfo.size) issues.add('RENDERED_IMAGE_SIZE_MISMATCH', page);
      }
    }

    if (!auditPath) {
      issues.add('MISSING_AUDIT_SIDECAR', page);
    } else {
      const cached = jsonCache.get(auditRelative);
      const report = cached?.value;
      auditRawHash = cached?.raw ? sha256(cached.raw) : null;
      if (!report || typeof report !== 'object' || Array.isArray(report)
        || report.schema_version !== 1
        || !Array.isArray(report.page_range)
        || report.page_range.length !== 2
        || report.page_range[0] !== page
        || report.page_range[1] !== page
        || !Array.isArray(report.pages)
        || report.pages.length !== 1) {
        issues.add('AUDIT_SIDECAR_INVALID', page);
      } else {
        const auditPage = report.pages[0];
        if (!auditPage || typeof auditPage !== 'object' || Array.isArray(auditPage)
          || auditPage.page !== page
          || !AUDIT_GATES.has(auditPage.gate)
          || !SHA256_PATTERN.test(String(auditPage.primary_sha256 || ''))
          || !SHA256_PATTERN.test(String(auditPage.witness_sha256 || ''))) {
          issues.add('AUDIT_PAGE_RECORD_INVALID', page);
        } else {
          if (currentWitnessHash == null || auditPage.witness_sha256 !== currentWitnessHash) {
            issues.add('STALE_AUDIT_WITNESS_HASH', page);
          }
          const expectedWitnessSuffix = `${document.id}/vision/${canonicalVisionName(page)}`;
          if (typeof auditPage.witness_path !== 'string'
            || !portable(auditPage.witness_path).endsWith(expectedWitnessSuffix)) {
            issues.add('AUDIT_WITNESS_PATH_MISMATCH', page);
          }
          if (!summaryMatchesAudit(report, auditPage)) issues.add('AUDIT_SUMMARY_MISMATCH', page);
        }
      }
    }

    if (visionRawHash && imageHash && auditRawHash) {
      snapshotEntries.push(
        `${document.id}\0${page}\0${visionRawHash}\0${imageHash}\0${auditRawHash}`,
      );
    }
  }

  for (const relativePath of evidenceFiles.keys()) {
    if (relativePath.startsWith('vision-passes/') && !referencedRawFiles.has(relativePath)) {
      issues.add('UNREFERENCED_RAW_PASS_FILE', inferPage(relativePath));
    }
    if (relativePath.endsWith('.json')
      && !recognizedJson.has(relativePath)
      && !referencedRawFiles.has(relativePath)) {
      issues.add('UNEXPECTED_JSON_SIDECAR', inferPage(relativePath));
    }
  }

  const verifiedPages = Array.from(
    { length: document.page_count },
    (_, index) => index + 1,
  ).filter((page) => !issues.hasPageIssues(page)).length;
  const serializedIssues = issues.serialize();
  return {
    result: {
      document_id: document.id,
      source_pdf_sha256: document.source_sha256,
      expected_pages: document.page_count,
      verified_pages: verifiedPages,
      verdict: serializedIssues.length ? 'fail' : 'pass',
      issues: serializedIssues,
    },
    issueCounts: issues.counts(),
    snapshotEntries,
  };
}

export async function verifyOcrEvidenceManifest({ manifestPath, witnessRoot }) {
  const resolvedManifestPath = path.resolve(requireString(manifestPath, 'manifestPath'));
  const resolvedWitnessRoot = path.resolve(requireString(witnessRoot, 'witnessRoot'));
  const manifestRaw = await readFile(resolvedManifestPath, 'utf8').catch((error) => {
    fail(`cannot read manifest: ${error.message}`);
  });
  const manifest = normalizeManifest(manifestRaw, resolvedManifestPath);
  const witnessInfo = await stat(resolvedWitnessRoot).catch((error) => {
    fail(`cannot stat witness root: ${error.message}`);
  });
  if (!witnessInfo.isDirectory()) fail('witnessRoot must be a directory');

  const documents = [];
  const issueCounts = new Map();
  const snapshotEntries = [];
  for (const document of manifest.documents) {
    const result = await verifyDocument(document, resolvedWitnessRoot);
    documents.push(result.result);
    snapshotEntries.push(...result.snapshotEntries);
    for (const [code, count] of Object.entries(result.issueCounts)) {
      issueCounts.set(code, (issueCounts.get(code) || 0) + count);
    }
  }
  documents.sort((left, right) => compareText(left.document_id, right.document_id));
  snapshotEntries.sort(compareText);
  const verifiedDocuments = documents.filter((document) => document.verdict === 'pass').length;
  const verifiedPages = documents.reduce((sum, document) => sum + document.verified_pages, 0);
  const sortedIssueCounts = Object.fromEntries(
    [...issueCounts.entries()].sort(([left], [right]) => compareText(left, right)),
  );
  const verdict = issueCounts.size ? 'fail' : 'pass';
  return {
    schema_version: 1,
    artifact_type: 'ocr_evidence_manifest_verification',
    verdict,
    policy: {
      input_mode: 'read_only',
      evidence_mutation: 'none',
      fail_closed: true,
      scope: 'manifest_documents_only',
      evidence_namespaces: [...EVIDENCE_NAMESPACES],
      unscoped_diagnostic_directories: 'ignored',
      raw_ocr_text_in_output: false,
      required_page_contract: 'one canonical Vision JSON, rendered image, Vision text, and one canonical audit JSON per required page',
      audit_freshness_contract: 'audit witness_sha256 must equal the hash of the current canonical Vision lines joined by newline',
    },
    manifest: {
      sha256: manifest.manifest_sha256,
      expected_documents: manifest.documents.length,
      expected_pages: manifest.expected_pages,
    },
    summary: {
      verified_documents: verifiedDocuments,
      failed_documents: manifest.documents.length - verifiedDocuments,
      verified_pages: verifiedPages,
      failed_pages: manifest.expected_pages - verifiedPages,
      issue_counts: sortedIssueCounts,
      evidence_snapshot_sha256: sha256(snapshotEntries.join('\n')),
    },
    documents,
  };
}

export function parseOcrEvidenceManifestArgs(argv) {
  const values = {};
  const allowed = new Set(['--manifest', '--witness-root', '--output']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!allowed.has(argument)) fail(`unexpected argument: ${argument}`);
    if (Object.hasOwn(values, argument)) fail(`duplicate argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`missing value for ${argument}`);
    values[argument] = value;
    index += 1;
  }
  for (const argument of allowed) {
    if (!values[argument]) fail(`${argument} is required`);
  }
  return {
    manifestPath: values['--manifest'],
    witnessRoot: values['--witness-root'],
    outputPath: values['--output'],
  };
}

export async function writeOcrEvidenceManifestVerification({
  manifestPath,
  witnessRoot,
  outputPath,
}) {
  const resolvedManifestPath = path.resolve(requireString(manifestPath, 'manifestPath'));
  const resolvedWitnessRoot = path.resolve(requireString(witnessRoot, 'witnessRoot'));
  const resolvedOutputPath = path.resolve(requireString(outputPath, 'outputPath'));
  if (inside(resolvedWitnessRoot, resolvedOutputPath)) {
    fail('output must be outside the read-only witness root');
  }
  if (resolvedOutputPath === resolvedManifestPath) {
    fail('output must not replace the input manifest');
  }
  const result = await verifyOcrEvidenceManifest({
    manifestPath: resolvedManifestPath,
    witnessRoot: resolvedWitnessRoot,
  });
  await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  const temporaryPath = `${resolvedOutputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  await rename(temporaryPath, resolvedOutputPath);
  return result;
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  try {
    const options = parseOcrEvidenceManifestArgs(process.argv.slice(2));
    const result = await writeOcrEvidenceManifestVerification(options);
    console.log(JSON.stringify({
      verdict: result.verdict,
      expected_documents: result.manifest.expected_documents,
      expected_pages: result.manifest.expected_pages,
      verified_documents: result.summary.verified_documents,
      verified_pages: result.summary.verified_pages,
      issue_counts: result.summary.issue_counts,
      evidence_snapshot_sha256: result.summary.evidence_snapshot_sha256,
    }));
    if (result.verdict !== 'pass') process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({
      verdict: 'error',
      code: 'VERIFIER_INPUT_ERROR',
      message: error.message,
    }));
    process.exitCode = 64;
  }
}
