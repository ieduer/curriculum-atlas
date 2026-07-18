#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  exactObjectKeys as requireExactLifecycleKeys,
  isCanonicalIsoTimestamp,
  preflightDocument,
  validateCanonicalLifecycleTimestamps,
  validateCompleteProgressContract,
  validateCompleteTimestampOrder,
  validateOcrDocumentOutput,
  validateRemoteOcrManifest,
} from './run-remote-ocr-offload.mjs';
import { validateRepairManifest as validateRemoteRepairManifest } from './apply-remote-ocr-repair.mjs';
import {
  canonicalJson,
  captureLocalReprocessSnapshot,
  copyTreeStrict,
  inspectTree,
  inspectTreeInventory,
  LOCAL_REPROCESS_SNAPSHOT_MODE,
} from './lib/remote-ocr-local-snapshot.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = path.resolve(path.dirname(scriptPath), '..');
const sha256Pattern = /^[a-f0-9]{64}$/;
const documentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const repairReceiptType = 'curriculum_remote_ocr_page_repair_receipt';
const seedReceiptType = 'curriculum_remote_ocr_hash_bound_output_seed';
const seedMode = 'hash_bound_output_seed';
const seedConfigurationScope = 'active_writer_with_hash_bound_seed_exceptions';
const seedPredecessorEvidenceDirectory = 'seed-predecessor-evidence';
const seedPredecessorEvidenceType = 'curriculum_remote_ocr_seed_predecessor_controls';
const timeoutRecoveryGrantFilename = 'timeout-recovery-grant.json';
const timeoutRecoveryGrantType = 'curriculum_remote_ocr_timeout_recovery_grant';
const timeoutRecoveryGrantMode = 'one_additional_attempt_per_document';
const timeoutRecoveryLedgerIdentityFilename = 'timeout-recovery-ledger-identity.json';
const timeoutRecoveryLedgerType = 'curriculum_remote_ocr_timeout_recovery_consumption_ledger';
const timeoutRecoveryClaimFilename = 'timeout-recovery-consumption-claim.json';
const timeoutRecoveryClaimType = 'curriculum_remote_ocr_timeout_recovery_consumption_claim';
const timeoutRecoveryClaimMode = 'atomic_single_claim';
const timeoutRecoveryIncidentType = 'curriculum_remote_ocr_child_timeout_incident';
const timeoutRecoveryIssuanceDirectory = 'timeout-recovery-issuance';
const timeoutRecoveryIssuanceClaimType = 'curriculum_remote_ocr_timeout_recovery_issuance_claim';
const timeoutRecoveryPredecessorClaimKeyType = 'curriculum_remote_ocr_timeout_recovery_predecessor_claim_key';
const maxAuthorityFileBytes = 64 * 1024 * 1024;
const maxDocumentAttempts = 5;
const legacyB1RunnerScriptSha256 = 'b08c3f7aa3da6e44dd9fffeecaf20b2a020df4d604c9b957399abaf886d15a55';
const p4ToP1Transition = 'p4_to_p1_v1';
const p4ToP1SeedAwareOcrTransition = 'p4_to_p1_seed_aware_ocr_v2';
const legacyToSeedAwareOcrScriptTransition = 'b1_legacy_to_seed_aware_v1';
const legacyB1OcrScriptSha256 = 'b4ea873026fb4d2da2efb921ddac3974a48db703143ff53aff3ebeae48d9b048';
const seedAwareOcrScriptSha256 = '3176d267c681b2764d4ff81f7e7b6748c174ee62854a11a2529ccfb355a364f3';
const auditedCommonInferenceSuffixSha256 = '4edade704624f0bac5bcd76eeb113a07452a57040e4fd949609d319f49c2b4ca';
const fixedB3RunnerScriptSha256 = '58a1e3826aca807bf62f4546f237597c305334ba1b0a56a8f47cacfaa5cfeaa7';
const a1CompletedStatusRunnerScriptSha256 = 'c562ee6363cfac390454700be92dc7a38b4c08946520d0e7b4991c792c23b34c';
const directedRunnerCompatibilityType = 'curriculum_remote_ocr_directed_runner_compatibility';
const directedRunnerCompatibilityTransition = 'a1_completed_status_to_fixed_b3_union_v1';
const paddleMarkdownAssetPattern = /^img_in_(header_image_box|image_box|footer_image_box|chart_box)_(\d+)_(\d+)_(\d+)_(\d+)\.jpg$/u;
const paddleAssetLabels = Object.freeze({
  header_image_box: 'header_image',
  image_box: 'image',
  footer_image_box: 'footer_image',
  chart_box: 'chart',
});
const documentStatuses = Object.freeze([
  'complete',
  'failed',
  'interrupted',
  'pending',
  'quarantined',
  'retry_wait',
  'running',
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(pathname) {
  return sha256(await readFile(pathname));
}

async function exists(pathname) {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}

async function lstatIfPresent(pathname) {
  try {
    return await lstat(pathname);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireSha256(value, label) {
  if (!sha256Pattern.test(String(value || ''))) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireExactObjectKeys(left, right, label) {
  if (!sameJson(Object.keys(left).sort(), Object.keys(right).sort())) {
    throw new Error(`${label} field set differs`);
  }
}

export function validateDirectedRunnerCompatibilityEvidence(evidenceValue) {
  const evidence = requireObject(evidenceValue, 'directed runner compatibility evidence');
  requireExactObjectKeys(evidence, {
    schema_version: null,
    compatibility_type: null,
    transition: null,
    allowed_difference: null,
    shards: null,
    citation_allowed: null,
    compatibility_sha256: null,
  }, 'directed runner compatibility evidence');
  if (evidence.schema_version !== 1
    || evidence.compatibility_type !== directedRunnerCompatibilityType
    || evidence.transition !== directedRunnerCompatibilityTransition
    || !sameJson(evidence.allowed_difference, ['runner_script_sha256'])
    || evidence.citation_allowed !== false
    || !Array.isArray(evidence.shards)
    || evidence.shards.length !== 2) {
    throw new Error('directed runner compatibility evidence declaration is invalid');
  }
  const expectedRoles = [
    {
      role: 'shard_a',
      runner_script_sha256: a1CompletedStatusRunnerScriptSha256,
      documents: 8,
      pages: 3_182,
    },
    {
      role: 'shard_b',
      runner_script_sha256: fixedB3RunnerScriptSha256,
      documents: 6,
      pages: 3_182,
    },
  ];
  for (let index = 0; index < expectedRoles.length; index += 1) {
    const shard = requireObject(evidence.shards[index], `directed runner compatibility shard ${index + 1}`);
    requireExactObjectKeys(shard, {
      role: null,
      manifest_sha256: null,
      run_identity_sha256: null,
      runner_script_sha256: null,
      documents: null,
      pages: null,
    }, `directed runner compatibility shard ${index + 1}`);
    requireSha256(shard.manifest_sha256, `directed runner compatibility shard ${index + 1} manifest SHA-256`);
    requireSha256(shard.run_identity_sha256, `directed runner compatibility shard ${index + 1} identity SHA-256`);
    if (shard.role !== expectedRoles[index].role
      || shard.runner_script_sha256 !== expectedRoles[index].runner_script_sha256
      || shard.documents !== expectedRoles[index].documents
      || shard.pages !== expectedRoles[index].pages) {
      throw new Error('directed runner compatibility evidence is not the unique A-new to B-fixed pair');
    }
  }
  const { compatibility_sha256: _compatibilitySha256, ...basis } = evidence;
  if (evidence.compatibility_sha256 !== sha256(canonicalJson(basis))) {
    throw new Error('directed runner compatibility evidence SHA-256 is invalid');
  }
  return evidence;
}

function isAuditedP4ToP1Delta(delta) {
  return delta?.schema_version === 2 && delta.transition === p4ToP1Transition
    || delta?.schema_version === 3 && delta.transition === p4ToP1SeedAwareOcrTransition;
}

function validateP4ToP1OcrScriptTransition(delta, predecessorSha256, successorSha256) {
  requireSha256(predecessorSha256, 'p4 OCR script SHA-256');
  requireSha256(successorSha256, 'p1 OCR script SHA-256');
  if (delta.schema_version === 2 && delta.transition === p4ToP1Transition) {
    if (predecessorSha256 !== successorSha256) {
      throw new Error('schema-v2 p4-to-p1 requires an identical OCR script identity');
    }
    return null;
  }
  if (delta.schema_version !== 3 || delta.transition !== p4ToP1SeedAwareOcrTransition) {
    throw new Error('seed receipt p4-to-p1 transition declaration is invalid');
  }
  if (predecessorSha256 !== legacyB1OcrScriptSha256
    || successorSha256 !== seedAwareOcrScriptSha256) {
    throw new Error('schema-v3 p4-to-p1 OCR script pair is not the exact audited transition');
  }
  const expected = {
    schema_version: 1,
    transition: legacyToSeedAwareOcrScriptTransition,
    predecessor_sha256: legacyB1OcrScriptSha256,
    successor_sha256: seedAwareOcrScriptSha256,
    audited_common_inference_suffix_sha256: auditedCommonInferenceSuffixSha256,
  };
  const actual = requireObject(
    delta.ocr_script_transition,
    'seed receipt OCR script transition',
  );
  requireExactObjectKeys(actual, expected, 'seed receipt OCR script transition');
  if (!sameJson(actual, expected)) {
    throw new Error('seed receipt OCR script transition declaration is not exact');
  }
  return expected;
}

function requireExactObjectKeyOrder(value, expectedKeys, label) {
  requireObject(value, label);
  if (!sameJson(Object.keys(value), expectedKeys)) {
    throw new Error(`${label} field order is not canonical`);
  }
  return value;
}

function containsTimeoutRecoveryKey(value) {
  if (Array.isArray(value)) return value.some(containsTimeoutRecoveryKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) => (
    key.startsWith('timeout_recovery') || containsTimeoutRecoveryKey(nested)
  ));
}

function requireRecomputedIdentityHashes(identity, label) {
  const attestation = requireObject(identity.llama_server_attestation, `${label} llama-server attestation`);
  const attestationSha256 = sha256(`${JSON.stringify(attestation)}\n`);
  if (identity.llama_server_attestation_sha256 !== attestationSha256) {
    throw new Error(`${label} llama-server attestation SHA-256 is invalid`);
  }
  const runtimeFingerprint = requireObject(identity.runtime_fingerprint, `${label} runtime fingerprint`);
  const runtimeFingerprintSha256 = sha256(`${JSON.stringify(runtimeFingerprint)}\n`);
  if (identity.runtime_fingerprint_sha256 !== runtimeFingerprintSha256) {
    throw new Error(`${label} runtime fingerprint SHA-256 is invalid`);
  }
  if (runtimeFingerprint.llama_server_attestation_sha256 !== attestationSha256) {
    throw new Error(`${label} runtime fingerprint is not bound to its llama-server attestation`);
  }
  return { attestation, attestationSha256, runtimeFingerprint, runtimeFingerprintSha256 };
}

function requireCanonicalLoopback8112(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port !== '8112') {
    throw new Error(`${label} must retain http://127.0.0.1:8112`);
  }
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveWithNearestExistingParent(pathname) {
  let cursor = path.resolve(pathname);
  const missingSegments = [];
  for (;;) {
    try {
      const resolved = await realpath(cursor);
      return path.resolve(resolved, ...missingSegments.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      let unresolvedEntryExists = false;
      try {
        await lstat(cursor);
        unresolvedEntryExists = true;
      } catch (entryError) {
        if (entryError?.code !== 'ENOENT' && entryError?.code !== 'ENOTDIR') throw entryError;
      }
      if (unresolvedEntryExists) {
        throw new Error(`${cursor} exists but cannot be resolved (dangling or invalid symlink)`);
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function baseFailureValid(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.error === 'string'
    && /PEG-native/iu.test(value.error)
    && /(?:^|\D)500(?:\D|$)/u.test(value.error),
  );
}

async function readJsonWithRaw(pathname, label = pathname) {
  const raw = await readFile(pathname);
  let value;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  return { raw, value };
}

async function requireRegularNonSymlink(pathname, label) {
  const info = await lstat(pathname).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing`);
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  return info;
}

async function verifySha256Sidecar(pathname, label) {
  const sidecarPath = `${pathname}.sha256`;
  await Promise.all([
    requireRegularNonSymlink(pathname, label),
    requireRegularNonSymlink(sidecarPath, `${label} SHA-256 sidecar`),
  ]);
  const sidecar = await readFile(sidecarPath, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`${label} SHA-256 sidecar is missing`);
    throw error;
  });
  const match = /^([a-f0-9]{64})  ([^\r\n]+)\n$/u.exec(sidecar);
  if (!match || match[2] !== path.basename(pathname)) {
    throw new Error(`${label} SHA-256 sidecar has an invalid format`);
  }
  const actual = await sha256File(pathname);
  if (actual !== match[1]) throw new Error(`${label} SHA-256 sidecar mismatch`);
  return actual;
}

async function readJsonWithVerifiedSidecar(pathname, label) {
  const sidecarPath = `${pathname}.sha256`;
  await Promise.all([
    requireRegularNonSymlink(pathname, label),
    requireRegularNonSymlink(sidecarPath, `${label} SHA-256 sidecar`),
  ]);
  const [raw, sidecarRaw] = await Promise.all([
    readFile(pathname),
    readFile(sidecarPath),
  ]);
  const match = /^([a-f0-9]{64})  ([^\r\n]+)\n$/u.exec(sidecarRaw.toString('utf8'));
  if (!match || match[2] !== path.basename(pathname)) {
    throw new Error(`${label} SHA-256 sidecar has an invalid format`);
  }
  const digest = sha256(raw);
  if (digest !== match[1]) throw new Error(`${label} SHA-256 sidecar mismatch`);
  let value;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  return { raw, sidecarRaw, digest, value };
}

function requireCanonicalPrettyJson(record, label) {
  const expected = Buffer.from(`${JSON.stringify(record.value, null, 2)}\n`);
  if (!record.raw.equals(expected)) {
    throw new Error(`${label} is not the exact canonical pretty-printed JSON encoding`);
  }
  return record;
}

async function readStableAuthorityFile(pathname, label) {
  const handle = await open(
    pathname,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  ).catch((error) => {
    throw new Error(`${label} cannot be opened without following links: ${error.message}`);
  });
  try {
    const before = await handle.stat({ bigint: true });
    const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : before.uid;
    const gid = typeof process.getgid === 'function' ? BigInt(process.getgid()) : before.gid;
    if (!before.isFile()
      || before.nlink !== 1n
      || before.uid !== uid
      || before.gid !== gid
      || before.size < 1n
      || before.size > BigInt(maxAuthorityFileBytes)
      || (Number(before.mode) & 0o7777) !== 0o600) {
      throw new Error(`${label} must be a current-UID/GID mode-0600 single-link file within size bounds`);
    }
    const raw = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathnameInfo = await lstat(pathname, { bigint: true });
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || after.nlink !== 1n
      || pathnameInfo.dev !== after.dev
      || pathnameInfo.ino !== after.ino
      || BigInt(raw.byteLength) !== after.size) {
      throw new Error(`${label} changed while it was read`);
    }
    return { raw, digest: sha256(raw), bytes: raw.byteLength };
  } finally {
    await handle.close();
  }
}

async function readCanonicalAuthorityJsonWithVerifiedSidecar(pathname, label) {
  const [body, sidecar] = await Promise.all([
    readStableAuthorityFile(pathname, label),
    readStableAuthorityFile(`${pathname}.sha256`, `${label} SHA-256 sidecar`),
  ]);
  const match = /^([a-f0-9]{64})  ([^\r\n]+)\n$/u.exec(sidecar.raw.toString('utf8'));
  if (!match || match[2] !== path.basename(pathname) || match[1] !== body.digest) {
    throw new Error(`${label} SHA-256 sidecar mismatch`);
  }
  let value;
  try { value = JSON.parse(body.raw.toString('utf8')); } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  const record = {
    raw: body.raw,
    sidecarRaw: sidecar.raw,
    digest: body.digest,
    value,
  };
  requireCanonicalPrettyJson(record, label);
  return record;
}

async function fingerprintStablePaddlexCache(cacheRoot, label) {
  const officialModelsRoot = path.join(cacheRoot, 'official_models');
  const directorySnapshots = new Map();
  const excluded = (relativePath) => {
    const parts = relativePath.split(path.sep);
    const basename = parts.at(-1);
    return parts.includes('locks')
      || parts.some((part) => part.startsWith('._'))
      || basename === '.cache'
      || basename.endsWith('.lock')
      || basename.endsWith('.part')
      || basename.includes('.tmp')
      || basename.startsWith('.nfs');
  };
  const sameIdentity = (left, right) => left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
  const readStableCacheFile = async (pathname, relativePath) => {
    const handle = await open(
      pathname,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    ).catch((error) => {
      throw new Error(`${label} file ${relativePath} cannot be opened safely: ${error.message}`);
    });
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) throw new Error(`${label} contains a non-regular file: ${relativePath}`);
      const raw = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      const pathnameInfo = await lstat(pathname, { bigint: true });
      if (!sameIdentity(before, after)
        || pathnameInfo.dev !== after.dev
        || pathnameInfo.ino !== after.ino
        || BigInt(raw.byteLength) !== after.size) {
        throw new Error(`${label} file ${relativePath} changed while it was fingerprinted`);
      }
      return { bytes: raw.byteLength, sha256: sha256(raw) };
    } finally {
      await handle.close();
    }
  };
  const entries = [];
  const walk = async (directory) => {
    const before = await lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || await realpath(directory) !== directory) {
      throw new Error(`${label} contains a non-canonical directory: ${directory}`);
    }
    directorySnapshots.set(directory, before);
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      const pathname = path.join(directory, child.name);
      const relativePath = path.relative(officialModelsRoot, pathname);
      if (excluded(relativePath)) continue;
      const info = await lstat(pathname, { bigint: true });
      if (info.isSymbolicLink()) throw new Error(`${label} contains a symlink: ${relativePath}`);
      if (info.isDirectory()) {
        await walk(pathname);
      } else if (info.isFile()) {
        const stable = await readStableCacheFile(pathname, relativePath);
        entries.push({
          path: relativePath.split(path.sep).join('/'),
          bytes: stable.bytes,
          sha256: stable.sha256,
        });
      } else {
        throw new Error(`${label} contains a non-regular entry: ${relativePath}`);
      }
    }
    const after = await lstat(directory, { bigint: true });
    if (!sameIdentity(before, after) || await realpath(directory) !== directory) {
      throw new Error(`${label} directory changed while it was fingerprinted: ${directory}`);
    }
  };
  await walk(officialModelsRoot);
  for (const [directory, before] of directorySnapshots) {
    const after = await lstat(directory, { bigint: true });
    if (!sameIdentity(before, after) || await realpath(directory) !== directory) {
      throw new Error(`${label} directory set changed after fingerprinting`);
    }
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  for (const required of [
    'PP-DocLayoutV3/inference.json',
    'PP-DocLayoutV3/inference.pdiparams',
    'PP-DocLayoutV3/inference.yml',
  ]) {
    if (!entries.some((entry) => entry.path === required && entry.bytes > 0)) {
      throw new Error(`${label} is incomplete: missing ${required}`);
    }
  }
  return {
    schema_version: 1,
    model_name: 'PP-DocLayoutV3',
    relative_root: 'official_models',
    file_count: entries.length,
    total_bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    tree_sha256: sha256(`${JSON.stringify(entries)}\n`),
  };
}

async function atomicWrite(pathname, contents, mode = 0o600) {
  await mkdir(path.dirname(pathname), { recursive: true });
  const temporary = path.join(path.dirname(pathname), `.${path.basename(pathname)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { mode, flag: 'wx' });
    await rename(temporary, pathname);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeReceipt(pathname, receipt) {
  const contents = `${JSON.stringify(receipt, null, 2)}\n`;
  await atomicWrite(pathname, contents);
  await atomicWrite(`${pathname}.sha256`, `${sha256(contents)}  ${path.basename(pathname)}\n`);
}

async function validateDocumentTreeShape(documentRoot, pageCount) {
  const rootEntries = (await readdir(documentRoot)).sort();
  if (!sameJson(rootEntries, ['pages', 'state.json'])) {
    throw new Error(`document tree contains unexpected root entries: ${documentRoot}`);
  }
  const stateInfo = await lstat(path.join(documentRoot, 'state.json'));
  const pagesInfo = await lstat(path.join(documentRoot, 'pages'));
  if (!stateInfo.isFile() || stateInfo.isSymbolicLink() || !pagesInfo.isDirectory() || pagesInfo.isSymbolicLink()) {
    throw new Error(`document tree state/pages shape is invalid: ${documentRoot}`);
  }
  const expectedPages = Array.from({ length: pageCount }, (_, index) => String(index + 1).padStart(4, '0'));
  const actualPages = (await readdir(path.join(documentRoot, 'pages'))).sort();
  if (!sameJson(actualPages, expectedPages)) {
    throw new Error(`document tree physical page directory set is not exactly 1..${pageCount}: ${documentRoot}`);
  }
  const shapes = new Map();
  for (const page of expectedPages) {
    const pageRoot = path.join(documentRoot, 'pages', page);
    const pageInfo = await lstat(pageRoot);
    if (!pageInfo.isDirectory() || pageInfo.isSymbolicLink()) {
      throw new Error(`document tree page is not a real directory: ${pageRoot}`);
    }
    const entries = (await readdir(pageRoot)).sort();
    if (!sameJson(entries, ['content.md', 'markdown', 'result.json'])) {
      throw new Error(`document tree page contains unexpected artifacts: ${pageRoot}`);
    }
    for (const name of ['content.md', 'result.json']) {
      const info = await lstat(path.join(pageRoot, name));
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`document page artifact is not a regular file: ${path.join(pageRoot, name)}`);
      }
    }
    const markdownRoot = path.join(pageRoot, 'markdown');
    const markdownInfo = await lstat(markdownRoot);
    if (!markdownInfo.isDirectory() || markdownInfo.isSymbolicLink()) {
      throw new Error(`document page Markdown mirror is not a real directory: ${markdownRoot}`);
    }
    const expectedMarkdownName = `page-${page}.md`;
    const markdownEntries = (await readdir(markdownRoot)).sort();
    const hasImages = markdownEntries.includes('imgs');
    const expectedMarkdownEntries = hasImages
      ? ['imgs', expectedMarkdownName]
      : [expectedMarkdownName];
    if (!sameJson(markdownEntries, expectedMarkdownEntries)) {
      throw new Error(`document page Markdown mirror contains unexpected artifacts: ${markdownRoot}`);
    }
    const markdownPath = path.join(markdownRoot, expectedMarkdownName);
    const markdownFileInfo = await lstat(markdownPath);
    if (!markdownFileInfo.isFile() || markdownFileInfo.isSymbolicLink()) {
      throw new Error(`document page Markdown mirror is not a regular file: ${markdownPath}`);
    }
    const markdownSha256 = await sha256File(markdownPath);
    const treeEntries = [`F\0${expectedMarkdownName}\0${markdownFileInfo.size}\0${markdownSha256}\n`];
    const assets = [];
    let treeFiles = 1;
    let treeBytes = markdownFileInfo.size;
    if (hasImages) {
      const imagesRoot = path.join(markdownRoot, 'imgs');
      const imagesInfo = await lstat(imagesRoot);
      if (!imagesInfo.isDirectory() || imagesInfo.isSymbolicLink()) {
        throw new Error(`document page Markdown image root is not a real directory: ${imagesRoot}`);
      }
      const imageEntries = (await readdir(imagesRoot)).sort();
      if (imageEntries.length === 0) {
        throw new Error(`document page Markdown image root is empty: ${imagesRoot}`);
      }
      treeEntries.push('D\0imgs\n');
      for (const name of imageEntries) {
        const match = paddleMarkdownAssetPattern.exec(name);
        if (!match) throw new Error(`document page Markdown asset name is not a pinned Paddle filename: ${name}`);
        const pathname = path.join(imagesRoot, name);
        const info = await lstat(pathname);
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new Error(`document page Markdown asset is not a regular file: ${pathname}`);
        }
        if (info.size === 0) throw new Error(`document page Markdown asset is empty: ${pathname}`);
        const digest = await sha256File(pathname);
        const bbox = match.slice(2).map(Number);
        if (!(bbox[0] < bbox[2] && bbox[1] < bbox[3])) {
          throw new Error(`document page Markdown asset has an invalid bounding box: ${name}`);
        }
        const relativePath = `imgs/${name}`;
        treeEntries.push(`F\0${relativePath}\0${info.size}\0${digest}\n`);
        treeFiles += 1;
        treeBytes += info.size;
        assets.push({
          name,
          path: pathname,
          relativePath,
          sha256: digest,
          bytes: info.size,
          blockType: match[1],
          blockLabel: paddleAssetLabels[match[1]],
          bbox,
        });
      }
    }
    shapes.set(Number(page), {
      markdownPath,
      markdownSha256,
      assets,
      markdownTree: {
        tree_sha256: sha256(treeEntries.join('')),
        files: treeFiles,
        bytes: treeBytes,
      },
    });
  }
  return shapes;
}

function validateRunIdentity(identity, shardManifest, manifestSha256) {
  requireObject(identity, 'run identity');
  if (identity.schema_version !== 1) throw new Error('run identity schema_version must equal 1');
  if (identity.manifest_sha256 !== manifestSha256) throw new Error('run identity manifest fingerprint mismatch');
  if (!sameJson(identity.runtime, shardManifest.runtime)) throw new Error('run identity runtime differs from shard manifest');
  requireObject(identity.runtime_fingerprint, 'run identity runtime_fingerprint');
  for (const [key, value] of Object.entries(shardManifest.runtime)) {
    if (identity.runtime_fingerprint[key] !== value) {
      throw new Error(`run identity runtime fingerprint differs for ${key}`);
    }
  }
  const runtimeFingerprintSha256 = sha256(`${JSON.stringify(identity.runtime_fingerprint)}\n`);
  if (identity.runtime_fingerprint_sha256 !== runtimeFingerprintSha256) {
    throw new Error('run identity runtime fingerprint SHA-256 mismatch');
  }
  requireObject(identity.llama_server_attestation, 'run identity llama_server_attestation');
  const attestationSha256 = sha256(`${JSON.stringify(identity.llama_server_attestation)}\n`);
  if (identity.llama_server_attestation_sha256 !== attestationSha256) {
    throw new Error('run identity llama-server attestation SHA-256 mismatch');
  }
  requireSha256(identity.runner_script_sha256, 'run identity runner_script_sha256');
  requireSha256(identity.ocr_script_sha256, 'run identity ocr_script_sha256');
  requireObject(identity.worker_configuration, 'run identity worker_configuration');
  const documentRecovery = requireObject(identity.document_recovery, 'run identity document_recovery');
  if (documentRecovery.max_attempts !== maxDocumentAttempts) {
    throw new Error(`run identity document_recovery.max_attempts must equal ${maxDocumentAttempts}`);
  }
  if (identity.whole_document_atomic !== true) throw new Error('run identity whole_document_atomic must equal true');
  if (identity.citation_allowed !== false) throw new Error('run identity citation_allowed must equal false');
  return identity;
}

function validateSeedAllowedDelta(receipt) {
  const predecessor = requireObject(receipt.predecessor, 'seed receipt predecessor');
  const successor = requireObject(receipt.successor, 'seed receipt successor');
  const predecessorWorker = requireObject(predecessor.worker_configuration, 'seed predecessor worker configuration');
  const successorWorker = requireObject(successor.worker_configuration, 'seed successor worker configuration');
  if (predecessor.runner_script_sha256 !== legacyB1RunnerScriptSha256) {
    throw new Error('seed predecessor is not bound to the exact B-r1 runner');
  }
  const keys = [
    'llama_url',
    'vl_rec_max_concurrency',
    'server_parallel',
    'micro_batch',
    'use_queues',
    'runtime_device',
    'paddlex_cache_home',
    'python_runtime',
    'paddlex_layout_model_cache_sha256',
  ].sort();
  if (!sameJson(Object.keys(predecessorWorker).sort(), keys)
    || !sameJson(Object.keys(successorWorker).sort(), keys)
    || predecessorWorker.vl_rec_max_concurrency !== 4
    || successorWorker.vl_rec_max_concurrency !== 1
    || predecessorWorker.server_parallel !== 4
    || successorWorker.server_parallel !== 4
    || predecessorWorker.micro_batch !== 16
    || successorWorker.micro_batch !== 16
    || predecessorWorker.use_queues !== true
    || successorWorker.use_queues !== true) {
    throw new Error('seed receipt worker configuration is outside the audited B-r1 to B-r2 delta');
  }
  for (const key of keys.filter((key) => !['vl_rec_max_concurrency', 'paddlex_cache_home'].includes(key))) {
    if (!sameJson(predecessorWorker[key], successorWorker[key])) {
      throw new Error(`seed receipt contains a forbidden worker delta for ${key}`);
    }
  }
  if (predecessorWorker.paddlex_cache_home !== successorWorker.paddlex_cache_home
    && predecessorWorker.paddlex_layout_model_cache_sha256 !== successorWorker.paddlex_layout_model_cache_sha256) {
    throw new Error('seed receipt cache path delta lacks an identical cache tree SHA-256');
  }
  const predecessorRecovery = structuredClone(requireObject(predecessor.document_recovery, 'seed predecessor recovery'));
  const successorRecovery = structuredClone(requireObject(successor.document_recovery, 'seed successor recovery'));
  if (predecessorRecovery.child_monitoring?.idle_timeout_seconds !== 300
    || successorRecovery.child_monitoring?.idle_timeout_seconds !== 1200) {
    throw new Error('seed receipt idle timeout delta is not 300 to 1200 seconds');
  }
  delete predecessorRecovery.child_monitoring.idle_timeout_seconds;
  delete successorRecovery.child_monitoring.idle_timeout_seconds;
  if (!sameJson(predecessorRecovery, successorRecovery)) {
    throw new Error('seed receipt recovery policy has deltas beyond the idle timeout');
  }
  const expectedDelta = {
    schema_version: 1,
    vl_rec_max_concurrency: { predecessor: 4, successor: 1 },
    paddlex_cache_home: {
      predecessor: predecessorWorker.paddlex_cache_home,
      successor: successorWorker.paddlex_cache_home,
      tree_sha256: successorWorker.paddlex_layout_model_cache_sha256,
    },
    child_idle_timeout_seconds: { predecessor: 300, successor: 1200 },
  };
  if (!sameJson(receipt.allowed_configuration_delta, expectedDelta)) {
    throw new Error('seed receipt allowed delta declaration is not exact');
  }
}

export function validateP4ToP1SeedDelta(receipt, predecessorIdentity, successorIdentity) {
  const delta = requireObject(receipt.allowed_configuration_delta, 'seed receipt allowed configuration delta');
  requireObject(predecessorIdentity, 'p4 predecessor identity');
  requireObject(successorIdentity, 'p1 successor identity');
  const predecessor = requireObject(receipt.predecessor, 'seed receipt predecessor');
  const successor = requireObject(receipt.successor, 'seed receipt successor');
  if (predecessorIdentity.runner_script_sha256 !== legacyB1RunnerScriptSha256
    || predecessor.runner_script_sha256 !== legacyB1RunnerScriptSha256
    || successorIdentity.runner_script_sha256 === legacyB1RunnerScriptSha256) {
    throw new Error('p4-to-p1 predecessor is not the exact legacy unseeded runner');
  }
  for (const [value, label] of [
    [predecessorIdentity.ocr_script_sha256, 'p4 OCR script SHA-256'],
    [successorIdentity.ocr_script_sha256, 'p1 OCR script SHA-256'],
    [successorIdentity.runner_script_sha256, 'p1 runner script SHA-256'],
  ]) requireSha256(value, label);
  const ocrScriptTransition = validateP4ToP1OcrScriptTransition(
    delta,
    predecessorIdentity.ocr_script_sha256,
    successorIdentity.ocr_script_sha256,
  );
  if (!sameJson(predecessor.runtime, predecessorIdentity.runtime)
    || !sameJson(predecessor.runtime_fingerprint, predecessorIdentity.runtime_fingerprint)
    || predecessor.runtime_fingerprint_sha256 !== predecessorIdentity.runtime_fingerprint_sha256
    || !sameJson(predecessor.worker_configuration, predecessorIdentity.worker_configuration)
    || !sameJson(predecessor.document_recovery, predecessorIdentity.document_recovery)
    || !sameJson(successor.runtime, successorIdentity.runtime)
    || !sameJson(successor.runtime_fingerprint, successorIdentity.runtime_fingerprint)
    || successor.runtime_fingerprint_sha256 !== successorIdentity.runtime_fingerprint_sha256
    || !sameJson(successor.worker_configuration, successorIdentity.worker_configuration)
    || !sameJson(successor.document_recovery, successorIdentity.document_recovery)
    || predecessor.ocr_script_sha256 !== predecessorIdentity.ocr_script_sha256
    || successor.ocr_script_sha256 !== successorIdentity.ocr_script_sha256
    || successor.runner_script_sha256 !== successorIdentity.runner_script_sha256) {
    throw new Error('p4-to-p1 receipt runtime controls differ from the raw identities');
  }
  if (!sameJson(predecessorIdentity.runtime, successorIdentity.runtime)
    || predecessorIdentity.input_root !== successorIdentity.input_root
    || predecessorIdentity.python_invocation_path !== successorIdentity.python_invocation_path
    || predecessorIdentity.python_resolved_target !== successorIdentity.python_resolved_target) {
    throw new Error('p4-to-p1 changes a forbidden model, DPI, input, or Python identity');
  }

  const predecessorHashes = requireRecomputedIdentityHashes(predecessorIdentity, 'p4 predecessor');
  const successorHashes = requireRecomputedIdentityHashes(successorIdentity, 'p1 successor');
  if (predecessorHashes.attestationSha256 === successorHashes.attestationSha256
    || predecessorHashes.runtimeFingerprintSha256 === successorHashes.runtimeFingerprintSha256) {
    throw new Error('p4-to-p1 must change the attestation and runtime fingerprint identities');
  }
  requireExactObjectKeys(
    predecessorHashes.runtimeFingerprint,
    successorHashes.runtimeFingerprint,
    'p4-to-p1 runtime fingerprint',
  );
  const predecessorRuntime = structuredClone(predecessorHashes.runtimeFingerprint);
  const successorRuntime = structuredClone(successorHashes.runtimeFingerprint);
  delete predecessorRuntime.llama_server_attestation_sha256;
  delete successorRuntime.llama_server_attestation_sha256;
  if (!sameJson(predecessorRuntime, successorRuntime)) {
    throw new Error('p4-to-p1 changes a forbidden runtime fingerprint field');
  }

  const predecessorAttestation = predecessorHashes.attestation;
  const successorAttestation = successorHashes.attestation;
  requireExactObjectKeys(predecessorAttestation, successorAttestation, 'p4-to-p1 llama attestation');
  if (predecessorAttestation.systemd_unit !== 'curriculum-ocr-llama.service'
    || successorAttestation.systemd_unit !== 'curriculum-ocr-llama.service'
    || predecessorAttestation.host !== '127.0.0.1'
    || successorAttestation.host !== '127.0.0.1'
    || predecessorAttestation.port !== 8112
    || successorAttestation.port !== 8112
    || predecessorAttestation.parallel !== 4
    || successorAttestation.parallel !== 1) {
    throw new Error('p4-to-p1 llama unit, host, port, or parallelism is invalid');
  }
  requireSha256(predecessorAttestation.proc_cmdline_sha256, 'p4 proc cmdline SHA-256');
  requireSha256(successorAttestation.proc_cmdline_sha256, 'p1 proc cmdline SHA-256');
  if (predecessorAttestation.proc_cmdline_sha256 === successorAttestation.proc_cmdline_sha256) {
    throw new Error('p4-to-p1 proc cmdline SHA-256 did not change');
  }
  const predecessorProduction = requireObject(
    predecessorAttestation.production_command_contract,
    'p4 production command contract',
  );
  const successorProduction = requireObject(
    successorAttestation.production_command_contract,
    'p1 production command contract',
  );
  requireExactObjectKeys(predecessorProduction, successorProduction, 'p4-to-p1 production command contract');
  const predecessorValues = requireObject(predecessorProduction.values, 'p4 production command values');
  const successorValues = requireObject(successorProduction.values, 'p1 production command values');
  const productionValueKeys = [
    '--batch-size',
    '--cache-type-k',
    '--cache-type-v',
    '--ctx-size',
    '--fit',
    '--flash-attn',
    '--host',
    '--n-gpu-layers',
    '--parallel',
    '--port',
    '--temp',
    '--threads',
    '--threads-batch',
    '--timeout',
    '--ubatch-size',
  ].sort();
  if (!sameJson(Object.keys(predecessorValues).sort(), productionValueKeys)
    || !sameJson(Object.keys(successorValues).sort(), productionValueKeys)
    || predecessorValues['--parallel'] !== '4'
    || successorValues['--parallel'] !== '1') {
    throw new Error('p4-to-p1 production command parallel declaration is invalid');
  }
  const expectedStableCommandValues = {
    '--host': '127.0.0.1',
    '--port': '8112',
    '--temp': '0',
    '--ctx-size': '32768',
    '--n-gpu-layers': 'all',
    '--flash-attn': 'auto',
    '--cache-type-k': 'f16',
    '--cache-type-v': 'f16',
    '--batch-size': '2048',
    '--ubatch-size': '512',
    '--fit': 'off',
    '--timeout': '3600',
    '--threads': '8',
    '--threads-batch': '16',
  };
  for (const [name, expected] of Object.entries(expectedStableCommandValues)) {
    if (predecessorValues[name] !== expected || successorValues[name] !== expected) {
      throw new Error(`p4-to-p1 changes forbidden production command value ${name}`);
    }
  }
  const expectedFlags = ['--mmproj-offload', '--cont-batching', '--no-webui', '--metrics'];
  if (!sameJson(predecessorProduction.flags, expectedFlags)
    || !sameJson(successorProduction.flags, expectedFlags)) {
    throw new Error('p4-to-p1 changes forbidden production command flags');
  }
  const predecessorAttestationStable = structuredClone(predecessorAttestation);
  const successorAttestationStable = structuredClone(successorAttestation);
  for (const value of [predecessorAttestationStable, successorAttestationStable]) {
    delete value.proc_cmdline_sha256;
    delete value.parallel;
    delete value.production_command_contract;
  }
  if (!sameJson(predecessorAttestationStable, successorAttestationStable)) {
    throw new Error('p4-to-p1 changes a forbidden llama-server attestation field');
  }

  const predecessorWorker = requireObject(predecessorIdentity.worker_configuration, 'p4 worker configuration');
  const successorWorker = requireObject(successorIdentity.worker_configuration, 'p1 worker configuration');
  const workerKeys = [
    'llama_url',
    'vl_rec_max_concurrency',
    'server_parallel',
    'micro_batch',
    'use_queues',
    'runtime_device',
    'paddlex_cache_home',
    'python_runtime',
    'paddlex_layout_model_cache_sha256',
  ].sort();
  if (!sameJson(Object.keys(predecessorWorker).sort(), workerKeys)
    || !sameJson(Object.keys(successorWorker).sort(), workerKeys)
    || predecessorWorker.vl_rec_max_concurrency !== 4
    || successorWorker.vl_rec_max_concurrency !== 1
    || predecessorWorker.server_parallel !== 4
    || successorWorker.server_parallel !== 1
    || predecessorWorker.micro_batch !== 16
    || successorWorker.micro_batch !== 16
    || predecessorWorker.use_queues !== true
    || successorWorker.use_queues !== true) {
    throw new Error('p4-to-p1 worker configuration is outside the exact concurrency delta');
  }
  requireCanonicalLoopback8112(predecessorWorker.llama_url, 'p4 llama URL');
  requireCanonicalLoopback8112(successorWorker.llama_url, 'p1 llama URL');
  for (const key of workerKeys.filter((value) => ![
    'vl_rec_max_concurrency',
    'server_parallel',
    'paddlex_cache_home',
  ].includes(value))) {
    if (!sameJson(predecessorWorker[key], successorWorker[key])) {
      throw new Error(`p4-to-p1 changes forbidden worker field ${key}`);
    }
  }
  if (predecessorWorker.paddlex_cache_home !== successorWorker.paddlex_cache_home
    && predecessorWorker.paddlex_layout_model_cache_sha256
      !== successorWorker.paddlex_layout_model_cache_sha256) {
    throw new Error('p4-to-p1 cache path changed without an identical cache tree SHA-256');
  }
  const predecessorRecovery = structuredClone(predecessorIdentity.document_recovery);
  const successorRecovery = structuredClone(successorIdentity.document_recovery);
  if (predecessorRecovery.child_monitoring?.idle_timeout_seconds !== 300
    || successorRecovery.child_monitoring?.idle_timeout_seconds !== 1200) {
    throw new Error('p4-to-p1 child idle timeout is not the exact 300-to-1200 transition');
  }
  delete predecessorRecovery.child_monitoring.idle_timeout_seconds;
  delete successorRecovery.child_monitoring.idle_timeout_seconds;
  if (!sameJson(predecessorRecovery, successorRecovery)) {
    throw new Error('p4-to-p1 changes a forbidden document recovery field');
  }

  const commonDelta = {
    vl_rec_max_concurrency: { predecessor: 4, successor: 1 },
    server_parallel: { predecessor: 4, successor: 1 },
    paddlex_cache_home: {
      predecessor: predecessorWorker.paddlex_cache_home,
      successor: successorWorker.paddlex_cache_home,
      tree_sha256: successorWorker.paddlex_layout_model_cache_sha256,
    },
    child_idle_timeout_seconds: { predecessor: 300, successor: 1200 },
    llama_server_attestation: {
      predecessor_sha256: predecessorHashes.attestationSha256,
      successor_sha256: successorHashes.attestationSha256,
      proc_cmdline_sha256: {
        predecessor: predecessorAttestation.proc_cmdline_sha256,
        successor: successorAttestation.proc_cmdline_sha256,
      },
      parallel: { predecessor: 4, successor: 1 },
      production_command_parallel: { predecessor: '4', successor: '1' },
    },
    runtime_fingerprint: {
      predecessor_sha256: predecessorHashes.runtimeFingerprintSha256,
      successor_sha256: successorHashes.runtimeFingerprintSha256,
    },
  };
  const expectedDelta = ocrScriptTransition ? {
    schema_version: 3,
    transition: p4ToP1SeedAwareOcrTransition,
    ocr_script_transition: ocrScriptTransition,
    ...commonDelta,
  } : {
    schema_version: 2,
    transition: p4ToP1Transition,
    ...commonDelta,
  };
  if (!sameJson(delta, expectedDelta)) {
    throw new Error('p4-to-p1 allowed configuration delta declaration is not exact');
  }
  return delta.transition;
}

function seedPredecessorDocument(record) {
  const {
    successor_document_tree: _successorDocumentTree,
    successor_state_sha256: _successorStateSha256,
    successor_status_sha256: _successorStatusSha256,
    timeout_recovery: _timeoutRecovery,
    ...predecessorDocument
  } = record;
  return predecessorDocument;
}

function timeoutRecoverySummary(grant, rawSha256, sidecarSha256) {
  return {
    grant_id: grant.grant_id,
    raw_sha256: rawSha256,
    sidecar_sha256: sidecarSha256,
    policy: grant.policy,
    documents: grant.documents,
  };
}

function timeoutRecoveryPredecessorClaimKey(grant) {
  return sha256(canonicalJson({
    schema_version: 1,
    claim_key_type: timeoutRecoveryPredecessorClaimKeyType,
    predecessor: grant.predecessor,
    policy: grant.policy,
    documents: grant.documents,
    citation_allowed: false,
  }));
}

function validateTimeoutRecoveryIncidentSummary(summaryValue, grantDocument) {
  const summary = requireObject(
    summaryValue,
    `${grantDocument.document_id} timeout recovery predecessor incident`,
  );
  const expectedRelativePath = `${seedPredecessorEvidenceDirectory}/timeout-incidents/${grantDocument.document_id}/attempt-0005.json`;
  if (!sameJson(Object.keys(summary).sort(), [
    'attempt',
    'citation_allowed',
    'document_id',
    'evidence_origin',
    'log_sha256',
    'path',
    'raw_sha256',
    'sidecar_path',
    'sidecar_sha256',
    'timeout_type',
  ].sort())
    || summary.document_id !== grantDocument.document_id
    || summary.attempt !== maxDocumentAttempts
    || summary.timeout_type !== 'idle_timeout'
    || !['runner_emitted_v1', 'legacy_status_log_derivation_v1'].includes(summary.evidence_origin)
    || summary.path !== expectedRelativePath
    || summary.sidecar_path !== `${expectedRelativePath}.sha256`
    || summary.log_sha256 !== grantDocument.timeout_log.sha256
    || summary.citation_allowed !== false) {
    throw new Error(`${grantDocument.document_id}: timeout recovery predecessor incident summary is invalid`);
  }
  requireSha256(summary.raw_sha256, `${grantDocument.document_id} timeout incident raw SHA-256`);
  requireSha256(summary.sidecar_sha256, `${grantDocument.document_id} timeout incident sidecar SHA-256`);
  return summary;
}

function validateTimeoutRecoveryIncidentValue({
  incident,
  summary,
  grantDocument,
  document,
  predecessorIdentity,
  predecessorStatus,
  logRaw,
}) {
  requireExactObjectKeyOrder(incident, [
    'schema_version',
    'incident_type',
    'evidence_origin',
    'document_id',
    'attempt',
    'timeout_type',
    'child_started_at',
    'detected_at',
    'recorded_at',
    'elapsed_seconds',
    'idle_seconds',
    'termination_signals',
    'monitoring_policy',
    'runtime_fingerprint_sha256',
    'log',
    'citation_allowed',
  ], `${document.id} timeout incident`);
  requireExactObjectKeys(incident, {
    schema_version: null,
    incident_type: null,
    evidence_origin: null,
    document_id: null,
    attempt: null,
    timeout_type: null,
    child_started_at: null,
    detected_at: null,
    recorded_at: null,
    elapsed_seconds: null,
    idle_seconds: null,
    termination_signals: null,
    monitoring_policy: null,
    runtime_fingerprint_sha256: null,
    log: null,
    citation_allowed: null,
  }, `${document.id} timeout incident`);
  const monitoring = requireObject(
    predecessorIdentity.document_recovery?.child_monitoring,
    `${document.id} predecessor child monitoring`,
  );
  requireExactObjectKeyOrder(incident.monitoring_policy, [
    'startup_timeout_seconds',
    'idle_timeout_seconds',
    'wall_floor_seconds',
    'wall_seconds_per_page',
    'terminate_grace_seconds',
    'poll_interval_seconds',
    'wall_timeout_seconds',
  ], `${document.id} timeout incident monitoring policy`);
  const expectedMonitoring = {
    ...monitoring,
    wall_timeout_seconds: Math.max(
      monitoring.wall_floor_seconds,
      monitoring.wall_seconds_per_page * document.page_count,
    ),
  };
  const startedAt = Date.parse(incident.child_started_at);
  const detectedAt = Date.parse(incident.detected_at);
  const recordedAt = Date.parse(incident.recorded_at);
  const quarantinedAt = Date.parse(predecessorStatus.quarantined_at);
  const expectedSignals = /^OCR child idle_timeout after [1-9]\d*s; terminated with SIGTERM then SIGKILL$/u.test(
    predecessorStatus.error,
  ) ? ['SIGTERM', 'SIGKILL'] : ['SIGTERM'];
  const expectedError = `OCR child ${incident.timeout_type} after ${incident.elapsed_seconds}s; terminated with ${incident.termination_signals.join(' then ')}`;
  const legacyDerived = incident.evidence_origin === 'legacy_status_log_derivation_v1';
  const legacySignalRows = logRaw.toString('utf8').match(/SignalInfo:\s*\*\*\* SIGTERM\b/gu) || [];
  if (incident.schema_version !== 1
    || incident.incident_type !== timeoutRecoveryIncidentType
    || !['runner_emitted_v1', 'legacy_status_log_derivation_v1'].includes(incident.evidence_origin)
    || incident.document_id !== document.id
    || incident.attempt !== maxDocumentAttempts
    || incident.timeout_type !== 'idle_timeout'
    || !Number.isFinite(startedAt)
    || !Number.isFinite(detectedAt)
    || !Number.isFinite(recordedAt)
    || !Number.isFinite(quarantinedAt)
    || new Date(startedAt).toISOString() !== incident.child_started_at
    || new Date(detectedAt).toISOString() !== incident.detected_at
    || new Date(recordedAt).toISOString() !== incident.recorded_at
    || new Date(quarantinedAt).toISOString() !== predecessorStatus.quarantined_at
    || detectedAt < startedAt
    || recordedAt < detectedAt
    || quarantinedAt < recordedAt
    || Math.abs(Math.floor((detectedAt - startedAt) / 1_000) - incident.elapsed_seconds) > 1
    || !Number.isSafeInteger(incident.elapsed_seconds)
    || incident.elapsed_seconds < 1
    || !Number.isSafeInteger(incident.idle_seconds)
    || incident.idle_seconds < 1
    || incident.idle_seconds < monitoring.idle_timeout_seconds
    || incident.idle_seconds > incident.elapsed_seconds
    || incident.elapsed_seconds >= expectedMonitoring.wall_timeout_seconds
    || !sameJson(incident.termination_signals, expectedSignals)
    || !sameJson(incident.monitoring_policy, expectedMonitoring)
    || incident.runtime_fingerprint_sha256 !== predecessorIdentity.runtime_fingerprint_sha256
    || incident.citation_allowed !== false
    || predecessorStatus.status !== 'quarantined'
    || predecessorStatus.attempt !== maxDocumentAttempts
    || predecessorStatus.error !== expectedError
    || (legacyDerived
      && (detectedAt !== recordedAt
        || recordedAt !== quarantinedAt
        || !sameJson(incident.termination_signals, ['SIGTERM'])
        || legacySignalRows.length !== maxDocumentAttempts
        || incident.idle_seconds !== incident.elapsed_seconds
        || incident.child_started_at
          !== new Date(quarantinedAt - incident.elapsed_seconds * 1_000).toISOString()))
    || summary.evidence_origin !== incident.evidence_origin) {
    throw new Error(`${document.id}: timeout incident does not prove the exact attempt-5 idle timeout`);
  }
  const log = requireObject(incident.log, `${document.id} timeout incident log`);
  requireExactObjectKeyOrder(log, ['path', 'bytes', 'sha256'], `${document.id} timeout incident log`);
  requireExactObjectKeys(log, { path: null, bytes: null, sha256: null }, `${document.id} timeout incident log`);
  if (log.path !== grantDocument.timeout_log.path
    || log.path !== `logs/${document.id}.log`
    || log.bytes !== logRaw.byteLength
    || log.sha256 !== sha256(logRaw)
    || log.sha256 !== grantDocument.timeout_log.sha256
    || summary.log_sha256 !== log.sha256) {
    throw new Error(`${document.id}: timeout incident log differs from grant, receipt, or raw bytes`);
  }
  return incident;
}

async function loadTimeoutRecoveryIssuance(
  shardRoot,
  receipt,
  lineage,
  timeoutRecovery,
  p4ToP1,
) {
  const summaryValue = receipt.timeout_recovery_issuance;
  const lineageDeclared = lineage.timeout_recovery_issuance_claim_key !== undefined
    || lineage.timeout_recovery_issuance_sha256 !== undefined;
  const issuanceRoot = path.join(shardRoot, timeoutRecoveryIssuanceDirectory);
  const issuanceRootInfo = await lstatIfPresent(issuanceRoot);
  if (!timeoutRecovery) {
    if (summaryValue !== undefined || lineageDeclared || issuanceRootInfo) {
      throw new Error('seed without timeout recovery unexpectedly contains issuance evidence');
    }
    for (const document of receipt.documents) {
      if (document?.timeout_recovery?.predecessor_incident !== undefined) {
        throw new Error(`${document.document_id || 'unknown'}: no-grant seed contains a predecessor incident summary`);
      }
    }
    return null;
  }
  if (!p4ToP1) {
    throw new Error('timeout recovery is permitted only for an audited p4-to-p1 transition');
  }
  if (!summaryValue || !lineageDeclared || !issuanceRootInfo) {
    throw new Error('audited timeout recovery seed is missing its issuance evidence');
  }
  if (!issuanceRootInfo.isDirectory() || issuanceRootInfo.isSymbolicLink()
    || await realpath(issuanceRoot) !== issuanceRoot) {
    throw new Error('timeout recovery issuance root must be a real directory');
  }
  const summary = requireObject(summaryValue, 'timeout recovery issuance summary');
  if (!sameJson(Object.keys(summary).sort(), [
    'citation_allowed',
    'claim_key',
    'ledger_id',
    'path',
    'raw_sha256',
    'schema_version',
    'sidecar_path',
    'sidecar_sha256',
  ].sort())
    || summary.schema_version !== 1
    || summary.citation_allowed !== false) {
    throw new Error('timeout recovery issuance summary field set is invalid');
  }
  const claimKey = timeoutRecoveryPredecessorClaimKey(timeoutRecovery.grant);
  const basename = `${claimKey}.issuance.json`;
  const relativePath = `${timeoutRecoveryIssuanceDirectory}/${basename}`;
  if (summary.claim_key !== claimKey
    || summary.ledger_id !== timeoutRecovery.grant.consumption.ledger_id
    || summary.path !== relativePath
    || summary.sidecar_path !== `${relativePath}.sha256`
    || lineage.timeout_recovery_issuance_claim_key !== claimKey
    || lineage.timeout_recovery_issuance_sha256 !== summary.raw_sha256) {
    throw new Error('timeout recovery issuance summary is not canonically bound to the grant and lineage');
  }
  requireSha256(summary.raw_sha256, 'timeout recovery issuance raw SHA-256');
  requireSha256(summary.sidecar_sha256, 'timeout recovery issuance sidecar SHA-256');
  const entries = await readdir(issuanceRoot, { withFileTypes: true });
  const expectedEntries = [basename, `${basename}.sha256`];
  if (!sameJson(entries.map((entry) => entry.name).sort(), expectedEntries.sort())
    || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('timeout recovery issuance root has missing or extra entries');
  }
  const pathname = path.join(issuanceRoot, basename);
  const evidence = await readCanonicalAuthorityJsonWithVerifiedSidecar(
    pathname,
    'timeout recovery issuance claim',
  );
  requireCanonicalPrettyJson(evidence, 'timeout recovery issuance claim');
  const claim = requireObject(evidence.value, 'timeout recovery issuance claim');
  requireExactObjectKeyOrder(claim, [
    'schema_version',
    'claim_type',
    'claim_key',
    'ledger_id',
    'predecessor',
    'grant_id',
    'grant_raw_sha256',
    'incident_evidence',
    'citation_allowed',
  ], 'timeout recovery issuance claim');
  requireExactObjectKeyOrder(claim.predecessor, [
    'manifest_sha256', 'run_identity_sha256', 'run_status_sha256',
  ], 'timeout recovery issuance predecessor');
  for (const incidentEvidence of claim.incident_evidence || []) {
    requireExactObjectKeyOrder(incidentEvidence, [
      'document_id', 'attempt', 'timeout_type', 'raw_sha256', 'sidecar_sha256', 'log_sha256',
    ], 'timeout recovery issuance incident evidence');
  }
  if (evidence.digest !== summary.raw_sha256
    || sha256(evidence.sidecarRaw) !== summary.sidecar_sha256) {
    throw new Error('timeout recovery issuance raw or sidecar differs from the receipt summary');
  }
  if (!sameJson(Object.keys(claim).sort(), [
    'citation_allowed',
    'claim_key',
    'claim_type',
    'grant_id',
    'grant_raw_sha256',
    'incident_evidence',
    'ledger_id',
    'predecessor',
    'schema_version',
  ].sort())
    || claim.schema_version !== 1
    || claim.claim_type !== timeoutRecoveryIssuanceClaimType
    || claim.claim_key !== claimKey
    || claim.ledger_id !== summary.ledger_id
    || !sameJson(claim.predecessor, timeoutRecovery.grant.predecessor)
    || claim.grant_id !== timeoutRecovery.grant.grant_id
    || claim.grant_raw_sha256 !== timeoutRecovery.rawSha256
    || claim.citation_allowed !== false
    || !Array.isArray(claim.incident_evidence)) {
    throw new Error('timeout recovery issuance claim is not bound to the exact grant');
  }
  const receiptDocuments = new Map(receipt.documents.map((document) => [document.document_id, document]));
  const expectedIncidents = timeoutRecovery.grant.documents.map((grantDocument) => {
    const receiptDocument = receiptDocuments.get(grantDocument.document_id);
    const incident = validateTimeoutRecoveryIncidentSummary(
      receiptDocument?.timeout_recovery?.predecessor_incident,
      grantDocument,
    );
    return {
      document_id: grantDocument.document_id,
      attempt: incident.attempt,
      timeout_type: incident.timeout_type,
      raw_sha256: incident.raw_sha256,
      sidecar_sha256: incident.sidecar_sha256,
      log_sha256: incident.log_sha256,
    };
  });
  if (!sameJson(claim.incident_evidence, expectedIncidents)) {
    throw new Error('timeout recovery issuance incident set or order differs from receipt documents');
  }
  return {
    root: issuanceRoot,
    path: pathname,
    sidecarPath: `${pathname}.sha256`,
    raw: evidence.raw,
    sidecarRaw: evidence.sidecarRaw,
    rawSha256: evidence.digest,
    sidecarSha256: sha256(evidence.sidecarRaw),
    claim,
    summary,
    incidents: expectedIncidents,
  };
}

function timeoutRecoveryReceiptDocument(record) {
  return record?.timeout_recovery || null;
}

function validateSeedTreeFingerprint(value, label) {
  const tree = requireObject(value, label);
  requireSha256(tree.tree_sha256, `${label}.tree_sha256`);
  if (!Number.isSafeInteger(tree.files) || tree.files < 0
    || !Number.isSafeInteger(tree.bytes) || tree.bytes < 0) {
    throw new Error(`${label} file or byte count is invalid`);
  }
  return tree;
}

function validateTimeoutRecoveryGrantShape(grant, manifestSha256) {
  requireObject(grant, 'timeout recovery grant');
  requireExactObjectKeyOrder(grant, [
    'schema_version',
    'grant_type',
    'mode',
    'grant_id',
    'predecessor',
    'policy',
    'consumption',
    'documents',
    'citation_allowed',
  ], 'timeout recovery grant');
  const expectedGrantKeys = [
    'citation_allowed',
    'consumption',
    'documents',
    'grant_id',
    'grant_type',
    'mode',
    'policy',
    'predecessor',
    'schema_version',
  ].sort();
  if (!sameJson(Object.keys(grant).sort(), expectedGrantKeys)
    || grant.schema_version !== 1
    || grant.grant_type !== timeoutRecoveryGrantType
    || grant.mode !== timeoutRecoveryGrantMode
    || grant.citation_allowed !== false
    || !Array.isArray(grant.documents)
    || grant.documents.length === 0) {
    throw new Error('timeout recovery grant identity is invalid');
  }
  const { grant_id: _grantId, ...grantBasis } = grant;
  const computedGrantId = sha256(canonicalJson(grantBasis));
  if (grant.grant_id !== computedGrantId) {
    throw new Error('timeout recovery grant ID does not match its canonical basis');
  }
  const predecessor = requireObject(grant.predecessor, 'timeout recovery grant predecessor');
  requireExactObjectKeyOrder(predecessor, [
    'manifest_sha256', 'run_identity_sha256', 'run_status_sha256',
  ], 'timeout recovery grant predecessor');
  if (!sameJson(
    Object.keys(predecessor).sort(),
    ['manifest_sha256', 'run_identity_sha256', 'run_status_sha256'].sort(),
  ) || predecessor.manifest_sha256 !== manifestSha256) {
    throw new Error('timeout recovery grant manifest differs from the shard manifest');
  }
  for (const [key, value] of Object.entries({
    run_identity_sha256: predecessor.run_identity_sha256,
    run_status_sha256: predecessor.run_status_sha256,
  })) requireSha256(value, `timeout recovery grant predecessor.${key}`);
  const expectedPolicy = {
    required_status: 'quarantined',
    required_inherited_attempts: 5,
    granted_attempt: 6,
    additional_attempts_per_document: 1,
    automatic_attempt_7: false,
    scope: 'all_timeout_quarantined_documents',
  };
  requireExactObjectKeyOrder(grant.policy, Object.keys(expectedPolicy), 'timeout recovery grant policy');
  if (canonicalJson(grant.policy) !== canonicalJson(expectedPolicy)) {
    throw new Error('timeout recovery grant policy is not the one-attempt fail-closed contract');
  }
  const consumption = requireObject(grant.consumption, 'timeout recovery grant consumption');
  requireExactObjectKeyOrder(consumption, [
    'ledger_id', 'ledger_root', 'ledger_device', 'ledger_inode', 'claim_mode',
  ], 'timeout recovery grant consumption');
  if (!sameJson(Object.keys(consumption).sort(), [
    'claim_mode',
    'ledger_device',
    'ledger_id',
    'ledger_inode',
    'ledger_root',
  ].sort())
    || consumption.claim_mode !== timeoutRecoveryClaimMode
    || typeof consumption.ledger_root !== 'string'
    || !path.isAbsolute(consumption.ledger_root)
    || !/^\d+$/u.test(consumption.ledger_device)
    || !/^\d+$/u.test(consumption.ledger_inode)) {
    throw new Error('timeout recovery grant consumption policy is invalid');
  }
  requireSha256(consumption.ledger_id, 'timeout recovery grant consumption ledger ID');
  const documentIds = grant.documents.map((document) => document?.document_id);
  if (new Set(documentIds).size !== documentIds.length) {
    throw new Error('timeout recovery grant contains duplicate documents');
  }
  for (const value of grant.documents) {
    const document = requireObject(value, 'timeout recovery grant document');
    requireExactObjectKeyOrder(document, [
      'document_id',
      'predecessor_status_sha256',
      'predecessor_state_sha256',
      'inherited_attempts',
      'granted_attempt',
      'first_missing_page',
      'completed_pages_sha256',
      'failed_pages_sha256',
      'quarantine_reason',
      'error_sha256',
      'classification',
      'timeout_log',
    ], `${document.document_id || 'unknown'} timeout recovery grant document`);
    const expectedDocumentKeys = [
      'classification',
      'completed_pages_sha256',
      'document_id',
      'error_sha256',
      'failed_pages_sha256',
      'first_missing_page',
      'granted_attempt',
      'inherited_attempts',
      'predecessor_state_sha256',
      'predecessor_status_sha256',
      'quarantine_reason',
      'timeout_log',
    ].sort();
    if (!sameJson(Object.keys(document).sort(), expectedDocumentKeys)
      || !documentIdPattern.test(String(document.document_id || ''))
      || document.inherited_attempts !== 5
      || document.granted_attempt !== 6
      || !Number.isSafeInteger(document.first_missing_page)
      || document.first_missing_page < 1
      || document.quarantine_reason !== 'attempt_budget_exhausted'
      || document.classification !== 'child_idle_timeout_only') {
      throw new Error(`${document.document_id || 'unknown'}: timeout recovery grant document is invalid`);
    }
    for (const [key, digest] of Object.entries({
      predecessor_status_sha256: document.predecessor_status_sha256,
      predecessor_state_sha256: document.predecessor_state_sha256,
      completed_pages_sha256: document.completed_pages_sha256,
      failed_pages_sha256: document.failed_pages_sha256,
      error_sha256: document.error_sha256,
    })) requireSha256(digest, `${document.document_id} timeout recovery ${key}`);
    const log = requireObject(document.timeout_log, `${document.document_id} timeout recovery log`);
    requireExactObjectKeyOrder(
      log,
      ['path', 'bytes', 'sha256'],
      `${document.document_id} timeout recovery log`,
    );
    if (!sameJson(Object.keys(log).sort(), ['bytes', 'path', 'sha256'])
      || log.path !== `logs/${document.document_id}.log`
      || !Number.isSafeInteger(log.bytes)
      || log.bytes < 0) {
      throw new Error(`${document.document_id}: timeout recovery log path or size is invalid`);
    }
    requireSha256(log.sha256, `${document.document_id} timeout recovery log sha256`);
  }
  return grant;
}

async function loadTimeoutRecoveryGrant(shardRoot, receipt, lineage, manifestSha256) {
  const grantPath = path.join(shardRoot, timeoutRecoveryGrantFilename);
  const receiptSummary = receipt.timeout_recovery_grant;
  const hasDeclaredGrant = receiptSummary !== undefined
    || lineage.timeout_recovery_grant_id !== undefined
    || lineage.timeout_recovery_grant_sha256 !== undefined
    || lineage.timeout_recovery_documents !== undefined;
  const hasGrantFile = await exists(grantPath);
  const hasGrantSidecar = await exists(`${grantPath}.sha256`);
  if (!hasDeclaredGrant) {
    if (hasGrantFile || hasGrantSidecar) {
      throw new Error('seed without timeout recovery lineage unexpectedly contains grant evidence');
    }
    return null;
  }
  if (!hasGrantFile || !hasGrantSidecar) {
    throw new Error('timeout recovery seed is missing its raw grant or sidecar');
  }
  const evidence = await readCanonicalAuthorityJsonWithVerifiedSidecar(
    grantPath,
    'timeout recovery grant',
  );
  requireCanonicalPrettyJson(evidence, 'timeout recovery grant');
  const grant = validateTimeoutRecoveryGrantShape(evidence.value, manifestSha256);
  const sidecarSha256 = sha256(evidence.sidecarRaw);
  const expectedSummary = timeoutRecoverySummary(grant, evidence.digest, sidecarSha256);
  const grantIds = grant.documents.map((document) => document.document_id);
  if (canonicalJson(receiptSummary) !== canonicalJson(expectedSummary)
    || lineage.timeout_recovery_grant_id !== grant.grant_id
    || lineage.timeout_recovery_grant_sha256 !== evidence.digest
    || !sameJson(lineage.timeout_recovery_documents, grantIds)) {
    throw new Error('timeout recovery grant differs from the seed receipt or identity lineage');
  }
  return {
    path: grantPath,
    sidecarPath: `${grantPath}.sha256`,
    raw: evidence.raw,
    sidecarRaw: evidence.sidecarRaw,
    rawSha256: evidence.digest,
    sidecarSha256,
    grant,
    summary: expectedSummary,
  };
}

async function loadTimeoutRecoveryConsumption(shardRoot, receipt, lineage, timeoutRecovery) {
  const ledgerPath = path.join(shardRoot, timeoutRecoveryLedgerIdentityFilename);
  const claimPath = path.join(shardRoot, timeoutRecoveryClaimFilename);
  const declared = receipt.timeout_recovery_consumption !== undefined
    || lineage.timeout_recovery_ledger_id !== undefined
    || lineage.timeout_recovery_claim_sha256 !== undefined;
  const evidencePresent = (await exists(ledgerPath))
    || (await exists(`${ledgerPath}.sha256`))
    || (await exists(claimPath))
    || (await exists(`${claimPath}.sha256`));
  if (!timeoutRecovery) {
    if (declared || evidencePresent) {
      throw new Error('seed without timeout recovery unexpectedly contains consumption evidence');
    }
    return null;
  }
  if (!declared || !await exists(ledgerPath) || !await exists(`${ledgerPath}.sha256`)
    || !await exists(claimPath) || !await exists(`${claimPath}.sha256`)) {
    throw new Error('timeout recovery seed is missing its immutable consumption witness');
  }
  const [ledgerEvidence, claimEvidence] = await Promise.all([
    readCanonicalAuthorityJsonWithVerifiedSidecar(ledgerPath, 'timeout recovery ledger identity'),
    readCanonicalAuthorityJsonWithVerifiedSidecar(claimPath, 'timeout recovery consumption claim'),
  ]);
  requireCanonicalPrettyJson(ledgerEvidence, 'timeout recovery ledger identity');
  requireCanonicalPrettyJson(claimEvidence, 'timeout recovery consumption claim');
  const ledger = requireObject(ledgerEvidence.value, 'timeout recovery ledger identity');
  requireExactObjectKeyOrder(ledger, [
    'schema_version', 'ledger_type', 'ledger_nonce', 'ledger_id', 'citation_allowed',
  ], 'timeout recovery ledger identity');
  const expectedLedgerKeys = [
    'citation_allowed',
    'ledger_id',
    'ledger_nonce',
    'ledger_type',
    'schema_version',
  ].sort();
  const { ledger_id: _ledgerId, ...ledgerBasis } = ledger;
  if (!sameJson(Object.keys(ledger).sort(), expectedLedgerKeys)
    || ledger.schema_version !== 1
    || ledger.ledger_type !== timeoutRecoveryLedgerType
    || ledger.citation_allowed !== false
    || ledger.ledger_id !== sha256(canonicalJson(ledgerBasis))) {
    throw new Error('timeout recovery ledger identity is invalid');
  }
  requireSha256(ledger.ledger_nonce, 'timeout recovery ledger nonce');
  requireSha256(ledger.ledger_id, 'timeout recovery ledger ID');
  const claim = requireObject(claimEvidence.value, 'timeout recovery consumption claim');
  requireExactObjectKeyOrder(claim, [
    'schema_version',
    'claim_type',
    'claim_mode',
    'ledger_id',
    'ledger_root',
    'ledger_device',
    'ledger_inode',
    'grant_id',
    'grant_raw_sha256',
    'predecessor',
    'granted_documents',
    'successor',
    'citation_allowed',
  ], 'timeout recovery consumption claim');
  const expectedClaimKeys = [
    'citation_allowed',
    'claim_mode',
    'claim_type',
    'grant_id',
    'grant_raw_sha256',
    'granted_documents',
    'ledger_device',
    'ledger_id',
    'ledger_inode',
    'ledger_root',
    'predecessor',
    'schema_version',
    'successor',
  ].sort();
  const expectedGrantedDocuments = timeoutRecovery.grant.documents.map((document) => ({
    document_id: document.document_id,
    predecessor_status_sha256: document.predecessor_status_sha256,
    predecessor_state_sha256: document.predecessor_state_sha256,
    inherited_attempts: document.inherited_attempts,
    granted_attempt: document.granted_attempt,
  }));
  requireExactObjectKeyOrder(claim.predecessor, [
    'manifest_sha256', 'run_identity_sha256', 'run_status_sha256',
  ], 'timeout recovery consumption predecessor');
  for (const grantedDocument of claim.granted_documents || []) {
    requireExactObjectKeyOrder(grantedDocument, [
      'document_id',
      'predecessor_status_sha256',
      'predecessor_state_sha256',
      'inherited_attempts',
      'granted_attempt',
    ], 'timeout recovery consumption granted document');
  }
  const successor = requireObject(claim.successor, 'timeout recovery consumption successor');
  requireExactObjectKeyOrder(successor, [
    'seed_id', 'output_root', 'output_device', 'output_inode',
  ], 'timeout recovery consumption successor');
  const [canonicalShardRoot, shardRootInfo] = await Promise.all([
    realpath(shardRoot),
    stat(shardRoot, { bigint: true }),
  ]);
  if (!sameJson(Object.keys(claim).sort(), expectedClaimKeys)
    || claim.schema_version !== 1
    || claim.claim_type !== timeoutRecoveryClaimType
    || claim.claim_mode !== timeoutRecoveryClaimMode
    || claim.ledger_id !== ledger.ledger_id
    || claim.ledger_id !== timeoutRecovery.grant.consumption.ledger_id
    || claim.ledger_root !== timeoutRecovery.grant.consumption.ledger_root
    || claim.ledger_device !== timeoutRecovery.grant.consumption.ledger_device
    || claim.ledger_inode !== timeoutRecovery.grant.consumption.ledger_inode
    || claim.grant_id !== timeoutRecovery.grant.grant_id
    || claim.grant_raw_sha256 !== timeoutRecovery.rawSha256
    || !sameJson(claim.predecessor, timeoutRecovery.grant.predecessor)
    || !sameJson(claim.granted_documents, expectedGrantedDocuments)
    || claim.citation_allowed !== false
    || !sameJson(Object.keys(successor).sort(), [
      'output_device',
      'output_inode',
      'output_root',
      'seed_id',
    ])
    || successor.seed_id !== lineage.seed_id
    || successor.output_root !== canonicalShardRoot
    || successor.output_device !== String(shardRootInfo.dev)
    || successor.output_inode !== String(shardRootInfo.ino)) {
    throw new Error('timeout recovery consumption claim is not bound to the exact grant and seed');
  }
  const ledgerSidecarSha256 = sha256(ledgerEvidence.sidecarRaw);
  const claimSidecarSha256 = sha256(claimEvidence.sidecarRaw);
  const summary = {
    ledger_id: ledger.ledger_id,
    ledger_identity_sha256: ledgerEvidence.digest,
    ledger_identity_sidecar_sha256: ledgerSidecarSha256,
    claim_mode: timeoutRecoveryClaimMode,
    claim_sha256: claimEvidence.digest,
    claim_sidecar_sha256: claimSidecarSha256,
  };
  if (canonicalJson(receipt.timeout_recovery_consumption) !== canonicalJson(summary)
    || lineage.timeout_recovery_ledger_id !== ledger.ledger_id
    || lineage.timeout_recovery_claim_sha256 !== claimEvidence.digest) {
    throw new Error('timeout recovery consumption witness differs from seed lineage');
  }
  return {
    ledgerPath,
    ledgerSidecarPath: `${ledgerPath}.sha256`,
    ledger,
    ledgerRaw: ledgerEvidence.raw,
    ledgerSidecarRaw: ledgerEvidence.sidecarRaw,
    ledgerSha256: ledgerEvidence.digest,
    ledgerSidecarSha256,
    claimPath,
    claimSidecarPath: `${claimPath}.sha256`,
    claim,
    claimRaw: claimEvidence.raw,
    claimSidecarRaw: claimEvidence.sidecarRaw,
    claimSha256: claimEvidence.digest,
    claimSidecarSha256,
    summary,
  };
}

function validateSeedReceiptDocumentShape(
  record,
  document,
  predecessorRunnerScriptSha256,
  timeoutRecoveryDocument = null,
) {
  const completedPages = record.completed_pages;
  if (record.page_count !== document.page_count
    || ![
      'complete',
      'interrupted',
      'pending',
      'quarantined',
      'retry_wait',
    ].includes(record.predecessor_status)
    || !Number.isSafeInteger(record.inherited_attempts)
    || record.inherited_attempts < 0
    || record.inherited_attempts > 5
    || !Array.isArray(completedPages)
    || !sameJson([...completedPages].sort((left, right) => left - right), completedPages)
    || new Set(completedPages).size !== completedPages.length
    || completedPages.some((page) => !Number.isSafeInteger(page) || page < 1 || page > document.page_count)
    || !Array.isArray(record.failed_pages)
    || record.failed_pages.length !== 0
    || !Array.isArray(record.inherited_page_artifacts)
    || record.inherited_page_artifacts.length !== completedPages.length
    || record.inherited_page_artifacts_sha256 !== sha256(canonicalJson(record.inherited_page_artifacts))) {
    throw new Error(`${document.id}: seed receipt document lineage is invalid`);
  }
  requireSha256(
    record.predecessor_configuration_sha256,
    `${document.id} predecessor_configuration_sha256`,
  );
  if (record.predecessor_status === 'pending') {
    if (record.predecessor_status_format !== 'pending_no_status'
      || record.inherited_attempts !== 0
      || completedPages.length !== 0
      || record.predecessor_document_tree !== null
      || record.predecessor_pages_tree !== null
      || record.predecessor_state_sha256 !== null
      || record.predecessor_status_sha256 !== null
      || record.predecessor_status_sidecar_sha256 !== null
      || record.successor_document_tree !== null
      || record.successor_state_sha256 !== null
      || record.successor_status_sha256 !== null) {
      throw new Error(`${document.id}: pending seed receipt shape is invalid`);
    }
  } else {
    if (record.inherited_attempts < 1
      || ![
        'complete_identity_v1',
        'legacy_b1_complete_reverified',
        'legacy_b1_interrupted',
        'timeout_only_quarantine_granted_v1',
      ].includes(record.predecessor_status_format)) {
      throw new Error(`${document.id}: attempted seed receipt status format is invalid`);
    }
    if (record.predecessor_status_format === 'legacy_b1_complete_reverified'
      && (record.predecessor_status !== 'complete'
        || predecessorRunnerScriptSha256 !== legacyB1RunnerScriptSha256)) {
      throw new Error(`${document.id}: legacy complete status format is not bound to B-r1`);
    }
    if (record.predecessor_status_format === 'legacy_b1_interrupted'
      && (record.predecessor_status !== 'interrupted'
        || predecessorRunnerScriptSha256 !== legacyB1RunnerScriptSha256)) {
      throw new Error(`${document.id}: legacy interrupted status format is not bound to B-r1`);
    }
    if (record.predecessor_status_format === 'timeout_only_quarantine_granted_v1'
      && (record.predecessor_status !== 'quarantined'
        || record.inherited_attempts !== 5
        || predecessorRunnerScriptSha256 !== legacyB1RunnerScriptSha256
        || !timeoutRecoveryDocument)) {
      throw new Error(`${document.id}: legacy timeout quarantine is not bound to an exact recovery grant`);
    }
    validateSeedTreeFingerprint(record.predecessor_document_tree, `${document.id} predecessor document tree`);
    validateSeedTreeFingerprint(record.predecessor_pages_tree, `${document.id} predecessor pages tree`);
    validateSeedTreeFingerprint(record.successor_document_tree, `${document.id} successor document tree`);
    for (const [key, value] of Object.entries({
      predecessor_state_sha256: record.predecessor_state_sha256,
      predecessor_status_sha256: record.predecessor_status_sha256,
      predecessor_status_sidecar_sha256: record.predecessor_status_sidecar_sha256,
      successor_state_sha256: record.successor_state_sha256,
      successor_status_sha256: record.successor_status_sha256,
    })) requireSha256(value, `${document.id} ${key}`);
    if (record.predecessor_status === 'complete' && completedPages.length !== document.page_count) {
      throw new Error(`${document.id}: complete predecessor does not cover the whole document`);
    }
    if (record.predecessor_status !== 'complete' && completedPages.length >= document.page_count) {
      throw new Error(`${document.id}: incomplete predecessor unexpectedly covers the whole document`);
    }
  }
  const artifactPages = record.inherited_page_artifacts.map((page) => page?.physical_pdf_page);
  if (!sameJson(artifactPages, completedPages) || new Set(artifactPages).size !== artifactPages.length) {
    throw new Error(`${document.id}: inherited page artifact sequence differs from completed_pages`);
  }
  if (timeoutRecoveryDocument) {
    const expectedRecovery = {
      grant_id: timeoutRecoveryDocument.grant_id,
      grant_raw_sha256: timeoutRecoveryDocument.grant_raw_sha256,
      granted_attempt: 6,
      first_missing_page: timeoutRecoveryDocument.first_missing_page,
      predecessor_log: {
        ...timeoutRecoveryDocument.predecessor_log,
        path: `${seedPredecessorEvidenceDirectory}/${timeoutRecoveryDocument.predecessor_log.path}`,
      },
      predecessor_incident: timeoutRecoveryDocument.predecessor_incident,
    };
    if (!sameJson(record.timeout_recovery, expectedRecovery)
      || !sameJson(record.timeout_log, timeoutRecoveryDocument.timeout_log)) {
      throw new Error(`${document.id}: timeout recovery receipt summary is invalid`);
    }
  } else if (record.timeout_recovery !== undefined
    || record.timeout_log !== undefined
    || record.predecessor_status === 'quarantined') {
    throw new Error(`${document.id}: quarantine lineage exists without an exact timeout recovery grant`);
  }
  return completedPages;
}

function evidenceEntryPath(entry, expectedType) {
  if (expectedType === 'directory') {
    const match = /^D\0([^\n]+)\n$/u.exec(entry);
    if (!match) return null;
    return match[1].split(path.sep).join('/');
  }
  const match = /^F\0([^\0\n]+)\0(\d+)\0([a-f0-9]{64})\n$/u.exec(entry);
  if (!match) return null;
  return match[1].split(path.sep).join('/');
}

function prefixTreeEntry(entry, prefix) {
  const directory = /^D\0([^\n]+)\n$/u.exec(entry);
  if (directory) return `D\0${prefix}/${directory[1]}\n`;
  const file = /^F\0([^\0\n]+)\0(\d+)\0([a-f0-9]{64})\n$/u.exec(entry);
  if (!file) throw new Error('seed predecessor tree inventory contains an invalid entry');
  return `F\0${prefix}/${file[1]}\0${file[2]}\0${file[3]}\n`;
}

function treeFingerprint(entries, files, bytes) {
  return { tree_sha256: sha256(entries.join('')), files, bytes };
}

function requireEvidenceFileRecord(value, expectedPath, label) {
  const record = requireObject(value, label);
  if (record.path !== expectedPath
    || !Number.isSafeInteger(record.bytes)
    || record.bytes < 0) {
    throw new Error(`${label} path or byte count is invalid`);
  }
  requireSha256(record.sha256, `${label}.sha256`);
  return record;
}

function expectedSeedStateConfiguration(runtime, worker) {
  const pythonRuntime = requireObject(worker.python_runtime, 'seed predecessor Python runtime');
  const packages = requireObject(pythonRuntime.packages, 'seed predecessor Python packages');
  return {
    pipeline: runtime.pipeline,
    pipeline_version: runtime.pipeline_version,
    layout_model: 'PP-DocLayoutV3',
    recognizer: 'PaddleOCR-VL-1.6-0.9B official GGUF',
    recognizer_backend: 'llama-cpp-server',
    recognizer_server_url: worker.llama_url,
    dpi: runtime.render_dpi,
    device: worker.runtime_device,
    python: pythonRuntime.python_version,
    paddlepaddle: packages.paddlepaddle,
    paddleocr: packages.paddleocr,
    paddlex: packages.paddlex,
    vl_rec_max_concurrency: worker.vl_rec_max_concurrency,
    server_parallel: worker.server_parallel,
    micro_batch: worker.micro_batch,
    use_queues: worker.use_queues,
  };
}

function classifyRawB1Status(identity, progress, status, statusSha256, document) {
  if (progress.status_json_sha256 !== statusSha256
    || status.schema_version !== 1
    || status.document_id !== document.id
    || status.status !== progress.status
    || status.citation_allowed !== false) {
    throw new Error(`${document.id}: raw predecessor status identity mismatch`);
  }
  const keys = Object.keys(status).sort();
  const retryWaitKeys = [
    'attempt',
    'citation_allowed',
    'document_id',
    'error',
    'failed_at',
    'max_attempts',
    'next_retry_at',
    'page_count',
    'retry_delay_seconds',
    'runtime_fingerprint_sha256',
    'schema_version',
    'status',
  ].sort();
  if (progress.status === 'retry_wait'
    && sameJson(keys, retryWaitKeys)
    && status.attempt === progress.attempts
    && status.max_attempts === 5
    && status.page_count === document.page_count
    && status.runtime_fingerprint_sha256 === identity.runtime_fingerprint_sha256
    && status.next_retry_at === progress.next_retry_at
    && status.error === progress.error
    && status.failed_at === progress.failed_at
    && [2, 10, 30, 60].includes(status.retry_delay_seconds)) {
    return 'complete_identity_v1';
  }
  const completedKeys = [
    'artifacts',
    'attempt',
    'citation_allowed',
    'completed_at',
    'document_id',
    'page_count',
    'runtime_fingerprint_sha256',
    'schema_version',
    'source_sha256',
    'status',
    'whole_document_atomic',
  ].sort();
  if (progress.status === 'complete'
    && sameJson(keys, completedKeys)
    && status.attempt === progress.attempts
    && status.page_count === document.page_count
    && status.runtime_fingerprint_sha256 === identity.runtime_fingerprint_sha256
    && status.source_sha256 === document.source_sha256
    && status.whole_document_atomic === true
    && isCanonicalIsoTimestamp(status.completed_at)
    && status.completed_at === progress.completed_at) {
    return 'complete_identity_v1';
  }
  if (identity.runner_script_sha256 !== legacyB1RunnerScriptSha256) {
    throw new Error(`${document.id}: raw legacy predecessor status is not from exact B-r1`);
  }
  const legacyCompleteKeys = [
    'artifacts',
    'citation_allowed',
    'document_id',
    'page_count',
    'runtime_fingerprint_sha256',
    'schema_version',
    'source_sha256',
    'status',
    'verified_at',
    'whole_document_atomic',
  ].sort();
  if (progress.status === 'complete'
    && sameJson(keys, legacyCompleteKeys)
    && (!isCanonicalIsoTimestamp(status.verified_at)
      || !isCanonicalIsoTimestamp(progress.verified_at))) {
    throw new Error(`${document.id}: raw legacy completion verified_at timestamp is not canonical`);
  }
  if (progress.status === 'complete'
    && sameJson(keys, legacyCompleteKeys)
    && status.page_count === document.page_count
    && status.runtime_fingerprint_sha256 === identity.runtime_fingerprint_sha256
    && status.source_sha256 === document.source_sha256
    && status.whole_document_atomic === true
    && isCanonicalIsoTimestamp(status.verified_at)
    && status.verified_at === progress.verified_at) {
    return 'legacy_b1_complete_reverified';
  }
  const legacyInterruptedKeys = [
    'attempt',
    'citation_allowed',
    'document_id',
    'interrupted_at',
    'max_attempts',
    'schema_version',
    'status',
  ].sort();
  if (progress.status === 'interrupted'
    && sameJson(keys, legacyInterruptedKeys)
    && status.attempt === progress.attempts
    && status.max_attempts === 5
    && status.interrupted_at === progress.interrupted_at) {
    return 'legacy_b1_interrupted';
  }
  const legacyQuarantinedKeys = [
    'attempt',
    'citation_allowed',
    'document_id',
    'error',
    'max_attempts',
    'page_count',
    'quarantine_reason',
    'quarantined_at',
    'runtime_fingerprint_sha256',
    'schema_version',
    'status',
  ].sort();
  if (progress.status === 'quarantined'
    && sameJson(keys, legacyQuarantinedKeys)
    && status.attempt === 5
    && progress.attempts === 5
    && status.max_attempts === 5
    && status.page_count === document.page_count
    && status.runtime_fingerprint_sha256 === identity.runtime_fingerprint_sha256
    && status.quarantine_reason === 'attempt_budget_exhausted'
    && progress.quarantine_reason === status.quarantine_reason
    && status.error === progress.error
    && status.quarantined_at === progress.quarantined_at
    && typeof status.quarantined_at === 'string'
    && Number.isFinite(Date.parse(status.quarantined_at))
    && typeof status.error === 'string'
    && /^OCR child idle_timeout after [1-9]\d*s; terminated with SIGTERM(?: then SIGKILL)?$/u.test(status.error)) {
    return 'timeout_only_quarantine_granted_v1';
  }
  throw new Error(`${document.id}: raw predecessor status shape is not exact B-r1`);
}

async function predecessorPageTrees(documentRoot, completedPages, stateRaw) {
  const pagesEntries = [];
  let pageFiles = 0;
  let pageBytes = 0;
  const pageFingerprints = new Map();
  for (const page of completedPages) {
    const pageName = String(page).padStart(4, '0');
    const inventory = await inspectTreeInventory(path.join(documentRoot, 'pages', pageName));
    pagesEntries.push(`D\0${pageName}\n`);
    pagesEntries.push(...inventory.entries.map((entry) => prefixTreeEntry(entry, pageName)));
    pageFiles += inventory.files;
    pageBytes += inventory.bytes;
    pageFingerprints.set(page, {
      tree_sha256: inventory.tree_sha256,
      files: inventory.files,
      bytes: inventory.bytes,
    });
  }
  const pagesTree = treeFingerprint(pagesEntries, pageFiles, pageBytes);
  const documentEntries = [
    'D\0pages\n',
    ...pagesEntries.map((entry) => prefixTreeEntry(entry, 'pages')),
    `F\0state.json\0${stateRaw.byteLength}\0${sha256(stateRaw)}\n`,
  ];
  const documentTree = treeFingerprint(
    documentEntries,
    pageFiles + 1,
    pageBytes + stateRaw.byteLength,
  );
  return { pagesTree, documentTree, pageFingerprints };
}

async function validateSeedPredecessorEvidence({
  shardRoot,
  receipt,
  identity,
  shardManifest,
  manifestSha256,
  timeoutRecovery,
}) {
  const predecessor = requireObject(receipt.predecessor, 'seed receipt predecessor');
  const contract = requireObject(predecessor.control_evidence, 'seed predecessor control evidence');
  const evidenceRoot = path.join(shardRoot, seedPredecessorEvidenceDirectory);
  const tree = await inspectTreeInventory(evidenceRoot);
  const inventoryPath = path.join(evidenceRoot, 'inventory.json');
  const { raw: inventoryRaw, value: inventory } = await readJsonWithRaw(
    inventoryPath,
    'seed predecessor evidence inventory',
  );
  const expectedContract = {
    schema_version: 1,
    directory: seedPredecessorEvidenceDirectory,
    inventory_sha256: sha256(inventoryRaw),
    tree_sha256: tree.tree_sha256,
    files: tree.files,
    bytes: tree.bytes,
  };
  if (!sameJson(contract, expectedContract)) {
    throw new Error('seed predecessor evidence tree differs from the receipt contract');
  }
  requireObject(inventory, 'seed predecessor evidence inventory');
  if (inventory.schema_version !== 1
    || inventory.evidence_type !== seedPredecessorEvidenceType
    || inventory.manifest_sha256 !== manifestSha256
    || inventory.runner_script_sha256 !== legacyB1RunnerScriptSha256
    || inventory.citation_allowed !== false
    || !Array.isArray(inventory.files)
    || !Array.isArray(inventory.documents)) {
    throw new Error('seed predecessor evidence inventory identity is invalid');
  }
  const fileRecords = new Map();
  for (const recordValue of inventory.files) {
    const record = requireObject(recordValue, 'seed predecessor evidence file');
    if (typeof record.path !== 'string'
      || !record.path
      || path.isAbsolute(record.path)
      || path.posix.normalize(record.path) !== record.path
      || record.path.startsWith('../')
      || fileRecords.has(record.path)) {
      throw new Error('seed predecessor evidence inventory contains an unsafe or duplicate path');
    }
    requireEvidenceFileRecord(record, record.path, `seed predecessor evidence ${record.path}`);
    fileRecords.set(record.path, record);
  }
  if (!sameJson([...fileRecords.keys()], [...fileRecords.keys()].sort())) {
    throw new Error('seed predecessor evidence files are not canonical-order');
  }
  const actualFiles = tree.entries
    .map((entry) => evidenceEntryPath(entry, 'file'))
    .filter(Boolean)
    .sort();
  const expectedFiles = [...fileRecords.keys(), 'inventory.json'].sort();
  if (!sameJson(actualFiles, expectedFiles)) {
    throw new Error('seed predecessor evidence tree has missing or extra files');
  }
  const expectedDirectories = new Set();
  for (const relativePath of fileRecords.keys()) {
    const parts = relativePath.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      expectedDirectories.add(parts.slice(0, index).join('/'));
    }
  }
  const actualDirectories = tree.entries
    .map((entry) => evidenceEntryPath(entry, 'directory'))
    .filter(Boolean)
    .sort();
  if (!sameJson(actualDirectories, [...expectedDirectories].sort())) {
    throw new Error('seed predecessor evidence tree has missing or extra directories');
  }
  const rawByPath = new Map();
  const authorityLogPaths = new Set(
    timeoutRecovery?.grant.documents.map((document) => document.timeout_log.path) || [],
  );
  for (const [relativePath, record] of fileRecords) {
    const pathname = path.join(evidenceRoot, relativePath);
    let raw;
    let bytes;
    let digest;
    if (relativePath.startsWith('timeout-incidents/') || authorityLogPaths.has(relativePath)) {
      const stable = await readStableAuthorityFile(
        pathname,
        `seed predecessor evidence ${relativePath}`,
      );
      ({ raw, bytes, digest } = stable);
    } else {
      const info = await requireRegularNonSymlink(pathname, `seed predecessor evidence ${relativePath}`);
      raw = await readFile(pathname);
      bytes = info.size;
      digest = sha256(raw);
    }
    if (bytes !== record.bytes || digest !== record.sha256) {
      throw new Error(`seed predecessor evidence ${relativePath} differs from its raw inventory`);
    }
    rawByPath.set(relativePath, raw);
  }

  const identityRaw = rawByPath.get('run-identity.json');
  const runStatusRaw = rawByPath.get('run-status.json');
  const runStatusSidecarRaw = rawByPath.get('run-status.json.sha256');
  if (!identityRaw || !runStatusRaw || !runStatusSidecarRaw) {
    throw new Error('seed predecessor evidence lacks raw run controls');
  }
  let predecessorIdentity;
  let predecessorRunStatus;
  try {
    predecessorIdentity = JSON.parse(identityRaw);
    predecessorRunStatus = JSON.parse(runStatusRaw);
  } catch (error) {
    throw new Error(`seed predecessor raw control JSON is invalid: ${error.message}`);
  }
  validateRunIdentity(predecessorIdentity, shardManifest, manifestSha256);
  if (predecessorIdentity.runner_script_sha256 !== legacyB1RunnerScriptSha256
    || predecessorIdentity.seed_lineage !== undefined
    || sha256(identityRaw) !== predecessor.run_identity_sha256
    || !sameJson(predecessorIdentity.runtime, predecessor.runtime)
    || !sameJson(predecessorIdentity.runtime_fingerprint, predecessor.runtime_fingerprint)
    || predecessorIdentity.runtime_fingerprint_sha256 !== predecessor.runtime_fingerprint_sha256
    || predecessorIdentity.ocr_script_sha256 !== predecessor.ocr_script_sha256
    || !sameJson(predecessorIdentity.worker_configuration, predecessor.worker_configuration)
    || !sameJson(predecessorIdentity.document_recovery, predecessor.document_recovery)) {
    throw new Error('seed predecessor raw run identity differs from the receipt');
  }
  const sidecarMatch = /^([a-f0-9]{64})  run-status\.json\n$/u.exec(
    runStatusSidecarRaw.toString('utf8'),
  );
  if (!sidecarMatch
    || sidecarMatch[1] !== sha256(runStatusRaw)
    || sha256(runStatusRaw) !== predecessor.run_status_sha256
    || sha256(runStatusSidecarRaw) !== predecessor.run_status_sidecar_sha256) {
    throw new Error('seed predecessor raw run status sidecar is invalid');
  }
  requireObject(predecessorRunStatus, 'seed predecessor raw run status');
  if (predecessorRunStatus.schema_version !== 1
    || predecessorRunStatus.manifest_sha256 !== manifestSha256
    || predecessorRunStatus.runtime_fingerprint_sha256 !== predecessorIdentity.runtime_fingerprint_sha256
    || !sameJson(predecessorRunStatus.document_recovery, predecessorIdentity.document_recovery)
    || predecessorRunStatus.citation_allowed !== false
    || predecessorRunStatus.seed_lineage !== undefined) {
    throw new Error('seed predecessor raw run status differs from raw identity');
  }
  const progressById = requireObject(
    predecessorRunStatus.documents,
    'seed predecessor raw run status documents',
  );
  const expectedIds = shardManifest.documents.map((document) => document.id);
  if (!sameJson(Object.keys(progressById).sort(), [...expectedIds].sort())) {
    throw new Error('seed predecessor raw run status document set differs from manifest');
  }
  const counts = Object.fromEntries(documentStatuses.map((status) => [status, 0]));
  const expectedInventoryDocuments = [];
  const timeoutRecoveryDocuments = new Map(
    (timeoutRecovery?.grant.documents || []).map((document) => [document.document_id, document]),
  );
  for (const document of shardManifest.documents) {
    const progress = requireObject(progressById[document.id], `${document.id} raw predecessor progress`);
    if (!['complete', 'interrupted', 'pending', 'quarantined', 'retry_wait'].includes(progress.status)
      || !Number.isSafeInteger(progress.attempts)
      || progress.attempts < 0
      || progress.attempts > 5
      || progress.page_count !== document.page_count
      || (progress.status === 'pending' && progress.attempts !== 0)
      || (progress.status !== 'pending' && progress.attempts < 1)) {
      throw new Error(`${document.id}: raw predecessor progress is invalid`);
    }
    const timeoutDocument = timeoutRecoveryDocuments.get(document.id) || null;
    if ((progress.status === 'quarantined') !== Boolean(timeoutDocument)) {
      throw new Error(`${document.id}: raw quarantine set differs from the timeout recovery grant`);
    }
    counts[progress.status] += 1;
    const receiptDocument = receipt.documents.find((item) => item.document_id === document.id);
    if (!receiptDocument
      || receiptDocument.predecessor_status !== progress.status
      || receiptDocument.inherited_attempts !== progress.attempts) {
      throw new Error(`${document.id}: raw predecessor attempt/status differs from receipt`);
    }
    const statePath = `documents/${document.id}/state.json`;
    const statusPath = `status/${document.id}.json`;
    const sidecarPath = `${statusPath}.sha256`;
    const timeoutLogPath = `logs/${document.id}.log`;
    if (progress.status === 'pending') {
      if (fileRecords.has(statePath) || fileRecords.has(statusPath) || fileRecords.has(sidecarPath)) {
        throw new Error(`${document.id}: pending predecessor raw controls must be absent`);
      }
      expectedInventoryDocuments.push({
        document_id: document.id,
        predecessor_status: 'pending',
        state: { present: false, path: statePath },
        status: { present: false, path: statusPath, sidecar_path: sidecarPath },
      });
      continue;
    }
    const stateRecord = requireEvidenceFileRecord(
      fileRecords.get(statePath),
      statePath,
      `${document.id} raw predecessor state`,
    );
    const statusRecord = requireEvidenceFileRecord(
      fileRecords.get(statusPath),
      statusPath,
      `${document.id} raw predecessor status`,
    );
    const statusSidecarRecord = requireEvidenceFileRecord(
      fileRecords.get(sidecarPath),
      sidecarPath,
      `${document.id} raw predecessor status sidecar`,
    );
    const timeoutLogRecord = timeoutDocument
      ? requireEvidenceFileRecord(
          fileRecords.get(timeoutLogPath),
          timeoutLogPath,
          `${document.id} raw predecessor timeout log`,
        )
      : null;
    const incidentSummary = timeoutDocument
      ? validateTimeoutRecoveryIncidentSummary(
          receiptDocument.timeout_recovery?.predecessor_incident,
          timeoutDocument,
        )
      : null;
    const incidentPath = incidentSummary
      ? incidentSummary.path.slice(`${seedPredecessorEvidenceDirectory}/`.length)
      : null;
    const incidentSidecarPath = incidentSummary
      ? incidentSummary.sidecar_path.slice(`${seedPredecessorEvidenceDirectory}/`.length)
      : null;
    const incidentRecord = incidentSummary
      ? requireEvidenceFileRecord(
          fileRecords.get(incidentPath),
          incidentPath,
          `${document.id} raw predecessor timeout incident`,
        )
      : null;
    const incidentSidecarRecord = incidentSummary
      ? requireEvidenceFileRecord(
          fileRecords.get(incidentSidecarPath),
          incidentSidecarPath,
          `${document.id} raw predecessor timeout incident sidecar`,
        )
      : null;
    const stateRaw = rawByPath.get(statePath);
    const statusRaw = rawByPath.get(statusPath);
    const statusSidecarRaw = rawByPath.get(sidecarPath);
    let state;
    let status;
    let timeoutIncident = null;
    try {
      state = JSON.parse(stateRaw);
      status = JSON.parse(statusRaw);
      if (incidentSummary) timeoutIncident = JSON.parse(rawByPath.get(incidentPath));
    } catch (error) {
      throw new Error(`${document.id}: raw predecessor document JSON is invalid: ${error.message}`);
    }
    if (incidentSummary) {
      const incidentRaw = rawByPath.get(incidentPath);
      const incidentSidecarRaw = rawByPath.get(incidentSidecarPath);
      if (!incidentRaw.equals(Buffer.from(`${JSON.stringify(timeoutIncident, null, 2)}\n`))) {
        throw new Error(`${document.id}: timeout incident is not canonical pretty-printed JSON`);
      }
      const incidentSidecarMatch = new RegExp(
        `^([a-f0-9]{64})  ${path.basename(incidentPath).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\n$`,
        'u',
      ).exec(incidentSidecarRaw.toString('utf8'));
      if (sha256(incidentRaw) !== incidentSummary.raw_sha256
        || sha256(incidentSidecarRaw) !== incidentSummary.sidecar_sha256
        || !incidentSidecarMatch
        || incidentSidecarMatch[1] !== incidentSummary.raw_sha256) {
        throw new Error(`${document.id}: timeout incident raw bytes or sidecar differ from the receipt`);
      }
      validateTimeoutRecoveryIncidentValue({
        incident: timeoutIncident,
        summary: incidentSummary,
        grantDocument: timeoutDocument,
        document,
        predecessorIdentity,
        predecessorStatus: status,
        logRaw: rawByPath.get(timeoutLogPath),
      });
    }
    const completedPages = receiptDocument.completed_pages;
    if (state.schema_version !== 1
      || state.document_id !== document.id
      || state.source_sha256 !== document.source_sha256
      || state.page_count !== document.page_count
      || state.seed_lineage !== undefined
      || state.configuration_scope !== undefined
      || !sameJson(state.configuration, expectedSeedStateConfiguration(
        shardManifest.runtime,
        predecessorIdentity.worker_configuration,
      ))
      || !sameJson(state.completed_pages, completedPages)
      || Object.keys(requireObject(state.failed_pages, `${document.id} raw failed_pages`)).length !== 0
      || !sameJson(Object.keys(requireObject(state.pages, `${document.id} raw pages`)), completedPages.map(String))) {
      throw new Error(`${document.id}: raw predecessor state identity or page set is invalid`);
    }
    const expectedFirstMissingPage = completedPages.length === document.page_count
      ? null
      : completedPages.length + 1;
    if (timeoutDocument
      && (!sameJson(completedPages, Array.from(
        { length: timeoutDocument.first_missing_page - 1 },
        (_, index) => index + 1,
      ))
        || timeoutDocument.first_missing_page !== expectedFirstMissingPage
        || timeoutDocument.completed_pages_sha256 !== sha256(canonicalJson(completedPages))
        || timeoutDocument.failed_pages_sha256 !== sha256(canonicalJson(state.failed_pages))
        || timeoutDocument.predecessor_state_sha256 !== sha256(stateRaw)
        || timeoutDocument.predecessor_status_sha256 !== sha256(statusRaw)
        || timeoutDocument.error_sha256 !== sha256(progress.error)
        || !sameJson(timeoutDocument.timeout_log, timeoutLogRecord))) {
      throw new Error(`${document.id}: timeout recovery frontier, failure, or log evidence differs from raw controls`);
    }
    if (sha256(stateRaw) !== receiptDocument.predecessor_state_sha256
      || sha256(canonicalJson(state.configuration))
        !== receiptDocument.predecessor_configuration_sha256) {
      throw new Error(`${document.id}: raw predecessor state fingerprint differs from receipt`);
    }
    const statusSidecarMatch = new RegExp(
      `^([a-f0-9]{64})  ${document.id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\.json\\n$`,
      'u',
    ).exec(statusSidecarRaw.toString('utf8'));
    if (!statusSidecarMatch
      || statusSidecarMatch[1] !== sha256(statusRaw)
      || sha256(statusRaw) !== receiptDocument.predecessor_status_sha256
      || sha256(statusSidecarRaw) !== receiptDocument.predecessor_status_sidecar_sha256) {
      throw new Error(`${document.id}: raw predecessor status sidecar differs from receipt`);
    }
    const statusFormat = classifyRawB1Status(
      predecessorIdentity,
      progress,
      status,
      sha256(statusRaw),
      document,
    );
    if (statusFormat !== receiptDocument.predecessor_status_format) {
      throw new Error(`${document.id}: raw predecessor status format differs from receipt`);
    }
    const documentRoot = path.join(shardRoot, 'documents', document.id);
    const trees = await predecessorPageTrees(documentRoot, completedPages, stateRaw);
    if (!sameJson(trees.pagesTree, receiptDocument.predecessor_pages_tree)
      || !sameJson(trees.documentTree, receiptDocument.predecessor_document_tree)) {
      throw new Error(`${document.id}: raw predecessor state and inherited pages do not reconstruct its tree`);
    }
    const pageArtifacts = [];
    const validationArtifacts = [];
    for (const page of completedPages) {
      const statePage = requireObject(state.pages[String(page)], `${document.id} raw page ${page}`);
      const receiptPage = receiptDocument.inherited_page_artifacts.find(
        (item) => item.physical_pdf_page === page,
      );
      const pageTree = trees.pageFingerprints.get(page);
      if (!receiptPage
        || statePage.status !== 'ocr_complete_pending_audit'
        || statePage.physical_pdf_page !== page
        || statePage.citation_eligible !== false
        || statePage.seed_provenance !== undefined
        || statePage.rendered_image_sha256 !== receiptPage.rendered_image_sha256
        || statePage.result_json_sha256 !== receiptPage.result_json_sha256
        || statePage.content_markdown_sha256 !== receiptPage.content_markdown_sha256
        || pageTree.tree_sha256 !== receiptPage.page_tree_sha256
        || pageTree.files !== receiptPage.page_tree_files
        || pageTree.bytes !== receiptPage.page_tree_bytes) {
        throw new Error(`${document.id}: raw predecessor page ${page} differs from inherited evidence`);
      }
      pageArtifacts.push(receiptPage);
      validationArtifacts.push({
        page_number: page,
        rendered_image_sha256: statePage.rendered_image_sha256,
        result_json_sha256: statePage.result_json_sha256,
        content_markdown_sha256: statePage.content_markdown_sha256,
        citation_eligible: false,
      });
    }
    if (sha256(canonicalJson(pageArtifacts)) !== receiptDocument.inherited_page_artifacts_sha256) {
      throw new Error(`${document.id}: raw predecessor page aggregate differs from receipt`);
    }
    if (progress.status === 'complete') {
      const artifacts = requireObject(status.artifacts, `${document.id} raw complete artifacts`);
      requireExactObjectKeys(artifacts, {
        state_sha256: null,
        page_artifacts_sha256: null,
        page_artifacts: null,
      }, `${document.id} raw complete artifacts`);
      if (artifacts.state_sha256 !== sha256(stateRaw)
        || artifacts.page_artifacts_sha256
          !== sha256(`${JSON.stringify(validationArtifacts)}\n`)
        || !sameJson(artifacts.page_artifacts, validationArtifacts)) {
        throw new Error(`${document.id}: raw predecessor complete artifacts are invalid`);
      }
    }
    expectedInventoryDocuments.push({
      document_id: document.id,
      predecessor_status: progress.status,
      state: { present: true, ...stateRecord },
      status: { present: true, ...statusRecord, sidecar: statusSidecarRecord },
      ...(timeoutLogRecord ? { timeout_log: timeoutLogRecord } : {}),
      ...(incidentSummary ? {
        timeout_incident: {
          document_id: document.id,
          attempt: incidentSummary.attempt,
          timeout_type: incidentSummary.timeout_type,
          evidence_origin: incidentSummary.evidence_origin,
          raw: incidentRecord,
          sidecar: incidentSidecarRecord,
          log_sha256: incidentSummary.log_sha256,
          citation_allowed: false,
        },
      } : {}),
    });
  }
  const expectedCounts = {
    total: shardManifest.documents.length,
    complete: counts.complete,
    failed: counts.failed,
    interrupted: counts.interrupted,
    pending: counts.pending,
    running: counts.running,
    retry_wait: counts.retry_wait,
    quarantined: counts.quarantined,
  };
  if (!sameJson(predecessorRunStatus.counts, expectedCounts)
    || predecessorRunStatus.finished !== (counts.complete === shardManifest.documents.length)
    || predecessorRunStatus.settled
      !== (counts.complete + counts.quarantined === shardManifest.documents.length)
    || !sameJson(inventory.documents, expectedInventoryDocuments)) {
    throw new Error('seed predecessor raw run counts or evidence document inventory is invalid');
  }
  if (counts.quarantined !== timeoutRecoveryDocuments.size) {
    throw new Error('seed predecessor quarantine count differs from the timeout recovery grant');
  }
  const expectedRawFilePaths = [
    'run-identity.json',
    'run-status.json',
    'run-status.json.sha256',
    ...expectedInventoryDocuments.flatMap((document) => document.state.present
      ? [
          document.state.path,
          document.status.path,
          document.status.sidecar.path,
          ...(document.timeout_log ? [document.timeout_log.path] : []),
          ...(document.timeout_incident
            ? [document.timeout_incident.raw.path, document.timeout_incident.sidecar.path]
            : []),
        ]
      : []),
  ].sort();
  if (!sameJson([...fileRecords.keys()], expectedRawFilePaths)) {
    throw new Error('seed predecessor evidence raw file inventory is not exact');
  }
  return {
    root: evidenceRoot,
    contract,
    inventory,
    identity: predecessorIdentity,
    runStatus: predecessorRunStatus,
  };
}

async function verifySeedInstalledItems(
  shardRoot,
  marker,
  controlEvidence,
  timeoutRecovery = null,
  timeoutRecoveryConsumption = null,
  timeoutRecoveryIssuance = null,
) {
  const specifications = [
    { name: 'documents', type: 'directory' },
    { name: 'status', type: 'directory' },
    { name: seedPredecessorEvidenceDirectory, type: 'directory' },
    { name: 'seed-receipt.json', type: 'file' },
    { name: 'seed-receipt.json.sha256', type: 'file' },
    ...(timeoutRecovery ? [
      { name: timeoutRecoveryGrantFilename, type: 'file' },
      { name: `${timeoutRecoveryGrantFilename}.sha256`, type: 'file' },
      { name: timeoutRecoveryIssuanceDirectory, type: 'directory' },
      { name: timeoutRecoveryLedgerIdentityFilename, type: 'file' },
      { name: `${timeoutRecoveryLedgerIdentityFilename}.sha256`, type: 'file' },
      { name: timeoutRecoveryClaimFilename, type: 'file' },
      { name: `${timeoutRecoveryClaimFilename}.sha256`, type: 'file' },
    ] : []),
    { name: 'run-identity.json', type: 'file' },
    { name: 'run-status.json', type: 'file' },
    { name: 'run-status.json.sha256', type: 'file' },
  ];
  if (!Array.isArray(marker.installed_items)
    || marker.installed_items.length !== specifications.length) {
    throw new Error('seed commit installed item inventory is invalid');
  }
  if (marker.installed_items_sha256 !== sha256(canonicalJson(marker.installed_items))) {
    throw new Error('seed commit installed item inventory fingerprint is invalid');
  }
  for (let index = 0; index < specifications.length; index += 1) {
    const expected = specifications[index];
    const item = requireObject(marker.installed_items[index], `seed commit item ${index}`);
    const fingerprint = requireObject(item.fingerprint, `seed commit item ${expected.name} fingerprint`);
    if (item.name !== expected.name || item.type !== expected.type) {
      throw new Error('seed commit installed item inventory order or type is invalid');
    }
    if (expected.type === 'directory') {
      requireSha256(fingerprint.tree_sha256, `seed commit item ${expected.name} tree_sha256`);
      if (!Number.isSafeInteger(fingerprint.files) || fingerprint.files < 0
        || !Number.isSafeInteger(fingerprint.bytes) || fingerprint.bytes < 0) {
        throw new Error(`seed commit item ${expected.name} directory fingerprint is invalid`);
      }
    } else {
      requireSha256(fingerprint.sha256, `seed commit item ${expected.name} sha256`);
      if (!Number.isSafeInteger(fingerprint.bytes) || fingerprint.bytes < 0) {
        throw new Error(`seed commit item ${expected.name} file fingerprint is invalid`);
      }
    }
    if (![
      seedPredecessorEvidenceDirectory,
      'seed-receipt.json',
      'seed-receipt.json.sha256',
      timeoutRecoveryGrantFilename,
      `${timeoutRecoveryGrantFilename}.sha256`,
      timeoutRecoveryIssuanceDirectory,
      timeoutRecoveryLedgerIdentityFilename,
      `${timeoutRecoveryLedgerIdentityFilename}.sha256`,
      timeoutRecoveryClaimFilename,
      `${timeoutRecoveryClaimFilename}.sha256`,
      'run-identity.json',
    ].includes(expected.name)) continue;
    const pathname = path.join(shardRoot, expected.name);
    let actual;
    if (expected.type === 'directory') {
      actual = await inspectTree(pathname);
    } else {
      const info = await requireRegularNonSymlink(pathname, `seed commit item ${expected.name}`);
      actual = { sha256: await sha256File(pathname), bytes: info.size };
    }
    if (!sameJson(fingerprint, actual)) {
      throw new Error(`seed commit item ${expected.name} differs from the installed shard`);
    }
  }
  const byName = new Map(marker.installed_items.map((item) => [item.name, item]));
  const exactFileFingerprint = (name, contents) => {
    const raw = Buffer.from(contents, 'utf8');
    if (!sameJson(byName.get(name)?.fingerprint, { sha256: sha256(raw), bytes: raw.byteLength })) {
      throw new Error(`seed commit item ${name} is not cross-bound to the marker contract`);
    }
  };
  const exactHashFingerprint = (name, digest) => {
    const item = byName.get(name);
    if (item?.fingerprint?.sha256 !== digest) {
      throw new Error(`seed commit item ${name} is not cross-bound to the marker contract`);
    }
  };
  exactHashFingerprint('seed-receipt.json', marker.seed_receipt_sha256);
  exactFileFingerprint(
    'seed-receipt.json.sha256',
    `${marker.seed_receipt_sha256}  seed-receipt.json\n`,
  );
  exactHashFingerprint('run-identity.json', marker.run_identity_sha256);
  if (timeoutRecovery) {
    exactHashFingerprint(timeoutRecoveryGrantFilename, timeoutRecovery.rawSha256);
    exactFileFingerprint(
      `${timeoutRecoveryGrantFilename}.sha256`,
      `${timeoutRecovery.rawSha256}  ${timeoutRecoveryGrantFilename}\n`,
    );
    exactHashFingerprint(
      timeoutRecoveryLedgerIdentityFilename,
      timeoutRecoveryConsumption.ledgerSha256,
    );
    exactFileFingerprint(
      `${timeoutRecoveryLedgerIdentityFilename}.sha256`,
      `${timeoutRecoveryConsumption.ledgerSha256}  ${timeoutRecoveryLedgerIdentityFilename}\n`,
    );
    exactHashFingerprint(timeoutRecoveryClaimFilename, timeoutRecoveryConsumption.claimSha256);
    exactFileFingerprint(
      `${timeoutRecoveryClaimFilename}.sha256`,
      `${timeoutRecoveryConsumption.claimSha256}  ${timeoutRecoveryClaimFilename}\n`,
    );
    if (!sameJson(byName.get(timeoutRecoveryIssuanceDirectory)?.fingerprint, {
      tree_sha256: sha256([
        `F\0${path.basename(timeoutRecoveryIssuance.path)}\0${timeoutRecoveryIssuance.raw.byteLength}\0${timeoutRecoveryIssuance.rawSha256}\n`,
        `F\0${path.basename(timeoutRecoveryIssuance.sidecarPath)}\0${timeoutRecoveryIssuance.sidecarRaw.byteLength}\0${timeoutRecoveryIssuance.sidecarSha256}\n`,
      ].sort().join('')),
      files: 2,
      bytes: timeoutRecoveryIssuance.raw.byteLength + timeoutRecoveryIssuance.sidecarRaw.byteLength,
    })) {
      throw new Error('timeout recovery issuance directory is not cross-bound to the commit marker');
    }
  }
  exactHashFingerprint('run-status.json', marker.initial_run_status_sha256);
  exactFileFingerprint(
    'run-status.json.sha256',
    `${marker.initial_run_status_sha256}  run-status.json\n`,
  );
  const evidenceItem = byName.get(seedPredecessorEvidenceDirectory);
  if (!sameJson(evidenceItem?.fingerprint, {
    tree_sha256: controlEvidence.tree_sha256,
    files: controlEvidence.files,
    bytes: controlEvidence.bytes,
  })) {
    throw new Error('seed predecessor evidence is not cross-bound to the commit marker');
  }
}

async function loadSeedEvidence(shardRoot, identity, identitySha256, shardManifest, manifestSha256) {
  if (identity.seed_lineage === undefined) {
    for (const name of [
      'seed-receipt.json',
      'seed-receipt.json.sha256',
      'seed-commit.json',
      'seed-commit.json.sha256',
      '.seed-journal.json',
      '.seed-journal.json.sha256',
      seedPredecessorEvidenceDirectory,
      timeoutRecoveryGrantFilename,
      `${timeoutRecoveryGrantFilename}.sha256`,
      timeoutRecoveryIssuanceDirectory,
      timeoutRecoveryLedgerIdentityFilename,
      `${timeoutRecoveryLedgerIdentityFilename}.sha256`,
      timeoutRecoveryClaimFilename,
      `${timeoutRecoveryClaimFilename}.sha256`,
    ]) {
      if (await exists(path.join(shardRoot, name))) {
        throw new Error(`unseeded run identity unexpectedly has ${name}`);
      }
    }
    return null;
  }
  const lineage = requireObject(identity.seed_lineage, 'run identity seed_lineage');
  if (lineage.schema_version !== 1
    || lineage.mode !== seedMode
    || lineage.citation_allowed !== false) {
    throw new Error('run identity seed lineage is invalid');
  }
  for (const [key, value] of Object.entries({
    seed_id: lineage.seed_id,
    seed_receipt_sha256: lineage.seed_receipt_sha256,
    predecessor_run_identity_sha256: lineage.predecessor_run_identity_sha256,
    predecessor_run_status_sha256: lineage.predecessor_run_status_sha256,
    predecessor_snapshot_sha256: lineage.predecessor_snapshot_sha256,
  })) requireSha256(value, `run identity seed_lineage.${key}`);

  const receiptPath = path.join(shardRoot, 'seed-receipt.json');
  const markerPath = path.join(shardRoot, 'seed-commit.json');
  const [receiptEvidence, markerEvidence] = await Promise.all([
    readJsonWithVerifiedSidecar(receiptPath, 'seed receipt'),
    readJsonWithVerifiedSidecar(markerPath, 'seed commit marker'),
  ]);
  const receiptSha256 = receiptEvidence.digest;
  const markerSha256 = markerEvidence.digest;
  const receipt = receiptEvidence.value;
  const marker = markerEvidence.value;
  if (receiptSha256 !== lineage.seed_receipt_sha256
    || receipt.schema_version !== 1
    || receipt.receipt_type !== seedReceiptType
    || receipt.status !== 'prepared_commit_marker_required'
    || receipt.seed_id !== lineage.seed_id
    || receipt.seed_basis_sha256 !== lineage.seed_id
    || receipt.manifest_sha256 !== manifestSha256
    || receipt.citation_allowed !== false
    || !Array.isArray(receipt.documents)) {
    throw new Error('seed receipt identity differs from the run identity');
  }
  const allowedConfigurationDelta = requireObject(
    receipt.allowed_configuration_delta,
    'seed receipt allowed configuration delta',
  );
  const p4ToP1 = isAuditedP4ToP1Delta(allowedConfigurationDelta);
  if (allowedConfigurationDelta.schema_version !== 1 && !p4ToP1) {
    throw new Error('seed receipt allowed configuration delta version or transition is invalid');
  }
  if (!p4ToP1 && (containsTimeoutRecoveryKey(receipt) || containsTimeoutRecoveryKey(lineage))) {
    throw new Error('timeout recovery is permitted only for an audited p4-to-p1 transition');
  }
  const timeoutRecovery = await loadTimeoutRecoveryGrant(
    shardRoot,
    receipt,
    lineage,
    manifestSha256,
  );
  if (timeoutRecovery && !p4ToP1) {
    throw new Error('timeout recovery is permitted only for an audited p4-to-p1 transition');
  }
  const timeoutRecoveryConsumption = await loadTimeoutRecoveryConsumption(
    shardRoot,
    receipt,
    lineage,
    timeoutRecovery,
  );
  const timeoutRecoveryIssuance = await loadTimeoutRecoveryIssuance(
    shardRoot,
    receipt,
    lineage,
    timeoutRecovery,
    p4ToP1,
  );
  if (!timeoutRecovery
    && (containsTimeoutRecoveryKey(receipt) || containsTimeoutRecoveryKey(lineage))) {
    throw new Error('seed without a grant contains a timeout recovery field');
  }
  const predecessor = requireObject(receipt.predecessor, 'seed receipt predecessor');
  const successor = requireObject(receipt.successor, 'seed receipt successor');
  const predecessorRuntimeContractValid = p4ToP1
    ? predecessor.runtime_fingerprint_sha256
      === sha256(`${JSON.stringify(predecessor.runtime_fingerprint)}\n`)
    : sameJson(predecessor.runtime_fingerprint, identity.runtime_fingerprint)
      && predecessor.runtime_fingerprint_sha256
        === sha256(`${JSON.stringify(predecessor.runtime_fingerprint)}\n`)
      && predecessor.runtime_fingerprint_sha256 === identity.runtime_fingerprint_sha256;
  if (predecessor.run_identity_sha256 !== lineage.predecessor_run_identity_sha256
    || predecessor.run_status_sha256 !== lineage.predecessor_run_status_sha256
    || predecessor.snapshot_sha256 !== lineage.predecessor_snapshot_sha256
    || predecessor.manifest_sha256 !== manifestSha256
    || !sameJson(predecessor.runtime, shardManifest.runtime)
    || !predecessorRuntimeContractValid
    || !sameJson(successor.runtime, identity.runtime)
    || !sameJson(successor.runtime_fingerprint, identity.runtime_fingerprint)
    || successor.runtime_fingerprint_sha256 !== identity.runtime_fingerprint_sha256
    || !sameJson(successor.worker_configuration, identity.worker_configuration)
    || !sameJson(successor.document_recovery, identity.document_recovery)
    || successor.runner_script_sha256 !== identity.runner_script_sha256
    || successor.ocr_script_sha256 !== identity.ocr_script_sha256
    || successor.citation_allowed !== false) {
    throw new Error('seed receipt predecessor or successor contract differs from the shard identity');
  }
  if (timeoutRecovery
    && (timeoutRecovery.grant.predecessor.manifest_sha256 !== predecessor.manifest_sha256
      || timeoutRecovery.grant.predecessor.run_identity_sha256 !== predecessor.run_identity_sha256
      || timeoutRecovery.grant.predecessor.run_status_sha256 !== predecessor.run_status_sha256)) {
    throw new Error('timeout recovery grant predecessor differs from the seed receipt predecessor');
  }
  for (const [key, value] of Object.entries({
    run_status_sidecar_sha256: predecessor.run_status_sidecar_sha256,
    runner_script_sha256: predecessor.runner_script_sha256,
    ocr_script_sha256: predecessor.ocr_script_sha256,
    worker_configuration_sha256: predecessor.worker_configuration_sha256,
    document_recovery_sha256: predecessor.document_recovery_sha256,
    page_artifacts_sha256: predecessor.page_artifacts_sha256,
    initial_run_status_sha256: successor.initial_run_status_sha256,
  })) requireSha256(value, `seed receipt ${key}`);
  if (predecessor.worker_configuration_sha256 !== sha256(canonicalJson(predecessor.worker_configuration))
    || predecessor.document_recovery_sha256 !== sha256(canonicalJson(predecessor.document_recovery))
    || successor.worker_configuration_sha256 !== sha256(canonicalJson(successor.worker_configuration))
    || successor.document_recovery_sha256 !== sha256(canonicalJson(successor.document_recovery))) {
    throw new Error('seed receipt configuration or recovery fingerprints are invalid');
  }
  if (!p4ToP1) validateSeedAllowedDelta(receipt);
  const expectedIds = shardManifest.documents.map((document) => document.id);
  const receiptIds = receipt.documents.map((document) => document?.document_id);
  if (new Set(receiptIds).size !== receiptIds.length || !sameJson(receiptIds, expectedIds)) {
    throw new Error('seed receipt document set differs from the shard manifest');
  }
  let inheritedPages = 0;
  let inheritedDocuments = 0;
  const predecessorDocuments = [];
  const aggregatePageArtifacts = [];
  const timeoutRecoveryDocuments = new Map(
    (timeoutRecovery?.grant.documents || []).map((grantDocument) => [
      grantDocument.document_id,
      {
        ...grantDocument,
        grant_id: timeoutRecovery.grant.grant_id,
        grant_raw_sha256: timeoutRecovery.rawSha256,
        predecessor_log: grantDocument.timeout_log,
        predecessor_incident: receipt.documents.find(
          (document) => document.document_id === grantDocument.document_id,
        )?.timeout_recovery?.predecessor_incident,
      },
    ]),
  );
  for (const document of shardManifest.documents) {
    const record = receipt.documents.find((item) => item.document_id === document.id);
    requireObject(record, `${document.id} seed receipt document`);
    const completedPages = validateSeedReceiptDocumentShape(
      record,
      document,
      predecessor.runner_script_sha256,
      timeoutRecoveryDocuments.get(document.id) || null,
    );
    inheritedPages += completedPages.length;
    if (completedPages.length > 0) inheritedDocuments += 1;
    predecessorDocuments.push(seedPredecessorDocument(record));
    for (const page of record.inherited_page_artifacts) {
      if (!record.completed_pages.includes(page.physical_pdf_page)
        || page.citation_allowed !== false
        || !Number.isSafeInteger(page.page_tree_files)
        || !Number.isSafeInteger(page.page_tree_bytes)) {
        throw new Error(`${document.id}: seed inherited page inventory is invalid`);
      }
      for (const key of [
        'rendered_image_sha256',
        'result_json_sha256',
        'content_markdown_sha256',
        'page_tree_sha256',
      ]) requireSha256(page[key], `${document.id} inherited page ${page.physical_pdf_page} ${key}`);
      aggregatePageArtifacts.push({ document_id: document.id, ...page });
    }
  }
  const expectedTimeoutRecoveryIds = receipt.documents
    .filter((document) => document.predecessor_status === 'quarantined')
    .map((document) => document.document_id);
  if (!sameJson(
    timeoutRecovery?.grant.documents.map((document) => document.document_id) || [],
    expectedTimeoutRecoveryIds,
  )) {
    throw new Error('timeout recovery grant document set or order differs from quarantined predecessors');
  }
  const counts = requireObject(receipt.counts, 'seed receipt counts');
  const quarantinedDocuments = timeoutRecoveryDocuments.size;
  const expectedCountKeys = [
    'documents',
    'failed_pages',
    'inherited_documents',
    'inherited_pages',
    'quarantined_documents',
    ...(timeoutRecovery ? [
      'predecessor_complete_documents',
      'predecessor_quarantined_documents',
      'recovery_granted_documents',
    ] : []),
  ].sort();
  if (!sameJson(Object.keys(counts).sort(), expectedCountKeys)
    || counts.documents !== shardManifest.documents.length
    || counts.inherited_documents !== inheritedDocuments
    || counts.inherited_pages !== inheritedPages
    || counts.failed_pages !== 0
    || counts.quarantined_documents !== 0
    || lineage.inherited_pages !== inheritedPages) {
    throw new Error('seed receipt counts or fail-closed gates are invalid');
  }
  if (timeoutRecovery) {
    if (counts.predecessor_complete_documents
        !== receipt.documents.filter((document) => document.predecessor_status === 'complete').length
      || counts.predecessor_quarantined_documents !== quarantinedDocuments
      || counts.recovery_granted_documents !== quarantinedDocuments) {
      throw new Error('seed receipt timeout recovery counts are invalid');
    }
  } else if (counts.predecessor_complete_documents !== undefined
    || counts.predecessor_quarantined_documents !== undefined
    || counts.recovery_granted_documents !== undefined) {
    throw new Error('seed receipt without a recovery grant carries recovery counts');
  }
  if (predecessor.completed_pages !== inheritedPages
    || predecessor.failed_pages !== 0
    || predecessor.quarantined_documents !== quarantinedDocuments
    || predecessor.page_artifacts_sha256 !== sha256(canonicalJson(aggregatePageArtifacts))) {
    throw new Error('seed predecessor page aggregate or fail-closed counts are invalid');
  }
  const predecessorEvidence = await validateSeedPredecessorEvidence({
    shardRoot,
    receipt,
    identity,
    shardManifest,
    manifestSha256,
    timeoutRecovery,
  });
  if (p4ToP1) {
    validateP4ToP1SeedDelta(receipt, predecessorEvidence.identity, identity);
  }
  const predecessorSnapshot = {
    manifest_sha256: predecessor.manifest_sha256,
    run_identity_sha256: predecessor.run_identity_sha256,
    run_status_sha256: predecessor.run_status_sha256,
    run_status_sidecar_sha256: predecessor.run_status_sidecar_sha256,
    runtime_fingerprint_sha256: predecessor.runtime_fingerprint_sha256,
    worker_configuration_sha256: predecessor.worker_configuration_sha256,
    document_recovery_sha256: predecessor.document_recovery_sha256,
    completed_pages: predecessor.completed_pages,
    failed_pages: predecessor.failed_pages,
    quarantined_documents: predecessor.quarantined_documents,
    page_artifacts_sha256: predecessor.page_artifacts_sha256,
    ...(timeoutRecovery ? {
      timeout_recovery_grant_id: timeoutRecovery.grant.grant_id,
      timeout_recovery_grant_raw_sha256: timeoutRecovery.rawSha256,
      timeout_recovery_grant_sidecar_sha256: timeoutRecovery.sidecarSha256,
    } : {}),
    documents: predecessorDocuments,
  };
  if (predecessor.snapshot_sha256 !== sha256(canonicalJson(predecessorSnapshot))) {
    throw new Error('seed predecessor snapshot fingerprint is invalid');
  }
  const { initial_run_status_sha256: _initialRunStatusSha256, ...successorContract } = successor;
  const seedBasis = {
    schema_version: 1,
    mode: seedMode,
    manifest_sha256: receipt.manifest_sha256,
    predecessor,
    successor_contract: successorContract,
    allowed_configuration_delta: receipt.allowed_configuration_delta,
    ...(timeoutRecovery ? { timeout_recovery_grant: timeoutRecovery.summary } : {}),
    ...(timeoutRecoveryIssuance ? {
      timeout_recovery_issuance: timeoutRecoveryIssuance.summary,
    } : {}),
    documents: predecessorDocuments,
    citation_allowed: false,
  };
  const computedSeedId = sha256(canonicalJson(seedBasis));
  if (receipt.seed_id !== computedSeedId || receipt.seed_basis_sha256 !== computedSeedId) {
    throw new Error('seed receipt seed basis fingerprint is invalid');
  }
  if (marker.schema_version !== 1
    || marker.marker_type !== 'curriculum_remote_ocr_hash_bound_seed_commit'
    || marker.seed_id !== lineage.seed_id
    || marker.seed_receipt_sha256 !== receiptSha256
    || marker.run_identity_sha256 !== identitySha256
    || marker.initial_run_status_sha256 !== successor.initial_run_status_sha256
    || marker.citation_allowed !== false) {
    throw new Error('seed commit marker does not bind the receipt and run identity');
  }
  requireSha256(marker.installed_items_sha256, 'seed commit installed_items_sha256');
  await verifySeedInstalledItems(
    shardRoot,
    marker,
    predecessorEvidence.contract,
    timeoutRecovery,
    timeoutRecoveryConsumption,
    timeoutRecoveryIssuance,
  );
  return {
    receiptPath,
    receipt,
    receiptSha256,
    markerPath,
    marker,
    markerSha256,
    predecessorEvidence,
    timeoutRecovery,
    timeoutRecoveryConsumption,
    timeoutRecoveryIssuance,
  };
}

function validateRunStatus(runStatus, identity, shardManifest, seed = null) {
  requireObject(runStatus, 'run status');
  if (runStatus.schema_version !== 1) throw new Error('run status schema_version must equal 1');
  if (runStatus.manifest_sha256 !== identity.manifest_sha256) throw new Error('run status manifest fingerprint mismatch');
  if (runStatus.runtime_fingerprint_sha256 !== identity.runtime_fingerprint_sha256) {
    throw new Error('run status runtime fingerprint mismatch');
  }
  if (!sameJson(runStatus.document_recovery, identity.document_recovery)) {
    throw new Error('run status recovery policy differs from run identity');
  }
  if (runStatus.citation_allowed !== false) throw new Error('run status citation_allowed must equal false');
  if (seed) {
    if (runStatus.seed_lineage?.seed_id !== seed.receipt.seed_id
      || runStatus.seed_lineage?.predecessor_run_identity_sha256
        !== seed.receipt.predecessor.run_identity_sha256) {
      throw new Error('run status seed lineage differs from the verified seed receipt');
    }
    const recoveryIds = seed.timeoutRecovery?.grant.documents.map((document) => document.document_id);
    if (seed.timeoutRecovery) {
      if (runStatus.seed_lineage.timeout_recovery_grant_id !== seed.timeoutRecovery.grant.grant_id
        || runStatus.seed_lineage.timeout_recovery_grant_sha256 !== seed.timeoutRecovery.rawSha256
        || runStatus.seed_lineage.timeout_recovery_ledger_id
          !== seed.timeoutRecoveryConsumption.ledger.ledger_id
        || runStatus.seed_lineage.timeout_recovery_claim_sha256
          !== seed.timeoutRecoveryConsumption.claimSha256
        || runStatus.seed_lineage.timeout_recovery_issuance_claim_key
          !== seed.timeoutRecoveryIssuance.claim.claim_key
        || runStatus.seed_lineage.timeout_recovery_issuance_sha256
          !== seed.timeoutRecoveryIssuance.rawSha256
        || !sameJson(runStatus.seed_lineage.timeout_recovery_documents, recoveryIds)) {
        throw new Error('run status timeout recovery lineage differs from the verified grant');
      }
    } else if (runStatus.seed_lineage.timeout_recovery_grant_id !== undefined
      || runStatus.seed_lineage.timeout_recovery_grant_sha256 !== undefined
      || runStatus.seed_lineage.timeout_recovery_ledger_id !== undefined
      || runStatus.seed_lineage.timeout_recovery_claim_sha256 !== undefined
      || runStatus.seed_lineage.timeout_recovery_issuance_claim_key !== undefined
      || runStatus.seed_lineage.timeout_recovery_issuance_sha256 !== undefined
      || runStatus.seed_lineage.timeout_recovery_documents !== undefined) {
      throw new Error('run status declares timeout recovery without a verified grant');
    }
  } else if (runStatus.seed_lineage !== undefined) {
    throw new Error('unseeded run status unexpectedly contains seed lineage');
  }
  if (runStatus.settled !== true) throw new Error('run status is not settled');
  const documents = requireObject(runStatus.documents, 'run status documents');
  const expectedIds = shardManifest.documents.map((document) => document.id).sort();
  if (!sameJson(Object.keys(documents).sort(), expectedIds)) {
    throw new Error('run status document set differs from shard manifest');
  }
  const counts = Object.fromEntries(documentStatuses.map((status) => [status, 0]));
  for (const document of shardManifest.documents) {
    const progress = requireObject(documents[document.id], `${document.id} run status`);
    if (!documentStatuses.includes(progress.status)) throw new Error(`${document.id}: invalid run status`);
    if (!['complete', 'quarantined'].includes(progress.status)) {
      throw new Error(`${document.id}: run status ${progress.status} is not receivable`);
    }
    if (progress.page_count !== document.page_count) throw new Error(`${document.id}: run status page count mismatch`);
    if (!Number.isSafeInteger(progress.attempts) || progress.attempts < 0) {
      throw new Error(`${document.id}: run status attempts is not a non-negative integer`);
    }
    validateCanonicalLifecycleTimestamps(progress, `${document.id} run status`);
    if (progress.status === 'complete') {
      validateCompleteTimestampOrder(progress, `${document.id} complete run status`);
    }
    let timeoutDocument = null;
    if (seed) {
      const seededDocument = seed.receipt.documents.find((item) => item.document_id === document.id);
      timeoutDocument = seed.timeoutRecovery?.grant.documents.find(
        (item) => item.document_id === document.id,
      ) || null;
      if (progress.seed_id !== seed.receipt.seed_id
        || progress.predecessor_status !== seededDocument.predecessor_status
        || progress.inherited_attempts !== seededDocument.inherited_attempts
        || progress.attempts < seededDocument.inherited_attempts) {
        throw new Error(`${document.id}: run status violates the seed attempt floor or predecessor status`);
      }
      if (timeoutDocument) {
        if (progress.status !== 'complete'
          || progress.attempts !== 6
          || progress.inherited_attempts !== 5
          || progress.attempt_ceiling !== 6
          || progress.timeout_recovery_grant_id !== seed.timeoutRecovery.grant.grant_id
          || progress.timeout_recovery_grant_sha256 !== seed.timeoutRecovery.rawSha256
          || progress.timeout_recovery_first_missing_page !== timeoutDocument.first_missing_page) {
          throw new Error(`${document.id}: timeout recovery final state is not exact attempt 6 complete`);
        }
      } else if (progress.attempt_ceiling !== undefined
        || progress.timeout_recovery_grant_id !== undefined
        || progress.timeout_recovery_grant_sha256 !== undefined
        || progress.timeout_recovery_first_missing_page !== undefined) {
        throw new Error(`${document.id}: ungranted document carries timeout recovery progress`);
      }
    }
    const attemptCeiling = timeoutDocument ? maxDocumentAttempts + 1 : maxDocumentAttempts;
    if (progress.attempts > attemptCeiling) {
      throw new Error(`${document.id}: run status exceeds the granted attempt ceiling ${attemptCeiling}`);
    }
    requireSha256(progress.status_json_sha256, `${document.id} status_json_sha256`);
    counts[progress.status] += 1;
  }
  const expectedCounts = {
    total: shardManifest.documents.length,
    complete: counts.complete,
    failed: counts.failed,
    interrupted: counts.interrupted,
    pending: counts.pending,
    running: counts.running,
    retry_wait: counts.retry_wait,
    quarantined: counts.quarantined,
  };
  if (!sameJson(runStatus.counts, expectedCounts)) throw new Error('run status counts do not match document statuses');
  if (runStatus.finished !== (counts.quarantined === 0)) {
    throw new Error('run status finished flag does not match terminal document states');
  }
  return runStatus;
}

async function loadRepairManifest(manifestPath, shardRoot) {
  if (!manifestPath) return null;
  const requestedPath = path.resolve(manifestPath);
  await requireRegularNonSymlink(requestedPath, 'repair manifest');
  const resolvedPath = await realpath(requestedPath);
  const manifestSha256 = await verifySha256Sidecar(resolvedPath, 'repair manifest');
  const { value } = await readJsonWithRaw(resolvedPath, 'repair manifest');
  const manifest = validateRemoteRepairManifest(value);
  const manifestDirectory = path.dirname(resolvedPath);
  const pages = new Map();
  const evidenceByPath = new Map();

  for (const document of manifest.documents) {
    for (const page of document.pages) {
      const key = `${document.document_id}:${page.physical_pdf_page}`;
      const evidence = [];
      for (const item of page.evidence) {
        const pathname = path.resolve(manifestDirectory, path.normalize(item.path));
        if (!isWithin(manifestDirectory, pathname)) {
          throw new Error(`${key}: repair evidence escapes the manifest directory`);
        }
        await requireRegularNonSymlink(pathname, `${key} repair evidence ${item.path}`);
        const resolvedEvidencePath = await realpath(pathname);
        if (resolvedEvidencePath !== pathname || !isWithin(manifestDirectory, resolvedEvidencePath)) {
          throw new Error(`${key}: repair evidence must not traverse a symbolic link`);
        }
        const actualSha256 = await sha256File(pathname);
        if (actualSha256 !== item.sha256) {
          throw new Error(`${key}: repair evidence hash mismatch for ${item.path}`);
        }
        const previous = evidenceByPath.get(item.path);
        if (previous && previous.sha256 !== item.sha256) {
          throw new Error(`repair evidence path is reused with conflicting hashes: ${item.path}`);
        }
        const record = {
          kind: item.kind,
          relative_path: item.path,
          source_path: pathname,
          sha256: item.sha256,
        };
        evidence.push(record);
        if (!previous) evidenceByPath.set(item.path, record);
      }
      pages.set(key, { document, page, evidence });
    }
  }

  const receiptPath = path.join(shardRoot, 'repair-receipts', `${manifest.repair_id}.json`);
  const receiptSha256 = await verifySha256Sidecar(receiptPath, 'repair receipt');
  const { value: receipt } = await readJsonWithRaw(receiptPath, 'repair receipt');
  return {
    manifestPath: resolvedPath,
    manifest,
    manifestSha256,
    manifestDirectory,
    pages,
    evidence: [...evidenceByPath.values()].sort((left, right) => (
      left.relative_path < right.relative_path ? -1 : left.relative_path > right.relative_path ? 1 : 0
    )),
    receiptPath,
    receipt,
    receiptSha256,
  };
}

async function loadShard({ manifestPath, root, repairManifestPath }) {
  const resolvedManifestPath = path.resolve(manifestPath);
  const requestedRoot = path.resolve(root);
  const rootInfo = await lstat(requestedRoot).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`shard root is missing: ${requestedRoot}`);
    throw error;
  });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`shard root must be a real directory: ${requestedRoot}`);
  }
  const resolvedRoot = await realpath(requestedRoot);
  await requireRegularNonSymlink(resolvedManifestPath, 'shard manifest');
  const { raw: manifestRaw, value: manifest } = await readJsonWithRaw(resolvedManifestPath, 'shard manifest');
  validateRemoteOcrManifest(manifest);
  const manifestSha256 = sha256(manifestRaw);
  const identityPath = path.join(resolvedRoot, 'run-identity.json');
  const runStatusPath = path.join(resolvedRoot, 'run-status.json');
  await requireRegularNonSymlink(identityPath, 'run identity');
  const [{ raw: identityRaw, value: identity }, runStatusEvidence, repair] = await Promise.all([
    readJsonWithRaw(identityPath, 'run identity'),
    readJsonWithVerifiedSidecar(runStatusPath, 'run status'),
    loadRepairManifest(repairManifestPath, resolvedRoot),
  ]);
  validateRunIdentity(identity, manifest, manifestSha256);
  const identitySha256 = sha256(identityRaw);
  const runStatus = runStatusEvidence.value;
  const runStatusSha256 = runStatusEvidence.digest;
  const seed = await loadSeedEvidence(resolvedRoot, identity, identitySha256, manifest, manifestSha256);
  const p4ToP1 = isAuditedP4ToP1Delta(seed?.receipt?.allowed_configuration_delta);
  if (p4ToP1) {
    const workerConfiguration = requireObject(identity.worker_configuration, 'run identity worker configuration');
    if (typeof workerConfiguration.paddlex_cache_home !== 'string'
      || !path.isAbsolute(workerConfiguration.paddlex_cache_home)) {
      throw new Error('run identity PaddleX cache home must be an absolute path');
    }
    const cacheRoot = path.resolve(workerConfiguration.paddlex_cache_home);
    if (cacheRoot !== workerConfiguration.paddlex_cache_home
      || cacheRoot === resolvedRoot
      || !isWithin(resolvedRoot, cacheRoot)) {
      throw new Error('run identity PaddleX cache must be a canonical path contained by the shard root');
    }
    const cacheInfo = await lstat(cacheRoot).catch((error) => {
      if (error?.code === 'ENOENT') throw new Error('shard PaddleX cache is missing');
      throw error;
    });
    if (!cacheInfo.isDirectory() || cacheInfo.isSymbolicLink()
      || await realpath(cacheRoot) !== cacheRoot) {
      throw new Error('shard PaddleX cache must be a canonical real directory');
    }
    const officialModelsRoot = path.join(cacheRoot, 'official_models');
    if (await realpath(officialModelsRoot) !== officialModelsRoot
      || !isWithin(cacheRoot, officialModelsRoot)) {
      throw new Error('shard PaddleX official model cache must be canonical and contained');
    }
    const paddlexCacheFingerprint = await fingerprintStablePaddlexCache(
      cacheRoot,
      'shard PaddleX cache',
    );
    const runtimeFingerprint = requireObject(identity.runtime_fingerprint, 'run identity runtime fingerprint');
    if (workerConfiguration.paddlex_cache_home !== cacheRoot
      || workerConfiguration.paddlex_layout_model_cache_sha256 !== paddlexCacheFingerprint.tree_sha256
      || !sameJson(runtimeFingerprint.paddlex_layout_model_cache, paddlexCacheFingerprint)) {
      throw new Error('shard PaddleX cache differs from the run identity');
    }
  }
  validateRunStatus(runStatus, identity, manifest, seed);
  return {
    manifestPath: resolvedManifestPath,
    manifest,
    manifestSha256,
    root: resolvedRoot,
    identity,
    identitySha256,
    runStatus,
    runStatusSha256,
    repair,
    seed,
  };
}

