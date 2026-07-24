#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const QUEUE_PATH = path.join(ROOT, 'data/ocr-queue.json');
const COVERAGE_PATH = path.join(ROOT, 'data/ocr-coverage-ledger.json');
const PRIVATE_ROOT = path.join(ROOT, '.cache/ocr-candidate-fallback-v15');
const HYBRID_ROOT = path.join(ROOT, '.cache/pre2001-candidate-hybrid-v15');
const LEDGER_PATH = path.join(ROOT, 'data/ocr-candidate-fallback-ledger.json');
const SWIFT_SOURCE = path.join(ROOT, 'scripts/vision-ocr-batch.swift');
const SWIFT_BINARY = path.join(ROOT, '.cache/bin/vision-ocr-batch-v15');
const PDFTOPPM = '/opt/homebrew/bin/pdftoppm';
const BATCH_SIZE = 12;
const buildPre2001Hybrid = process.argv.includes('--build-pre2001-hybrid');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fileSha256(file) {
  return sha256(await readFile(file));
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function compileVisionBinary() {
  await mkdir(path.dirname(SWIFT_BINARY), { recursive: true });
  const source = await stat(SWIFT_SOURCE);
  const binary = await stat(SWIFT_BINARY).catch(() => null);
  if (binary && binary.mtimeMs >= source.mtimeMs) return;
  await run('/usr/bin/swiftc', ['-O', SWIFT_SOURCE, '-o', SWIFT_BINARY], {
    maxBuffer: 8 * 1024 * 1024,
  });
}

function meanConfidence(lines) {
  const values = lines.map((line) => Number(line.confidence)).filter(Number.isFinite);
  return values.length
    ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6))
    : 0;
}

async function validatedExistingSidecar(file, expected) {
  try {
    const raw = await readFile(file);
    const value = JSON.parse(raw);
    if (value.document_id !== expected.document_id
      || value.physical_pdf_page !== expected.page
      || value.source_pdf_sha256 !== expected.source_pdf_sha256
      || value.citation_allowed !== false
      || !Array.isArray(value.lines)) return null;
    return {
      page: expected.page,
      sidecar_sha256: sha256(raw),
      character_count: value.lines.reduce((sum, line) => sum + String(line.text || '').length, 0),
      line_count: value.lines.length,
      mean_confidence: meanConfidence(value.lines),
    };
  } catch {
    return null;
  }
}

