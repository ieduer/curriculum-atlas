#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCUMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PAGE_FILE_PATTERN = /^page-(\d+)\.json$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MIN_FOOTER_RUN = 2;
const MIN_HEADER_SUPPORT = 2;

function fail(message) {
  throw new Error(`OCR page furniture candidates: ${message}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
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

function requireInteger(value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    fail(`${label} must be an integer >= ${minimum}`);
  }
  return value;
}

function samplePages(pages) {
  if (pages.length <= 3) return [...pages];
  return [...new Set([
    pages[0],
    pages[Math.floor((pages.length - 1) / 2)],
    pages.at(-1),
  ])];
}

function normalizeHeader(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function normalizeSidecar(documentId, relativePath, page, raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    fail(`${relativePath} contains invalid JSON: ${error.message}`);
  }
  const record = requireObject(value, relativePath);
  requireInteger(record.schema_version, `${relativePath}.schema_version`, 1);
  if (record.document_id !== undefined
    && requireString(record.document_id, `${relativePath}.document_id`) !== documentId) {
    fail(`${relativePath}.document_id does not match its directory`);
  }
  if (record.physical_pdf_page !== undefined
    && requireInteger(record.physical_pdf_page, `${relativePath}.physical_pdf_page`, 1) !== page) {
    fail(`${relativePath}.physical_pdf_page does not match its filename`);
  }
  const expectedImage = `page-${String(page).padStart(3, '0')}.png`;
  if (requireString(record.file, `${relativePath}.file`) !== expectedImage) {
    fail(`${relativePath}.file must equal ${expectedImage}`);
  }
  const sourcePdfSha = requireString(
    record.source_pdf_sha256,
    `${relativePath}.source_pdf_sha256`,
    { pattern: SHA256_PATTERN },
  );
  requireString(
    record.rendered_image_sha256,
    `${relativePath}.rendered_image_sha256`,
    { pattern: SHA256_PATTERN },
  );
  if (!Array.isArray(record.lines)) fail(`${relativePath}.lines must be an array`);
  const lines = record.lines.map((line, index) => {
    const item = requireObject(line, `${relativePath}.lines[${index}]`);
    return {
      text: requireString(item.text, `${relativePath}.lines[${index}].text`, { allowEmpty: true }),
    };
  });
  return {
    page,
    source_pdf_sha256: sourcePdfSha,
    first_line: lines.length ? lines[0].text.trim() : '',
    last_line: lines.length ? lines.at(-1).text.trim() : '',
  };
}

function buildFooterSegments(pages) {
  const numericFooters = pages.flatMap((page) => {
    if (!/^\d{1,4}$/.test(page.last_line)) return [];
    const printedPage = Number(page.last_line);
    return [{
      page: page.page,
      printed_page: printedPage,
      offset: printedPage - page.page,
    }];
  });
  const runs = [];
  let current = [];
  for (const item of numericFooters) {
    const previous = current.at(-1);
    if (!previous || (item.page === previous.page + 1 && item.offset === previous.offset)) {
      current.push(item);
      continue;
    }
    runs.push(current);
    current = [item];
  }
  if (current.length) runs.push(current);
  return runs
    .filter((run) => run.length >= MIN_FOOTER_RUN)
    .map((run) => ({
      candidate_type: 'printed_page_number_footer',
      start_page: run[0].page,
      end_page: run.at(-1).page,
      page_count: run.length,
      physical_to_printed_offset: run[0].offset,
      printed_page_start: run[0].printed_page,
      printed_page_end: run.at(-1).printed_page,
      example_pages: samplePages(run.map((item) => item.page)),
      review_status: 'pending_image_review',
      eligible_for_audit_filter: false,
    }));
}

function buildHeaderCandidates(pages) {
  const groups = new Map();
  for (const page of pages) {
    const normalized = normalizeHeader(page.first_line);
    if (!normalized) continue;
    const group = groups.get(normalized) || {
      normalized_text: normalized,
      pages: [],
      variants: new Map(),
    };
    group.pages.push(page.page);
    group.variants.set(page.first_line, (group.variants.get(page.first_line) || 0) + 1);
    groups.set(normalized, group);
  }
  return [...groups.values()]
    .filter((group) => group.pages.length >= MIN_HEADER_SUPPORT)
    .sort((left, right) => (
      right.pages.length - left.pages.length
      || compareText(left.normalized_text, right.normalized_text)
    ))
    .map((group) => ({
      candidate_type: 'recurring_first_line',
      normalized_text: group.normalized_text,
      occurrence_count: group.pages.length,
      pages: [...group.pages],
      example_pages: samplePages(group.pages),
      raw_variants: [...group.variants.entries()]
        .sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))
        .map(([text, count]) => ({ text, count })),
      review_status: 'pending_image_review',
      eligible_for_audit_filter: false,
    }));
}

async function discoverDocuments(witnessRoot) {
  let entries;
  try {
    entries = await readdir(witnessRoot, { withFileTypes: true });
  } catch (error) {
    fail(`cannot read witness root ${witnessRoot}: ${error.message}`);
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => compareText(left.name, right.name))
    .map((entry) => ({
      document_id: requireString(entry.name, 'document_id', { pattern: DOCUMENT_ID_PATTERN }),
      vision_root: path.join(witnessRoot, entry.name, 'vision'),
    }));
}

async function readDocument(document) {
  let entries;
  try {
    entries = await readdir(document.vision_root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail(`cannot read ${document.document_id}/vision: ${error.message}`);
  }
  const files = [];
  const ignoredNoncanonicalFiles = [];
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    if (!entry.name.startsWith('page-') || !entry.name.endsWith('.json')) continue;
    const match = entry.name.match(PAGE_FILE_PATTERN);
    if (!match) {
      if (!entry.isFile()) fail(`${document.document_id}/vision/${entry.name} must be a regular file`);
      ignoredNoncanonicalFiles.push(`${document.document_id}/vision/${entry.name}`);
      continue;
    }
    if (!entry.isFile()) fail(`${document.document_id}/vision/${entry.name} must be a regular file`);
    files.push({
      page: Number(match[1]),
      absolute_path: path.join(document.vision_root, entry.name),
      relative_path: `${document.document_id}/vision/${entry.name}`,
    });
  }
  if (!files.length) return null;
  files.sort((left, right) => left.page - right.page || compareText(left.relative_path, right.relative_path));
  const pages = [];
  const sourceFiles = [];
  const seenPages = new Set();
  for (const file of files) {
    if (!Number.isInteger(file.page) || file.page < 1) {
      fail(`${file.relative_path} has an invalid page number`);
    }
    if (seenPages.has(file.page)) fail(`${document.document_id} has duplicate sidecars for page ${file.page}`);
    seenPages.add(file.page);
    let raw;
    try {
      raw = await readFile(file.absolute_path, 'utf8');
    } catch (error) {
      fail(`cannot read ${file.relative_path}: ${error.message}`);
    }
    pages.push(normalizeSidecar(document.document_id, file.relative_path, file.page, raw));
    sourceFiles.push({ path: file.relative_path, sha256: sha256(raw) });
  }
  const sourcePdfHashes = [...new Set(pages.map((page) => page.source_pdf_sha256))];
  if (sourcePdfHashes.length !== 1) {
    fail(`${document.document_id} contains conflicting source_pdf_sha256 values`);
  }
  const footerSegments = buildFooterSegments(pages);
  const headerCandidates = buildHeaderCandidates(pages);
  return {
    document_id: document.document_id,
    source_pdf_sha256: sourcePdfHashes[0],
    observed_page_count: pages.length,
    observed_page_start: pages[0].page,
    observed_page_end: pages.at(-1).page,
    sidecar_snapshot_sha256: sha256(
      sourceFiles.map((file) => `${file.path}\0${file.sha256}`).join('\n'),
    ),
    footer_candidates: footerSegments,
    recurring_first_line_candidates: headerCandidates,
    ignored_noncanonical_files: ignoredNoncanonicalFiles,
    review_status: 'pending_image_review',
    eligible_for_audit_filter: false,
  };
}

export async function buildOcrPageFurnitureCandidates({ witnessRoot }) {
  const resolvedWitnessRoot = path.resolve(requireString(witnessRoot, 'witnessRoot'));
  const discovered = await discoverDocuments(resolvedWitnessRoot);
  const documents = [];
  for (const document of discovered) {
    const value = await readDocument(document);
    if (value) documents.push(value);
  }
  if (!documents.length) fail(`no */vision/page-*.json files found under ${resolvedWitnessRoot}`);
  const footerCandidates = documents.flatMap((document) => document.footer_candidates);
  const headerCandidates = documents.flatMap((document) => document.recurring_first_line_candidates);
  return {
    schema_version: 1,
    artifact_type: 'ocr_page_furniture_candidates',
    policy: {
      input_mode: 'read_only_vision_sidecar_snapshot',
      raw_witness_mutation: 'none',
      audit_filter_mutation: 'none',
      publication_mutation: 'none',
      candidate_status: 'pending_image_review',
      noncanonical_sidecars: 'record but exclude files whose names do not match page-<number>.json',
      activation_rule: 'a separate source-image-reviewed, source-hash-bound approval artifact is required before any header or footer can be excluded from OCR comparison',
      minimum_footer_consecutive_pages: MIN_FOOTER_RUN,
      minimum_recurring_first_line_support: MIN_HEADER_SUPPORT,
    },
    summary: {
      documents: documents.length,
      observed_pages: documents.reduce((sum, document) => sum + document.observed_page_count, 0),
      footer_candidate_segments: footerCandidates.length,
      footer_candidate_pages: footerCandidates.reduce((sum, candidate) => sum + candidate.page_count, 0),
      recurring_first_line_candidates: headerCandidates.length,
      ignored_noncanonical_files: documents.reduce(
        (sum, document) => sum + document.ignored_noncanonical_files.length,
        0,
      ),
      eligible_for_audit_filter: 0,
    },
    documents,
  };
}

export function parseOcrPageFurnitureArgs(argv) {
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

export async function writeOcrPageFurnitureCandidates({ witnessRoot, outputPath }) {
  const resolvedWitnessRoot = path.resolve(requireString(witnessRoot, 'witnessRoot'));
  const resolvedOutputPath = path.resolve(requireString(outputPath, 'outputPath'));
  const outputRelativeToWitness = path.relative(resolvedWitnessRoot, resolvedOutputPath);
  if (outputRelativeToWitness === ''
    || (!outputRelativeToWitness.startsWith(`..${path.sep}`) && outputRelativeToWitness !== '..')) {
    fail('output must be outside the read-only witness root');
  }
  const artifact = await buildOcrPageFurnitureCandidates({ witnessRoot: resolvedWitnessRoot });
  await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return artifact;
}

async function main() {
  const options = parseOcrPageFurnitureArgs(process.argv.slice(2));
  const artifact = await writeOcrPageFurnitureCandidates(options);
  process.stdout.write(`${JSON.stringify(artifact.summary)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
