import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

import { validateCorpusManifest } from '../import-corpus.mjs';

export const BUNDLE_CONTRACT = 'curriculum_private_corpus_bundle_v1';
export const DESCRIPTOR_CONTRACT = 'curriculum_private_corpus_artifact_v1';
export const BUILD_RECEIPT_CONTRACT = 'curriculum_private_corpus_build_receipt_v1';
export const PUBLISH_RECEIPT_CONTRACT = 'curriculum_private_corpus_publish_receipt_v1';
export const HYDRATION_RECEIPT_CONTRACT = 'curriculum_private_corpus_hydration_receipt_v1';
export const CLASSIFICATION = 'copyright_restricted_derived_release_input_private';
export const PRIVATE_BUCKET = 'bdfz-ops-backups';
export const PRIVATE_PREFIX = 'curriculum-atlas/corpus-bundles/v1';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CORPUS_RELEASE_PATTERN = /^corpus-[a-f0-9]{24}$/;
const BUNDLE_ID_PATTERN = /^corpus-bundle-[a-f0-9]{24}$/;
const AGE_RECIPIENT_PATTERN = /^age1[0-9a-z]{58}$/;
const USTAR_BLOCK = 512;
const USTAR_END_BYTES = 1024;
const MAX_PRIVATE_JSON_BYTES = 1024 * 1024;
export const MAX_PRIVATE_ARTIFACT_BYTES = 1024 * 1024 * 1024;

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('canonical JSON does not permit non-finite numbers');
  }
  if (value === undefined) throw new Error('canonical JSON does not permit undefined');
  return value;
}

export function canonicalJsonBuffer(value) {
  return Buffer.from(`${JSON.stringify(canonicalize(value), null, 2)}\n`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} must contain exactly the supported fields`);
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function exactSha256(value, label) {
  if (!SHA256_PATTERN.test(String(value || ''))) throw new Error(`${label} must be a lowercase SHA-256`);
  return value;
}

function exactCorpusRelease(value, label = 'corpus release id') {
  if (!CORPUS_RELEASE_PATTERN.test(String(value || ''))) throw new Error(`${label} is invalid`);
  return value;
}

function exactBundleId(value) {
  if (!BUNDLE_ID_PATTERN.test(String(value || ''))) throw new Error('bundle_id is invalid');
  return value;
}

export function validateAgeRecipient(value, label = 'age recipient') {
  if (!AGE_RECIPIENT_PATTERN.test(String(value || ''))) {
    throw new Error(`${label} must be one canonical native age X25519 recipient`);
  }
  return value;
}

export function validateSingleRecipientAgeEnvelope(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_PRIVATE_ARTIFACT_BYTES) {
    throw new Error('age envelope byte length is invalid');
  }
  const maximumHeaderBytes = Math.min(buffer.length, 64 * 1024);
  let offset = 0;
  let lineNumber = 0;
  let recipientStanzas = 0;
  let terminated = false;
  while (offset < maximumHeaderBytes) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline === -1 || newline >= maximumHeaderBytes || newline - offset > 4096) {
      throw new Error('age envelope header is missing or exceeds its safety limit');
    }
    const lineBytes = buffer.subarray(offset, newline);
    if ([...lineBytes].some((byte) => byte < 0x20 || byte > 0x7e)) {
      throw new Error('age envelope header is not canonical ASCII');
    }
    const line = lineBytes.toString('ascii');
    lineNumber += 1;
    if (lineNumber === 1) {
      if (line !== 'age-encryption.org/v1') throw new Error('age envelope version header is invalid');
    } else if (line.startsWith('-> ')) {
      recipientStanzas += 1;
      if (!line.startsWith('-> X25519 ') || recipientStanzas > 1) {
        throw new Error('age envelope must authorize exactly one native X25519 recipient stanza');
      }
    } else if (line.startsWith('--- ')) {
      terminated = true;
      offset = newline + 1;
      break;
    }
    offset = newline + 1;
  }
  if (!terminated || recipientStanzas !== 1 || offset >= buffer.length) {
    throw new Error('age envelope must authorize exactly one native X25519 recipient stanza');
  }
  return buffer;
}

function safeArchivePath(value) {
  const path = String(value || '');
  if (!path || path.startsWith('/') || path.endsWith('/') || path.includes('\\')
      || /[\u0000-\u001f\u007f]/.test(path)
      || Buffer.from(path, 'utf8').toString('utf8') !== path
      || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`archive path is unsafe: ${JSON.stringify(path)}`);
  }
  return path;
}

function compareArchivePaths(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function splitUstarPath(path) {
  const normalized = safeArchivePath(path);
  if (Buffer.byteLength(normalized) <= 100) return { name: normalized, prefix: '' };
  const slashIndexes = [];
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index] === '/') slashIndexes.push(index);
  }
  for (const index of slashIndexes.reverse()) {
    const prefix = normalized.slice(0, index);
    const name = normalized.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`USTAR path cannot be represented canonically: ${normalized}`);
}

function writeAscii(target, offset, length, value, label) {
  const encoded = Buffer.from(value, 'ascii');
  if (encoded.length > length) throw new Error(`${label} does not fit in USTAR field`);
  encoded.copy(target, offset);
}

function writeUtf8(target, offset, length, value, label) {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length > length) throw new Error(`${label} does not fit in USTAR field`);
  encoded.copy(target, offset);
}

function octalField(value, width, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  const octal = value.toString(8);
  if (octal.length > width - 1) throw new Error(`${label} exceeds canonical USTAR range`);
  return `${octal.padStart(width - 1, '0')}\0`;
}

function createUstarHeader(path, size) {
  const { name, prefix } = splitUstarPath(path);
  const header = Buffer.alloc(USTAR_BLOCK);
  writeUtf8(header, 0, 100, name, 'name');
  writeAscii(header, 100, 8, octalField(0o600, 8, 'mode'), 'mode');
  writeAscii(header, 108, 8, octalField(0, 8, 'uid'), 'uid');
  writeAscii(header, 116, 8, octalField(0, 8, 'gid'), 'gid');
  writeAscii(header, 124, 12, octalField(size, 12, 'size'), 'size');
  writeAscii(header, 136, 12, octalField(0, 12, 'mtime'), 'mtime');
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  writeAscii(header, 257, 6, 'ustar\0', 'magic');
  writeAscii(header, 263, 2, '00', 'version');
  writeUtf8(header, 345, 155, prefix, 'prefix');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  if (checksum.toString(8).length > 6) throw new Error('USTAR checksum exceeds canonical field');
  writeAscii(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `, 'checksum');
  return header;
}

