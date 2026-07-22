#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
const RESEARCH_RENDER_DPI = 240;
const RESEARCH_RENDERER_COMMAND_CONTRACT = 'pdftoppm_png_single_page_v1';
const RESEARCH_RENDERER_EXECUTION_BINDING = 'verified_private_read_only_copy_v1';
const RESEARCH_RENDERER_CANDIDATES = Object.freeze([
  '/opt/homebrew/bin/pdftoppm',
  '/usr/local/bin/pdftoppm',
  '/usr/bin/pdftoppm',
]);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function parseArgs(argv) {
  const options = {
    manifest: DEFAULT_MANIFEST,
    schema: DEFAULT_SCHEMA,
    resourceMap: null,
    output: null,
    requirePublicationEligible: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') options.root = argv[++index];
    else if (arg === '--manifest') options.manifest = argv[++index];
    else if (arg === '--schema') options.schema = argv[++index];
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

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function readStableRegularFile(filePath, label) {
  const descriptor = openSync(filePath, 'r');
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    const buffer = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (!sameFileIdentity(before, after) || buffer.length !== before.size) {
      throw new Error(`${label} changed while it was read`);
    }
    return { buffer, identity: after };
  } finally {
    closeSync(descriptor);
  }
}

function runPdftoppm(rendererPath, arguments_, label, environment = process.env) {
  const result = spawnSync(rendererPath, arguments_, {
    encoding: 'utf8',
    env: environment,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(0, 500);
    throw new Error(`${label} exited ${result.status ?? 'unknown'}${detail ? `: ${detail}` : ''}`);
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function pdftoppmVersion(rendererPath, environment = process.env) {
  const output = runPdftoppm(rendererPath, ['-v'], 'pdftoppm version check', environment);
  const match = output.match(/^pdftoppm version [^\r\n]+$/mu);
  if (!match) throw new Error('pdftoppm version output is not unambiguous');
  return match[0];
}

function inspectResearchEvidencePdftoppmInternal() {
  const candidate = RESEARCH_RENDERER_CANDIDATES.find((entry) => existsSync(entry));
  if (!candidate) throw new Error('fixed pdftoppm renderer is unavailable');
  const rendererPath = realpathSync(candidate);
  const renderer = readStableRegularFile(rendererPath, 'pdftoppm renderer');
  if ((renderer.identity.mode & 0o111) === 0) throw new Error('pdftoppm renderer is not executable');
  return {
    path: rendererPath,
    buffer: renderer.buffer,
    identity: {
      name: 'pdftoppm',
      version: pdftoppmVersion(rendererPath),
      sha256: sha256(renderer.buffer),
      command_contract: RESEARCH_RENDERER_COMMAND_CONTRACT,
      execution_binding: RESEARCH_RENDERER_EXECUTION_BINDING,
    },
  };
}

export function inspectResearchEvidencePdftoppm() {
  return inspectResearchEvidencePdftoppmInternal().identity;
}

function assertExpectedRenderer(actual, expected) {
  const keys = ['name', 'version', 'sha256', 'command_contract', 'execution_binding'];
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)
    || Object.keys(expected).length !== keys.length || !keys.every((key) => Object.hasOwn(expected, key))) {
    throw new Error('research evidence renderer identity contract is invalid');
  }
  for (const key of keys) {
    if (expected[key] !== actual[key]) {
      throw new Error(`fixed pdftoppm ${key} differs from the Git-pinned research renderer identity`);
    }
  }
}

export function renderResearchEvidencePdfPage({ pdfBytes, page, dpi, expectedRenderer }) {
  if (!Buffer.isBuffer(pdfBytes) || pdfBytes.length === 0) {
    throw new Error('verified PDF bytes are required for research page rendering');
  }
  if (!Number.isInteger(page) || page < 1) throw new Error('research PDF page must be a positive integer');
  if (dpi !== RESEARCH_RENDER_DPI) throw new Error(`research PDF render DPI must equal ${RESEARCH_RENDER_DPI}`);
  const inspected = inspectResearchEvidencePdftoppmInternal();
  assertExpectedRenderer(inspected.identity, expectedRenderer);
  const directory = mkdtempSync(path.join(tmpdir(), 'curriculum-research-page-'));
  const protectedDirectory = path.join(directory, 'verified-inputs');
  const privateRendererPath = path.join(protectedDirectory, 'pdftoppm');
  const privatePdfPath = path.join(protectedDirectory, 'source.pdf');
  const prefix = path.join(directory, 'page');
  let rendererDescriptor = null;
  let pdfDescriptor = null;
  try {
    chmodSync(directory, 0o700);
    mkdirSync(protectedDirectory, { mode: 0o700 });
    writeFileSync(privateRendererPath, inspected.buffer, { flag: 'wx', mode: 0o700 });
    writeFileSync(privatePdfPath, pdfBytes, { flag: 'wx', mode: 0o600 });
    chmodSync(privateRendererPath, 0o500);
    chmodSync(privatePdfPath, 0o400);
    rendererDescriptor = openSync(privateRendererPath, 'r');
    pdfDescriptor = openSync(privatePdfPath, 'r');
    const rendererIdentity = fstatSync(rendererDescriptor);
    const pdfIdentity = fstatSync(pdfDescriptor);
    chmodSync(protectedDirectory, 0o500);
    const rendererEnvironment = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => !name.startsWith('DYLD_') && !name.startsWith('LD_')));
    const rendererLibraryDirectory = path.resolve(path.dirname(inspected.path), '../lib');
    if (process.platform === 'darwin') rendererEnvironment.DYLD_LIBRARY_PATH = rendererLibraryDirectory;
    else rendererEnvironment.LD_LIBRARY_PATH = rendererLibraryDirectory;
    if (pdftoppmVersion(privateRendererPath, rendererEnvironment) !== inspected.identity.version) {
      throw new Error('private pdftoppm copy version differs from the verified renderer');
    }
    const arguments_ = [
      '-f', String(page), '-l', String(page), '-r', String(dpi),
      '-png', '-singlefile', privatePdfPath, prefix,
    ];
    runPdftoppm(
      privateRendererPath,
      arguments_,
      'deterministic pdftoppm page render',
      rendererEnvironment,
    );
    if (!sameFileIdentity(rendererIdentity, fstatSync(rendererDescriptor))) {
      throw new Error('private pdftoppm inode changed during rendering');
    }
    if (!sameFileIdentity(pdfIdentity, fstatSync(pdfDescriptor))) {
      throw new Error('private source PDF inode changed during rendering');
    }
    if (sha256(readStableRegularFile(privateRendererPath, 'private pdftoppm renderer').buffer)
      !== inspected.identity.sha256) {
      throw new Error('private pdftoppm bytes changed during rendering');
    }
    if (sha256(readStableRegularFile(privatePdfPath, 'private source PDF').buffer) !== sha256(pdfBytes)) {
      throw new Error('private source PDF bytes changed during rendering');
    }
    return {
      buffer: readStableRegularFile(`${prefix}.png`, 'rendered research page').buffer,
      renderer: inspected.identity,
      page,
      dpi,
      arguments: arguments_.map((value) => (
        value === privatePdfPath ? '<PRIVATE_VERIFIED_PDF>' : value === prefix ? '<PRIVATE_OUTPUT_PREFIX>' : value
      )),
    };
  } finally {
    if (rendererDescriptor !== null) closeSync(rendererDescriptor);
    if (pdfDescriptor !== null) closeSync(pdfDescriptor);
    try {
      chmodSync(protectedDirectory, 0o700);
    } catch {
      // A failed spawn may have already made the temporary directory unavailable.
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

function deterministicPageRenderer() {
  return ({ pdfBytes, page, dpi, evidence }) => renderResearchEvidencePdfPage({
    pdfBytes,
    page,
    dpi,
    expectedRenderer: evidence?.page_image?.renderer,
  }).buffer;
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

export async function validateResearchEvidenceSliceFile(options = {}) {
  if (Object.hasOwn(options, 'rendererPath')) {
    throw new Error('research renderer is fixed and cannot be overridden');
  }
  const {
    root = PROJECT_ROOT,
    manifest: manifestName = DEFAULT_MANIFEST,
    schema: schemaName = DEFAULT_SCHEMA,
    sourceRegistry: sourceRegistryName = DEFAULT_SOURCE_REGISTRY,
    resourceMap,
    resourcePathOverrides = {},
  } = options;
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
      renderPageImage: deterministicPageRenderer(),
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
