import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const defaultSamples = [
  '/private/tmp/curriculum-atlas-yuwen-samples/page-005.png',
  '/private/tmp/curriculum-atlas-yuwen-samples/page-100.png',
  '/private/tmp/curriculum-atlas-yuwen-samples/page-300.png',
  '/private/tmp/curriculum-atlas-yuwen-samples/page-567.png',
  '/private/tmp/moe-2022-03-page5.png',
];
const samples = (process.argv.slice(2).length ? process.argv.slice(2) : defaultSamples)
  .map((path) => resolve(path));
const outputRoot = resolve('.cache/ocr-benchmark');
const visionDir = resolve(outputRoot, 'apple-vision');
const tesseractDir = resolve(outputRoot, 'tesseract-5.5.2');
await Promise.all([mkdir(visionDir, { recursive: true }), mkdir(tesseractDir, { recursive: true })]);

const { stdout: visionStdout } = await run('/usr/bin/swift', [
  resolve('scripts/vision-ocr-batch.swift'),
  ...samples,
], { maxBuffer: 64 * 1024 * 1024 });

for (const line of visionStdout.split('\n').filter(Boolean)) {
  const result = JSON.parse(line);
  const stem = basename(result.file, extname(result.file));
  await Promise.all([
    writeFile(resolve(visionDir, `${stem}.json`), `${JSON.stringify(result, null, 2)}\n`),
    writeFile(resolve(visionDir, `${stem}.txt`), `${result.lines.map((item) => item.text).join('\n')}\n`),
  ]);
}

for (const sample of samples) {
  const stem = basename(sample, extname(sample));
  const started = performance.now();
  const { stdout } = await run('/opt/homebrew/bin/tesseract', [
    sample,
    'stdout',
    '-l',
    'chi_sim+chi_tra+eng',
    '--psm',
    '6',
  ], { maxBuffer: 64 * 1024 * 1024 });
  await Promise.all([
    writeFile(resolve(tesseractDir, `${stem}.txt`), stdout),
    writeFile(resolve(tesseractDir, `${stem}.json`), `${JSON.stringify({
      file: basename(sample),
      language: 'chi_sim+chi_tra+eng',
      page_segmentation_mode: 6,
      elapsed_seconds: Number(((performance.now() - started) / 1000).toFixed(3)),
      text: stdout,
    }, null, 2)}\n`),
  ]);
}

console.log(JSON.stringify({ vision: visionDir, tesseract: tesseractDir, samples: samples.length }));