function entryBuffer(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('archive entry must be an object');
  if (!Buffer.isBuffer(entry.buffer)) throw new Error(`archive entry ${entry.path || '<unknown>'} must use a Buffer`);
  return { path: safeArchivePath(entry.path), buffer: entry.buffer };
}

export function createDeterministicUstar(entries) {
  if (!Array.isArray(entries)) throw new Error('archive entries must be an array');
  const normalized = entries.map(entryBuffer).sort((left, right) => compareArchivePaths(left.path, right.path));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].path === normalized[index].path) {
      throw new Error(`duplicate archive path: ${normalized[index].path}`);
    }
  }
  const blocks = [];
  let total = USTAR_END_BYTES;
  for (const entry of normalized) {
    total += USTAR_BLOCK + Math.ceil(entry.buffer.length / USTAR_BLOCK) * USTAR_BLOCK;
    if (total > MAX_PRIVATE_ARTIFACT_BYTES) throw new Error('private corpus archive exceeds safety limit');
    blocks.push(createUstarHeader(entry.path, entry.buffer.length), entry.buffer);
    const padding = (USTAR_BLOCK - (entry.buffer.length % USTAR_BLOCK)) % USTAR_BLOCK;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(USTAR_END_BYTES));
  return Buffer.concat(blocks, total);
}

function zeroBlock(buffer) {
  for (const byte of buffer) if (byte !== 0) return false;
  return true;
}

