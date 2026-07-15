import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { open, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const outputPath = path.join(projectRoot, 'data/local-official-scans.json');
const ids = [
  ...Array.from({ length: 19 }, (_, index) => `moe-2011-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 17 }, (_, index) => `moe-2022-${String(index + 1).padStart(2, '0')}`),
];

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function parsePageCount(output, id) {
  const pageCount = Number(output.match(/^Pages:\s+(\d+)$/m)?.[1]);
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error(`${id}: pdfinfo did not return a valid page count`);
  return pageCount;
}

async function pdfHeader(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(5);
    await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString('ascii');
  } finally {
    await handle.close();
  }
}

const documents = [];
for (const id of ids) {
  const localCachePath = `.cache/sources/${id}.pdf`;
  const filePath = path.join(projectRoot, localCachePath);
  const header = await pdfHeader(filePath);
  if (header !== '%PDF-') throw new Error(`${id}: local payload is not a PDF`);

  const [{ stdout: info }, { stdout: nativeText }, fileStat, checksumSha256] = await Promise.all([
    run('pdfinfo', [filePath], { maxBuffer: 4 * 1024 * 1024 }),
    run('pdftotext', ['-enc', 'UTF-8', filePath, '-'], { maxBuffer: 8 * 1024 * 1024 }),
    stat(filePath),
    sha256(filePath),
  ]);
  const pageCount = parsePageCount(info, id);
  const nativeTextCharacters = nativeText.replace(/\s/gu, '').length;
  const scanThreshold = Math.max(512, pageCount * 8);
  if (nativeTextCharacters > scanThreshold) {
    throw new Error(`${id}: ${nativeTextCharacters} native-text characters exceed scan threshold ${scanThreshold}`);
  }

  documents.push({
    id,
    local_cache_path: localCachePath,
    page_count: pageCount,
    checksum_sha256: checksumSha256,
    source_bytes: fileStat.size,
    native_text_characters: nativeTextCharacters,
    text_quality_status: 'ocr_required',
    citation_allowed: false,
  });
}

await writeFile(outputPath, `${JSON.stringify({
  schema_version: 1,
  generated_at: new Date().toISOString(),
  verification_policy: 'Local official MOE PDF; PDF signature, pdfinfo page count, SHA-256, and near-empty native text verified. OCR remains non-citable until independent review.',
  counts: {
    documents: documents.length,
    pages: documents.reduce((sum, document) => sum + document.page_count, 0),
  },
  documents,
}, null, 2)}\n`);

console.log(JSON.stringify({ documents: documents.length, pages: documents.reduce((sum, document) => sum + document.page_count, 0) }));
