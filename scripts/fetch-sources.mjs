import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { sourceManifest } from './source-manifest.mjs';

const run = promisify(execFile);
const projectRoot = new URL('../', import.meta.url);
const root = new URL('../.cache/', import.meta.url);
const sourceDir = new URL('sources/', root);
const textDir = new URL('text/', root);
const highSchoolDir = new URL('high-school-2020/', root);
await Promise.all([mkdir(sourceDir, { recursive: true }), mkdir(textDir, { recursive: true }), mkdir(highSchoolDir, { recursive: true })]);
const binaryPathById = new Map();

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function download(url, destination) {
  if (await exists(destination)) return;
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'BDFZ-Curriculum-Atlas/1.0 source-verification' },
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await writeFile(destination, Buffer.from(await response.arrayBuffer()));
      return;
    } catch (error) {
      lastError = error;
      process.stderr.write(`retry ${attempt}/4 ${url}: ${error.message}\n`);
    }
  }
  throw new Error(`Download failed after retries: ${url}: ${lastError?.message}`);
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function stripHtml(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const directFiles = sourceManifest.filter((item) => item.file_format === 'pdf' && item.access_status === 'verified_online');
let cursor = 0;
async function worker() {
  while (cursor < directFiles.length) {
    const record = directFiles[cursor++];
    const pdfPath = join(sourceDir.pathname, `${record.id}.pdf`);
    const textPath = join(textDir.pathname, `${record.id}.txt`);
    await download(record.source_url, pdfPath);
    binaryPathById.set(record.id, pdfPath);
    if (!(await exists(textPath))) await run('/opt/homebrew/bin/pdftotext', ['-enc', 'UTF-8', pdfPath, textPath]);
    process.stdout.write(`fetched ${record.id}\n`);
  }
}
await Promise.all(Array.from({ length: 3 }, () => worker()));

for (const record of sourceManifest.filter((item) => ['pdf_local', 'pdf_local_research'].includes(item.file_format))) {
  if (!record.local_cache_path) continue;
  const pdfPath = fileURLToPath(new URL(record.local_cache_path, projectRoot));
  if (!(await exists(pdfPath))) throw new Error(`Local source missing for ${record.id}: ${record.local_cache_path}`);
  binaryPathById.set(record.id, pdfPath);
  const textPath = join(textDir.pathname, `${record.id}.txt`);
  if (record.citation_allowed && record.text_quality_status === 'official_native_text' && !(await exists(textPath))) {
    await run('/opt/homebrew/bin/pdftotext', ['-enc', 'UTF-8', '-layout', pdfPath, textPath]);
  }
}

const zipRecord = sourceManifest.find((item) => item.file_format === 'pdf_in_zip');
if (!zipRecord) throw new Error('High-school archive record missing.');
const zipPath = join(sourceDir.pathname, 'moe-hs-2020.zip');
await download(zipRecord.source_url, zipPath);
if ((await readdir(highSchoolDir)).length === 0) {
  await run('/opt/homebrew/bin/7z', ['x', '-y', `-o${highSchoolDir.pathname}`, zipPath], { maxBuffer: 20 * 1024 * 1024 });
}

const archiveFiles = await readdir(highSchoolDir, { recursive: true });
for (const record of sourceManifest.filter((item) => item.file_format === 'pdf_in_zip')) {
  const memberPrefix = `${Number(record.archive_member_prefix)}.`;
  const member = archiveFiles.find((name) => basename(name).startsWith(memberPrefix) && name.toLowerCase().endsWith('.pdf'));
  if (!member) throw new Error(`Archive member not found for ${record.id}`);
  const pdfPath = join(highSchoolDir.pathname, member);
  binaryPathById.set(record.id, pdfPath);
  const textPath = join(textDir.pathname, `${record.id}.txt`);
  if (!(await exists(textPath))) await run('/opt/homebrew/bin/pdftotext', ['-enc', 'UTF-8', pdfPath, textPath]);
}

for (const record of sourceManifest.filter((item) => item.file_format === 'html')) {
  const textPath = join(textDir.pathname, `${record.id}.txt`);
  if (await exists(textPath)) continue;
  const response = await fetch(record.source_url, {
    headers: { 'user-agent': 'BDFZ-Curriculum-Atlas/1.0 source-verification' },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`HTML fetch failed ${response.status}: ${record.source_url}`);
  await writeFile(textPath, stripHtml(await response.text()));
}

const entries = [];
for (const record of sourceManifest) {
  const binaryPath = binaryPathById.get(record.id) || null;
  const textPath = join(textDir.pathname, `${record.id}.txt`);
  entries.push({
    id: record.id,
    fetched: binaryPath ? await exists(binaryPath) : await exists(textPath),
    source_sha256: binaryPath && await exists(binaryPath) ? await sha256(binaryPath) : null,
    text_sha256: await exists(textPath) ? await sha256(textPath) : null,
    source_bytes: binaryPath && await exists(binaryPath) ? (await readFile(binaryPath)).byteLength : null,
    text_bytes: await exists(textPath) ? (await readFile(textPath)).byteLength : null,
  });
}

await writeFile(new URL('../data/ingest-manifest.json', import.meta.url), `${JSON.stringify({ generated_at: new Date().toISOString(), entries }, null, 2)}\n`);
console.log(`Verified ${entries.filter((entry) => entry.fetched).length}/${entries.length} source records.`);
