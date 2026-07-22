#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const compareText = (left, right) => Buffer.from(left).compare(Buffer.from(right));

const runRoot = '/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess';
const outputRoot = `${runRoot}/output/production-p1-mb16-shard-a-r2`;
const evidenceBaseRoot = `${runRoot}/a2-deploy-evidence/20260719T003812Z`;
const documentId = 'legacy-compendium-english';
const rearmRepairId = 'a08b53ee30c0320bc8c2783df1087392a42e33a283a776630206a857412b7dc6';
const issuanceRelativePath = 'timeout-recovery-issuance/791ad258ee227f1fbc5646a91812b2900ec2d0eef04da885ffc1b3f6b5a960a8.issuance.json';

export const A2_READONLY_COLLECTION_SPEC = Object.freeze({
  schema_version: 1,
  target: {
    run_root: runRoot,
    output_root: outputRoot,
    input_root: `${runRoot}/input/pdfs-verified`,
    manifest: `${runRoot}/manifests/offload-shard-a.json`,
    lifecycle_lock: `${runRoot}/.a2-lifecycle.lock`,
    evidence_base_root: evidenceBaseRoot,
    incident_evidence_root: `${evidenceBaseRoot}/incident-operator-freeze-monitor-jq-20260722T041335Z`,
    rearm_evidence_root: `${evidenceBaseRoot}/${rearmRepairId}`,
    continuation_evidence_root: `${evidenceBaseRoot}/operator-forward-continuations/${documentId}/attempt-0006`,
    document_root: `${outputRoot}/documents/${documentId}`,
    document_id: documentId,
    attempt: 6,
  },
  directories: {
    output_root: outputRoot,
    input_root: `${runRoot}/input/pdfs-verified`,
    evidence_base_root: evidenceBaseRoot,
    incident_evidence_root: `${evidenceBaseRoot}/incident-operator-freeze-monitor-jq-20260722T041335Z`,
    rearm_evidence_root: `${evidenceBaseRoot}/${rearmRepairId}`,
    document_root: `${outputRoot}/documents/${documentId}`,
    lifecycle_lock: `${runRoot}/.a2-lifecycle.lock`,
    continuation_evidence_root: `${evidenceBaseRoot}/operator-forward-continuations/${documentId}/attempt-0006`,
  },
  files: {
    manifest: { path: `${runRoot}/manifests/offload-shard-a.json`, export: 'json' },
    run_identity: { path: `${outputRoot}/run-identity.json`, export: 'json' },
    run_status: { path: `${outputRoot}/run-status.json`, export: 'json' },
    run_status_sidecar: { path: `${outputRoot}/run-status.json.sha256`, export: 'text' },
    document_status: { path: `${outputRoot}/status/${documentId}.json`, export: 'json' },
    document_status_sidecar: { path: `${outputRoot}/status/${documentId}.json.sha256`, export: 'text' },
    document_state: { path: `${outputRoot}/documents/${documentId}/state.json`, export: 'json_raw' },
    document_log: { path: `${outputRoot}/logs/${documentId}.log`, export: 'none' },
    seed_receipt: { path: `${outputRoot}/seed-receipt.json`, export: 'json' },
    seed_receipt_sidecar: { path: `${outputRoot}/seed-receipt.json.sha256`, export: 'text' },
    seed_commit: { path: `${outputRoot}/seed-commit.json`, export: 'json' },
    seed_commit_sidecar: { path: `${outputRoot}/seed-commit.json.sha256`, export: 'text' },
    seed_journal: { path: `${outputRoot}/.seed-journal.json`, export: 'json' },
    seed_journal_sidecar: { path: `${outputRoot}/.seed-journal.json.sha256`, export: 'text' },
    ledger_identity: { path: `${outputRoot}/timeout-recovery-ledger-identity.json`, export: 'json' },
    ledger_identity_sidecar: { path: `${outputRoot}/timeout-recovery-ledger-identity.json.sha256`, export: 'text' },
    timeout_grant: { path: `${outputRoot}/timeout-recovery-grant.json`, export: 'json' },
    timeout_grant_sidecar: { path: `${outputRoot}/timeout-recovery-grant.json.sha256`, export: 'text' },
    timeout_consumption_claim: { path: `${outputRoot}/timeout-recovery-consumption-claim.json`, export: 'json' },
    timeout_consumption_claim_sidecar: { path: `${outputRoot}/timeout-recovery-consumption-claim.json.sha256`, export: 'text' },
    timeout_issuance: { path: `${outputRoot}/${issuanceRelativePath}`, export: 'json' },
    timeout_issuance_sidecar: { path: `${outputRoot}/${issuanceRelativePath}.sha256`, export: 'text' },
    incident: { path: `${evidenceBaseRoot}/incident-operator-freeze-monitor-jq-20260722T041335Z/incident.json`, export: 'json' },
    rearm_receipt: { path: `${evidenceBaseRoot}/${rearmRepairId}/repair-receipt.json`, export: 'json' },
    rearm_receipt_sidecar: { path: `${evidenceBaseRoot}/${rearmRepairId}/repair-receipt.json.sha256`, export: 'text' },
    rearm_reservation_claim: { path: `${evidenceBaseRoot}/${rearmRepairId}.claim.json`, export: 'json' },
  },
  trees: {
    document: `${outputRoot}/documents/${documentId}`,
    incident: `${evidenceBaseRoot}/incident-operator-freeze-monitor-jq-20260722T041335Z`,
    predecessor: `${outputRoot}/seed-predecessor-evidence`,
    rearm: `${evidenceBaseRoot}/${rearmRepairId}`,
    continuation: `${evidenceBaseRoot}/operator-forward-continuations/${documentId}/attempt-0006`,
  },
  units: {
    worker: 'curriculum-ocr-reprocess-a-r2.service',
    monitor: 'curriculum-ocr-reprocess-a-r2-monitor.service',
    monitor_timer: 'curriculum-ocr-reprocess-a-r2-monitor.timer',
    alert: 'curriculum-ocr-monitor-alert@curriculum-ocr-reprocess-a-r2-monitor.service.service',
    llama: 'curriculum-ocr-llama.service',
  },
});

