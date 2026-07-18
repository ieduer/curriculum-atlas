#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTimeoutRecoveryAuthorityIdentity,
  canonicalTimeoutRecoveryAuthorityRoot,
} from './prepare-timeout-recovery-grant.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const identityFilename = 'ledger-identity.json';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function pathKind(pathname) {
  try {
    const info = await lstat(pathname);
    if (info.isSymbolicLink()) return 'symlink';
    if (info.isDirectory()) return 'directory';
    if (info.isFile()) return 'file';
    return 'other';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function syncDirectory(pathname) {
  const handle = await open(pathname, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readOwnedFile(pathname, ownerRoot, label) {
  const handle = await open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
    throw new Error(`${label} cannot be opened without following links: ${error.message}`, { cause: error });
  });
  try {
    const info = await handle.stat({ bigint: true });
    const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : info.uid;
    const gid = typeof process.getgid === 'function' ? BigInt(process.getgid()) : info.gid;
    if (!info.isFile()
      || info.nlink !== 1n
      || info.uid !== uid
      || info.gid !== gid
      || (Number(info.mode) & 0o777) !== 0o600) {
      throw new Error(`${label} must be a current-UID/GID mode-0600 single-link file`);
    }
    const resolved = await realpath(pathname);
    if (resolved !== path.resolve(pathname) || path.dirname(resolved) !== ownerRoot) {
      throw new Error(`${label} must resolve directly inside the canonical authority`);
    }
    const raw = await handle.readFile();
    const final = await handle.stat({ bigint: true });
    if (BigInt(raw.byteLength) !== info.size
      || final.dev !== info.dev
      || final.ino !== info.ino
      || final.size !== info.size
      || final.mtimeNs !== info.mtimeNs
      || final.ctimeNs !== info.ctimeNs
      || final.nlink !== 1n) {
      throw new Error(`${label} changed while it was read`);
    }
    return raw;
  } finally {
    await handle.close();
  }
}

async function publishNoReplace(pathname, ownerRoot, raw, label) {
  const existing = await pathKind(pathname);
  if (existing !== 'missing') {
    if (existing !== 'file') throw new Error(`${label} final path is not a regular file`);
    const persisted = await readOwnedFile(pathname, ownerRoot, label);
    if (!persisted.equals(raw)) throw new Error(`${label} already exists with different bytes`);
    return false;
  }
  const tempPath = path.join(
    ownerRoot,
    `.${path.basename(pathname)}.provision-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      tempPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(raw);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await link(tempPath, pathname);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let persisted;
      let lastError;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          persisted = await readOwnedFile(pathname, ownerRoot, label);
          break;
        } catch (readError) {
          lastError = readError;
          if (!/single-link/u.test(readError.message)) throw readError;
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      }
      if (!persisted) throw lastError;
      if (!persisted.equals(raw)) throw new Error(`${label} concurrently appeared with different bytes`);
    }
    await unlink(tempPath);
    await syncDirectory(ownerRoot);
    return true;
  } finally {
    await handle?.close();
    await unlink(tempPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

async function inspectAuthority(authorityRoot, inputRoot) {
  const info = await stat(authorityRoot, { bigint: true });
  const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : info.uid;
  const gid = typeof process.getgid === 'function' ? BigInt(process.getgid()) : info.gid;
  if (!info.isDirectory()
    || (Number(info.mode) & 0o777) !== 0o700
    || info.uid !== uid
    || info.gid !== gid
    || await realpath(authorityRoot) !== authorityRoot) {
    throw new Error('timeout recovery authority must be a real current-UID/GID mode-0700 directory');
  }
  const identity = buildTimeoutRecoveryAuthorityIdentity({
    ledgerRoot: authorityRoot,
    predecessorInputRoot: inputRoot,
    ledgerDevice: info.dev,
    ledgerInode: info.ino,
    ownerUid: info.uid,
    ownerGid: info.gid,
  });
  const identityRaw = Buffer.from(jsonText(identity));
  const identityPath = path.join(authorityRoot, identityFilename);
  const sidecarRaw = Buffer.from(`${sha256(identityRaw)}  ${identityFilename}\n`);
  return { info, identity, identityRaw, identityPath, sidecarRaw };
}

export async function provisionTimeoutRecoveryAuthority({ inputRoot, apply = false } = {}) {
  if (typeof inputRoot !== 'string' || inputRoot.length === 0) throw new Error('--input-root is required');
  if (typeof apply !== 'boolean') throw new Error('apply must be a boolean');
  const inputPath = path.resolve(inputRoot);
  if (await pathKind(inputPath) !== 'directory' || await realpath(inputPath) !== inputPath) {
    throw new Error('timeout recovery input root must be an existing real directory');
  }
  const authorityRoot = canonicalTimeoutRecoveryAuthorityRoot(inputPath);
  const parent = path.dirname(authorityRoot);
  if (await pathKind(parent) !== 'directory' || await realpath(parent) !== parent) {
    throw new Error('timeout recovery authority parent must be an existing real directory');
  }
  let authorityKind = await pathKind(authorityRoot);
  if (authorityKind === 'symlink') throw new Error('timeout recovery authority must not be a symlink');
  if (!['missing', 'directory'].includes(authorityKind)) {
    throw new Error('timeout recovery authority path must be absent or a real directory');
  }
  if (authorityKind === 'missing' && !apply) {
    return {
      schema_version: 1,
      operation: 'provision_timeout_recovery_authority',
      mode: 'preview',
      status: 'ready_to_allocate_authority_inode',
      input_root: inputPath,
      authority_root: authorityRoot,
      planned_writes: [authorityRoot, path.join(authorityRoot, identityFilename), path.join(authorityRoot, `${identityFilename}.sha256`)],
      citation_allowed: false,
    };
  }
  if (authorityKind === 'missing') {
    try {
      await mkdir(authorityRoot, { mode: 0o700 });
      await syncDirectory(parent);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    authorityKind = await pathKind(authorityRoot);
  }
  if (authorityKind !== 'directory') throw new Error('timeout recovery authority allocation did not create a directory');
  const expected = await inspectAuthority(authorityRoot, inputPath);
  const rawKind = await pathKind(expected.identityPath);
  const sidecarPath = `${expected.identityPath}.sha256`;
  const sidecarKind = await pathKind(sidecarPath);
  if (rawKind === 'missing' && sidecarKind === 'file') {
    throw new Error('timeout recovery authority has an orphan identity sidecar');
  }
  if (![rawKind, sidecarKind].every((kind) => ['missing', 'file'].includes(kind))) {
    throw new Error('timeout recovery authority identity paths must be absent or regular files');
  }
  if (!apply) {
    if (rawKind === 'file') {
      const raw = await readOwnedFile(expected.identityPath, authorityRoot, 'timeout recovery authority identity');
      if (!raw.equals(expected.identityRaw)) throw new Error('timeout recovery authority identity is not canonical');
    }
    if (sidecarKind === 'file') {
      const raw = await readOwnedFile(sidecarPath, authorityRoot, 'timeout recovery authority identity sidecar');
      if (!raw.equals(expected.sidecarRaw)) throw new Error('timeout recovery authority identity sidecar is not canonical');
    }
    return {
      schema_version: 1,
      operation: 'provision_timeout_recovery_authority',
      mode: 'preview',
      status: rawKind === 'file' && sidecarKind === 'file' ? 'verified_idempotent' : 'ready_to_apply',
      input_root: inputPath,
      authority_root: authorityRoot,
      ledger_id: expected.identity.ledger_id,
      planned_writes: [
        ...(rawKind === 'missing' ? [expected.identityPath] : []),
        ...(sidecarKind === 'missing' ? [sidecarPath] : []),
      ],
      citation_allowed: false,
    };
  }
  const writes = [];
  if (await publishNoReplace(
    expected.identityPath,
    authorityRoot,
    expected.identityRaw,
    'timeout recovery authority identity',
  )) writes.push(expected.identityPath);
  if (await publishNoReplace(
    sidecarPath,
    authorityRoot,
    expected.sidecarRaw,
    'timeout recovery authority identity sidecar',
  )) writes.push(sidecarPath);
  const [identityRaw, sidecarRaw] = await Promise.all([
    readOwnedFile(expected.identityPath, authorityRoot, 'timeout recovery authority identity'),
    readOwnedFile(sidecarPath, authorityRoot, 'timeout recovery authority identity sidecar'),
  ]);
  if (!identityRaw.equals(expected.identityRaw) || !sidecarRaw.equals(expected.sidecarRaw)) {
    throw new Error('timeout recovery authority provisioning did not persist the exact identity pair');
  }
  return {
    schema_version: 1,
    operation: 'provision_timeout_recovery_authority',
    mode: 'apply',
    status: writes.length > 0 ? 'applied' : 'verified_idempotent',
    input_root: inputPath,
    authority_root: authorityRoot,
    ledger_id: expected.identity.ledger_id,
    applied_writes: writes,
    citation_allowed: false,
  };
}

function parseArguments(argv) {
  const options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--input-root') {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('--input-root requires a value');
      options.inputRoot = argv[index + 1];
      index += 1;
    } else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function usage() {
  return 'Usage: node scripts/provision-timeout-recovery-authority.mjs --input-root DIR [--apply]';
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(await provisionTimeoutRecoveryAuthority(options), null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`timeout recovery authority provisioning refused: ${error.message}\n`);
    process.exitCode = 1;
  });
}