function parseCanonicalOctal(buffer, width, label) {
  const value = buffer.toString('ascii');
  const pattern = new RegExp(`^[0-7]{${width - 1}}\\0$`);
  if (!pattern.test(value)) throw new Error(`${label} is not canonical USTAR octal`);
  const parsed = Number.parseInt(value.slice(0, -1), 8);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} exceeds safe integer range`);
  return parsed;
}

function parseNullTerminatedUtf8(buffer, label) {
  const nul = buffer.indexOf(0);
  const end = nul === -1 ? buffer.length : nul;
  if (nul !== -1 && !zeroBlock(buffer.subarray(nul))) throw new Error(`${label} has non-zero bytes after NUL`);
  const bytes = buffer.subarray(0, end);
  const value = bytes.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(bytes)) throw new Error(`${label} is not valid canonical UTF-8`);
  return value;
}

export function parseUstar(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('USTAR input must be a Buffer');
  if (buffer.length < USTAR_END_BYTES || buffer.length % USTAR_BLOCK !== 0
      || buffer.length > MAX_PRIVATE_ARTIFACT_BYTES) {
    throw new Error('USTAR byte length is invalid');
  }
  const entries = [];
  let offset = 0;
  while (offset < buffer.length) {
    const header = buffer.subarray(offset, offset + USTAR_BLOCK);
    if (zeroBlock(header)) {
      if (offset + USTAR_END_BYTES !== buffer.length
          || !zeroBlock(buffer.subarray(offset + USTAR_BLOCK, offset + USTAR_END_BYTES))) {
        throw new Error('USTAR terminator or trailing bytes are invalid');
      }
      return entries;
    }
    const checksumField = header.subarray(148, 156).toString('ascii');
    if (!/^[0-7]{6}\0 $/.test(checksumField)) throw new Error('USTAR checksum field is not canonical');
    const expectedChecksum = Number.parseInt(checksumField.slice(0, 6), 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (actualChecksum !== expectedChecksum) throw new Error('USTAR checksum mismatch');
    if (header[156] !== 0x30) throw new Error('USTAR permits regular files only');
    const name = parseNullTerminatedUtf8(header.subarray(0, 100), 'USTAR name');
    const prefix = parseNullTerminatedUtf8(header.subarray(345, 500), 'USTAR prefix');
    const path = safeArchivePath(prefix ? `${prefix}/${name}` : name);
    const size = parseCanonicalOctal(header.subarray(124, 136), 12, 'USTAR size');
    const canonicalHeader = createUstarHeader(path, size);
    if (!canonicalHeader.equals(header)) throw new Error(`USTAR header is not canonical for ${path}`);
    const payloadStart = offset + USTAR_BLOCK;
    const paddedBytes = Math.ceil(size / USTAR_BLOCK) * USTAR_BLOCK;
    const next = payloadStart + paddedBytes;
    if (next > buffer.length - USTAR_END_BYTES) throw new Error(`USTAR payload overruns archive for ${path}`);
    const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + size));
    if (!zeroBlock(buffer.subarray(payloadStart + size, next))) {
      throw new Error(`USTAR payload padding is non-zero for ${path}`);
    }
    if (entries.length && compareArchivePaths(entries.at(-1).path, path) >= 0) {
      throw new Error('USTAR paths must be strictly ordered without duplicates');
    }
    entries.push({ path, buffer: payload });
    offset = next;
  }
  throw new Error('USTAR archive is missing its terminator');
}

function payloadIdentity(files) {
  return sha256(canonicalJsonBuffer(files));
}

function bundleIdentity(value) {
  return sha256(canonicalJsonBuffer({
    age_recipient: value.age_recipient,
    contract: BUNDLE_CONTRACT,
    corpus_manifest_sha256: value.corpus_manifest_sha256,
    corpus_release_fingerprint_sha256: value.corpus_release_fingerprint_sha256,
    corpus_release_id: value.corpus_release_id,
    files: value.files,
    payload_sha256: value.payload_sha256,
  }));
}

export function validateBundleManifest(value) {
  const keys = [
    'archive_file_count',
    'archive_format',
    'age_recipient',
    'bundle_id',
    'classification',
    'compression',
    'contract',
    'corpus_manifest_bytes',
    'corpus_manifest_sha256',
    'corpus_release_fingerprint_sha256',
    'corpus_release_id',
    'encryption',
    'files',
    'payload_bytes',
    'payload_file_count',
    'payload_sha256',
    'public_runtime',
    'schema_version',
  ];
  exactKeys(value, keys, 'bundle manifest');
  if (value.schema_version !== 1 || value.contract !== BUNDLE_CONTRACT) throw new Error('bundle manifest contract is invalid');
  if (value.classification !== CLASSIFICATION) throw new Error('bundle manifest classification is invalid');
  if (value.public_runtime !== false) throw new Error('bundle manifest public_runtime must remain false');
  if (value.archive_format !== 'ustar' || value.compression !== 'zstd' || value.encryption !== 'age') {
    throw new Error('bundle manifest transport formats are invalid');
  }
  validateAgeRecipient(value.age_recipient, 'bundle manifest age_recipient');
  exactCorpusRelease(value.corpus_release_id);
  exactSha256(value.corpus_release_fingerprint_sha256, 'corpus_release_fingerprint_sha256');
  exactSha256(value.corpus_manifest_sha256, 'corpus_manifest_sha256');
  positiveInteger(value.corpus_manifest_bytes, 'corpus_manifest_bytes');
  exactSha256(value.payload_sha256, 'payload_sha256');
  positiveInteger(value.payload_file_count, 'payload_file_count');
  positiveInteger(value.archive_file_count, 'archive_file_count');
  positiveInteger(value.payload_bytes, 'payload_bytes');
  exactBundleId(value.bundle_id);
  if (!Array.isArray(value.files) || value.files.length !== value.payload_file_count) {
    throw new Error('bundle manifest files do not match payload_file_count');
  }
  const paths = [];
  for (const [index, entry] of value.files.entries()) {
    exactKeys(entry, ['bytes', 'path', 'sha256'], `bundle manifest files[${index}]`);
    const path = safeArchivePath(entry.path);
    if (path === 'bundle-manifest.json') throw new Error('bundle manifest must not list itself as payload');
    exactSha256(entry.sha256, `bundle manifest files[${index}].sha256`);
    positiveInteger(entry.bytes, `bundle manifest files[${index}].bytes`);
    paths.push(path);
  }
  const sortedPaths = [...paths].sort(compareArchivePaths);
  if (JSON.stringify(paths) !== JSON.stringify(sortedPaths) || new Set(paths).size !== paths.length) {
    throw new Error('bundle manifest file paths must be unique and sorted');
  }
  if (value.archive_file_count !== value.payload_file_count + 1) {
    throw new Error('bundle manifest archive_file_count must include exactly one manifest');
  }
  if (value.payload_bytes !== value.files.reduce((sum, entry) => sum + entry.bytes, 0)) {
    throw new Error('bundle manifest payload bytes do not match files');
  }
  if (value.payload_sha256 !== payloadIdentity(value.files)) {
    throw new Error('bundle manifest payload identity is invalid');
  }
  const expectedBundleId = `corpus-bundle-${bundleIdentity(value).slice(0, 24)}`;
  if (value.bundle_id !== expectedBundleId) throw new Error('bundle manifest bundle identity is invalid');
  const manifestEntry = value.files.find((entry) => entry.path === 'corpus/manifest.json');
  if (!manifestEntry || manifestEntry.sha256 !== value.corpus_manifest_sha256
      || manifestEntry.bytes !== value.corpus_manifest_bytes) {
    throw new Error('bundle manifest corpus manifest identity is inconsistent');
  }
  const sql = value.files.filter((entry) => /^corpus\/sql\/\d{3}-(?:core|paragraphs)\.sql$/.test(entry.path));
  const text = value.files.filter((entry) => /^corpus\/text\/[^/]+\.txt$/.test(entry.path));
  if (sql.length + text.length + 1 !== value.files.length) {
    throw new Error('bundle manifest contains unsupported payload paths');
  }
  return value;
}

function projectPath(root, value, label) {
  const base = resolve(String(root));
  const target = resolve(base, String(value || ''));
  const relation = relative(base, target);
  if (!value || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${label} must remain inside project root`);
  }
  return target;
}

function validateReadBounds({ expectedBytes = null, maxBytes = MAX_PRIVATE_ARTIFACT_BYTES } = {}, label) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_PRIVATE_ARTIFACT_BYTES) {
    throw new Error(`${label} safety limit is invalid`);
  }
  if (expectedBytes !== null
      && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maxBytes)) {
    throw new Error(`${label} expected byte count exceeds its safety limit`);
  }
  return { expectedBytes, maxBytes };
}

