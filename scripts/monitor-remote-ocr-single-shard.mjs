#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  statfs,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  parseMeminfo,
  parseNvidiaSmi,
  parseSystemdShow,
} from './monitor-remote-ocr-reprocess.mjs';
import { fingerprintPaddlexLayoutModelCache } from './run-remote-ocr-offload.mjs';

const execFile = promisify(execFileCallback);
const gib = 1024 ** 3;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const documentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const unitPattern = /^[A-Za-z0-9][A-Za-z0-9_.@:-]*\.service$/u;
const seedMode = 'hash_bound_output_seed';
const seedReceiptType = 'curriculum_remote_ocr_hash_bound_output_seed';
const legacyB1RunnerScriptSha256 = 'b08c3f7aa3da6e44dd9fffeecaf20b2a020df4d604c9b957399abaf886d15a55';
const p4ToP1Transition = 'p4_to_p1_v1';
const p4ToP1SeedAwareOcrTransition = 'p4_to_p1_seed_aware_ocr_v2';
const legacyToSeedAwareOcrScriptTransition = 'b1_legacy_to_seed_aware_v1';
const legacyB1OcrScriptSha256 = 'b4ea873026fb4d2da2efb921ddac3974a48db703143ff53aff3ebeae48d9b048';
const seedAwareOcrScriptSha256 = '3176d267c681b2764d4ff81f7e7b6748c174ee62854a11a2529ccfb355a364f3';
const auditedCommonInferenceSuffixSha256 = '4edade704624f0bac5bcd76eeb113a07452a57040e4fd949609d319f49c2b4ca';
const timeoutRecoveryGrantFilename = 'timeout-recovery-grant.json';
const timeoutRecoveryGrantType = 'curriculum_remote_ocr_timeout_recovery_grant';
const timeoutRecoveryGrantMode = 'one_additional_attempt_per_document';
const timeoutRecoveryClaimMode = 'atomic_single_claim';
const timeoutRecoveryLedgerIdentityFilename = 'timeout-recovery-ledger-identity.json';
const timeoutRecoveryLedgerType = 'curriculum_remote_ocr_timeout_recovery_consumption_ledger';
const timeoutRecoveryClaimFilename = 'timeout-recovery-consumption-claim.json';
const timeoutRecoveryClaimType = 'curriculum_remote_ocr_timeout_recovery_consumption_claim';
const timeoutRecoveryIssuanceDirectory = 'timeout-recovery-issuance';
const timeoutRecoveryIssuanceClaimType = 'curriculum_remote_ocr_timeout_recovery_issuance_claim';
const timeoutRecoveryPredecessorClaimKeyType = 'curriculum_remote_ocr_timeout_recovery_predecessor_claim_key';
const timeoutRecoveryIncidentType = 'curriculum_remote_ocr_child_timeout_incident';
const maxAuthorityFileBytes = 64 * 1024 * 1024;
const maxDocumentAttempts = 5;
const documentRetryBackoffMilliseconds = Object.freeze([2_000, 10_000, 30_000, 60_000]);
const allowedStatuses = new Set([
  'pending',
  'running',
  'retry_wait',
  'complete',
  'failed',
  'interrupted',
  'quarantined',
]);
const seedablePredecessorStatuses = new Set(['pending', 'retry_wait', 'complete', 'interrupted', 'quarantined']);
const baseInstalledItemSpecifications = Object.freeze([
  { name: 'documents', type: 'directory' },
  { name: 'status', type: 'directory' },
  { name: 'seed-predecessor-evidence', type: 'directory' },
  { name: 'seed-receipt.json', type: 'file' },
  { name: 'seed-receipt.json.sha256', type: 'file' },
  { name: 'run-identity.json', type: 'file' },
  { name: 'run-status.json', type: 'file' },
  { name: 'run-status.json.sha256', type: 'file' },
]);
const timeoutRecoveryInstalledItemSpecifications = Object.freeze([
  { name: timeoutRecoveryGrantFilename, type: 'file' },
  { name: `${timeoutRecoveryGrantFilename}.sha256`, type: 'file' },
  { name: timeoutRecoveryIssuanceDirectory, type: 'directory' },
  { name: timeoutRecoveryLedgerIdentityFilename, type: 'file' },
  { name: `${timeoutRecoveryLedgerIdentityFilename}.sha256`, type: 'file' },
  { name: timeoutRecoveryClaimFilename, type: 'file' },
  { name: `${timeoutRecoveryClaimFilename}.sha256`, type: 'file' },
]);
const immutableInstalledItems = new Set([
  'seed-predecessor-evidence',
  'seed-receipt.json',
  'seed-receipt.json.sha256',
  'run-identity.json',
  timeoutRecoveryGrantFilename,
  `${timeoutRecoveryGrantFilename}.sha256`,
  timeoutRecoveryIssuanceDirectory,
  timeoutRecoveryLedgerIdentityFilename,
  `${timeoutRecoveryLedgerIdentityFilename}.sha256`,
  timeoutRecoveryClaimFilename,
  `${timeoutRecoveryClaimFilename}.sha256`,
]);
const defaultThresholds = Object.freeze({
  stall_seconds: 1500,
  disk_min_gib: 50,
  memory_min_gib: 2,
  gpu_max_c: 85,
});

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const iso = (milliseconds) => new Date(milliseconds).toISOString();

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isAuditedP4ToP1Transition(value) {
  return value === p4ToP1Transition || value === p4ToP1SeedAwareOcrTransition;
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

function requireExactObjectKeys(left, right, label) {
  if (!sameJson(Object.keys(left).sort(), Object.keys(right).sort())) {
    throw new Error(`${label} field set differs`);
  }
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
  try { parsed = new URL(value); } catch { throw new Error(`${label} must be a valid URL`); }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port !== '8112') {
    throw new Error(`${label} must retain http://127.0.0.1:8112`);
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireSha256(value, label) {
  if (!sha256Pattern.test(String(value || ''))) throw new Error(`${label} must be a lowercase SHA-256`);
  return value;
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

function timeoutRecoverySummary(grant, rawSha256, sidecarSha256) {
  return {
    grant_id: grant.grant_id,
    raw_sha256: rawSha256,
    sidecar_sha256: sidecarSha256,
    policy: grant.policy,
    documents: grant.documents,
  };
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
  if (!sameJson(Object.keys(grant).sort(), [
    'citation_allowed',
    'consumption',
    'documents',
    'grant_id',
    'grant_type',
    'mode',
    'policy',
    'predecessor',
    'schema_version',
  ].sort())
    || grant.schema_version !== 1
    || grant.grant_type !== timeoutRecoveryGrantType
    || grant.mode !== timeoutRecoveryGrantMode
    || grant.citation_allowed !== false
    || !Array.isArray(grant.documents)
    || grant.documents.length === 0) {
    throw new Error('timeout recovery grant identity is invalid');
  }
  const { grant_id: _grantId, ...grantBasis } = grant;
  if (grant.grant_id !== sha256(canonicalJson(grantBasis))) {
    throw new Error('timeout recovery grant ID does not match its canonical basis');
  }
  const predecessor = requireObject(grant.predecessor, 'timeout recovery grant predecessor');
  requireExactObjectKeyOrder(predecessor, [
    'manifest_sha256', 'run_identity_sha256', 'run_status_sha256',
  ], 'timeout recovery grant predecessor');
  if (!sameJson(Object.keys(predecessor).sort(), [
    'manifest_sha256',
    'run_identity_sha256',
    'run_status_sha256',
  ].sort())
    || predecessor.manifest_sha256 !== manifestSha256) {
    throw new Error('timeout recovery grant predecessor is invalid');
  }
  requireSha256(predecessor.run_identity_sha256, 'timeout recovery predecessor identity SHA-256');
  requireSha256(predecessor.run_status_sha256, 'timeout recovery predecessor status SHA-256');
  const expectedPolicy = {
    required_status: 'quarantined',
    required_inherited_attempts: 5,
    granted_attempt: 6,
    additional_attempts_per_document: 1,
    automatic_attempt_7: false,
    scope: 'all_timeout_quarantined_documents',
  };
  requireExactObjectKeyOrder(grant.policy, Object.keys(expectedPolicy), 'timeout recovery grant policy');
  if (!sameJson(grant.policy, expectedPolicy)) {
    throw new Error('timeout recovery grant policy is invalid');
  }
  const consumption = requireObject(grant.consumption, 'timeout recovery grant consumption');
  requireExactObjectKeyOrder(consumption, [
    'ledger_id', 'ledger_root', 'ledger_device', 'ledger_inode', 'claim_mode',
  ], 'timeout recovery grant consumption');
  if (!sameJson(Object.keys(consumption).sort(), [
    'claim_mode', 'ledger_device', 'ledger_id', 'ledger_inode', 'ledger_root',
  ].sort())
    || consumption.claim_mode !== timeoutRecoveryClaimMode
    || typeof consumption.ledger_root !== 'string'
    || !path.isAbsolute(consumption.ledger_root)
    || !/^\d+$/u.test(consumption.ledger_device)
    || !/^\d+$/u.test(consumption.ledger_inode)) {
    throw new Error('timeout recovery grant consumption is invalid');
  }
  requireSha256(consumption.ledger_id, 'timeout recovery ledger ID');
  const documentIds = grant.documents.map((value) => value?.document_id);
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
    if (!sameJson(Object.keys(document).sort(), [
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
    ].sort())
      || !documentIdPattern.test(String(document.document_id || ''))
      || document.inherited_attempts !== maxDocumentAttempts
      || document.granted_attempt !== maxDocumentAttempts + 1
      || !Number.isSafeInteger(document.first_missing_page)
      || document.first_missing_page < 1
      || document.quarantine_reason !== 'attempt_budget_exhausted'
      || document.classification !== 'child_idle_timeout_only') {
      throw new Error(`${document.document_id || 'unknown'}: timeout recovery grant document is invalid`);
    }
    for (const [key, digest] of Object.entries({
      completed_pages_sha256: document.completed_pages_sha256,
      failed_pages_sha256: document.failed_pages_sha256,
      predecessor_state_sha256: document.predecessor_state_sha256,
      predecessor_status_sha256: document.predecessor_status_sha256,
      error_sha256: document.error_sha256,
    })) requireSha256(digest, `${document.document_id} ${key}`);
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
      throw new Error(`${document.document_id}: timeout recovery log is invalid`);
    }
    requireSha256(log.sha256, `${document.document_id} timeout log SHA-256`);
  }
  return grant;
}

function parseJsonRaw(record, label) {
  try {
    return JSON.parse(record.raw);
  } catch (error) {
    throw new Error(`${label} JSON is invalid: ${error.message}`);
  }
}

async function lstatIfPresent(pathname) {
  try { return await lstat(pathname); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function installedItemSpecifications(hasTimeoutRecovery) {
  if (!hasTimeoutRecovery) return baseInstalledItemSpecifications;
  return Object.freeze([
    ...baseInstalledItemSpecifications.slice(0, 5),
    ...timeoutRecoveryInstalledItemSpecifications,
    ...baseInstalledItemSpecifications.slice(5),
  ]);
}

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function requireNonnegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a nonnegative integer`);
  return parsed;
}

function requirePositiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be greater than zero`);
  return parsed;
}

function requireDocumentId(value, label = 'document id') {
  if (!documentIdPattern.test(String(value || ''))) throw new Error(`${label} is unsafe`);
  return value;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function disjoint(left, right) {
  return !inside(left, right) && !inside(right, left);
}

function parsePair(value, label) {
  const separator = value.indexOf('=');
  if (separator < 1 || separator === value.length - 1) throw new Error(`${label} must use LABEL=VALUE`);
  return [value.slice(0, separator), value.slice(separator + 1)];
}

export function parseSingleShardMonitorArgs(argv) {
  const values = {
    oldWorkerUnits: new Map(),
    inactiveWorkerUnits: new Map(),
    llamaUnit: 'curriculum-ocr-llama.service',
    llamaHealthUrl: 'http://127.0.0.1:8112/health',
    thresholds: { ...defaultThresholds },
    predecessorAnchors: {},
  };
  const anchorArguments = new Map([
    ['--b1-identity-sha256', 'identity_sha256'],
    ['--b1-run-status-sha256', 'run_status_sha256'],
    ['--b1-state-hashset-sha256', 'state_hashset_sha256'],
    ['--b1-status-hashset-sha256', 'status_hashset_sha256'],
    ['--b1-artifact-hashset-sha256', 'artifact_hashset_sha256'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      index += 1;
      return value;
    };
    if (argument === '--run-root') values.runRoot = path.resolve(next());
    else if (argument === '--predecessor-output') values.predecessorOutput = next();
    else if (argument === '--successor-output') values.successorOutput = next();
    else if (argument === '--output-dir') values.outputDir = path.resolve(next());
    else if (argument === '--worker-unit') values.workerUnit = next();
    else if (argument === '--old-worker-unit') {
      const [label, unit] = parsePair(next(), '--old-worker-unit');
      values.oldWorkerUnits.set(label, unit);
    } else if (argument === '--inactive-worker-unit') {
      const [label, unit] = parsePair(next(), '--inactive-worker-unit');
      if (values.inactiveWorkerUnits.has(label)) {
        throw new Error(`duplicate inactive worker label: ${label}`);
      }
      values.inactiveWorkerUnits.set(label, unit);
    } else if (argument === '--llama-unit') values.llamaUnit = next();
    else if (argument === '--llama-health-url') values.llamaHealthUrl = next();
    else if (argument === '--stall-seconds') values.thresholds.stall_seconds = requirePositiveInteger(next(), argument);
    else if (argument === '--disk-min-gib') values.thresholds.disk_min_gib = requirePositiveNumber(next(), argument);
    else if (argument === '--memory-min-gib') values.thresholds.memory_min_gib = requirePositiveNumber(next(), argument);
    else if (argument === '--gpu-max-c') values.thresholds.gpu_max_c = requirePositiveNumber(next(), argument);
    else if (anchorArguments.has(argument)) values.predecessorAnchors[anchorArguments.get(argument)] = next();
    else if (argument === '--help') values.help = true;
    else throw new Error(`unexpected argument: ${argument}`);
  }

  if (values.help) return values;
  if (!values.runRoot) throw new Error('--run-root is required');
  if (!values.predecessorOutput) throw new Error('--predecessor-output is required');
  if (!values.successorOutput) throw new Error('--successor-output is required');
  if (!values.outputDir) throw new Error('--output-dir is required');
  for (const [label, relative] of [
    ['predecessor', values.predecessorOutput],
    ['successor', values.successorOutput],
  ]) {
    if (path.isAbsolute(relative)) throw new Error(`${label} output must be relative to --run-root`);
    const resolved = path.resolve(values.runRoot, relative);
    if (!inside(values.runRoot, resolved)) throw new Error(`${label} output escapes --run-root`);
  }
  const predecessorRoot = path.resolve(values.runRoot, values.predecessorOutput);
  const successorRoot = path.resolve(values.runRoot, values.successorOutput);
  if (!disjoint(predecessorRoot, successorRoot)) throw new Error('predecessor and successor outputs must be disjoint and non-nested');
  if (!inside(values.runRoot, values.outputDir)) throw new Error('--output-dir must be inside --run-root');
  if (!disjoint(values.outputDir, predecessorRoot) || !disjoint(values.outputDir, successorRoot)) {
    throw new Error('--output-dir must be disjoint from both OCR output roots');
  }
  for (const [label, unit] of [
    ['worker', values.workerUnit],
    ['llama', values.llamaUnit],
  ]) {
    if (!unitPattern.test(String(unit || ''))) throw new Error(`${label} unit is invalid`);
  }
  for (const label of ['a', 'b']) {
    const unit = values.oldWorkerUnits.get(label);
    if (!unitPattern.test(String(unit || ''))) throw new Error(`old worker ${label} unit is invalid`);
  }
  if ([...values.oldWorkerUnits.keys()].some((label) => !['a', 'b'].includes(label))) {
    throw new Error('only old worker labels a and b are allowed');
  }
  for (const [label, unit] of values.inactiveWorkerUnits) {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/u.test(label) || ['a', 'b'].includes(label)) {
      throw new Error('inactive worker labels must be safe, unique, and distinct from legacy a/b');
    }
    if (!unitPattern.test(String(unit || ''))) throw new Error(`inactive worker ${label} unit is invalid`);
  }
  const allUnits = [
    values.workerUnit,
    values.llamaUnit,
    ...values.oldWorkerUnits.values(),
    ...values.inactiveWorkerUnits.values(),
  ];
  if (new Set(allUnits).size !== allUnits.length) {
    throw new Error('worker, old-worker, inactive-worker, and llama units must be distinct');
  }
  if (!/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9/_-]*$/u.test(values.llamaHealthUrl)) {
    throw new Error('--llama-health-url must be an explicit 127.0.0.1 HTTP endpoint');
  }
  for (const name of anchorArguments.values()) requireSha256(values.predecessorAnchors[name], name);
  return values;
}

async function requireRealDirectory(pathname, label) {
  const info = await lstat(pathname).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing`);
    throw error;
  });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  return realpath(pathname);
}

async function fingerprintStablePaddlexCache(cacheHome, label) {
  const before = await stat(cacheHome, { bigint: true });
  const first = await fingerprintPaddlexLayoutModelCache(cacheHome);
  const middle = await stat(cacheHome, { bigint: true });
  const second = await fingerprintPaddlexLayoutModelCache(cacheHome);
  const after = await stat(cacheHome, { bigint: true });
  const stableDirectory = [middle, after].every((value) => (
    value.dev === before.dev
    && value.ino === before.ino
    && value.size === before.size
    && value.mtimeNs === before.mtimeNs
    && value.ctimeNs === before.ctimeNs
  ));
  if (!stableDirectory || !sameJson(first, second)) {
    throw new Error(`${label} changed while its fingerprint was verified`);
  }
  return second;
}

async function inspectBoundPaddlexCache(root, identity, label) {
  const worker = requireObject(identity.worker_configuration, `${label} worker configuration`);
  if (typeof worker.paddlex_cache_home !== 'string' || !path.isAbsolute(worker.paddlex_cache_home)) {
    throw new Error(`${label} worker paddlex_cache_home must be absolute`);
  }
  const expectedCacheHome = path.resolve(worker.paddlex_cache_home);
  if (expectedCacheHome !== worker.paddlex_cache_home
    || expectedCacheHome === root
    || !inside(root, expectedCacheHome)) {
    throw new Error(`${label} worker paddlex_cache_home must be canonical and contained by its output root`);
  }
  const cacheHome = await requireRealDirectory(expectedCacheHome, `${label} PaddleX cache root`);
  if (cacheHome !== expectedCacheHome) throw new Error(`${label} PaddleX cache root is not canonical`);
  const expectedOfficialModels = path.join(cacheHome, 'official_models');
  const officialModels = await requireRealDirectory(
    expectedOfficialModels,
    `${label} PaddleX official_models root`,
  );
  if (officialModels !== expectedOfficialModels) {
    throw new Error(`${label} PaddleX official_models root is not canonical`);
  }
  const fingerprint = await fingerprintStablePaddlexCache(cacheHome, `${label} PaddleX cache`);
  if (worker.paddlex_layout_model_cache_sha256 !== fingerprint.tree_sha256) {
    throw new Error(`${label} PaddleX cache tree hash differs from its worker identity`);
  }
  const runtimeFingerprint = requireObject(identity.runtime_fingerprint, `${label} runtime fingerprint`);
  if (!sameJson(runtimeFingerprint.paddlex_layout_model_cache, fingerprint)) {
    throw new Error(`${label} PaddleX cache fingerprint differs from its runtime identity`);
  }
  return fingerprint;
}

async function readStableRaw(root, pathname, label, attempts = 3) {
  if (!inside(root, pathname)) throw new Error(`${label} escapes its root`);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const before = await lstat(pathname);
      if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
      const resolved = await realpath(pathname);
      if (!inside(root, resolved) || resolved !== path.resolve(pathname)) throw new Error(`${label} traverses a symbolic link`);
      const raw = await readFile(pathname);
      const after = await stat(pathname);
      if (before.dev !== after.dev
        || before.ino !== after.ino
        || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs) {
        throw new Error(`${label} changed while it was read`);
      }
      return { raw, sha256: sha256(raw), bytes: raw.byteLength, metadata: after };
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(75);
    }
  }
  throw lastError;
}

async function readStableJson(root, pathname, label) {
  const record = await readStableRaw(root, pathname, label);
  try {
    return { ...record, value: JSON.parse(record.raw.toString('utf8')) };
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function parseSidecar(raw, basename, label) {
  const match = /^([a-f0-9]{64})  ([^\r\n]+)\n$/u.exec(raw.toString('utf8'));
  if (!match || match[2] !== basename) throw new Error(`${label} SHA-256 sidecar format is invalid`);
  return match[1];
}

async function readHashBoundJson(root, pathname, label) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const [body, sidecar] = await Promise.all([
        readStableJson(root, pathname, label),
        readStableRaw(root, `${pathname}.sha256`, `${label} SHA-256 sidecar`, 1),
      ]);
      const expected = parseSidecar(sidecar.raw, path.basename(pathname), label);
      if (body.sha256 !== expected) throw new Error(`${label} SHA-256 sidecar mismatch`);
      return { ...body, sidecar_sha256: sidecar.sha256, sidecar_raw: sidecar.raw };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(75);
    }
  }
  throw lastError;
}

async function readStableAuthorityRaw(root, pathname, label) {
  if (!inside(root, pathname)) throw new Error(`${label} escapes its root`);
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
    return { raw, sha256: sha256(raw), bytes: raw.byteLength, metadata: after };
  } finally {
    await handle.close();
  }
}

async function readHashBoundAuthorityJson(root, pathname, label) {
  const [body, sidecar] = await Promise.all([
    readStableAuthorityRaw(root, pathname, label),
    readStableAuthorityRaw(root, `${pathname}.sha256`, `${label} SHA-256 sidecar`),
  ]);
  const expected = parseSidecar(sidecar.raw, path.basename(pathname), label);
  if (body.sha256 !== expected) throw new Error(`${label} SHA-256 sidecar mismatch`);
  let value;
  try { value = JSON.parse(body.raw.toString('utf8')); } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  const record = {
    ...body,
    value,
    sidecar_sha256: sidecar.sha256,
    sidecar_raw: sidecar.raw,
  };
  requireCanonicalPrettyJson(record, label);
  return record;
}

function requireCanonicalPrettyJson(record, label) {
  if (!record.raw.equals(Buffer.from(`${JSON.stringify(record.value, null, 2)}\n`))) {
    throw new Error(`${label} is not the exact canonical pretty-printed JSON encoding`);
  }
  return record;
}

function normalizedPages(value, pageCount, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const pages = value.map(Number).sort((left, right) => left - right);
  if (new Set(pages).size !== pages.length
    || pages.some((page) => !Number.isSafeInteger(page) || page < 1 || page > pageCount)) {
    throw new Error(`${label} contains duplicate or invalid pages`);
  }
  return pages;
}

function exactCounts(documents) {
  const counts = {
    total: documents.length,
    complete: 0,
    failed: 0,
    interrupted: 0,
    pending: 0,
    running: 0,
    retry_wait: 0,
    quarantined: 0,
  };
  for (const document of documents) counts[document.status] += 1;
  return counts;
}

function assertRunCounts(runStatus, documents, label) {
  const { counts, declaredCountsMatch } = deriveRunCounts(runStatus, documents, label);
  if (!declaredCountsMatch) throw new Error(`${label} counts differ from document statuses`);
  return counts;
}

function deriveRunCounts(runStatus, documents, label) {
  const counts = exactCounts(documents);
  const declared = requireObject(runStatus.counts, `${label} counts`);
  const keys = Object.keys(counts).sort();
  if (!sameJson(Object.keys(declared).sort(), keys)) throw new Error(`${label} counts schema is invalid`);
  if (keys.some((key) => !Number.isSafeInteger(declared[key]) || declared[key] < 0)) {
    throw new Error(`${label} counts values are invalid`);
  }
  if (declared.total !== counts.total
    || keys.filter((key) => key !== 'total').reduce((sum, key) => sum + declared[key], 0) !== declared.total) {
    throw new Error(`${label} declared counts total is invalid`);
  }
  if (runStatus.finished !== (counts.complete === counts.total)) throw new Error(`${label} finished flag is inconsistent`);
  if (runStatus.settled !== (counts.complete + counts.quarantined === counts.total)) {
    throw new Error(`${label} settled flag is inconsistent`);
  }
  return { counts, declaredCountsMatch: sameJson(declared, counts) };
}

function fingerprintRecords(records) {
  return sha256(canonicalJson(records));
}

function posixRelative(root, pathname) {
  return path.relative(root, pathname).split(path.sep).join('/');
}

export async function inspectTreeStrict(root) {
  const canonicalRoot = await requireRealDirectory(root, 'tree root');
  const entries = [];
  let files = 0;
  let bytes = 0;
  async function walk(directory, relativeDirectory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareText(left.name, right.name));
    if (relativeDirectory && children.length === 0) entries.push(`D\0${relativeDirectory}\n`);
    for (const child of children) {
      const pathname = path.join(directory, child.name);
      const info = await lstat(pathname);
      if (info.isSymbolicLink()) throw new Error('tree contains a symbolic link');
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      if (info.isDirectory()) {
        entries.push(`D\0${relative}\n`);
        await walk(pathname, relative);
      } else if (info.isFile()) {
        const record = await readStableRaw(canonicalRoot, pathname, 'tree file');
        entries.push(`F\0${relative}\0${record.bytes}\0${record.sha256}\n`);
        files += 1;
        bytes += record.bytes;
      } else {
        throw new Error('tree contains a non-regular entry');
      }
    }
  }
  await walk(canonicalRoot, '');
  return { tree_sha256: sha256(entries.join('')), files, bytes, entries };
}

async function exactDirectoryEntries(root, expectedNames, label) {
  const entries = await readdir(root, { withFileTypes: true });
  const actualNames = entries.map((entry) => entry.name).sort();
  const expected = [...expectedNames].sort();
  if (!sameJson(actualNames, expected)) throw new Error(`${label} contains missing or unexpected entries`);
  for (const entry of entries) {
    const info = await lstat(path.join(root, entry.name));
    if (info.isSymbolicLink()) throw new Error(`${label} contains a symbolic link`);
  }
  return entries;
}

function predecessorStatusFormat(identity, progress, status, statusSha256, state, stateSha256, pageArtifacts) {
  if (progress.status_json_sha256 !== statusSha256
    || status.schema_version !== 1
    || status.document_id !== state.document_id
    || status.status !== progress.status
    || status.citation_allowed !== false) {
    throw new Error(`${state.document_id}: B1 predecessor document status identity mismatch`);
  }
  if (progress.status === 'pending') return 'pending_no_status';
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
    && status.max_attempts === maxDocumentAttempts
    && status.page_count === progress.page_count
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
  const validateComplete = (timestampField) => {
    const artifacts = requireObject(status.artifacts, `${state.document_id} B1 complete status artifacts`);
    if (!sameJson(Object.keys(artifacts).sort(), [
      'page_artifacts',
      'page_artifacts_sha256',
      'state_sha256',
    ])) {
      throw new Error(`${state.document_id}: B1 complete status artifacts field set differs`);
    }
    if (status.page_count !== progress.page_count
      || status.runtime_fingerprint_sha256 !== identity.runtime_fingerprint_sha256
      || status.source_sha256 !== state.source_sha256
      || status.whole_document_atomic !== true
      || typeof status[timestampField] !== 'string'
      || !Number.isFinite(Date.parse(status[timestampField]))
      || new Date(Date.parse(status[timestampField])).toISOString() !== status[timestampField]
      || status[timestampField] !== progress[timestampField]
      || artifacts.state_sha256 !== stateSha256
      || artifacts.page_artifacts_sha256 !== sha256(`${JSON.stringify(pageArtifacts)}\n`)
      || !sameJson(artifacts.page_artifacts, pageArtifacts)) {
      throw new Error(`${state.document_id}: B1 complete status identity or artifacts mismatch`);
    }
  };
  if (progress.status === 'complete'
    && sameJson(keys, completedKeys)
    && status.attempt === progress.attempts) {
    validateComplete('completed_at');
    return 'complete_identity_v1';
  }
  if (progress.status === 'complete'
    && sameJson(keys, legacyCompleteKeys)
    && status.attempt === undefined
    && status.max_attempts === undefined) {
    validateComplete('verified_at');
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
    && status.max_attempts === maxDocumentAttempts
    && status.page_count === undefined
    && status.runtime_fingerprint_sha256 === undefined
    && typeof status.interrupted_at === 'string'
    && Number.isFinite(Date.parse(status.interrupted_at))
    && new Date(Date.parse(status.interrupted_at)).toISOString() === status.interrupted_at
    && status.interrupted_at === progress.interrupted_at) {
    return 'legacy_b1_interrupted';
  }
  if (progress.status === 'quarantined') {
    const exactKeys = [
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
    if (!sameJson(Object.keys(status).sort(), exactKeys)
      || status.attempt !== maxDocumentAttempts
      || status.max_attempts !== maxDocumentAttempts
      || status.page_count !== progress.page_count
      || status.quarantine_reason !== 'attempt_budget_exhausted'
      || progress.quarantine_reason !== status.quarantine_reason
      || progress.quarantined_at !== status.quarantined_at
      || progress.error !== status.error
      || typeof status.quarantined_at !== 'string'
      || !Number.isFinite(Date.parse(status.quarantined_at))
      || new Date(Date.parse(status.quarantined_at)).toISOString() !== status.quarantined_at) {
      throw new Error('B1 timeout quarantine status shape is invalid');
    }
    return 'timeout_only_quarantine_granted_v1';
  }
  throw new Error(`${state.document_id}: B1 predecessor document status shape is not exact`);
}

function validateInheritedCompleteProgressKeys(progress, format, phase, documentId) {
  const required = new Set([
    'attempts',
    'inherited_attempts',
    'page_count',
    'predecessor_status',
    'seed_id',
    'status',
    'status_json_sha256',
  ]);
  const optional = new Set(['started_at']);
  if (format === 'complete_identity_v1') required.add('completed_at');
  else if (format === 'legacy_b1_complete_reverified') {
    required.add('verified_at');
    optional.add('completed_at');
  } else {
    throw new Error(`${documentId}: B2 inherited complete progress format is invalid`);
  }
  if (phase === 'full') required.add('verified_at');
  const keys = Object.keys(progress);
  if ([...required].some((key) => !Object.hasOwn(progress, key))
    || keys.some((key) => !required.has(key) && !optional.has(key))) {
    throw new Error(`${documentId}: B2 inherited complete progress field set differs`);
  }
}

function validateInitialCompleteStatus({
  receiptDocument,
  progress,
  status,
  statusSha256,
  state,
  stateSha256,
  pageArtifacts,
  seedId,
  identity,
}) {
  if (receiptDocument.predecessor_status !== 'complete'
    || status.max_attempts !== undefined) return false;
  const modern = receiptDocument.predecessor_status_format === 'complete_identity_v1';
  const legacy = receiptDocument.predecessor_status_format === 'legacy_b1_complete_reverified';
  if (!modern && !legacy) {
    throw new Error(`${receiptDocument.document_id}: B2 initial inherited complete status format is invalid`);
  }
  validateInheritedCompleteProgressKeys(
    progress,
    receiptDocument.predecessor_status_format,
    'initial',
    receiptDocument.document_id,
  );
  const expectedStatusKeys = [
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
  ].sort();
  if (!sameJson(Object.keys(status).sort(), expectedStatusKeys)) {
    throw new Error(`${receiptDocument.document_id}: B2 initial inherited complete status field set differs`);
  }
  const lineage = requireObject(
    status.seed_lineage,
    `${receiptDocument.document_id} B2 initial inherited complete status seed lineage`,
  );
  const expectedLineageKeys = [
    'citation_allowed',
    'inherited_attempts',
    'predecessor_status_sha256',
    'schema_version',
    'seed_id',
  ].sort();
  if (!sameJson(Object.keys(lineage).sort(), expectedLineageKeys)) {
    throw new Error(`${receiptDocument.document_id}: B2 initial inherited complete status seed lineage field set differs`);
  }
  const artifacts = requireObject(
    status.artifacts,
    `${receiptDocument.document_id} B2 initial inherited complete status artifacts`,
  );
  const expectedArtifactKeys = [
    'page_artifacts',
    'page_artifacts_sha256',
    'state_sha256',
  ].sort();
  if (!sameJson(Object.keys(artifacts).sort(), expectedArtifactKeys)) {
    throw new Error(`${receiptDocument.document_id}: B2 initial inherited complete status artifacts field set differs`);
  }
  if (artifacts.state_sha256 !== stateSha256
    || artifacts.page_artifacts_sha256 !== sha256(`${JSON.stringify(pageArtifacts)}\n`)
    || !sameJson(artifacts.page_artifacts, pageArtifacts)) {
    throw new Error(`${receiptDocument.document_id}: B2 initial inherited complete status artifacts differ from state`);
  }
  const timestampField = modern ? 'completed_at' : 'verified_at';
  if (progress.status !== 'complete'
    || progress.attempts !== receiptDocument.inherited_attempts
    || status.schema_version !== 1
    || status.document_id !== receiptDocument.document_id
    || status.status !== 'complete'
    || status.citation_allowed !== false
    || status.page_count !== receiptDocument.page_count
    || status.runtime_fingerprint_sha256 !== identity.runtime_fingerprint_sha256
    || status.source_sha256 !== state.source_sha256
    || status.whole_document_atomic !== true
    || typeof status[timestampField] !== 'string'
    || !Number.isFinite(Date.parse(status[timestampField]))
    || new Date(Date.parse(status[timestampField])).toISOString() !== status[timestampField]
    || status[timestampField] !== progress[timestampField]
    || (modern && status.attempt !== progress.attempts)
    || lineage.schema_version !== 1
    || lineage.seed_id !== seedId
    || lineage.predecessor_status_sha256 !== receiptDocument.predecessor_status_sha256
    || lineage.inherited_attempts !== receiptDocument.inherited_attempts
    || lineage.citation_allowed !== false) {
    throw new Error(`${receiptDocument.document_id}: B2 initial inherited complete status identity differs`);
  }
  if (statusSha256 !== receiptDocument.successor_status_sha256
    || progress.status_json_sha256 !== statusSha256
    || stateSha256 !== receiptDocument.successor_state_sha256) {
    throw new Error(`${receiptDocument.document_id}: B2 initial inherited complete status or state SHA differs from seed receipt`);
  }
  return true;
}

function validateFullCompleteStatus({
  receiptDocument,
  progress,
  status,
  state,
  stateSha256,
  pageArtifacts,
  seedId,
  identity,
  attemptCeiling,
}) {
  if (progress.status !== 'complete' || status.max_attempts === undefined) return false;
  const hasCompletedAt = Object.hasOwn(status, 'completed_at');
  const hasVerifiedAt = Object.hasOwn(status, 'verified_at');
  if (hasCompletedAt === hasVerifiedAt) {
    throw new Error(`${receiptDocument.document_id}: B2 full complete status timestamp field is not exact`);
  }
  const timestampField = hasCompletedAt ? 'completed_at' : 'verified_at';
  if (receiptDocument.predecessor_status === 'complete') {
    if (timestampField !== 'verified_at') {
      throw new Error(`${receiptDocument.document_id}: B2 inherited full complete status timestamp is invalid`);
    }
    validateInheritedCompleteProgressKeys(
      progress,
      receiptDocument.predecessor_status_format,
      'full',
      receiptDocument.document_id,
    );
  }
  const expectedStatusKeys = [
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
    ...(receiptDocument.timeout_recovery ? ['seed_lineage'] : []),
  ].sort();
  if (!sameJson(Object.keys(status).sort(), expectedStatusKeys)) {
    throw new Error(`${receiptDocument.document_id}: B2 full complete status field set differs`);
  }
  const artifacts = requireObject(
    status.artifacts,
    `${receiptDocument.document_id} B2 full complete status artifacts`,
  );
  if (!sameJson(Object.keys(artifacts).sort(), [
    'page_artifacts',
    'page_artifacts_sha256',
    'state_sha256',
  ])) {
    throw new Error(`${receiptDocument.document_id}: B2 full complete status artifacts field set differs`);
  }
  if (artifacts.state_sha256 !== stateSha256
    || artifacts.page_artifacts_sha256 !== sha256(`${JSON.stringify(pageArtifacts)}\n`)
    || !sameJson(artifacts.page_artifacts, pageArtifacts)) {
    throw new Error(`${receiptDocument.document_id}: B2 full complete status artifacts differ from state`);
  }
  if (status.schema_version !== 1
    || status.document_id !== receiptDocument.document_id
    || status.status !== 'complete'
    || status.attempt !== progress.attempts
    || status.max_attempts !== attemptCeiling
    || status.page_count !== receiptDocument.page_count
    || status.runtime_fingerprint_sha256 !== identity.runtime_fingerprint_sha256
    || status.source_sha256 !== state.source_sha256
    || status.citation_allowed !== false
    || status.whole_document_atomic !== true
    || typeof status[timestampField] !== 'string'
    || !Number.isFinite(Date.parse(status[timestampField]))
    || new Date(Date.parse(status[timestampField])).toISOString() !== status[timestampField]
    || status[timestampField] !== progress[timestampField]) {
    throw new Error(`${receiptDocument.document_id}: B2 full complete status identity differs`);
  }
  if (receiptDocument.timeout_recovery) {
    const lineage = requireObject(
      status.seed_lineage,
      `${receiptDocument.document_id} B2 full complete status seed lineage`,
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
      || lineage.schema_version !== 1
      || lineage.seed_id !== seedId
      || lineage.predecessor_status_sha256 !== receiptDocument.predecessor_status_sha256
      || lineage.inherited_attempts !== receiptDocument.inherited_attempts
      || lineage.timeout_recovery_grant_id !== receiptDocument.timeout_recovery.grant_id
      || lineage.timeout_recovery_grant_sha256 !== receiptDocument.timeout_recovery.grant_raw_sha256
      || lineage.timeout_recovery_first_missing_page !== receiptDocument.timeout_recovery.first_missing_page
      || lineage.granted_attempt !== attemptCeiling
      || lineage.citation_allowed !== false) {
      throw new Error(`${receiptDocument.document_id}: B2 full complete status seed lineage differs`);
    }
  }
  return true;
}

async function inspectPageTree(root, documentId, page, statePage) {
  const pageRoot = path.join(root, 'documents', documentId, 'pages', String(page).padStart(4, '0'));
  const tree = await inspectTreeStrict(pageRoot);
  const result = await readStableRaw(root, path.join(pageRoot, 'result.json'), 'OCR result JSON');
  const markdown = await readStableRaw(root, path.join(pageRoot, 'content.md'), 'OCR content Markdown');
  JSON.parse(result.raw.toString('utf8'));
  if (result.sha256 !== requireSha256(statePage.result_json_sha256, 'result JSON SHA-256')
    || markdown.sha256 !== requireSha256(statePage.content_markdown_sha256, 'content Markdown SHA-256')) {
    throw new Error('OCR page artifact hash differs from state');
  }
  requireSha256(statePage.rendered_image_sha256, 'rendered image SHA-256');
  if (statePage.status !== 'ocr_complete_pending_audit'
    || statePage.physical_pdf_page !== page
    || statePage.citation_eligible !== false) {
    throw new Error('OCR page state is not fail-closed or has the wrong physical page');
  }
  return {
    physical_pdf_page: page,
    rendered_image_sha256: statePage.rendered_image_sha256,
    result_json_sha256: result.sha256,
    content_markdown_sha256: markdown.sha256,
    page_tree_sha256: tree.tree_sha256,
    page_tree_files: tree.files,
    page_tree_bytes: tree.bytes,
    citation_allowed: false,
    tree,
  };
}

function validateBaseState(state, documentId, pageCount, label) {
  requireObject(state, label);
  if (state.schema_version !== 1 || state.document_id !== documentId || state.page_count !== pageCount) {
    throw new Error(`${label} identity is invalid`);
  }
  requireSha256(state.source_sha256, `${label} source SHA-256`);
  const completedPages = normalizedPages(state.completed_pages, pageCount, `${label} completed_pages`);
  const failedPages = requireObject(state.failed_pages, `${label} failed_pages`);
  const failedPageNumbers = normalizedPages(Object.keys(failedPages).map(Number), pageCount, `${label} failed_pages keys`);
  if (completedPages.some((page) => failedPageNumbers.includes(page))) throw new Error(`${label} page is complete and failed`);
  const pages = requireObject(state.pages, `${label} pages`);
  const pageKeys = normalizedPages(Object.keys(pages).map(Number), pageCount, `${label} pages keys`);
  if (!sameJson(pageKeys, completedPages)) throw new Error(`${label} page metadata differs from completed_pages`);
  if (state.selected_pages !== undefined) {
    const selected = normalizedPages(state.selected_pages, pageCount, `${label} selected_pages`);
    const expected = Array.from({ length: pageCount }, (_, index) => index + 1);
    if (!sameJson(selected, expected)) throw new Error(`${label} is not whole-document OCR`);
    if (state.selected_pages_complete !== (completedPages.length === pageCount && failedPageNumbers.length === 0)) {
      throw new Error(`${label} selected_pages_complete is inconsistent`);
    }
  } else if (state.selected_pages_complete !== undefined) {
    throw new Error(`${label} selected_pages_complete exists without selected_pages`);
  }
  return { completedPages, failedPages, failedPageNumbers, pages };
}

function validateProgress(progress, pageCount, label, predecessor = false, attemptCeiling = maxDocumentAttempts) {
  requireObject(progress, label);
  if (!allowedStatuses.has(progress.status)) throw new Error(`${label} status is invalid`);
  if (progress.page_count !== pageCount) throw new Error(`${label} page_count is invalid`);
  if (!Number.isSafeInteger(progress.attempts) || progress.attempts < 0 || progress.attempts > attemptCeiling) {
    throw new Error(`${label} attempts are invalid`);
  }
  if (progress.status === 'pending' && progress.attempts !== 0) throw new Error(`${label} pending status has attempts`);
  if (['running', 'retry_wait', 'complete', 'interrupted', 'quarantined'].includes(progress.status)
    && progress.attempts < 1) throw new Error(`${label} attempted status has no attempt`);
  if (progress.status === 'retry_wait' && progress.attempts >= attemptCeiling) {
    throw new Error(`${label} retry_wait exhausted its attempts`);
  }
  if (predecessor && !seedablePredecessorStatuses.has(progress.status)) {
    throw new Error(`${label} is not seedable`);
  }
  return progress;
}

async function inspectTimeoutRecoveryIncident({
  root,
  documentId,
  pageCount,
  progress,
  state,
  stateRecord,
  stateSummary,
  status,
  statusRecord,
  identity,
  grantDocument,
}) {
  const logPath = path.join(root, grantDocument.timeout_log.path);
  const logRecord = await readStableAuthorityRaw(root, logPath, `${documentId} timeout log`);
  if (logRecord.bytes !== grantDocument.timeout_log.bytes
    || logRecord.sha256 !== grantDocument.timeout_log.sha256) {
    throw new Error(`${documentId}: timeout log bytes or SHA-256 differ from the grant`);
  }
  const incidentDirectory = path.join(root, 'timeout-incidents', documentId);
  await exactDirectoryEntries(incidentDirectory, ['attempt-0005.json', 'attempt-0005.json.sha256'], `${documentId} timeout incident root`);
  const incidentRecord = await readHashBoundAuthorityJson(
    root,
    path.join(incidentDirectory, 'attempt-0005.json'),
    `${documentId} timeout incident`,
  );
  requireCanonicalPrettyJson(incidentRecord, `${documentId} timeout incident`);
  const incident = requireObject(incidentRecord.value, `${documentId} timeout incident`);
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
  ], `${documentId} timeout incident`);
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
  }, `${documentId} timeout incident`);
  const monitoring = requireObject(identity.document_recovery?.child_monitoring, `${documentId} child monitoring`);
  requireExactObjectKeyOrder(incident.monitoring_policy, [
    'startup_timeout_seconds',
    'idle_timeout_seconds',
    'wall_floor_seconds',
    'wall_seconds_per_page',
    'terminate_grace_seconds',
    'poll_interval_seconds',
    'wall_timeout_seconds',
  ], `${documentId} timeout incident monitoring policy`);
  const expectedMonitoring = {
    ...monitoring,
    wall_timeout_seconds: Math.max(
      monitoring.wall_floor_seconds,
      monitoring.wall_seconds_per_page * pageCount,
    ),
  };
  const startedAt = Date.parse(incident.child_started_at);
  const detectedAt = Date.parse(incident.detected_at);
  const recordedAt = Date.parse(incident.recorded_at);
  const quarantinedAt = Date.parse(status.quarantined_at);
  const expectedSignals = /^OCR child idle_timeout after [1-9]\d*s; terminated with SIGTERM then SIGKILL$/u.test(
    status.error,
  ) ? ['SIGTERM', 'SIGKILL'] : ['SIGTERM'];
  const expectedError = `OCR child ${incident.timeout_type} after ${incident.elapsed_seconds}s; terminated with ${incident.termination_signals.join(' then ')}`;
  const incidentLog = requireObject(incident.log, `${documentId} timeout incident log`);
  requireExactObjectKeyOrder(incidentLog, ['path', 'bytes', 'sha256'], `${documentId} timeout incident log`);
  const legacyDerived = incident.evidence_origin === 'legacy_status_log_derivation_v1';
  const legacySignalRows = logRecord.raw.toString('utf8').match(/SignalInfo:\s*\*\*\* SIGTERM\b/gu) || [];
  if (incident.schema_version !== 1
    || incident.incident_type !== timeoutRecoveryIncidentType
    || !['runner_emitted_v1', 'legacy_status_log_derivation_v1'].includes(incident.evidence_origin)
    || incident.document_id !== documentId
    || incident.attempt !== maxDocumentAttempts
    || incident.timeout_type !== 'idle_timeout'
    || !Number.isFinite(startedAt)
    || !Number.isFinite(detectedAt)
    || !Number.isFinite(recordedAt)
    || !Number.isFinite(quarantinedAt)
    || new Date(startedAt).toISOString() !== incident.child_started_at
    || new Date(detectedAt).toISOString() !== incident.detected_at
    || new Date(recordedAt).toISOString() !== incident.recorded_at
    || new Date(quarantinedAt).toISOString() !== status.quarantined_at
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
    || incident.runtime_fingerprint_sha256 !== identity.runtime_fingerprint_sha256
    || incident.citation_allowed !== false
    || progress.status !== 'quarantined'
    || progress.attempts !== maxDocumentAttempts
    || status.status !== 'quarantined'
    || status.attempt !== maxDocumentAttempts
    || status.error !== expectedError
    || (legacyDerived
      && (detectedAt !== recordedAt
        || recordedAt !== quarantinedAt
        || !sameJson(incident.termination_signals, ['SIGTERM'])
        || legacySignalRows.length !== maxDocumentAttempts
        || incident.idle_seconds !== incident.elapsed_seconds
        || incident.child_started_at
          !== new Date(quarantinedAt - incident.elapsed_seconds * 1_000).toISOString()))
    || !sameJson(Object.keys(incidentLog).sort(), ['bytes', 'path', 'sha256'])
    || incidentLog.path !== grantDocument.timeout_log.path
    || incidentLog.bytes !== logRecord.bytes
    || incidentLog.sha256 !== logRecord.sha256) {
    throw new Error(`${documentId}: timeout incident does not prove the exact attempt-5 idle timeout`);
  }
  const completedPages = stateSummary.completedPages;
  const expectedFirstMissingPage = completedPages.length === pageCount ? null : completedPages.length + 1;
  if (grantDocument.predecessor_state_sha256 !== stateRecord.sha256
    || grantDocument.predecessor_status_sha256 !== statusRecord.sha256
    || grantDocument.completed_pages_sha256 !== sha256(canonicalJson(completedPages))
    || grantDocument.failed_pages_sha256 !== sha256(canonicalJson(stateSummary.failedPages))
    || grantDocument.error_sha256 !== sha256(progress.error)
    || grantDocument.first_missing_page !== expectedFirstMissingPage
    || !sameJson(completedPages, Array.from(
      { length: grantDocument.first_missing_page - 1 },
      (_, index) => index + 1,
    ))) {
    throw new Error(`${documentId}: timeout recovery grant frontier differs from predecessor controls`);
  }
  return {
    log: logRecord,
    incident: incidentRecord,
    summary: {
      document_id: documentId,
      attempt: maxDocumentAttempts,
      timeout_type: 'idle_timeout',
      evidence_origin: incident.evidence_origin,
      path: `seed-predecessor-evidence/timeout-incidents/${documentId}/attempt-0005.json`,
      raw_sha256: incidentRecord.sha256,
      sidecar_path: `seed-predecessor-evidence/timeout-incidents/${documentId}/attempt-0005.json.sha256`,
      sidecar_sha256: incidentRecord.sidecar_sha256,
      log_sha256: logRecord.sha256,
      citation_allowed: false,
    },
  };
}

export async function inspectPredecessorB1(predecessorRoot) {
  const root = await requireRealDirectory(predecessorRoot, 'B1 predecessor output');
  const rootEntries = (await readdir(root, { withFileTypes: true })).map((entry) => entry.name);
  const requiredRootEntries = [
    'documents',
    'paddlex-cache',
    'status',
    'run-identity.json',
    'run-status.json',
    'run-status.json.sha256',
  ];
  const recoveryRootEntries = [
    timeoutRecoveryGrantFilename,
    `${timeoutRecoveryGrantFilename}.sha256`,
    'timeout-incidents',
  ];
  const hasAnyTimeoutRecoveryEvidence = recoveryRootEntries.some((name) => rootEntries.includes(name));
  const allowedRootEntries = new Set([
    ...requiredRootEntries,
    'logs',
    ...(hasAnyTimeoutRecoveryEvidence ? recoveryRootEntries : []),
  ]);
  if (requiredRootEntries.some((name) => !rootEntries.includes(name))
    || (hasAnyTimeoutRecoveryEvidence
      && recoveryRootEntries.some((name) => !rootEntries.includes(name)))
    || rootEntries.some((name) => !allowedRootEntries.has(name))) {
    throw new Error(`B1 predecessor root contains missing or unexpected entries: ${rootEntries.sort().join(',')}`);
  }
  for (const name of rootEntries) {
    const info = await lstat(path.join(root, name));
    if (info.isSymbolicLink()) throw new Error('B1 predecessor root contains a symbolic link');
  }
  const [documentsRoot, statusRoot] = await Promise.all([
    requireRealDirectory(path.join(root, 'documents'), 'B1 documents root'),
    requireRealDirectory(path.join(root, 'status'), 'B1 status root'),
  ]);
  const [identityRecord, runStatusRecord] = await Promise.all([
    readStableJson(root, path.join(root, 'run-identity.json'), 'B1 run identity'),
    readHashBoundJson(root, path.join(root, 'run-status.json'), 'B1 run status'),
  ]);
  const identity = requireObject(identityRecord.value, 'B1 run identity');
  const runStatus = requireObject(runStatusRecord.value, 'B1 run status');
  if (identity.schema_version !== 1
    || identity.citation_allowed !== false
    || identity.whole_document_atomic !== true
    || identity.seed_lineage !== undefined
    || identity.runner_script_sha256 !== legacyB1RunnerScriptSha256) {
    throw new Error('B1 run identity is not the exact unseeded fail-closed lineage');
  }
  requireSha256(identity.manifest_sha256, 'B1 manifest SHA-256');
  requireSha256(identity.runtime_fingerprint_sha256, 'B1 runtime fingerprint SHA-256');
  requireSha256(identity.ocr_script_sha256, 'B1 OCR script SHA-256');
  if (identity.runtime_fingerprint_sha256 !== sha256(`${JSON.stringify(identity.runtime_fingerprint)}\n`)) {
    throw new Error('B1 runtime fingerprint hash mismatch');
  }
  if (runStatus.schema_version !== 1
    || runStatus.citation_allowed !== false
    || runStatus.seed_lineage !== undefined
    || runStatus.manifest_sha256 !== identity.manifest_sha256
    || runStatus.runtime_fingerprint_sha256 !== identity.runtime_fingerprint_sha256
    || !sameJson(runStatus.document_recovery, identity.document_recovery)) {
    throw new Error('B1 run status differs from its run identity');
  }
  requireObject(identity.worker_configuration, 'B1 worker configuration');
  requireObject(identity.document_recovery, 'B1 document recovery');
  let timeoutRecovery = null;
  if (hasAnyTimeoutRecoveryEvidence) {
    const grantRecord = await readHashBoundAuthorityJson(
      root,
      path.join(root, timeoutRecoveryGrantFilename),
      'B1 timeout recovery grant',
    );
    requireCanonicalPrettyJson(grantRecord, 'B1 timeout recovery grant');
    const grant = validateTimeoutRecoveryGrantShape(grantRecord.value, identity.manifest_sha256);
    if (grant.predecessor.run_identity_sha256 !== identityRecord.sha256
      || grant.predecessor.run_status_sha256 !== runStatusRecord.sha256) {
      throw new Error('B1 timeout recovery grant is not bound to the exact predecessor controls');
    }
    timeoutRecovery = {
      grant,
      raw: grantRecord.raw,
      raw_sha256: grantRecord.sha256,
      sidecar_raw: grantRecord.sidecar_raw,
      sidecar_sha256: grantRecord.sidecar_sha256,
      summary: timeoutRecoverySummary(grant, grantRecord.sha256, grantRecord.sidecar_sha256),
      incidents: new Map(),
    };
  }
  const paddlexLayoutModelCache = await inspectBoundPaddlexCache(root, identity, 'B1');
  const statusDocuments = Object.entries(requireObject(runStatus.documents, 'B1 run status documents'));
  if (statusDocuments.length === 0) throw new Error('B1 run status has no documents');
  const documents = statusDocuments.map(([documentId, progress]) => {
    requireDocumentId(documentId);
    return [documentId, validateProgress(progress, requirePositiveInteger(progress.page_count, 'B1 page_count'), `B1 ${documentId}`, true)];
  });
  const counts = assertRunCounts(runStatus, documents.map(([, progress]) => progress), 'B1 run status');
  const quarantinedIds = documents
    .filter(([, progress]) => progress.status === 'quarantined')
    .map(([documentId]) => documentId);
  if ((counts.quarantined > 0) !== Boolean(timeoutRecovery)
    || !sameJson(timeoutRecovery?.grant.documents.map((document) => document.document_id) || [], quarantinedIds)) {
    throw new Error('B1 quarantine set and timeout recovery grant differ');
  }
  if (timeoutRecovery) {
    await exactDirectoryEntries(
      path.join(root, 'timeout-incidents'),
      quarantinedIds,
      'B1 timeout incidents root',
    );
  }
  const expectedDocumentRoots = documents.filter(([, progress]) => progress.status !== 'pending').map(([id]) => id);
  const expectedStatusFiles = expectedDocumentRoots.flatMap((id) => [`${id}.json`, `${id}.json.sha256`]);
  await exactDirectoryEntries(documentsRoot, expectedDocumentRoots, 'B1 documents root');
  await exactDirectoryEntries(statusRoot, expectedStatusFiles, 'B1 status root');
  if (rootEntries.includes('logs')) {
    const logsRoot = await requireRealDirectory(path.join(root, 'logs'), 'B1 logs root');
    const logEntries = await readdir(logsRoot, { withFileTypes: true });
    for (const entry of logEntries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.log')) throw new Error('B1 logs contain an unexpected entry');
      requireDocumentId(entry.name.slice(0, -4), 'B1 log document id');
      if (!runStatus.documents[entry.name.slice(0, -4)]) throw new Error('B1 logs contain an unknown document');
    }
  }

  const stateHashRecords = [];
  const statusHashRecords = [];
  const artifactHashRecords = [];
  const publicDocuments = [];
  const aggregatePageArtifacts = [];
  let completedPages = 0;
  let latestProgressMilliseconds = runStatusRecord.metadata.mtimeMs;

  for (const [documentId, progress] of documents) {
    if (progress.status === 'pending') {
      publicDocuments.push({
        document_id: documentId,
        page_count: progress.page_count,
        predecessor_status: 'pending',
        predecessor_status_format: 'pending_no_status',
        inherited_attempts: 0,
        completed_pages: [],
        failed_pages: [],
        predecessor_document_tree: null,
        predecessor_pages_tree: null,
        predecessor_state_sha256: null,
        predecessor_configuration_sha256: sha256(canonicalJson(identity.worker_configuration)),
        predecessor_status_sha256: null,
        predecessor_status_sidecar_sha256: null,
        inherited_page_artifacts: [],
        inherited_page_artifacts_sha256: sha256(canonicalJson([])),
      });
      continue;
    }
    const documentRoot = await requireRealDirectory(path.join(documentsRoot, documentId), 'B1 document root');
    await exactDirectoryEntries(documentRoot, ['pages', 'state.json'], 'B1 document root');
    const pagesRoot = await requireRealDirectory(path.join(documentRoot, 'pages'), 'B1 pages root');
    const [stateRecord, statusRecord] = await Promise.all([
      readStableJson(root, path.join(documentRoot, 'state.json'), 'B1 state'),
      readHashBoundJson(root, path.join(statusRoot, `${documentId}.json`), 'B1 document status'),
    ]);
    latestProgressMilliseconds = Math.max(latestProgressMilliseconds, stateRecord.metadata.mtimeMs, statusRecord.metadata.mtimeMs);
    const state = stateRecord.value;
    const stateSummary = validateBaseState(state, documentId, progress.page_count, 'B1 state');
    if (stateSummary.failedPageNumbers.length !== 0) throw new Error('B1 predecessor contains failed pages');
    const physicalPages = (await readdir(pagesRoot, { withFileTypes: true })).map((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^\d{4}$/u.test(entry.name)) {
        throw new Error('B1 pages root contains an unexpected entry');
      }
      return Number(entry.name);
    }).sort((left, right) => left - right);
    if (!sameJson(physicalPages, stateSummary.completedPages)) throw new Error('B1 physical pages differ from state');
    const status = requireObject(statusRecord.value, 'B1 document status');
    if (status.schema_version !== 1
      || status.document_id !== documentId
      || status.status !== progress.status
      || status.citation_allowed !== false
      || progress.status_json_sha256 !== statusRecord.sha256) {
      throw new Error('B1 document status differs from run status');
    }
    if (status.attempt !== undefined && status.attempt !== progress.attempts) throw new Error('B1 status attempt mismatch');
    if (status.page_count !== undefined && status.page_count !== progress.page_count) throw new Error('B1 status page_count mismatch');
    if (status.runtime_fingerprint_sha256 !== undefined
      && status.runtime_fingerprint_sha256 !== identity.runtime_fingerprint_sha256) {
      throw new Error('B1 status runtime fingerprint mismatch');
    }
    const grantDocument = timeoutRecovery?.grant.documents.find(
      (document) => document.document_id === documentId,
    ) || null;
    const recoveryEvidence = grantDocument
      ? await inspectTimeoutRecoveryIncident({
          root,
          documentId,
          pageCount: progress.page_count,
          progress,
          state,
          stateRecord,
          stateSummary,
          status,
          statusRecord,
          identity,
          grantDocument,
        })
      : null;
    if (!grantDocument && progress.status === 'quarantined') {
      throw new Error(`${documentId}: quarantined predecessor lacks an exact timeout recovery grant`);
    }
    if (recoveryEvidence) timeoutRecovery.incidents.set(documentId, recoveryEvidence);
    const pageArtifacts = [];
    for (const page of stateSummary.completedPages) {
      const artifact = await inspectPageTree(root, documentId, page, stateSummary.pages[String(page)]);
      const { tree, ...publicArtifact } = artifact;
      pageArtifacts.push(publicArtifact);
      aggregatePageArtifacts.push({ document_id: documentId, ...publicArtifact });
      for (const entry of tree.entries.filter((value) => value.startsWith('F\0'))) {
        const [, relative, bytes, digest] = entry.trimEnd().split('\0');
        artifactHashRecords.push({
          path: `documents/${documentId}/pages/${String(page).padStart(4, '0')}/${relative}`,
          bytes: Number(bytes),
          sha256: digest,
        });
      }
    }
    const [documentTree, pagesTree] = await Promise.all([
      inspectTreeStrict(documentRoot),
      inspectTreeStrict(pagesRoot),
    ]);
    stateHashRecords.push({ document_id: documentId, bytes: stateRecord.bytes, sha256: stateRecord.sha256 });
    statusHashRecords.push({
      document_id: documentId,
      body_sha256: statusRecord.sha256,
      sidecar_sha256: statusRecord.sidecar_sha256,
    });
    completedPages += stateSummary.completedPages.length;
    const validationPageArtifacts = stateSummary.completedPages.map((page) => ({
      page_number: page,
      rendered_image_sha256: stateSummary.pages[String(page)].rendered_image_sha256,
      result_json_sha256: stateSummary.pages[String(page)].result_json_sha256,
      content_markdown_sha256: stateSummary.pages[String(page)].content_markdown_sha256,
      citation_eligible: false,
    }));
    publicDocuments.push({
      document_id: documentId,
      page_count: progress.page_count,
      predecessor_status: progress.status,
      predecessor_status_format: predecessorStatusFormat(
        identity,
        progress,
        status,
        statusRecord.sha256,
        state,
        stateRecord.sha256,
        validationPageArtifacts,
      ),
      inherited_attempts: progress.attempts,
      completed_pages: stateSummary.completedPages,
      failed_pages: [],
      predecessor_document_tree: {
        tree_sha256: documentTree.tree_sha256,
        files: documentTree.files,
        bytes: documentTree.bytes,
      },
      predecessor_pages_tree: {
        tree_sha256: pagesTree.tree_sha256,
        files: pagesTree.files,
        bytes: pagesTree.bytes,
      },
      predecessor_state_sha256: stateRecord.sha256,
      predecessor_configuration_sha256: sha256(canonicalJson(state.configuration)),
      predecessor_status_sha256: statusRecord.sha256,
      predecessor_status_sidecar_sha256: statusRecord.sidecar_sha256,
      ...(recoveryEvidence ? {
        timeout_log: {
          path: grantDocument.timeout_log.path,
          bytes: recoveryEvidence.log.bytes,
          sha256: recoveryEvidence.log.sha256,
        },
      } : {}),
      inherited_page_artifacts: pageArtifacts,
      inherited_page_artifacts_sha256: sha256(canonicalJson(pageArtifacts)),
    });
  }

  const anchors = {
    identity_sha256: identityRecord.sha256,
    run_status_sha256: runStatusRecord.sha256,
    state_hashset_sha256: fingerprintRecords(stateHashRecords.sort((left, right) => compareText(left.document_id, right.document_id))),
    status_hashset_sha256: fingerprintRecords(statusHashRecords.sort((left, right) => compareText(left.document_id, right.document_id))),
    artifact_hashset_sha256: fingerprintRecords(artifactHashRecords.sort((left, right) => compareText(left.path, right.path))),
  };
  const pageArtifactsSha256 = sha256(canonicalJson(aggregatePageArtifacts));
  const snapshotBasis = {
    manifest_sha256: identity.manifest_sha256,
    run_identity_sha256: identityRecord.sha256,
    run_status_sha256: runStatusRecord.sha256,
    run_status_sidecar_sha256: runStatusRecord.sidecar_sha256,
    runtime_fingerprint_sha256: identity.runtime_fingerprint_sha256,
    worker_configuration_sha256: sha256(canonicalJson(identity.worker_configuration)),
    document_recovery_sha256: sha256(canonicalJson(identity.document_recovery)),
    completed_pages: completedPages,
    failed_pages: 0,
    quarantined_documents: counts.quarantined,
    ...(timeoutRecovery ? {
      timeout_recovery_grant_id: timeoutRecovery.grant.grant_id,
      timeout_recovery_grant_raw_sha256: timeoutRecovery.raw_sha256,
      timeout_recovery_grant_sidecar_sha256: timeoutRecovery.sidecar_sha256,
    } : {}),
    page_artifacts_sha256: pageArtifactsSha256,
    documents: publicDocuments,
  };
  return {
    root,
    identity,
    identity_record: identityRecord,
    run_status: runStatus,
    run_status_record: runStatusRecord,
    counts,
    documents: publicDocuments,
    completed_pages: completedPages,
    failed_pages: 0,
    quarantined_documents: counts.quarantined,
    page_artifacts_sha256: pageArtifactsSha256,
    snapshot_sha256: sha256(canonicalJson(snapshotBasis)),
    anchors,
    paddlex_layout_model_cache: paddlexLayoutModelCache,
    latest_progress_at: iso(latestProgressMilliseconds),
    _snapshot_basis: snapshotBasis,
    _timeout_recovery: timeoutRecovery,
  };
}

function compareReceiptDocument(receiptDocument, predecessorDocument) {
  const predecessorKeys = Object.keys(predecessorDocument).sort();
  const stripped = Object.fromEntries(
    Object.entries(receiptDocument).filter(([key]) => ![
      'successor_document_tree',
      'successor_state_sha256',
      'successor_status_sha256',
      'timeout_recovery',
    ].includes(key)),
  );
  if (!sameJson(Object.keys(stripped).sort(), predecessorKeys)
    || canonicalJson(stripped) !== canonicalJson(predecessorDocument)) {
    const differingKey = [...new Set([...Object.keys(stripped), ...predecessorKeys])]
      .find((key) => !sameJson(stripped[key], predecessorDocument[key]));
    const missingKeys = predecessorKeys.filter((key) => !(key in stripped));
    const extraKeys = Object.keys(stripped).filter((key) => !(key in predecessorDocument));
    throw new Error(
      `seed receipt document ${receiptDocument.document_id || 'unknown'} differs from the exact B1 snapshot${differingKey ? ` at ${differingKey}` : ''}${missingKeys.length ? ` missing ${missingKeys.join(',')}` : ''}${extraKeys.length ? ` extra ${extraKeys.join(',')}` : ''}`,
    );
  }
}

async function validatePredecessorEvidence(successorRoot, receipt, predecessor) {
  const evidenceRoot = await requireRealDirectory(
    path.join(successorRoot, 'seed-predecessor-evidence'),
    'seed predecessor evidence root',
  );
  const tree = await inspectTreeStrict(evidenceRoot);
  const contract = requireObject(receipt.predecessor.control_evidence, 'seed predecessor evidence contract');
  if (contract.directory !== 'seed-predecessor-evidence'
    || contract.tree_sha256 !== tree.tree_sha256
    || contract.files !== tree.files
    || contract.bytes !== tree.bytes) {
    throw new Error('seed predecessor evidence tree differs from receipt');
  }
  const inventoryRecord = await readStableJson(evidenceRoot, path.join(evidenceRoot, 'inventory.json'), 'seed predecessor inventory');
  if (inventoryRecord.sha256 !== contract.inventory_sha256) throw new Error('seed predecessor inventory differs from receipt');
  const inventory = requireObject(inventoryRecord.value, 'seed predecessor inventory');
  if (inventory.schema_version !== 1
    || inventory.evidence_type !== 'curriculum_remote_ocr_seed_predecessor_controls'
    || inventory.manifest_sha256 !== predecessor.identity.manifest_sha256
    || inventory.runner_script_sha256 !== legacyB1RunnerScriptSha256
    || inventory.citation_allowed !== false) {
    throw new Error('seed predecessor inventory identity is invalid');
  }
  const expectedFiles = [
    ['run-identity.json', predecessor.identity_record],
    ['run-status.json', predecessor.run_status_record],
    ['run-status.json.sha256', {
      raw: predecessor.run_status_record.sidecar_raw,
      sha256: predecessor.run_status_record.sidecar_sha256,
      bytes: predecessor.run_status_record.sidecar_raw.byteLength,
    }],
  ];
  const expectedInventoryDocuments = [];
  for (const document of predecessor.documents) {
    const statePath = `documents/${document.document_id}/state.json`;
    const statusPath = `status/${document.document_id}.json`;
    if (document.predecessor_status === 'pending') {
      expectedInventoryDocuments.push({
        document_id: document.document_id,
        predecessor_status: 'pending',
        state: { present: false, path: statePath },
        status: { present: false, path: statusPath, sidecar_path: `${statusPath}.sha256` },
      });
      continue;
    }
    const stateRecord = await readStableRaw(predecessor.root, path.join(predecessor.root, statePath), 'B1 evidence state');
    const statusRecord = await readStableRaw(predecessor.root, path.join(predecessor.root, statusPath), 'B1 evidence status');
    const sidecarRecord = await readStableRaw(predecessor.root, path.join(predecessor.root, `${statusPath}.sha256`), 'B1 evidence status sidecar');
    expectedFiles.push([statePath, stateRecord], [statusPath, statusRecord], [`${statusPath}.sha256`, sidecarRecord]);
    const recoveryEvidence = predecessor._timeout_recovery?.incidents.get(document.document_id) || null;
    const timeoutLogPath = `logs/${document.document_id}.log`;
    const incidentPath = `timeout-incidents/${document.document_id}/attempt-0005.json`;
    const incidentSidecarPath = `${incidentPath}.sha256`;
    if (recoveryEvidence) {
      expectedFiles.push(
        [timeoutLogPath, recoveryEvidence.log],
        [incidentPath, recoveryEvidence.incident],
        [incidentSidecarPath, {
          raw: recoveryEvidence.incident.sidecar_raw,
          sha256: recoveryEvidence.incident.sidecar_sha256,
          bytes: recoveryEvidence.incident.sidecar_raw.byteLength,
        }],
      );
    }
    expectedInventoryDocuments.push({
      document_id: document.document_id,
      predecessor_status: document.predecessor_status,
      state: { present: true, path: statePath, bytes: stateRecord.bytes, sha256: stateRecord.sha256 },
      status: {
        present: true,
        path: statusPath,
        bytes: statusRecord.bytes,
        sha256: statusRecord.sha256,
        sidecar: {
          path: `${statusPath}.sha256`,
          bytes: sidecarRecord.bytes,
          sha256: sidecarRecord.sha256,
        },
      },
      ...(recoveryEvidence ? {
        timeout_log: {
          path: timeoutLogPath,
          bytes: recoveryEvidence.log.bytes,
          sha256: recoveryEvidence.log.sha256,
        },
        timeout_incident: {
          document_id: document.document_id,
          attempt: maxDocumentAttempts,
          timeout_type: 'idle_timeout',
          evidence_origin: recoveryEvidence.incident.value.evidence_origin,
          raw: {
            path: incidentPath,
            bytes: recoveryEvidence.incident.bytes,
            sha256: recoveryEvidence.incident.sha256,
          },
          sidecar: {
            path: incidentSidecarPath,
            bytes: recoveryEvidence.incident.sidecar_raw.byteLength,
            sha256: recoveryEvidence.incident.sidecar_sha256,
          },
          log_sha256: recoveryEvidence.log.sha256,
          citation_allowed: false,
        },
      } : {}),
    });
  }
  expectedFiles.sort(([left], [right]) => compareText(left, right));
  const expectedFileRecords = expectedFiles.map(([relativePath, record]) => ({
    path: relativePath,
    bytes: record.bytes,
    sha256: record.sha256,
  }));
  if (!sameJson(inventory.files, expectedFileRecords) || !sameJson(inventory.documents, expectedInventoryDocuments)) {
    throw new Error('seed predecessor inventory differs from B1 controls');
  }
  const expectedTreePaths = new Set(['inventory.json', ...expectedFiles.map(([relativePath]) => relativePath)]);
  const actualFilePaths = tree.entries.filter((entry) => entry.startsWith('F\0')).map((entry) => entry.split('\0')[1]);
  if (actualFilePaths.some((relativePath) => !expectedTreePaths.has(relativePath))
    || expectedTreePaths.size !== actualFilePaths.length) {
    throw new Error('seed predecessor evidence contains missing or unexpected files');
  }
  for (const [relativePath, sourceRecord] of expectedFiles) {
    const copied = await readStableRaw(evidenceRoot, path.join(evidenceRoot, relativePath), 'seed predecessor evidence file');
    if (copied.sha256 !== sourceRecord.sha256 || copied.bytes !== sourceRecord.bytes) {
      throw new Error('seed predecessor evidence bytes differ from B1');
    }
  }
  return { tree, inventory_sha256: inventoryRecord.sha256 };
}

function validateReceiptPredecessor(receipt, predecessor) {
  const contract = requireObject(receipt.predecessor, 'seed receipt predecessor');
  const expected = predecessor._snapshot_basis;
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'documents' || key.startsWith('timeout_recovery_')) continue;
    if (!sameJson(contract[key], value)) throw new Error(`seed receipt predecessor ${key} differs from B1`);
  }
  if (contract.runner_script_sha256 !== predecessor.identity.runner_script_sha256
    || contract.ocr_script_sha256 !== predecessor.identity.ocr_script_sha256
    || !sameJson(contract.runtime, predecessor.identity.runtime)
    || !sameJson(contract.runtime_fingerprint, predecessor.identity.runtime_fingerprint)
    || !sameJson(contract.worker_configuration, predecessor.identity.worker_configuration)
    || !sameJson(contract.document_recovery, predecessor.identity.document_recovery)) {
    throw new Error('seed receipt predecessor runtime controls differ from B1');
  }
  if (receipt.documents.length !== predecessor.documents.length) throw new Error('seed receipt document count differs from B1');
  for (let index = 0; index < predecessor.documents.length; index += 1) {
    compareReceiptDocument(receipt.documents[index], predecessor.documents[index]);
  }
}

function expectedStateConfiguration(identity) {
  const runtime = requireObject(identity.runtime, 'B2 runtime');
  const worker = requireObject(identity.worker_configuration, 'B2 worker configuration');
  const python = requireObject(worker.python_runtime, 'B2 Python runtime');
  const packages = requireObject(python.packages, 'B2 Python packages');
  return {
    pipeline: runtime.pipeline,
    pipeline_version: runtime.pipeline_version,
    layout_model: 'PP-DocLayoutV3',
    recognizer: 'PaddleOCR-VL-1.6-0.9B official GGUF',
    recognizer_backend: 'llama-cpp-server',
    recognizer_server_url: worker.llama_url,
    dpi: runtime.render_dpi,
    device: worker.runtime_device,
    python: python.python_version,
    paddlepaddle: packages.paddlepaddle,
    paddleocr: packages.paddleocr,
    paddlex: packages.paddlex,
    vl_rec_max_concurrency: worker.vl_rec_max_concurrency,
    server_parallel: worker.server_parallel,
    micro_batch: worker.micro_batch,
    use_queues: worker.use_queues,
  };
}

function validateNormalizedRecoveryStatus(receiptDocument, progress, status, statusSha256, identity) {
  if (progress.status !== 'retry_wait' || !['running', 'failed', 'interrupted'].includes(status.status)) {
    return false;
  }
  if (!Number.isSafeInteger(progress.attempts)
    || progress.attempts < 1
    || progress.attempts >= maxDocumentAttempts
    || status.attempt !== progress.attempts
    || status.max_attempts !== maxDocumentAttempts
    || progress.status_json_sha256 !== statusSha256) {
    throw new Error('B2 normalized recovery attempt or status hash is invalid');
  }
  const timestampField = {
    running: 'started_at',
    failed: 'failed_at',
    interrupted: 'interrupted_at',
  }[status.status];
  const rawStatusRecordedAt = status[timestampField];
  if (typeof rawStatusRecordedAt !== 'string'
    || !Number.isFinite(Date.parse(rawStatusRecordedAt))
    || new Date(Date.parse(rawStatusRecordedAt)).toISOString() !== rawStatusRecordedAt
    || progress[timestampField] !== rawStatusRecordedAt) {
    throw new Error('B2 normalized recovery timestamp is invalid');
  }
  const recoveryRecordedAt = progress.interrupted_at || progress.failed_at || progress.started_at;
  if (typeof recoveryRecordedAt !== 'string'
    || !Number.isFinite(Date.parse(recoveryRecordedAt))
    || new Date(Date.parse(recoveryRecordedAt)).toISOString() !== recoveryRecordedAt) {
    throw new Error('B2 normalized recovery source timestamp is invalid');
  }
  const expectedNextRetry = new Date(
    Date.parse(recoveryRecordedAt) + documentRetryBackoffMilliseconds[progress.attempts - 1],
  ).toISOString();
  if (progress.next_retry_at !== expectedNextRetry) {
    throw new Error('B2 normalized recovery backoff is invalid');
  }

  const keys = Object.keys(status).sort();
  const legacyInterruptedKeys = [
    'attempt',
    'citation_allowed',
    'document_id',
    'interrupted_at',
    'max_attempts',
    'runtime_fingerprint_sha256',
    'schema_version',
    'seed_lineage',
    'status',
  ].sort();
  const legacyInterrupted = status.status === 'interrupted'
    && receiptDocument.predecessor_status_format === 'legacy_b1_interrupted'
    && progress.attempts === receiptDocument.inherited_attempts
    && statusSha256 === receiptDocument.successor_status_sha256
    && status.page_count === undefined
    && sameJson(keys, legacyInterruptedKeys);
  if (legacyInterrupted) {
    const lineage = requireObject(status.seed_lineage, 'B2 normalized legacy status seed lineage');
    if (!sameJson(Object.keys(lineage).sort(), [
      'citation_allowed',
      'inherited_attempts',
      'predecessor_status_sha256',
      'schema_version',
      'seed_id',
    ].sort()) || lineage.schema_version !== 1) {
      throw new Error('B2 normalized legacy status seed lineage shape is invalid');
    }
  }
  if (!legacyInterrupted) {
    const statusSpecificKeys = {
      running: ['started_at'],
      failed: ['error', 'failed_at'],
      interrupted: ['interrupted_at'],
    }[status.status];
    const fullKeys = [
      'attempt',
      'citation_allowed',
      'document_id',
      'max_attempts',
      'page_count',
      'runtime_fingerprint_sha256',
      'schema_version',
      'status',
      ...statusSpecificKeys,
    ].sort();
    if (!sameJson(keys, fullKeys) || status.page_count !== receiptDocument.page_count) {
      throw new Error('B2 normalized recovery raw status shape is invalid');
    }
  }
  if (status.runtime_fingerprint_sha256 !== identity.runtime_fingerprint_sha256
    || status.citation_allowed !== false
    || (status.status === 'failed'
      && (typeof status.error !== 'string' || !status.error || status.error !== progress.error))) {
    throw new Error('B2 normalized recovery raw status identity is invalid');
  }
  return true;
}

function validateLegacyAllowedSeedDelta(receipt, predecessor, identity) {
  if (!sameJson(predecessor.identity.runtime, identity.runtime)
    || !sameJson(predecessor.identity.runtime_fingerprint, identity.runtime_fingerprint)
    || predecessor.identity.runtime_fingerprint_sha256 !== identity.runtime_fingerprint_sha256
    || !sameJson(predecessor.identity.llama_server_attestation, identity.llama_server_attestation)
    || predecessor.identity.input_root !== identity.input_root
    || predecessor.identity.python_invocation_path !== identity.python_invocation_path
    || predecessor.identity.python_resolved_target !== identity.python_resolved_target) {
    throw new Error('B2 changes a forbidden B1 runtime, input, Python, or llama identity');
  }
  const predecessorWorker = requireObject(predecessor.identity.worker_configuration, 'B1 worker configuration');
  const successorWorker = requireObject(identity.worker_configuration, 'B2 worker configuration');
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
    || successorWorker.server_parallel !== 4
    || predecessorWorker.micro_batch !== 16
    || successorWorker.micro_batch !== 16
    || predecessorWorker.use_queues !== true
    || successorWorker.use_queues !== true) {
    throw new Error('B2 worker configuration is outside the audited concurrency delta');
  }
  for (const key of workerKeys.filter((value) => !['vl_rec_max_concurrency', 'paddlex_cache_home'].includes(value))) {
    if (!sameJson(predecessorWorker[key], successorWorker[key])) throw new Error(`B2 changes forbidden worker field ${key}`);
  }
  if (predecessorWorker.paddlex_cache_home !== successorWorker.paddlex_cache_home
    && predecessorWorker.paddlex_layout_model_cache_sha256 !== successorWorker.paddlex_layout_model_cache_sha256) {
    throw new Error('B2 cache path changed without an identical cache tree hash');
  }
  const predecessorRecovery = structuredClone(predecessor.identity.document_recovery);
  const successorRecovery = structuredClone(identity.document_recovery);
  const predecessorIdle = predecessorRecovery.child_monitoring?.idle_timeout_seconds;
  const successorIdle = successorRecovery.child_monitoring?.idle_timeout_seconds;
  if (predecessorIdle !== 300 || successorIdle !== 1200) {
    throw new Error('B2 child idle timeout is outside the audited 300 to 1200 second delta');
  }
  delete predecessorRecovery.child_monitoring.idle_timeout_seconds;
  delete successorRecovery.child_monitoring.idle_timeout_seconds;
  if (!sameJson(predecessorRecovery, successorRecovery)) throw new Error('B2 changes a forbidden recovery field');
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
    throw new Error('B2 receipt allowed configuration delta is invalid');
  }
}

export function validateP4ToP1MonitorDelta(receipt, predecessorIdentity, successorIdentity) {
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

function validateAllowedSeedDelta(receipt, predecessor, identity) {
  if (receipt.allowed_configuration_delta?.schema_version === 1) {
    validateLegacyAllowedSeedDelta(receipt, predecessor, identity);
    return null;
  }
  return validateP4ToP1MonitorDelta(receipt, predecessor.identity, identity);
}

function requireTimeoutIncidentReceiptSummary(value, grantDocument, predecessorIncident) {
  const summary = requireObject(value, `${grantDocument.document_id} predecessor incident summary`);
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
    || canonicalJson(summary) !== canonicalJson(predecessorIncident.summary)) {
    throw new Error(`${grantDocument.document_id}: predecessor incident receipt summary is invalid`);
  }
  return summary;
}

async function validateTimeoutRecoverySuccessorEvidence({
  root,
  receipt,
  lineage,
  predecessor,
  configurationTransition,
}) {
  const predecessorRecovery = predecessor._timeout_recovery;
  const declared = containsTimeoutRecoveryKey(receipt) || containsTimeoutRecoveryKey(lineage);
  if (!predecessorRecovery) {
    if (declared) throw new Error('no-grant seed contains timeout recovery fields');
    return null;
  }
  if (!declared || !isAuditedP4ToP1Transition(configurationTransition)) {
    throw new Error('timeout recovery requires an exact audited p4-to-p1 transition');
  }
  const grantRecord = await readHashBoundAuthorityJson(
    root,
    path.join(root, timeoutRecoveryGrantFilename),
    'B2 timeout recovery grant',
  );
  requireCanonicalPrettyJson(grantRecord, 'B2 timeout recovery grant');
  const grant = validateTimeoutRecoveryGrantShape(grantRecord.value, receipt.manifest_sha256);
  if (grantRecord.sha256 !== predecessorRecovery.raw_sha256
    || grantRecord.sidecar_sha256 !== predecessorRecovery.sidecar_sha256
    || !grantRecord.raw.equals(predecessorRecovery.raw)
    || !grantRecord.sidecar_raw.equals(predecessorRecovery.sidecar_raw)
    || !sameJson(grant, predecessorRecovery.grant)
    || !sameJson(receipt.timeout_recovery_grant, predecessorRecovery.summary)) {
    throw new Error('B2 timeout recovery grant differs from the exact B1 grant');
  }
  const grantDocumentIds = grant.documents.map((document) => document.document_id);
  if (lineage.timeout_recovery_grant_id !== grant.grant_id
    || lineage.timeout_recovery_grant_sha256 !== grantRecord.sha256
    || !sameJson(lineage.timeout_recovery_documents, grantDocumentIds)) {
    throw new Error('B2 timeout recovery grant differs from identity lineage');
  }
  const receiptDocuments = new Map(receipt.documents.map((document) => [document.document_id, document]));
  const incidentEvidence = grant.documents.map((grantDocument) => {
    const receiptDocument = receiptDocuments.get(grantDocument.document_id);
    const predecessorIncident = predecessorRecovery.incidents.get(grantDocument.document_id);
    const recovery = requireObject(receiptDocument?.timeout_recovery, `${grantDocument.document_id} timeout recovery receipt`);
    if (!predecessorIncident
      || !sameJson(Object.keys(recovery).sort(), [
        'first_missing_page',
        'grant_id',
        'grant_raw_sha256',
        'granted_attempt',
        'predecessor_incident',
        'predecessor_log',
      ].sort())
      || recovery.grant_id !== grant.grant_id
      || recovery.grant_raw_sha256 !== grantRecord.sha256
      || recovery.granted_attempt !== maxDocumentAttempts + 1
      || recovery.first_missing_page !== grantDocument.first_missing_page
      || !sameJson(recovery.predecessor_log, {
        ...grantDocument.timeout_log,
        path: `seed-predecessor-evidence/${grantDocument.timeout_log.path}`,
      })) {
      throw new Error(`${grantDocument.document_id}: timeout recovery receipt grant binding is invalid`);
    }
    const incident = requireTimeoutIncidentReceiptSummary(
      recovery.predecessor_incident,
      grantDocument,
      predecessorIncident,
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
  for (const document of receipt.documents) {
    if (!grantDocumentIds.includes(document.document_id) && document.timeout_recovery !== undefined) {
      throw new Error(`${document.document_id}: timeout recovery receipt exists without a grant`);
    }
  }

  const claimKey = timeoutRecoveryPredecessorClaimKey(grant);
  const basename = `${claimKey}.issuance.json`;
  const issuanceRelativePath = `${timeoutRecoveryIssuanceDirectory}/${basename}`;
  const issuanceSummary = requireObject(receipt.timeout_recovery_issuance, 'timeout recovery issuance summary');
  if (!sameJson(Object.keys(issuanceSummary).sort(), [
    'citation_allowed',
    'claim_key',
    'ledger_id',
    'path',
    'raw_sha256',
    'schema_version',
    'sidecar_path',
    'sidecar_sha256',
  ].sort())
    || issuanceSummary.schema_version !== 1
    || issuanceSummary.claim_key !== claimKey
    || issuanceSummary.ledger_id !== grant.consumption.ledger_id
    || issuanceSummary.path !== issuanceRelativePath
    || issuanceSummary.sidecar_path !== `${issuanceRelativePath}.sha256`
    || issuanceSummary.citation_allowed !== false
    || lineage.timeout_recovery_issuance_claim_key !== claimKey
    || lineage.timeout_recovery_issuance_sha256 !== issuanceSummary.raw_sha256) {
    throw new Error('timeout recovery issuance summary is not canonical or lineage-bound');
  }
  requireSha256(issuanceSummary.raw_sha256, 'timeout recovery issuance SHA-256');
  requireSha256(issuanceSummary.sidecar_sha256, 'timeout recovery issuance sidecar SHA-256');
  const issuanceRoot = await requireRealDirectory(
    path.join(root, timeoutRecoveryIssuanceDirectory),
    'timeout recovery issuance root',
  );
  await exactDirectoryEntries(issuanceRoot, [basename, `${basename}.sha256`], 'timeout recovery issuance root');
  const issuanceRecord = await readHashBoundAuthorityJson(
    root,
    path.join(issuanceRoot, basename),
    'timeout recovery issuance claim',
  );
  requireCanonicalPrettyJson(issuanceRecord, 'timeout recovery issuance claim');
  const issuance = requireObject(issuanceRecord.value, 'timeout recovery issuance claim');
  requireExactObjectKeyOrder(issuance, [
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
  requireExactObjectKeyOrder(issuance.predecessor, [
    'manifest_sha256', 'run_identity_sha256', 'run_status_sha256',
  ], 'timeout recovery issuance predecessor');
  for (const evidence of issuance.incident_evidence || []) {
    requireExactObjectKeyOrder(evidence, [
      'document_id', 'attempt', 'timeout_type', 'raw_sha256', 'sidecar_sha256', 'log_sha256',
    ], 'timeout recovery issuance incident evidence');
  }
  if (issuanceRecord.sha256 !== issuanceSummary.raw_sha256
    || issuanceRecord.sidecar_sha256 !== issuanceSummary.sidecar_sha256
    || !sameJson(Object.keys(issuance).sort(), [
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
    || issuance.schema_version !== 1
    || issuance.claim_type !== timeoutRecoveryIssuanceClaimType
    || issuance.claim_key !== claimKey
    || issuance.ledger_id !== grant.consumption.ledger_id
    || !sameJson(issuance.predecessor, grant.predecessor)
    || issuance.grant_id !== grant.grant_id
    || issuance.grant_raw_sha256 !== grantRecord.sha256
    || !sameJson(issuance.incident_evidence, incidentEvidence)
    || issuance.citation_allowed !== false) {
    throw new Error('timeout recovery issuance claim is not bound to grant and incidents');
  }

  const [ledgerRecord, consumptionRecord] = await Promise.all([
    readHashBoundAuthorityJson(
      root,
      path.join(root, timeoutRecoveryLedgerIdentityFilename),
      'timeout recovery ledger identity',
    ),
    readHashBoundAuthorityJson(
      root,
      path.join(root, timeoutRecoveryClaimFilename),
      'timeout recovery consumption claim',
    ),
  ]);
  requireCanonicalPrettyJson(ledgerRecord, 'timeout recovery ledger identity');
  requireCanonicalPrettyJson(consumptionRecord, 'timeout recovery consumption claim');
  const ledger = requireObject(ledgerRecord.value, 'timeout recovery ledger identity');
  requireExactObjectKeyOrder(ledger, [
    'schema_version', 'ledger_type', 'ledger_nonce', 'ledger_id', 'citation_allowed',
  ], 'timeout recovery ledger identity');
  const { ledger_id: _ledgerId, ...ledgerBasis } = ledger;
  if (!sameJson(Object.keys(ledger).sort(), [
    'citation_allowed', 'ledger_id', 'ledger_nonce', 'ledger_type', 'schema_version',
  ].sort())
    || ledger.schema_version !== 1
    || ledger.ledger_type !== timeoutRecoveryLedgerType
    || ledger.ledger_id !== sha256(canonicalJson(ledgerBasis))
    || ledger.ledger_id !== grant.consumption.ledger_id
    || ledger.citation_allowed !== false) {
    throw new Error('timeout recovery ledger identity is invalid');
  }
  requireSha256(ledger.ledger_nonce, 'timeout recovery ledger nonce');
  const claim = requireObject(consumptionRecord.value, 'timeout recovery consumption claim');
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
  requireExactObjectKeyOrder(claim.predecessor, [
    'manifest_sha256', 'run_identity_sha256', 'run_status_sha256',
  ], 'timeout recovery consumption predecessor');
  const expectedGrantedDocuments = grant.documents.map((document) => ({
    document_id: document.document_id,
    predecessor_status_sha256: document.predecessor_status_sha256,
    predecessor_state_sha256: document.predecessor_state_sha256,
    inherited_attempts: document.inherited_attempts,
    granted_attempt: document.granted_attempt,
  }));
  const outputInfo = await stat(root, { bigint: true });
  const successor = requireObject(claim.successor, 'timeout recovery consumption successor');
  requireExactObjectKeyOrder(successor, [
    'seed_id', 'output_root', 'output_device', 'output_inode',
  ], 'timeout recovery consumption successor');
  for (const document of claim.granted_documents || []) {
    requireExactObjectKeyOrder(document, [
      'document_id',
      'predecessor_status_sha256',
      'predecessor_state_sha256',
      'inherited_attempts',
      'granted_attempt',
    ], 'timeout recovery consumption granted document');
  }
  if (!sameJson(Object.keys(claim).sort(), [
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
  ].sort())
    || claim.schema_version !== 1
    || claim.claim_type !== timeoutRecoveryClaimType
    || claim.claim_mode !== timeoutRecoveryClaimMode
    || claim.ledger_id !== ledger.ledger_id
    || claim.ledger_root !== grant.consumption.ledger_root
    || claim.ledger_device !== grant.consumption.ledger_device
    || claim.ledger_inode !== grant.consumption.ledger_inode
    || claim.grant_id !== grant.grant_id
    || claim.grant_raw_sha256 !== grantRecord.sha256
    || !sameJson(claim.predecessor, grant.predecessor)
    || !sameJson(claim.granted_documents, expectedGrantedDocuments)
    || claim.citation_allowed !== false
    || !sameJson(Object.keys(successor).sort(), [
      'output_device', 'output_inode', 'output_root', 'seed_id',
    ].sort())
    || successor.output_root !== root
    || successor.output_device !== String(outputInfo.dev)
    || successor.output_inode !== String(outputInfo.ino)
    || successor.seed_id !== lineage.seed_id) {
    throw new Error('timeout recovery consumption claim is not bound to grant, ledger, and output');
  }
  const consumptionSummary = {
    ledger_id: ledger.ledger_id,
    ledger_identity_sha256: ledgerRecord.sha256,
    ledger_identity_sidecar_sha256: ledgerRecord.sidecar_sha256,
    claim_mode: timeoutRecoveryClaimMode,
    claim_sha256: consumptionRecord.sha256,
    claim_sidecar_sha256: consumptionRecord.sidecar_sha256,
  };
  if (!sameJson(receipt.timeout_recovery_consumption, consumptionSummary)
    || lineage.timeout_recovery_ledger_id !== ledger.ledger_id
    || lineage.timeout_recovery_claim_sha256 !== consumptionRecord.sha256) {
    throw new Error('timeout recovery consumption summary differs from lineage');
  }
  return {
    grant,
    grant_record: grantRecord,
    claim_key: claimKey,
    issuance_record: issuanceRecord,
    consumption_record: consumptionRecord,
    ledger_record: ledgerRecord,
  };
}

function markerItemsByName(marker, specifications) {
  const items = marker.installed_items;
  if (!Array.isArray(items) || items.length !== specifications.length) {
    throw new Error('seed marker installed item inventory is invalid');
  }
  if (!sameJson(items.map(({ name, type }) => ({ name, type })), specifications)) {
    throw new Error('seed marker installed item names or types differ from the contract');
  }
  if (marker.installed_items_sha256 !== sha256(canonicalJson(items))) {
    throw new Error('seed marker installed item inventory hash mismatch');
  }
  return new Map(items.map((item) => [item.name, item]));
}

async function inspectInstalledItem(successorRoot, specification) {
  const pathname = path.join(successorRoot, specification.name);
  if (specification.type === 'directory') {
    const { entries: _entries, ...fingerprint } = await inspectTreeStrict(pathname);
    return fingerprint;
  }
  const record = await readStableRaw(successorRoot, pathname, `seed item ${specification.name}`);
  return { sha256: record.sha256, bytes: record.bytes };
}

export async function inspectSuccessorB2(successorRoot, predecessor, nowMilliseconds = Date.now()) {
  const root = await requireRealDirectory(successorRoot, 'B2 successor output');
  const requiredRootEntries = [
    '.seed-journal.json',
    '.seed-journal.json.sha256',
    'documents',
    'logs',
    'paddlex-cache',
    'run-identity.json',
    'run-status.json',
    'run-status.json.sha256',
    'seed-commit.json',
    'seed-commit.json.sha256',
    'seed-predecessor-evidence',
    'seed-receipt.json',
    'seed-receipt.json.sha256',
    'status',
  ];
  const rootEntries = await readdir(root, { withFileTypes: true });
  const names = rootEntries.map((entry) => entry.name);
  const recoveryRootEntries = timeoutRecoveryInstalledItemSpecifications.map(({ name }) => name);
  const hasAnyRecoveryRootEntry = recoveryRootEntries.some((name) => names.includes(name));
  const allowedRootEntries = new Set([
    ...requiredRootEntries,
    '.remote-ocr-orchestrator.lock',
    ...(hasAnyRecoveryRootEntry ? recoveryRootEntries : []),
  ]);
  if (requiredRootEntries.some((name) => !names.includes(name)) || names.some((name) => !allowedRootEntries.has(name))) {
    throw new Error('B2 successor root contains missing or unexpected entries');
  }
  if (hasAnyRecoveryRootEntry && recoveryRootEntries.some((name) => !names.includes(name))) {
    throw new Error('B2 timeout recovery root contains a partial evidence set');
  }
  for (const entry of rootEntries) {
    const info = await lstat(path.join(root, entry.name));
    if (info.isSymbolicLink()) throw new Error('B2 successor root contains a symbolic link');
    if (entry.name === '.remote-ocr-orchestrator.lock' && !info.isFile()) throw new Error('B2 orchestrator lock is not regular');
  }
  const [documentsRoot, statusRoot, logsRoot] = await Promise.all([
    requireRealDirectory(path.join(root, 'documents'), 'B2 documents root'),
    requireRealDirectory(path.join(root, 'status'), 'B2 status root'),
    requireRealDirectory(path.join(root, 'logs'), 'B2 logs root'),
  ]);
  const [identityRecord, runStatusRecord, receiptRecord, markerRecord, journalRecord] = await Promise.all([
    readStableJson(root, path.join(root, 'run-identity.json'), 'B2 run identity'),
    readHashBoundJson(root, path.join(root, 'run-status.json'), 'B2 run status'),
    readHashBoundJson(root, path.join(root, 'seed-receipt.json'), 'B2 seed receipt'),
    readHashBoundJson(root, path.join(root, 'seed-commit.json'), 'B2 seed commit marker'),
    readHashBoundJson(root, path.join(root, '.seed-journal.json'), 'B2 seed journal'),
  ]);
  const identity = requireObject(identityRecord.value, 'B2 run identity');
  const runStatus = requireObject(runStatusRecord.value, 'B2 run status');
  const receipt = requireObject(receiptRecord.value, 'B2 seed receipt');
  const marker = requireObject(markerRecord.value, 'B2 seed marker');
  const journal = requireObject(journalRecord.value, 'B2 seed journal');
  for (const [label, value] of [['identity', identity], ['run status', runStatus], ['receipt', receipt], ['marker', marker], ['journal', journal]]) {
    if (value.schema_version !== 1 || value.citation_allowed !== false) throw new Error(`B2 ${label} is not fail-closed`);
  }
  if (receipt.receipt_type !== seedReceiptType || receipt.status !== 'prepared_commit_marker_required') {
    throw new Error('B2 seed receipt type or status is invalid');
  }
  if (marker.marker_type !== 'curriculum_remote_ocr_hash_bound_seed_commit'
    || journal.journal_type !== 'curriculum_remote_ocr_hash_bound_seed_install') {
    throw new Error('B2 seed transaction control type is invalid');
  }
  const seedId = requireSha256(receipt.seed_id, 'B2 seed id');
  const receiptDocuments = Array.isArray(receipt.documents) ? receipt.documents : null;
  if (!receiptDocuments || receiptDocuments.length === 0) throw new Error('B2 seed receipt has no documents');
  const successorContract = requireObject(receipt.successor, 'B2 seed successor contract');
  const successorContractWithoutInitial = structuredClone(successorContract);
  delete successorContractWithoutInitial.initial_run_status_sha256;
  const seedBasis = {
    schema_version: 1,
    mode: seedMode,
    manifest_sha256: receipt.manifest_sha256,
    predecessor: receipt.predecessor,
    successor_contract: successorContractWithoutInitial,
    allowed_configuration_delta: receipt.allowed_configuration_delta,
    documents: receiptDocuments.map((document) => {
      const value = structuredClone(document);
      delete value.successor_document_tree;
      delete value.successor_state_sha256;
      delete value.successor_status_sha256;
      delete value.timeout_recovery;
      return value;
    }),
    ...(receipt.timeout_recovery_grant ? {
      timeout_recovery_grant: receipt.timeout_recovery_grant,
    } : {}),
    ...(receipt.timeout_recovery_issuance ? {
      timeout_recovery_issuance: receipt.timeout_recovery_issuance,
    } : {}),
    citation_allowed: false,
  };
  if (receipt.seed_basis_sha256 !== sha256(canonicalJson(seedBasis))
    || seedId !== receipt.seed_basis_sha256) {
    throw new Error('B2 seed id or seed basis hash is invalid');
  }
  validateReceiptPredecessor(receipt, predecessor);
  if (identity.schema_version !== 1
    || identity.whole_document_atomic !== true
    || identity.manifest_sha256 !== receipt.manifest_sha256
    || identity.runtime_fingerprint_sha256 !== sha256(`${JSON.stringify(identity.runtime_fingerprint)}\n`)) {
    throw new Error('B2 run identity contract is invalid');
  }
  const lineage = requireObject(identity.seed_lineage, 'B2 run identity seed lineage');
  if (lineage.schema_version !== 1
    || lineage.mode !== seedMode
    || lineage.seed_id !== seedId
    || lineage.seed_receipt_sha256 !== receiptRecord.sha256
    || lineage.predecessor_run_identity_sha256 !== predecessor.anchors.identity_sha256
    || lineage.predecessor_run_status_sha256 !== predecessor.anchors.run_status_sha256
    || lineage.predecessor_snapshot_sha256 !== predecessor.snapshot_sha256
    || lineage.inherited_pages !== receipt.counts?.inherited_pages
    || lineage.citation_allowed !== false) {
    throw new Error('B2 run identity is not bound to the exact seed receipt and B1');
  }
  if (!sameJson(successorContract.runtime, identity.runtime)
    || !sameJson(successorContract.runtime_fingerprint, identity.runtime_fingerprint)
    || successorContract.runtime_fingerprint_sha256 !== identity.runtime_fingerprint_sha256
    || !sameJson(successorContract.worker_configuration, identity.worker_configuration)
    || successorContract.worker_configuration_sha256 !== sha256(canonicalJson(identity.worker_configuration))
    || !sameJson(successorContract.document_recovery, identity.document_recovery)
    || successorContract.document_recovery_sha256 !== sha256(canonicalJson(identity.document_recovery))
    || successorContract.runner_script_sha256 !== identity.runner_script_sha256
    || successorContract.ocr_script_sha256 !== identity.ocr_script_sha256
    || successorContract.citation_allowed !== false) {
    throw new Error('B2 run identity differs from the receipt successor contract');
  }
  const paddlexLayoutModelCache = await inspectBoundPaddlexCache(root, identity, 'B2');
  if (!sameJson(paddlexLayoutModelCache, predecessor.paddlex_layout_model_cache)) {
    throw new Error('B2 PaddleX cache fingerprint differs from B1');
  }
  const configurationTransition = validateAllowedSeedDelta(receipt, predecessor, identity);
  const timeoutRecoveryEvidence = await validateTimeoutRecoverySuccessorEvidence({
    root,
    receipt,
    lineage,
    predecessor,
    configurationTransition,
  });
  if (Boolean(timeoutRecoveryEvidence) !== hasAnyRecoveryRootEntry) {
    throw new Error('B2 timeout recovery declaration differs from root evidence');
  }
  const specifications = installedItemSpecifications(Boolean(timeoutRecoveryEvidence));
  const markerItems = markerItemsByName(marker, specifications);
  if (marker.seed_id !== seedId
    || marker.seed_receipt_sha256 !== receiptRecord.sha256
    || marker.run_identity_sha256 !== identityRecord.sha256
    || marker.initial_run_status_sha256 !== successorContract.initial_run_status_sha256) {
    throw new Error('B2 seed marker is not bound to receipt, identity, and initial run status');
  }
  if (journal.seed_id !== seedId
    || journal.seed_receipt_sha256 !== receiptRecord.sha256
    || journal.run_identity_sha256 !== identityRecord.sha256
    || journal.initial_run_status_sha256 !== successorContract.initial_run_status_sha256
    || !sameJson(journal.items, marker.installed_items)) {
    throw new Error('B2 seed journal differs from the commit marker');
  }
  const initialRunStatusItem = markerItems.get('run-status.json');
  const expectedInitialSidecar = Buffer.from(`${successorContract.initial_run_status_sha256}  run-status.json\n`);
  if (initialRunStatusItem?.fingerprint?.sha256 !== successorContract.initial_run_status_sha256
    || !sameJson(markerItems.get('run-status.json.sha256')?.fingerprint, {
      sha256: sha256(expectedInitialSidecar),
      bytes: expectedInitialSidecar.byteLength,
    })) {
    throw new Error('B2 marker does not bind the initial run status');
  }
  for (const specification of specifications.filter(({ name }) => immutableInstalledItems.has(name))) {
    const actual = await inspectInstalledItem(root, specification);
    if (!sameJson(actual, markerItems.get(specification.name)?.fingerprint)) {
      throw new Error(`B2 immutable seed item ${specification.name} drifted`);
    }
  }
  await validatePredecessorEvidence(root, receipt, predecessor);

  if (runStatus.schema_version !== 1
    || runStatus.manifest_sha256 !== identity.manifest_sha256
    || runStatus.runtime_fingerprint_sha256 !== identity.runtime_fingerprint_sha256
    || !sameJson(runStatus.document_recovery, identity.document_recovery)) {
    throw new Error('B2 run status differs from its run identity');
  }
  const runLineage = requireObject(runStatus.seed_lineage, 'B2 run status seed lineage');
  if (runLineage.schema_version !== 1
    || runLineage.mode !== seedMode
    || runLineage.seed_id !== seedId
    || runLineage.predecessor_run_identity_sha256 !== predecessor.anchors.identity_sha256
    || runLineage.predecessor_run_status_sha256 !== predecessor.anchors.run_status_sha256
    || runLineage.citation_allowed !== false) {
    throw new Error('B2 run status seed lineage differs from identity');
  }
  if (timeoutRecoveryEvidence) {
    if (runLineage.timeout_recovery_grant_id !== lineage.timeout_recovery_grant_id
      || runLineage.timeout_recovery_grant_sha256 !== lineage.timeout_recovery_grant_sha256
      || !sameJson(runLineage.timeout_recovery_documents, lineage.timeout_recovery_documents)
      || runLineage.timeout_recovery_ledger_id !== lineage.timeout_recovery_ledger_id
      || runLineage.timeout_recovery_claim_sha256 !== lineage.timeout_recovery_claim_sha256
      || runLineage.timeout_recovery_issuance_claim_key
        !== lineage.timeout_recovery_issuance_claim_key
      || runLineage.timeout_recovery_issuance_sha256
        !== lineage.timeout_recovery_issuance_sha256) {
      throw new Error('B2 run status timeout recovery lineage differs from identity');
    }
  } else {
    const strayRecoveryLineage = [identity, runStatus, lineage, runLineage]
      .some(containsTimeoutRecoveryKey);
    if (strayRecoveryLineage) throw new Error('B2 no-grant seed contains timeout recovery lineage');
  }
  const runDocumentsObject = requireObject(runStatus.documents, 'B2 run status documents');
  const receiptIds = receiptDocuments.map((document) => requireDocumentId(document.document_id, 'B2 receipt document id'));
  if (new Set(receiptIds).size !== receiptIds.length
    || !sameJson(Object.keys(runDocumentsObject).sort(), [...receiptIds].sort())) {
    throw new Error('B2 document set differs from the receipt');
  }
  const currentDocuments = receiptDocuments.map((document) => {
    const documentRecovery = document.timeout_recovery || null;
    const attemptCeiling = documentRecovery ? maxDocumentAttempts + 1 : maxDocumentAttempts;
    const progress = validateProgress(
      runDocumentsObject[document.document_id],
      document.page_count,
      `B2 ${document.document_id}`,
      false,
      attemptCeiling,
    );
    if (progress.seed_id !== seedId
      || progress.predecessor_status !== document.predecessor_status
      || progress.inherited_attempts !== document.inherited_attempts
      || progress.attempts < document.inherited_attempts) {
      throw new Error('B2 progress violates its inherited attempt floor or predecessor status');
    }
    if (documentRecovery) {
      if (document.predecessor_status !== 'quarantined'
        || document.inherited_attempts !== maxDocumentAttempts
        || progress.attempt_ceiling !== attemptCeiling
        || progress.timeout_recovery_grant_id !== documentRecovery.grant_id
        || progress.timeout_recovery_grant_sha256 !== documentRecovery.grant_raw_sha256
        || progress.timeout_recovery_first_missing_page !== documentRecovery.first_missing_page) {
        throw new Error(`${document.document_id}: B2 progress is not bound to its attempt-6 grant`);
      }
    } else if (document.predecessor_status === 'quarantined'
      || containsTimeoutRecoveryKey(document)
      || containsTimeoutRecoveryKey(progress)
      || progress.attempt_ceiling !== undefined) {
      throw new Error(`${document.document_id}: B2 progress has stray timeout recovery fields`);
    }
    return [document, progress];
  });
  const { counts, declaredCountsMatch } = deriveRunCounts(
    runStatus,
    currentDocuments.map(([, progress]) => progress),
    'B2 run status',
  );
  const expectedDocumentRoots = currentDocuments.filter(([, progress]) => progress.status !== 'pending').map(([document]) => document.document_id);
  const expectedStatusFiles = expectedDocumentRoots.flatMap((id) => [`${id}.json`, `${id}.json.sha256`]);
  await exactDirectoryEntries(documentsRoot, expectedDocumentRoots, 'B2 documents root');
  await exactDirectoryEntries(statusRoot, expectedStatusFiles, 'B2 status root');
  const logEntries = await readdir(logsRoot, { withFileTypes: true });
  for (const entry of logEntries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.log')) throw new Error('B2 logs contain an unexpected entry');
    const documentId = requireDocumentId(entry.name.slice(0, -4), 'B2 log document id');
    if (!runDocumentsObject[documentId]) throw new Error('B2 logs contain an unknown document');
  }

  let expectedPages = 0;
  let completedPages = 0;
  let failedPages = 0;
  let latestProgressMilliseconds = runStatusRecord.metadata.mtimeMs;
  const expectedConfiguration = expectedStateConfiguration(identity);
  for (const [receiptDocument, progress] of currentDocuments) {
    expectedPages += receiptDocument.page_count;
    if (progress.status === 'pending') continue;
    const documentId = receiptDocument.document_id;
    const documentRoot = await requireRealDirectory(path.join(documentsRoot, documentId), 'B2 document root');
    await exactDirectoryEntries(documentRoot, ['pages', 'state.json'], 'B2 document root');
    const pagesRoot = await requireRealDirectory(path.join(documentRoot, 'pages'), 'B2 pages root');
    const [stateRecord, statusRecord] = await Promise.all([
      readStableJson(root, path.join(documentRoot, 'state.json'), 'B2 state'),
      readHashBoundJson(root, path.join(statusRoot, `${documentId}.json`), 'B2 document status'),
    ]);
    latestProgressMilliseconds = Math.max(latestProgressMilliseconds, stateRecord.metadata.mtimeMs, statusRecord.metadata.mtimeMs);
    const state = stateRecord.value;
    const stateSummary = validateBaseState(state, documentId, receiptDocument.page_count, 'B2 state');
    if (!sameJson(state.configuration, expectedConfiguration)
      || state.configuration_scope !== 'active_writer_with_hash_bound_seed_exceptions') {
      throw new Error('B2 state configuration differs from the successor identity');
    }
    const stateLineage = requireObject(state.seed_lineage, 'B2 state seed lineage');
    if (stateLineage.schema_version !== 1
      || stateLineage.mode !== seedMode
      || stateLineage.seed_id !== seedId
      || stateLineage.predecessor_run_identity_sha256 !== predecessor.anchors.identity_sha256
      || stateLineage.predecessor_configuration_sha256 !== receiptDocument.predecessor_configuration_sha256
      || !sameJson(stateLineage.inherited_completed_pages, receiptDocument.completed_pages)
      || stateLineage.citation_allowed !== false) {
      throw new Error('B2 state seed lineage differs from the receipt');
    }
    if (receiptDocument.timeout_recovery) {
      if (stateLineage.timeout_recovery_grant_id !== receiptDocument.timeout_recovery.grant_id
        || stateLineage.timeout_recovery_grant_sha256
          !== receiptDocument.timeout_recovery.grant_raw_sha256
        || stateLineage.timeout_recovery_first_missing_page
          !== receiptDocument.timeout_recovery.first_missing_page) {
        throw new Error('B2 state timeout recovery lineage is invalid');
      }
    } else if (containsTimeoutRecoveryKey(state)
      || containsTimeoutRecoveryKey(stateLineage)) {
      throw new Error('B2 state contains stray timeout recovery lineage');
    }
    const inherited = new Set(receiptDocument.completed_pages);
    const physicalPages = (await readdir(pagesRoot, { withFileTypes: true })).map((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^\d{4}$/u.test(entry.name)) {
        throw new Error('B2 pages root contains an unexpected entry');
      }
      return Number(entry.name);
    }).sort((left, right) => left - right);
    if (!sameJson(physicalPages, stateSummary.completedPages)) throw new Error('B2 physical pages differ from state');
    for (const page of stateSummary.completedPages) {
      const statePage = stateSummary.pages[String(page)];
      const provenance = statePage.seed_provenance;
      if (inherited.has(page)) {
        if (!provenance
          || provenance.seed_id !== seedId
          || provenance.predecessor_run_identity_sha256 !== predecessor.anchors.identity_sha256
          || provenance.predecessor_configuration_sha256 !== receiptDocument.predecessor_configuration_sha256) {
          throw new Error('B2 inherited page seed provenance mismatch');
        }
      } else if (provenance !== undefined) {
        throw new Error('B2 newly written page incorrectly carries seed provenance');
      }
      const artifact = await inspectPageTree(root, documentId, page, statePage);
      if (inherited.has(page)) {
        const expectedArtifact = receiptDocument.inherited_page_artifacts.find(
          (value) => value.physical_pdf_page === page,
        );
        const { tree: _tree, ...publicArtifact } = artifact;
        if (!sameJson(publicArtifact, expectedArtifact)) throw new Error('B2 inherited page artifact identity drifted');
      }
    }
    const pageArtifacts = stateSummary.completedPages.map((page) => ({
      page_number: page,
      rendered_image_sha256: stateSummary.pages[String(page)].rendered_image_sha256,
      result_json_sha256: stateSummary.pages[String(page)].result_json_sha256,
      content_markdown_sha256: stateSummary.pages[String(page)].content_markdown_sha256,
      citation_eligible: false,
    }));
    const status = requireObject(statusRecord.value, 'B2 document status');
    const initialCompleteStatus = validateInitialCompleteStatus({
      receiptDocument,
      progress,
      status,
      statusSha256: statusRecord.sha256,
      state,
      stateSha256: stateRecord.sha256,
      pageArtifacts,
      seedId,
      identity,
    });
    const legacyInterruptedInitial = receiptDocument.predecessor_status_format === 'legacy_b1_interrupted'
      && progress.status === 'interrupted'
      && progress.attempts === receiptDocument.inherited_attempts
      && status.attempt === progress.attempts
      && status.max_attempts === maxDocumentAttempts
      && status.page_count === undefined;
    const documentAttemptCeiling = receiptDocument.timeout_recovery
      ? maxDocumentAttempts + 1
      : maxDocumentAttempts;
    const fullCompleteStatus = validateFullCompleteStatus({
      receiptDocument,
      progress,
      status,
      state,
      stateSha256: stateRecord.sha256,
      pageArtifacts,
      seedId,
      identity,
      attemptCeiling: documentAttemptCeiling,
    });
    const fullSuccessorStatus = fullCompleteStatus
      || (progress.status !== 'complete'
        && status.attempt === progress.attempts
        && status.max_attempts === documentAttemptCeiling
        && status.page_count === receiptDocument.page_count);
    const normalizedRecoveryStatus = validateNormalizedRecoveryStatus(
      receiptDocument,
      progress,
      status,
      statusRecord.sha256,
      identity,
    );
    const rawStatusMatchesProgress = status.status === progress.status;
    if (status.schema_version !== 1
      || status.document_id !== documentId
      || status.citation_allowed !== false
      || !((rawStatusMatchesProgress
        && (fullSuccessorStatus
          || initialCompleteStatus
          || legacyInterruptedInitial))
        || normalizedRecoveryStatus)
      || status.runtime_fingerprint_sha256 !== identity.runtime_fingerprint_sha256) {
      throw new Error('B2 document status differs from run status or identity');
    }
    if (progress.status !== 'running' && progress.status_json_sha256 !== statusRecord.sha256) {
      throw new Error('B2 terminal document status hash differs from run status');
    }
    const statusLineage = receiptDocument.timeout_recovery
      ? requireObject(status.seed_lineage, 'B2 timeout recovery document status seed lineage')
      : status.seed_lineage;
    if (statusLineage !== undefined) {
      if (statusLineage.seed_id !== seedId
        || statusLineage.predecessor_status_sha256 !== receiptDocument.predecessor_status_sha256
        || statusLineage.inherited_attempts !== receiptDocument.inherited_attempts
        || statusLineage.citation_allowed !== false) {
        throw new Error('B2 document status seed lineage is invalid');
      }
      if (receiptDocument.timeout_recovery) {
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
        if (!sameJson(Object.keys(statusLineage).sort(), expectedLineageKeys)
          || statusLineage.schema_version !== 1
          || statusLineage.timeout_recovery_grant_id
            !== receiptDocument.timeout_recovery.grant_id
          || statusLineage.timeout_recovery_grant_sha256
            !== receiptDocument.timeout_recovery.grant_raw_sha256
          || statusLineage.timeout_recovery_first_missing_page
            !== receiptDocument.timeout_recovery.first_missing_page
          || statusLineage.granted_attempt !== maxDocumentAttempts + 1) {
          throw new Error('B2 document status timeout recovery lineage is invalid');
        }
        if (progress.status === 'complete'
          && (progress.attempts !== maxDocumentAttempts + 1
            || status.attempt !== maxDocumentAttempts + 1
            || status.max_attempts !== maxDocumentAttempts + 1)) {
          throw new Error(`${documentId}: B2 timeout recovery completion did not consume granted attempt 6`);
        }
      } else if (containsTimeoutRecoveryKey(status)
        || containsTimeoutRecoveryKey(statusLineage)
        || statusLineage.granted_attempt !== undefined) {
        throw new Error('B2 document status contains stray timeout recovery lineage');
      }
    }
    if (receiptDocument.timeout_recovery
      && stateSummary.completedPages.length === receiptDocument.page_count
      && stateSummary.failedPageNumbers.length === 0
      && (progress.status !== 'complete' || status.status !== 'complete')) {
      throw new Error(`${documentId}: B2 timeout recovery completed artifacts were downgraded`);
    }
    if (progress.status === 'complete') {
      if (stateSummary.completedPages.length !== receiptDocument.page_count
        || stateSummary.failedPageNumbers.length !== 0
        || state.selected_pages_complete !== true
        || status.whole_document_atomic !== true
        || status.artifacts?.state_sha256 !== stateRecord.sha256
        || status.artifacts?.page_artifacts_sha256 !== sha256(`${JSON.stringify(pageArtifacts)}\n`)) {
        throw new Error('B2 complete document is not whole-document atomic');
      }
    }
    completedPages += stateSummary.completedPages.length;
    failedPages += stateSummary.failedPageNumbers.length;
  }
  for (const entry of logEntries) {
    const info = await stat(path.join(logsRoot, entry.name));
    latestProgressMilliseconds = Math.max(latestProgressMilliseconds, info.mtimeMs);
  }
  const receiptCounts = requireObject(receipt.counts, 'B2 receipt counts');
  const recoveryDocumentCount = receiptDocuments.filter(
    (document) => document.timeout_recovery !== undefined,
  ).length;
  if (receiptCounts.documents !== receiptDocuments.length
    || receiptCounts.inherited_documents !== receiptDocuments.filter((document) => document.completed_pages.length > 0).length
    || receiptCounts.inherited_pages !== receiptDocuments.reduce((sum, document) => sum + document.completed_pages.length, 0)
    || receiptCounts.failed_pages !== 0
    || receiptCounts.quarantined_documents !== 0
    || (timeoutRecoveryEvidence
      && (receiptCounts.predecessor_complete_documents !== predecessor.counts.complete
        || receiptCounts.predecessor_quarantined_documents !== predecessor.counts.quarantined
        || receiptCounts.recovery_granted_documents !== recoveryDocumentCount))
    || (!timeoutRecoveryEvidence
      && (receiptCounts.predecessor_complete_documents !== undefined
        || receiptCounts.predecessor_quarantined_documents !== undefined
        || receiptCounts.recovery_granted_documents !== undefined))) {
    throw new Error('B2 receipt counts differ from its documents');
  }
  const complete = counts.complete === counts.total
    && completedPages === expectedPages
    && failedPages === 0
    && runStatus.finished === true
    && runStatus.settled === true;
  return {
    read_ok: true,
    ...(configurationTransition ? { configuration_transition: configurationTransition } : {}),
    seed_id_sha256: sha256(seedId),
    receipt_sha256: receiptRecord.sha256,
    marker_sha256: markerRecord.sha256,
    identity_sha256: identityRecord.sha256,
    run_status_sha256: runStatusRecord.sha256,
    documents: receiptDocuments.length,
    expected_pages: expectedPages,
    completed_pages: completedPages,
    failed_pages: failedPages,
    status_counts: counts,
    declared_counts_match: declaredCountsMatch,
    complete,
    inconsistent_completion: runStatus.finished === true && !complete,
    latest_progress_at: iso(latestProgressMilliseconds),
    progress_age_seconds: Math.max(0, Math.floor((nowMilliseconds - latestProgressMilliseconds) / 1000)),
    paddlex_layout_model_cache: paddlexLayoutModelCache,
  };
}

export function parseInactiveSystemdShow(raw) {
  const fields = {};
  const expectedKeys = [
    'LoadState', 'ActiveState', 'SubState', 'NRestarts', 'ExecMainStatus', 'MainPID', 'Result',
  ];
  for (const line of String(raw).split('\n')) {
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('systemd show output is malformed');
    const key = line.slice(0, separator);
    if (Object.hasOwn(fields, key)) throw new Error(`systemd show output repeats ${key}`);
    fields[key] = line.slice(separator + 1);
  }
  if (!sameJson(Object.keys(fields).sort(), [...expectedKeys].sort())) {
    throw new Error('systemd show output field set is not exact');
  }
  for (const required of expectedKeys) {
    if (!(required in fields)) throw new Error(`systemd show output lacks ${required}`);
  }
  if (fields.LoadState === 'loaded') return parseSystemdShow(raw);
  for (const key of ['NRestarts', 'ExecMainStatus', 'MainPID']) {
    if (!/^(?:0|[1-9]\d*)$/u.test(fields[key])) {
      throw new Error(`systemd numeric status ${key} is not canonical decimal`);
    }
  }
  const nRestarts = Number(fields.NRestarts);
  const execMainStatus = Number(fields.ExecMainStatus);
  const mainPid = Number(fields.MainPID);
  if (![nRestarts, execMainStatus, mainPid].every(Number.isSafeInteger)
    || nRestarts !== 0
    || fields.LoadState !== 'masked'
    || fields.ActiveState !== 'inactive'
    || fields.SubState !== 'dead'
    || mainPid !== 0
    || execMainStatus !== 0
    || fields.Result !== 'success') {
    throw new Error('masked systemd unit is not the exact safe inactive terminal state');
  }
  return {
    active_state: fields.ActiveState,
    sub_state: fields.SubState,
    n_restarts: nRestarts,
    exec_main_status: execMainStatus,
    main_pid: mainPid,
    result: fields.Result,
  };
}

async function probeSystemd(unit, runExecFile = execFile, { allowMaskedInactive = false } = {}) {
  const { stdout } = await runExecFile('/usr/bin/systemctl', [
    '--user',
    'show',
    unit,
    '--no-pager',
    '--property=LoadState',
    '--property=ActiveState',
    '--property=SubState',
    '--property=NRestarts',
    '--property=ExecMainStatus',
    '--property=MainPID',
    '--property=Result',
  ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
  return allowMaskedInactive ? parseInactiveSystemdShow(stdout) : parseSystemdShow(stdout);
}

async function readBoundedResponse(response, byteLimit = 64 * 1024) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > byteLimit) {
      await reader.cancel();
      throw new Error('llama health response is oversized');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function probeLlamaHealth(url, runFetch = fetch) {
  try {
    const response = await runFetch(url, { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    const raw = await readBoundedResponse(response);
    let value = null;
    try { value = raw ? JSON.parse(raw) : null; } catch { value = null; }
    return {
      healthy: response.status === 200 && (value?.status === 'ok' || value?.status === 'ready' || value?.ok === true),
      http_status: response.status,
    };
  } catch {
    return { healthy: false, http_status: null };
  }
}

export async function collectSingleShardResources(runRoot, {
  runExecFile = execFile,
  read = readFile,
  filesystemStat = statfs,
} = {}) {
  const results = await Promise.allSettled([
    filesystemStat(runRoot, { bigint: true }),
    read('/proc/meminfo', 'utf8'),
    runExecFile('/usr/bin/nvidia-smi', [
      '--query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total',
      '--format=csv,noheader,nounits',
    ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 }),
  ]);
  const errors = [];
  let disk = null;
  let memory = null;
  let gpu = null;
  if (results[0].status === 'fulfilled') {
    const value = results[0].value;
    const availableBytes = Number(value.bavail * value.bsize);
    if (Number.isSafeInteger(availableBytes) && availableBytes >= 0) {
      disk = { available_gib: Number((availableBytes / gib).toFixed(3)) };
    } else errors.push('DISK_PROBE_FAILED');
  } else errors.push('DISK_PROBE_FAILED');
  if (results[1].status === 'fulfilled') {
    try {
      const availableBytes = parseMeminfo(results[1].value);
      memory = { available_gib: Number((availableBytes / gib).toFixed(3)) };
    } catch { errors.push('MEMORY_PROBE_FAILED'); }
  } else errors.push('MEMORY_PROBE_FAILED');
  if (results[2].status === 'fulfilled') {
    try { gpu = parseNvidiaSmi(results[2].value.stdout); } catch { errors.push('GPU_PROBE_FAILED'); }
  } else errors.push('GPU_PROBE_FAILED');
  return { resources: { disk, memory, gpu }, errors };
}

function failedPredecessor() {
  return { read_ok: false, anchors_match: false, anchors: null };
}

function failedSuccessor() {
  return { read_ok: false, complete: false };
}

async function retryConsistentInspection(action, attempts = 5) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await action(); } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(150);
    }
  }
  throw lastError;
}

export async function collectSingleShardMonitorSnapshot(config, dependencies = {}) {
  const nowMilliseconds = dependencies.nowMilliseconds ?? Date.now();
  const collectionErrors = [];
  const capture = async (code, action, fallback) => {
    try { return await action(); } catch { collectionErrors.push(code); return fallback; }
  };
  const canonicalRunRoot = await requireRealDirectory(config.runRoot, 'monitor run root');
  const predecessorRoot = path.resolve(canonicalRunRoot, config.predecessorOutput);
  const successorRoot = path.resolve(canonicalRunRoot, config.successorOutput);
  const runExecFile = dependencies.execFile || execFile;
  const runFetch = dependencies.fetch || fetch;
  const predecessor = await capture(
    'B1_READ_FAILED',
    () => inspectPredecessorB1(predecessorRoot),
    null,
  );
  const inactiveWorkerEntries = [...(config.inactiveWorkerUnits || new Map())];
  const [successor, worker, oldWorkerA, oldWorkerB, inactiveWorkers, llamaSystemd, llamaHealth, resourceResult] = await Promise.all([
    predecessor
      ? capture(
          'B2_READ_FAILED',
          () => retryConsistentInspection(() => inspectSuccessorB2(successorRoot, predecessor, nowMilliseconds)),
          failedSuccessor(),
        )
      : Promise.resolve(failedSuccessor()),
    capture('B2_WORKER_PROBE_FAILED', () => probeSystemd(config.workerUnit, runExecFile), null),
    capture('OLD_WORKER_A_PROBE_FAILED', () => probeSystemd(
      config.oldWorkerUnits.get('a'),
      runExecFile,
      { allowMaskedInactive: true },
    ), null),
    capture('OLD_WORKER_B_PROBE_FAILED', () => probeSystemd(
      config.oldWorkerUnits.get('b'),
      runExecFile,
      { allowMaskedInactive: true },
    ), null),
    Promise.all(inactiveWorkerEntries.map(async ([label, unit]) => {
      const codeLabel = label.toUpperCase().replaceAll('-', '_');
      const value = await capture(
        `INACTIVE_WORKER_${codeLabel}_PROBE_FAILED`,
        () => probeSystemd(unit, runExecFile, { allowMaskedInactive: true }),
        null,
      );
      return [label, value];
    })).then(Object.fromEntries),
    capture('LLAMA_SYSTEMD_PROBE_FAILED', () => probeSystemd(config.llamaUnit, runExecFile), null),
    probeLlamaHealth(config.llamaHealthUrl, runFetch),
    collectSingleShardResources(canonicalRunRoot, {
      runExecFile,
      read: dependencies.readFile || readFile,
      filesystemStat: dependencies.statfs || statfs,
    }),
  ]);
  collectionErrors.push(...resourceResult.errors);
  const anchorsMatch = predecessor
    ? Object.entries(config.predecessorAnchors).every(([name, expected]) => predecessor.anchors[name] === expected)
    : false;
  return {
    schema_version: 1,
    monitor_type: isAuditedP4ToP1Transition(successor.configuration_transition)
      ? 'curriculum_remote_ocr_single_shard_p1'
      : 'curriculum_remote_ocr_single_shard_b2',
    run_id: path.basename(canonicalRunRoot),
    observed_at: iso(nowMilliseconds),
    thresholds: { ...config.thresholds },
    collection_errors: [...new Set(collectionErrors)].sort(),
    predecessor: predecessor ? {
      read_ok: true,
      anchors: predecessor.anchors,
      anchors_match: anchorsMatch,
      documents: predecessor.counts.total,
      completed_pages: predecessor.completed_pages,
      failed_pages: predecessor.failed_pages,
      quarantined_documents: predecessor.quarantined_documents,
    } : failedPredecessor(),
    successor,
    services: {
      worker,
      old_workers: { a: oldWorkerA, b: oldWorkerB },
      ...(inactiveWorkerEntries.length > 0 ? { inactive_workers: inactiveWorkers } : {}),
      llama: { systemd: llamaSystemd, health: llamaHealth },
    },
    resources: resourceResult.resources,
  };
}

function issue(code) {
  return { code, severity: 'critical' };
}

function serviceActive(service) {
  return Boolean(service
    && (service.active_state === 'active' || service.sub_state === 'running' || service.main_pid > 0));
}

function serviceStrictlyRunning(service) {
  return Boolean(service
    && service.active_state === 'active'
    && service.sub_state === 'running'
    && Number.isSafeInteger(service.main_pid)
    && service.main_pid > 0);
}

export function classifySingleShardSnapshot(snapshot) {
  const issues = (snapshot.collection_errors || []).map(issue);
  const predecessor = snapshot.predecessor || failedPredecessor();
  const successor = snapshot.successor || failedSuccessor();
  const thresholds = snapshot.thresholds || defaultThresholds;
  const worker = snapshot.services?.worker;
  const workerStrictlyRunning = serviceStrictlyRunning(worker);
  if (predecessor.read_ok && predecessor.anchors_match !== true) issues.push(issue('B1_HASH_DRIFT'));
  if (successor.read_ok) {
    if (successor.inconsistent_completion) issues.push(issue('B2_COMPLETION_INCONSISTENT'));
    if (successor.declared_counts_match !== true
      && (!workerStrictlyRunning || successor.complete)) issues.push(issue('B2_RUN_COUNTS_DRIFT'));
    if ((successor.status_counts?.failed || 0) > 0) issues.push(issue('B2_FAILED'));
    if ((successor.status_counts?.quarantined || 0) > 0) issues.push(issue('B2_QUARANTINED'));
    if (!successor.complete
      && (successor.status_counts?.interrupted || 0) > 0
      && !workerStrictlyRunning) issues.push(issue('B2_INTERRUPTED'));
    if ((successor.failed_pages || 0) > 0) issues.push(issue('B2_PAGE_FAILURE'));
    if (!successor.complete
      && workerStrictlyRunning
      && successor.progress_age_seconds > thresholds.stall_seconds) issues.push(issue('B2_NO_PROGRESS'));
  }
  for (const label of ['a', 'b']) {
    if (serviceActive(snapshot.services?.old_workers?.[label])) issues.push(issue(`OLD_WORKER_${label.toUpperCase()}_ACTIVE`));
  }
  for (const [label, inactiveWorker] of Object.entries(snapshot.services?.inactive_workers || {})) {
    if (serviceActive(inactiveWorker)) {
      issues.push(issue(`INACTIVE_WORKER_${label.toUpperCase().replaceAll('-', '_')}_ACTIVE`));
    }
  }
  if (worker?.n_restarts > 0) issues.push(issue('B2_WORKER_RESTARTED'));
  if (successor.read_ok
    && successor.complete
    && isAuditedP4ToP1Transition(successor.configuration_transition)) {
    if (serviceActive(worker)) issues.push(issue('B2_WORKER_ACTIVE_AFTER_P1_COMPLETION'));
    if (worker?.exec_main_status !== 0 || worker?.result !== 'success') {
      issues.push(issue('B2_WORKER_UNCLEAN_AFTER_P1_COMPLETION'));
    }
    if (serviceActive(snapshot.services?.llama?.systemd)
      || snapshot.services?.llama?.health?.healthy) {
      issues.push(issue('LLAMA_ACTIVE_AFTER_P1_COMPLETION'));
    }
  }
  if (successor.read_ok && !successor.complete) {
    if (!workerStrictlyRunning) issues.push(issue('B2_WORKER_NOT_ACTIVE'));
    if (worker?.exec_main_status !== 0) issues.push(issue('B2_WORKER_EXIT_STATUS'));
    const llama = snapshot.services?.llama;
    if (!llama?.systemd
      || llama.systemd.active_state !== 'active'
      || llama.systemd.sub_state !== 'running'
      || llama.systemd.main_pid < 1
      || llama.systemd.exec_main_status !== 0) {
      issues.push(issue('LLAMA_NOT_ACTIVE'));
    }
    if (!llama?.health?.healthy) issues.push(issue('LLAMA_HEALTH_FAILED'));
    if (llama?.systemd?.n_restarts > 0) issues.push(issue('LLAMA_RESTARTED'));
  }
  if (snapshot.resources?.disk?.available_gib < thresholds.disk_min_gib) issues.push(issue('DISK_BELOW_MINIMUM'));
  if (snapshot.resources?.memory?.available_gib < thresholds.memory_min_gib) issues.push(issue('MEMORY_BELOW_MINIMUM'));
  if (snapshot.resources?.gpu?.max_temperature_c > thresholds.gpu_max_c) issues.push(issue('GPU_OVER_TEMPERATURE'));
  const deduplicated = [...new Map(issues.map((value) => [value.code, value])).values()]
    .sort((left, right) => compareText(left.code, right.code));
  if (deduplicated.length > 0) return { state: 'blocked', exit_code: 12, issues: deduplicated };
  if (successor.read_ok && successor.complete) return { state: 'completed', exit_code: 0, issues: [] };
  return { state: 'healthy_running', exit_code: 10, issues: [] };
}

function safeService(service) {
  return service && {
    active_state: service.active_state,
    sub_state: service.sub_state,
    n_restarts: service.n_restarts,
    exec_main_status: service.exec_main_status,
  };
}

export function privacySafeSingleShardEvent(snapshot, health) {
  return {
    schema_version: 1,
    timestamp: snapshot.observed_at,
    run_id: snapshot.run_id,
    state: health.state,
    exit_code: health.exit_code,
    issue_codes: health.issues.map((value) => value.code),
    predecessor: {
      read_ok: snapshot.predecessor?.read_ok ?? false,
      anchors_match: snapshot.predecessor?.anchors_match ?? false,
      documents: snapshot.predecessor?.documents ?? null,
      completed_pages: snapshot.predecessor?.completed_pages ?? null,
    },
    successor: {
      read_ok: snapshot.successor?.read_ok ?? false,
      ...(snapshot.successor?.configuration_transition
        ? { configuration_transition: snapshot.successor.configuration_transition }
        : {}),
      complete: snapshot.successor?.complete ?? false,
      documents: snapshot.successor?.documents ?? null,
      expected_pages: snapshot.successor?.expected_pages ?? null,
      completed_pages: snapshot.successor?.completed_pages ?? null,
      failed_pages: snapshot.successor?.failed_pages ?? null,
      status_counts: snapshot.successor?.status_counts ?? null,
      declared_counts_match: snapshot.successor?.declared_counts_match ?? null,
      progress_age_seconds: snapshot.successor?.progress_age_seconds ?? null,
    },
    services: {
      worker: safeService(snapshot.services?.worker),
      old_workers: {
        a: safeService(snapshot.services?.old_workers?.a),
        b: safeService(snapshot.services?.old_workers?.b),
      },
      ...(snapshot.services?.inactive_workers ? {
        inactive_workers: Object.fromEntries(
          Object.entries(snapshot.services.inactive_workers).map(
            ([label, value]) => [label, safeService(value)],
          ),
        ),
      } : {}),
      llama: {
        ...safeService(snapshot.services?.llama?.systemd),
        healthy: snapshot.services?.llama?.health?.healthy ?? false,
        http_status: snapshot.services?.llama?.health?.http_status ?? null,
      },
    },
    resources: snapshot.resources && {
      disk_available_gib: snapshot.resources.disk?.available_gib ?? null,
      memory_available_gib: snapshot.resources.memory?.available_gib ?? null,
      gpu_max_temperature_c: snapshot.resources.gpu?.max_temperature_c ?? null,
      gpu_max_utilization_percent: snapshot.resources.gpu?.max_utilization_percent ?? null,
    },
  };
}

async function atomicWrite(pathname, contents) {
  const temporary = `${pathname}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, pathname);
  await chmod(pathname, 0o600);
}