function validateShardUnion(parentManifest, shards) {
  const parentDocuments = new Map(parentManifest.documents.map((document) => [document.id, document]));
  const seenDocuments = new Map();
  const seenSourcePaths = new Set();
  const seenRoots = new Set();
  let selectedPages = 0;
  let selectedBytes = 0;
  let runtimeFingerprintSha256 = null;
  let p1ExecutionContract = null;
  let p4ToP1Union = null;
  let p4ToP1TransitionContract = null;
  const p1RunnerShards = [];

  for (const shard of shards) {
    if (seenRoots.has(shard.root)) throw new Error(`duplicate shard root: ${shard.root}`);
    seenRoots.add(shard.root);
    if (!sameJson(shard.manifest.runtime, parentManifest.runtime)) throw new Error('shard runtime differs from parent manifest');
    if (!sameJson(shard.manifest.quality_policy, parentManifest.quality_policy)) {
      throw new Error('shard quality policy differs from parent manifest');
    }
    if (!sameJson(shard.manifest.import_hard_gates, parentManifest.import_hard_gates)) {
      throw new Error('shard import gates differ from parent manifest');
    }
    if (runtimeFingerprintSha256 === null) {
      runtimeFingerprintSha256 = shard.identity.runtime_fingerprint_sha256;
    } else if (runtimeFingerprintSha256 !== shard.identity.runtime_fingerprint_sha256) {
      throw new Error('shard runtime fingerprints differ');
    }
    const shardDelta = shard.seed?.receipt?.allowed_configuration_delta;
    const shardIsP4ToP1 = isAuditedP4ToP1Delta(shardDelta);
    if (p4ToP1Union === null) p4ToP1Union = shardIsP4ToP1;
    else if (p4ToP1Union !== shardIsP4ToP1) {
      throw new Error('shard union mixes audited p4-to-p1 and legacy execution contracts');
    }
    if (shardIsP4ToP1) {
      const shardTransitionContract = {
        schema_version: shardDelta.schema_version,
        transition: shardDelta.transition,
        ...(shardDelta.ocr_script_transition ? {
          ocr_script_transition: shardDelta.ocr_script_transition,
        } : {}),
      };
      if (p4ToP1TransitionContract === null) {
        p4ToP1TransitionContract = shardTransitionContract;
      } else if (!sameJson(p4ToP1TransitionContract, shardTransitionContract)) {
        throw new Error('p1 shard union mixes different audited OCR script transition contracts');
      }
      const {
        paddlex_cache_home: _shardSpecificPaddlexCacheHome,
        ...pathIndependentWorkerConfiguration
      } = shard.identity.worker_configuration;
      const shardExecutionContract = {
        runtime_fingerprint_sha256: shard.identity.runtime_fingerprint_sha256,
        llama_server_attestation_sha256: shard.identity.llama_server_attestation_sha256,
        ocr_script_sha256: shard.identity.ocr_script_sha256,
        worker_configuration: pathIndependentWorkerConfiguration,
        document_recovery: shard.identity.document_recovery,
        python_invocation_path: shard.identity.python_invocation_path,
        python_resolved_target: shard.identity.python_resolved_target,
      };
      if (p1ExecutionContract === null) {
        p1ExecutionContract = shardExecutionContract;
      } else if (!sameJson(p1ExecutionContract, shardExecutionContract)) {
        throw new Error('p1 shard execution contracts differ');
      }
      p1RunnerShards.push(shard);
    }
    for (const document of shard.manifest.documents) {
      if (seenDocuments.has(document.id)) throw new Error(`document appears in more than one shard: ${document.id}`);
      const parentDocument = parentDocuments.get(document.id);
      if (!parentDocument) throw new Error(`shard contains a document absent from parent manifest: ${document.id}`);
      if (!sameJson(document, parentDocument)) throw new Error(`${document.id}: shard document differs from parent manifest`);
      if (seenSourcePaths.has(document.source_path)) {
        throw new Error(`source path appears in more than one shard: ${document.source_path}`);
      }
      seenSourcePaths.add(document.source_path);
      seenDocuments.set(document.id, shard);
      selectedPages += document.page_count;
      selectedBytes += document.source_bytes;
    }
  }

  const parentIds = [...parentDocuments.keys()].sort();
  const unionIds = [...seenDocuments.keys()].sort();
  if (!sameJson(unionIds, parentIds)) throw new Error('shard union does not exactly equal the parent manifest');
  if (parentManifest.counts.selected_documents !== unionIds.length
    || parentManifest.counts.selected_pages !== selectedPages
    || parentManifest.counts.selected_source_bytes !== selectedBytes) {
    throw new Error('parent manifest counts do not match the shard union');
  }
  const runnerHashes = new Set(p1RunnerShards.map((shard) => shard.identity.runner_script_sha256));
  let runnerCompatibility = null;
  const roleCandidates = p1RunnerShards.map((shard) => ({
    shard,
    documents: shard.manifest.documents.length,
    pages: shard.manifest.documents.reduce((sum, document) => sum + document.page_count, 0),
  }));
  const hasExactAAndBShape = roleCandidates.length === 2
    && roleCandidates.some((candidate) => candidate.documents === 8 && candidate.pages === 3_182)
    && roleCandidates.some((candidate) => candidate.documents === 6 && candidate.pages === 3_182);
  if (runnerHashes.size > 1) {
    if (p1RunnerShards.length !== 2 || runnerHashes.size !== 2 || !hasExactAAndBShape) {
      throw new Error('p1 shard union runner drift is outside the unique directed A+B compatibility pair');
    }
    const shardA = roleCandidates.find((candidate) => (
      candidate.documents === 8
      && candidate.pages === 3_182
      && candidate.shard.identity.runner_script_sha256 === a1CompletedStatusRunnerScriptSha256
    ));
    const shardB = roleCandidates.find((candidate) => (
      candidate.documents === 6
      && candidate.pages === 3_182
      && candidate.shard.identity.runner_script_sha256 === fixedB3RunnerScriptSha256
    ));
    if (!shardA || !shardB || shardA.shard === shardB.shard) {
      throw new Error('p1 shard union runner drift is not the exact directed A-new to B-fixed pair');
    }
    const basis = {
      schema_version: 1,
      compatibility_type: directedRunnerCompatibilityType,
      transition: directedRunnerCompatibilityTransition,
      allowed_difference: ['runner_script_sha256'],
      shards: [
        {
          role: 'shard_a',
          manifest_sha256: shardA.shard.manifestSha256,
          run_identity_sha256: shardA.shard.identitySha256,
          runner_script_sha256: a1CompletedStatusRunnerScriptSha256,
          documents: shardA.documents,
          pages: shardA.pages,
        },
        {
          role: 'shard_b',
          manifest_sha256: shardB.shard.manifestSha256,
          run_identity_sha256: shardB.shard.identitySha256,
          runner_script_sha256: fixedB3RunnerScriptSha256,
          documents: shardB.documents,
          pages: shardB.pages,
        },
      ],
      citation_allowed: false,
    };
    runnerCompatibility = validateDirectedRunnerCompatibilityEvidence({
      ...basis,
      compatibility_sha256: sha256(canonicalJson(basis)),
    });
  }
  return { seenDocuments, runnerCompatibility };
}