export async function readPrivateFile(path, {
  expectedBytes = null,
  maxBytes = MAX_PRIVATE_ARTIFACT_BYTES,
  ownerOnly = false,
  label = 'private file',
} = {}) {
  const bounds = validateReadBounds({ expectedBytes, maxBytes }, label);
  const target = resolve(String(path));
  const info = await lstat(target, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} is not a regular file: ${target}`);
  if (info.size > BigInt(bounds.maxBytes)
      || (bounds.expectedBytes !== null && info.size !== BigInt(bounds.expectedBytes))) {
    throw new Error(`${label} byte count differs from its safety limit or exact receipt`);
  }
  const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size) {
      throw new Error(`${label} changed before its verified file descriptor was opened: ${target}`);
    }
    if (before.size > BigInt(bounds.maxBytes)
        || (bounds.expectedBytes !== null && before.size !== BigInt(bounds.expectedBytes))) {
      throw new Error(`${label} byte count differs from its safety limit or exact receipt`);
    }
    const buffer = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
        || BigInt(buffer.length) !== after.size) {
      throw new Error(`${label} changed while it was being read: ${target}`);
    }
    if (ownerOnly) await handle.chmod(0o600);
    return buffer;
  } finally {
    await handle.close();
  }
}

async function readStableRegularFile(root, path, expected = null) {
  const target = projectPath(root, path, path);
  const info = await lstat(target, { bigint: true });
  if (info.isSymbolicLink()) throw new Error(`${path} is a symbolic link`);
  if (!info.isFile()) throw new Error(`${path} is not a regular file`);
  const realRoot = await realpath(resolve(root));
  const realTarget = await realpath(target);
  const relation = relative(realRoot, realTarget);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${path} resolves outside project root`);
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  const handle = await open(target, flags);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`${path} is not a regular file`);
    if (info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size) {
      throw new Error(`${path} changed before its verified file descriptor was opened`);
    }
    if (expected && (before.size !== BigInt(expected.bytes)
        || expected.bytes > MAX_PRIVATE_ARTIFACT_BYTES)) {
      throw new Error(`${path} hash or byte mismatch`);
    }
    if (!expected && before.size > BigInt(MAX_PRIVATE_JSON_BYTES)) {
      throw new Error(`${path} exceeds private manifest safety limit`);
    }
    const buffer = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
        || BigInt(buffer.length) !== after.size) {
      throw new Error(`${path} changed while it was being read`);
    }
    if (expected && (buffer.length !== expected.bytes || sha256(buffer) !== expected.sha256)) {
      throw new Error(`${path} hash or byte mismatch`);
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

async function exactNamedInventory(directory, suffix) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.name.endsWith(suffix)).map((entry) => entry.name).sort();
}

async function ensureDirectoryTree(root, relativeDirectory) {
  const base = resolve(String(root));
  let current = base;
  const seals = [];
  for (const part of String(relativeDirectory).split('/')) {
    if (!part || part === '.' || part === '..') throw new Error('private directory path is invalid');
    current = resolve(current, part);
    try {
      const info = await lstat(current, { bigint: true });
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`private directory component is not a real directory: ${current}`);
      }
      seals.push({ path: current, dev: info.dev, ino: info.ino });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await mkdir(current, { mode: 0o700 });
      const created = await lstat(current, { bigint: true });
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error(`private directory component is not a real directory: ${current}`);
      }
      seals.push({ path: current, dev: created.dev, ino: created.ino });
    }
  }
  return { path: current, seals };
}

async function verifyDirectoryTree(seals) {
  for (const seal of seals || []) {
    const info = await lstat(seal.path, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== seal.dev || info.ino !== seal.ino) {
      throw new Error(`private directory identity changed: ${seal.path}`);
    }
  }
}

export async function buildPrivateCorpusTar({ root = process.cwd(), ageRecipient } = {}) {
  validateAgeRecipient(ageRecipient, 'private corpus age recipient');
  const manifestPath = 'data/corpus-chunks/manifest.json';
  const manifestBuffer = await readStableRegularFile(root, manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBuffer.toString('utf8'));
  } catch (error) {
    throw new Error(`corpus manifest is not JSON: ${error.message}`);
  }
  const validated = validateCorpusManifest(manifest, manifest?.sql_files?.length);
  const expectedSqlNames = validated.sql_files.map((entry) => entry.name).sort();
  const actualSqlNames = await exactNamedInventory(projectPath(root, 'data/corpus-chunks', 'SQL directory'), '.sql');
  const undeclaredSql = actualSqlNames.filter((name) => !expectedSqlNames.includes(name));
  const missingSql = expectedSqlNames.filter((name) => !actualSqlNames.includes(name));
  if (undeclaredSql.length) throw new Error(`SQL inventory contains undeclared files: ${undeclaredSql.join(', ')}`);
  if (missingSql.length) throw new Error(`SQL inventory is missing files: ${missingSql.join(', ')}`);

  const textDirectory = projectPath(root, '.cache/text', 'text directory');
  const expectedTextNames = validated.text_assets.map((entry) => `${entry.document_id}.txt`).sort();
  const actualTextNames = await exactNamedInventory(textDirectory, '.txt');
  const missingText = expectedTextNames.filter((name) => !actualTextNames.includes(name));
  if (missingText.length) throw new Error(`text inventory is missing files: ${missingText.join(', ')}`);

  const payload = [{ path: 'corpus/manifest.json', buffer: manifestBuffer }];
  for (const entry of validated.sql_files) {
    payload.push({
      path: `corpus/sql/${entry.name}`,
      buffer: await readStableRegularFile(root, `data/corpus-chunks/${entry.name}`, entry),
    });
  }
  for (const entry of validated.text_assets) {
    safeArchivePath(`corpus/text/${entry.document_id}.txt`);
    payload.push({
      path: `corpus/text/${entry.document_id}.txt`,
      buffer: await readStableRegularFile(root, `.cache/text/${entry.document_id}.txt`, entry),
    });
  }
  payload.sort((left, right) => compareArchivePaths(left.path, right.path));
  const files = payload.map((entry) => ({ path: entry.path, sha256: sha256(entry.buffer), bytes: entry.buffer.length }));
  const partial = {
    schema_version: 1,
    contract: BUNDLE_CONTRACT,
    classification: CLASSIFICATION,
    public_runtime: false,
    archive_format: 'ustar',
    compression: 'zstd',
    encryption: 'age',
    age_recipient: ageRecipient,
    corpus_release_id: validated.release_id,
    corpus_release_fingerprint_sha256: validated.release_fingerprint_sha256,
    corpus_manifest_sha256: sha256(manifestBuffer),
    corpus_manifest_bytes: manifestBuffer.length,
    payload_file_count: files.length,
    archive_file_count: files.length + 1,
    payload_bytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
    payload_sha256: payloadIdentity(files),
    files,
  };
  const bundleManifest = validateBundleManifest({
    ...partial,
    bundle_id: `corpus-bundle-${bundleIdentity(partial).slice(0, 24)}`,
  });
  const bundleManifestBuffer = canonicalJsonBuffer(bundleManifest);
  const tarBuffer = createDeterministicUstar([
    { path: 'bundle-manifest.json', buffer: bundleManifestBuffer },
    ...payload,
  ]);
  return {
    tar_buffer: tarBuffer,
    plaintext_tar_sha256: sha256(tarBuffer),
    plaintext_tar_bytes: tarBuffer.length,
    bundle_manifest: bundleManifest,
    bundle_manifest_buffer: bundleManifestBuffer,
    bundle_manifest_sha256: sha256(bundleManifestBuffer),
  };
}

