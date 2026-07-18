#!/usr/bin/env node

import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
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
  return readFile(resolved);
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

async function writeExclusiveDurable(pathname, raw, label) {
  let handle;
  try {
    handle = await open(pathname, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(raw);
    await handle.sync();
  } catch (error) {
    throw new Error(`${label} exclusive write failed: ${error.message}`, { cause: error });
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(pathname));
  return true;
}

async function installOrVerifyExactFile(pathname, ownerRoot, raw, label) {
  const created = await writeExclusiveDurable(pathname, raw, label);
  const persisted = await requireOwnedFile(pathname, ownerRoot, label);
  if (!persisted.equals(raw)) {
    throw new Error(`${label} already exists with different raw bytes`);
  }
  return created;
}

async function installOrVerifyHashSeal(pathname, ownerRoot, raw, label) {
  const persistedRaw = await requireOwnedFile(pathname, ownerRoot, label);
  if (!persistedRaw.equals(raw)) {
    throw new Error(`${label} raw bytes drifted before hash-seal installation`);
  }
  const sealPath = `${pathname}.sha256`;
  const sealRaw = expectedHashSeal(pathname, raw);
  const created = await writeExclusiveDurable(sealPath, sealRaw, `${label} hash seal`);
  const persistedSeal = await requireOwnedFile(sealPath, ownerRoot, `${label} hash seal`);
  verifyHashSeal(pathname, raw, persistedSeal, label);
  return created;
}

function parseLedgerIdentity(raw) {
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
  const basis = {
    schema_version: 1,
    ledger_type: ledgerType,
    ledger_nonce: identity.ledger_nonce,
    citation_allowed: false,
  };
  const expected = {
    schema_version: basis.schema_version,
    ledger_type: basis.ledger_type,
    ledger_nonce: basis.ledger_nonce,
    ledger_id: sha256(canonicalJson(basis)),
    citation_allowed: false,
  };
  const expectedRaw = Buffer.from(jsonText(expected));
  if (identity.schema_version !== 1
    || identity.ledger_type !== ledgerType
    || identity.citation_allowed !== false
    || !raw.equals(expectedRaw)) {
    throw new Error('timeout recovery ledger identity is not exact canonical v1 raw bytes');
  }
  return { identity: expected, raw: expectedRaw };
}

function newLedgerIdentity(randomBytes) {
  const nonceBytes = randomBytes(32);
  if (!Buffer.isBuffer(nonceBytes) || nonceBytes.byteLength !== 32) {
    throw new Error('timeout recovery ledger nonce source must return exactly 32 bytes');
  }
  const basis = {
    schema_version: 1,
    ledger_type: ledgerType,
    ledger_nonce: nonceBytes.toString('hex'),
    citation_allowed: false,
  };
  const identity = {
    schema_version: basis.schema_version,
    ledger_type: basis.ledger_type,
    ledger_nonce: basis.ledger_nonce,
    ledger_id: sha256(canonicalJson(basis)),
    citation_allowed: false,
  };
  return { identity, raw: Buffer.from(jsonText(identity)) };
}

async function loadLedgerIdentity(ledgerRoot, { apply, randomBytes, actions }) {
  const identityPath = path.join(ledgerRoot, ledgerIdentityFilename);
  let pair = await readOptionalHashSealedFile(
    identityPath,
    ledgerRoot,
    'timeout recovery ledger identity',
  );
  if (!pair.present) {
    if (!apply) return null;
    const candidate = newLedgerIdentity(randomBytes);
    const created = await writeExclusiveDurable(
      identityPath,
      candidate.raw,
      'timeout recovery ledger identity',
    );
    if (created) actions.push(`create:${identityPath}`);
    pair = await readOptionalHashSealedFile(
      identityPath,
      ledgerRoot,
      'timeout recovery ledger identity',
    );
  }
  const parsed = parseLedgerIdentity(pair.raw);
  if (pair.sealPresent) {
    verifyHashSeal(identityPath, parsed.raw, pair.sealRaw, 'timeout recovery ledger identity');
  } else if (apply) {
    if (await installOrVerifyHashSeal(
      identityPath,
      ledgerRoot,
      parsed.raw,
      'timeout recovery ledger identity',
    )) actions.push(`repair-hash-seal:${identityPath}.sha256`);
  }
  return { ...parsed, hashSealPresent: pair.sealPresent || apply };
}

function buildGrant(inspection, ledger) {
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
    documents: structuredClone(inspection.documents),
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

function inspectionHash(inspection) {
  return sha256(canonicalJson({
    schema_version: inspection.schema_version,
    manifest_path: inspection.manifest_path,
    manifest_sha256: inspection.manifest_sha256,
    predecessor_root: inspection.predecessor_root,
    predecessor_input_root: inspection.predecessor_input_root,
    run_identity_sha256: inspection.run_identity_sha256,
    run_status_sha256: inspection.run_status_sha256,
    documents: inspection.documents,
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

async function ensureLedgerRoot(ledgerRoot, { apply, actions }) {
  let kind = await pathKind(ledgerRoot);
  if (kind === 'missing' && apply) {
    try {
      await mkdir(ledgerRoot, { mode: 0o700 });
      actions.push(`create:${ledgerRoot}`);
      await syncDirectory(path.dirname(ledgerRoot));
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    kind = await pathKind(ledgerRoot);
  }
  if (kind === 'missing') return null;
  if (kind !== 'directory') {
    throw new Error('timeout recovery ledger root must be a real directory');
  }
  const resolved = await realpath(ledgerRoot);
  if (resolved !== ledgerRoot) {
    throw new Error('timeout recovery ledger root must not resolve through a symlink');
  }
  const info = await stat(resolved, { bigint: true });
  if ((Number(info.mode) & 0o777) !== 0o700) {
    throw new Error('timeout recovery ledger root mode must equal 0700');
  }
  return {
    root: resolved,
    device: String(info.dev),
    inode: String(info.ino),
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
}) {
  const grantPath = path.join(inspection.predecessor_root, grantFilename);
  const expected = buildGrant(inspection, ledger);
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
  const randomBytes = dependencies.randomBytes || nodeRandomBytes;
  if (typeof randomBytes !== 'function') throw new Error('randomBytes dependency must be a function');
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
  rejectNestedLedger(prospectiveLedgerRoot, inspection);
  const actions = [];
  const initialInspectionHash = inspectionHash(inspection);
  const initialLedgerKind = await pathKind(prospectiveLedgerRoot);
  const existingGrantPair = await readOptionalHashSealedFile(
    path.join(inspection.predecessor_root, grantFilename),
    inspection.predecessor_root,
    'timeout recovery grant',
  );
  if (initialLedgerKind === 'missing' && existingGrantPair.present) {
    throw new Error('timeout recovery grant exists without its bound ledger root');
  }
  let ledger = await ensureLedgerRoot(prospectiveLedgerRoot, { apply, actions });
  if (!ledger) {
    return {
      schema_version: 1,
      operation: 'prepare_timeout_recovery_grant',
      mode: 'preview',
      status: 'ready_to_apply',
      predecessor: {
        root: inspection.predecessor_root,
        manifest_sha256: inspection.manifest_sha256,
        run_identity_sha256: inspection.run_identity_sha256,
        run_status_sha256: inspection.run_status_sha256,
        evidence_hash: initialInspectionHash,
        quarantined_documents: inspection.documents.length,
      },
      ledger: {
        root: prospectiveLedgerRoot,
        present: false,
        identity_present: false,
        hash_seal_present: false,
      },
      grant: {
        path: path.join(inspection.predecessor_root, grantFilename),
        present: false,
        hash_seal_present: false,
        documents: inspection.documents.map((document) => ({
          document_id: document.document_id,
          first_missing_page: document.first_missing_page,
        })),
      },
      planned_writes: [
        prospectiveLedgerRoot,
        path.join(prospectiveLedgerRoot, ledgerIdentityFilename),
        path.join(prospectiveLedgerRoot, `${ledgerIdentityFilename}.sha256`),
        path.join(inspection.predecessor_root, grantFilename),
        path.join(inspection.predecessor_root, `${grantFilename}.sha256`),
      ],
      citation_allowed: false,
    };
  }
  const initialIdentityPair = await readOptionalHashSealedFile(
    path.join(ledger.root, ledgerIdentityFilename),
    ledger.root,
    'timeout recovery ledger identity',
  );
  if (!initialIdentityPair.present && existingGrantPair.present) {
    throw new Error('timeout recovery grant exists without a ledger identity');
  }
  const ledgerIdentity = await loadLedgerIdentity(ledger.root, { apply, randomBytes, actions });
  if (!ledgerIdentity) {
    if (existingGrantPair.present) {
      throw new Error('timeout recovery grant exists without a ledger identity');
    }
    return {
      schema_version: 1,
      operation: 'prepare_timeout_recovery_grant',
      mode: 'preview',
      status: 'ready_to_apply',
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
        present: true,
        identity_present: false,
        hash_seal_present: false,
      },
      grant: {
        path: path.join(inspection.predecessor_root, grantFilename),
        present: false,
        hash_seal_present: false,
        documents: inspection.documents.map((document) => ({
          document_id: document.document_id,
          first_missing_page: document.first_missing_page,
        })),
      },
      planned_writes: [
        path.join(ledger.root, ledgerIdentityFilename),
        path.join(ledger.root, `${ledgerIdentityFilename}.sha256`),
        path.join(inspection.predecessor_root, grantFilename),
        path.join(inspection.predecessor_root, `${grantFilename}.sha256`),
      ],
      citation_allowed: false,
    };
  }
  ledger = { ...ledger, identity: ledgerIdentity.identity };
  const stableInspection = apply
    ? await requireUnchangedInspection(inspectOptions, initialInspectionHash)
    : inspection;
  const grant = await verifyOrInstallGrant({
    inspection: stableInspection,
    ledger,
    apply,
    actions,
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
    if (!finalIdentityPair.present || !finalIdentityPair.sealPresent
      || !finalGrantPair.present || !finalGrantPair.sealPresent) {
      throw new Error('timeout recovery preparation did not durably install all hash-sealed files');
    }
    verifyHashSeal(
      path.join(ledger.root, ledgerIdentityFilename),
      finalIdentityPair.raw,
      finalIdentityPair.sealRaw,
      'timeout recovery ledger identity',
    );
    verifyHashSeal(grant.path, finalGrantPair.raw, finalGrantPair.sealRaw, 'timeout recovery grant');
  }
  const plannedWrites = apply ? [] : [
    ...(!ledgerIdentity.hashSealPresent
      ? [path.join(ledger.root, `${ledgerIdentityFilename}.sha256`)]
      : []),
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
      ledger_id: ledger.identity.ledger_id,
      identity_sha256: sha256(ledgerIdentity.raw),
      hash_seal_sha256: sha256(expectedHashSeal(
        path.join(ledger.root, ledgerIdentityFilename),
        ledgerIdentity.raw,
      )),
      present: true,
      identity_present: true,
      hash_seal_present: apply || (await pathKind(
        path.join(ledger.root, `${ledgerIdentityFilename}.sha256`),
      )) === 'file',
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
    'Defaults to a read-only preview. --apply exclusively creates or exactly repairs',
    'the mode-0700 ledger and mode-0600 v1 SHA-256 hash-sealed identity/grant files.',
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
