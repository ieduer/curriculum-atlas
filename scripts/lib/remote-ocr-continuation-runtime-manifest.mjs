import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from './remote-ocr-local-snapshot.mjs';

const moduleRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const defaultManifestPath = path.join(
  moduleRoot,
  'data',
  'remote-ocr-a2-continuation-runtime-manifest.json',
);
const entrypoint = 'scripts/continue-remote-ocr-operator-interruption.mjs';
const sha256Pattern = /^[a-f0-9]{64}$/u;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function requireExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(`${label} contains missing or unexpected keys`);
  }
  return value;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..'
    && !path.isAbsolute(relative));
}

function relativeImports(source) {
  const specifiers = new Set();
  for (const pattern of [
    /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+)['"]/gsu,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/gsu,
  ]) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers];
}

async function resolveModule(root, importer, specifier) {
  const unresolved = path.resolve(path.dirname(path.join(root, importer)), specifier);
  if (!inside(root, unresolved)) throw new Error(`runtime import escapes repository root: ${specifier}`);
  for (const candidate of [unresolved, `${unresolved}.mjs`, `${unresolved}.js`]) {
    const present = await lstat(candidate).then(() => true, (error) => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    });
    if (!present) continue;
    const resolved = await realpath(candidate);
    const info = await lstat(candidate);
    if (resolved !== candidate || !info.isFile() || info.isSymbolicLink()) {
      throw new Error(`runtime module must be a real regular file: ${candidate}`);
    }
    return path.relative(root, candidate).split(path.sep).join('/');
  }
  throw new Error(`runtime relative import is missing: ${importer} -> ${specifier}`);
}

export async function buildA2ContinuationRuntimeManifest(root = moduleRoot) {
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== path.resolve(root)) throw new Error('runtime source root traverses a symbolic link');
  const pending = [entrypoint];
  const sources = new Map();
  while (pending.length > 0) {
    const relative = pending.pop();
    if (sources.has(relative)) continue;
    const pathname = path.join(canonicalRoot, relative);
    const resolved = await realpath(pathname);
    const info = await lstat(pathname);
    if (resolved !== pathname || !info.isFile() || info.isSymbolicLink()) {
      throw new Error(`runtime source must be a real regular file: ${relative}`);
    }
    const raw = await readFile(pathname);
    sources.set(relative, raw);
    for (const specifier of relativeImports(raw.toString('utf8'))) {
      pending.push(await resolveModule(canonicalRoot, relative, specifier));
    }
  }
  const files = [...sources]
    .map(([relative, raw]) => ({ path: relative, sha256: sha256(raw), bytes: raw.byteLength }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const treeBasis = { schema_version: 1, entrypoint, files };
  return {
    schema_version: 1,
    manifest_type: 'curriculum_remote_ocr_a2_continuation_runtime_manifest',
    entrypoint,
    files,
    runtime_tree_sha256: sha256(canonicalJson(treeBasis)),
  };
}

function parseManifest(raw, label) {
  let manifest;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  requireExactKeys(
    manifest,
    ['schema_version', 'manifest_type', 'entrypoint', 'files', 'runtime_tree_sha256'],
    label,
  );
  if (manifest.schema_version !== 1
    || manifest.manifest_type !== 'curriculum_remote_ocr_a2_continuation_runtime_manifest'
    || manifest.entrypoint !== entrypoint
    || !Array.isArray(manifest.files)
    || !sha256Pattern.test(String(manifest.runtime_tree_sha256 || ''))) {
    throw new Error(`${label} identity is invalid`);
  }
  let previous = null;
  for (const descriptor of manifest.files) {
    requireExactKeys(descriptor, ['path', 'sha256', 'bytes'], `${label} file descriptor`);
    if (typeof descriptor.path !== 'string'
      || !descriptor.path
      || path.isAbsolute(descriptor.path)
      || descriptor.path.split('/').some((part) => !part || part === '.' || part === '..')
      || !sha256Pattern.test(String(descriptor.sha256 || ''))
      || !Number.isSafeInteger(descriptor.bytes)
      || descriptor.bytes < 1
      || (previous !== null && previous.localeCompare(descriptor.path) >= 0)) {
      throw new Error(`${label} file descriptor is invalid or not strictly sorted`);
    }
    previous = descriptor.path;
  }
  const expectedRaw = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (!raw.equals(expectedRaw)) throw new Error(`${label} bytes are not canonical pretty JSON`);
  return manifest;
}

export async function validateA2ContinuationRuntimeManifest({
  root = moduleRoot,
  manifestPath = defaultManifestPath,
} = {}) {
  const raw = await readFile(manifestPath);
  const manifest = parseManifest(raw, 'A2 continuation runtime manifest');
  const actual = await buildA2ContinuationRuntimeManifest(root);
  if (canonicalJson(manifest) !== canonicalJson(actual)) {
    throw new Error('A2 continuation runtime manifest differs from the actual execution closure');
  }
  return {
    manifest,
    raw,
    sha256: sha256(raw),
    bytes: raw.byteLength,
    runtime_tree_sha256: manifest.runtime_tree_sha256,
    files: manifest.files.length,
    path: manifestPath,
  };
}

export function validateArchivedA2ContinuationRuntimeManifest(raw, trusted) {
  const manifest = parseManifest(raw, 'archived A2 continuation runtime manifest');
  if (!trusted?.raw?.equals(raw)
    || trusted.sha256 !== sha256(raw)
    || trusted.runtime_tree_sha256 !== manifest.runtime_tree_sha256
    || trusted.files !== manifest.files.length) {
    throw new Error('archived A2 continuation runtime manifest differs from the trusted receiver runtime');
  }
  return manifest;
}

export const A2_CONTINUATION_RUNTIME_MANIFEST_PATH = defaultManifestPath;
