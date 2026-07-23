#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE_CONFIG_PATH = path.join(ROOT, 'data/pre2001-specialist-bounded-source.json');
const LOCAL_COMPENDIA_PATH = path.join(ROOT, 'data/local-compendia.json');
const OUTPUT_ROOT = path.join(ROOT, '.cache/pre2001-targeted-ocr');
const PROFILE = 'targeted_tesseract_20260723';
const DPI = 240;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: ROOT,
    encoding: options.encoding || null,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr;
    throw new Error(`${binary} failed: ${stderr || `exit ${result.status}`}`);
  }
  return result.stdout;
}

function pageRanges(source) {
  const starts = source.starts || [];
  const pages = new Set();
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    if (start.include === false) continue;
    const next = starts[index + 1];
    requireValue(next && Number(next.page) > Number(start.page),
      `${source.document_id} targeted OCR source needs a later sentinel heading`);
    for (let page = Number(start.page); page < Number(next.page); page += 1) pages.add(page);
  }
  return [...pages].sort((left, right) => left - right);
}

async function main() {
  const [sourceConfig, localCompendia] = await Promise.all([
    readFile(SOURCE_CONFIG_PATH, 'utf8').then(JSON.parse),
    readFile(LOCAL_COMPENDIA_PATH, 'utf8').then(JSON.parse),
  ]);
  const documentsById = new Map(localCompendia.documents.map((document) => [document.id, document]));
  const sources = sourceConfig.heading_sources.filter((source) => source.ocr_profile === PROFILE);
  requireValue(sources.length > 0, `no ${PROFILE} sources configured`);

  for (const source of sources) {
    const document = documentsById.get(source.document_id);
    requireValue(document, `unknown targeted OCR document: ${source.document_id}`);
    const sourcePdf = path.join(ROOT, document.local_cache_path);
    const sourceBytes = await readFile(sourcePdf);
    requireValue(sha256(sourceBytes) === document.checksum_sha256,
      `targeted OCR source hash mismatch: ${source.document_id}`);
    const documentRoot = path.join(OUTPUT_ROOT, source.document_id);
    await rm(documentRoot, { recursive: true, force: true });
    await mkdir(documentRoot, { recursive: true });
    const pages = {};
    const completedPages = pageRanges(source);

    for (const page of completedPages) {
      const pageRoot = path.join(documentRoot, 'pages', String(page).padStart(4, '0'));
      const imageBase = path.join(pageRoot, `page-${String(page).padStart(4, '0')}`);
      await mkdir(pageRoot, { recursive: true });
      run('pdftoppm', [
        '-f', String(page),
        '-l', String(page),
        '-r', String(DPI),
        '-png',
        '-singlefile',
        sourcePdf,
        imageBase,
      ]);
      const imagePath = `${imageBase}.png`;
      const imageBytes = await readFile(imagePath);
      const rawText = run('tesseract', [
        imagePath,
        'stdout',
        '-l', 'chi_sim+eng',
        '--psm', '3',
      ], { encoding: 'utf8' });
      const content = String(rawText)
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      requireValue(content.length >= 80,
        `targeted OCR output is unexpectedly short: ${source.document_id} p.${page}`);
      const markdown = `${content}\n`;
      const contentPath = path.join(pageRoot, 'content.md');
      await writeFile(contentPath, markdown);
      pages[String(page)] = {
        status: 'ocr_complete_pending_audit',
        physical_pdf_page: page,
        engine: `tesseract chi_sim+eng psm3 ${DPI}dpi`,
        rendered_image_sha256: sha256(imageBytes),
        content_markdown_sha256: sha256(markdown),
        citation_eligible: false,
      };
    }

    const state = {
      schema_version: 1,
      profile: PROFILE,
      document_id: source.document_id,
      source_path: document.local_cache_path,
      source_sha256: document.checksum_sha256,
      page_count: document.page_count,
      selected_pages: completedPages,
      completed_pages: completedPages,
      failed_pages: {},
      selected_pages_complete: true,
      configuration: {
        engine: 'tesseract',
        languages: ['chi_sim', 'eng'],
        page_segmentation_mode: 3,
        render_dpi: DPI,
      },
      pages,
    };
    await writeFile(path.join(documentRoot, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
    process.stdout.write(
      `Targeted OCR built: ${source.document_id} pages ${completedPages[0]}-${completedPages.at(-1)}.\n`,
    );
  }
}

await main();
