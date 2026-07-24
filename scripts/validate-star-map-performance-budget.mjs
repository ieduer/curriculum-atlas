#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const checkOnly = process.argv.includes('--check');
const budgetPath = resolve(root, 'data/star-map-performance-budget.json');
const outputPath = resolve(root, 'data/star-map-performance-validation.json');
const graphFiles = [
  'public/data/concept-evolution.json',
  'public/data/ocr-observation-layer.json',
  'public/data/subject-detail-observation-layer.json',
  'public/data/pre2001-subject-detail-observation-layer.json',
  'public/data/century-observation-layer.json',
  'public/data/concept-evolution-families.json',
];
const frontendFiles = ['public/index.html', 'public/app.js', 'public/atlas.js', 'public/styles.css'];
const budgetText = await readFile(budgetPath, 'utf8');
const budget = JSON.parse(budgetText);
const texts = Object.fromEntries(await Promise.all([...graphFiles, ...frontendFiles]
  .map(async (path) => [path, await readFile(resolve(root, path), 'utf8')])));
const graphs = Object.fromEntries(graphFiles.map((path) => [path, JSON.parse(texts[path])]));
const century = graphs['public/data/century-observation-layer.json'].star_projection;
const episodeCollections = [
  graphs['public/data/concept-evolution.json'].episodes,
  graphs['public/data/ocr-observation-layer.json'].episodes,
  graphs['public/data/subject-detail-observation-layer.json'].episodes,
  graphs['public/data/pre2001-subject-detail-observation-layer.json'].episodes,
  century.episodes,
];
const edgeCollections = [
  graphs['public/data/concept-evolution.json'].edges,
  graphs['public/data/ocr-observation-layer.json'].edges,
  graphs['public/data/subject-detail-observation-layer.json'].edges,
  graphs['public/data/pre2001-subject-detail-observation-layer.json'].edges,
  century.edges,
  graphs['public/data/concept-evolution-families.json'].edges,
];
const evidenceCollections = [
  graphs['public/data/concept-evolution.json'].evidence,
  graphs['public/data/ocr-observation-layer.json'].evidence,
  graphs['public/data/subject-detail-observation-layer.json'].evidence,
  graphs['public/data/pre2001-subject-detail-observation-layer.json'].evidence,
  century.evidence,
];
const observed = {
  initial_graph_data_raw_bytes: graphFiles.reduce((sum, path) => sum + Buffer.byteLength(texts[path]), 0),
  frontend_raw_bytes: frontendFiles.reduce((sum, path) => sum + Buffer.byteLength(texts[path]), 0),
  merged_episode_count: episodeCollections.reduce((sum, items) => sum + items.length, 0),
  merged_edge_count: edgeCollections.reduce((sum, items) => sum + items.length, 0),
  merged_evidence_count: evidenceCollections.reduce((sum, items) => sum + items.length, 0),
  canvas_device_pixel_ratio: Number(texts['public/atlas.js'].match(/this\.dpr = Math\.min\((\d+)/)?.[1]),
  mobile_automatic_label_count: Number(texts['public/atlas.js']
    .match(/const automaticLimit = this\.width <= 640 \? (\d+)/)?.[1]),
  canvas_animation_fps: 1000 / Number(texts['public/atlas.js']
    .match(/this\.animationFrameInterval = (\d+)/)?.[1]),
};
const checks = Object.entries(budget.static).map(([budgetKey, maximum]) => {
  const observedKey = budgetKey.replace(/_max$/, '');
  return {
    id: `static.${observedKey}`,
    passed: Number(observed[observedKey]) <= Number(maximum),
    observed: observed[observedKey],
    maximum,
  };
});
const failed = checks.filter((item) => !item.passed);
const fingerprints = Object.fromEntries(Object.entries(texts)
  .map(([path, value]) => [path, createHash('sha256').update(value).digest('hex')]));
const receipt = {
  schema_version: 1,
  artifact_profile: 'curriculum-star-map-performance-validation-v1',
  budget_id: budget.budget_id,
  release_decision: failed.length ? 'block' : 'pass',
  deployment_allowed: failed.length === 0,
  source_fingerprints: {
    'data/star-map-performance-budget.json': createHash('sha256').update(budgetText).digest('hex'),
    ...fingerprints,
  },
  observed,
  checks,
};
const output = `${JSON.stringify(receipt, null, 2)}\n`;
if (checkOnly) {
  if (await readFile(outputPath, 'utf8') !== output) {
    throw new Error('data/star-map-performance-validation.json is stale; run npm run performance:validate');
  }
} else {
  await writeFile(outputPath, output);
}
if (failed.length) throw new Error(`star-map performance budget failed: ${failed.map((item) => item.id).join(', ')}`);
console.log(`PASS ${checks.length}/${checks.length} static star-map performance budgets`);
