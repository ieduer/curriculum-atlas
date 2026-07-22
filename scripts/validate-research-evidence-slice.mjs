#!/usr/bin/env node
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  projectResearchEvidenceSlice,
  validateResearchEvidenceSlice,
} from './lib/research-evidence-slice.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MANIFEST = 'data/research-evidence/zh-hs-2017-2020.json';

function parseArgs(argv) {
  const options = {
    manifest: DEFAULT_MANIFEST,
    resourceMap: null,
    output: null,
    requirePublicationEligible: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--manifest') options.manifest = argv[++index];
    else if (arg === '--resource-map') options.resourceMap = argv[++index];
    else if (arg === '--output') options.output = argv[++index];
    else if (arg === '--require-publication-eligible') options.requirePublicationEligible = true;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!options.resourceMap) throw new Error('--resource-map is required; private evidence paths are never inferred');
  return options;
}

async function readRegularJson(filePath, label) {
  const resolved = path.resolve(filePath);
  const state = await lstat(resolved);
  if (!state.isFile() || state.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return JSON.parse(await readFile(resolved, 'utf8'));
}

function resourcePathsFromMap(resourceMap) {
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestPath = path.isAbsolute(options.manifest)
    ? options.manifest
    : path.join(PROJECT_ROOT, options.manifest);
  const manifest = await readRegularJson(manifestPath, 'research evidence manifest');
  const resourceMap = await readRegularJson(options.resourceMap, 'resource map');
  const validation = validateResearchEvidenceSlice({
    manifest,
    resourcePaths: resourcePathsFromMap(resourceMap),
  });
  const result = {
    validation,
    projection: validation.evidence_integrity_valid
      ? projectResearchEvidenceSlice({ manifest, validation })
      : null,
  };
  if (options.output) await writeOwnerOnlyJson(options.output, result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!validation.evidence_integrity_valid) process.exitCode = 2;
  else if (options.requirePublicationEligible
    && validation.assertions.some((item) => item.publication_eligible !== true)) process.exitCode = 3;
}

main().catch((error) => {
  process.stderr.write(`research evidence validation failed: ${error.message}\n`);
  process.exitCode = 2;
});