export function parsePrivateCorpusTar(tarBuffer) {
  const entries = parseUstar(tarBuffer);
  if (!entries.length || entries[0].path !== 'bundle-manifest.json') {
    throw new Error('private corpus archive must begin with bundle-manifest.json');
  }
  let bundleManifest;
  try {
    bundleManifest = JSON.parse(entries[0].buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`bundle manifest is not JSON: ${error.message}`);
  }
  if (!canonicalJsonBuffer(bundleManifest).equals(entries[0].buffer)) {
    throw new Error('bundle manifest JSON is not canonical');
  }
  validateBundleManifest(bundleManifest);
  const expectedPaths = ['bundle-manifest.json', ...bundleManifest.files.map((entry) => entry.path)];
  const actualPaths = entries.map((entry) => entry.path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error('private corpus archive inventory differs from bundle manifest');
  }
  const files = new Map();
  for (const [index, declared] of bundleManifest.files.entries()) {
    const archiveEntry = entries[index + 1];
    if (archiveEntry.buffer.length !== declared.bytes || sha256(archiveEntry.buffer) !== declared.sha256) {
      throw new Error(`private corpus archive payload identity differs for ${declared.path}`);
    }
    files.set(declared.path, archiveEntry.buffer);
  }
  const manifestBuffer = files.get('corpus/manifest.json');
  let corpusManifest;
  try {
    corpusManifest = JSON.parse(manifestBuffer.toString('utf8'));
  } catch (error) {
    throw new Error(`archived corpus manifest is not JSON: ${error.message}`);
  }
  const validatedCorpus = validateCorpusManifest(corpusManifest, corpusManifest?.sql_files?.length);
  if (validatedCorpus.release_id !== bundleManifest.corpus_release_id
      || validatedCorpus.release_fingerprint_sha256 !== bundleManifest.corpus_release_fingerprint_sha256) {
    throw new Error('archived corpus manifest release differs from bundle manifest');
  }
  const expectedPayloadPaths = [
    'corpus/manifest.json',
    ...validatedCorpus.sql_files.map((entry) => `corpus/sql/${entry.name}`),
    ...validatedCorpus.text_assets.map((entry) => `corpus/text/${entry.document_id}.txt`),
  ].sort(compareArchivePaths);
  if (JSON.stringify(expectedPayloadPaths) !== JSON.stringify(bundleManifest.files.map((entry) => entry.path))) {
    throw new Error('bundle payload does not exactly match the archived corpus manifest');
  }
  return {
    bundle_manifest: bundleManifest,
    bundle_manifest_buffer: entries[0].buffer,
    bundle_manifest_sha256: sha256(entries[0].buffer),
    corpus_manifest: validatedCorpus,
    corpus_manifest_buffer: manifestBuffer,
    files,
    plaintext_tar_sha256: sha256(tarBuffer),
    plaintext_tar_bytes: tarBuffer.length,
  };
}

function descriptorSectionKeys() {
  return {
    root: ['bundle', 'classification', 'contract', 'corpus', 'public_runtime', 'receipt', 'schema_version', 'storage'],
    corpus: ['manifest_bytes', 'manifest_sha256', 'release_fingerprint_sha256', 'release_id'],
    bundle: [
      'age_recipient', 'archive_file_count', 'bundle_id', 'bundle_manifest_sha256', 'ciphertext_bytes',
      'ciphertext_sha256', 'payload_sha256', 'plaintext_tar_bytes', 'plaintext_tar_sha256',
    ],
    storage: ['bucket', 'object_key', 'provider', 'receipt_key'],
    receipt: ['bytes', 'sha256'],
  };
}

export function validateCorpusArtifactDescriptor(value) {
  const keys = descriptorSectionKeys();
  exactKeys(value, keys.root, 'corpus artifact descriptor');
  if (value.schema_version !== 1 || value.contract !== DESCRIPTOR_CONTRACT) throw new Error('corpus artifact descriptor contract is invalid');
  if (value.classification !== CLASSIFICATION) throw new Error('corpus artifact descriptor classification is invalid');
  if (value.public_runtime !== false) throw new Error('corpus artifact descriptor public_runtime must remain false');
  exactKeys(value.corpus, keys.corpus, 'corpus artifact descriptor corpus');
  exactCorpusRelease(value.corpus.release_id);
  exactSha256(value.corpus.release_fingerprint_sha256, 'descriptor corpus release fingerprint');
  exactSha256(value.corpus.manifest_sha256, 'descriptor corpus manifest SHA-256');
  positiveInteger(value.corpus.manifest_bytes, 'descriptor corpus manifest bytes');
  exactKeys(value.bundle, keys.bundle, 'corpus artifact descriptor bundle');
  exactBundleId(value.bundle.bundle_id);
  validateAgeRecipient(value.bundle.age_recipient, 'descriptor bundle age_recipient');
  for (const name of ['bundle_manifest_sha256', 'payload_sha256', 'plaintext_tar_sha256', 'ciphertext_sha256']) {
    exactSha256(value.bundle[name], `descriptor bundle ${name}`);
  }
  positiveInteger(value.bundle.archive_file_count, 'descriptor archive file count');
  positiveInteger(value.bundle.plaintext_tar_bytes, 'descriptor plaintext tar bytes');
  positiveInteger(value.bundle.ciphertext_bytes, 'descriptor ciphertext bytes');
  exactKeys(value.storage, keys.storage, 'corpus artifact descriptor storage');
  if (value.storage.provider !== 'cloudflare_r2_s3' || value.storage.bucket !== PRIVATE_BUCKET) {
    throw new Error('corpus artifact descriptor storage boundary is invalid');
  }
  const expectedObject = `${PRIVATE_PREFIX}/objects/sha256/${value.bundle.ciphertext_sha256}.tar.zst.age`;
  if (value.storage.object_key !== expectedObject) throw new Error('descriptor content-addressed object key is invalid');
  exactKeys(value.receipt, keys.receipt, 'corpus artifact descriptor receipt');
  exactSha256(value.receipt.sha256, 'descriptor receipt SHA-256');
  positiveInteger(value.receipt.bytes, 'descriptor receipt bytes');
  const expectedReceipt = `${PRIVATE_PREFIX}/receipts/sha256/${value.receipt.sha256}.json`;
  if (value.storage.receipt_key !== expectedReceipt) throw new Error('descriptor content-addressed receipt key is invalid');
  return value;
}