export async function writeSingleShardMonitorOutputs(outputDir, snapshot, health) {
  const parent = await requireRealDirectory(path.dirname(outputDir), 'monitor output parent');
  const canonicalOutput = path.join(parent, path.basename(outputDir));
  try {
    const info = await lstat(canonicalOutput);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('monitor output must be a real directory');
    const entries = await readdir(canonicalOutput, { withFileTypes: true });
    for (const entry of entries) {
      if (!['latest.json', 'events.jsonl'].includes(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('monitor output contains an unexpected entry');
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(canonicalOutput, { mode: 0o700 });
  }
  await chmod(canonicalOutput, 0o700);
  const safe = privacySafeSingleShardEvent(snapshot, health);
  await atomicWrite(path.join(canonicalOutput, 'latest.json'), `${JSON.stringify(safe, null, 2)}\n`);
  const eventPath = path.join(canonicalOutput, 'events.jsonl');
  const handle = await open(eventPath, 'a', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(safe)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(eventPath, 0o600);
  return safe;
}

function usage() {
  return [
    'Usage: node scripts/monitor-remote-ocr-single-shard.mjs \\',
    '  --run-root DIR --predecessor-output RELATIVE_B1 --successor-output RELATIVE_B2 \\',
    '  --output-dir DIR --worker-unit B2.service \\',
    '  --old-worker-unit a=OLD_A.service --old-worker-unit b=OLD_B.service \\',
    '  --b1-identity-sha256 HASH --b1-run-status-sha256 HASH \\',
    '  --b1-state-hashset-sha256 HASH --b1-status-hashset-sha256 HASH \\',
    '  --b1-artifact-hashset-sha256 HASH [options]',
    '',
    'Options:',
    '  --llama-unit UNIT.service       Default: curriculum-ocr-llama.service',
    '  --llama-health-url URL          Default: http://127.0.0.1:8112/health',
    '  --inactive-worker-unit LABEL=UNIT.service  Additional unit that must remain inactive',
    '  --stall-seconds N               Default: 1500',
    '  --disk-min-gib N                Default: 50',
    '  --memory-min-gib N              Default: 2',
    '  --gpu-max-c N                   Default: 85',
    '',
    'Exit 0 means complete, 10 means healthy and running, and 12 means blocked.',
    'The monitor never changes OCR inputs, outputs, services, or retries. It writes',
    'only privacy-safe latest.json and events.jsonl under --output-dir.',
  ].join('\n');
}

async function main() {
  const config = parseSingleShardMonitorArgs(process.argv.slice(2));
  if (config.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const snapshot = await collectSingleShardMonitorSnapshot(config);
  const health = classifySingleShardSnapshot(snapshot);
  await writeSingleShardMonitorOutputs(config.outputDir, snapshot, health);
  process.stdout.write(`${JSON.stringify({
    timestamp: snapshot.observed_at,
    run_id: snapshot.run_id,
    state: health.state,
    exit_code: health.exit_code,
    issue_codes: health.issues.map((value) => value.code),
    completed_pages: snapshot.successor.completed_pages ?? null,
  })}\n`);
  process.exitCode = health.exit_code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`single-shard OCR monitor failed closed: ${error.name || 'Error'}\n`);
    process.exitCode = 12;
  });
}
