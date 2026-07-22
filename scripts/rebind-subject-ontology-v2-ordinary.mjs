#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateCorpusManifest } from './import-corpus.mjs';
import { validatePageEvidenceForRelease } from './page-evidence-release-hook.mjs';
import {
  CANONICAL_FACETS,
  computeSubjectOntologyV2Report,
  validateSubjectOntologyV2,
} from './validate-subject-ontology-v2.mjs';
import { validateDraft202012 } from './lib/draft-2020-schema-validator.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const INDEX_PATH = 'data/ontologies/index.json';
const REPORT_PATH = 'data/subject-ontology-v2-validation.json';
const TRANSACTION_PATH = 'data/.subject-ontology-v2-ordinary-rebind-transaction.json';
const SCHEMA_PATH = 'data/schemas/subject-ontology-v2.schema.json';
const EXPECTED_DOCUMENTS = 195;
const EXPECTED_SQL_CHUNKS = 93;
const ACTIVE_ROOTS = new Set();
const ZERO_PUBLICATION_COUNTS = Object.freeze({
  documents: 0,
  pages: 0,
  display_pages: 0,
  citation_pages: 0,
  resolved_semantic_controls: 0,
});
const BINDING_PATHS = Object.freeze({
  taxonomy: 'data/concept-model-v2.json',
  catalog: 'data/catalog.json',
  provenance: 'data/document-sources.json',
  corpus_manifest: 'data/corpus-chunks/manifest.json',
  page_evidence_manifest: 'scripts/page-evidence/fail-closed-manifest.json',
  reviewer_registry: 'scripts/page-evidence/reviewer-authorities.json',
  online_source_registry: 'scripts/page-evidence/online-source-identities.json',
  online_verification_standard: 'data/online-verification-standard.json',
});
const SHADOW_PATHS = Object.freeze([
  ...Object.values(BINDING_PATHS),
  SCHEMA_PATH,
  'data/page-publication-manifest.json',
  'data/semantic-publication-policy.json',
]);

function fail(message) {
  throw new Error(`ordinary subject ontology rebind: ${message}`);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function scanJsonString(text, start) {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') return index + 1;
  }
  fail('ontology index contains an unterminated JSON string');
}

function scanJsonValue(text, start) {
  if (text[start] === '"') return scanJsonString(text, start);
  if (text[start] !== '{' && text[start] !== '[') {
    let cursor = start;
    while (cursor < text.length && !/[\s,}\]]/u.test(text[cursor])) cursor += 1;
    return cursor;
  }
  const stack = [];
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '"') {
      index = scanJsonString(text, index) - 1;
      continue;
    }
    if (text[index] === '{' || text[index] === '[') {
      stack.push(text[index]);
      continue;
    }
    if (text[index] === '}' || text[index] === ']') {
      const expected = text[index] === '}' ? '{' : '[';
      if (stack.pop() !== expected) fail('ontology index contains a malformed JSON value');
      if (stack.length === 0) return index + 1;
    }
  }
  fail('ontology index contains an unterminated JSON value');
}

function replaceTopLevelProperty(buffer, property, value) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '"') {
      const stringEnd = scanJsonString(text, index);
      if (depth === 1 && JSON.parse(text.slice(index, stringEnd)) === property) {
        let cursor = stringEnd;
        while (/\s/u.test(text[cursor] || '')) cursor += 1;
        if (text[cursor] !== ':') fail(`top-level ${property} is not followed by a colon`);
        cursor += 1;
        while (/\s/u.test(text[cursor] || '')) cursor += 1;
        const valueEnd = scanJsonValue(text, cursor);
        const lineStart = text.lastIndexOf('\n', cursor) + 1;
        const indentation = text.slice(lineStart, lineStart + text.slice(lineStart).search(/\S/u));
        const replacement = JSON.stringify(value, null, 2).replaceAll('\n', `\n${indentation}`);
        return Buffer.from(`${text.slice(0, cursor)}${replacement}${text.slice(valueEnd)}`, 'utf8');
      }
      index = stringEnd - 1;
      continue;
    }
    if (text[index] === '{' || text[index] === '[') depth += 1;
    if (text[index] === '}' || text[index] === ']') depth -= 1;
  }
  fail(`ontology index is missing top-level ${property}`);
}

