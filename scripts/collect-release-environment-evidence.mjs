#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CORE_TABLE_COUNT_KEYS } from './import-corpus.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_OUTPUT = 'data/release-environment-evidence.json';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const BASE_ASSET_PATHS = [
  'app.js',
  'atlas.js',
  'styles.css',
  'data/concept-evolution.json',
  'data/concept-evolution-academic.json',
];
const GRAPH_SHARD_TRANSPORT = 'immutable-content-addressed-graph-shards-v1';
const ENVIRONMENTS = {
  preview: {
    worker: 'bdfz-curriculum-atlas-preview',
    database: 'bdfz-curriculum-atlas-preview',
    bucket: 'bdfz-curriculum-atlas-sources-preview',
    base_url: 'https://bdfz-curriculum-atlas-preview.bdfz.workers.dev',
    wrangler_env: 'preview',
  },
  production: {
    worker: 'bdfz-curriculum-atlas',
    database: 'bdfz-curriculum-atlas',
    bucket: 'bdfz-curriculum-atlas-sources',
    base_url: 'https://curriculum.bdfz.net',
    wrangler_env: null,
  },
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertGitCommitExists(root, value, label) {
  const commit = String(value || '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error(`${label} is not an exact Git commit`);
  const type = spawnSync('git', ['cat-file', '-t', commit], { cwd: root, encoding: 'utf8' });
  if (type.status !== 0 || type.stdout.trim() !== 'commit') throw new Error(`${label} is not a commit object`);
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (ancestor.status !== 0) throw new Error(`${label} is not an ancestor of HEAD`);
  return commit;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function exactInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function exactCoreCounts(value, label, { allowLegacyEmbeddedItems = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value);
  const requiredKeys = allowLegacyEmbeddedItems
    ? CORE_TABLE_COUNT_KEYS.filter((key) => key !== 'embedded_items')
    : CORE_TABLE_COUNT_KEYS;
  if (!requiredKeys.every((key) => Object.hasOwn(value, key))
      || keys.some((key) => !CORE_TABLE_COUNT_KEYS.includes(key))
      || (!allowLegacyEmbeddedItems && keys.length !== CORE_TABLE_COUNT_KEYS.length)) {
    throw new Error(`${label} must contain the exact core table key set`);
  }
  return Object.fromEntries(requiredKeys.map((key) => [
    key,
    exactInteger(value[key], `${label}.${key}`),
  ]));
}

function validateCorpus(value, label) {
  if (value === null) return null;
  if (!value || value.ready !== true || typeof value.release_id !== 'string'
    || !SHA256_PATTERN.test(String(value.release_fingerprint_sha256 || ''))
    || !SHA256_PATTERN.test(String(value.manifest_sha256 || ''))) {
    throw new Error(`${label} corpus evidence is invalid`);
  }
  const counts = {};
  for (const key of ['documents', 'paragraphs', 'fts_rows', 'page_publication_gates', 'displayed_paragraphs', 'accepted_ocr_documents', 'chunks']) {
    counts[key] = exactInteger(value.counts?.[key], `${label}.corpus.counts.${key}`);
  }
  counts.core_table_counts = exactCoreCounts(value.counts?.core_table_counts, `${label}.corpus.counts.core_table_counts`, {
    allowLegacyEmbeddedItems: true,
  });
  return { ...value, counts };
}

export function validateEnvironmentEvidenceReceipt(value) {
  if (value?.schema_version !== 1 || value?.contract !== 'curriculum_release_environment_evidence_v1') {
    throw new Error('unsupported release environment evidence receipt');
  }
  if (value.generated_by !== 'scripts/collect-release-environment-evidence.mjs') {
    throw new Error('release environment evidence has an unsupported generator');
  }
  for (const name of ['preview', 'production']) {
    const environment = value.environments?.[name];
    if (environment === null) continue;
    if (!environment || environment.environment !== name || !UUID_PATTERN.test(environment.worker_version_id)
      || !UUID_PATTERN.test(environment.deployment_id) || !/^[a-f0-9]{40}$/.test(environment.asset_git_commit)) {
      throw new Error(`${name} environment evidence identity is invalid`);
    }
    const parityAssets = environment.asset_parity?.assets;
    const parityPaths = Array.isArray(parityAssets) ? parityAssets.map((asset) => asset.path) : [];
    const uniqueParityPaths = new Set(parityPaths);
    const legacyParity = environment.asset_parity?.method === 'five_live_assets_byte_equal_git_commit'
      && parityPaths.length === BASE_ASSET_PATHS.length
      && BASE_ASSET_PATHS.every((path) => uniqueParityPaths.has(path));
    const shardedParity = environment.asset_parity?.method === 'git_graph_manifest_live_assets_byte_equal_commit'
      && environment.asset_parity?.transport_profile === GRAPH_SHARD_TRANSPORT
      && SHA256_PATTERN.test(String(environment.asset_parity?.build_revision || ''))
      && uniqueParityPaths.size === parityPaths.length
      && BASE_ASSET_PATHS.every((path) => uniqueParityPaths.has(path))
      && parityPaths.filter((path) => !BASE_ASSET_PATHS.includes(path))
        .every((path) => path.startsWith('data/graph-shards/'))
      && environment.asset_parity?.graph_shard_count === parityPaths.length - BASE_ASSET_PATHS.length
      && environment.asset_parity?.asset_paths_sha256 === sha256([...parityPaths].sort().join('\0'));
    if (environment.asset_parity?.valid !== true || (!legacyParity && !shardedParity)
      || !Array.isArray(parityAssets)
      || parityAssets.some((asset) => !SHA256_PATTERN.test(asset.sha256) || !Number.isSafeInteger(asset.bytes))) {
      throw new Error(`${name} environment asset parity evidence is invalid`);
    }
    if (!Array.isArray(environment.applied_migrations) || !Array.isArray(environment.pending_migrations)) {
      throw new Error(`${name} migration evidence is invalid`);
    }
    if (!Number.isSafeInteger(environment.health?.http_status)
      || !SHA256_PATTERN.test(String(environment.health?.body_sha256 || ''))) {
      throw new Error(`${name} health evidence is invalid`);
    }
    validateCorpus(environment.corpus, name);
    if (!Array.isArray(environment.command_receipts)
      || environment.command_receipts.some((receipt) => receipt.exit_code !== 0
        || !SHA256_PATTERN.test(receipt.stdout_sha256)
        || !SHA256_PATTERN.test(receipt.stderr_sha256))) {
      throw new Error(`${name} command receipts are invalid`);
    }
  }
  const { receipt_sha256: declared, ...projection } = value;
  if (!SHA256_PATTERN.test(String(declared || '')) || sha256(stableStringify(projection)) !== declared) {
    throw new Error('release environment evidence receipt hash mismatch');
  }
  return value;
}

function commandReceipt(id, arguments_, result) {
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr || '');
  return {
    id,
    command: `npx --no-install wrangler ${arguments_.join(' ')}`,
    exit_code: result.status,
    stdout_sha256: sha256(stdout),
    stdout_bytes: stdout.length,
    stderr_sha256: sha256(stderr),
    stderr_bytes: stderr.length,
  };
}

function runWrangler(root, id, arguments_) {
  const fullArguments = ['--no-install', 'wrangler', ...arguments_];
  const result = spawnSync('npx', fullArguments, { cwd: root, encoding: null, maxBuffer: 64 * 1024 * 1024 });
  const receipt = commandReceipt(id, arguments_, result);
  if (result.status !== 0) {
    const stderr = Buffer.from(result.stderr || '').toString('utf8').trim();
    throw new Error(`${id} failed with exit ${result.status}: ${stderr.slice(0, 2000)}`);
  }
  return { stdout: Buffer.from(result.stdout || ''), receipt };
}

function gitBlob(root, commit, path) {
  const result = spawnSync('git', ['show', `${commit}:public/${path}`], { cwd: root, encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Git asset is missing at ${commit}:public/${path}`);
  return Buffer.from(result.stdout || '');
}

function assetPathsForCommit(root, commit) {
  const indexes = ['data/concept-evolution.json', 'data/concept-evolution-academic.json']
    .map((assetPath) => JSON.parse(gitBlob(root, commit, assetPath).toString('utf8')));
  if (indexes.some((index) => index.transport_profile !== GRAPH_SHARD_TRANSPORT)
    || indexes[0].build_revision !== indexes[1].build_revision) {
    throw new Error('Git graph indexes do not share one immutable shard revision');
  }
  const shardPaths = indexes.flatMap((index) => index.shard_manifest?.assets || []).map((asset) => {
    if (asset.build_revision !== index.build_revision || typeof asset.path !== 'string'
      || !asset.path.startsWith('/data/graph-shards/') || asset.path.includes('..')) {
      throw new Error(`Git graph shard descriptor is invalid: ${asset.id || 'unknown'}`);
    }
    return asset.path.slice(1);
  });
  if (new Set(shardPaths).size !== shardPaths.length) throw new Error('Git graph shard paths are duplicated');
  return {
    paths: [...BASE_ASSET_PATHS, ...shardPaths].sort(),
    buildRevision: indexes[0].build_revision,
    graphShardCount: shardPaths.length,
  };
}

async function fetchBytes(url) {
  const response = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { response, bytes };
}

function normalizeCorpus(health) {
  const corpus = health?.corpus;
  if (!corpus?.ready || !corpus.releaseId || !corpus.releaseFingerprintSha256
    || !corpus.manifestSha256 || !corpus.expected || !corpus.live) return null;
  const expected = {
    documents: corpus.expected.documents,
    paragraphs: corpus.expected.paragraphs,
    fts_rows: corpus.expected.ftsRows,
    page_publication_gates: corpus.expected.pageGates,
    displayed_paragraphs: corpus.expected.displayedParagraphs,
    accepted_ocr_documents: corpus.expected.acceptedOcrDocuments,
    chunks: corpus.expected.chunks,
  };
  const live = {
    documents: corpus.live.documents,
    paragraphs: corpus.live.paragraphs,
    fts_rows: corpus.live.ftsRows,
    page_publication_gates: corpus.live.pageGates,
    displayed_paragraphs: corpus.live.displayedParagraphs,
    accepted_ocr_documents: corpus.live.acceptedOcrDocuments,
    chunks: corpus.live.chunks,
  };
  expected.core_table_counts = exactCoreCounts(corpus.expected.coreTables, 'health.corpus.expected.coreTables');
  live.core_table_counts = exactCoreCounts(corpus.live.coreTables, 'health.corpus.live.coreTables');
  if (stableStringify(expected) !== stableStringify(live)) throw new Error('health corpus expected/live counts differ');
  return {
    ready: true,
    release_id: corpus.releaseId,
    release_fingerprint_sha256: corpus.releaseFingerprintSha256,
    manifest_sha256: corpus.manifestSha256,
    counts: expected,
  };
}

async function collectEnvironment(root, name, assetCommit, observedAt) {
  const config = ENVIRONMENTS[name];
  if (!config) throw new Error(`unsupported environment: ${name}`);
  assertGitCommitExists(root, assetCommit, `${name} asset commit`);
  const commandReceipts = [];

  const deployment = runWrangler(root, 'deployments_status', [
    'deployments', 'status', '--name', config.worker, '--json',
  ]);
  commandReceipts.push(deployment.receipt);
  const deploymentJson = JSON.parse(deployment.stdout.toString('utf8'));
  const activeVersions = (deploymentJson.versions || []).filter((version) => version.percentage === 100);
  if (activeVersions.length !== 1 || !UUID_PATTERN.test(activeVersions[0].version_id)) {
    throw new Error(`${name} does not have exactly one 100-percent Worker version`);
  }
  const workerVersionId = activeVersions[0].version_id;

  const version = runWrangler(root, 'version_view', [
    'versions', 'view', workerVersionId, '--name', config.worker, '--json',
  ]);
  commandReceipts.push(version.receipt);
  JSON.parse(version.stdout.toString('utf8'));

  const migrationArguments = ['d1', 'migrations', 'list', config.database];
  if (config.wrangler_env) migrationArguments.push('--env', config.wrangler_env);
  migrationArguments.push('--remote');
  const migrations = runWrangler(root, 'd1_migrations_list', migrationArguments);
  commandReceipts.push(migrations.receipt);
  const migrationOutput = migrations.stdout.toString('utf8');
  const availableMigrations = (await readdir(resolve(root, 'migrations')))
    .filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
  const pendingMigrations = availableMigrations.filter((file) => migrationOutput.includes(file));
  if (pendingMigrations.length === 0 && !/No migrations to apply|Migrations to be applied/i.test(migrationOutput)) {
    throw new Error(`${name} migration output is not recognized`);
  }
  const appliedMigrations = availableMigrations.filter((file) => !pendingMigrations.includes(file));

  const cacheBust = encodeURIComponent(observedAt);
  const healthFetch = await fetchBytes(`${config.base_url}/api/health?release-evidence=${cacheBust}`);
  const healthBodySha256 = sha256(healthFetch.bytes);
  let health;
  try {
    health = JSON.parse(healthFetch.bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${name} health is not JSON: ${error.message}`);
  }

  const assetPlan = assetPathsForCommit(root, assetCommit);
  const assets = [];
  for (const path of assetPlan.paths) {
    const expected = gitBlob(root, assetCommit, path);
    const live = await fetchBytes(`${config.base_url}/${path}?release-evidence=${cacheBust}`);
    if (live.response.status !== 200 || !expected.equals(live.bytes)) {
      throw new Error(`${name} live asset differs from Git ${assetCommit}: public/${path}`);
    }
    assets.push({ path, sha256: sha256(live.bytes), bytes: live.bytes.length });
  }

  let pointer = { exists: false };
  const pointerArguments = [
    'r2', 'object', 'get', `${config.bucket}/release/current.json`, '--pipe', '--remote',
  ];
  const pointerResult = spawnSync('npx', ['--no-install', 'wrangler', ...pointerArguments], {
    cwd: root, encoding: null, maxBuffer: 64 * 1024 * 1024,
  });
  if (pointerResult.status === 0) {
    const bytes = Buffer.from(pointerResult.stdout || '');
    const parsed = JSON.parse(bytes.toString('utf8'));
    pointer = {
      exists: true,
      sha256: sha256(bytes),
      bytes: bytes.length,
      release_id: parsed.release_id,
      release_manifest_key: parsed.release_manifest_key,
    };
    commandReceipts.push(commandReceipt('r2_current_pointer', pointerArguments, pointerResult));
  } else {
    const stderr = Buffer.from(pointerResult.stderr || '').toString('utf8');
    if (!/(?:NoSuchKey|does not exist|not found|404|10007)/i.test(stderr)) {
      throw new Error(`${name} R2 pointer read failed: ${stderr.trim().slice(0, 2000)}`);
    }
    const missingReceipt = commandReceipt('r2_current_pointer_absent', pointerArguments, pointerResult);
    commandReceipts.push({ ...missingReceipt, exit_code: 0, observed_remote_absence: true });
  }

  const healthGitCommit = health.release?.gitCommit || null;
  if (healthGitCommit !== null && healthGitCommit !== assetCommit) {
    throw new Error(`${name} health Git commit ${healthGitCommit} differs from asset commit ${assetCommit}`);
  }
  return {
    environment: name,
    observed_at: observedAt,
    worker_name: config.worker,
    worker_version_id: workerVersionId,
    deployment_id: deploymentJson.id,
    deployment_created_on: deploymentJson.created_on,
    asset_git_commit: assetCommit,
    asset_parity: {
      valid: true,
      method: 'git_graph_manifest_live_assets_byte_equal_commit',
      transport_profile: GRAPH_SHARD_TRANSPORT,
      build_revision: assetPlan.buildRevision,
      graph_shard_count: assetPlan.graphShardCount,
      asset_paths_sha256: sha256(assetPlan.paths.join('\0')),
      assets,
    },
    applied_migrations: appliedMigrations,
    pending_migrations: pendingMigrations,
    r2_release_reader: health.release?.r2Reader || 'stable_keys_v0',
    health: {
      url: `${config.base_url}/api/health`,
      http_status: healthFetch.response.status,
      ok: health.ok === true,
      version: health.version || null,
      release_git_commit: healthGitCommit,
      body_sha256: healthBodySha256,
      bytes: healthFetch.bytes.length,
    },
    corpus: normalizeCorpus(health),
    r2_current_pointer: pointer,
    command_receipts: commandReceipts,
  };
}

export async function collectReleaseEnvironmentEvidence({
  root = DEFAULT_ROOT,
  output = DEFAULT_OUTPUT,
  environment,
  assetCommit,
  observedAt = new Date().toISOString(),
} = {}) {
  if (!ENVIRONMENTS[environment]) throw new Error('--environment must be preview or production');
  if (!assetCommit) {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (head.status !== 0) throw new Error('cannot resolve the current Git HEAD');
    assetCommit = head.stdout.trim();
  }
  const outputPath = resolve(root, output);
  let previous = null;
  try {
    previous = validateEnvironmentEvidenceReceipt(JSON.parse(await readFile(outputPath, 'utf8')));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const environments = {
    preview: previous?.environments?.preview || null,
    production: previous?.environments?.production || null,
    [environment]: await collectEnvironment(resolve(root), environment, assetCommit, observedAt),
  };
  const receipt = {
    schema_version: 1,
    contract: 'curriculum_release_environment_evidence_v1',
    generated_by: 'scripts/collect-release-environment-evidence.mjs',
    observed_at: observedAt,
    environments,
  };
  const complete = validateEnvironmentEvidenceReceipt({
    ...receipt,
    receipt_sha256: sha256(stableStringify(receipt)),
  });
  await writeFile(outputPath, `${JSON.stringify(complete, null, 2)}\n`, 'utf8');
  return complete;
}

function parseArgs(argv) {
  const result = { root: DEFAULT_ROOT, output: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    if (key === '--environment') result.environment = value;
    else if (key === '--asset-commit') result.assetCommit = value;
    else if (key === '--root') result.root = value;
    else if (key === '--output') result.output = value;
    else throw new Error(`unexpected argument: ${key}`);
    index += 1;
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const receipt = await collectReleaseEnvironmentEvidence(options);
  const environment = receipt.environments[options.environment];
  process.stdout.write(`${options.environment} worker=${environment.worker_version_id} migrations=${environment.applied_migrations.length} corpus=${environment.corpus?.release_id || 'absent'} receipt=${receipt.receipt_sha256}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`collect-release-environment-evidence: ${error.message}\n`);
    process.exitCode = 1;
  });
}
