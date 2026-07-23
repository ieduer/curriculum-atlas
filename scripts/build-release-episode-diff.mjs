#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(new URL('..', import.meta.url).pathname);
const checkOnly = process.argv.includes('--check');
const baselineTag = 'curriculum-baseline-20260723-7cedbe95';
const outputPath = resolve(root, 'data/release-episode-diff.json');
const layers = [
  ['core', 'public/data/concept-evolution.json', (value) => value.episodes],
  ['ocr', 'public/data/ocr-observation-layer.json', (value) => value.episodes],
  ['subject_detail', 'public/data/subject-detail-observation-layer.json', (value) => value.episodes],
  ['pre2001_subject_detail', 'public/data/pre2001-subject-detail-observation-layer.json', (value) => value.episodes],
  ['century', 'public/data/century-observation-layer.json', (value) => value.star_projection.episodes],
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

const baselineCommit = git(['rev-list', '-n', '1', baselineTag]).trim();
if (!/^[0-9a-f]{40}$/.test(baselineCommit)) throw new Error(`invalid baseline commit: ${baselineCommit}`);
const baselineById = new Map();
const currentById = new Map();
const inputFingerprints = {};

for (const [layer, path, select] of layers) {
  const baselineText = git(['show', `${baselineTag}:${path}`]);
  const currentText = await readFile(resolve(root, path), 'utf8');
  inputFingerprints[path] = {
    baseline_sha256: sha256(baselineText),
    current_sha256: sha256(currentText),
  };
  for (const episode of select(JSON.parse(baselineText))) {
    if (baselineById.has(episode.id)) throw new Error(`duplicate baseline episode id: ${episode.id}`);
    baselineById.set(episode.id, { layer, episode });
  }
  for (const episode of select(JSON.parse(currentText))) {
    if (currentById.has(episode.id)) throw new Error(`duplicate current episode id: ${episode.id}`);
    currentById.set(episode.id, { layer, episode });
  }
}

const added = [];
const removed = [];
const updated = [];
let unchanged = 0;
for (const [id, current] of [...currentById.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  const baseline = baselineById.get(id);
  if (!baseline) {
    added.push({ id, layer: current.layer, fingerprint_sha256: sha256(stableStringify(current.episode)) });
    continue;
  }
  const baselineFingerprint = sha256(stableStringify(baseline.episode));
  const currentFingerprint = sha256(stableStringify(current.episode));
  if (baselineFingerprint === currentFingerprint && baseline.layer === current.layer) {
    unchanged += 1;
    continue;
  }
  const fields = [...new Set([
    ...Object.keys(baseline.episode),
    ...Object.keys(current.episode),
  ])].filter((field) => stableStringify(baseline.episode[field]) !== stableStringify(current.episode[field])).sort();
  updated.push({
    id,
    baseline_layer: baseline.layer,
    current_layer: current.layer,
    changed_top_level_fields: fields,
    baseline_fingerprint_sha256: baselineFingerprint,
    current_fingerprint_sha256: currentFingerprint,
  });
}
for (const [id, baseline] of [...baselineById.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  if (!currentById.has(id)) {
    removed.push({ id, layer: baseline.layer, fingerprint_sha256: sha256(stableStringify(baseline.episode)) });
  }
}
const crossLayerMoves = updated.filter((item) => item.baseline_layer !== item.current_layer);
const receipt = {
  schema_version: 1,
  artifact_profile: 'curriculum-release-episode-diff-v1',
  baseline: {
    tag: baselineTag,
    commit: baselineCommit,
    production_worker_version_id: '7cedbe95-fed7-432b-85ef-d89a3baf2d6f',
  },
  input_fingerprints: inputFingerprints,
  release_gate: {
    stable_ids_preserved: removed.length === 0 && crossLayerMoves.length === 0,
    removed_episode_count_allowed: 0,
    cross_layer_move_count_allowed: 0,
    deployment_allowed: removed.length === 0 && crossLayerMoves.length === 0,
  },
  counts: {
    baseline: baselineById.size,
    current: currentById.size,
    added: added.length,
    removed: removed.length,
    updated: updated.length,
    unchanged,
    cross_layer_moves: crossLayerMoves.length,
  },
  added,
  removed,
  updated,
};
const output = `${JSON.stringify(receipt, null, 2)}\n`;
if (checkOnly) {
  if (await readFile(outputPath, 'utf8') !== output) {
    throw new Error('data/release-episode-diff.json is stale; run npm run release:episodes:build');
  }
} else {
  await writeFile(outputPath, output);
}
if (!receipt.release_gate.deployment_allowed) {
  throw new Error(`episode release gate blocked: removed=${removed.length} cross_layer_moves=${crossLayerMoves.length}`);
}
console.log(`PASS episodes ${baselineById.size}→${currentById.size}; +${added.length} -${removed.length} ~${updated.length}`);
