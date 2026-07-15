import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const [inputArg, outputArg, auditArg, concurrencyArg = '4'] = process.argv.slice(2);
if (!inputArg || !outputArg || !auditArg) {
  console.error('usage: node scripts/ocr-pdf-vision.mjs <input.pdf> <output.txt> <audit.json> [concurrency]');
  process.exit(64);
}

const input = resolve(inputArg);
const output = resolve(outputArg);
const auditOutput = resolve(auditArg);
const concurrency = Math.max(1, Math.min(8, Number(concurrencyArg) || 4));
const swiftScript = resolve('scripts/vision-ocr-batch.swift');
const temp = await mkdtemp(join(tmpdir(), 'curriculum-vision-ocr-'));

function parseRows(stdout) {
  const rows = stdout.split('\n').filter(Boolean).map((line) => {
    const separator = line.indexOf('\t');
    if (separator < 0) return { confidence: 0, text: line };
    return { confidence: Number(line.slice(0, separator)) || 0, text: line.slice(separator + 1) };
  });
  return {
    text: rows.map((row) => row.text).join('\n'),
    confidences: rows.map((row) => row.confidence),
  };
}

try {
  await Promise.all([mkdir(dirname(output), { recursive: true }), mkdir(dirname(auditOutput), { recursive: true })]);
  await run('/opt/homebrew/bin/pdftoppm', ['-png', '-r', '180', input, join(temp, 'page')], { maxBuffer: 64 * 1024 * 1024 });
  const images = (await readdir(temp)).filter((name) => name.endsWith('.png')).sort();
  const chunks = Array.from({ length: concurrency }, () => []);
  images.forEach((image, index) => chunks[index % concurrency].push(join(temp, image)));
  const pageResults = await Promise.all(chunks.filter((chunk) => chunk.length).map(async (chunk) => {
    const { stdout } = await run('/usr/bin/swift', [swiftScript, ...chunk], { maxBuffer: 64 * 1024 * 1024 });
    return stdout.split('\n').filter(Boolean).map(JSON.parse);
  }));
  const byFile = new Map(pageResults.flat().map((result) => [result.file, result]));
  const pages = images.map((image, index) => {
    const result = byFile.get(image) || { lines: [], error: 'missing_result' };
    const parsed = {
      text: result.lines.map((line) => line.text).join('\n'),
      confidences: result.lines.map((line) => line.confidence),
    };
    const mean = parsed.confidences.length
      ? parsed.confidences.reduce((sum, value) => sum + value, 0) / parsed.confidences.length
      : 0;
    return {
      page: index + 1,
      text: parsed.text,
      lines: parsed.confidences.length,
      characters: parsed.text.length,
      mean_confidence: Number(mean.toFixed(4)),
      minimum_confidence: parsed.confidences.length ? Math.min(...parsed.confidences) : 0,
      low_confidence_lines: parsed.confidences.filter((value) => value < 0.75).length,
      engine_error: result.error || null,
    };
  });
  process.stderr.write('\n');
  await writeFile(output, `${pages.map((page) => page.text).join('\n\f\n')}\n`);
  await writeFile(auditOutput, `${JSON.stringify({
    engine: 'Apple Vision accurate zh-Hans+en-US',
    source: basename(input),
    source_bytes: (await readFile(input)).byteLength,
    pages: pages.length,
    generated_at: new Date().toISOString(),
    metrics: pages.map(({ text: _text, ...metric }) => metric),
  }, null, 2)}\n`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