function validateSeededCompleteLifecycle(shard, document, validation, status, statusSha256) {
  if (!shard.seed || status.status !== 'complete') return false;
  const progress = shard.runStatus.documents[document.id];
  const receiptDocument = shard.seed.receipt.documents.find(
    (item) => item.document_id === document.id,
  );
  const predecessorProgress = shard.seed.predecessorEvidence.runStatus.documents[document.id];
  const timeoutDocument = shard.seed.timeoutRecovery?.grant.documents.find(
    (item) => item.document_id === document.id,
  ) || null;
  const initialInheritedComplete = receiptDocument.predecessor_status === 'complete'
    && status.max_attempts === undefined;
  if (initialInheritedComplete) {
    const modern = receiptDocument.predecessor_status_format === 'complete_identity_v1';
    const legacy = receiptDocument.predecessor_status_format === 'legacy_b1_complete_reverified';
    if (!modern && !legacy) {
      throw new Error(`${document.id}: seeded initial complete status format is invalid`);
    }
    const timestampField = modern ? 'completed_at' : 'verified_at';
    validateCompleteProgressContract({
      receiptDocument,
      progress,
      predecessorProgress,
      phase: 'initial',
      statusTimestampField: timestampField,
      labelPrefix: 'receiver',
    });
    requireExactLifecycleKeys(status, [
      'artifacts',
      'citation_allowed',
      'document_id',
      'page_count',
      'runtime_fingerprint_sha256',
      'schema_version',
      'seed_lineage',
      'source_sha256',
      'status',
      'whole_document_atomic',
      ...(modern ? ['attempt', 'completed_at'] : ['verified_at']),
    ], `${document.id} receiver initial complete status`);
    const lineage = requireExactLifecycleKeys(status.seed_lineage, [
      'citation_allowed',
      'inherited_attempts',
      'predecessor_status_sha256',
      'schema_version',
      'seed_id',
    ], `${document.id} receiver initial complete status seed lineage`);
    const artifacts = requireExactLifecycleKeys(status.artifacts, [
      'page_artifacts',
      'page_artifacts_sha256',
      'state_sha256',
    ], `${document.id} receiver initial complete status artifacts`);
    if (progress.status !== 'complete'
      || progress.attempts !== receiptDocument.inherited_attempts
      || status.schema_version !== 1
      || status.document_id !== document.id
      || status.page_count !== document.page_count
      || status.runtime_fingerprint_sha256 !== shard.identity.runtime_fingerprint_sha256
      || status.source_sha256 !== document.source_sha256
      || status.citation_allowed !== false
      || status.whole_document_atomic !== true
      || !isCanonicalIsoTimestamp(status[timestampField])
      || status[timestampField] !== progress[timestampField]
      || (modern && status.attempt !== progress.attempts)
      || lineage.schema_version !== 1
      || lineage.seed_id !== shard.seed.receipt.seed_id
      || lineage.predecessor_status_sha256 !== receiptDocument.predecessor_status_sha256
      || lineage.inherited_attempts !== receiptDocument.inherited_attempts
      || lineage.citation_allowed !== false
      || artifacts.state_sha256 !== validation.state_sha256
      || artifacts.page_artifacts_sha256 !== validation.page_artifacts_sha256
      || !sameJson(artifacts.page_artifacts, validation.page_artifacts)
      || statusSha256 !== receiptDocument.successor_status_sha256
      || validation.state_sha256 !== receiptDocument.successor_state_sha256) {
      throw new Error(`${document.id}: receiver initial complete status or state differs from seed receipt`);
    }
    return true;
  }

  if (status.max_attempts === undefined) return false;
  const hasCompletedAt = Object.hasOwn(status, 'completed_at');
  const hasVerifiedAt = Object.hasOwn(status, 'verified_at');
  if (hasCompletedAt === hasVerifiedAt) {
    throw new Error(`${document.id}: receiver full complete status timestamp field is not exact`);
  }
  const timestampField = hasCompletedAt ? 'completed_at' : 'verified_at';
  if (receiptDocument.predecessor_status === 'complete' && timestampField !== 'verified_at') {
    throw new Error(`${document.id}: inherited complete reverify must use verified_at`);
  }
  validateCompleteProgressContract({
    receiptDocument,
    progress,
    predecessorProgress,
    phase: 'full',
    statusTimestampField: timestampField,
    labelPrefix: 'receiver',
  });
  requireExactLifecycleKeys(status, [
    'artifacts',
    'attempt',
    'citation_allowed',
    'document_id',
    'max_attempts',
    'page_count',
    'runtime_fingerprint_sha256',
    'schema_version',
    'source_sha256',
    'status',
    timestampField,
    'whole_document_atomic',
    ...(timeoutDocument ? ['seed_lineage'] : []),
  ], `${document.id} receiver full complete status`);
  const artifacts = requireExactLifecycleKeys(status.artifacts, [
    'page_artifacts',
    'page_artifacts_sha256',
    'state_sha256',
  ], `${document.id} receiver full complete status artifacts`);
  const attemptCeiling = timeoutDocument ? maxDocumentAttempts + 1 : maxDocumentAttempts;
  if (status.schema_version !== 1
    || status.document_id !== document.id
    || status.attempt !== progress.attempts
    || status.max_attempts !== attemptCeiling
    || status.page_count !== document.page_count
    || status.runtime_fingerprint_sha256 !== shard.identity.runtime_fingerprint_sha256
    || status.source_sha256 !== document.source_sha256
    || status.citation_allowed !== false
    || status.whole_document_atomic !== true
    || !isCanonicalIsoTimestamp(status[timestampField])
    || status[timestampField] !== progress[timestampField]
    || artifacts.state_sha256 !== validation.state_sha256
    || artifacts.page_artifacts_sha256 !== validation.page_artifacts_sha256
    || !sameJson(artifacts.page_artifacts, validation.page_artifacts)) {
    throw new Error(`${document.id}: receiver full complete status identity or artifacts differ`);
  }
  if (receiptDocument.predecessor_status === 'complete'
    && validation.state_sha256 !== receiptDocument.successor_state_sha256) {
    throw new Error(`${document.id}: receiver inherited complete state differs from receipt successor_state_sha256`);
  }
  return true;
}

