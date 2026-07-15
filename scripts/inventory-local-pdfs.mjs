import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const roots = process.argv.slice(2, -1);
const output = process.argv.at(-1);
if (!output || roots.length === 0) {
  console.error('usage: node scripts/inventory-local-pdfs.mjs <root> [root...] <output.json>');
  process.exit(64);
}

async function walk(path) {
  const metadata = await stat(path);
  if (metadata.isFile()) return path.toLowerCase().endsWith('.pdf') ? [path] : [];
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => walk(join(path, entry.name))))).flat();
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function fileMagic(path) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(8);
    await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString('latin1');
  } finally {
    await handle.close();
  }
}

function infoValue(output, key) {
  const match = output.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim() || null;
}

function meaningfulCharacters(value) {
  return (value.match(/[\p{Script=Han}A-Za-z0-9]/gu) || []).length;
}

const files = (await Promise.all(roots.map((root) => walk(resolve(root))))).flat().sort();
const resolvedRoots = roots.map((root) => resolve(root));
const records = Array(files.length);
let cursor = 0;

async function worker() {
  while (cursor < files.length) {
    const index = cursor++;
    const path = files[index];
    const owningRoot = resolvedRoots.find((root) => path.startsWith(root)) || dirname(path);
    const [metadata, checksum, magic, pdfInfoResult, fontsResult, textResult] = await Promise.all([
      stat(path),
      sha256(path),
      fileMagic(path),
      run('/opt/homebrew/bin/pdfinfo', [path], { maxBuffer: 4 * 1024 * 1024 }).then((result) => ({ ok: true, ...result })).catch((error) => ({ ok: false, stderr: error.stderr || error.message })),
      run('/opt/homebrew/bin/pdffonts', [path], { maxBuffer: 4 * 1024 * 1024 }).then((result) => ({ ok: true, ...result })).catch((error) => ({ ok: false, stderr: error.stderr || error.message })),
      run('/opt/homebrew/bin/pdftotext', ['-enc', 'UTF-8', path, '-'], { maxBuffer: 64 * 1024 * 1024 }).then((result) => ({ ok: true, ...result })).catch((error) => ({ ok: false, stderr: error.stderr || error.message })),
    ]);
    const pdfInfo = pdfInfoResult.stdout || '';
    const fonts = fontsResult.stdout || '';
    const text = textResult.stdout || '';
    const fontLines = fonts.split('\n').slice(2).filter((line) => line.trim() && !line.startsWith('---'));
    records[index] = {
      name: basename(path),
      relative_path: relative(owningRoot, path),
      root_label: basename(owningRoot),
      bytes: metadata.size,
      sha256: checksum,
      pdf_magic: magic.slice(0, 5),
      valid_pdf: magic.startsWith('%PDF-') && pdfInfoResult.ok,
      pages: Number(infoValue(pdfInfo, 'Pages')) || null,
      title: infoValue(pdfInfo, 'Title'),
      author: infoValue(pdfInfo, 'Author'),
      page_size: infoValue(pdfInfo, 'Page size'),
      embedded_font_count: fontLines.length,
      extracted_text_bytes: Buffer.byteLength(text),
      extracted_meaningful_characters: meaningfulCharacters(text),
      needs_ocr: meaningfulCharacters(text) < Math.max(200, (Number(infoValue(pdfInfo, 'Pages')) || 1) * 40),
      errors: [pdfInfoResult, fontsResult, textResult]
        .filter((result) => !result.ok)
        .map((result) => String(result.stderr || 'unknown parser error').split('\n')[0].slice(0, 240)),
    };
    process.stderr.write(`\rinventory ${index + 1}/${files.length}`);
  }
}

await Promise.all(Array.from({ length: 4 }, () => worker()));
process.stderr.write('\n');
const groups = Object.values(Object.groupBy(records, (record) => record.sha256))
  .filter((group) => group.length > 1)
  .map((group) => ({ sha256: group[0].sha256, files: group.map((record) => `${record.root_label}/${record.relative_path}`) }));

await mkdir(dirname(resolve(output)), { recursive: true });
await writeFile(resolve(output), `${JSON.stringify({ generated_at: new Date().toISOString(), files: records.length, exact_duplicate_groups: groups, records }, null, 2)}\n`);
console.log(`Inventoried ${records.length} PDFs; ${groups.length} exact duplicate groups.`);