export function createBuildReceipt({ built, ciphertextBuffer, bucket = PRIVATE_BUCKET } = {}) {
  if (!built?.bundle_manifest || !Buffer.isBuffer(ciphertextBuffer)) throw new Error('build receipt requires built tar and ciphertext bytes');
  validateBundleManifest(built.bundle_manifest);
  if (built.plaintext_tar_sha256 !== sha256(built.tar_buffer)
      || built.plaintext_tar_bytes !== built.tar_buffer.length
      || built.bundle_manifest_sha256 !== sha256(built.bundle_manifest_buffer)) {
    throw new Error('build receipt input identity is unstable');
  }
  const ciphertextSha256 = sha256(ciphertextBuffer);
  return {
    schema_version: 1,
    contract: BUILD_RECEIPT_CONTRACT,
    classification: CLASSIFICATION,
    public_runtime: false,
    corpus: {
      release_id: built.bundle_manifest.corpus_release_id,
      release_fingerprint_sha256: built.bundle_manifest.corpus_release_fingerprint_sha256,
      manifest_sha256: built.bundle_manifest.corpus_manifest_sha256,
      manifest_bytes: built.bundle_manifest.corpus_manifest_bytes,
    },
    bundle: {
      bundle_id: built.bundle_manifest.bundle_id,
      age_recipient: built.bundle_manifest.age_recipient,
      bundle_manifest_sha256: built.bundle_manifest_sha256,
      payload_sha256: built.bundle_manifest.payload_sha256,
      archive_file_count: built.bundle_manifest.archive_file_count,
      plaintext_tar_sha256: built.plaintext_tar_sha256,
      plaintext_tar_bytes: built.plaintext_tar_bytes,
      ciphertext_sha256: ciphertextSha256,
      ciphertext_bytes: ciphertextBuffer.length,
    },
    storage: {
      provider: 'cloudflare_r2_s3',
      bucket,
      object_key: `${PRIVATE_PREFIX}/objects/sha256/${ciphertextSha256}.tar.zst.age`,
    },
  };
}

export function validateBuildReceipt(value) {
  exactKeys(value, ['bundle', 'classification', 'contract', 'corpus', 'public_runtime', 'schema_version', 'storage'], 'build receipt');
  if (value.schema_version !== 1 || value.contract !== BUILD_RECEIPT_CONTRACT
      || value.classification !== CLASSIFICATION || value.public_runtime !== false) {
    throw new Error('build receipt contract is invalid');
  }
  exactKeys(value.corpus, ['manifest_bytes', 'manifest_sha256', 'release_fingerprint_sha256', 'release_id'], 'build receipt corpus');
  exactCorpusRelease(value.corpus.release_id);
  exactSha256(value.corpus.release_fingerprint_sha256, 'build receipt release fingerprint');
  exactSha256(value.corpus.manifest_sha256, 'build receipt manifest SHA-256');
  positiveInteger(value.corpus.manifest_bytes, 'build receipt manifest bytes');
  exactKeys(value.bundle, descriptorSectionKeys().bundle, 'build receipt bundle');
  exactBundleId(value.bundle.bundle_id);
  validateAgeRecipient(value.bundle.age_recipient, 'build receipt bundle age_recipient');
  for (const name of ['bundle_manifest_sha256', 'payload_sha256', 'plaintext_tar_sha256', 'ciphertext_sha256']) {
    exactSha256(value.bundle[name], `build receipt bundle ${name}`);
  }
  positiveInteger(value.bundle.archive_file_count, 'build receipt archive file count');
  positiveInteger(value.bundle.plaintext_tar_bytes, 'build receipt plaintext bytes');
  positiveInteger(value.bundle.ciphertext_bytes, 'build receipt ciphertext bytes');
  exactKeys(value.storage, ['bucket', 'object_key', 'provider'], 'build receipt storage');
  if (value.storage.provider !== 'cloudflare_r2_s3' || value.storage.bucket !== PRIVATE_BUCKET
      || value.storage.object_key !== `${PRIVATE_PREFIX}/objects/sha256/${value.bundle.ciphertext_sha256}.tar.zst.age`) {
    throw new Error('build receipt storage identity is invalid');
  }
  return value;
}