async function validateDocumentStatus(shard, document, validation) {
  const progress = shard.runStatus.documents[document.id];
  const statusPath = path.join(shard.root, 'status', `${document.id}.json`);
  const statusSha256 = await verifySha256Sidecar(statusPath, `${document.id} status`);
  if (progress.status_json_sha256 !== statusSha256) {
    throw new Error(`${document.id}: run status does not reference the current document status`);
  }
  const { value: status } = await readJsonWithRaw(statusPath, `${document.id} status`);
  requireObject(status, `${document.id} status`);
  if (status.schema_version !== 1
    || status.document_id !== document.id
    || status.page_count !== document.page_count
    || status.runtime_fingerprint_sha256 !== shard.identity.runtime_fingerprint_sha256) {
    throw new Error(`${document.id}: document status identity mismatch`);
  }
  if (status.citation_allowed !== false) throw new Error(`${document.id}: document status citation_allowed must equal false`);
  if (status.status !== progress.status) throw new Error(`${document.id}: document and run status disagree`);
  if (status.status === 'complete') {
    if (status.source_sha256 !== document.source_sha256 || status.whole_document_atomic !== true) {
      throw new Error(`${document.id}: complete status source or atomicity mismatch`);
    }
    const artifacts = requireObject(status.artifacts, `${document.id} status artifacts`);
    if (artifacts.state_sha256 !== validation.state_sha256
      || artifacts.page_artifacts_sha256 !== validation.page_artifacts_sha256
      || !sameJson(artifacts.page_artifacts, validation.page_artifacts)) {
      throw new Error(`${document.id}: complete status artifacts differ from revalidated output`);
    }
    validateSeededCompleteLifecycle(shard, document, validation, status, statusSha256);
  }
  const timeoutDocument = shard.seed?.timeoutRecovery?.grant.documents.find(
    (item) => item.document_id === document.id,
  );
  if (timeoutDocument) {
    const lineage = requireObject(status.seed_lineage, `${document.id} timeout recovery status lineage`);
    const receiptDocument = shard.seed.receipt.documents.find(
      (item) => item.document_id === document.id,
    );
    const expectedLineageKeys = [
      'citation_allowed',
      'granted_attempt',
      'inherited_attempts',
      'predecessor_status_sha256',
      'schema_version',
      'seed_id',
      'timeout_recovery_first_missing_page',
      'timeout_recovery_grant_id',
      'timeout_recovery_grant_sha256',
    ].sort();
    if (!sameJson(Object.keys(lineage).sort(), expectedLineageKeys)
      || status.status !== 'complete'
      || status.attempt !== 6
      || status.max_attempts !== 6
      || lineage.schema_version !== 1
      || lineage.seed_id !== shard.seed.receipt.seed_id
      || lineage.predecessor_status_sha256 !== receiptDocument.predecessor_status_sha256
      || lineage.inherited_attempts !== 5
      || lineage.citation_allowed !== false
      || lineage.timeout_recovery_grant_id !== shard.seed.timeoutRecovery.grant.grant_id
      || lineage.timeout_recovery_grant_sha256 !== shard.seed.timeoutRecovery.rawSha256
      || lineage.timeout_recovery_first_missing_page !== timeoutDocument.first_missing_page
      || lineage.granted_attempt !== 6) {
      throw new Error(`${document.id}: document status is not an exact granted attempt 6 completion`);
    }
  } else {
    const seededRecord = shard.seed?.receipt.documents.find(
      (item) => item.document_id === document.id,
    );
    const exactSeededInheritedComplete = Boolean(
      seededRecord
      && seededRecord.predecessor_status === 'complete'
      && progress.status === 'complete'
      && progress.attempts === seededRecord.inherited_attempts
      && statusSha256 === seededRecord.successor_status_sha256
      && (seededRecord.predecessor_status_format === 'complete_identity_v1'
        ? status.attempt === progress.attempts
          && status.max_attempts === undefined
          && status.completed_at === progress.completed_at
        : seededRecord.predecessor_status_format === 'legacy_b1_complete_reverified'
          && status.attempt === undefined
          && status.max_attempts === undefined
          && status.verified_at === progress.verified_at),
    );
    const hasAttempt = status.attempt !== undefined;
    const hasMaxAttempts = status.max_attempts !== undefined;
    if (!exactSeededInheritedComplete && hasAttempt !== hasMaxAttempts) {
      throw new Error(`${document.id}: ungranted document status has an incomplete attempt ceiling`);
    }
    if (!exactSeededInheritedComplete && hasAttempt) {
      if (!Number.isSafeInteger(status.attempt)
        || status.attempt < 0
        || status.attempt > maxDocumentAttempts
        || status.attempt !== progress.attempts
        || status.max_attempts !== maxDocumentAttempts) {
        throw new Error(`${document.id}: ungranted document status exceeds or differs from the global attempt ceiling`);
      }
    } else if (!exactSeededInheritedComplete) {
      const exactLegacyComplete = Boolean(
        !shard.seed
        && shard.identity.runner_script_sha256 === legacyB1RunnerScriptSha256
        && status.status === 'complete'
        && status.verified_at === progress.verified_at,
      );
      if (!exactSeededInheritedComplete && !exactLegacyComplete) {
        throw new Error(`${document.id}: ungranted document status omits its attempt ceiling outside an exact legacy completion`);
      }
    }
    const lineage = status.seed_lineage;
    if (lineage && (lineage.timeout_recovery_grant_id !== undefined
      || lineage.timeout_recovery_grant_sha256 !== undefined
      || lineage.timeout_recovery_first_missing_page !== undefined
      || lineage.granted_attempt !== undefined)) {
      throw new Error(`${document.id}: ungranted document status carries timeout recovery lineage`);
    }
  }
  return { status, statusSha256 };
}

