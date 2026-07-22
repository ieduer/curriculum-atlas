#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  projectResearchEvidenceSlice,
  validateResearchEvidenceSlice,
} from './lib/research-evidence-slice.mjs';
import { validateCorpusManifest } from './import-corpus.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MANIFEST = 'data/research-evidence/zh-hs-2017-2020.json';
const DEFAULT_SCHEMA = 'data/research-evidence/research-evidence-slice.schema.json';
const DEFAULT_SOURCE_REGISTRY = 'data/research-evidence/zh-hs-2017-2020-source-registry.json';
const DEFAULT_RENDERER = existsSync('/opt/homebrew/bin/pdftoppm')
  ? '/opt/homebrew/bin/pdftoppm'
  : 'pdftoppm';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function parseArgs(argv) {
  const options = {
    manifest: DEFAULT_MANIFEST,
    schema: DEFAULT_SCHEMA,
    rendererPath: DEFAULT_RENDERER,
    resourceMap: null,
    output: null,
    requirePublicationEligible: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') options.root = argv[++index];
    else if (arg === '--manifest') options.manifest = argv[++index];
    else if (arg === '--schema') options.schema = argv[++index];
    else if (arg === '--renderer') options.rendererPath = argv[++index];
    else if (arg === '--resource-map') options.resourceMap = argv[++index];
    else if (arg === '--output') options.output = argv[++index];
    else if (arg === '--require-publication-eligible') options.requirePublicationEligible = true;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  options.resourceMap ||= process.env.CURRICULUM_RESEARCH_EVIDENCE_RESOURCE_MAP || null;
  if (!options.resourceMap) throw new Error('--resource-map or CURRICULUM_RESEARCH_EVIDENCE_RESOURCE_MAP is required; private evidence paths are never inferred');
  return options;
}

async function readExactRegularFile(filePath, expected, label) {
  const state = await lstat(filePath);
  if (!state.isFile() || state.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  const buffer = await readFile(filePath);
  if (buffer.length !== expected.bytes || sha256(buffer) !== expected.sha256) {
    throw new Error(`${label} differs from the immutable corpus manifest`);
  }
  return buffer;
}

async function materializeImmutableCorpusDatabase({ root, manifestPath }) {
  const manifestBuffer = await readFile(manifestPath);
  const manifest = validateCorpusManifest(JSON.parse(manifestBuffer.toString('utf8')));
  const directory = await mkdtemp(path.join(tmpdir(), 'curriculum-research-corpus-'));
  const databasePath = path.join(directory, 'corpus.sqlite');
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA foreign_keys=OFF;');
    const migrationNames = await readdir(path.join(root, 'migrations'));
    for (const name of migrationNames.filter((entry) => /^\d{4}_.+\.sql$/.test(entry)).sort()) {
      const migration = await readFile(path.join(root, 'migrations', name));
      database.exec(new TextDecoder('utf-8', { fatal: true }).decode(migration));
    }
    for (const entry of manifest.sql_files) {
      const sqlPath = path.join(root, 'data/corpus-chunks', entry.name);
      const sql = await readExactRegularFile(sqlPath, entry, `corpus SQL ${entry.name}`);
      database.exec(new TextDecoder('utf-8', { fatal: true }).decode(sql));
    }
    for (const entry of manifest.text_assets) {
      await readExactRegularFile(
        path.join(root, '.cache/text', `${entry.document_id}.txt`),
        entry,
        `corpus text ${entry.document_id}`,
      );
    }
  } catch (error) {
    database.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  database.close();
  const snapshotIdentity = {
    manifest_sha256: sha256(manifestBuffer),
    release_id: manifest.release_id,
    release_fingerprint_sha256: manifest.release_fingerprint_sha256,
    sql_files: manifest.sql_files,
    text_assets: manifest.text_assets,
  };
  return {
    databasePath,
    manifest,
    snapshotSha256: sha256(JSON.stringify(snapshotIdentity)),
    async cleanup() { await rm(directory, { recursive: true, force: true }); },
  };
}

function deterministicPageRenderer(rendererPath) {
  return ({ pdfPath, page, dpi }) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'curriculum-research-page-'));
    const prefix = path.join(directory, 'page');
    try {
      const result = spawnSync(rendererPath, [
        '-f', String(page), '-l', String(page), '-r', String(dpi),
        '-png', '-singlefile', pdfPath, prefix,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (result.error) throw new Error(`pdftoppm could not start: ${result.error.message}`);
      if (result.status !== 0) {
        throw new Error(`pdftoppm exited ${result.status ?? 'unknown'}: ${String(result.stderr || '').trim().slice(0, 500)}`);
      }
      return readFileSync(`${prefix}.png`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

async function readRegularJson(filePath, label) {
  const resolved = path.resolve(filePath);
  const state = await lstat(resolved);
  if (!state.isFile() || state.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return JSON.parse(await readFile(resolved, 'utf8'));
}

function resourcePathsFromMap(resourceMap, overrides = {}) {
  if (resourceMap?.schema_version !== 1 || resourceMap?.policy !== 'local_read_only_research_evidence_resources_v1') {
    throw new Error('resource map policy must be local_read_only_research_evidence_resources_v1 schema 1');
  }
  if (!resourceMap.resources || typeof resourceMap.resources !== 'object' || Array.isArray(resourceMap.resources)) {
    throw new Error('resource map resources must be an object');
  }
  const paths = {};
  for (const [resourceId, resourcePath] of Object.entries(resourceMap.resources)) {
    if (!/^[a-z0-9][a-z0-9:._-]*$/.test(resourceId)) throw new Error(`invalid resource id: ${resourceId}`);
    if (typeof resourcePath !== 'string' || !path.isAbsolute(resourcePath)) {
      throw new Error(`resource ${resourceId} must use an absolute path`);
    }
    paths[resourceId] = resourcePath;
  }
  for (const [resourceId, resourcePath] of Object.entries(overrides)) {
    if (!Object.hasOwn(paths, resourceId)) throw new Error(`resource override is not declared by the resource map: ${resourceId}`);
    if (typeof resourcePath !== 'string' || !path.isAbsolute(resourcePath)) {
      throw new Error(`resource override ${resourceId} must use an absolute path`);
    }
    paths[resourceId] = resourcePath;
  }
  return paths;
}

async function writeOwnerOnlyJson(destination, value) {
  const resolved = path.resolve(destination);
  const directory = path.dirname(resolved);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${resolved}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, resolved);
  await chmod(resolved, 0o600);
}

export async function validateResearchEvidenceSliceFile({
  root = PROJECT_ROOT,
  manifest: manifestName = DEFAULT_MANIFEST,
  schema: schemaName = DEFAULT_SCHEMA,
  sourceRegistry: sourceRegistryName = DEFAULT_SOURCE_REGISTRY,
  resourceMap,
  resourcePathOverrides = {},
  rendererPath = DEFAULT_RENDERER,
} = {}) {
  if (!resourceMap) throw new Error('research evidence resource map is required');
  const projectRoot = path.resolve(root);
  const manifestPath = path.isAbsolute(manifestName)
    ? manifestName
    : path.join(projectRoot, manifestName);
  const schemaPath = path.isAbsolute(schemaName)
    ? schemaName
    : path.join(projectRoot, schemaName);
  const sourceRegistryPath = path.isAbsolute(sourceRegistryName)
    ? sourceRegistryName
    : path.join(projectRoot, sourceRegistryName);
  const manifest = await readRegularJson(manifestPath, 'research evidence manifest');
  const schema = await readRegularJson(schemaPath, 'research evidence schema');
  const sourceRegistry = await readRegularJson(sourceRegistryPath, 'research evidence source registry');
  const resourceMapValue = await readRegularJson(resourceMap, 'resource map');
  const corpusManifestPath = resourcePathOverrides[manifest.corpus.manifest_resource_id]
    || resourcePathsFromMap(resourceMapValue)[manifest.corpus.manifest_resource_id];
  if (path.resolve(corpusManifestPath) !== path.resolve(projectRoot, 'data/corpus-chunks/manifest.json')) {
    throw new Error('research evidence corpus manifest must be the immutable repository manifest');
  }
  const corpus = await materializeImmutableCorpusDatabase({
    root: projectRoot,
    manifestPath: corpusManifestPath,
  });
  try {
    const resourcePaths = resourcePathsFromMap(resourceMapValue, {
      ...resourcePathOverrides,
      [manifest.corpus.resource_id]: corpus.databasePath,
    });
    const validation = validateResearchEvidenceSlice({
      manifest,
      schema,
      sourceRegistry,
      resourcePaths,
      renderPageImage: deterministicPageRenderer(rendererPath || DEFAULT_RENDERER),
    });
    validation.corpus_sql_text_snapshot_sha256 = corpus.snapshotSha256;
    return {
      validation,
      projection: validation.evidence_integrity_valid
        ? projectResearchEvidenceSlice({ manifest, validation })
        : null,
    };
  } finally {
    await corpus.cleanup();
  }
}

export function assertResearchEvidenceReleaseGate(result, { requirePublicationEligible = false } = {}) {
  if (!result?.validation?.evidence_integrity_valid || result.validation.errors?.length) {
    const codes = [...new Set((result?.validation?.errors || []).map((error) => error.code))];
    throw new Error(`research evidence integrity gate failed: ${codes.join(', ') || 'invalid result'}`);
  }
  if (requirePublicationEligible) {
    const blocked = result.validation.assertions
      .filter((item) => item.publication_eligible !== true)
      .map((item) => item.assertion_id);
    if (blocked.length) {
      throw new Error(`research evidence strict publication eligibility gate failed: ${blocked.join(', ')}`);
    }
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await validateResearchEvidenceSliceFile({
    root: options.root || PROJECT_ROOT,
    manifest: options.manifest,
    schema: options.schema,
    resourceMap: options.resourceMap,
    rendererPath: options.rendererPath,
  });
  if (options.output) await writeOwnerOnlyJson(options.output, result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.validation.evidence_integrity_valid) process.exitCode = 2;
  else if (options.requirePublicationEligible
    && result.validation.assertions.some((item) => item.publication_eligible !== true)) process.exitCode = 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`research evidence validation failed: ${error.message}\n`);
    process.exitCode = 2;
  });
}
