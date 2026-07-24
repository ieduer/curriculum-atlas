#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const QUEUE_PATH = path.join(ROOT, 'data/ocr-queue.json');
const PRIMARY_ROOT = path.join(ROOT, '.cache/ocr-production');
const OUTPUT_ROOT = path.join(ROOT, '.cache/ocr-generic-fallback-v18');
const DOCUMENT_IDS = [
  'legacy-compendium-biology',
  'legacy-compendium-general-primary',
];
const MUTool = '/opt/homebrew/bin/mutool';
const TESSERACT = '/opt/homebrew/bin/tesseract';
const CONCURRENCY = 6;
const exec = promisify(execFile);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function assert(condition, message) {
  if (!condition) throw new Error(`OCR generic fallback: ${message}`);
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function mapConcurrent(values, mapper, concurrency = CONCURRENCY) {
  const output = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(values.length, concurrency) }, () => worker()));
  return output;
}

async function loadExistingReceipt(target, identity) {
  if (!(await exists(target))) return null;
  try {
    const raw = await readFile(target);
    const receipt = JSON.parse(raw);
    if (receipt.document_id !== identity.documentId
      || receipt.physical_pdf_page !== identity.page
      || receipt.source_pdf_sha256 !== identity.sourceSha256
      || receipt.engine !== 'Tesseract 5.5.2 chi_sim+eng psm6 candidate fallback'
      || receipt.citation_allowed !== false
      || !/^[a-f0-9]{64}$/u.test(receipt.rendered_image_sha256)
      || sha256(`${receipt.text}\n`) !== receipt.text_sha256) {
      return null;
    }
    return { raw, receipt };
  } catch {
    return null;
  }
}

async function recognizePage({ document, page, outputPath, tempRoot }) {
  const identity = {
    documentId: document.id,
    page,
    sourceSha256: document.source_sha256,
  };
  const existing = await loadExistingReceipt(outputPath, identity);
  if (existing) return existing.receipt;
  const imagePath = path.join(
    tempRoot,
    `${document.id}-page-${String(page).padStart(4, '0')}.png`,
  );
  await exec(MUTool, [
    'draw',
    '-q',
    '-F', 'png',
    '-r', '180',
    '-o', imagePath,
    path.join(ROOT, document.local_cache_path),
    String(page),
  ], { maxBuffer: 8 * 1024 * 1024 });
  const imageRaw = await readFile(imagePath);
  const { stdout } = await exec(TESSERACT, [
    imagePath,
    'stdout',
    '-l', 'chi_sim+eng',
    '--psm', '6',
  ], { maxBuffer: 16 * 1024 * 1024 });
  const text = stdout.replace(/\r\n/gu, '\n').trim();
  const receipt = {
    schema_version: 1,
    artifact_profile: 'curriculum-ocr-generic-fallback-page-v1',
    document_id: document.id,
    physical_pdf_page: page,
    source_pdf_sha256: document.source_sha256,
    rendered_image_sha256: sha256(imageRaw),
    render_dpi: 180,
    renderer: 'MuPDF mutool',
    engine: 'Tesseract 5.5.2 chi_sim+eng psm6 candidate fallback',
    text,
    text_sha256: sha256(`${text}\n`),
    citation_allowed: false,
    semantic_claim_allowed: false,
  };
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

async function buildDocument(document, { check }) {
  const primaryStatePath = path.join(PRIMARY_ROOT, document.id, 'state.json');
  const primaryStateRaw = await readFile(primaryStatePath);
  const primaryState = JSON.parse(primaryStateRaw);
  assert(primaryState.document_id === document.id, `${document.id} primary state identity drift`);
  assert(primaryState.source_sha256 === document.source_sha256,
    `${document.id} primary source hash drift`);
  assert(primaryState.page_count === document.page_count,
    `${document.id} primary page count drift`);
  const completed = new Set((primaryState.completed_pages || []).map(Number));
  const failed = new Set(Object.keys(primaryState.failed_pages || {}).map(Number));
  const missingPages = Array.from({ length: document.page_count }, (_, index) => index + 1)
    .filter((page) => !completed.has(page) || failed.has(page));
  const documentRoot = path.join(OUTPUT_ROOT, document.id);
  const pageRoot = path.join(documentRoot, 'pages');
  await mkdir(pageRoot, { recursive: true });
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'curriculum-ocr-fallback-v18-'));
  try {
    const receipts = await mapConcurrent(missingPages, async (page) => {
      const outputPath = path.join(pageRoot, `page-${String(page).padStart(4, '0')}.json`);
      if (check) {
        const receipt = await loadExistingReceipt(outputPath, {
          documentId: document.id,
          page,
          sourceSha256: document.source_sha256,
        });
        assert(receipt, `${document.id} page ${page} fallback receipt missing or stale`);
        return receipt.receipt;
      }
      return recognizePage({ document, page, outputPath, tempRoot });
    });
    const pages = Object.fromEntries(receipts.map((receipt) => [
      String(receipt.physical_pdf_page),
      {
        sidecar: `pages/page-${String(receipt.physical_pdf_page).padStart(4, '0')}.json`,
        sidecar_sha256: sha256(`${JSON.stringify(receipt, null, 2)}\n`),
        text_sha256: receipt.text_sha256,
        rendered_image_sha256: receipt.rendered_image_sha256,
      },
    ]));
    const state = {
      schema_version: 1,
      profile: 'candidate_hybrid_tesseract_v18',
      document_id: document.id,
      source_sha256: document.source_sha256,
      page_count: document.page_count,
      primary_state_sha256: sha256(primaryStateRaw),
      primary_completed_pages: [...completed].sort((left, right) => left - right),
      fallback_pages: missingPages,
      completed_pages: Array.from({ length: document.page_count }, (_, index) => index + 1),
      failed_pages: {},
      pages,
      citation_allowed: false,
      semantic_claim_allowed: false,
    };
    const expected = `${JSON.stringify(state, null, 2)}\n`;
    const statePath = path.join(documentRoot, 'state.json');
    if (check) {
      assert(await readFile(statePath, 'utf8') === expected, `${document.id} fallback state is stale`);
    } else {
      await writeFile(statePath, expected);
    }
    return {
      document_id: document.id,
      primary_pages: completed.size,
      fallback_pages: missingPages.length,
      total_pages: document.page_count,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const check = process.argv.includes('--check');
  const queue = JSON.parse(await readFile(QUEUE_PATH, 'utf8'));
  const byId = new Map(queue.documents.map((document) => [document.id, document]));
  const documents = DOCUMENT_IDS.map((id) => {
    const document = byId.get(id);
    assert(document, `${id} is absent from OCR queue`);
    return document;
  });
  await mkdir(OUTPUT_ROOT, { recursive: true });
  const results = [];
  for (const document of documents) results.push(await buildDocument(document, { check }));
  process.stdout.write(`${JSON.stringify({
    documents: results.length,
    primary_pages: results.reduce((sum, item) => sum + item.primary_pages, 0),
    fallback_pages: results.reduce((sum, item) => sum + item.fallback_pages, 0),
    total_pages: results.reduce((sum, item) => sum + item.total_pages, 0),
  })}\n`);
}

await main();