function repairProvenance(repair, baseFailure) {
  return {
    schema_version: 1,
    repair_manifest_sha256: repair.manifestSha256,
    repair_id: repair.manifest.repair_id,
    method: repair.manifest.method,
    base_failure: baseFailure,
    citation_eligible: false,
  };
}

function sameCoordinates(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((coordinate, index) => coordinate === expected[index]);
}

async function validateNativePaddlePage({
  document,
  page,
  statePage,
  pageShape,
  documentRoot,
}) {
  if (!pageShape?.markdownPath) {
    throw new Error(`${document.id} page ${page}: native Paddle Markdown tree is missing`);
  }
  const pageRoot = path.join(documentRoot, 'pages', String(page).padStart(4, '0'));
  const [{ raw: resultRaw, value: result }, contentText, markdownText] = await Promise.all([
    readJsonWithRaw(path.join(pageRoot, 'result.json'), `${document.id} page ${page} Paddle result`),
    readFile(path.join(pageRoot, 'content.md'), 'utf8'),
    readFile(pageShape.markdownPath, 'utf8'),
  ]);
  requireObject(result, `${document.id} page ${page} Paddle result`);
  if (Object.hasOwn(result, 'result_type') || Object.hasOwn(result, 'repair_provenance')) {
    throw new Error(`${document.id} page ${page}: native Paddle result contains repair-only identity`);
  }
  requireObject(result.model_settings, `${document.id} page ${page} Paddle model_settings`);
  if (!Array.isArray(result.parsing_res_list)) {
    throw new Error(`${document.id} page ${page}: Paddle parsing_res_list must be an array`);
  }
  const layout = requireObject(result.layout_det_res, `${document.id} page ${page} Paddle layout_det_res`);
  if (!Array.isArray(layout.boxes)) {
    throw new Error(`${document.id} page ${page}: Paddle layout boxes must be an array`);
  }
  const contentSha256 = sha256(contentText);
  if (markdownText !== contentText
    || pageShape.markdownSha256 !== contentSha256
    || statePage.content_markdown_sha256 !== contentSha256
    || statePage.result_json_sha256 !== sha256(resultRaw)
    || statePage.citation_eligible !== false) {
    throw new Error(`${document.id} page ${page}: native Paddle Markdown mirror or state hash mismatch`);
  }

  const assetsByRelativePath = new Map(pageShape.assets.map((asset) => [asset.relativePath, asset]));
  const referencedAssets = new Set();
  const imageTagPattern = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/giu;
  for (const match of markdownText.matchAll(imageTagPattern)) {
    const relativePath = match[1];
    if (!/^imgs\/[^/]+\.jpg$/u.test(relativePath) || !assetsByRelativePath.has(relativePath)) {
      throw new Error(`${document.id} page ${page}: Markdown image reference is not a local validated Paddle asset`);
    }
    if (referencedAssets.has(relativePath)) {
      throw new Error(`${document.id} page ${page}: Markdown references the same Paddle asset more than once`);
    }
    referencedAssets.add(relativePath);
  }

  for (const asset of pageShape.assets) {
    const parsingBound = result.parsing_res_list.some((block) => (
      block
      && block.block_label === asset.blockLabel
      && sameCoordinates(block.block_bbox, asset.bbox)
    ));
    const layoutBound = layout.boxes.some((box) => (
      box
      && box.label === asset.blockLabel
      && sameCoordinates(box.coordinate, asset.bbox)
    ));
    if (!parsingBound && !layoutBound) {
      throw new Error(`${document.id} page ${page}: Paddle Markdown asset is not bound to result geometry: ${asset.name}`);
    }
  }
  return {
    assetCount: pageShape.assets.length,
    assetBytes: pageShape.assets.reduce((sum, asset) => sum + asset.bytes, 0),
    markdownTreeSha256: pageShape.markdownTree.tree_sha256,
  };
}