async function processDocument(document, gap) {
  const pdfPath = path.join(ROOT, document.local_cache_path);
  const pdfSha = await fileSha256(pdfPath);
  if (pdfSha !== document.source_sha256) {
    throw new Error(`${document.id}: source PDF hash drift`);
  }
  const documentRoot = path.join(PRIVATE_ROOT, document.id);
  await mkdir(documentRoot, { recursive: true });
  const pageRows = [];
  const [firstPage, lastPage] = gap.page_range;
  for (let batchStart = firstPage; batchStart <= lastPage; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(lastPage, batchStart + BATCH_SIZE - 1);
    const pending = [];
    for (let page = batchStart; page <= batchEnd; page += 1) {
      const sidecarPath = path.join(documentRoot, `page-${String(page).padStart(4, '0')}.json`);
      const existing = await validatedExistingSidecar(sidecarPath, {
        document_id: document.id,
        page,
        source_pdf_sha256: pdfSha,
      });
      if (existing) pageRows.push(existing);
      else pending.push(page);
    }
    if (!pending.length) {
      process.stdout.write(`${document.id} ${batchStart}-${batchEnd} cached\n`);
      continue;
    }
    const renderRoot = await mkdtemp(path.join(tmpdir(), `${document.id}-candidate-`));
    const rawRoot = path.join(renderRoot, 'vision');
    await mkdir(rawRoot, { recursive: true });
    try {
      await run(PDFTOPPM, [
        '-png', '-r', '160', '-f', String(batchStart), '-l', String(batchEnd),
        pdfPath, path.join(renderRoot, 'page'),
      ], { maxBuffer: 32 * 1024 * 1024 });
      const imageNames = (await readdir(renderRoot))
        .filter((name) => name.endsWith('.png'))
        .sort((left, right) => left.localeCompare(right, 'en'));
      if (imageNames.length !== batchEnd - batchStart + 1) {
        throw new Error(`${document.id}: rendered ${imageNames.length} pages for ${batchStart}-${batchEnd}`);
      }
      const imagePaths = imageNames.map((name) => path.join(renderRoot, name));
      await run(SWIFT_BINARY, [
        '--output-dir', rawRoot, '--languages', 'zh-Hans,en-US', ...imagePaths,
      ], { maxBuffer: 128 * 1024 * 1024 });
      for (const [index, imageName] of imageNames.entries()) {
        const page = batchStart + index;
        const imagePath = path.join(renderRoot, imageName);
        const rawPath = path.join(rawRoot, `${path.parse(imageName).name}.json`);
        const raw = JSON.parse(await readFile(rawPath, 'utf8'));
        if (raw.error) throw new Error(`${document.id}: page ${page} Vision error ${raw.error}`);
        const record = {
          schema_version: 1,
          artifact_profile: 'candidate-ocr-single-witness-v1',
          document_id: document.id,
          physical_pdf_page: page,
          source_pdf_sha256: pdfSha,
          rendered_image_sha256: await fileSha256(imagePath),
          engine: 'Apple Vision VNRecognizeTextRequest accurate zh-Hans+en-US',
          engine_role: 'candidate_observation_fallback_not_independent_publication_witness',
          lines: raw.lines,
          critical_fields: [],
          semantic_claim_allowed: false,
          negative_claim_allowed: false,
          citation_allowed: false
        };
        const serialized = `${JSON.stringify(record, null, 2)}\n`;
        const sidecarPath = path.join(documentRoot, `page-${String(page).padStart(4, '0')}.json`);
        await writeFile(sidecarPath, serialized);
        pageRows.push({
          page,
          sidecar_sha256: sha256(serialized),
          character_count: record.lines.reduce((sum, line) => sum + String(line.text || '').length, 0),
          line_count: record.lines.length,
          mean_confidence: meanConfidence(record.lines),
        });
      }
      process.stdout.write(`${document.id} ${batchStart}-${batchEnd} complete\n`);
    } finally {
      await rm(renderRoot, { recursive: true, force: true });
    }
  }
  pageRows.sort((left, right) => left.page - right.page);
  return {
    document_id: document.id,
    subject: document.subject,
    source_pdf_sha256: pdfSha,
    page_range: gap.page_range,
    pages: pageRows,
    counts: {
      pages: pageRows.length,
      characters: pageRows.reduce((sum, page) => sum + page.character_count, 0),
      low_mean_confidence_pages: pageRows.filter((page) => page.mean_confidence < 0.8).length,
    },
  };
}

function contiguousRanges(pages) {
  const ranges = [];
  for (const page of pages) {
    const current = ranges.at(-1);
    if (current && page === current[1] + 1) current[1] = page;
    else ranges.push([page, page]);
  }
  return ranges;
}

