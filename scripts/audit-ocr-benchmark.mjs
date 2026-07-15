import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

const projectRoot = new URL('../', import.meta.url);
const groundTruth = JSON.parse(await readFile(new URL('data/ocr-benchmark-ground-truth.json', projectRoot), 'utf8'));
const argv = process.argv.slice(2);
const outputIndex = argv.indexOf('--output-report');
const outputReport = outputIndex >= 0 ? argv[outputIndex + 1] : 'data/ocr-benchmark-results.json';
if (outputIndex >= 0 && !outputReport) throw new Error('--output-report requires a project-relative path.');
if (outputIndex >= 0) argv.splice(outputIndex, 2);
const engineSpecs = argv;
if (engineSpecs.length === 0) {
  throw new Error('Pass engine directories as <label>=<directory>.');
}

async function filesRecursively(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesRecursively(path));
    else if (['.txt', '.md', '.json'].includes(extname(entry.name).toLowerCase())) files.push(path);
  }
  return files;
}

function extractOcrStrings(value, key = '') {
  if (typeof value === 'string') {
    return ['content', 'block_content', 'text'].includes(key) ? [value] : [];
  }
  if (Array.isArray(value)) {
    if (key === 'rec_texts') return value.filter((item) => typeof item === 'string');
    return value.flatMap((item) => extractOcrStrings(item));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([childKey, child]) => extractOcrStrings(child, childKey));
  }
  return [];
}

async function readOcrOutput(path) {
  const raw = await readFile(path, 'utf8');
  if (extname(path).toLowerCase() !== '.json') return raw;
  return extractOcrStrings(JSON.parse(raw)).join('\n');
}

function normalize(value) {
  return value
    .replace(/<[^>]*>/g, '')
    .normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

const engines = [];
for (const spec of engineSpecs) {
  const separator = spec.indexOf('=');
  if (separator < 1) throw new Error(`Invalid engine spec: ${spec}`);
  const label = spec.slice(0, separator);
  const directory = spec.slice(separator + 1);
  const files = await filesRecursively(directory);
  const samples = [];
  for (const truth of groundTruth.samples) {
    const stem = basename(truth.image, extname(truth.image));
    const matchingFiles = files.filter((path) => basename(path).includes(stem));
    const output = normalize((await Promise.all(matchingFiles.map(readOcrOutput))).join('\n'));
    const anchors = truth.anchors.map((anchor) => ({ anchor, matched: output.includes(normalize(anchor)) }));
    const matched = anchors.filter((anchor) => anchor.matched).length;
    samples.push({
      image: truth.image,
      page_type: truth.page_type,
      matching_files: matchingFiles,
      matched_anchors: matched,
      total_anchors: anchors.length,
      anchor_recall: Number((matched / anchors.length).toFixed(4)),
      missed_anchors: anchors.filter((anchor) => !anchor.matched).map((anchor) => anchor.anchor),
    });
  }
  const matched = samples.reduce((sum, sample) => sum + sample.matched_anchors, 0);
  const total = samples.reduce((sum, sample) => sum + sample.total_anchors, 0);
  engines.push({
    label,
    directory,
    anchor_recall: Number((matched / total).toFixed(4)),
    matched_anchors: matched,
    total_anchors: total,
    samples,
  });
}

const report = {
  generated_at: new Date().toISOString(),
  metric: 'Visually reviewed critical-anchor recall after NFKC and punctuation/whitespace normalization; not a substitute for full CER.',
  engines,
};
await writeFile(new URL(outputReport, projectRoot), `${JSON.stringify(report, null, 2)}\n`);
for (const engine of engines) {
  console.log(`${engine.label}: ${engine.matched_anchors}/${engine.total_anchors} (${engine.anchor_recall})`);
  for (const sample of engine.samples) {
    console.log(`  ${basename(sample.image)}: ${sample.matched_anchors}/${sample.total_anchors} missed=${sample.missed_anchors.join(' | ') || '-'}`);
  }
}