async function validateRepairPage({
  shard,
  document,
  page,
  statePage,
  pageShape,
  documentRoot,
}) {
  const provenance = requireObject(statePage.repair_provenance, `${document.id} page ${page} repair_provenance`);
  if (!shard.repair) throw new Error(`${document.id} page ${page}: explicit --repair-manifest is missing`);
  if (!baseFailureValid(provenance.base_failure)
    || !sameJson(provenance, repairProvenance(shard.repair, provenance.base_failure))) {
    throw new Error(`${document.id} page ${page}: repair provenance contract mismatch`);
  }
  const key = `${document.id}:${page}`;
  const manifestRecord = shard.repair.pages.get(key);
  if (!manifestRecord) throw new Error(`${document.id} page ${page}: repair manifest page entry is missing`);
  const { document: repairDocument, page: repairPage } = manifestRecord;
  if (repairDocument.source_sha256 !== document.source_sha256
    || repairDocument.page_count !== document.page_count
    || repairDocument.citation_allowed !== false
    || repairPage.citation_eligible !== false
    || repairPage.rendered_image_sha256 !== statePage.rendered_image_sha256) {
    throw new Error(`${document.id} page ${page}: repair document, image, or citation identity mismatch`);
  }
  if (!pageShape?.markdownPath) {
    throw new Error(`${document.id} page ${page}: repaired page Markdown mirror is missing`);
  }
  if (pageShape.assets.length !== 0 || pageShape.markdownTree.files !== 1) {
    throw new Error(`${document.id} page ${page}: repaired page must not contain unbound Paddle Markdown assets`);
  }
  const pageRoot = path.join(documentRoot, 'pages', String(page).padStart(4, '0'));
  const resultPath = path.join(pageRoot, 'result.json');
  const contentPath = path.join(pageRoot, 'content.md');
  const [{ raw: resultRaw, value: result }, contentText, markdownText] = await Promise.all([
    readJsonWithRaw(resultPath, `${document.id} page ${page} repair result`),
    readFile(contentPath, 'utf8'),
    readFile(pageShape.markdownPath, 'utf8'),
  ]);
  const expectedResult = {
    schema_version: 1,
    result_type: 'curriculum_remote_ocr_page_repair',
    document_id: document.id,
    physical_pdf_page: page,
    text: repairPage.final_text,
    final_text_sha256: repairPage.final_text_sha256,
    citation_eligible: false,
    repair_provenance: provenance,
  };
  const resultSha256 = sha256(resultRaw);
  const contentSha256 = sha256(contentText);
  if (!sameJson(result, expectedResult)
    || contentText !== repairPage.final_text
    || markdownText !== repairPage.final_text
    || contentSha256 !== repairPage.final_text_sha256
    || statePage.result_json_sha256 !== resultSha256
    || statePage.content_markdown_sha256 !== contentSha256
    || statePage.citation_eligible !== false) {
    throw new Error(`${document.id} page ${page}: repaired artifacts conflict with the repair manifest`);
  }
  return {
    key,
    documentId: document.id,
    page,
    renderedImageSha256: repairPage.rendered_image_sha256,
    finalTextSha256: repairPage.final_text_sha256,
    resultJsonSha256: resultSha256,
    contentMarkdownSha256: contentSha256,
  };
}

function validateRepairReceipt(shard, documents, repairReferences) {
  if (!shard.repair) {
    if (repairReferences.size !== 0) throw new Error('repaired state pages exist without an explicit repair manifest');
    return;
  }
  const { manifest, manifestSha256, receipt } = shard.repair;
  requireObject(receipt, 'repair receipt');
  if (receipt.schema_version !== 1
    || receipt.receipt_type !== repairReceiptType
    || receipt.repair_id !== manifest.repair_id
    || receipt.repair_manifest_sha256 !== manifestSha256
    || receipt.method !== manifest.method
    || receipt.citation_allowed !== false
    || receipt.status !== 'applied'
    || typeof receipt.applied_at !== 'string'
    || !Number.isFinite(Date.parse(receipt.applied_at))
    || !Array.isArray(receipt.documents)) {
    throw new Error('repair receipt identity conflicts with the explicit repair manifest');
  }
  const documentItems = new Map(documents.map((item) => [item.document.id, item]));
  const expectedDocumentIds = manifest.documents.map((document) => document.document_id).sort();
  const receiptDocumentIds = receipt.documents.map((document) => document?.document_id).sort();
  if (new Set(receiptDocumentIds).size !== receiptDocumentIds.length
    || !sameJson(receiptDocumentIds, expectedDocumentIds)) {
    throw new Error('repair receipt document set differs from the repair manifest');
  }
  for (const repairDocument of manifest.documents) {
    const item = documentItems.get(repairDocument.document_id);
    const receiptDocument = receipt.documents.find((entry) => entry.document_id === repairDocument.document_id);
    if (!item
      || !receiptDocument
      || receiptDocument.source_sha256 !== repairDocument.source_sha256
      || receiptDocument.page_count !== repairDocument.page_count
      || receiptDocument.state_after_sha256 !== item.validation.state_sha256
      || !sha256Pattern.test(String(receiptDocument.state_before_sha256 || ''))
      || !Array.isArray(receiptDocument.pages)) {
      throw new Error(`${repairDocument.document_id}: repair receipt state or document identity mismatch`);
    }
    const expectedPageNumbers = repairDocument.pages.map((page) => page.physical_pdf_page).sort((left, right) => left - right);
    const receiptPageNumbers = receiptDocument.pages.map((page) => page?.physical_pdf_page).sort((left, right) => left - right);
    if (new Set(receiptPageNumbers).size !== receiptPageNumbers.length
      || !sameJson(receiptPageNumbers, expectedPageNumbers)) {
      throw new Error(`${repairDocument.document_id}: repair receipt page set differs from the repair manifest`);
    }
    for (const repairPage of repairDocument.pages) {
      const key = `${repairDocument.document_id}:${repairPage.physical_pdf_page}`;
      const reference = repairReferences.get(key);
      const receiptPage = receiptDocument.pages.find(
        (entry) => entry.physical_pdf_page === repairPage.physical_pdf_page,
      );
      if (!reference
        || !receiptPage
        || receiptPage.rendered_image_sha256 !== reference.renderedImageSha256
        || receiptPage.final_text_sha256 !== reference.finalTextSha256
        || receiptPage.result_json_sha256 !== reference.resultJsonSha256
        || receiptPage.content_markdown_sha256 !== reference.contentMarkdownSha256
        || receiptPage.citation_eligible !== false) {
        throw new Error(`${key}: repair receipt artifact checksum mismatch`);
      }
    }
  }
}

async function joinedDocumentText(documentRoot, document) {
  const parts = [];
  for (let page = 1; page <= document.page_count; page += 1) {
    if (page > 1) parts.push(Buffer.from('\f'));
    parts.push(await readFile(path.join(documentRoot, 'pages', String(page).padStart(4, '0'), 'content.md')));
  }
  return Buffer.concat(parts);
}

async function validateSeededDocumentLineage(shard, document, state, documentRoot) {
  if (!shard.seed) {
    if (state.seed_lineage !== undefined || state.configuration_scope !== undefined) {
      throw new Error(`${document.id}: unseeded shard contains seeded OCR state`);
    }
    for (const page of Object.values(requireObject(state.pages, `${document.id} pages`))) {
      if (page?.seed_provenance !== undefined) {
        throw new Error(`${document.id}: unseeded shard contains page seed provenance`);
      }
    }
    return;
  }
  const record = shard.seed.receipt.documents.find((item) => item.document_id === document.id);
  const lineage = requireObject(state.seed_lineage, `${document.id} seed_lineage`);
  const timeoutDocument = shard.seed.timeoutRecovery?.grant.documents.find(
    (item) => item.document_id === document.id,
  );
  requireExactLifecycleKeys(lineage, [
    'citation_allowed',
    'inherited_completed_pages',
    'mode',
    'predecessor_configuration_sha256',
    'predecessor_run_identity_sha256',
    'schema_version',
    'seed_id',
    ...(timeoutDocument ? [
      'timeout_recovery_first_missing_page',
      'timeout_recovery_grant_id',
      'timeout_recovery_grant_sha256',
    ] : []),
  ], `${document.id} state seed lineage`);
  if (state.configuration_scope !== seedConfigurationScope
    || lineage.schema_version !== 1
    || lineage.mode !== seedMode
    || lineage.seed_id !== shard.seed.receipt.seed_id
    || lineage.predecessor_run_identity_sha256 !== shard.seed.receipt.predecessor.run_identity_sha256
    || lineage.predecessor_configuration_sha256 !== record.predecessor_configuration_sha256
    || lineage.citation_allowed !== false
    || !sameJson(lineage.inherited_completed_pages, record.completed_pages)) {
    throw new Error(`${document.id}: state seed lineage differs from the independently verified receipt`);
  }
  if (timeoutDocument) {
    if (lineage.timeout_recovery_grant_id !== shard.seed.timeoutRecovery.grant.grant_id
      || lineage.timeout_recovery_grant_sha256 !== shard.seed.timeoutRecovery.rawSha256
      || lineage.timeout_recovery_first_missing_page !== timeoutDocument.first_missing_page) {
      throw new Error(`${document.id}: state timeout recovery lineage differs from the verified grant`);
    }
  } else if (lineage.timeout_recovery_grant_id !== undefined
    || lineage.timeout_recovery_grant_sha256 !== undefined
    || lineage.timeout_recovery_first_missing_page !== undefined) {
    throw new Error(`${document.id}: ungranted state carries timeout recovery lineage`);
  }
  const inherited = new Map(
    record.inherited_page_artifacts.map((page) => [page.physical_pdf_page, page]),
  );
  const completedPages = state.completed_pages;
  if (!Array.isArray(completedPages)) throw new Error(`${document.id}: completed_pages is invalid`);
  for (const page of completedPages) {
    const statePage = requireObject(state.pages[String(page)], `${document.id} page ${page}`);
    const expected = inherited.get(page);
    if (!expected) {
      if (statePage.seed_provenance !== undefined) {
        throw new Error(`${document.id}: newly generated page ${page} carries inherited seed provenance`);
      }
      continue;
    }
    const expectedTag = {
      seed_id: shard.seed.receipt.seed_id,
      predecessor_run_identity_sha256: shard.seed.receipt.predecessor.run_identity_sha256,
      predecessor_configuration_sha256: record.predecessor_configuration_sha256,
    };
    if (!sameJson(statePage.seed_provenance, expectedTag)
      || statePage.rendered_image_sha256 !== expected.rendered_image_sha256
      || statePage.result_json_sha256 !== expected.result_json_sha256
      || statePage.content_markdown_sha256 !== expected.content_markdown_sha256
      || statePage.citation_eligible !== false) {
      throw new Error(`${document.id}: inherited page ${page} state or seed artifact identity changed`);
    }
    const pageTree = await inspectTree(path.join(documentRoot, 'pages', String(page).padStart(4, '0')));
    if (pageTree.tree_sha256 !== expected.page_tree_sha256
      || pageTree.files !== expected.page_tree_files
      || pageTree.bytes !== expected.page_tree_bytes) {
      throw new Error(`${document.id}: inherited page ${page} tree differs from the seed receipt`);
    }
  }
  for (const page of record.completed_pages) {
    if (!completedPages.includes(page)) {
      throw new Error(`${document.id}: inherited page ${page} disappeared after the seed transaction`);
    }
  }
}

async function validateShardDocuments(shard, projectRoot, python, dependencies) {
  const documents = [];
  const repairReferences = new Map();
  for (const document of shard.manifest.documents) {
    const source = await preflightDocument(document, {
      inputRoot: projectRoot,
      python,
      ...(dependencies.pageCounter ? { pageCounter: dependencies.pageCounter } : {}),
    });
    const documentRoot = path.join(shard.root, 'documents', document.id);
    const pageShapes = await validateDocumentTreeShape(documentRoot, document.page_count);
    const validation = await validateOcrDocumentOutput(
      document,
      documentRoot,
      shard.manifest.runtime,
      {
        requireComplete: true,
        workerConfiguration: shard.identity.worker_configuration,
      },
    );
    const { status, statusSha256 } = await validateDocumentStatus(shard, document, validation);
    const { value: state } = await readJsonWithRaw(path.join(documentRoot, 'state.json'), `${document.id} OCR state`);
    await validateSeededDocumentLineage(shard, document, state, documentRoot);
    let repairPageCount = 0;
    let nativeAssetCount = 0;
    let nativeAssetBytes = 0;
    const nativeMarkdownTrees = [];
    for (let page = 1; page <= document.page_count; page += 1) {
      const statePage = state.pages[String(page)];
      const pageShape = pageShapes.get(page);
      if (!statePage?.repair_provenance) {
        const native = await validateNativePaddlePage({
          document,
          page,
          statePage,
          pageShape,
          documentRoot,
        });
        nativeAssetCount += native.assetCount;
        nativeAssetBytes += native.assetBytes;
        nativeMarkdownTrees.push({
          physical_pdf_page: page,
          markdown_tree_sha256: native.markdownTreeSha256,
          asset_count: native.assetCount,
          asset_bytes: native.assetBytes,
        });
        continue;
      }
      const reference = await validateRepairPage({
        shard,
        document,
        page,
        statePage,
        pageShape,
        documentRoot,
      });
      repairReferences.set(reference.key, reference);
      repairPageCount += 1;
    }
    if (status.status === 'quarantined' && repairPageCount === 0) {
      throw new Error(`${document.id}: quarantined document has no independently adjudicated repair pages`);
    }
    const [sourceTree, text] = await Promise.all([
      inspectTree(documentRoot),
      joinedDocumentText(documentRoot, document),
    ]);
    documents.push({
      document,
      shard,
      documentRoot,
      source,
      validation,
      status: status.status,
      statusSha256,
      sourceTree,
      text,
      textSha256: sha256(text),
      repairPageCount,
      nativeAssetCount,
      nativeAssetBytes,
      nativeMarkdownTreesSha256: sha256(`${JSON.stringify(nativeMarkdownTrees)}\n`),
    });
  }
  const manifestRepairPages = new Set(shard.repair ? shard.repair.pages.keys() : []);
  if (!sameJson([...repairReferences.keys()].sort(), [...manifestRepairPages].sort())) {
    throw new Error(`repair manifest page set does not exactly match repaired state pages in ${shard.root}`);
  }
  validateRepairReceipt(shard, documents, repairReferences);
  return documents;
}

function sourceShardFingerprint(shard) {
  return {
    root: shard.root,
    manifest_sha256: shard.manifestSha256,
    run_identity_sha256: shard.identitySha256,
    run_status_sha256: shard.runStatusSha256,
    runtime_fingerprint_sha256: shard.identity.runtime_fingerprint_sha256,
    seed_id: shard.seed?.receipt.seed_id || null,
    seed_receipt_sha256: shard.seed?.receiptSha256 || null,
    seed_commit_marker_sha256: shard.seed?.markerSha256 || null,
    ...(shard.seed?.timeoutRecovery
      ? {
          timeout_recovery_grant_sha256: shard.seed.timeoutRecovery.rawSha256,
          timeout_recovery_issuance_sha256: shard.seed.timeoutRecoveryIssuance.rawSha256,
        }
      : {}),
    repair_manifest_sha256: shard.repair?.manifestSha256 || null,
    repair_receipt_sha256: shard.repair?.receiptSha256 || null,
  };
}

async function verifyIdempotentArchivedTimeoutRecoveryEvidence(receipt, receiptPath, shards) {
  const timeoutShards = shards.filter((shard) => shard.seed?.timeoutRecovery);
  const sourceEvidence = requireObject(receipt.source_evidence, 'receiver receipt source_evidence');
  if (!Array.isArray(sourceEvidence.shards)
    || sourceEvidence.shards.length !== shards.length) {
    throw new Error('receiver receipt archived shard evidence is invalid');
  }
  for (let index = 0; index < shards.length; index += 1) {
    const archivedShard = requireObject(
      sourceEvidence.shards[index],
      `receiver receipt archived shard ${index + 1}`,
    );
    if (archivedShard.source_root !== shards[index].root
      || Boolean(archivedShard.seed_lineage?.timeout_recovery)
        !== Boolean(shards[index].seed?.timeoutRecovery)) {
      throw new Error('receiver receipt archived shard timeout recovery mapping differs from current shards');
    }
  }
  if (timeoutShards.length === 0) return;
  const receiptDirectory = path.dirname(receiptPath);
  const canonicalReceiptDirectory = await realpath(receiptDirectory);
  if (canonicalReceiptDirectory !== receiptDirectory) {
    throw new Error('receiver receipt evidence root must be a canonical real directory');
  }
  const requireCanonicalArchiveDirectory = async (root, label) => {
    const info = await lstat(root).catch((error) => {
      if (error?.code === 'ENOENT') throw new Error(`${label} is missing`);
      throw error;
    });
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`${label} must be a real directory`);
    }
    const canonicalRoot = await realpath(root);
    if (canonicalRoot !== root || !isWithin(canonicalReceiptDirectory, canonicalRoot)) {
      throw new Error(`${label} must be canonical and contained by the receipt evidence root`);
    }
    return canonicalRoot;
  };
  const requireExactArchiveEntries = async (root, expected, label) => {
    await requireCanonicalArchiveDirectory(root, label);
    const entries = await readdir(root, { withFileTypes: true });
    if (!sameJson(entries.map((entry) => entry.name).sort(), [...expected].sort())) {
      throw new Error(`${label} contains missing or unexpected entries`);
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error(`${label} contains a symbolic link`);
    }
  };
  const readStableArchivedAuthorityFile = async (pathname, label) => {
    const parent = path.dirname(pathname);
    await requireCanonicalArchiveDirectory(parent, `${label} parent`);
    const before = await stat(parent, { bigint: true });
    const stable = await readStableAuthorityFile(pathname, label);
    const [after, canonicalAfter] = await Promise.all([
      stat(parent, { bigint: true }),
      realpath(parent),
    ]);
    if (canonicalAfter !== parent
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs) {
      throw new Error(`${label} parent changed while the archived file was read`);
    }
    return stable;
  };
  const verifyArchivedFile = async (recordValue, expectedPath, expectedSha256, label) => {
    const record = requireObject(recordValue, label);
    if (record.path !== expectedPath || record.sha256 !== expectedSha256) {
      throw new Error(`${label} path or fingerprint differs from the applied receipt`);
    }
    if (!isWithin(receiptDirectory, record.path)) {
      throw new Error(`${label} escapes the receipt evidence root`);
    }
    const stable = await readStableArchivedAuthorityFile(record.path, label);
    if (stable.digest !== expectedSha256) {
      throw new Error(`${label} differs from the applied receipt`);
    }
    return stable;
  };
  for (const shard of timeoutShards) {
    const evidenceIndex = sourceEvidence.shards.findIndex(
      (candidate) => candidate?.source_root === shard.root,
    );
    if (evidenceIndex < 0) {
      throw new Error(`archived timeout recovery evidence is missing for ${shard.root}`);
    }
    const archivedShard = sourceEvidence.shards[evidenceIndex];
    const seedLineage = requireObject(
      archivedShard.seed_lineage,
      `archived timeout recovery seed lineage for ${shard.root}`,
    );
    const timeoutEvidence = requireObject(
      seedLineage.timeout_recovery,
      `archived timeout recovery evidence for ${shard.root}`,
    );
    const archiveRoot = path.join(
      receiptDirectory,
      'source-evidence',
      `shard-${String(evidenceIndex + 1).padStart(2, '0')}`,
      'seed-lineage',
      'timeout-recovery',
    );
    await requireExactArchiveEntries(archiveRoot, [
      timeoutRecoveryGrantFilename,
      `${timeoutRecoveryGrantFilename}.sha256`,
      timeoutRecoveryIssuanceDirectory,
      timeoutRecoveryLedgerIdentityFilename,
      `${timeoutRecoveryLedgerIdentityFilename}.sha256`,
      timeoutRecoveryClaimFilename,
      `${timeoutRecoveryClaimFilename}.sha256`,
    ], 'archived timeout recovery root');
    await verifyArchivedFile(
      timeoutEvidence.grant,
      path.join(archiveRoot, timeoutRecoveryGrantFilename),
      shard.seed.timeoutRecovery.rawSha256,
      'archived timeout recovery grant',
    );
    await verifyArchivedFile(
      timeoutEvidence.sidecar,
      path.join(archiveRoot, `${timeoutRecoveryGrantFilename}.sha256`),
      shard.seed.timeoutRecovery.sidecarSha256,
      'archived timeout recovery grant sidecar',
    );
    await verifySha256Sidecar(timeoutEvidence.grant.path, 'archived timeout recovery grant');
    if (timeoutEvidence.grant_id !== shard.seed.timeoutRecovery.grant.grant_id) {
      throw new Error('archived timeout recovery grant ID differs from current staging');
    }
    const issuanceBasename = path.basename(shard.seed.timeoutRecoveryIssuance.path);
    const issuanceArchiveRoot = path.join(archiveRoot, timeoutRecoveryIssuanceDirectory);
    await requireExactArchiveEntries(
      issuanceArchiveRoot,
      [issuanceBasename, `${issuanceBasename}.sha256`],
      'archived timeout recovery issuance root',
    );
    await verifyArchivedFile(
      timeoutEvidence.issuance,
      path.join(issuanceArchiveRoot, issuanceBasename),
      shard.seed.timeoutRecoveryIssuance.rawSha256,
      'archived timeout recovery issuance claim',
    );
    await verifyArchivedFile(
      timeoutEvidence.issuance_sidecar,
      path.join(issuanceArchiveRoot, `${issuanceBasename}.sha256`),
      shard.seed.timeoutRecoveryIssuance.sidecarSha256,
      'archived timeout recovery issuance claim sidecar',
    );
    await verifySha256Sidecar(
      timeoutEvidence.issuance.path,
      'archived timeout recovery issuance claim',
    );
    if (timeoutEvidence.issuance_claim_key
      !== shard.seed.timeoutRecoveryIssuance.claim.claim_key) {
      throw new Error('archived timeout recovery issuance claim key differs from current staging');
    }
    await verifyArchivedFile(
      timeoutEvidence.ledger_identity,
      path.join(archiveRoot, timeoutRecoveryLedgerIdentityFilename),
      shard.seed.timeoutRecoveryConsumption.ledgerSha256,
      'archived timeout recovery ledger identity',
    );
    await verifyArchivedFile(
      timeoutEvidence.ledger_identity_sidecar,
      path.join(archiveRoot, `${timeoutRecoveryLedgerIdentityFilename}.sha256`),
      shard.seed.timeoutRecoveryConsumption.ledgerSidecarSha256,
      'archived timeout recovery ledger identity sidecar',
    );
    await verifySha256Sidecar(
      timeoutEvidence.ledger_identity.path,
      'archived timeout recovery ledger identity',
    );
    await verifyArchivedFile(
      timeoutEvidence.claim,
      path.join(archiveRoot, timeoutRecoveryClaimFilename),
      shard.seed.timeoutRecoveryConsumption.claimSha256,
      'archived timeout recovery consumption claim',
    );
    await verifyArchivedFile(
      timeoutEvidence.claim_sidecar,
      path.join(archiveRoot, `${timeoutRecoveryClaimFilename}.sha256`),
      shard.seed.timeoutRecoveryConsumption.claimSidecarSha256,
      'archived timeout recovery consumption claim sidecar',
    );
    await verifySha256Sidecar(
      timeoutEvidence.claim.path,
      'archived timeout recovery consumption claim',
    );
    const predecessorControls = requireObject(
      seedLineage.predecessor_controls,
      `archived timeout recovery predecessor controls for ${shard.root}`,
    );
    const expectedControlsPath = path.join(
      receiptDirectory,
      'source-evidence',
      `shard-${String(evidenceIndex + 1).padStart(2, '0')}`,
      'seed-lineage',
      'predecessor-controls',
    );
    if (predecessorControls.path !== expectedControlsPath
      || !isWithin(receiptDirectory, predecessorControls.path)) {
      throw new Error('archived timeout recovery predecessor controls path is invalid');
    }
    await requireCanonicalArchiveDirectory(
      predecessorControls.path,
      'archived timeout recovery predecessor controls',
    );
    const controlsTree = await inspectTree(predecessorControls.path);
    const expectedControlsTree = {
      tree_sha256: shard.seed.predecessorEvidence.contract.tree_sha256,
      files: shard.seed.predecessorEvidence.contract.files,
      bytes: shard.seed.predecessorEvidence.contract.bytes,
    };
    if (!sameJson(controlsTree, expectedControlsTree)
      || predecessorControls.tree_sha256 !== controlsTree.tree_sha256
      || predecessorControls.files !== controlsTree.files
      || predecessorControls.bytes !== controlsTree.bytes
      || predecessorControls.inventory_sha256
        !== shard.seed.predecessorEvidence.contract.inventory_sha256) {
      throw new Error('archived timeout recovery predecessor controls differ from current staging');
    }
    const inventoryPath = path.join(predecessorControls.path, 'inventory.json');
    await requireRegularNonSymlink(inventoryPath, 'archived timeout recovery predecessor inventory');
    if (await sha256File(inventoryPath) !== predecessorControls.inventory_sha256) {
      throw new Error('archived timeout recovery predecessor inventory differs from the receipt');
    }
    for (const grantDocument of shard.seed.timeoutRecovery.grant.documents) {
      const logPath = path.join(predecessorControls.path, grantDocument.timeout_log.path);
      const stableLog = await readStableArchivedAuthorityFile(
        logPath,
        `${grantDocument.document_id} archived timeout recovery log`,
      );
      if (!isWithin(predecessorControls.path, logPath)
        || stableLog.bytes !== grantDocument.timeout_log.bytes
        || stableLog.digest !== grantDocument.timeout_log.sha256) {
        throw new Error(`${grantDocument.document_id}: archived timeout recovery log differs from the grant`);
      }
      const receiptDocument = shard.seed.receipt.documents.find(
        (document) => document.document_id === grantDocument.document_id,
      );
      const incidentSummary = validateTimeoutRecoveryIncidentSummary(
        receiptDocument?.timeout_recovery?.predecessor_incident,
        grantDocument,
      );
      const relativeIncident = incidentSummary.path.slice(
        `${seedPredecessorEvidenceDirectory}/`.length,
      );
      const relativeSidecar = incidentSummary.sidecar_path.slice(
        `${seedPredecessorEvidenceDirectory}/`.length,
      );
      const archivedIncident = path.join(predecessorControls.path, relativeIncident);
      const archivedSidecar = path.join(predecessorControls.path, relativeSidecar);
      const stableIncident = await readStableArchivedAuthorityFile(
        archivedIncident,
        `${grantDocument.document_id} archived timeout incident`,
      );
      const stableSidecar = await readStableArchivedAuthorityFile(
        archivedSidecar,
        `${grantDocument.document_id} archived timeout incident sidecar`,
      );
      if (stableIncident.digest !== incidentSummary.raw_sha256
        || stableSidecar.digest !== incidentSummary.sidecar_sha256) {
        throw new Error(`${grantDocument.document_id}: archived timeout incident differs from receipt`);
      }
      await verifySha256Sidecar(
        archivedIncident,
        `${grantDocument.document_id} archived timeout incident`,
      );
    }
  }
}

async function findIdempotentReceipt(
  normalized,
  parentManifestSha256,
  shards,
  documents,
  runnerCompatibility,
) {
  const receiptRootInfo = await lstatIfPresent(normalized.receiptRoot);
  if (!receiptRootInfo) return null;
  if (!receiptRootInfo.isDirectory() || receiptRootInfo.isSymbolicLink()) {
    throw new Error(`remote OCR receipt root is not a real directory: ${normalized.receiptRoot}`);
  }
  const expectedShardFingerprints = shards
    .map(sourceShardFingerprint)
    .sort((left, right) => left.root < right.root ? -1 : left.root > right.root ? 1 : 0);
  const candidates = [];
  const entries = await readdir(normalized.receiptRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const receiptPath = path.join(normalized.receiptRoot, entry.name, 'receipt.json');
    if (!(await exists(receiptPath))) continue;
    let receipt;
    try {
      ({ value: receipt } = await readJsonWithRaw(receiptPath, 'receiver receipt'));
    } catch {
      continue;
    }
    if (receipt?.parent_manifest_sha256 !== parentManifestSha256 || receipt.status !== 'applied') continue;
    await verifySha256Sidecar(receiptPath, 'receiver receipt');
    if (receipt.destination?.production_root !== normalized.productionRoot
      || receipt.destination?.text_root !== normalized.textRoot
      || receipt.destination?.supervisor_root !== normalized.supervisorRoot
      || receipt.destination?.receipt_root !== normalized.receiptRoot) {
      continue;
    }
    if (receipt.schema_version !== 1
      || receipt.receipt_type !== 'curriculum_remote_ocr_whole_document_atomic_receive'
      || receipt.citation_allowed !== false
      || receipt.dry_run !== false
      || !Array.isArray(receipt.source_shards)
      || !Array.isArray(receipt.documents)) {
      throw new Error(`matching receiver receipt is invalid: ${receiptPath}`);
    }
    if (runnerCompatibility) {
      validateDirectedRunnerCompatibilityEvidence(receipt.source_shard_compatibility);
      if (!sameJson(receipt.source_shard_compatibility, runnerCompatibility)) {
        throw new Error('matching receiver receipt directed runner compatibility evidence differs');
      }
    } else if (receipt.source_shard_compatibility !== undefined) {
      throw new Error('matching receiver receipt has unexpected runner compatibility evidence');
    }
    await verifyIdempotentArchivedTimeoutRecoveryEvidence(
      receipt,
      receiptPath,
      shards,
    );
    await verifyRetryLedgerReceiptState(receipt);
    const actualShardFingerprints = receipt.source_shards
      .map((shard) => ({
        root: shard.root,
        manifest_sha256: shard.manifest_sha256,
        run_identity_sha256: shard.run_identity_sha256,
        run_status_sha256: shard.run_status_sha256,
        runtime_fingerprint_sha256: shard.runtime_fingerprint_sha256,
        seed_id: shard.seed_id || null,
        seed_receipt_sha256: shard.seed_receipt_sha256 || null,
        seed_commit_marker_sha256: shard.seed_commit_marker_sha256 || null,
        ...(shard.timeout_recovery_grant_sha256
          ? {
              timeout_recovery_grant_sha256: shard.timeout_recovery_grant_sha256,
              timeout_recovery_issuance_sha256: shard.timeout_recovery_issuance_sha256,
            }
          : {}),
        repair_manifest_sha256: shard.repair_manifest_sha256 || null,
        repair_receipt_sha256: shard.repair_receipt_sha256 || null,
      }))
      .sort((left, right) => left.root < right.root ? -1 : left.root > right.root ? 1 : 0);
    if (!sameJson(actualShardFingerprints, expectedShardFingerprints)) {
      throw new Error('matching receiver receipt source shard fingerprints differ from current staging');
    }
    const expectedDocumentIds = documents.map((item) => item.document.id).sort();
    const receiptDocumentIds = receipt.documents.map((item) => item?.document_id).sort();
    if (new Set(receiptDocumentIds).size !== receiptDocumentIds.length
      || !sameJson(receiptDocumentIds, expectedDocumentIds)) {
      throw new Error('matching receiver receipt document set differs from current staging');
    }
    for (const item of documents) {
      const receiptDocument = receipt.documents.find((entryValue) => entryValue.document_id === item.document.id);
      const replacingExistingDocument = item.document.planning_snapshot?.mode === LOCAL_REPROCESS_SNAPSHOT_MODE;
      const targetDocumentPath = path.join(normalized.productionRoot, item.document.id);
      const targetTextPath = path.join(normalized.textRoot, `${item.document.id}.txt`);
      if (!receiptDocument
        || receiptDocument.source_document_tree_sha256 !== item.sourceTree.tree_sha256
        || receiptDocument.source_state_sha256 !== item.validation.state_sha256
        || receiptDocument.source_page_artifacts_sha256 !== item.validation.page_artifacts_sha256
        || receiptDocument.source_native_markdown_trees_sha256 !== item.nativeMarkdownTreesSha256
        || receiptDocument.source_native_markdown_asset_count !== item.nativeAssetCount
        || receiptDocument.source_native_markdown_asset_bytes !== item.nativeAssetBytes
        || receiptDocument.target_document_path !== targetDocumentPath
        || receiptDocument.target_document_tree_sha256 !== item.sourceTree.tree_sha256
        || receiptDocument.target_text_path !== targetTextPath
        || receiptDocument.target_text_sha256 !== item.textSha256
        || receiptDocument.repair_pages !== item.repairPageCount
        || !sameJson(
          receiptDocument.timeout_recovery,
          timeoutRecoveryReceiptDocument(
            item.shard.seed?.receipt.documents.find(
              (document) => document.document_id === item.document.id,
            ),
          ) || undefined,
        )
        || receiptDocument.citation_allowed !== false
        || receiptDocument.replacement_mode !== (
          replacingExistingDocument
            ? LOCAL_REPROCESS_SNAPSHOT_MODE
            : 'install_into_absent_destination'
        )
        || receiptDocument.planned_local_snapshot_sha256 !== (
          replacingExistingDocument
            ? item.document.planning_snapshot.snapshot_sha256
            : null
        )) {
        throw new Error(`${item.document.id}: matching receiver receipt differs from current staging`);
      }
      if (replacingExistingDocument) {
        const previousDocument = requireObject(
          receiptDocument.previous_document,
          `${item.document.id} receipt previous_document`,
        );
        if (previousDocument.existed !== true
          || previousDocument.tree_sha256 !== item.document.planning_snapshot.document_tree.tree_sha256
          || previousDocument.files !== item.document.planning_snapshot.document_tree.files
          || previousDocument.bytes !== item.document.planning_snapshot.document_tree.bytes
          || typeof previousDocument.backup_path !== 'string') {
          throw new Error(`${item.document.id}: matching receiver receipt original document snapshot differs`);
        }
        const backupTree = await inspectTree(previousDocument.backup_path);
        if (!sameJson(backupTree, item.document.planning_snapshot.document_tree)) {
          throw new Error(`${item.document.id}: preserved original document backup differs from the planning snapshot`);
        }
      } else if (receiptDocument.previous_document?.existed !== false) {
        throw new Error(`${item.document.id}: matching receiver receipt unexpectedly records an original document`);
      }
      const expectedPreviousText = replacingExistingDocument
        ? {
            existed: item.document.planning_snapshot.text.exists,
            sha256: item.document.planning_snapshot.text.sha256,
            bytes: item.document.planning_snapshot.text.bytes,
          }
        : receiptDocument.previous_text;
      if (receiptDocument.previous_text?.existed !== expectedPreviousText.existed
        || receiptDocument.previous_text?.sha256 !== expectedPreviousText.sha256
        || receiptDocument.previous_text?.bytes !== expectedPreviousText.bytes) {
        throw new Error(`${item.document.id}: matching receiver receipt original text snapshot differs`);
      }
      if (receiptDocument.previous_text.existed) {
        const backupInfo = await lstatIfPresent(receiptDocument.previous_text.backup_path);
        if (!backupInfo || !backupInfo.isFile() || backupInfo.isSymbolicLink()
          || backupInfo.size !== receiptDocument.previous_text.bytes
          || await sha256File(receiptDocument.previous_text.backup_path) !== receiptDocument.previous_text.sha256) {
          throw new Error(`${item.document.id}: preserved original text backup differs from the planning snapshot`);
        }
      }
      const textInfo = await lstatIfPresent(targetTextPath);
      if (!textInfo || !textInfo.isFile() || textInfo.isSymbolicLink()) {
        throw new Error(`${item.document.id}: idempotent target text is missing or invalid`);
      }
      const [targetTree, targetTextSha256] = await Promise.all([
        inspectTree(targetDocumentPath),
        sha256File(targetTextPath),
      ]);
      if (targetTree.tree_sha256 !== item.sourceTree.tree_sha256 || targetTextSha256 !== item.textSha256) {
        throw new Error(`${item.document.id}: idempotent target hashes differ from the applied receipt`);
      }
    }
    candidates.push({ ...receipt, receipt_path: receiptPath });
  }
  if (candidates.length > 1) {
    throw new Error('multiple applied receiver receipts match the same parent manifest and destination');
  }
  return candidates[0] || null;
}