function sameBytes(left, right) {
  return left.length === right.length && left.equals(right);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label} has unexpected or missing fields`);
}

function assertBooleanFalse(value, label) {
  if (value !== false) fail(`ordinary fail-closed ${label} must be false`);
}

function assertZeroOntologyIndex(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)
      || index.schema_version !== 2
      || index.artifact_kind !== 'subject_ontology_index'
      || index.contract_id !== 'subject-ontology-v2'
      || index.status !== 'candidate_fail_closed') {
    fail('index is not the candidate_fail_closed subject-ontology-v2 contract');
  }
  if (!Array.isArray(index.coverage_universes) || index.coverage_universes.length !== 0) {
    fail('coverage_universes must remain empty');
  }
  if (!Array.isArray(index.canonical_facets) || index.canonical_facets.length !== CANONICAL_FACETS.length) {
    fail('all 12 canonical facets must be present exactly once');
  }
  for (let position = 0; position < CANONICAL_FACETS.length; position += 1) {
    const expected = CANONICAL_FACETS[position];
    const facet = index.canonical_facets[position];
    if (facet?.facet_id !== expected.facet_id || facet.label !== expected.label
        || facet.directory !== expected.directory) {
      fail(`facet ${position} differs from the canonical 12-facet identity`);
    }
    if (facet.status !== 'not_started') fail(`${facet.facet_id}.status must remain not_started`);
    if (!Array.isArray(facet.scope_files) || facet.scope_files.length !== 0) {
      fail(`${facet.facet_id}.scope_files must remain empty`);
    }
    const coverage = facet.coverage;
    if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) {
      fail(`${facet.facet_id}.coverage is missing`);
    }
    for (const key of ['scope_count', 'concept_count', 'semantic_relation_count']) {
      if (coverage[key] !== 0) fail(`${facet.facet_id}.coverage.${key} must remain zero`);
    }
    assertBooleanFalse(coverage.current_ordinary_scope_complete, `${facet.facet_id}.coverage.current_ordinary_scope_complete`);
    assertBooleanFalse(coverage.historical_coverage_complete, `${facet.facet_id}.coverage.historical_coverage_complete`);
    if (coverage.unknown_or_unresolved !== true) {
      fail(`${facet.facet_id}.coverage.unknown_or_unresolved must remain true`);
    }
    if (!Array.isArray(coverage.reason_codes) || coverage.reason_codes.length === 0) {
      fail(`${facet.facet_id}.coverage.reason_codes must retain an unresolved reason`);
    }
  }
  const gate = index.release_gate;
  if (!gate || gate.mode !== 'ordinary_nonpublishable') {
    fail('ordinary fail-closed release_gate.mode must be ordinary_nonpublishable');
  }
  for (const key of [
    'builder_input_allowed',
    'public_data_update_allowed',
    'semantic_claims_allowed',
    'negative_historical_assertions_allowed',
  ]) assertBooleanFalse(gate[key], `release_gate.${key}`);
  if (!Array.isArray(gate.reason_codes) || gate.reason_codes.length === 0) {
    fail('ordinary fail-closed release_gate must retain reason codes');
  }
}

async function safeArtifact(root, relativePath, label = relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || isAbsolute(relativePath)
      || relativePath === '..' || relativePath.startsWith('../') || relativePath.includes('/../')
      || relativePath.includes('\\')) {
    fail(`${label} is not a safe project-relative path`);
  }
  const realRoot = await realpath(root);
  const candidate = resolve(realRoot, relativePath);
  const relation = relative(realRoot, candidate);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    fail(`${label} escapes the project root`);
  }
  const lexical = await lstat(candidate);
  if (lexical.isSymbolicLink() || !lexical.isFile()) fail(`${label} must be a regular non-symlink file`);
  const resolved = await realpath(candidate);
  const resolvedRelation = relative(realRoot, resolved);
  if (resolvedRelation === '..' || resolvedRelation.startsWith(`..${sep}`) || isAbsolute(resolvedRelation)) {
    fail(`${label} resolves outside the project root`);
  }
  const buffer = await readFile(resolved);
  return {
    path: relativePath,
    absolute: resolved,
    buffer,
    sha256: sha256(buffer),
    bytes: buffer.length,
    mode: (await stat(resolved)).mode & 0o777,
  };
}

function parseJson(artifact, label = artifact.path) {
  try {
    return JSON.parse(artifact.buffer.toString('utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

async function assertNoOntologyPayload(root) {
  const ontologyRoot = resolve(root, 'data/ontologies');
  const pending = [ontologyRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(`unregistered ontology artifact is a symlink: ${absolute}`);
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) fail(`unregistered ontology artifact has an unsupported type: ${absolute}`);
      const projectPath = relative(resolve(root), absolute).replaceAll('\\', '/');
      if (projectPath !== INDEX_PATH) fail(`unregistered ontology artifact is forbidden in ordinary mode: ${projectPath}`);
    }
  }
}

function assertZeroPageEvidence(result, manifest) {
  if (result?.valid !== true || result.publishable !== false || result.status !== 'unresolved_fail_closed') {
    fail('ordinary page evidence must be valid, unresolved_fail_closed, and publishable=false');
  }
  if (!manifest || manifest.status !== 'unresolved_fail_closed'
      || !Array.isArray(manifest.bundles) || manifest.bundles.length !== 0) {
    fail('ordinary page evidence must retain an empty fail-closed bundle set');
  }
  if (JSON.stringify(result.counts) !== JSON.stringify(ZERO_PUBLICATION_COUNTS)
      || JSON.stringify(manifest.expected_publication) !== JSON.stringify(ZERO_PUBLICATION_COUNTS)) {
    fail('ordinary page evidence counts must all remain zero');
  }
}

async function copyShadowArtifact(shadowRoot, artifact) {
  const destination = resolve(shadowRoot, artifact.path);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(artifact.absolute, destination);
  const copied = await readFile(destination);
  if (!sameBytes(copied, artifact.buffer)) fail(`shadow copy drifted for ${artifact.path}`);
}

async function computeReportFromShadow({ artifacts, indexBuffer }) {
  const shadowRoot = await mkdtemp(join(tmpdir(), 'curriculum-ordinary-ontology-shadow-'));
  try {
    for (const artifact of artifacts.values()) await copyShadowArtifact(shadowRoot, artifact);
    const shadowIndex = resolve(shadowRoot, INDEX_PATH);
    await mkdir(dirname(shadowIndex), { recursive: true, mode: 0o700 });
    await writeFile(shadowIndex, indexBuffer, { mode: 0o600 });
    return computeSubjectOntologyV2Report({ rootDir: shadowRoot });
  } finally {
    await rm(shadowRoot, { recursive: true, force: true });
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertTemporaryPath(artifact, temporary) {
  if (typeof temporary !== 'string' || dirname(temporary) !== dirname(artifact.absolute)
      || temporary === artifact.absolute) {
    fail(`temporary path is not in the governed target directory: ${artifact.absolute}`);
  }
}

async function writeAtomic(artifact, buffer, { temporary, afterTemporarySync = null } = {}) {
  assertTemporaryPath(artifact, temporary);
  if (afterTemporarySync !== null && typeof afterTemporarySync !== 'function') {
    fail('afterTemporarySync must be a function');
  }
  let handle;
  try {
    handle = await open(temporary, 'wx', artifact.mode ?? 0o644);
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    await afterTemporarySync?.();
    await rename(temporary, artifact.absolute);
    await syncDirectory(dirname(artifact.absolute));
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function writeAtomicNoReplace(artifact, buffer, { temporary, afterTemporarySync = null } = {}) {
  assertTemporaryPath(artifact, temporary);
  if (afterTemporarySync !== null && typeof afterTemporarySync !== 'function') {
    fail('afterTemporarySync must be a function');
  }
  let handle;
  try {
    handle = await open(temporary, 'wx', artifact.mode ?? 0o600);
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    await afterTemporarySync?.();
    await link(temporary, artifact.absolute);
    await unlink(temporary);
    await syncDirectory(dirname(artifact.absolute));
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function transactionIdentity(buffer) {
  return {
    sha256: sha256(buffer),
    bytes: buffer.length,
    base64: buffer.toString('base64'),
  };
}

function decodeTransactionIdentity(value, label) {
  exactKeys(value, ['sha256', 'bytes', 'base64'], label);
  if (!/^[a-f0-9]{64}$/u.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes < 0
      || typeof value.base64 !== 'string') {
    fail(`${label} identity is malformed`);
  }
  const buffer = Buffer.from(value.base64, 'base64');
  if (buffer.toString('base64') !== value.base64 || buffer.length !== value.bytes
      || sha256(buffer) !== value.sha256) {
    fail(`${label} bytes do not match their transaction identity`);
  }
  return { ...value, buffer };
}

function outputTemporaryPath(path, ownerPid, transactionId) {
  return join(
    dirname(path),
    `.${basename(path)}.ordinary-rebind-${ownerPid}-${transactionId}.tmp`,
  ).replaceAll('\\', '/');
}

function journalTemporaryPath(ownerPid, transactionId, phase) {
  return `data/.subject-ontology-v2-ordinary-rebind-${phase}-${ownerPid}-${transactionId}.tmp`;
}

function transactionOutput({ path, mode, before, after, ownerPid, transactionId }) {
  return {
    path,
    mode,
    temporary_path: outputTemporaryPath(path, ownerPid, transactionId),
    before: transactionIdentity(before),
    after: transactionIdentity(after),
  };
}

function buildTransaction({ indexArtifact, reportArtifact, indexBuffer, reportBuffer }) {
  const transactionId = randomUUID();
  const ownerPid = process.pid;
  return {
    schema_version: 1,
    artifact_kind: 'subject_ontology_v2_ordinary_rebind_transaction',
    transaction_id: transactionId,
    owner_pid: ownerPid,
    state: 'prepared',
    outputs: {
      index: transactionOutput({
        path: INDEX_PATH,
        mode: indexArtifact.mode,
        before: indexArtifact.buffer,
        after: indexBuffer,
        ownerPid,
        transactionId,
      }),
      report: transactionOutput({
        path: REPORT_PATH,
        mode: reportArtifact.mode,
        before: reportArtifact.buffer,
        after: reportBuffer,
        ownerPid,
        transactionId,
      }),
    },
  };
}

function validateTransactionOutput(value, expectedPath, ownerPid, transactionId, label) {
  exactKeys(value, ['path', 'mode', 'temporary_path', 'before', 'after'], label);
  if (value.path !== expectedPath
      || value.temporary_path !== outputTemporaryPath(expectedPath, ownerPid, transactionId)
      || !Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o777) {
    fail(`${label} target identity is invalid`);
  }
  return {
    path: value.path,
    mode: value.mode,
    temporary_path: value.temporary_path,
    before: decodeTransactionIdentity(value.before, `${label}.before`),
    after: decodeTransactionIdentity(value.after, `${label}.after`),
  };
}

function validateTransaction(value) {
  exactKeys(value, [
    'schema_version', 'artifact_kind', 'transaction_id', 'owner_pid', 'state', 'outputs',
  ], 'transaction journal');
  if (value.schema_version !== 1
      || value.artifact_kind !== 'subject_ontology_v2_ordinary_rebind_transaction'
      || !/^[a-f0-9-]{36}$/u.test(value.transaction_id)
      || !Number.isSafeInteger(value.owner_pid) || value.owner_pid < 1
      || !['prepared', 'validated'].includes(value.state)) {
    fail('transaction journal identity or state is invalid');
  }
  exactKeys(value.outputs, ['index', 'report'], 'transaction journal outputs');
  return {
    ...value,
    outputs: {
      index: validateTransactionOutput(
        value.outputs.index, INDEX_PATH, value.owner_pid, value.transaction_id, 'transaction index',
      ),
      report: validateTransactionOutput(
        value.outputs.report, REPORT_PATH, value.owner_pid, value.transaction_id, 'transaction report',
      ),
    },
  };
}

async function readTransaction(projectRoot) {
  try {
    const artifact = await safeArtifact(projectRoot, TRANSACTION_PATH, 'ordinary rebind transaction journal');
    if (artifact.mode !== 0o600) fail('ordinary rebind transaction journal must be owner-only');
    return { artifact, transaction: validateTransaction(parseJson(artifact, 'ordinary rebind transaction journal')) };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function removeTransaction(artifact) {
  await unlink(artifact.absolute);
  await syncDirectory(dirname(artifact.absolute));
}

async function removeTransactionTemporary(projectRoot, relativePath) {
  const absolute = resolve(projectRoot, relativePath);
  const relation = relative(projectRoot, absolute);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    fail(`transaction temporary path escapes the project root: ${relativePath}`);
  }
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile()) fail(`transaction temporary is not a regular file: ${relativePath}`);
    await unlink(absolute);
    await syncDirectory(dirname(absolute));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function cleanupTransactionTemporaries(projectRoot, transaction) {
  for (const relativePath of [
    transaction.outputs.index.temporary_path,
    transaction.outputs.report.temporary_path,
    journalTemporaryPath(transaction.owner_pid, transaction.transaction_id, 'journal'),
    journalTemporaryPath(transaction.owner_pid, transaction.transaction_id, 'validated'),
  ]) await removeTransactionTemporary(projectRoot, relativePath);
}

async function cleanupOrphanJournalTemporaries(projectRoot) {
  const dataRoot = resolve(projectRoot, 'data');
  const pattern = /^\.subject-ontology-v2-ordinary-rebind-(?:journal|validated)-(\d+)-([a-f0-9-]{36})\.tmp$/u;
  let changed = false;
  for (const entry of await readdir(dataRoot, { withFileTypes: true })) {
    const match = entry.name.match(pattern);
    if (!match) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) fail(`orphan transaction temporary is unsafe: data/${entry.name}`);
    const ownerPid = Number(match[1]);
    if (!Number.isSafeInteger(ownerPid) || ownerPid < 1 || processIsAlive(ownerPid)) {
      fail(`transaction initialization is still owned by a live process: data/${entry.name}`);
    }
    const info = await lstat(join(dataRoot, entry.name));
    if ((info.mode & 0o777) !== 0o600) fail(`orphan transaction temporary is not owner-only: data/${entry.name}`);
    await unlink(join(dataRoot, entry.name));
    changed = true;
  }
  if (changed) await syncDirectory(dataRoot);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function recoverInterruptedTransaction(projectRoot, {
  allowLiveOwner = false,
  expectedTransactionId = null,
} = {}) {
  const pending = await readTransaction(projectRoot);
  if (!pending) return null;
  const { artifact: journalArtifact, transaction } = pending;
  if (expectedTransactionId !== null && transaction.transaction_id !== expectedTransactionId) {
    fail('transaction journal does not belong to this invocation');
  }
  if (processIsAlive(transaction.owner_pid)
      && !(allowLiveOwner && transaction.owner_pid === process.pid)) {
    fail(`transaction ${transaction.transaction_id} is still owned by a live process`);
  }
  await cleanupTransactionTemporaries(projectRoot, transaction);
  const indexArtifact = await safeArtifact(projectRoot, INDEX_PATH, 'transaction recovery index');
  const reportArtifact = await safeArtifact(projectRoot, REPORT_PATH, 'transaction recovery report');
  const targets = [
    [indexArtifact, transaction.outputs.index],
    [reportArtifact, transaction.outputs.report],
  ];
  for (const [target, identity] of targets) {
    if (target.mode !== identity.mode) fail(`${identity.path} mode changed during the interrupted transaction`);
    if (!sameBytes(target.buffer, identity.before.buffer) && !sameBytes(target.buffer, identity.after.buffer)) {
      fail(`${identity.path} matches neither side of the interrupted transaction`);
    }
  }
  if (transaction.state === 'validated') {
    if (!targets.every(([target, identity]) => sameBytes(target.buffer, identity.after.buffer))) {
      fail('validated transaction does not contain both exact after-images');
    }
    await removeTransaction(journalArtifact);
    return 'completed_validated_transaction';
  }
  for (const [target, identity] of targets) {
    if (!sameBytes(target.buffer, identity.before.buffer)) {
      await writeAtomic(target, identity.before.buffer, {
        temporary: resolve(projectRoot, identity.temporary_path),
      });
    }
  }
  const restoredIndex = await safeArtifact(projectRoot, INDEX_PATH, 'restored transaction index');
  const restoredReport = await safeArtifact(projectRoot, REPORT_PATH, 'restored transaction report');
  if (!sameBytes(restoredIndex.buffer, transaction.outputs.index.before.buffer)
      || !sameBytes(restoredReport.buffer, transaction.outputs.report.before.buffer)) {
    fail('interrupted transaction rollback did not restore both exact before-images');
  }
  await removeTransaction(journalArtifact);
  return 'rolled_back_prepared_transaction';
}

async function writeTransaction(projectRoot, transaction, { afterTemporarySync = null } = {}) {
  const existing = await readTransaction(projectRoot);
  if (existing) fail('another ordinary rebind transaction is already present');
  const absolute = resolve(projectRoot, TRANSACTION_PATH);
  const artifact = { absolute, mode: 0o600 };
  await writeAtomicNoReplace(artifact, jsonBytes(transaction), {
    temporary: resolve(projectRoot, journalTemporaryPath(
      transaction.owner_pid, transaction.transaction_id, 'journal',
    )),
    afterTemporarySync,
  });
  return safeArtifact(projectRoot, TRANSACTION_PATH, 'written ordinary rebind transaction journal');
}

async function markTransactionValidated(projectRoot, transaction) {
  const pending = await readTransaction(projectRoot);
  if (!pending || pending.transaction.transaction_id !== transaction.transaction_id
      || pending.transaction.state !== 'prepared') {
    fail('prepared transaction journal changed before validation commit');
  }
  const validated = { ...transaction, state: 'validated' };
  await writeAtomic(pending.artifact, jsonBytes(validated), {
    temporary: resolve(projectRoot, journalTemporaryPath(
      transaction.owner_pid, transaction.transaction_id, 'validated',
    )),
  });
  return safeArtifact(projectRoot, TRANSACTION_PATH, 'validated ordinary rebind transaction journal');
}

async function assertArtifactsUnchanged(root, artifacts) {
  for (const artifact of artifacts.values()) {
    const current = await safeArtifact(root, artifact.path);
    if (!sameBytes(current.buffer, artifact.buffer)) fail(`source changed during rebind: ${artifact.path}`);
  }
}

export async function rebindOrdinarySubjectOntologyV2({
  root = DEFAULT_ROOT,
  promotion = false,
  testHooks = null,
} = {}) {
  if (promotion !== false) fail('promotion is forbidden; use the signed two-commit promotion path');
  const projectRoot = await realpath(resolve(root));
  if (testHooks !== null) {
    exactKeys(testHooks, [
      'afterJournalTemporarySync', 'afterIndexTemporarySync', 'afterIndexWrite',
    ], 'testHooks');
    if (typeof testHooks.afterJournalTemporarySync !== 'function'
        || typeof testHooks.afterIndexTemporarySync !== 'function'
        || typeof testHooks.afterIndexWrite !== 'function') {
      fail('all testHooks callbacks must be functions');
    }
    if (projectRoot === await realpath(DEFAULT_ROOT)) fail('testHooks are forbidden for the real project root');
  }
  if (ACTIVE_ROOTS.has(projectRoot)) fail('another ordinary rebind is active for this project root');
  ACTIVE_ROOTS.add(projectRoot);
  try {
  await cleanupOrphanJournalTemporaries(projectRoot);
  const recoveredTransaction = await recoverInterruptedTransaction(projectRoot);
  const indexArtifact = await safeArtifact(projectRoot, INDEX_PATH, 'ontology index');
  const reportArtifact = await safeArtifact(projectRoot, REPORT_PATH, 'ontology validation report');
  const index = parseJson(indexArtifact, 'ontology index');
  assertZeroOntologyIndex(index);
  await assertNoOntologyPayload(projectRoot);

  const artifacts = new Map();
  for (const relativePath of SHADOW_PATHS) {
    const artifact = await safeArtifact(projectRoot, relativePath);
    artifacts.set(relativePath, artifact);
  }
  const schema = parseJson(artifacts.get(SCHEMA_PATH), 'subject ontology schema');
  validateDraft202012(schema, index, { label: 'ordinary subject ontology index' });

  const catalog = parseJson(artifacts.get(BINDING_PATHS.catalog), 'catalog');
  if (!Array.isArray(catalog.documents) || catalog.documents.length !== EXPECTED_DOCUMENTS
      || new Set(catalog.documents.map((document) => document?.id)).size !== EXPECTED_DOCUMENTS) {
    fail(`catalog must contain exactly ${EXPECTED_DOCUMENTS} unique documents`);
  }
  const corpus = validateCorpusManifest(parseJson(
    artifacts.get(BINDING_PATHS.corpus_manifest),
    'corpus manifest',
  ));
  if (corpus.documents !== EXPECTED_DOCUMENTS || corpus.sql_chunks !== EXPECTED_SQL_CHUNKS
      || corpus.sql_files.length !== EXPECTED_SQL_CHUNKS) {
    fail(`corpus must contain ${EXPECTED_DOCUMENTS} documents and ${EXPECTED_SQL_CHUNKS} SQL chunks`);
  }

  const pageEvidenceManifest = parseJson(
    artifacts.get(BINDING_PATHS.page_evidence_manifest),
    'page-evidence manifest',
  );
  const pageEvidence = validatePageEvidenceForRelease({
    root: projectRoot,
    pageEvidencePromotion: false,
  });
  assertZeroPageEvidence(pageEvidence, pageEvidenceManifest);

  const rebound = structuredClone(index);
  rebound.bindings = {
    taxonomy: {
      path: BINDING_PATHS.taxonomy,
      sha256: artifacts.get(BINDING_PATHS.taxonomy).sha256,
    },
    catalog: {
      path: BINDING_PATHS.catalog,
      sha256: artifacts.get(BINDING_PATHS.catalog).sha256,
    },
    provenance: {
      path: BINDING_PATHS.provenance,
      sha256: artifacts.get(BINDING_PATHS.provenance).sha256,
    },
    corpus_manifest: {
      path: BINDING_PATHS.corpus_manifest,
      sha256: artifacts.get(BINDING_PATHS.corpus_manifest).sha256,
      release_id: corpus.release_id,
      release_fingerprint_sha256: corpus.release_fingerprint_sha256,
      manifest_sha256: corpus.manifest_sha256,
    },
    page_evidence_manifest: {
      path: BINDING_PATHS.page_evidence_manifest,
      sha256: artifacts.get(BINDING_PATHS.page_evidence_manifest).sha256,
    },
    reviewer_registry: {
      path: BINDING_PATHS.reviewer_registry,
      sha256: artifacts.get(BINDING_PATHS.reviewer_registry).sha256,
    },
    online_source_registry: {
      path: BINDING_PATHS.online_source_registry,
      sha256: artifacts.get(BINDING_PATHS.online_source_registry).sha256,
    },
    online_verification_standard: {
      path: BINDING_PATHS.online_verification_standard,
      sha256: artifacts.get(BINDING_PATHS.online_verification_standard).sha256,
    },
    validation_report_path: REPORT_PATH,
  };
  assertZeroOntologyIndex(rebound);
  validateDraft202012(schema, rebound, { label: 'rebound ordinary subject ontology index' });
  const indexBuffer = replaceTopLevelProperty(indexArtifact.buffer, 'bindings', rebound.bindings);
  const report = await computeReportFromShadow({ artifacts, indexBuffer });
  if (report.mode !== 'ordinary_nonpublishable' || report.valid !== true || report.publishable !== false
      || report.counts?.facets !== 12 || report.counts.scopes !== 0
      || report.counts.coverage_universes !== 0 || report.counts.concepts !== 0
      || report.counts.relations !== 0) {
    fail('computed report is not the exact zero-data ordinary validation result');
  }
  const reportBuffer = jsonBytes(report);

  await assertArtifactsUnchanged(projectRoot, artifacts);
  const currentIndex = await safeArtifact(projectRoot, INDEX_PATH, 'ontology index pre-write recheck');
  const currentReport = await safeArtifact(projectRoot, REPORT_PATH, 'ontology report pre-write recheck');
  if (!sameBytes(currentIndex.buffer, indexArtifact.buffer)
      || !sameBytes(currentReport.buffer, reportArtifact.buffer)) {
    fail('governed ontology outputs changed during rebind');
  }

  const indexChanged = !sameBytes(indexArtifact.buffer, indexBuffer);
  const reportChanged = !sameBytes(reportArtifact.buffer, reportBuffer);
  const transaction = buildTransaction({ indexArtifact, reportArtifact, indexBuffer, reportBuffer });
  let transactionWritten = false;
  try {
    if (indexChanged || reportChanged) {
      try {
        await writeTransaction(projectRoot, transaction, {
          afterTemporarySync: testHooks?.afterJournalTemporarySync,
        });
        transactionWritten = true;
      } catch (error) {
        const pending = await readTransaction(projectRoot);
        if (pending?.transaction.transaction_id === transaction.transaction_id) transactionWritten = true;
        throw error;
      }
    }
    if (indexChanged) {
      await writeAtomic(indexArtifact, indexBuffer, {
        temporary: resolve(projectRoot, transaction.outputs.index.temporary_path),
        afterTemporarySync: testHooks?.afterIndexTemporarySync,
      });
    }
    if (transactionWritten) await testHooks?.afterIndexWrite();
    if (reportChanged) {
      await writeAtomic(reportArtifact, reportBuffer, {
        temporary: resolve(projectRoot, transaction.outputs.report.temporary_path),
      });
    }
    const validated = validateSubjectOntologyV2({ rootDir: projectRoot });
    if (validated.valid !== true || validated.publishable !== false
        || validated.counts?.scopes !== 0 || validated.counts?.concepts !== 0
        || validated.counts?.relations !== 0) {
      fail('exact post-write validator did not preserve the ordinary fail-closed state');
    }
    if (transactionWritten) {
      const validatedJournal = await markTransactionValidated(projectRoot, transaction);
      await removeTransaction(validatedJournal);
    }
    return {
      changed: indexChanged || reportChanged,
      recovered_transaction: recoveredTransaction,
      index: { path: INDEX_PATH, sha256: sha256(indexBuffer), bytes: indexBuffer.length },
      report: { path: REPORT_PATH, sha256: sha256(reportBuffer), bytes: reportBuffer.length },
      catalog: { sha256: artifacts.get(BINDING_PATHS.catalog).sha256, documents: catalog.documents.length },
      corpus: {
        sha256: artifacts.get(BINDING_PATHS.corpus_manifest).sha256,
        release_id: corpus.release_id,
        release_fingerprint_sha256: corpus.release_fingerprint_sha256,
        manifest_sha256: corpus.manifest_sha256,
        documents: corpus.documents,
        sql_chunks: corpus.sql_chunks,
      },
      page_evidence: {
        sha256: artifacts.get(BINDING_PATHS.page_evidence_manifest).sha256,
        status: pageEvidence.status,
        publishable: pageEvidence.publishable,
        counts: pageEvidence.counts,
      },
    };
  } catch (error) {
    try {
      if (transactionWritten) {
        await recoverInterruptedTransaction(projectRoot, {
          allowLiveOwner: true,
          expectedTransactionId: transaction.transaction_id,
        });
      }
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'ordinary ontology rebind failed and rollback also failed');
    }
    throw error;
  }
  } finally {
    ACTIVE_ROOTS.delete(projectRoot);
  }
}

export function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, promotion: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--promotion' || argument === '--page-evidence-promotion'
        || argument === '--subject-ontology-v2-promotion') {
      fail('promotion flags are forbidden; use the signed two-commit promotion path');
    }
    if (argument !== '--root') fail(`unexpected argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail('--root requires a path');
    options.root = value;
    index += 1;
  }
  return options;
}

async function main() {
  const result = await rebindOrdinarySubjectOntologyV2(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