async function buildHybridState(document) {
  const localRoot = path.join(ROOT, '.cache/ocr-production', document.id);
  const localStateBytes = await readFile(path.join(localRoot, 'state.json'));
  const localState = JSON.parse(localStateBytes);
  if (localState.source_sha256 !== document.source_sha256
    || Number(localState.page_count) !== Number(document.page_count)) {
    throw new Error(`${document.id}: local production OCR identity drift`);
  }
  const localCompleted = new Set((localState.completed_pages || []).map(Number));
  const missingPages = Array.from({ length: document.page_count }, (_, index) => index + 1)
    .filter((page) => !localCompleted.has(page));
  for (const pageRange of contiguousRanges(missingPages)) {
    await processDocument(document, { page_range: pageRange });
  }
  const pages = {};
  for (let page = 1; page <= document.page_count; page += 1) {
    if (localCompleted.has(page)) {
      const contentPath = path.join(localRoot, 'pages', String(page).padStart(4, '0'), 'content.md');
      const content = await readFile(contentPath);
      const expected = localState.pages?.[String(page)]?.content_markdown_sha256;
      if (expected && sha256(content) !== expected) throw new Error(`${document.id}: local p.${page} hash drift`);
      pages[String(page)] = {
        origin: 'local_production_snapshot',
        content_sha256: sha256(content),
      };
      continue;
    }
    const sidecarPath = path.join(PRIVATE_ROOT, document.id, `page-${String(page).padStart(4, '0')}.json`);
    const sidecar = await readFile(sidecarPath);
    const record = JSON.parse(sidecar);
    if (record.document_id !== document.id
      || record.physical_pdf_page !== page
      || record.source_pdf_sha256 !== document.source_sha256
      || record.citation_allowed !== false) {
      throw new Error(`${document.id}: candidate p.${page} identity drift`);
    }
    pages[String(page)] = {
      origin: 'candidate_ocr_single_witness_v1',
      sidecar_sha256: sha256(sidecar),
    };
  }
  const state = {
    schema_version: 1,
    profile: 'candidate_hybrid_20260723',
    document_id: document.id,
    source_sha256: document.source_sha256,
    page_count: document.page_count,
    completed_pages: Array.from({ length: document.page_count }, (_, index) => index + 1),
    failed_pages: {},
    citation_allowed: false,
    semantic_claim_allowed: false,
    assertion_boundary: 'Local production OCR and single-witness Apple Vision fallback complete candidate observation coverage only; quotation, citation and semantic claims remain closed.',
    roots: {
      local_production_snapshot: path.relative(ROOT, localRoot),
      candidate_ocr_single_witness_v1: path.relative(ROOT, path.join(PRIVATE_ROOT, document.id)),
    },
    pages,
  };
  const outputRoot = path.join(HYBRID_ROOT, document.id);
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(outputRoot, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  process.stdout.write(`${document.id} hybrid 1-${document.page_count} complete\n`);
}

await compileVisionBinary();
const [queue, coverage] = await Promise.all([
  readFile(QUEUE_PATH, 'utf8').then(JSON.parse),
  readFile(COVERAGE_PATH, 'utf8').then(JSON.parse),
]);
const queueById = new Map(queue.documents.map((document) => [document.id, document]));
let ledger;
if (coverage.gaps.length) {
  const documents = await Promise.all(coverage.gaps.map((gap) => {
    const document = queueById.get(gap.document_id);
    if (!document) throw new Error(`gap document missing from queue: ${gap.document_id}`);
    return processDocument(document, gap);
  }));
  const expectedPages = coverage.gaps.reduce((sum, gap) => sum + gap.remaining_pages, 0);
  const observedPages = documents.reduce((sum, document) => sum + document.counts.pages, 0);
  if (observedPages !== expectedPages) {
    throw new Error(`candidate fallback coverage ${observedPages}/${expectedPages}`);
  }
  ledger = {
    schema_version: 1,
    artifact_profile: 'curriculum-candidate-ocr-fallback-ledger-v1',
    generated_at: new Date().toISOString(),
    source_coverage_sha256: await fileSha256(COVERAGE_PATH),
    policy: {
      purpose: 'complete candidate-only page coverage after bounded primary OCR timeouts',
      private_text_included: false,
      independent_dual_witness_complete: false,
      semantic_claim_allowed: false,
      negative_claim_allowed: false,
      citation_allowed: false
    },
    documents,
    counts: {
      documents: documents.length,
      pages: observedPages,
      characters: documents.reduce((sum, document) => sum + document.counts.characters, 0),
      low_mean_confidence_pages: documents.reduce((sum, document) => sum + document.counts.low_mean_confidence_pages, 0),
      candidate_gap_pages_remaining: 0
    }
  };
  await writeFile(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`);
} else {
  ledger = JSON.parse(await readFile(LEDGER_PATH, 'utf8'));
  if (ledger.artifact_profile !== 'curriculum-candidate-ocr-fallback-ledger-v1'
    || ledger.counts.candidate_gap_pages_remaining !== 0) {
    throw new Error('completed coverage requires the existing immutable candidate fallback ledger');
  }
  for (const record of ledger.documents) {
    const document = queueById.get(record.document_id);
    if (!document) throw new Error(`fallback ledger document missing from queue: ${record.document_id}`);
    const validated = await processDocument(document, { page_range: record.page_range });
    if (validated.counts.pages !== record.counts.pages) {
      throw new Error(`${record.document_id}: fallback sidecar count drift`);
    }
  }
}

if (buildPre2001Hybrid) {
  for (const documentId of [
    'legacy-compendium-geography',
    'legacy-compendium-mathematics',
    'legacy-compendium-politics',
  ]) {
    const document = queueById.get(documentId);
    if (!document) throw new Error(`hybrid document missing from queue: ${documentId}`);
    await buildHybridState(document);
  }
}
process.stdout.write(`${JSON.stringify(ledger.counts)}\n`);
