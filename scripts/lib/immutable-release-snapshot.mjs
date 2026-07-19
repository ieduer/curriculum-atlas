import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const READ_NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function rootPath(value) {
  return value instanceof URL ? fileURLToPath(value) : resolve(String(value || ''));
}

function normalizeRelativePath(value, label) {
  const text = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!text || isAbsolute(text) || text === '..' || text.startsWith('../') || text.includes('/../')) {
    throw new Error(`${label} must remain inside root`);
  }
  const normalized = text.replace(/\/{2,}/g, '/');
  if (normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${label} must be a canonical project-relative path`);
  }
  return normalized;
}

function assertInside(parent, child, label) {
  const relation = relative(parent, child);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${label} must remain inside root`);
  }
}

function normalizeExpected(expected, label) {
  const hash = String(expected?.sha256 || '');
  const bytes = expected?.bytes;
  if (!SHA256_PATTERN.test(hash) || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`${label} requires exact SHA-256 and byte length`);
  }
  return { sha256: hash, bytes };
}

function assertParity(expected, buffer, label) {
  const actual = { sha256: sha256(buffer), bytes: buffer.byteLength };
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
    throw new Error(`${label} parity failure: expected sha256=${expected.sha256} bytes=${expected.bytes}; actual sha256=${actual.sha256} bytes=${actual.bytes}`);
  }
  return actual;
}

async function readPinnedSource({ root, source, expected, label }) {
  const projectRoot = rootPath(root);
  const rootReal = await realpath(projectRoot);
  const normalized = normalizeRelativePath(source, label);
  const absolute = resolve(projectRoot, normalized);
  assertInside(projectRoot, absolute, label);
  const sourceLstat = await lstat(absolute);
  if (sourceLstat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!sourceLstat.isFile()) throw new Error(`${label} must be a regular file`);
  const sourceReal = await realpath(absolute);
  assertInside(rootReal, sourceReal, label);

  const handle = await open(absolute, READ_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    const buffer = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`${label} changed while being snapshotted`);
    }
    const identity = normalizeExpected(expected, label);
    assertParity(identity, buffer, label);
    return { normalized, buffer, identity };
  } finally {
    await handle.close();
  }
}

async function createPrivateDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await chmod(directory, 0o700);
  return directory;
}

async function writeReadOnlySnapshotFile(directory, relativePath, buffer) {
  const destination = join(directory, relativePath);
  assertInside(directory, destination, 'snapshot destination');
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, buffer, { flag: 'wx', mode: 0o600 });
  await chmod(destination, 0o400);
  const state = await lstat(destination);
  if (!state.isFile() || state.isSymbolicLink() || (state.mode & 0o222) !== 0) {
    throw new Error(`snapshot file is not a fixed read-only regular file: ${relativePath}`);
  }
  return { path: destination, dev: state.dev, ino: state.ino };
}

async function verifySnapshotFile({ path, directory, expected, dev, ino, label }) {
  const state = await lstat(path);
  if (!state.isFile() || state.isSymbolicLink()) throw new Error(`${label} snapshot inode is no longer a regular file`);
  if (state.dev !== dev || state.ino !== ino) throw new Error(`${label} snapshot inode changed`);
  if ((state.mode & 0o222) !== 0) throw new Error(`${label} snapshot is no longer read-only`);
  const pathReal = await realpath(path);
  const directoryReal = await realpath(directory);
  assertInside(directoryReal, pathReal, `${label} snapshot`);
  const handle = await open(path, READ_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== dev || opened.ino !== ino) throw new Error(`${label} snapshot inode changed while opening`);
    const buffer = await handle.readFile();
    const actual = assertParity(expected, buffer, `${label} snapshot`);
    return { ...actual, dev, ino };
  } finally {
    await handle.close();
  }
}

export async function createImmutableFileSnapshot({ root, source, expected, label = 'release file' } = {}) {
  const pinned = await readPinnedSource({ root, source, expected, label });
  const directory = await createPrivateDirectory('curriculum-release-file-');
  try {
    const snapshot = await writeReadOnlySnapshotFile(directory, 'payload', pinned.buffer);
    return {
      path: snapshot.path,
      directory,
      source: pinned.normalized,
      sha256: pinned.identity.sha256,
      bytes: pinned.identity.bytes,
      dev: snapshot.dev,
      ino: snapshot.ino,
      verify: () => verifySnapshotFile({
        path: snapshot.path,
        directory,
        expected: pinned.identity,
        dev: snapshot.dev,
        ino: snapshot.ino,
        label,
      }),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function createImmutableBufferSnapshot({ buffer, label = 'release buffer' } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new Error(`${label} must be a Buffer`);
  const identity = { sha256: sha256(buffer), bytes: buffer.byteLength };
  const directory = await createPrivateDirectory('curriculum-release-buffer-');
  try {
    const snapshot = await writeReadOnlySnapshotFile(directory, 'payload', buffer);
    return {
      path: snapshot.path,
      directory,
      sha256: identity.sha256,
      bytes: identity.bytes,
      dev: snapshot.dev,
      ino: snapshot.ino,
      verify: () => verifySnapshotFile({
        path: snapshot.path,
        directory,
        expected: identity,
        dev: snapshot.dev,
        ino: snapshot.ino,
        label,
      }),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function createImmutableTreeSnapshot({ root, files, label = 'release source tree' } = {}) {
  if (!Array.isArray(files) || files.length === 0) throw new Error(`${label} requires a non-empty file inventory`);
  const normalizedFiles = files.map((entry, index) => ({
    path: normalizeRelativePath(entry?.path, `${label} files[${index}]`),
    expected: normalizeExpected(entry, `${label} files[${index}]`),
  })).sort((left, right) => left.path.localeCompare(right.path, 'en'));
  if (new Set(normalizedFiles.map((entry) => entry.path)).size !== normalizedFiles.length) {
    throw new Error(`${label} contains duplicate paths`);
  }

  const pinned = [];
  for (const entry of normalizedFiles) {
    pinned.push(await readPinnedSource({
      root,
      source: entry.path,
      expected: entry.expected,
      label: `${label} ${entry.path}`,
    }));
  }
  const directory = await createPrivateDirectory('curriculum-release-tree-');
  try {
    const snapshotFiles = [];
    for (const entry of pinned) {
      const snapshot = await writeReadOnlySnapshotFile(directory, entry.normalized, entry.buffer);
      snapshotFiles.push({
        path: entry.normalized,
        expected: entry.identity,
        dev: snapshot.dev,
        ino: snapshot.ino,
        snapshotPath: snapshot.path,
      });
    }
    const digestInput = snapshotFiles
      .map((entry) => `${entry.path}\0${entry.expected.sha256}\0${entry.expected.bytes}\n`)
      .join('');
    const digest = sha256(Buffer.from(digestInput));
    const totalBytes = snapshotFiles.reduce((total, entry) => total + entry.expected.bytes, 0);
    return {
      root: directory,
      sha256: digest,
      file_count: snapshotFiles.length,
      total_bytes: totalBytes,
      files: snapshotFiles.map(({ snapshotPath: _snapshotPath, expected, ...entry }) => ({
        ...entry,
        sha256: expected.sha256,
        bytes: expected.bytes,
      })),
      async verify() {
        for (const entry of snapshotFiles) {
          await verifySnapshotFile({
            path: entry.snapshotPath,
            directory,
            expected: entry.expected,
            dev: entry.dev,
            ino: entry.ino,
            label: `${label} ${entry.path}`,
          });
        }
        return { file_count: snapshotFiles.length, sha256: digest, total_bytes: totalBytes };
      },
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