function mode(info) {
  return (Number(info.mode) & 0o7777).toString(8).padStart(4, '0');
}

function identity(info) {
  return {
    device: String(info.dev),
    inode: String(info.ino),
    mode: mode(info),
    uid: String(info.uid),
    gid: String(info.gid),
    nlink: String(info.nlink),
    size: String(info.size),
    type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : info.isSymbolicLink() ? 'symlink' : 'other',
  };
}

async function capture(label, operation) {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return {
      ok: false,
      error: {
        label,
        code: String(error?.code || 'ERROR'),
        message: String(error?.message || error),
      },
    };
  }
}

async function inspectPath(pathname) {
  const info = await lstat(pathname, { bigint: true });
  const resolved = await realpath(pathname);
  return { path: pathname, realpath: resolved, ...identity(info) };
}

async function readStable(pathname, exportMode) {
  const before = await lstat(pathname, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('not a real regular file');
  const handle = await open(pathname, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const openedBefore = await handle.stat({ bigint: true });
    const raw = await handle.readFile();
    const openedAfter = await handle.stat({ bigint: true });
    const after = await lstat(pathname, { bigint: true });
    const sameIdentity = [openedBefore, openedAfter, after].every(
      (info) => info.dev === before.dev && info.ino === before.ino,
    );
    const stable = sameIdentity
      && openedBefore.size === openedAfter.size
      && openedAfter.size === BigInt(raw.byteLength)
      && before.nlink === after.nlink;
    const result = {
      path: pathname,
      ...identity(after),
      bytes: raw.byteLength,
      sha256: sha256(raw),
      stable,
    };
    if (exportMode === 'json' || exportMode === 'json_raw') {
      if (raw.byteLength > 2 * 1024 * 1024) throw new Error('metadata JSON exceeds 2 MiB export ceiling');
      result.json = JSON.parse(raw.toString('utf8'));
      if (exportMode === 'json_raw') result.raw_base64 = raw.toString('base64');
    } else if (exportMode === 'text') {
      if (raw.byteLength > 512) throw new Error('metadata text exceeds 512-byte export ceiling');
      result.text = raw.toString('utf8');
    }
    return result;
  } finally {
    await handle.close();
  }
}

async function inspectTree(root) {
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== path.resolve(root)) throw new Error('tree root traverses a symbolic link');
  const rootInfo = await lstat(root, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('tree root is not a real directory');
  const entries = [];
  const directories = [];
  let files = 0;
  let bytes = 0;
  async function walk(directory, relativeDirectory) {
    const directoryInfo = await lstat(directory, { bigint: true });
    directories.push({ path: relativeDirectory || '.', ...identity(directoryInfo) });
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareText(left.name, right.name));
    if (relativeDirectory && children.length === 0) entries.push(`D\0${relativeDirectory}\n`);
    for (const child of children) {
      const pathname = path.join(directory, child.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const info = await lstat(pathname, { bigint: true });
      if (info.isSymbolicLink()) throw new Error(`tree contains symbolic link: ${relative}`);
      if (info.isDirectory()) {
        entries.push(`D\0${relative}\n`);
        await walk(pathname, relative);
      } else if (info.isFile()) {
        const record = await readStable(pathname, 'none');
        if (!record.stable) throw new Error(`tree file changed during read: ${relative}`);
        entries.push(`F\0${relative}\0${record.bytes}\0${record.sha256}\n`);
        files += 1;
        bytes += record.bytes;
      } else {
        throw new Error(`tree contains non-regular entry: ${relative}`);
      }
    }
  }
  await walk(canonicalRoot, '');
  return {
    root,
    tree_sha256: sha256(entries.join('')),
    files,
    bytes,
    entries,
    directories,
  };
}

async function inspectUnit(unit, role) {
  const generation = [
    'StateChangeTimestampMonotonic',
    'ActiveEnterTimestampMonotonic',
    'ActiveExitTimestampMonotonic',
    'InactiveEnterTimestampMonotonic',
    ...(role.endsWith('_timer') ? ['LastTriggerUSecMonotonic'] : []),
  ];
  const properties = [
    'Id', 'LoadState', 'UnitFileState', 'ActiveState', 'SubState', 'MainPID',
    'InvocationID', 'ExecMainStatus', 'NRestarts', 'Result', 'ConditionResult',
    ...generation,
  ];
  const { stdout } = await execFile('systemctl', [
    '--user', 'show', unit,
    ...properties.map((property) => `--property=${property}`),
    '--no-pager',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 });
  const values = {};
  for (const line of String(stdout).trimEnd().split('\n')) {
    const delimiter = line.indexOf('=');
    if (delimiter < 1) throw new Error('invalid systemctl --user show output');
    const key = line.slice(0, delimiter);
    if (Object.hasOwn(values, key)) throw new Error(`duplicate systemd property: ${key}`);
    values[key] = line.slice(delimiter + 1);
  }
  return { role, unit, properties: values };
}

export async function collectA2ReadonlySnapshot({
  inspectPathFn = inspectPath,
  readStableFn = readStable,
  inspectTreeFn = inspectTree,
  inspectUnitFn = inspectUnit,
} = {}) {
  const spec = A2_READONLY_COLLECTION_SPEC;
  const directories = {};
  const files = {};
  const trees = {};
  const units = {};
  for (const [id, pathname] of Object.entries(spec.directories)) {
    directories[id] = await capture(`directory:${id}`, () => inspectPathFn(pathname));
  }
  for (const [id, descriptor] of Object.entries(spec.files)) {
    files[id] = await capture(`file:${id}`, () => readStableFn(descriptor.path, descriptor.export));
  }
  for (const [id, pathname] of Object.entries(spec.trees)) {
    trees[id] = await capture(`tree:${id}`, () => inspectTreeFn(pathname));
  }
  for (const [role, unit] of Object.entries(spec.units)) {
    units[role] = await capture(`unit:${role}`, () => inspectUnitFn(unit, role));
  }
  const specRaw = Buffer.from(JSON.stringify(spec));
  return {
    schema_version: 1,
    snapshot_type: 'curriculum_remote_ocr_a2_readonly_preflight_snapshot',
    collection_spec_sha256: sha256(specRaw),
    target: spec.target,
    directories,
    files,
    trees,
    units,
    mutation_performed: false,
    ocr_content_exported: false,
  };
}

async function main() {
  const snapshot = await collectA2ReadonlySnapshot();
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
}

const invokedAsFile = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsFile || process.env.CURRICULUM_A2_PREFLIGHT_COLLECT === '1') {
  main().catch((error) => {
    process.stderr.write(`collect-remote-ocr-a2-readonly-snapshot: ${error.message}\n`);
    process.exitCode = 2;
  });
}
