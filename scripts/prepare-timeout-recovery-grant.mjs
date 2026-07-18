#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './lib/remote-ocr-local-snapshot.mjs';
import { inspectTimeoutRecoveryPredecessorForGrant } from './run-remote-ocr-offload.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const sha256Pattern = /^[a-f0-9]{64}$/u;
const ledgerIdentityFilename = 'ledger-identity.json';
const grantFilename = 'timeout-recovery-grant.json';
const ledgerType = 'curriculum_remote_ocr_timeout_recovery_consumption_ledger';
const grantType = 'curriculum_remote_ocr_timeout_recovery_grant';
const grantMode = 'one_additional_attempt_per_document';
const claimMode = 'atomic_single_claim';
const authorityDirectoryName = 'timeout-recovery-authority-v1';
const issuanceClaimType = 'curriculum_remote_ocr_timeout_recovery_issuance_claim';
const predecessorClaimKeyType = 'curriculum_remote_ocr_timeout_recovery_predecessor_claim_key';
const activePublicationTemps = new Set();
const publicationLocks = new Map();

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function requireExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(expected)) {
    throw new Error(`${label} has an invalid or non-canonical field order`);
  }
  return value;
}

function requireSha256(value, label) {
  if (!sha256Pattern.test(String(value || ''))) {
    throw new Error(`${label} must be lowercase SHA-256`);
  }
  return value;
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

async function resolveProspectivePath(pathname, label) {
  const absolute = path.resolve(pathname);
  let cursor = absolute;
  const missing = [];
  for (;;) {
    const kind = await pathKind(cursor);
    if (kind === 'symlink') throw new Error(`${label} must not contain a symlink`);
    if (kind !== 'missing') {
      if (!['directory', 'file'].includes(kind)) {
        throw new Error(`${label} contains a non-regular filesystem entry`);
      }
      if (missing.length > 0 && kind !== 'directory') {
        throw new Error(`${label} has a non-directory existing parent`);
      }
      const resolved = await realpath(cursor);
      if (resolved !== cursor) throw new Error(`${label} must not resolve through a symlink`);
      return path.resolve(resolved, ...missing.reverse());
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`${label} has no existing parent`);
    missing.push(path.basename(cursor));
    cursor = parent;
  }
}

async function requireExistingRealParent(pathname, label) {
  const parent = path.dirname(pathname);
  if (await pathKind(parent) !== 'directory' || await realpath(parent) !== parent) {
    throw new Error(`${label} parent must be an existing real directory`);
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

async function requireOwnedFile(pathname, ownerRoot, label) {
  const info = await lstat(pathname).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing`);
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if ((info.mode & 0o777) !== 0o600) {
    throw new Error(`${label} mode must equal 0600`);
  }
  const resolved = await realpath(pathname);
  if (resolved !== path.resolve(pathname) || !isWithin(ownerRoot, resolved)) {
    throw new Error(`${label} must resolve directly inside its owned root`);
  }
  let handle;
  try {
    handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} cannot be opened without following links: ${error.message}`, { cause: error });
  }
  try {
    const opened = await handle.stat({ bigint: true });
    const expectedUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : opened.uid;
    const expectedGid = typeof process.getgid === 'function' ? BigInt(process.getgid()) : opened.gid;
    if (!opened.isFile()
      || opened.nlink !== 1n
      || opened.uid !== expectedUid
      || opened.gid !== expectedGid
      || (Number(opened.mode) & 0o777) !== 0o600) {
      throw new Error(`${label} must be a mode-0600 single-link file owned by the current uid/gid`);
    }
    const raw = await handle.readFile();
    if (BigInt(raw.byteLength) !== opened.size) {
      throw new Error(`${label} size changed while it was read`);
    }
    const final = await handle.stat({ bigint: true });
    if (final.dev !== opened.dev
      || final.ino !== opened.ino
      || final.size !== opened.size
      || final.mtimeNs !== opened.mtimeNs
      || final.ctimeNs !== opened.ctimeNs
      || final.nlink !== 1n) {
      throw new Error(`${label} changed while it was read`);
    }
    return raw;
  } finally {
    await handle.close();
  }
}

async function readOptionalHashSealedFile(pathname, ownerRoot, label) {
  const rawKind = await pathKind(pathname);
  const sealPath = `${pathname}.sha256`;
  const sealKind = await pathKind(sealPath);
  for (const [kind, entryLabel] of [[rawKind, label], [sealKind, `${label} hash seal`]]) {
    if (!['missing', 'file'].includes(kind)) {
      throw new Error(`${entryLabel} must be a regular non-symlink file when present`);
    }
  }
  if (rawKind === 'missing' && sealKind === 'file') {
    throw new Error(`${label} has an orphan SHA-256 hash seal`);
  }
  if (rawKind === 'missing') {
    return { present: false, sealPresent: false, raw: null, sealRaw: null };
  }
  const raw = await requireOwnedFile(pathname, ownerRoot, label);
  const sealRaw = sealKind === 'file'
    ? await requireOwnedFile(sealPath, ownerRoot, `${label} hash seal`)
    : null;
  return { present: true, sealPresent: sealRaw !== null, raw, sealRaw };
}

function expectedHashSeal(pathname, raw) {
  return Buffer.from(`${sha256(raw)}  ${path.basename(pathname)}\n`);
}

function verifyHashSeal(pathname, raw, sealRaw, label) {
  const expected = expectedHashSeal(pathname, raw);
  if (!sealRaw.equals(expected)) {
    throw new Error(`${label} SHA-256 hash seal differs from the exact raw bytes`);
  }
  return expected;
}

function processAppearsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function cleanupStalePublicationTemps(pathname, ownerRoot) {
  const parent = path.dirname(pathname);
  const prefix = `.${path.basename(pathname)}.publish-`;
  const entries = await readdir(parent, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix) || !entry.name.endsWith('.tmp')) continue;
    const pidMatch = /^\.(?:.+)\.publish-(\d+)-[a-f0-9-]+\.tmp$/u.exec(entry.name);
    const tempPath = path.join(parent, entry.name);
    if (!pidMatch
      || activePublicationTemps.has(tempPath)
      || (Number(pidMatch[1]) !== process.pid && processAppearsAlive(Number(pidMatch[1])))) continue;
    let handle;
    try {
      handle = await open(tempPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat({ bigint: true });
      const expectedUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : opened.uid;
      const expectedGid = typeof process.getgid === 'function' ? BigInt(process.getgid()) : opened.gid;
      if (!opened.isFile()
        || opened.nlink !== 1n
        || opened.uid !== expectedUid
        || opened.gid !== expectedGid
        || (Number(opened.mode) & 0o777) !== 0o600) {
        throw new Error(`stale publication temp is not a safe owned inode: ${tempPath}`);
      }
      const resolved = await realpath(tempPath);
      if (resolved !== tempPath || !isWithin(ownerRoot, resolved)) {
        throw new Error(`stale publication temp escaped its owned root: ${tempPath}`);
      }
      const current = await lstat(tempPath, { bigint: true });
      if (current.dev !== opened.dev || current.ino !== opened.ino || current.nlink !== 1n) {
        throw new Error(`stale publication temp changed before recovery: ${tempPath}`);
      }
      await unlink(tempPath);
    } finally {
      await handle?.close();
    }
  }
  await syncDirectory(parent);
}

