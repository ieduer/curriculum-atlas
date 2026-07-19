import { constants } from 'node:fs';
import {
  lstat,
  open,
  readdir,
  realpath,
  stat,
} from 'node:fs/promises';
import path from 'node:path';

function identity(info) {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    mode: String(info.mode),
    nlink: String(info.nlink),
    size: String(info.size),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs),
  };
}

function sameNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left, right) {
  return sameNode(left, right)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

export function pathIsWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function openPinnedDirectory(directoryPath, label) {
  const requestedPath = path.resolve(directoryPath);
  const requestedInfo = await lstat(requestedPath, { bigint: true });
  if (requestedInfo.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  const canonicalPath = await realpath(requestedPath);
  const before = identity(await stat(canonicalPath, { bigint: true }));
  const handle = await open(
    canonicalPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const openedInfo = await handle.stat({ bigint: true });
  if (!openedInfo.isDirectory()) {
    await handle.close();
    throw new Error(`${label} must be a directory`);
  }
  const opened = identity(openedInfo);
  if (!sameNode(before, opened)) {
    await handle.close();
    throw new Error(`${label} directory identity changed while opening`);
  }
  return { requestedPath, canonicalPath, handle, identity: opened };
}

async function verifyPinnedDirectory(pin, label) {
  const [handleInfo, pathInfo, currentCanonicalPath] = await Promise.all([
    pin.handle.stat({ bigint: true }),
    stat(pin.canonicalPath, { bigint: true }),
    realpath(pin.requestedPath),
  ]);
  const handleIdentity = identity(handleInfo);
  const pathIdentity = identity(pathInfo);
  if (currentCanonicalPath !== pin.canonicalPath
    || !sameNode(pin.identity, handleIdentity)
    || !sameNode(pin.identity, pathIdentity)) {
    throw new Error(`${label} directory identity changed after pinning`);
  }
}

export async function readPinnedRegularFileReceipt(filePath, options = {}) {
  const label = String(options.label || 'evidence file');
  const requestedPath = path.resolve(filePath);
  let rootPin;
  let parentPin;
  let fileHandle;
  try {
    const parentRequestedPath = path.dirname(requestedPath);
    rootPin = await openPinnedDirectory(options.rootPath || parentRequestedPath, `${label} root`);
    parentPin = await openPinnedDirectory(parentRequestedPath, `${label} parent`);
    if (!pathIsWithin(rootPin.canonicalPath, parentPin.canonicalPath)) {
      throw new Error(`${label} parent escapes its evidence root`);
    }
    const canonicalFilePath = path.join(parentPin.canonicalPath, path.basename(requestedPath));
    const beforeInfo = await lstat(canonicalFilePath, { bigint: true });
    if (beforeInfo.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
    if (!beforeInfo.isFile()) throw new Error(`${label} must be a regular file`);
    const before = identity(beforeInfo);
    fileHandle = await open(canonicalFilePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedInfo = await fileHandle.stat({ bigint: true });
    if (!openedInfo.isFile()) throw new Error(`${label} must be a regular file`);
    const opened = identity(openedInfo);
    if (!sameFileSnapshot(before, opened)) {
      throw new Error(`${label} file identity or metadata changed while opening`);
    }

    if (options.onPinnedForTest) await options.onPinnedForTest();
    const bytes = await fileHandle.readFile();

    await verifyPinnedDirectory(parentPin, `${label} parent`);
    await verifyPinnedDirectory(rootPin, `${label} root`);
    const [afterHandleInfo, afterPathInfo] = await Promise.all([
      fileHandle.stat({ bigint: true }),
      lstat(canonicalFilePath, { bigint: true }),
    ]);
    const afterHandle = identity(afterHandleInfo);
    const afterPath = identity(afterPathInfo);
    if (!afterPathInfo.isFile()
      || !sameFileSnapshot(opened, afterHandle)
      || !sameFileSnapshot(opened, afterPath)) {
      throw new Error(`${label} file identity or metadata changed during the read`);
    }
    return {
      bytes: options.encoding ? bytes.toString(options.encoding) : bytes,
      requestedPath,
      parentRequestedPath: parentPin.requestedPath,
      rootRequestedPath: rootPin.requestedPath,
      canonicalPath: canonicalFilePath,
      parentCanonicalPath: parentPin.canonicalPath,
      rootCanonicalPath: rootPin.canonicalPath,
      fileIdentity: opened,
      parentIdentity: parentPin.identity,
      rootIdentity: rootPin.identity,
    };
  } catch (error) {
    throw new Error(`${label} cannot be read safely: ${error.message}`);
  } finally {
    await fileHandle?.close();
    await parentPin?.handle.close();
    await rootPin?.handle.close();
  }
}

export async function readPinnedRegularFile(filePath, options = {}) {
  return (await readPinnedRegularFileReceipt(filePath, options)).bytes;
}

export async function readPinnedDirectoryEntries(directoryPath, options = {}) {
  const label = String(options.label || 'evidence directory');
  let rootPin;
  let directoryPin;
  try {
    rootPin = await openPinnedDirectory(options.rootPath || directoryPath, `${label} root`);
    directoryPin = await openPinnedDirectory(directoryPath, label);
    if (!pathIsWithin(rootPin.canonicalPath, directoryPin.canonicalPath)) {
      throw new Error(`${label} escapes its evidence root`);
    }
    if (options.onPinnedForTest) await options.onPinnedForTest();
    const entries = await readdir(directoryPin.canonicalPath, { withFileTypes: true });
    await verifyPinnedDirectory(directoryPin, label);
    await verifyPinnedDirectory(rootPin, `${label} root`);
    return {
      requestedPath: directoryPin.requestedPath,
      rootRequestedPath: rootPin.requestedPath,
      entries,
      canonicalPath: directoryPin.canonicalPath,
      directoryIdentity: directoryPin.identity,
      rootCanonicalPath: rootPin.canonicalPath,
      rootIdentity: rootPin.identity,
    };
  } catch (error) {
    throw new Error(`${label} cannot be read safely: ${error.message}`);
  } finally {
    await directoryPin?.handle.close();
    await rootPin?.handle.close();
  }
}

export async function verifyPinnedDirectoryReceipt(receipt, label = 'evidence directory') {
  const currentCanonicalPath = await realpath(receipt.requestedPath);
  const current = identity(await stat(receipt.canonicalPath, { bigint: true }));
  if (currentCanonicalPath !== receipt.canonicalPath || !sameNode(receipt.directoryIdentity, current)) {
    throw new Error(`${label} directory identity changed after its bounded read`);
  }
}