async function readJsonIfPresent(pathname) {
  if (!(await exists(pathname))) return {};
  const { value } = await readJsonWithRaw(pathname);
  return requireObject(value, pathname);
}

async function inspectLocalPreconditions(documents, roots, expectedSnapshots = null) {
  for (const lockName of ['lock', 'drain-lock']) {
    if (await lstatIfPresent(path.join(roots.supervisorRoot, lockName))) {
      throw new Error(`local OCR ${lockName} is active; remote receipt cannot race an OCR owner`);
    }
  }
  const watchdogControlPath = path.join(roots.supervisorRoot, 'watchdog-control.json');
  const watchdogControl = await readJsonIfPresent(watchdogControlPath);
  const supervisorSnapshot = {
    ocr_lock_absent: true,
    drain_lock_absent: true,
    watchdog_mode: Object.keys(watchdogControl).length ? watchdogControl.mode : 'absent',
  };
  if (!['absent', 'hold'].includes(supervisorSnapshot.watchdog_mode)) {
    throw new Error(`local OCR watchdog must be held before remote receipt; current mode=${supervisorSnapshot.watchdog_mode}`);
  }
  if (expectedSnapshots?.supervisor && !sameJson(supervisorSnapshot, expectedSnapshots.supervisor)) {
    throw new Error('local OCR ownership state changed after receipt planning');
  }
  const [documentRetries, pageRetries] = await Promise.all([
    readJsonIfPresent(path.join(roots.supervisorRoot, 'retries.json')),
    readJsonIfPresent(path.join(roots.supervisorRoot, 'page-retries.json')),
  ]);
  const snapshots = new Map();
  for (const item of documents) {
    const { id } = item.document;
    const replacementMode = item.document.planning_snapshot?.mode === LOCAL_REPROCESS_SNAPSHOT_MODE;
    const productionPath = path.join(roots.productionRoot, id);
    const productionInfo = await lstatIfPresent(productionPath);
    const textPath = path.join(roots.textRoot, `${id}.txt`);
    if (replacementMode) {
      if (!productionInfo || !productionInfo.isDirectory() || productionInfo.isSymbolicLink()) {
        throw new Error(`${id}: snapshotted local production document is missing or is not a real directory`);
      }
      const current = await captureLocalReprocessSnapshot({
        document: item.document,
        documentRoot: productionPath,
        textPath,
        documentRetries,
        pageRetries,
      });
      if (!sameJson(current, item.document.planning_snapshot)) {
        throw new Error(`${id}: local reprocess snapshot changed after planning`);
      }
      const snapshot = {
        mode: LOCAL_REPROCESS_SNAPSHOT_MODE,
        production_absent: false,
        retries_absent: current.retry_ledger.document.present === false
          && current.retry_ledger.pages.count === 0,
        planning_snapshot: current,
        production: {
          path: productionPath,
          ...current.document_tree,
        },
        text: {
          path: textPath,
          ...current.text,
        },
      };
      const expected = expectedSnapshots?.get(id);
      if (expected && !sameJson(snapshot, expected)) {
        throw new Error(`${id}: local destination changed after receipt planning`);
      }
      snapshots.set(id, snapshot);
      continue;
    }

    if (productionInfo) {
      if (productionInfo.isSymbolicLink()) throw new Error(`${id}: local production destination is a symbolic link`);
      let completedPages = null;
      const statePath = path.join(productionPath, 'state.json');
      if (await exists(statePath)) {
        const { value: state } = await readJsonWithRaw(statePath, `${id} local OCR state`);
        completedPages = Array.isArray(state.completed_pages) ? state.completed_pages.length : null;
      }
      throw new Error(`${id}: local production destination already exists${completedPages === null ? '' : ` with ${completedPages} completed pages`}`);
    }
    if (documentRetries[id]) throw new Error(`${id}: local document retry record conflicts with remote receipt`);
    const pageRetryKeys = Object.keys(pageRetries).filter((key) => key.startsWith(`${id}:`));
    if (pageRetryKeys.length) throw new Error(`${id}: local page retry records conflict with remote receipt`);

    let text = { exists: false, path: textPath, bytes: 0, sha256: null };
    const info = await lstatIfPresent(textPath);
    if (info) {
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${id}: local text destination is not a regular file`);
      text = { exists: true, path: textPath, bytes: info.size, sha256: await sha256File(textPath) };
    }
    const snapshot = {
      mode: 'require_absent',
      production_absent: true,
      retries_absent: true,
      production: null,
      text,
    };
    const expected = expectedSnapshots?.get(id);
    if (expected && !sameJson(snapshot, expected)) throw new Error(`${id}: local destination changed after receipt planning`);
    snapshots.set(id, snapshot);
  }
  const [currentDocumentRetries, currentPageRetries] = await Promise.all([
    readJsonIfPresent(path.join(roots.supervisorRoot, 'retries.json')),
    readJsonIfPresent(path.join(roots.supervisorRoot, 'page-retries.json')),
  ]);
  if (!sameJson(currentDocumentRetries, documentRetries) || !sameJson(currentPageRetries, pageRetries)) {
    throw new Error('local OCR retry ledger changed while receipt preconditions were inspected');
  }
  snapshots.supervisor = supervisorSnapshot;
  return snapshots;
}

async function normalizeOptions(options) {
  const projectRoot = await realpath(path.resolve(options.projectRoot || defaultProjectRoot));
  const projectInfo = await stat(projectRoot);
  if (!projectInfo.isDirectory()) throw new Error('--project-root must be a directory');
  const resolveRoot = (value, fallback) => resolveWithNearestExistingParent(
    path.resolve(projectRoot, value || fallback),
  );
  const [productionRoot, textRoot, supervisorRoot, receiptRoot] = await Promise.all([
    resolveRoot(options.productionRoot, '.cache/ocr-production'),
    resolveRoot(options.textRoot, '.cache/text'),
    resolveRoot(options.supervisorRoot, '.cache/ocr-supervisor'),
    resolveRoot(options.receiptRoot, '.cache/ocr-receipts'),
  ]);
  if (!options.manifest) throw new Error('--manifest is required');
  if (!Array.isArray(options.shards) || options.shards.length === 0) {
    throw new Error('at least one --shard-manifest/--shard-root pair is required');
  }
  const normalized = {
    manifest: path.resolve(options.manifest),
    shards: options.shards.map((shard) => ({
      manifestPath: path.resolve(shard.manifestPath),
      root: path.resolve(shard.root),
      repairManifestPath: shard.repairManifestPath ? path.resolve(shard.repairManifestPath) : null,
    })),
    projectRoot,
    productionRoot,
    textRoot,
    supervisorRoot,
    receiptRoot,
    python: path.resolve(options.python || '/Users/ylsuen/.venv/bin/python'),
    apply: options.apply === true,
  };
  const destinationRoots = [
    ['productionRoot', normalized.productionRoot],
    ['textRoot', normalized.textRoot],
    ['supervisorRoot', normalized.supervisorRoot],
    ['receiptRoot', normalized.receiptRoot],
  ];
  for (const [name, root] of destinationRoots) {
    if (!isWithin(projectRoot, root)) throw new Error(`${name} must remain inside --project-root`);
  }
  for (let leftIndex = 0; leftIndex < destinationRoots.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < destinationRoots.length; rightIndex += 1) {
      const [leftName, leftRoot] = destinationRoots[leftIndex];
      const [rightName, rightRoot] = destinationRoots[rightIndex];
      if (isWithin(leftRoot, rightRoot) || isWithin(rightRoot, leftRoot)) {
        throw new Error(`${leftName} and ${rightName} must not overlap`);
      }
    }
  }
  return normalized;
}

async function prepareReceiptPlan(options, dependencies = {}) {
  const normalized = await normalizeOptions(options);
  await requireRegularNonSymlink(normalized.manifest, 'parent manifest');
  const { raw: parentRaw, value: parentManifest } = await readJsonWithRaw(normalized.manifest, 'parent manifest');
  validateRemoteOcrManifest(parentManifest);
  const parentManifestSha256 = sha256(parentRaw);
  const shards = [];
  for (const shardOption of normalized.shards) shards.push(await loadShard(shardOption));
  const { runnerCompatibility } = validateShardUnion(parentManifest, shards);

  const documents = [];
  for (const shard of shards) {
    documents.push(...await validateShardDocuments(
      shard,
      normalized.projectRoot,
      normalized.python,
      dependencies,
    ));
  }
  documents.sort((left, right) => left.document.id < right.document.id ? -1 : left.document.id > right.document.id ? 1 : 0);
  const idempotentReceipt = await findIdempotentReceipt(
    normalized,
    parentManifestSha256,
    shards,
    documents,
    runnerCompatibility,
  );
  if (idempotentReceipt) {
    return {
      normalized,
      parentManifest,
      parentManifestSha256,
      shards,
      documents,
      runnerCompatibility,
      idempotentReceipt,
      localSnapshots: null,
    };
  }
  const localSnapshots = await inspectLocalPreconditions(documents, normalized);
  return {
    normalized,
    parentManifest,
    parentManifestSha256,
    shards,
    documents,
    runnerCompatibility,
    idempotentReceipt: null,
    localSnapshots,
  };
}

function receiptDocument(item, localSnapshot, roots, receiptDirectory) {
  const destinationDocument = path.join(roots.productionRoot, item.document.id);
  const destinationText = path.join(roots.textRoot, `${item.document.id}.txt`);
  const replacingExistingDocument = localSnapshot.mode === LOCAL_REPROCESS_SNAPSHOT_MODE;
  const previousDocumentBackup = replacingExistingDocument
    ? path.join(receiptDirectory, 'backups', 'production', item.document.id)
    : null;
  const previousTextBackup = localSnapshot.text.exists
    ? path.join(receiptDirectory, 'backups', 'text', `${item.document.id}.txt`)
    : null;
  const timeoutRecovery = timeoutRecoveryReceiptDocument(
    item.shard.seed?.receipt.documents.find((document) => document.document_id === item.document.id),
  );
  return {
    document_id: item.document.id,
    page_count: item.document.page_count,
    source_shard_root: item.shard.root,
    source_shard_manifest_sha256: item.shard.manifestSha256,
    source_run_identity_sha256: item.shard.identitySha256,
    source_run_status_sha256: item.shard.runStatusSha256,
    source_document_status: item.status,
    source_document_status_sha256: item.statusSha256,
    source_pdf_sha256: item.document.source_sha256,
    source_document_tree_sha256: item.sourceTree.tree_sha256,
    source_document_tree_files: item.sourceTree.files,
    source_document_tree_bytes: item.sourceTree.bytes,
    source_state_sha256: item.validation.state_sha256,
    source_page_artifacts_sha256: item.validation.page_artifacts_sha256,
    source_native_markdown_trees_sha256: item.nativeMarkdownTreesSha256,
    source_native_markdown_asset_count: item.nativeAssetCount,
    source_native_markdown_asset_bytes: item.nativeAssetBytes,
    repair_pages: item.repairPageCount,
    ...(timeoutRecovery ? { timeout_recovery: timeoutRecovery } : {}),
    citation_allowed: false,
    target_document_path: destinationDocument,
    target_document_tree_sha256: item.sourceTree.tree_sha256,
    target_text_path: destinationText,
    target_text_sha256: item.textSha256,
    target_text_bytes: item.text.length,
    replacement_mode: replacingExistingDocument
      ? LOCAL_REPROCESS_SNAPSHOT_MODE
      : 'install_into_absent_destination',
    planned_local_snapshot_sha256: replacingExistingDocument
      ? localSnapshot.planning_snapshot.snapshot_sha256
      : null,
    previous_document: {
      existed: replacingExistingDocument,
      tree_sha256: localSnapshot.production?.tree_sha256 || null,
      files: localSnapshot.production?.files || 0,
      bytes: localSnapshot.production?.bytes || 0,
      backup_path: previousDocumentBackup,
    },
    previous_text: {
      existed: localSnapshot.text.exists,
      sha256: localSnapshot.text.sha256,
      bytes: localSnapshot.text.bytes,
      backup_path: previousTextBackup,
    },
    rollback: {
      verify_target_document_tree_sha256: item.sourceTree.tree_sha256,
      document_action: replacingExistingDocument ? 'restore_verified_backup' : 'remove_new_tree',
      restore_document_from: previousDocumentBackup,
      restore_document_tree_sha256: localSnapshot.production?.tree_sha256 || null,
      target_document_path: destinationDocument,
      verify_target_text_sha256: item.textSha256,
      text_action: localSnapshot.text.exists ? 'restore_verified_backup' : 'remove_new_file',
      restore_text_from: previousTextBackup,
      restore_text_sha256: localSnapshot.text.sha256,
    },
  };
}

async function acquireReceiverLock(receiptRoot, token) {
  await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
  const lockPath = path.join(receiptRoot, '.receiver.lock');
  const handle = await open(lockPath, 'wx', 0o600).catch((error) => {
    if (error?.code === 'EEXIST') throw new Error(`remote OCR receiver lock already exists: ${lockPath}`);
    throw error;
  });
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, started_at: new Date().toISOString() })}\n`);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
    throw error;
  }
  return async () => {
    let owned = false;
    try {
      const current = JSON.parse(await readFile(lockPath, 'utf8'));
      owned = current.token === token;
    } catch {}
    await handle.close().catch(() => {});
    if (owned) await rm(lockPath, { force: true }).catch(() => {});
  };
}

async function copyVerifiedEvidence(source, destination, expectedSha256, label) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  const copiedSha256 = await sha256File(destination);
  if (copiedSha256 !== expectedSha256) throw new Error(`${label} changed while receipt evidence was copied`);
  return { path: destination, sha256: copiedSha256 };
}

async function archiveSourceEvidence(plan, receiptDirectory) {
  const evidenceRoot = path.join(receiptDirectory, 'source-evidence');
  const parent = await copyVerifiedEvidence(
    plan.normalized.manifest,
    path.join(evidenceRoot, 'parent-manifest.json'),
    plan.parentManifestSha256,
    'parent manifest',
  );
  const shards = [];
  for (let index = 0; index < plan.shards.length; index += 1) {
    const shard = plan.shards[index];
    const shardRoot = path.join(evidenceRoot, `shard-${String(index + 1).padStart(2, '0')}`);
    const manifest = await copyVerifiedEvidence(
      shard.manifestPath,
      path.join(shardRoot, 'manifest.json'),
      shard.manifestSha256,
      `shard ${index + 1} manifest`,
    );
    const identity = await copyVerifiedEvidence(
      path.join(shard.root, 'run-identity.json'),
      path.join(shardRoot, 'run-identity.json'),
      shard.identitySha256,
      `shard ${index + 1} run identity`,
    );
    const runStatus = await copyVerifiedEvidence(
      path.join(shard.root, 'run-status.json'),
      path.join(shardRoot, 'run-status.json'),
      shard.runStatusSha256,
      `shard ${index + 1} run status`,
    );
    await copyFile(
      path.join(shard.root, 'run-status.json.sha256'),
      path.join(shardRoot, 'run-status.json.sha256'),
      fsConstants.COPYFILE_EXCL,
    );
    await verifySha256Sidecar(path.join(shardRoot, 'run-status.json'), `archived shard ${index + 1} run status`);
    let seedEvidence = null;
    if (shard.seed) {
      const seedRoot = path.join(shardRoot, 'seed-lineage');
      const seedReceipt = await copyVerifiedEvidence(
        shard.seed.receiptPath,
        path.join(seedRoot, 'seed-receipt.json'),
        shard.seed.receiptSha256,
        `shard ${index + 1} seed receipt`,
      );
      const seedMarker = await copyVerifiedEvidence(
        shard.seed.markerPath,
        path.join(seedRoot, 'seed-commit.json'),
        shard.seed.markerSha256,
        `shard ${index + 1} seed commit marker`,
      );
      for (const item of [seedReceipt, seedMarker]) {
        await atomicWrite(`${item.path}.sha256`, `${item.sha256}  ${path.basename(item.path)}\n`);
        await verifySha256Sidecar(item.path, `archived shard ${index + 1} ${path.basename(item.path)}`);
      }
      let timeoutRecoveryEvidence = null;
      if (shard.seed.timeoutRecovery) {
        const timeoutRecoveryRoot = path.join(seedRoot, 'timeout-recovery');
        const grant = await copyVerifiedEvidence(
          shard.seed.timeoutRecovery.path,
          path.join(timeoutRecoveryRoot, timeoutRecoveryGrantFilename),
          shard.seed.timeoutRecovery.rawSha256,
          `shard ${index + 1} timeout recovery grant`,
        );
        const sidecar = await copyVerifiedEvidence(
          shard.seed.timeoutRecovery.sidecarPath,
          path.join(timeoutRecoveryRoot, `${timeoutRecoveryGrantFilename}.sha256`),
          shard.seed.timeoutRecovery.sidecarSha256,
          `shard ${index + 1} timeout recovery grant sidecar`,
        );
        await verifySha256Sidecar(grant.path, `archived shard ${index + 1} timeout recovery grant`);
        const issuanceBasename = path.basename(shard.seed.timeoutRecoveryIssuance.path);
        const issuance = await copyVerifiedEvidence(
          shard.seed.timeoutRecoveryIssuance.path,
          path.join(timeoutRecoveryRoot, timeoutRecoveryIssuanceDirectory, issuanceBasename),
          shard.seed.timeoutRecoveryIssuance.rawSha256,
          `shard ${index + 1} timeout recovery issuance claim`,
        );
        const issuanceSidecar = await copyVerifiedEvidence(
          shard.seed.timeoutRecoveryIssuance.sidecarPath,
          path.join(
            timeoutRecoveryRoot,
            timeoutRecoveryIssuanceDirectory,
            `${issuanceBasename}.sha256`,
          ),
          shard.seed.timeoutRecoveryIssuance.sidecarSha256,
          `shard ${index + 1} timeout recovery issuance claim sidecar`,
        );
        await verifySha256Sidecar(
          issuance.path,
          `archived shard ${index + 1} timeout recovery issuance claim`,
        );
        const ledgerIdentity = await copyVerifiedEvidence(
          shard.seed.timeoutRecoveryConsumption.ledgerPath,
          path.join(timeoutRecoveryRoot, timeoutRecoveryLedgerIdentityFilename),
          shard.seed.timeoutRecoveryConsumption.ledgerSha256,
          `shard ${index + 1} timeout recovery ledger identity`,
        );
        const ledgerIdentitySidecar = await copyVerifiedEvidence(
          shard.seed.timeoutRecoveryConsumption.ledgerSidecarPath,
          path.join(timeoutRecoveryRoot, `${timeoutRecoveryLedgerIdentityFilename}.sha256`),
          shard.seed.timeoutRecoveryConsumption.ledgerSidecarSha256,
          `shard ${index + 1} timeout recovery ledger identity sidecar`,
        );
        await verifySha256Sidecar(
          ledgerIdentity.path,
          `archived shard ${index + 1} timeout recovery ledger identity`,
        );
        const claim = await copyVerifiedEvidence(
          shard.seed.timeoutRecoveryConsumption.claimPath,
          path.join(timeoutRecoveryRoot, timeoutRecoveryClaimFilename),
          shard.seed.timeoutRecoveryConsumption.claimSha256,
          `shard ${index + 1} timeout recovery consumption claim`,
        );
        const claimSidecar = await copyVerifiedEvidence(
          shard.seed.timeoutRecoveryConsumption.claimSidecarPath,
          path.join(timeoutRecoveryRoot, `${timeoutRecoveryClaimFilename}.sha256`),
          shard.seed.timeoutRecoveryConsumption.claimSidecarSha256,
          `shard ${index + 1} timeout recovery consumption claim sidecar`,
        );
        await verifySha256Sidecar(
          claim.path,
          `archived shard ${index + 1} timeout recovery consumption claim`,
        );
        timeoutRecoveryEvidence = {
          grant,
          sidecar,
          grant_id: shard.seed.timeoutRecovery.grant.grant_id,
          issuance,
          issuance_sidecar: issuanceSidecar,
          issuance_claim_key: shard.seed.timeoutRecoveryIssuance.claim.claim_key,
          ledger_identity: ledgerIdentity,
          ledger_identity_sidecar: ledgerIdentitySidecar,
          claim,
          claim_sidecar: claimSidecar,
        };
      }
      const predecessorControlsPath = path.join(seedRoot, 'predecessor-controls');
      await copyTreeStrict(shard.seed.predecessorEvidence.root, predecessorControlsPath);
      const predecessorControlsFingerprint = await inspectTree(predecessorControlsPath);
      const expectedPredecessorControlsFingerprint = {
        tree_sha256: shard.seed.predecessorEvidence.contract.tree_sha256,
        files: shard.seed.predecessorEvidence.contract.files,
        bytes: shard.seed.predecessorEvidence.contract.bytes,
      };
      if (!sameJson(predecessorControlsFingerprint, expectedPredecessorControlsFingerprint)) {
        throw new Error(`archived shard ${index + 1} predecessor controls differ from seed receipt`);
      }
      seedEvidence = {
        receipt: seedReceipt,
        commit_marker: seedMarker,
        predecessor_controls: {
          path: predecessorControlsPath,
          ...predecessorControlsFingerprint,
          inventory_sha256: shard.seed.predecessorEvidence.contract.inventory_sha256,
        },
        ...(timeoutRecoveryEvidence ? { timeout_recovery: timeoutRecoveryEvidence } : {}),
      };
    }
    let repairEvidence = null;
    if (shard.repair) {
      const repairRoot = path.join(shardRoot, 'repair-source');
      const repairManifest = await copyVerifiedEvidence(
        shard.repair.manifestPath,
        path.join(repairRoot, 'repair-manifest.json'),
        shard.repair.manifestSha256,
        `shard ${index + 1} repair manifest`,
      );
      await atomicWrite(
        `${repairManifest.path}.sha256`,
        `${repairManifest.sha256}  ${path.basename(repairManifest.path)}\n`,
      );
      await verifySha256Sidecar(repairManifest.path, `archived shard ${index + 1} repair manifest`);
      const evidence = [];
      for (const item of shard.repair.evidence) {
        const archived = await copyVerifiedEvidence(
          item.source_path,
          path.join(repairRoot, 'evidence', item.relative_path),
          item.sha256,
          `shard ${index + 1} repair evidence ${item.relative_path}`,
        );
        evidence.push({
          kind: item.kind,
          source_relative_path: item.relative_path,
          ...archived,
        });
      }
      const repairReceipt = await copyVerifiedEvidence(
        shard.repair.receiptPath,
        path.join(repairRoot, 'repair-receipt.json'),
        shard.repair.receiptSha256,
        `shard ${index + 1} repair receipt`,
      );
      await atomicWrite(
        `${repairReceipt.path}.sha256`,
        `${repairReceipt.sha256}  ${path.basename(repairReceipt.path)}\n`,
      );
      await verifySha256Sidecar(repairReceipt.path, `archived shard ${index + 1} repair receipt`);
      repairEvidence = {
        manifest: repairManifest,
        receipt: repairReceipt,
        evidence,
      };
    }
    const statuses = [];
    for (const item of plan.documents.filter((document) => document.shard === shard)) {
      const sourceStatus = path.join(shard.root, 'status', `${item.document.id}.json`);
      const destinationStatus = path.join(shardRoot, 'status', `${item.document.id}.json`);
      statuses.push({
        document_id: item.document.id,
        ...await copyVerifiedEvidence(
          sourceStatus,
          destinationStatus,
          item.statusSha256,
          `${item.document.id} document status`,
        ),
      });
      await copyFile(
        `${sourceStatus}.sha256`,
        `${destinationStatus}.sha256`,
        fsConstants.COPYFILE_EXCL,
      );
      await verifySha256Sidecar(destinationStatus, `archived ${item.document.id} document status`);
    }
    shards.push({
      source_root: shard.root,
      manifest,
      run_identity: identity,
      run_status: runStatus,
      seed_lineage: seedEvidence,
      repair: repairEvidence,
      statuses,
    });
  }
  return { parent_manifest: parent, shards };
}