async function writeExclusiveDurableUnlocked(pathname, ownerRoot, raw, label, hooks = {}) {
  const persistedKind = await pathKind(pathname);
  if (persistedKind !== 'missing') {
    if (persistedKind !== 'file') {
      throw new Error(`${label} final path is not a regular file`);
    }
    await cleanupStalePublicationTemps(pathname, ownerRoot);
    const persisted = await requireOwnedFile(pathname, ownerRoot, label);
    if (!persisted.equals(raw)) {
      throw new Error(`${label} already exists with different raw bytes`);
    }
    await syncDirectory(path.dirname(pathname));
    return false;
  }
  await cleanupStalePublicationTemps(pathname, ownerRoot);
  const parent = path.dirname(pathname);
  const tempPath = path.join(
    parent,
    `.${path.basename(pathname)}.publish-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle;
  let preserveTemp = false;
  activePublicationTemps.add(tempPath);
  try {
    handle = await open(
      tempPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    const opened = await handle.stat({ bigint: true });
    const expectedUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : opened.uid;
    const expectedGid = typeof process.getgid === 'function' ? BigInt(process.getgid()) : opened.gid;
    if (!opened.isFile()
      || opened.nlink !== 1n
      || opened.uid !== expectedUid
      || opened.gid !== expectedGid
      || (Number(opened.mode) & 0o777) !== 0o600) {
      throw new Error(`${label} temporary inode is not a safe mode-0600 owned file`);
    }
    await handle.writeFile(raw);
    await handle.sync();
    await handle.close();
    handle = null;
    await hooks.afterTempSync?.({ pathname, tempPath, raw });
    try {
      await link(tempPath, pathname);
      await unlink(tempPath);
      await syncDirectory(parent);
      await hooks.afterLink?.({ pathname, tempPath, raw });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const persisted = await requireOwnedFile(pathname, ownerRoot, label);
      if (!persisted.equals(raw)) {
        throw new Error(`${label} final path exists with different raw bytes`);
      }
      await syncDirectory(parent);
    }
  } catch (error) {
    preserveTemp = error?.simulateProcessCrash === true;
    throw error;
  } finally {
    activePublicationTemps.delete(tempPath);
    await handle?.close();
    if (!preserveTemp) {
      await unlink(tempPath).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
      await syncDirectory(parent);
    }
  }
  return true;
}

async function writeExclusiveDurable(pathname, ownerRoot, raw, label, hooks = {}) {
  const previous = publicationLocks.get(pathname) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  publicationLocks.set(pathname, current);
  await previous;
  try {
    return await writeExclusiveDurableUnlocked(pathname, ownerRoot, raw, label, hooks);
  } finally {
    release();
    if (publicationLocks.get(pathname) === current) publicationLocks.delete(pathname);
  }
}

async function installOrVerifyExactFile(pathname, ownerRoot, raw, label, hooks = {}) {
  const created = await writeExclusiveDurable(pathname, ownerRoot, raw, label, hooks);
  const persisted = await requireOwnedFile(pathname, ownerRoot, label);
  if (!persisted.equals(raw)) {
    throw new Error(`${label} already exists with different raw bytes`);
  }
  return created;
}

async function installOrVerifyHashSeal(pathname, ownerRoot, raw, label, hooks = {}) {
  const persistedRaw = await requireOwnedFile(pathname, ownerRoot, label);
  if (!persistedRaw.equals(raw)) {
    throw new Error(`${label} raw bytes drifted before hash-seal installation`);
  }
  const sealPath = `${pathname}.sha256`;
  const sealRaw = expectedHashSeal(pathname, raw);
  const created = await writeExclusiveDurable(
    sealPath,
    ownerRoot,
    sealRaw,
    `${label} hash seal`,
    hooks,
  );
  const persistedSeal = await requireOwnedFile(sealPath, ownerRoot, `${label} hash seal`);
  verifyHashSeal(pathname, raw, persistedSeal, label);
  return created;
}

export function canonicalTimeoutRecoveryAuthorityRoot(predecessorInputRoot) {
  return path.join(path.dirname(path.resolve(predecessorInputRoot)), authorityDirectoryName);
}

export function buildTimeoutRecoveryAuthorityIdentity({
  ledgerRoot,
  predecessorInputRoot,
  ledgerDevice,
  ledgerInode,
  ownerUid,
  ownerGid,
}) {
  const nonceBasis = {
    schema_version: 1,
    authority_type: ledgerType,
    predecessor_input_root: path.resolve(predecessorInputRoot),
    ledger_root: path.resolve(ledgerRoot),
    ledger_device: String(ledgerDevice),
    ledger_inode: String(ledgerInode),
    owner_uid: String(ownerUid),
    owner_gid: String(ownerGid),
    citation_allowed: false,
  };
  const basis = {
    schema_version: 1,
    ledger_type: ledgerType,
    ledger_nonce: sha256(canonicalJson(nonceBasis)),
    citation_allowed: false,
  };
  return {
    schema_version: basis.schema_version,
    ledger_type: basis.ledger_type,
    ledger_nonce: basis.ledger_nonce,
    ledger_id: sha256(canonicalJson(basis)),
    citation_allowed: false,
  };
}

function parseLedgerIdentity(raw, ledger, predecessorInputRoot) {
  let identity;
  try {
    identity = JSON.parse(raw);
  } catch (error) {
    throw new Error(`timeout recovery ledger identity is not valid JSON: ${error.message}`);
  }
  requireExactKeys(identity, [
    'schema_version',
    'ledger_type',
    'ledger_nonce',
    'ledger_id',
    'citation_allowed',
  ], 'timeout recovery ledger identity');
  requireSha256(identity.ledger_nonce, 'timeout recovery ledger nonce');
  requireSha256(identity.ledger_id, 'timeout recovery ledger ID');
  const expected = buildTimeoutRecoveryAuthorityIdentity({
    ledgerRoot: ledger.root,
    predecessorInputRoot,
    ledgerDevice: ledger.device,
    ledgerInode: ledger.inode,
    ownerUid: ledger.uid,
    ownerGid: ledger.gid,
  });
  const expectedRaw = Buffer.from(jsonText(expected));
  if (identity.schema_version !== 1
    || identity.ledger_type !== ledgerType
    || identity.citation_allowed !== false
    || !raw.equals(expectedRaw)) {
    throw new Error('timeout recovery ledger identity is not the deterministic canonical authority for this input root and inode');
  }
  return { identity: expected, raw: expectedRaw };
}

async function loadLedgerIdentity(ledger, predecessorInputRoot) {
  const identityPath = path.join(ledger.root, ledgerIdentityFilename);
  const pair = await readOptionalHashSealedFile(
    identityPath,
    ledger.root,
    'timeout recovery ledger identity',
  );
  if (!pair.present || !pair.sealPresent) {
    throw new Error('timeout recovery requires one pre-existing hash-sealed canonical authority identity');
  }
  const parsed = parseLedgerIdentity(pair.raw, ledger, predecessorInputRoot);
  verifyHashSeal(identityPath, parsed.raw, pair.sealRaw, 'timeout recovery ledger identity');
  return { ...parsed, hashSealPresent: true };
}

function buildGrant(inspection, ledger) {
  const grantDocuments = inspection.documents.map((document) => {
    const { timeout_incident: _timeoutIncident, ...grantDocument } = document;
    return grantDocument;
  });
  const basis = {
    schema_version: 1,
    grant_type: grantType,
    mode: grantMode,
    predecessor: {
      manifest_sha256: inspection.manifest_sha256,
      run_identity_sha256: inspection.run_identity_sha256,
      run_status_sha256: inspection.run_status_sha256,
    },
    policy: {
      required_status: 'quarantined',
      required_inherited_attempts: 5,
      granted_attempt: 6,
      additional_attempts_per_document: 1,
      automatic_attempt_7: false,
      scope: 'all_timeout_quarantined_documents',
    },
    consumption: {
      ledger_id: ledger.identity.ledger_id,
      ledger_root: ledger.root,
      ledger_device: ledger.device,
      ledger_inode: ledger.inode,
      claim_mode: claimMode,
    },
    documents: grantDocuments,
    citation_allowed: false,
  };
  const grant = {
    schema_version: basis.schema_version,
    grant_type: basis.grant_type,
    mode: basis.mode,
    grant_id: sha256(canonicalJson(basis)),
    predecessor: basis.predecessor,
    policy: basis.policy,
    consumption: basis.consumption,
    documents: basis.documents,
    citation_allowed: false,
  };
  return { grant, raw: Buffer.from(jsonText(grant)) };
}

function timeoutRecoveryPredecessorClaimKey(grant) {
  return sha256(canonicalJson({
    schema_version: 1,
    claim_key_type: predecessorClaimKeyType,
    predecessor: grant.predecessor,
    policy: grant.policy,
    documents: grant.documents,
    citation_allowed: false,
  }));
}

function buildIssuanceClaim(inspection, ledger, expectedGrant) {
  const claimKey = timeoutRecoveryPredecessorClaimKey(expectedGrant.grant);
  const incidentEvidence = inspection.documents.map((document) => ({
    document_id: document.document_id,
    attempt: document.timeout_incident.attempt,
    timeout_type: document.timeout_incident.timeout_type,
    raw_sha256: document.timeout_incident.raw_sha256,
    sidecar_sha256: document.timeout_incident.sidecar_sha256,
    log_sha256: document.timeout_incident.log_sha256,
  }));
  const claim = {
    schema_version: 1,
    claim_type: issuanceClaimType,
    claim_key: claimKey,
    ledger_id: ledger.identity.ledger_id,
    predecessor: structuredClone(expectedGrant.grant.predecessor),
    grant_id: expectedGrant.grant.grant_id,
    grant_raw_sha256: sha256(expectedGrant.raw),
    incident_evidence: incidentEvidence,
    citation_allowed: false,
  };
  return {
    claim,
    raw: Buffer.from(jsonText(claim)),
    claimKey,
    path: path.join(ledger.root, `${claimKey}.issuance.json`),
  };
}

function inspectionHash(inspection) {
  const stableDocuments = inspection.documents.map((document) => ({
    ...document,
    timeout_incident: {
      ...document.timeout_incident,
      present: undefined,
    },
  }));
  return sha256(canonicalJson({
    schema_version: inspection.schema_version,
    manifest_path: inspection.manifest_path,
    manifest_sha256: inspection.manifest_sha256,
    predecessor_root: inspection.predecessor_root,
    predecessor_input_root: inspection.predecessor_input_root,
    run_identity_sha256: inspection.run_identity_sha256,
    run_status_sha256: inspection.run_status_sha256,
    documents: stableDocuments,
    citation_allowed: false,
  }));
}

async function requireUnchangedInspection(options, expectedHash) {
  const current = await inspectTimeoutRecoveryPredecessorForGrant(options);
  if (inspectionHash(current) !== expectedHash) {
    throw new Error('timeout recovery predecessor or manifest drifted during preparation');
  }
  return current;
}

async function ensureLedgerRoot(ledgerRoot) {
  const kind = await pathKind(ledgerRoot);
  if (kind === 'missing') {
    throw new Error('timeout recovery canonical authority root must be provisioned before grant preparation');
  }
  if (kind !== 'directory') {
    throw new Error('timeout recovery ledger root must be a real directory');
  }
  const resolved = await realpath(ledgerRoot);
  if (resolved !== ledgerRoot) {
    throw new Error('timeout recovery ledger root must not resolve through a symlink');
  }
  const info = await stat(resolved, { bigint: true });
  const expectedUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : info.uid;
  const expectedGid = typeof process.getgid === 'function' ? BigInt(process.getgid()) : info.gid;
  if ((Number(info.mode) & 0o777) !== 0o700
    || info.uid !== expectedUid
    || info.gid !== expectedGid) {
    throw new Error('timeout recovery ledger root must be mode 0700 and owned by the current uid/gid');
  }
  return {
    root: resolved,
    device: String(info.dev),
    inode: String(info.ino),
    uid: String(info.uid),
    gid: String(info.gid),
  };
}

function rejectNestedLedger(ledgerRoot, inspection) {
  for (const [protectedRoot, label] of [
    [inspection.predecessor_root, 'predecessor root'],
    [inspection.predecessor_input_root, 'predecessor input root'],
  ]) {
    if (isWithin(protectedRoot, ledgerRoot) || isWithin(ledgerRoot, protectedRoot)) {
      throw new Error(`timeout recovery ledger root must be disjoint from ${label}`);
    }
  }
  if (isWithin(ledgerRoot, inspection.manifest_path)) {
    throw new Error('timeout recovery ledger root must not contain the manifest');
  }
}

async function verifyOrInstallGrant({
  inspection,
  ledger,
  apply,
  actions,
  publicationHooks,
  requireStableInspection,
}) {
  const incidents = [];
  for (const document of inspection.documents) {
    const incident = document.timeout_incident;
    const incidentPath = path.join(inspection.predecessor_root, incident.path);
    const raw = Buffer.from(jsonText(incident.value));
    const sidecarRaw = expectedHashSeal(incidentPath, raw);
    if (sha256(raw) !== incident.raw_sha256
      || sha256(sidecarRaw) !== incident.sidecar_sha256
      || incident.value.log.sha256 !== document.timeout_log.sha256) {
      throw new Error(`${document.document_id}: structured timeout incident no longer matches its inspected bytes or log`);
    }
    let pair = await readOptionalHashSealedFile(
      incidentPath,
      inspection.predecessor_root,
      `${document.document_id} timeout incident`,
    );
    if (!pair.present && apply) {
      const incidentParent = path.dirname(incidentPath);
      await mkdir(incidentParent, { recursive: true, mode: 0o700 });
      const resolvedParent = await realpath(incidentParent);
      const parentInfo = await stat(resolvedParent, { bigint: true });
      const expectedUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : parentInfo.uid;
      const expectedGid = typeof process.getgid === 'function' ? BigInt(process.getgid()) : parentInfo.gid;
      if (resolvedParent !== incidentParent
        || !isWithin(inspection.predecessor_root, resolvedParent)
        || !parentInfo.isDirectory()
        || (Number(parentInfo.mode) & 0o777) !== 0o700
        || parentInfo.uid !== expectedUid
        || parentInfo.gid !== expectedGid) {
        throw new Error(`${document.document_id}: timeout incident parent is not a safe mode-0700 owned directory`);
      }
      await syncDirectory(path.dirname(incidentParent));
      await syncDirectory(inspection.predecessor_root);
      if (await installOrVerifyExactFile(
        incidentPath,
        inspection.predecessor_root,
        raw,
        `${document.document_id} timeout incident`,
        publicationHooks,
      )) actions.push(`create:${incidentPath}`);
      pair = await readOptionalHashSealedFile(
        incidentPath,
        inspection.predecessor_root,
        `${document.document_id} timeout incident`,
      );
    }
    if (pair.present && !pair.raw.equals(raw)) {
      throw new Error(`${document.document_id}: timeout incident exists with different raw bytes`);
    }
    if (pair.sealPresent) {
      verifyHashSeal(
        incidentPath,
        raw,
        pair.sealRaw,
        `${document.document_id} timeout incident`,
      );
    } else if (pair.present && apply) {
      if (await installOrVerifyHashSeal(
        incidentPath,
        inspection.predecessor_root,
        raw,
        `${document.document_id} timeout incident`,
        publicationHooks,
      )) actions.push(`create:${incidentPath}.sha256`);
      pair = await readOptionalHashSealedFile(
        incidentPath,
        inspection.predecessor_root,
        `${document.document_id} timeout incident`,
      );
    }
    if (apply && (!pair.present || !pair.sealPresent)) {
      throw new Error(`${document.document_id}: timeout incident was not durably hash-sealed`);
    }
    incidents.push({
      document_id: document.document_id,
      path: incidentPath,
      present: pair.present,
      hash_seal_present: pair.sealPresent,
      raw_sha256: incident.raw_sha256,
      sidecar_sha256: incident.sidecar_sha256,
    });
  }
  if (apply) await requireStableInspection();
  const grantPath = path.join(inspection.predecessor_root, grantFilename);
  const expected = buildGrant(inspection, ledger);
  const issuance = buildIssuanceClaim(inspection, ledger, expected);
  let issuancePair = await readOptionalHashSealedFile(
    issuance.path,
    ledger.root,
    'timeout recovery issuance claim',
  );
  if (!issuancePair.present && apply) {
    if (await installOrVerifyExactFile(
      issuance.path,
      ledger.root,
      issuance.raw,
      'timeout recovery issuance claim',
      publicationHooks,
    )) actions.push(`create:${issuance.path}`);
    issuancePair = await readOptionalHashSealedFile(
      issuance.path,
      ledger.root,
      'timeout recovery issuance claim',
    );
  }
  if (issuancePair.present && !issuancePair.raw.equals(issuance.raw)) {
    throw new Error('timeout recovery predecessor claim key was already issued with different evidence');
  }
  if (issuancePair.sealPresent) {
    verifyHashSeal(
      issuance.path,
      issuance.raw,
      issuancePair.sealRaw,
      'timeout recovery issuance claim',
    );
  } else if (issuancePair.present && apply) {
    if (await installOrVerifyHashSeal(
      issuance.path,
      ledger.root,
      issuance.raw,
      'timeout recovery issuance claim',
      publicationHooks,
    )) actions.push(`create:${issuance.path}.sha256`);
  }
  if (apply && (!issuancePair.present || !issuancePair.sealPresent)) {
    issuancePair = await readOptionalHashSealedFile(
      issuance.path,
      ledger.root,
      'timeout recovery issuance claim',
    );
    if (!issuancePair.present || !issuancePair.sealPresent) {
      throw new Error('timeout recovery issuance claim was not durably hash-sealed');
    }
    verifyHashSeal(
      issuance.path,
      issuance.raw,
      issuancePair.sealRaw,
      'timeout recovery issuance claim',
    );
  }
  if (apply) await requireStableInspection();
  let pair = await readOptionalHashSealedFile(
    grantPath,
    inspection.predecessor_root,
    'timeout recovery grant',
  );
  if (!pair.present && apply) {
    if (await installOrVerifyExactFile(
      grantPath,
      inspection.predecessor_root,
      expected.raw,
      'timeout recovery grant',
      publicationHooks,
    )) actions.push(`create:${grantPath}`);
    pair = await readOptionalHashSealedFile(
      grantPath,
      inspection.predecessor_root,
      'timeout recovery grant',
    );
  }
  if (pair.present && !pair.raw.equals(expected.raw)) {
    throw new Error('timeout recovery grant differs from the directly inspected predecessor evidence');
  }
  if (pair.sealPresent) {
    verifyHashSeal(grantPath, expected.raw, pair.sealRaw, 'timeout recovery grant');
  } else if (pair.present && apply) {
    if (await installOrVerifyHashSeal(
      grantPath,
      inspection.predecessor_root,
      expected.raw,
      'timeout recovery grant',
      publicationHooks,
    )) actions.push(`repair-hash-seal:${grantPath}.sha256`);
  }
  return {
    path: grantPath,
    present: pair.present || apply,
    hash_seal_present: pair.sealPresent || apply,
    grant_id: expected.grant.grant_id,
    raw_sha256: sha256(expected.raw),
    hash_seal_sha256: sha256(expectedHashSeal(grantPath, expected.raw)),
    documents: expected.grant.documents.map((document) => ({
      document_id: document.document_id,
      first_missing_page: document.first_missing_page,
      predecessor_status_sha256: document.predecessor_status_sha256,
      predecessor_state_sha256: document.predecessor_state_sha256,
      timeout_log_sha256: document.timeout_log.sha256,
    })),
    issuance: {
      claim_key: issuance.claimKey,
      path: issuance.path,
      present: issuancePair.present || apply,
      hash_seal_present: issuancePair.sealPresent || apply,
      raw_sha256: sha256(issuance.raw),
    },
    incidents,
  };
}

export async function prepareTimeoutRecoveryGrant({
  manifest,
  predecessorRoot,
  ledgerRoot,
  apply = false,
} = {}, dependencies = {}) {
  if (typeof apply !== 'boolean') throw new Error('apply must be a boolean');
  if (typeof ledgerRoot !== 'string' || ledgerRoot.length === 0) {
    throw new Error('--ledger-root is required');
  }
  const publicationHooks = dependencies.publicationHooks || {};
  if (!publicationHooks || typeof publicationHooks !== 'object' || Array.isArray(publicationHooks)) {
    throw new Error('publicationHooks dependency must be an object');
  }
  const inspectOptions = { manifestPath: manifest, predecessorRoot };
  const inspection = await inspectTimeoutRecoveryPredecessorForGrant(inspectOptions);
  if (path.resolve(predecessorRoot) !== inspection.predecessor_root) {
    throw new Error('timeout recovery predecessor root must not resolve through a symlink');
  }
  const prospectiveLedgerRoot = await resolveProspectivePath(
    ledgerRoot,
    'timeout recovery ledger root',
  );
  await requireExistingRealParent(prospectiveLedgerRoot, 'timeout recovery ledger root');
  const canonicalLedgerRoot = canonicalTimeoutRecoveryAuthorityRoot(
    inspection.predecessor_input_root,
  );
  if (prospectiveLedgerRoot !== canonicalLedgerRoot
    || path.resolve(ledgerRoot) !== canonicalLedgerRoot) {
    throw new Error(`timeout recovery ledger must equal the single canonical authority root ${canonicalLedgerRoot}`);
  }
  rejectNestedLedger(prospectiveLedgerRoot, inspection);
  const actions = [];
  const initialInspectionHash = inspectionHash(inspection);
  let ledger = await ensureLedgerRoot(prospectiveLedgerRoot);
  const ledgerIdentity = await loadLedgerIdentity(
    ledger,
    inspection.predecessor_input_root,
  );
  ledger = { ...ledger, identity: ledgerIdentity.identity };
  const stableInspection = apply
    ? await requireUnchangedInspection(inspectOptions, initialInspectionHash)
    : inspection;
  const grant = await verifyOrInstallGrant({
    inspection: stableInspection,
    ledger,
    apply,
    actions,
    publicationHooks,
    requireStableInspection: () => requireUnchangedInspection(
      inspectOptions,
      initialInspectionHash,
    ),
  });
  if (apply) {
    await requireUnchangedInspection(inspectOptions, initialInspectionHash);
    const finalIdentityPair = await readOptionalHashSealedFile(
      path.join(ledger.root, ledgerIdentityFilename),
      ledger.root,
      'timeout recovery ledger identity',
    );
    const finalGrantPair = await readOptionalHashSealedFile(
      grant.path,
      inspection.predecessor_root,
      'timeout recovery grant',
    );
    const finalIssuancePair = await readOptionalHashSealedFile(
      grant.issuance.path,
      ledger.root,
      'timeout recovery issuance claim',
    );
    if (!finalIdentityPair.present || !finalIdentityPair.sealPresent
      || !finalGrantPair.present || !finalGrantPair.sealPresent
      || !finalIssuancePair.present || !finalIssuancePair.sealPresent) {
      throw new Error('timeout recovery preparation did not durably install all hash-sealed files');
    }
    verifyHashSeal(
      path.join(ledger.root, ledgerIdentityFilename),
      finalIdentityPair.raw,
      finalIdentityPair.sealRaw,
      'timeout recovery ledger identity',
    );
    verifyHashSeal(grant.path, finalGrantPair.raw, finalGrantPair.sealRaw, 'timeout recovery grant');
    verifyHashSeal(
      grant.issuance.path,
      finalIssuancePair.raw,
      finalIssuancePair.sealRaw,
      'timeout recovery issuance claim',
    );
  }
  const plannedWrites = apply ? [] : [
    ...grant.incidents.flatMap((incident) => [
      ...(!incident.present ? [incident.path] : []),
      ...(!incident.hash_seal_present ? [`${incident.path}.sha256`] : []),
    ]),
    ...(!grant.issuance.present ? [grant.issuance.path] : []),
    ...(!grant.issuance.hash_seal_present ? [`${grant.issuance.path}.sha256`] : []),
    ...(!grant.present ? [grant.path] : []),
    ...(!grant.hash_seal_present ? [`${grant.path}.sha256`] : []),
  ];
  return {
    schema_version: 1,
    operation: 'prepare_timeout_recovery_grant',
    mode: apply ? 'apply' : 'preview',
    status: apply
      ? actions.length > 0 ? 'applied' : 'verified_idempotent'
      : plannedWrites.length > 0 ? 'ready_to_apply' : 'verified_idempotent',
    predecessor: {
      root: inspection.predecessor_root,
      manifest_sha256: inspection.manifest_sha256,
      run_identity_sha256: inspection.run_identity_sha256,
      run_status_sha256: inspection.run_status_sha256,
      evidence_hash: initialInspectionHash,
      quarantined_documents: inspection.documents.length,
    },
    ledger: {
      root: ledger.root,
      device: ledger.device,
      inode: ledger.inode,
      uid: ledger.uid,
      gid: ledger.gid,
      ledger_id: ledger.identity.ledger_id,
      identity_sha256: sha256(ledgerIdentity.raw),
      hash_seal_sha256: sha256(expectedHashSeal(
        path.join(ledger.root, ledgerIdentityFilename),
        ledgerIdentity.raw,
      )),
      present: true,
      identity_present: true,
      hash_seal_present: true,
    },
    grant,
    applied_writes: actions,
    planned_writes: plannedWrites,
    citation_allowed: false,
  };
}

function usage() {
  return [
    'Usage: node scripts/prepare-timeout-recovery-grant.mjs --manifest PATH \\',
    '  --predecessor-root DIR --ledger-root DIR [--apply]',
    '',
    'Defaults to a read-only preview. The canonical mode-0700 authority and its',
    'mode-0600 hash-sealed identity must already exist and are never repaired.',
    '--apply exclusively publishes exact incident, issuance, and grant file pairs.',
    'Document, frontier, status, state, and timeout-log evidence is always inspected',
    'from the predecessor; it cannot be supplied on the command line.',
  ].join('\n');
}

function parseArguments(argv) {
  const options = { apply: false, help: false };
  const targets = new Map([
    ['--manifest', 'manifest'],
    ['--predecessor-root', 'predecessorRoot'],
    ['--ledger-root', 'ledgerRoot'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (targets.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      options[targets.get(argument)] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await prepareTimeoutRecoveryGrant(options);
  process.stdout.write(jsonText(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`timeout recovery preparation refused: ${error.message}\n`);
    process.exitCode = 1;
  });
}