export function validatePublishReceipt(value) {
  exactKeys(
    value,
    ['bundle', 'classification', 'contract', 'corpus', 'public_runtime', 'schema_version', 'storage', 'verification'],
    'publish receipt',
  );
  if (value.schema_version !== 1 || value.contract !== PUBLISH_RECEIPT_CONTRACT
      || value.classification !== CLASSIFICATION || value.public_runtime !== false) {
    throw new Error('publish receipt contract is invalid');
  }
  exactKeys(value.storage, ['bucket', 'etag', 'object_key', 'provider'], 'publish receipt storage');
  if (typeof value.storage.etag !== 'string' || !value.storage.etag || value.storage.etag.length > 512
      || /[\u0000-\u001f\u007f]/.test(value.storage.etag)) {
    throw new Error('publish receipt storage ETag is invalid');
  }
  validateBuildReceipt({
    schema_version: 1,
    contract: BUILD_RECEIPT_CONTRACT,
    classification: CLASSIFICATION,
    public_runtime: false,
    corpus: value.corpus,
    bundle: value.bundle,
    storage: {
      provider: value.storage.provider,
      bucket: value.storage.bucket,
      object_key: value.storage.object_key,
    },
  });
  exactKeys(
    value.verification,
    ['bundle_manifest_replay', 'ciphertext_readback', 'conditional_create', 'decrypt_replay'],
    'publish receipt verification',
  );
  if (value.verification.conditional_create !== true
      || value.verification.ciphertext_readback !== true
      || value.verification.decrypt_replay !== true
      || value.verification.bundle_manifest_replay !== true) {
    throw new Error('publish receipt verification is incomplete');
  }
  return value;
}

export function assertParsedBundleMatchesBuildReceipt(parsed, receiptInput) {
  const receipt = validateBuildReceipt(receiptInput);
  if (!parsed?.bundle_manifest || !Buffer.isBuffer(parsed.corpus_manifest_buffer)) {
    throw new Error('parsed private corpus bundle is required');
  }
  const expectedCorpus = {
    release_id: parsed.bundle_manifest.corpus_release_id,
    release_fingerprint_sha256: parsed.bundle_manifest.corpus_release_fingerprint_sha256,
    manifest_sha256: parsed.bundle_manifest.corpus_manifest_sha256,
    manifest_bytes: parsed.bundle_manifest.corpus_manifest_bytes,
  };
  const expectedBundle = {
    bundle_id: parsed.bundle_manifest.bundle_id,
    age_recipient: parsed.bundle_manifest.age_recipient,
    bundle_manifest_sha256: parsed.bundle_manifest_sha256,
    payload_sha256: parsed.bundle_manifest.payload_sha256,
    archive_file_count: parsed.bundle_manifest.archive_file_count,
    plaintext_tar_sha256: parsed.plaintext_tar_sha256,
    plaintext_tar_bytes: parsed.plaintext_tar_bytes,
  };
  for (const [name, expected] of Object.entries(expectedCorpus)) {
    if (receipt.corpus[name] !== expected) throw new Error(`build receipt corpus ${name} differs from parsed bundle`);
  }
  for (const [name, expected] of Object.entries(expectedBundle)) {
    if (receipt.bundle[name] !== expected) throw new Error(`build receipt bundle ${name} differs from parsed bundle`);
  }
  return receipt;
}

export function assertParsedBundleMatchesDescriptor(parsed, descriptorInput) {
  const descriptor = validateCorpusArtifactDescriptor(descriptorInput);
  const syntheticBuildReceipt = {
    schema_version: 1,
    contract: BUILD_RECEIPT_CONTRACT,
    classification: CLASSIFICATION,
    public_runtime: false,
    corpus: descriptor.corpus,
    bundle: descriptor.bundle,
    storage: {
      provider: descriptor.storage.provider,
      bucket: descriptor.storage.bucket,
      object_key: descriptor.storage.object_key,
    },
  };
  assertParsedBundleMatchesBuildReceipt(parsed, syntheticBuildReceipt);
  return descriptor;
}

async function assertDestinationInventory(root, parsed) {
  const expectedSql = parsed.corpus_manifest.sql_files.map((entry) => entry.name).sort();
  const sqlDirectory = await ensureDirectoryTree(root, 'data/corpus-chunks');
  const actualSql = await exactNamedInventory(sqlDirectory.path, '.sql');
  const extrasSql = actualSql.filter((name) => !expectedSql.includes(name));
  if (extrasSql.length) throw new Error(`hydrated SQL inventory contains undeclared files: ${extrasSql.join(', ')}`);

  const expectedText = parsed.corpus_manifest.text_assets.map((entry) => `${entry.document_id}.txt`).sort();
  const textDirectory = await ensureDirectoryTree(root, '.cache/text');
  const actualText = await exactNamedInventory(textDirectory.path, '.txt');
  const extrasText = actualText.filter((name) => !expectedText.includes(name));
  if (extrasText.length) throw new Error(`hydrated text inventory contains undeclared files: ${extrasText.join(', ')}`);
  return { sql: sqlDirectory, text: textDirectory };
}