async function readLedgerSnapshot(pathname, label) {
  const info = await lstatIfPresent(pathname);
  if (!info) {
    return {
      path: pathname,
      exists: false,
      bytes: 0,
      sha256: null,
      raw: null,
      value: {},
    };
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  const { raw, value } = await readJsonWithRaw(pathname, label);
  requireObject(value, label);
  return {
    path: pathname,
    exists: true,
    bytes: info.size,
    sha256: sha256(raw),
    raw,
    value,
  };
}

async function prepareRetryLedgerTransaction(plan, receiptDirectory, token) {
  const replacementIds = new Set(
    plan.documents
      .filter((item) => item.document.planning_snapshot?.mode === LOCAL_REPROCESS_SNAPSHOT_MODE)
      .map((item) => item.document.id),
  );
  if (replacementIds.size === 0) return null;
  await mkdir(plan.normalized.supervisorRoot, { recursive: true, mode: 0o700 });
  const specifications = [
    {
      name: 'document_retries',
      fileName: 'retries.json',
      filter: (key) => !replacementIds.has(key),
    },
    {
      name: 'page_retries',
      fileName: 'page-retries.json',
      filter: (key) => ![...replacementIds].some((documentId) => key.startsWith(`${documentId}:`)),
    },
  ];
  const ledgers = [];
  for (const specification of specifications) {
    const pathname = path.join(plan.normalized.supervisorRoot, specification.fileName);
    const before = await readLedgerSnapshot(pathname, specification.name);
    const afterValue = Object.fromEntries(
      Object.entries(before.value).filter(([key]) => specification.filter(key)),
    );
    const changed = !sameJson(afterValue, before.value);
    const afterRaw = changed
      ? Buffer.from(`${JSON.stringify(afterValue, null, 2)}\n`)
      : before.raw;
    const stagePath = changed
      ? path.join(plan.normalized.supervisorRoot, `.receive-${specification.fileName}-${token}`)
      : null;
    const backupPath = changed && before.exists
      ? path.join(receiptDirectory, 'backups', 'supervisor', specification.fileName)
      : null;
    if (changed) {
      await writeFile(stagePath, afterRaw, { flag: 'wx', mode: 0o600 });
      if (backupPath) {
        await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
        await copyFile(pathname, backupPath, fsConstants.COPYFILE_EXCL);
        if (await sha256File(backupPath) !== before.sha256) {
          throw new Error(`${specification.name} backup hash mismatch`);
        }
      }
    }
    ledgers.push({
      name: specification.name,
      path: pathname,
      changed,
      stagePath,
      committed: false,
      before: {
        exists: before.exists,
        bytes: before.bytes,
        sha256: before.sha256,
        backup_path: backupPath,
      },
      after: {
        exists: changed ? true : before.exists,
        bytes: afterRaw?.length || 0,
        sha256: afterRaw ? sha256(afterRaw) : null,
      },
    });
  }
  return { replacement_document_ids: [...replacementIds].sort(), ledgers };
}

async function commitRetryLedgerTransaction(transaction) {
  if (!transaction) return;
  for (const ledger of transaction.ledgers) {
    if (!ledger.changed) continue;
    await rename(ledger.stagePath, ledger.path);
    ledger.committed = true;
    const after = await readLedgerSnapshot(ledger.path, ledger.name);
    if (after.exists !== ledger.after.exists
      || after.bytes !== ledger.after.bytes
      || after.sha256 !== ledger.after.sha256) {
      throw new Error(`${ledger.name} committed hash mismatch`);
    }
  }
}

async function verifyRetryLedgerTransactionPreconditions(transaction) {
  if (!transaction) return;
  for (const ledger of transaction.ledgers) {
    const current = await readLedgerSnapshot(ledger.path, ledger.name);
    if (current.exists !== ledger.before.exists
      || current.bytes !== ledger.before.bytes
      || current.sha256 !== ledger.before.sha256) {
      throw new Error(`${ledger.name} changed after the receipt transaction was staged`);
    }
  }
}

async function restoreRetryLedgerTransaction(transaction, token) {
  if (!transaction) return [];
  const errors = [];
  for (const ledger of [...transaction.ledgers].reverse()) {
    if (!ledger.committed) continue;
    try {
      if (ledger.before.exists) {
        const temporary = `${ledger.path}.rollback-${token}`;
        await rm(temporary, { force: true });
        await copyFile(ledger.before.backup_path, temporary, fsConstants.COPYFILE_EXCL);
        if (await sha256File(temporary) !== ledger.before.sha256) {
          throw new Error(`${ledger.name} rollback backup hash mismatch`);
        }
        await rename(temporary, ledger.path);
      } else {
        await rm(ledger.path, { force: true });
      }
      ledger.committed = false;
    } catch (error) {
      errors.push(`${ledger.name}: ${error.message}`);
    }
  }
  return errors;
}

function retryLedgerReceipt(transaction) {
  if (!transaction) return null;
  return {
    replacement_document_ids: transaction.replacement_document_ids,
    ledgers: transaction.ledgers.map((ledger) => ({
      name: ledger.name,
      path: ledger.path,
      changed: ledger.changed,
      before: ledger.before,
      after: ledger.after,
    })),
  };
}

async function verifyRetryLedgerReceiptState(receipt) {
  if (!receipt.supervisor_retry_ledgers) return;
  const transaction = requireObject(receipt.supervisor_retry_ledgers, 'receipt supervisor_retry_ledgers');
  if (!Array.isArray(transaction.replacement_document_ids)
    || !Array.isArray(transaction.ledgers)
    || transaction.ledgers.length !== 2) {
    throw new Error('receipt supervisor retry ledger transaction is invalid');
  }
  for (const ledger of transaction.ledgers) {
    requireObject(ledger, 'receipt retry ledger');
    const after = requireObject(ledger.after, `receipt ${ledger.name} after`);
    const current = await readLedgerSnapshot(ledger.path, `receipt ${ledger.name}`);
    if (current.exists !== after.exists
      || current.bytes !== after.bytes
      || current.sha256 !== after.sha256) {
      throw new Error(`receipt ${ledger.name} current state differs from the applied transaction`);
    }
    if (ledger.changed && ledger.before?.exists) {
      const backup = await readLedgerSnapshot(
        ledger.before.backup_path,
        `receipt ${ledger.name} backup`,
      );
      if (!backup.exists
        || backup.bytes !== ledger.before.bytes
        || backup.sha256 !== ledger.before.sha256) {
        throw new Error(`receipt ${ledger.name} preserved backup differs from the pre-apply state`);
      }
    }
  }
}

async function verifyRetryLedgerReceiptBeforeState(receipt) {
  if (!receipt.supervisor_retry_ledgers) return;
  for (const ledger of receipt.supervisor_retry_ledgers.ledgers) {
    const current = await readLedgerSnapshot(ledger.path, `rolled back ${ledger.name}`);
    if (current.exists !== ledger.before.exists
      || current.bytes !== ledger.before.bytes
      || current.sha256 !== ledger.before.sha256) {
      throw new Error(`rolled back ${ledger.name} differs from the pre-apply state`);
    }
  }
}

async function restoreText(entry, token) {
  const temporary = `${entry.targetTextPath}.rollback-${token}`;
  await rm(temporary, { force: true });
  if (entry.previousText.existed) {
    await copyFile(entry.previousText.backupPath, temporary, fsConstants.COPYFILE_EXCL);
    if (await sha256File(temporary) !== entry.previousText.sha256) {
      throw new Error(`${entry.id}: rollback text backup hash mismatch`);
    }
    await rename(temporary, entry.targetTextPath);
  } else {
    await rm(entry.targetTextPath, { force: true });
  }
}

async function restoreDocument(entry) {
  if (entry.documentCommitted) {
    await rm(entry.targetDocumentPath, { recursive: true, force: true });
    entry.documentCommitted = false;
  }
  if (entry.previousDocument.existed && entry.documentBackupCommitted) {
    await rename(entry.previousDocument.backupPath, entry.targetDocumentPath);
    entry.documentBackupCommitted = false;
  }
}

async function rollbackCommitted(entries, token) {
  const errors = [];
  for (const entry of [...entries].reverse()) {
    try {
      await restoreDocument(entry);
      if (entry.textCommitted) await restoreText(entry, token);
    } catch (error) {
      errors.push(`${entry.id}: ${error.message}`);
    }
  }
  return errors;
}

async function applyReceiptPlan(plan, dependencies = {}) {
  const token = randomUUID();
  const releaseLock = await acquireReceiverLock(plan.normalized.receiptRoot, token);
  const generatedAt = new Date().toISOString();
  const receiptId = `${generatedAt.replace(/[:.]/g, '-')}-${plan.parentManifestSha256.slice(0, 12)}-${token.slice(0, 8)}`;
  const receiptDirectory = path.join(plan.normalized.receiptRoot, receiptId);
  const receiptPath = path.join(receiptDirectory, 'receipt.json');
  const staged = [];
  let receipt = null;
  let retryLedgerTransaction = null;
  try {
    await inspectLocalPreconditions(plan.documents, plan.normalized, plan.localSnapshots);
    await Promise.all([
      mkdir(plan.normalized.productionRoot, { recursive: true }),
      mkdir(plan.normalized.textRoot, { recursive: true }),
      mkdir(path.join(receiptDirectory, 'backups', 'production'), { recursive: true, mode: 0o700 }),
      mkdir(path.join(receiptDirectory, 'backups', 'text'), { recursive: true, mode: 0o700 }),
    ]);
    const sourceEvidence = await archiveSourceEvidence(plan, receiptDirectory);
    retryLedgerTransaction = await prepareRetryLedgerTransaction(plan, receiptDirectory, token);

    for (const item of plan.documents) {
      const localSnapshot = plan.localSnapshots.get(item.document.id);
      const targetDocumentPath = path.join(plan.normalized.productionRoot, item.document.id);
      const targetTextPath = path.join(plan.normalized.textRoot, `${item.document.id}.txt`);
      const stagedDocumentPath = path.join(plan.normalized.productionRoot, `.receive-${item.document.id}-${token}`);
      const stagedTextPath = path.join(plan.normalized.textRoot, `.receive-${item.document.id}-${token}.txt`);
      const replacingExistingDocument = localSnapshot.mode === LOCAL_REPROCESS_SNAPSHOT_MODE;
      const backupDocumentPath = replacingExistingDocument
        ? path.join(receiptDirectory, 'backups', 'production', item.document.id)
        : null;
      const backupPath = localSnapshot.text.exists
        ? path.join(receiptDirectory, 'backups', 'text', `${item.document.id}.txt`)
        : null;
      await rm(stagedDocumentPath, { recursive: true, force: true });
      await rm(stagedTextPath, { force: true });
      await copyTreeStrict(item.documentRoot, stagedDocumentPath);
      await validateDocumentTreeShape(stagedDocumentPath, item.document.page_count);
      const copiedTree = await inspectTree(stagedDocumentPath);
      if (!sameJson(copiedTree, item.sourceTree)) {
        throw new Error(`${item.document.id}: copied document tree differs from source staging`);
      }
      await validateOcrDocumentOutput(
        item.document,
        stagedDocumentPath,
        item.shard.manifest.runtime,
        {
          requireComplete: true,
          workerConfiguration: item.shard.identity.worker_configuration,
        },
      );
      await writeFile(stagedTextPath, item.text, { flag: 'wx', mode: 0o600 });
      if (await sha256File(stagedTextPath) !== item.textSha256) {
        throw new Error(`${item.document.id}: staged joined text hash mismatch`);
      }
      if (backupPath) {
        await copyFile(targetTextPath, backupPath, fsConstants.COPYFILE_EXCL);
        if (await sha256File(backupPath) !== localSnapshot.text.sha256) {
          throw new Error(`${item.document.id}: previous text backup hash mismatch`);
        }
      }
      staged.push({
        id: item.document.id,
        item,
        targetDocumentPath,
        targetTextPath,
        stagedDocumentPath,
        stagedTextPath,
        previousText: {
          existed: localSnapshot.text.exists,
          sha256: localSnapshot.text.sha256,
          backupPath,
        },
        previousDocument: {
          existed: replacingExistingDocument,
          treeSha256: localSnapshot.production?.tree_sha256 || null,
          backupPath: backupDocumentPath,
        },
        documentBackupCommitted: false,
        documentCommitted: false,
        textCommitted: false,
      });
    }

    const [productionDevice, receiptDevice] = await Promise.all([
      stat(plan.normalized.productionRoot).then((info) => info.dev),
      stat(path.join(receiptDirectory, 'backups', 'production')).then((info) => info.dev),
    ]);
    if (productionDevice !== receiptDevice) {
      throw new Error('original local OCR document backups must be on the same filesystem for atomic rename');
    }

    await dependencies.beforeApplyRecheck?.(plan);
    await inspectLocalPreconditions(plan.documents, plan.normalized, plan.localSnapshots);
    await verifyRetryLedgerTransactionPreconditions(retryLedgerTransaction);
    const receiptDocuments = plan.documents.map((item) => receiptDocument(
      item,
      plan.localSnapshots.get(item.document.id),
      plan.normalized,
      receiptDirectory,
    ));
    receipt = {
      schema_version: 1,
      receipt_type: 'curriculum_remote_ocr_whole_document_atomic_receive',
      receipt_id: receiptId,
      status: 'prepared',
      generated_at: generatedAt,
      applied_at: null,
      failed_at: null,
      rolled_back_at: null,
      dry_run: false,
      parent_manifest_path: plan.normalized.manifest,
      parent_manifest_sha256: plan.parentManifestSha256,
      counts: {
        documents: plan.documents.length,
        pages: plan.documents.reduce((sum, item) => sum + item.document.page_count, 0),
        repair_pages: plan.documents.reduce((sum, item) => sum + item.repairPageCount, 0),
        replaced_local_documents: [...plan.localSnapshots.values()]
          .filter((snapshot) => snapshot.mode === LOCAL_REPROCESS_SNAPSHOT_MODE).length,
      },
      source_shards: plan.shards.map((shard) => ({
        root: shard.root,
        manifest_path: shard.manifestPath,
        manifest_sha256: shard.manifestSha256,
        run_identity_sha256: shard.identitySha256,
        run_status_sha256: shard.runStatusSha256,
        runtime_fingerprint_sha256: shard.identity.runtime_fingerprint_sha256,
        seed_id: shard.seed?.receipt.seed_id || null,
        seed_receipt_sha256: shard.seed?.receiptSha256 || null,
        seed_commit_marker_sha256: shard.seed?.markerSha256 || null,
        ...(shard.seed?.timeoutRecovery
          ? {
              timeout_recovery_grant_sha256: shard.seed.timeoutRecovery.rawSha256,
              timeout_recovery_issuance_sha256: shard.seed.timeoutRecoveryIssuance.rawSha256,
            }
          : {}),
        repair_manifest_path: shard.repair?.manifestPath || null,
        repair_manifest_sha256: shard.repair?.manifestSha256 || null,
        repair_receipt_sha256: shard.repair?.receiptSha256 || null,
      })),
      ...(plan.runnerCompatibility ? {
        source_shard_compatibility: plan.runnerCompatibility,
      } : {}),
      source_evidence: sourceEvidence,
      supervisor_retry_ledgers: retryLedgerReceipt(retryLedgerTransaction),
      destination: {
        production_root: plan.normalized.productionRoot,
        text_root: plan.normalized.textRoot,
        supervisor_root: plan.normalized.supervisorRoot,
        receipt_root: plan.normalized.receiptRoot,
      },
      citation_allowed: false,
      documents: receiptDocuments,
      rollback_policy: {
        precondition: 'verify every current target hash before deleting or restoring',
        order: 'reverse document order',
        scope: 'only paths and backups recorded in this receipt',
      },
    };
    await writeReceipt(receiptPath, receipt);

    for (const entry of staged) {
      await dependencies.beforeCommitDocument?.(entry.id, receipt);
      if (entry.previousDocument.existed) {
        await rename(entry.targetDocumentPath, entry.previousDocument.backupPath);
        entry.documentBackupCommitted = true;
        const backupTree = await inspectTree(entry.previousDocument.backupPath);
        if (backupTree.tree_sha256 !== entry.previousDocument.treeSha256) {
          throw new Error(`${entry.id}: atomically preserved original document backup hash mismatch`);
        }
      }
      await rename(entry.stagedDocumentPath, entry.targetDocumentPath);
      entry.documentCommitted = true;
      await dependencies.afterDocumentCommit?.(entry.id, receipt);
      await rename(entry.stagedTextPath, entry.targetTextPath);
      entry.textCommitted = true;
      await dependencies.afterTextCommit?.(entry.id, receipt);
    }
    await verifyRetryLedgerTransactionPreconditions(retryLedgerTransaction);
    await commitRetryLedgerTransaction(retryLedgerTransaction);

    for (const entry of staged) {
      const [targetTree, targetTextSha256] = await Promise.all([
        inspectTree(entry.targetDocumentPath),
        sha256File(entry.targetTextPath),
      ]);
      if (targetTree.tree_sha256 !== entry.item.sourceTree.tree_sha256
        || targetTextSha256 !== entry.item.textSha256) {
        throw new Error(`${entry.id}: committed target hash mismatch`);
      }
    }

    receipt.status = 'applied';
    receipt.applied_at = new Date().toISOString();
    await writeReceipt(receiptPath, receipt);
    return { ...receipt, receipt_path: receiptPath };
  } catch (error) {
    const rollbackErrors = [
      ...await restoreRetryLedgerTransaction(retryLedgerTransaction, token),
      ...await rollbackCommitted(staged, token),
    ];
    if (receipt) {
      receipt.status = rollbackErrors.length ? 'rollback_failed' : 'rolled_back_after_apply_failure';
      receipt.failed_at = new Date().toISOString();
      receipt.rolled_back_at = rollbackErrors.length ? null : new Date().toISOString();
      receipt.error = error.message;
      receipt.rollback_errors = rollbackErrors;
      await writeReceipt(receiptPath, receipt).catch(() => {});
    } else {
      await rm(receiptDirectory, { recursive: true, force: true }).catch(() => {});
    }
    if (rollbackErrors.length) {
      throw new Error(`${error.message}; automatic rollback also failed: ${rollbackErrors.join('; ')}`);
    }
    throw error;
  } finally {
    for (const entry of staged) {
      await rm(entry.stagedDocumentPath, { recursive: true, force: true }).catch(() => {});
      await rm(entry.stagedTextPath, { force: true }).catch(() => {});
    }
    for (const ledger of retryLedgerTransaction?.ledgers || []) {
      if (ledger.stagePath) await rm(ledger.stagePath, { force: true }).catch(() => {});
    }
    await releaseLock();
  }
}

async function loadRollbackReceipt(receiptPath) {
  const requestedPath = path.resolve(receiptPath);
  if (path.basename(requestedPath) !== 'receipt.json') {
    throw new Error('--rollback-receipt must point to an exact receipt.json file');
  }
  await requireRegularNonSymlink(requestedPath, 'receiver rollback receipt');
  const resolvedPath = await realpath(requestedPath);
  await verifySha256Sidecar(resolvedPath, 'receiver rollback receipt');
  const { value: receipt } = await readJsonWithRaw(resolvedPath, 'receiver rollback receipt');
  requireObject(receipt, 'receiver rollback receipt');
  if (receipt.schema_version !== 1
    || receipt.receipt_type !== 'curriculum_remote_ocr_whole_document_atomic_receive'
    || receipt.dry_run !== false
    || receipt.citation_allowed !== false
    || !['applied', 'rolled_back'].includes(receipt.status)
    || !Array.isArray(receipt.documents)
    || receipt.documents.length === 0) {
    throw new Error('receiver rollback receipt identity or status is invalid');
  }
  const receiptDirectory = path.dirname(requestedPath);
  const receiptRoot = path.dirname(receiptDirectory);
  const actualCanonicalReceiptRoot = await realpath(receiptRoot);
  const destination = requireObject(receipt.destination, 'receiver rollback destination');
  const canonicalReceiptRoot = typeof destination.receipt_root === 'string'
    ? await realpath(destination.receipt_root).catch(() => null)
    : null;
  if (typeof destination.production_root !== 'string'
    || !path.isAbsolute(destination.production_root)
    || typeof destination.text_root !== 'string'
    || !path.isAbsolute(destination.text_root)
    || typeof destination.supervisor_root !== 'string'
    || !path.isAbsolute(destination.supervisor_root)
    || typeof destination.receipt_root !== 'string'
    || canonicalReceiptRoot !== actualCanonicalReceiptRoot
    || isWithin(destination.production_root, destination.text_root)
    || isWithin(destination.text_root, destination.production_root)) {
    throw new Error('receiver rollback destination roots are invalid');
  }
  if (receipt.supervisor_retry_ledgers) {
    const retryTransaction = requireObject(
      receipt.supervisor_retry_ledgers,
      'receiver rollback supervisor_retry_ledgers',
    );
    if (!Array.isArray(retryTransaction.ledgers)
      || retryTransaction.ledgers.length !== 2
      || !sameJson(retryTransaction.ledgers.map((ledger) => ledger.name).sort(), ['document_retries', 'page_retries'])) {
      throw new Error('receiver rollback retry ledger transaction is invalid');
    }
    for (const ledger of retryTransaction.ledgers) {
      const expectedPath = path.join(
        destination.supervisor_root,
        ledger.name === 'document_retries' ? 'retries.json' : 'page-retries.json',
      );
      const expectedBackup = ledger.changed && ledger.before?.exists
        ? path.join(
            receiptDirectory,
            'backups',
            'supervisor',
            ledger.name === 'document_retries' ? 'retries.json' : 'page-retries.json',
          )
        : null;
      if (ledger.path !== expectedPath || ledger.before?.backup_path !== expectedBackup) {
        throw new Error(`receiver rollback ${ledger.name} paths escape their expected roots`);
      }
    }
  }
  const documents = [];
  const identifiers = new Set();
  for (const item of receipt.documents) {
    requireObject(item, 'receiver rollback document');
    if (!documentIdPattern.test(String(item.document_id || ''))
      || item.document_id === '.'
      || item.document_id === '..'
      || identifiers.has(item.document_id)) {
      throw new Error(`receiver rollback document id is unsafe or duplicated: ${item.document_id}`);
    }
    identifiers.add(item.document_id);
    const targetDocumentPath = path.join(destination.production_root, item.document_id);
    const targetTextPath = path.join(destination.text_root, `${item.document_id}.txt`);
    if (item.target_document_path !== targetDocumentPath || item.target_text_path !== targetTextPath) {
      throw new Error(`${item.document_id}: receiver rollback target path differs from destination roots`);
    }
    requireSha256(item.target_document_tree_sha256, `${item.document_id} target document tree`);
    requireSha256(item.target_text_sha256, `${item.document_id} target text`);
    const previousDocument = requireObject(item.previous_document, `${item.document_id} previous_document`);
    const previousText = requireObject(item.previous_text, `${item.document_id} previous_text`);
    if (typeof previousDocument.existed !== 'boolean' || typeof previousText.existed !== 'boolean') {
      throw new Error(`${item.document_id}: receiver rollback original-existence flags are invalid`);
    }
    const expectedDocumentBackup = previousDocument.existed
      ? path.join(receiptDirectory, 'backups', 'production', item.document_id)
      : null;
    const expectedTextBackup = previousText.existed
      ? path.join(receiptDirectory, 'backups', 'text', `${item.document_id}.txt`)
      : null;
    if (previousDocument.backup_path !== expectedDocumentBackup
      || previousText.backup_path !== expectedTextBackup) {
      throw new Error(`${item.document_id}: receiver rollback backup path escapes the receipt directory`);
    }
    if (previousDocument.existed) requireSha256(previousDocument.tree_sha256, `${item.document_id} previous document tree`);
    if (previousText.existed) requireSha256(previousText.sha256, `${item.document_id} previous text`);
    documents.push({
      item,
      targetDocumentPath,
      targetTextPath,
      previousDocument,
      previousText,
    });
  }
  return {
    receiptPath: requestedPath,
    receiptDirectory,
    receiptRoot,
    receipt,
    documents,
  };
}

async function verifyRollbackReceiptState(plan) {
  if (plan.receipt.status === 'rolled_back') {
    for (const entry of plan.documents) {
      const currentDocument = await lstatIfPresent(entry.targetDocumentPath);
      if (entry.previousDocument.existed) {
        if (!currentDocument || !currentDocument.isDirectory() || currentDocument.isSymbolicLink()) {
          throw new Error(`${entry.item.document_id}: rolled back original document is missing`);
        }
        const tree = await inspectTree(entry.targetDocumentPath);
        if (tree.tree_sha256 !== entry.previousDocument.tree_sha256) {
          throw new Error(`${entry.item.document_id}: rolled back original document hash mismatch`);
        }
      } else if (currentDocument) {
        throw new Error(`${entry.item.document_id}: rolled back destination should be absent`);
      }
      const currentText = await lstatIfPresent(entry.targetTextPath);
      if (entry.previousText.existed) {
        if (!currentText || !currentText.isFile() || currentText.isSymbolicLink()
          || currentText.size !== entry.previousText.bytes
          || await sha256File(entry.targetTextPath) !== entry.previousText.sha256) {
          throw new Error(`${entry.item.document_id}: rolled back original text hash mismatch`);
        }
      } else if (currentText) {
        throw new Error(`${entry.item.document_id}: rolled back text destination should be absent`);
      }
    }
    await verifyRetryLedgerReceiptBeforeState(plan.receipt);
    return;
  }

  for (const entry of plan.documents) {
    const [targetTree, targetTextInfo] = await Promise.all([
      inspectTree(entry.targetDocumentPath),
      lstatIfPresent(entry.targetTextPath),
    ]);
    if (targetTree.tree_sha256 !== entry.item.target_document_tree_sha256
      || !targetTextInfo
      || !targetTextInfo.isFile()
      || targetTextInfo.isSymbolicLink()
      || targetTextInfo.size !== entry.item.target_text_bytes
      || await sha256File(entry.targetTextPath) !== entry.item.target_text_sha256) {
      throw new Error(`${entry.item.document_id}: applied target differs from the rollback receipt`);
    }
    if (entry.previousDocument.existed) {
      const backupTree = await inspectTree(entry.previousDocument.backup_path);
      if (backupTree.tree_sha256 !== entry.previousDocument.tree_sha256) {
        throw new Error(`${entry.item.document_id}: original document backup hash mismatch`);
      }
    }
    if (entry.previousText.existed) {
      const backupInfo = await lstatIfPresent(entry.previousText.backup_path);
      if (!backupInfo || !backupInfo.isFile() || backupInfo.isSymbolicLink()
        || backupInfo.size !== entry.previousText.bytes
        || await sha256File(entry.previousText.backup_path) !== entry.previousText.sha256) {
        throw new Error(`${entry.item.document_id}: original text backup hash mismatch`);
      }
    }
  }
  await verifyRetryLedgerReceiptState(plan.receipt);
}

async function applyRollbackReceipt(plan) {
  const token = randomUUID();
  const releaseLock = await acquireReceiverLock(plan.receiptRoot, token);
  const moved = [];
  const ledgerMoves = [];
  try {
    const currentPlan = await loadRollbackReceipt(plan.receiptPath);
    await verifyRollbackReceiptState(currentPlan);
    if (currentPlan.receipt.status === 'rolled_back') {
      return {
        ...currentPlan.receipt,
        status: 'verified_idempotent',
        rollback_dry_run: false,
        verified_at: new Date().toISOString(),
        receipt_path: currentPlan.receiptPath,
      };
    }
    const [productionDevice, textDevice, receiptDevice] = await Promise.all([
      stat(currentPlan.receipt.destination.production_root).then((info) => info.dev),
      stat(currentPlan.receipt.destination.text_root).then((info) => info.dev),
      stat(currentPlan.receiptDirectory).then((info) => info.dev),
    ]);
    if (productionDevice !== receiptDevice || textDevice !== receiptDevice) {
      throw new Error('rollback requires production, text, and receipt backups on the same filesystem');
    }

    for (const entry of currentPlan.documents) {
      const remoteDocumentPath = path.join(
        currentPlan.receipt.destination.production_root,
        `.rollback-remote-${entry.item.document_id}-${token}`,
      );
      const remoteTextPath = path.join(
        currentPlan.receipt.destination.text_root,
        `.rollback-remote-${entry.item.document_id}-${token}.txt`,
      );
      await rename(entry.targetDocumentPath, remoteDocumentPath);
      const state = {
        ...entry,
        remoteDocumentPath,
        remoteTextPath,
        remoteDocumentMoved: true,
        originalDocumentRestored: false,
        remoteTextMoved: false,
        originalTextRestored: false,
      };
      moved.push(state);
      if (entry.previousDocument.existed) {
        await rename(entry.previousDocument.backup_path, entry.targetDocumentPath);
        state.originalDocumentRestored = true;
      }
      await rename(entry.targetTextPath, remoteTextPath);
      state.remoteTextMoved = true;
      if (entry.previousText.existed) {
        await copyFile(entry.previousText.backup_path, entry.targetTextPath, fsConstants.COPYFILE_EXCL);
        state.originalTextRestored = true;
      }
    }

    for (const ledger of currentPlan.receipt.supervisor_retry_ledgers?.ledgers || []) {
      if (!ledger.changed) continue;
      const currentPath = `${ledger.path}.rollback-remote-${token}`;
      await copyFile(ledger.path, currentPath, fsConstants.COPYFILE_EXCL);
      const state = { ledger, currentPath, restored: false };
      ledgerMoves.push(state);
      if (ledger.before.exists) {
        const temporary = `${ledger.path}.rollback-restore-${token}`;
        await copyFile(ledger.before.backup_path, temporary, fsConstants.COPYFILE_EXCL);
        if (await sha256File(temporary) !== ledger.before.sha256) {
          throw new Error(`${ledger.name} rollback source hash mismatch`);
        }
        await rename(temporary, ledger.path);
      } else {
        await rm(ledger.path, { force: true });
      }
      state.restored = true;
    }

    for (const state of moved) {
      if (state.originalDocumentRestored) {
        const tree = await inspectTree(state.targetDocumentPath);
        if (tree.tree_sha256 !== state.previousDocument.tree_sha256) {
          throw new Error(`${state.item.document_id}: restored original document hash mismatch`);
        }
      } else if (await lstatIfPresent(state.targetDocumentPath)) {
        throw new Error(`${state.item.document_id}: document destination was not removed by rollback`);
      }
      if (state.originalTextRestored) {
        if (await sha256File(state.targetTextPath) !== state.previousText.sha256) {
          throw new Error(`${state.item.document_id}: restored original text hash mismatch`);
        }
      } else if (await lstatIfPresent(state.targetTextPath)) {
        throw new Error(`${state.item.document_id}: text destination was not removed by rollback`);
      }
    }
    await verifyRetryLedgerReceiptBeforeState(currentPlan.receipt);

    for (const state of moved) {
      await rm(state.remoteDocumentPath, { recursive: true, force: true });
      await rm(state.remoteTextPath, { force: true });
    }
    for (const state of ledgerMoves) await rm(state.currentPath, { force: true });
    currentPlan.receipt.status = 'rolled_back';
    currentPlan.receipt.rolled_back_at = new Date().toISOString();
    currentPlan.receipt.rollback_applied = true;
    await writeReceipt(currentPlan.receiptPath, currentPlan.receipt);
    return { ...currentPlan.receipt, receipt_path: currentPlan.receiptPath };
  } catch (error) {
    const errors = [];
    for (const state of [...ledgerMoves].reverse()) {
      if (!state.restored) continue;
      try {
        await rename(state.currentPath, state.ledger.path);
      } catch (rollbackError) {
        errors.push(`${state.ledger.name}: ${rollbackError.message}`);
      }
    }
    for (const state of [...moved].reverse()) {
      try {
        if (state.originalTextRestored) await rm(state.targetTextPath, { force: true });
        if (state.remoteTextMoved) await rename(state.remoteTextPath, state.targetTextPath);
        if (state.originalDocumentRestored) {
          await rename(state.targetDocumentPath, state.previousDocument.backup_path);
        }
        if (state.remoteDocumentMoved) await rename(state.remoteDocumentPath, state.targetDocumentPath);
      } catch (rollbackError) {
        errors.push(`${state.item.document_id}: ${rollbackError.message}`);
      }
    }
    if (errors.length) {
      throw new Error(`${error.message}; rollback cancellation also failed: ${errors.join('; ')}`);
    }
    throw error;
  } finally {
    await releaseLock();
  }
}

async function rollbackRemoteOcrReceipt(options) {
  const plan = await loadRollbackReceipt(options.rollbackReceipt);
  await verifyRollbackReceiptState(plan);
  if (plan.receipt.status === 'rolled_back') {
    return {
      ...plan.receipt,
      status: 'verified_idempotent',
      rollback_dry_run: !options.apply,
      verified_at: new Date().toISOString(),
      receipt_path: plan.receiptPath,
    };
  }
  if (options.apply) return applyRollbackReceipt(plan);
  return {
    schema_version: 1,
    receipt_type: plan.receipt.receipt_type,
    status: 'rollback_dry_run_validated',
    rollback_dry_run: true,
    receipt_path: plan.receiptPath,
    receipt_id: plan.receipt.receipt_id,
    counts: plan.receipt.counts,
    citation_allowed: false,
    documents: plan.documents.map((entry) => ({
      document_id: entry.item.document_id,
      document_action: entry.previousDocument.existed ? 'restore_verified_backup' : 'remove_received_tree',
      text_action: entry.previousText.existed ? 'restore_verified_backup' : 'remove_received_text',
    })),
  };
}

export async function receiveRemoteOcrOffload(options, dependencies = {}) {
  if (options.rollbackReceipt) return rollbackRemoteOcrReceipt(options);
  const plan = await prepareReceiptPlan(options, dependencies);
  if (plan.idempotentReceipt) {
    return {
      ...plan.idempotentReceipt,
      status: 'verified_idempotent',
      dry_run: !plan.normalized.apply,
      verified_at: new Date().toISOString(),
    };
  }
  if (plan.normalized.apply) return applyReceiptPlan(plan, dependencies);
  return {
    schema_version: 1,
    receipt_type: 'curriculum_remote_ocr_whole_document_atomic_receive',
    status: 'dry_run_validated',
    dry_run: true,
    parent_manifest_path: plan.normalized.manifest,
    parent_manifest_sha256: plan.parentManifestSha256,
    counts: {
      documents: plan.documents.length,
      pages: plan.documents.reduce((sum, item) => sum + item.document.page_count, 0),
      repair_pages: plan.documents.reduce((sum, item) => sum + item.repairPageCount, 0),
      existing_document_trees_to_backup: [...plan.localSnapshots.values()]
        .filter((item) => item.mode === LOCAL_REPROCESS_SNAPSHOT_MODE).length,
      existing_text_files_to_backup: [...plan.localSnapshots.values()].filter((item) => item.text.exists).length,
    },
    source_shards: plan.shards.map((shard) => ({
      root: shard.root,
      manifest_path: shard.manifestPath,
      manifest_sha256: shard.manifestSha256,
      run_identity_sha256: shard.identitySha256,
      run_status_sha256: shard.runStatusSha256,
      runtime_fingerprint_sha256: shard.identity.runtime_fingerprint_sha256,
      seed_id: shard.seed?.receipt.seed_id || null,
      seed_receipt_sha256: shard.seed?.receiptSha256 || null,
      seed_commit_marker_sha256: shard.seed?.markerSha256 || null,
      ...(shard.seed?.timeoutRecovery
        ? {
            timeout_recovery_grant_sha256: shard.seed.timeoutRecovery.rawSha256,
            timeout_recovery_issuance_sha256: shard.seed.timeoutRecoveryIssuance.rawSha256,
          }
        : {}),
      repair_manifest_path: shard.repair?.manifestPath || null,
      repair_manifest_sha256: shard.repair?.manifestSha256 || null,
      repair_receipt_sha256: shard.repair?.receiptSha256 || null,
    })),
    ...(plan.runnerCompatibility ? {
      source_shard_compatibility: plan.runnerCompatibility,
    } : {}),
    destination: {
      production_root: plan.normalized.productionRoot,
      text_root: plan.normalized.textRoot,
      receipt_root: plan.normalized.receiptRoot,
    },
    citation_allowed: false,
    documents: plan.documents.map((item) => ({
      document_id: item.document.id,
      page_count: item.document.page_count,
      source_document_status: item.status,
      source_document_tree_sha256: item.sourceTree.tree_sha256,
      source_state_sha256: item.validation.state_sha256,
      source_page_artifacts_sha256: item.validation.page_artifacts_sha256,
      native_markdown_trees_sha256: item.nativeMarkdownTreesSha256,
      native_markdown_asset_count: item.nativeAssetCount,
      native_markdown_asset_bytes: item.nativeAssetBytes,
      joined_text_sha256: item.textSha256,
      joined_text_bytes: item.text.length,
      repair_pages: item.repairPageCount,
      ...(timeoutRecoveryReceiptDocument(
        item.shard.seed?.receipt.documents.find(
          (document) => document.document_id === item.document.id,
        ),
      ) ? {
        timeout_recovery: timeoutRecoveryReceiptDocument(
          item.shard.seed.receipt.documents.find(
            (document) => document.document_id === item.document.id,
          ),
        ),
      } : {}),
      replacement_mode: plan.localSnapshots.get(item.document.id).mode === LOCAL_REPROCESS_SNAPSHOT_MODE
        ? LOCAL_REPROCESS_SNAPSHOT_MODE
        : 'install_into_absent_destination',
      planned_local_snapshot_sha256: plan.localSnapshots.get(item.document.id).planning_snapshot?.snapshot_sha256 || null,
      previous_document_tree_sha256: plan.localSnapshots.get(item.document.id).production?.tree_sha256 || null,
      previous_text_sha256: plan.localSnapshots.get(item.document.id).text.sha256,
    })),
  };
}

export function parseReceiverArguments(argv) {
  const options = { shards: [], apply: false };
  const shardManifests = [];
  const shardRoots = [];
  const repairManifests = [];
  const suppliedValueKeys = [];
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--apply') {
      options.apply = true;
      continue;
    }
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    index += 1;
    suppliedValueKeys.push(key);
    if (key === '--shard-manifest') shardManifests.push(value);
    else if (key === '--shard-root') shardRoots.push(value);
    else if (key === '--repair-manifest') repairManifests.push(value);
    else if (key === '--manifest') options.manifest = value;
    else if (key === '--project-root') options.projectRoot = value;
    else if (key === '--production-root') options.productionRoot = value;
    else if (key === '--text-root') options.textRoot = value;
    else if (key === '--supervisor-root') options.supervisorRoot = value;
    else if (key === '--receipt-root') options.receiptRoot = value;
    else if (key === '--python') options.python = value;
    else if (key === '--rollback-receipt') options.rollbackReceipt = value;
    else throw new Error(`unknown argument: ${key}`);
  }
  if (options.rollbackReceipt) {
    const incompatible = suppliedValueKeys.filter((key) => key !== '--rollback-receipt');
    if (incompatible.length > 0 || shardManifests.length > 0 || shardRoots.length > 0 || repairManifests.length > 0) {
      throw new Error('--rollback-receipt cannot be combined with manifest, shard, root, or runtime options');
    }
    return options;
  }
  if (shardManifests.length !== shardRoots.length) {
    throw new Error('--shard-manifest and --shard-root must be supplied in matching pairs');
  }
  if (repairManifests.length !== 0 && repairManifests.length !== shardManifests.length) {
    throw new Error('--repair-manifest must be omitted entirely or supplied once per shard (use - for no repair)');
  }
  options.shards = shardManifests.map((manifestPath, index) => ({
    manifestPath,
    root: shardRoots[index],
    ...(repairManifests[index] && !['-', 'none'].includes(repairManifests[index])
      ? { repairManifestPath: repairManifests[index] }
      : {}),
  }));
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const result = await receiveRemoteOcrOffload(parseReceiverArguments(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      status: 'failed',
      code: error.code || 'REMOTE_OCR_RECEIVE_FAILED',
      message: error.message,
    }));
    process.exitCode = 1;
  }
}
