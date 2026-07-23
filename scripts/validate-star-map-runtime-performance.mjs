#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_OUTPUT = 'data/star-map-runtime-performance.json';
const RUNTIME_SOURCE_FILES = [
  'public/index.html',
  'public/app.js',
  'public/atlas.js',
  'public/styles.css',
  'public/data/concept-evolution.json',
  'public/data/ocr-observation-layer.json',
  'public/data/subject-detail-observation-layer.json',
  'public/data/pre2001-subject-detail-observation-layer.json',
  'public/data/century-observation-layer.json',
  'public/data/concept-evolution-families.json',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function readRuntimeSourceFingerprints(root = DEFAULT_ROOT) {
  const entries = await Promise.all(RUNTIME_SOURCE_FILES.map(async (path) => {
    const value = await readFile(resolve(root, path));
    return [path, sha256(value)];
  }));
  return Object.fromEntries(entries);
}

export function validateRuntimePerformance({
  measurement,
  budget,
  sourceFingerprints,
}) {
  const checks = [];
  const record = (id, passed, observed, maximum) => {
    checks.push({ id, passed: Boolean(passed), observed, maximum });
  };

  record('environment.preview', measurement.environment === 'preview',
    measurement.environment, 'preview');
  record('target.https', /^https:\/\/\S+$/.test(String(measurement.target_url || '')),
    measurement.target_url, 'https URL');
  record('budget.id', measurement.budget_id === budget.budget_id,
    measurement.budget_id, budget.budget_id);
  record('measured_at.valid', Number.isFinite(Date.parse(measurement.measured_at)),
    measurement.measured_at, 'valid ISO timestamp');

  for (const profile of ['desktop', 'mobile']) {
    const observed = measurement.measurements?.[profile] || {};
    const expected = budget.runtime[profile];
    record(`runtime.${profile}.viewport`, equal(observed.viewport, expected.viewport),
      observed.viewport, expected.viewport);
    for (const [field, maximum] of [
      ['ready_ms', expected.ready_ms_max],
      ['resource_transfer_bytes', expected.resource_transfer_bytes_max],
      ['draw_p95_ms', expected.draw_p95_ms_max],
      ['long_task_count', expected.long_task_count_max],
      ['long_task_total_ms', expected.long_task_total_ms_max],
    ]) {
      const value = Number(observed[field]);
      record(`runtime.${profile}.${field}`, Number.isFinite(value) && value >= 0 && value <= maximum,
        observed[field], maximum);
    }
  }

  const failed = checks.filter((item) => !item.passed);
  return {
    schema_version: 1,
    artifact_profile: 'curriculum-star-map-runtime-performance-v1',
    budget_id: budget.budget_id,
    environment: measurement.environment,
    target_url: measurement.target_url,
    measured_at: measurement.measured_at,
    release_git_commit: measurement.release_git_commit || null,
    release_decision: failed.length ? 'block' : 'pass',
    deployment_allowed: failed.length === 0,
    source_fingerprints: sourceFingerprints,
    measurements: measurement.measurements,
    checks,
  };
}

function parseArgs(argv) {
  const options = { check: false, input: null, output: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') options.check = true;
    else if (argument === '--input') options.input = argv[++index];
    else if (argument === '--output') options.output = argv[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.check && options.input) throw new Error('--check and --input cannot be combined');
  if (!options.check && !options.input) {
    throw new Error('usage: validate-star-map-runtime-performance.mjs --input <measurement.json> [--output <receipt.json>] | --check');
  }
  return options;
}

export async function runRuntimePerformanceValidation({
  root = DEFAULT_ROOT,
  check = false,
  input = null,
  output = DEFAULT_OUTPUT,
} = {}) {
  const budget = JSON.parse(await readFile(resolve(root, 'data/star-map-performance-budget.json'), 'utf8'));
  const outputPath = resolve(root, output);
  const currentFingerprints = await readRuntimeSourceFingerprints(root);
  const measurement = check
    ? JSON.parse(await readFile(outputPath, 'utf8'))
    : JSON.parse(await readFile(resolve(root, input), 'utf8'));
  const storedFingerprints = measurement.source_fingerprints;
  const receipt = validateRuntimePerformance({
    measurement,
    budget,
    sourceFingerprints: currentFingerprints,
  });

  if (check && !equal(storedFingerprints, currentFingerprints)) {
    throw new Error('runtime performance receipt is stale: preview source fingerprints do not match the current release');
  }
  if (!check) await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const failed = receipt.checks.filter((item) => !item.passed);
  if (failed.length) {
    throw new Error(`star-map runtime performance failed: ${failed.map((item) => item.id).join(', ')}`);
  }
  if (check && (measurement.release_decision !== 'pass' || measurement.deployment_allowed !== true)) {
    throw new Error('runtime performance receipt does not allow production deployment');
  }
  return receipt;
}

async function main() {
  const receipt = await runRuntimePerformanceValidation(parseArgs(process.argv.slice(2)));
  process.stdout.write(`PASS ${receipt.checks.length}/${receipt.checks.length} preview runtime performance checks\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`runtime-performance: ${error.message}\n`);
    process.exitCode = 1;
  });
}