async function destinationState(path, expectedBuffer) {
  try {
    const buffer = await readExistingRegularNoFollow(path, 'existing hydrated path');
    if (!buffer.equals(expectedBuffer)) throw new Error(`existing hydrated file differs: ${path}`);
    return 'exact';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function readExistingRegularNoFollow(path, label, { ownerOnly = false } = {}) {
  return readPrivateFile(path, { ownerOnly, label });
}

async function installNoClobber(path, buffer, directorySeals) {
  await verifyDirectoryTree(directorySeals);
  const temporary = `${path}.hydrate-${process.pid}-${randomUUID()}.tmp`;
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(buffer);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await verifyDirectoryTree(directorySeals);
    await link(temporary, path);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readExistingRegularNoFollow(path, 'existing hydrated path', { ownerOnly: true });
    if (!existing.equals(buffer)) throw new Error(`existing hydrated file differs: ${path}`);
  } finally {
    await rm(temporary, { force: true });
  }
  await verifyDirectoryTree(directorySeals);
}

async function writeAtomicOwnerOnly(path, buffer, { directorySeals = null } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (directorySeals) await verifyDirectoryTree(directorySeals);
  try {
    const existing = await readExistingRegularNoFollow(path, 'existing immutable receipt', { ownerOnly: true });
    if (!existing.equals(buffer)) throw new Error(`existing immutable receipt differs: ${path}`);
    return false;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(buffer);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (directorySeals) await verifyDirectoryTree(directorySeals);
    await link(temporary, path);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readExistingRegularNoFollow(path, 'existing immutable receipt', { ownerOnly: true });
    if (!existing.equals(buffer)) throw new Error(`existing immutable receipt differs: ${path}`);
  } finally {
    await rm(temporary, { force: true });
  }
  if (directorySeals) await verifyDirectoryTree(directorySeals);
  return true;
}

function hydrationTargets(root, parsed, directories) {
  return parsed.bundle_manifest.files.filter((entry) => entry.path !== 'corpus/manifest.json').map((entry) => {
    const sql = entry.path.match(/^corpus\/sql\/(.+)$/);
    const text = entry.path.match(/^corpus\/text\/(.+)$/);
    const destination = sql
      ? `data/corpus-chunks/${sql[1]}`
      : text ? `.cache/text/${text[1]}` : null;
    if (!destination) throw new Error(`unsupported hydration path: ${entry.path}`);
    return {
      archive_path: entry.path,
      destination: projectPath(root, destination, 'hydration destination'),
      buffer: parsed.files.get(entry.path),
      directory_seals: sql ? directories.sql.seals : directories.text.seals,
    };
  });
}

export async function hydratePrivateCorpusTar({ root = process.cwd(), tarBuffer } = {}) {
  const parsed = parsePrivateCorpusTar(tarBuffer);
  const trackedPath = projectPath(root, 'data/corpus-chunks/manifest.json', 'tracked corpus manifest');
  const tracked = await readStableRegularFile(root, 'data/corpus-chunks/manifest.json');
  if (!tracked.equals(parsed.corpus_manifest_buffer)) {
    throw new Error('tracked corpus manifest differs from private bundle; it will not be overwritten');
  }
  const directories = await assertDestinationInventory(root, parsed);
  const targets = hydrationTargets(root, parsed, directories);
  const states = [];
  for (const target of targets) states.push(await destinationState(target.destination, target.buffer));
  for (const [index, target] of targets.entries()) {
    if (states[index] === 'missing') {
      await installNoClobber(target.destination, target.buffer, target.directory_seals);
    }
  }
  for (const target of targets) {
    const verified = await readExistingRegularNoFollow(target.destination, 'hydrated readback');
    if (!verified.equals(target.buffer)) throw new Error(`hydrated readback differs: ${target.destination}`);
  }
  if (!(await readStableRegularFile(root, 'data/corpus-chunks/manifest.json')).equals(tracked)) {
    throw new Error('tracked corpus manifest changed during hydration');
  }
  const receipt = {
    schema_version: 1,
    contract: HYDRATION_RECEIPT_CONTRACT,
    classification: CLASSIFICATION,
    public_runtime: false,
    bundle_id: parsed.bundle_manifest.bundle_id,
    bundle_manifest_sha256: parsed.bundle_manifest_sha256,
    payload_sha256: parsed.bundle_manifest.payload_sha256,
    corpus_release_id: parsed.bundle_manifest.corpus_release_id,
    corpus_manifest_sha256: parsed.bundle_manifest.corpus_manifest_sha256,
    plaintext_tar_sha256: parsed.plaintext_tar_sha256,
    hydrated_file_count: targets.length,
    tracked_manifest_preserved: true,
  };
  const receiptPath = projectPath(
    root,
    `.cache/corpus-hydration/receipts/${parsed.bundle_manifest.bundle_id}.json`,
    'hydration receipt',
  );
  const receiptDirectory = await ensureDirectoryTree(root, '.cache/corpus-hydration/receipts');
  const created = await writeAtomicOwnerOnly(receiptPath, canonicalJsonBuffer(receipt), {
    directorySeals: receiptDirectory.seals,
  });
  return {
    ...receipt,
    status: created || states.includes('missing') ? 'hydrated' : 'already_hydrated',
    receipt_path: relative(resolve(root), receiptPath),
  };
}

export async function verifyHydratedCorpus({ root = process.cwd(), descriptor = null } = {}) {
  const manifestBuffer = await readStableRegularFile(root, 'data/corpus-chunks/manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(manifestBuffer.toString('utf8'));
  } catch (error) {
    throw new Error(`tracked corpus manifest is not JSON: ${error.message}`);
  }
  const validated = validateCorpusManifest(manifest, manifest?.sql_files?.length);
  if (descriptor) {
    validateCorpusArtifactDescriptor(descriptor);
    if (descriptor.corpus.release_id !== validated.release_id
        || descriptor.corpus.release_fingerprint_sha256 !== validated.release_fingerprint_sha256
        || descriptor.corpus.manifest_sha256 !== sha256(manifestBuffer)
        || descriptor.corpus.manifest_bytes !== manifestBuffer.length) {
      throw new Error('hydrated corpus differs from artifact descriptor corpus identity');
    }
  }
  const expected = [
    ...validated.sql_files.map((entry) => ({ path: `data/corpus-chunks/${entry.name}`, ...entry })),
    ...validated.text_assets.map((entry) => ({ path: `.cache/text/${entry.document_id}.txt`, ...entry })),
  ];
  for (const entry of expected) await readStableRegularFile(root, entry.path, entry);
  return {
    valid: true,
    release_id: validated.release_id,
    release_fingerprint_sha256: validated.release_fingerprint_sha256,
    manifest_sha256: sha256(manifestBuffer),
    manifest_bytes: manifestBuffer.length,
    hydrated_file_count: expected.length,
    sql_file_count: validated.sql_files.length,
    text_asset_count: validated.text_assets.length,
  };
}

export async function readJsonFile(path, label = 'JSON file') {
  let value;
  try {
    value = JSON.parse((await readPrivateFile(path, {
      maxBytes: MAX_PRIVATE_JSON_BYTES,
      label,
    })).toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error.message}`);
  }
  return value;
}

export async function writePrivateFile(path, buffer) {
  return writeAtomicOwnerOnly(resolve(path), buffer);
}
