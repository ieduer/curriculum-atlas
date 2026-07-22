#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  buildResearchSourceRegistry,
  projectResearchEvidenceSlice,
  validateResearchEvidenceSlice,
} from './lib/research-evidence-slice.mjs';
import { validateCorpusManifest } from './import-corpus.mjs';
import {
  assertResearchEvidenceReleaseGate,
  renderResearchEvidencePdfPage,
} from './validate-research-evidence-slice.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const MANIFEST_PATH = 'data/research-evidence/zh-hs-2017-2020.json';
const SOURCE_REGISTRY_PATH = 'data/research-evidence/zh-hs-2017-2020-source-registry.json';
const SCHEMA_PATH = 'data/research-evidence/research-evidence-slice.schema.json';
const CORPUS_MANIFEST_PATH = 'data/corpus-chunks/manifest.json';
const TRANSACTION_PATH = 'data/research-evidence/.zh-hs-2017-2020-corpus-rebind-transaction.json';
const JOURNAL_TEMP_PATTERN = /^\.zh-hs-2017-2020-corpus-rebind-(journal|staged|validated)-(\d+)-([a-f0-9-]{36})\.tmp$/u;
const PUBLICATION_KEYS = Object.freeze([
  'builder_input_allowed',
  'public_compare_allowed',
  'public_star_allowed',
  'ai_citation_allowed',
  'discussion_claim_citation_allowed',
]);
const ACTIVE_ROOTS = new Set();

function fail(message) {
  throw new Error(`research evidence corpus rebind: ${message}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} has unexpected or missing fields`);
  }
}

function sameBytes(left, right) {
  return left.length === right.length && left.equals(right);
}

function safeRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value)
      || value === '..' || value.startsWith('../') || value.includes('/../')
      || value.includes('\\')) {
    fail(`${label} is not a safe project-relative path`);
  }
  return value;
}

function contained(root, candidate, label) {
  const relation = relative(root, candidate);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    fail(`${label} escapes the project root`);
  }
}

function statIdentity(info) {
  return {
    dev: info.dev,
    ino: info.ino,
    uid: info.uid,
    nlink: info.nlink,
    size: info.size,
    mode: info.mode,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function assertNoAbsoluteSymlink(absolutePath, label) {
  let cursor = sep;
  for (const part of resolve(absolutePath).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) fail(`${label} contains a symbolic-link path component`);
  }
}

async function readStableAbsoluteFile(absolutePath, label, { allowedNlinks = [1n] } = {}) {
  if (typeof absolutePath !== 'string' || !isAbsolute(absolutePath)) {
    fail(`${label} must use an absolute path`);
  }
  await assertNoAbsoluteSymlink(absolutePath, label);
  const lexical = await lstat(absolutePath);
  if (lexical.isSymbolicLink() || !lexical.isFile()) {
    fail(`${label} must be a regular non-symlink file`);
  }
  const handle = await open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) fail(`${label} must remain a regular file`);
    if (typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid())) {
      fail(`${label} must be owned by the current user`);
    }
    if (!allowedNlinks.includes(before.nlink)) {
      if (allowedNlinks.length === 1 && allowedNlinks[0] === 1n) {
        fail(`${label} must have exactly one hard link`);
      }
      fail(`${label} must have ${allowedNlinks.map(String).join(' or ')} hard links`);
    }
    if ((before.mode & 0o022n) !== 0n) fail(`${label} must not be group/world writable`);
    const buffer = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(statIdentity(before), statIdentity(after))
        || BigInt(buffer.length) !== after.size) {
      fail(`${label} changed while it was read`);
    }
    return {
      absolute: absolutePath,
      buffer,
      bytes: buffer.length,
      sha256: sha256(buffer),
      mode: Number(after.mode & 0o777n),
      identity: statIdentity(after),
    };
  } finally {
    await handle.close();
  }
}

async function assertNoProjectSymlink(root, relativePath, label) {
  let cursor = root;
  const parts = relativePath.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index]);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) fail(`${label} contains a symbolic link: ${relativePath}`);
    if (index < parts.length - 1 && !info.isDirectory()) {
      fail(`${label} has a non-directory ancestor: ${relativePath}`);
    }
  }
}

async function readStableProjectFile(root, relativePath, label = relativePath, options = {}) {
  safeRelativePath(relativePath, label);
  const projectRoot = await realpath(root);
  const absolute = resolve(projectRoot, relativePath);
  contained(projectRoot, absolute, label);
  await assertNoProjectSymlink(projectRoot, relativePath, label);
  const resolved = await realpath(absolute);
  contained(projectRoot, resolved, label);
  const artifact = await readStableAbsoluteFile(resolved, label, options);
  return { ...artifact, path: relativePath };
}

function parseJson(artifact, label) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(artifact.buffer));
  } catch (error) {
    fail(`${label} is not strict UTF-8 JSON: ${error.message}`);
  }
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
  fail('JSON contains an unterminated string');
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
    if (text[index] === '{' || text[index] === '[') stack.push(text[index]);
    else if (text[index] === '}' || text[index] === ']') {
      const expected = text[index] === '}' ? '{' : '[';
      if (stack.pop() !== expected) fail('JSON contains a malformed value');
      if (stack.length === 0) return index + 1;
    }
  }
  fail('JSON contains an unterminated value');
}

function objectPropertyRange(text, objectStart, objectEnd, property, label) {
  if (text[objectStart] !== '{') fail(`${label} is not an object`);
  let depth = 0;
  let found = null;
  for (let index = objectStart; index < objectEnd; index += 1) {
    if (text[index] === '"') {
      const stringEnd = scanJsonString(text, index);
      if (depth === 1 && JSON.parse(text.slice(index, stringEnd)) === property) {
        let cursor = stringEnd;
        while (/\s/u.test(text[cursor] || '')) cursor += 1;
        if (text[cursor] !== ':') fail(`${label}.${property} is not followed by a colon`);
        cursor += 1;
        while (/\s/u.test(text[cursor] || '')) cursor += 1;
        const range = { start: cursor, end: scanJsonValue(text, cursor) };
        if (found) fail(`${label}.${property} occurs more than once`);
        found = range;
      }
      index = stringEnd - 1;
      continue;
    }
    if (text[index] === '{' || text[index] === '[') depth += 1;
    else if (text[index] === '}' || text[index] === ']') depth -= 1;
  }
  if (!found) fail(`${label} is missing ${property}`);
  return found;
}

function arrayItemRanges(text, arrayRange, label) {
  if (text[arrayRange.start] !== '[') fail(`${label} is not an array`);
  const ranges = [];
  let cursor = arrayRange.start + 1;
  while (cursor < arrayRange.end - 1) {
    while (/\s|,/u.test(text[cursor] || '')) cursor += 1;
    if (cursor >= arrayRange.end - 1) break;
    const end = scanJsonValue(text, cursor);
    ranges.push({ start: cursor, end });
    cursor = end;
  }
  return ranges;
}

function replacement(range, value) {
  return { ...range, bytes: JSON.stringify(value) };
}

function applyTextReplacements(text, replacements) {
  const ordered = [...replacements].sort((left, right) => right.start - left.start);
  let previousStart = text.length + 1;
  let output = text;
  for (const entry of ordered) {
    if (entry.start < 0 || entry.end <= entry.start || entry.end > text.length
        || entry.end > previousStart) {
      fail('JSON byte-preserving replacements overlap or escape the source');
    }
    output = `${output.slice(0, entry.start)}${entry.bytes}${output.slice(entry.end)}`;
    previousStart = entry.start;
  }
  JSON.parse(output);
  return Buffer.from(output, 'utf8');
}

function patchResearchManifestBytes(artifact, candidate) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(artifact.buffer);
  const rootEnd = scanJsonValue(text, 0);
  const corpusRange = objectPropertyRange(text, 0, rootEnd, 'corpus', 'manifest');
  const evidenceRange = objectPropertyRange(text, 0, rootEnd, 'evidence', 'manifest');
  const replacements = [
    replacement(objectPropertyRange(text, corpusRange.start, corpusRange.end, 'release_id', 'manifest.corpus'), candidate.corpus.release_id),
    replacement(objectPropertyRange(text, corpusRange.start, corpusRange.end, 'release_fingerprint_sha256', 'manifest.corpus'), candidate.corpus.release_fingerprint_sha256),
    replacement(objectPropertyRange(text, corpusRange.start, corpusRange.end, 'manifest_sha256', 'manifest.corpus'), candidate.corpus.manifest_sha256),
  ];
  const expectedById = new Map(candidate.evidence.map((entry) => [entry.evidence_id, entry]));
  const seen = new Set();
  for (const range of arrayItemRanges(text, evidenceRange, 'manifest.evidence')) {
    const item = JSON.parse(text.slice(range.start, range.end));
    const expected = expectedById.get(item.evidence_id);
    if (!expected || seen.has(item.evidence_id)) fail(`unexpected or duplicate evidence item: ${String(item.evidence_id)}`);
    seen.add(item.evidence_id);
    replacements.push(replacement(
      objectPropertyRange(text, range.start, range.end, 'paragraph_id', `manifest.evidence.${item.evidence_id}`),
      expected.paragraph_id,
    ));
  }
  if (seen.size !== expectedById.size) fail('manifest evidence byte ranges do not cover the candidate set');
  return applyTextReplacements(text, replacements);
}

function patchRegistryBytes(artifact, rowsetSha256) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(artifact.buffer);
  const rootEnd = scanJsonValue(text, 0);
  return applyTextReplacements(text, [replacement(
    objectPropertyRange(text, 0, rootEnd, 'research_corpus_rowset_sha256', 'source registry'),
    rowsetSha256,
  )]);
}

function assertFailClosed(manifest) {
  exactKeys(manifest.release_boundary, [
    'signed_editor_review_required', 'builder_input_allowed',
    'public_data_update_allowed', 'deployment_allowed',
  ], 'release boundary');
  if (manifest.release_boundary.signed_editor_review_required !== true
      || manifest.release_boundary.builder_input_allowed !== false
      || manifest.release_boundary.public_data_update_allowed !== false
      || manifest.release_boundary.deployment_allowed !== false) {
    fail('research release boundary must remain signed-review-required and fail closed');
  }
  for (const assertion of manifest.assertions || []) {
    if (assertion.review?.status !== 'pending_signed_editor_review'
        || assertion.review?.reviewer_id !== null
        || assertion.review?.decision_resource_id !== null) {
      fail(`${assertion.assertion_id} must retain an unsigned pending editor review`);
    }
    exactKeys(assertion.publication, PUBLICATION_KEYS, `${assertion.assertion_id}.publication`);
    for (const key of PUBLICATION_KEYS) {
      if (assertion.publication[key] !== false) fail(`${assertion.assertion_id}.${key} must remain false`);
    }
    if (assertion.release_gate?.allowed !== false
        || !Array.isArray(assertion.release_gate?.blocked_by_statuses)
        || assertion.release_gate.blocked_by_statuses.length === 0) {
      fail(`${assertion.assertion_id} must retain a blocked release gate`);
    }
  }
  for (const conflict of manifest.conflicts || []) {
    if (conflict.status !== 'unresolved_fail_closed') {
      fail(`${conflict.conflict_id} must remain unresolved_fail_closed`);
    }
  }
}

function manifestInvariantProjection(manifest) {
  const projected = structuredClone(manifest);
  delete projected.corpus.release_id;
  delete projected.corpus.release_fingerprint_sha256;
  delete projected.corpus.manifest_sha256;
  for (const evidence of projected.evidence || []) delete evidence.paragraph_id;
  return projected;
}

function assertOnlyAllowedManifestChanges(before, after) {
  if (JSON.stringify(manifestInvariantProjection(before))
      !== JSON.stringify(manifestInvariantProjection(after))) {
    fail('candidate changes fields outside corpus identity and evidence paragraph IDs');
  }
  assertFailClosed(after);
}

function registryInvariantProjection(registry) {
  const projected = structuredClone(registry);
  delete projected.research_corpus_rowset_sha256;
  return projected;
}

async function migrationNames(root) {
  const relativePath = 'migrations';
  await assertNoProjectSymlink(root, relativePath, 'migrations directory');
  const names = (await readdir(resolve(root, relativePath), { withFileTypes: true }))
    .filter((entry) => /^\d{4}_.+\.sql$/u.test(entry.name))
    .map((entry) => {
      if (entry.isSymbolicLink() || !entry.isFile()) fail(`migration is not a regular file: ${entry.name}`);
      return entry.name;
    })
    .sort();
  if (names.length === 0) fail('no corpus migrations were found');
  return names;
}

async function materializeCorpus(projectRoot) {
  const artifacts = new Map();
  const remember = (artifact) => {
    if (artifacts.has(artifact.path)) fail(`duplicate corpus input: ${artifact.path}`);
    artifacts.set(artifact.path, artifact);
    return artifact;
  };
  const manifestArtifact = remember(await readStableProjectFile(
    projectRoot, CORPUS_MANIFEST_PATH, 'corpus manifest',
  ));
  const manifest = validateCorpusManifest(parseJson(manifestArtifact, 'corpus manifest'));
  const migrations = await migrationNames(projectRoot);
  const migrationArtifacts = [];
  for (const name of migrations) {
    migrationArtifacts.push(remember(await readStableProjectFile(
      projectRoot, `migrations/${name}`, `migration ${name}`,
    )));
  }
  const sqlArtifacts = [];
  for (const entry of manifest.sql_files) {
    const artifact = remember(await readStableProjectFile(
      projectRoot, `data/corpus-chunks/${entry.name}`, `corpus SQL ${entry.name}`,
    ));
    if (artifact.bytes !== entry.bytes || artifact.sha256 !== entry.sha256) {
      fail(`corpus SQL ${entry.name} differs from the immutable corpus manifest`);
    }
    sqlArtifacts.push(artifact);
  }
  for (const entry of manifest.text_assets) {
    const artifact = remember(await readStableProjectFile(
      projectRoot, `.cache/text/${entry.document_id}.txt`, `corpus text ${entry.document_id}`,
    ));
    if (artifact.bytes !== entry.bytes || artifact.sha256 !== entry.sha256) {
      fail(`corpus text ${entry.document_id} differs from the immutable corpus manifest`);
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'curriculum-research-rebind-corpus-'));
  const databasePath = join(directory, 'corpus.sqlite');
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA foreign_keys=OFF;');
    for (const artifact of migrationArtifacts) {
      database.exec(new TextDecoder('utf-8', { fatal: true }).decode(artifact.buffer));
    }
    for (const artifact of sqlArtifacts) {
      database.exec(new TextDecoder('utf-8', { fatal: true }).decode(artifact.buffer));
    }
  } catch (error) {
    database.close();
    await rm(directory, { recursive: true, force: true });
    fail(`current corpus could not be materialized: ${error.message}`);
  }
  return {
    manifest,
    manifestArtifact,
    database,
    databasePath,
    artifacts,
    migrationNames: migrations,
    async cleanup() {
      try { database.close(); } catch { /* already closed */ }
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function exactTextAt(body, evidence) {
  return typeof body === 'string'
    && body.slice(evidence.utf16_start, evidence.utf16_end) === evidence.exact_text;
}

function locateEvidence(database, manifest, corpusManifest) {
  const paragraphStatement = database.prepare(`
    SELECT id,document_id,ordinal,page_number,body,body_sha256,display_allowed,citation_allowed,
           source_artifact_sha256,page_final_text_sha256,provenance_locator,corpus_release_id
    FROM paragraphs
    WHERE document_id=? AND ordinal=? AND page_number=? AND body_sha256=?
      AND source_artifact_sha256=? AND page_final_text_sha256=? AND corpus_release_id=?
    ORDER BY id
  `);
  const pageStatement = database.prepare(`
    SELECT document_id,page_number,source_artifact_sha256,final_text_sha256,stable_locator,
           publication_basis,review_status,display_allowed,citation_allowed,corpus_release_id
    FROM page_publication_gates
    WHERE document_id=? AND page_number=?
  `);
  const candidate = structuredClone(manifest);
  candidate.corpus.release_id = corpusManifest.release_id;
  candidate.corpus.release_fingerprint_sha256 = corpusManifest.release_fingerprint_sha256;
  candidate.corpus.manifest_sha256 = corpusManifest.__raw_sha256;
  const mappings = [];
  const locatorKeys = new Set();
  for (const evidence of candidate.evidence || []) {
    const matches = paragraphStatement.all(
      evidence.document_id,
      evidence.paragraph_ordinal,
      evidence.physical_pdf_page,
      evidence.paragraph_body_sha256,
      evidence.source_artifact_sha256,
      evidence.page_final_text_sha256,
      corpusManifest.release_id,
    );
    if (matches.length !== 1) {
      fail(`${evidence.evidence_id} evidence locator resolved ${matches.length} current paragraphs`);
    }
    const row = matches[0];
    if (sha256(Buffer.from(row.body, 'utf8')) !== evidence.paragraph_body_sha256
        || !exactTextAt(row.body, evidence)
        || typeof row.provenance_locator !== 'string'
        || !row.provenance_locator.startsWith(`${evidence.page_publication_stable_locator}:`)
        || !row.provenance_locator.endsWith(`:body:${evidence.paragraph_body_sha256}`)
        || Number(row.display_allowed) !== 1 || Number(row.citation_allowed) !== 1) {
      fail(`${evidence.evidence_id} current paragraph body, quote, or publication gate differs`);
    }
    const pages = pageStatement.all(evidence.document_id, evidence.physical_pdf_page);
    if (pages.length !== 1) fail(`${evidence.evidence_id} page gate resolved ${pages.length} rows`);
    const page = pages[0];
    if (page.source_artifact_sha256 !== evidence.source_artifact_sha256
        || page.final_text_sha256 !== evidence.page_final_text_sha256
        || page.stable_locator !== evidence.page_publication_stable_locator
        || page.corpus_release_id !== corpusManifest.release_id
        || Number(page.display_allowed) !== 1 || Number(page.citation_allowed) !== 1) {
      fail(`${evidence.evidence_id} current page identity or publication gate differs`);
    }
    const locatorKey = `${row.id}\u0000${evidence.utf16_start}\u0000${evidence.utf16_end}`;
    if (locatorKeys.has(locatorKey)) fail(`${evidence.evidence_id} duplicates another evidence locator`);
    locatorKeys.add(locatorKey);
    mappings.push({
      evidence_id: evidence.evidence_id,
      document_id: evidence.document_id,
      before_paragraph_id: evidence.paragraph_id,
      after_paragraph_id: Number(row.id),
      paragraph_ordinal: evidence.paragraph_ordinal,
      physical_pdf_page: evidence.physical_pdf_page,
      paragraph_body_sha256: evidence.paragraph_body_sha256,
      exact_text_sha256: evidence.exact_text_sha256,
      source_artifact_sha256: evidence.source_artifact_sha256,
      page_final_text_sha256: evidence.page_final_text_sha256,
      page_publication_stable_locator: evidence.page_publication_stable_locator,
    });
    evidence.paragraph_id = Number(row.id);
  }
  return { candidate, mappings };
}

async function loadResourceMap(resourceMapPath, manifest) {
  if (!resourceMapPath) fail('--resource-map or CURRICULUM_RESEARCH_EVIDENCE_RESOURCE_MAP is required');
  const mapArtifact = await readStableAbsoluteFile(resolve(resourceMapPath), 'research resource map');
  const value = parseJson(mapArtifact, 'research resource map');
  if (value.schema_version !== 1
      || value.policy !== 'local_read_only_research_evidence_resources_v1'
      || !value.resources || typeof value.resources !== 'object' || Array.isArray(value.resources)) {
    fail('research resource map contract is invalid');
  }
  const required = new Set([
    manifest.corpus.resource_id,
    manifest.corpus.manifest_resource_id,
    ...(manifest.online_sources || []).map((entry) => entry.resource?.resource_id),
    ...(manifest.evidence || []).map((entry) => entry.page_image?.resource_id),
  ]);
  const actual = new Set(Object.keys(value.resources));
  if ([...required].some((id) => !actual.has(id)) || [...actual].some((id) => !required.has(id))) {
    fail('research resource map must contain exactly the slice resource IDs');
  }
  const artifacts = new Map();
  const paths = {};
  for (const resourceId of [...required].sort()) {
    if (resourceId === manifest.corpus.resource_id
        || resourceId === manifest.corpus.manifest_resource_id) continue;
    const resourcePath = value.resources[resourceId];
    if (typeof resourcePath !== 'string' || !isAbsolute(resourcePath)) {
      fail(`resource ${resourceId} must use an absolute path`);
    }
    const artifact = await readStableAbsoluteFile(resourcePath, `resource ${resourceId}`);
    artifacts.set(resourceId, artifact);
    paths[resourceId] = artifact.absolute;
  }
  return { mapArtifact, value, artifacts, paths };
}

function renderPinnedPage({ pdfBytes, page, dpi, evidence }) {
  return renderResearchEvidencePdfPage({
    pdfBytes,
    page,
    dpi,
    expectedRenderer: evidence?.page_image?.renderer,
  }).buffer;
}

function assertProjectionFailClosed(projection) {
  if (projection.publication_state !== 'fail_closed_pending_signed_editor_review') {
    fail('research projection publication state opened unexpectedly');
  }
  if ((projection.assertions || []).some((entry) => entry.publication_eligible !== false)) {
    fail('research projection contains a publication-eligible assertion');
  }
  const consumers = projection.consumer_bindings || {};
  if ((consumers.compare || []).some((entry) => entry.public_display_allowed !== false)
      || (consumers.reader_search || []).some((entry) => entry.public_display_allowed !== false)
      || (consumers.star || []).some((entry) => entry.public_display_allowed !== false)
      || (consumers.ai || []).some((entry) => entry.citation_allowed !== false || entry.retrieval_allowed !== false)
      || (consumers.discussion || []).some((entry) => entry.claim_citation_allowed !== false)) {
    fail('a research evidence consumer binding opened unexpectedly');
  }
}

function validateCandidate({
  manifest,
  schema,
  sourceRegistry,
  corpus,
  resources,
  renderPageImage,
}) {
  const resourcePaths = {
    ...resources.paths,
    [manifest.corpus.resource_id]: corpus.databasePath,
    [manifest.corpus.manifest_resource_id]: corpus.manifestArtifact.absolute,
  };
  const validation = validateResearchEvidenceSlice({
    manifest,
    schema,
    sourceRegistry,
    resourcePaths,
    renderPageImage,
  });
  const result = {
    validation,
    projection: validation.evidence_integrity_valid
      ? projectResearchEvidenceSlice({ manifest, validation })
      : null,
  };
  try {
    assertResearchEvidenceReleaseGate(result);
  } catch (error) {
    fail(error.message);
  }
  let strictBlocked = false;
  try {
    assertResearchEvidenceReleaseGate(result, { requirePublicationEligible: true });
  } catch (error) {
    if (/strict publication eligibility gate failed/u.test(error.message)) strictBlocked = true;
    else fail(error.message);
  }
  if (!strictBlocked) fail('strict research publication gate unexpectedly passed');
  assertProjectionFailClosed(result.projection);
  return result;
}

async function assertArtifactUnchanged(artifact, label) {
  const current = await readStableAbsoluteFile(artifact.absolute, label);
  if (!sameIdentity(current.identity, artifact.identity) || !sameBytes(current.buffer, artifact.buffer)) {
    fail(`${label} changed during rebind`);
  }
}

async function assertInputsUnchanged(projectRoot, corpus, resources, schemaArtifact) {
  const names = await migrationNames(projectRoot);
  if (JSON.stringify(names) !== JSON.stringify(corpus.migrationNames)) {
    fail('migration set changed during rebind');
  }
  for (const artifact of corpus.artifacts.values()) {
    await assertArtifactUnchanged(artifact, artifact.path);
  }
  await assertArtifactUnchanged(resources.mapArtifact, 'research resource map');
  for (const [resourceId, artifact] of resources.artifacts) {
    await assertArtifactUnchanged(artifact, `resource ${resourceId}`);
  }
  await assertArtifactUnchanged(schemaArtifact, 'research evidence schema');
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function outputTemporaryPath(path, ownerPid, transactionId, phase) {
  return join(
    dirname(path),
    `.${basename(path)}.corpus-rebind-${phase}-${ownerPid}-${transactionId}.tmp`,
  ).replaceAll('\\', '/');
}

function journalTemporaryPath(ownerPid, transactionId, phase) {
  return `data/research-evidence/.zh-hs-2017-2020-corpus-rebind-${phase}-${ownerPid}-${transactionId}.tmp`;
}

function canonicalUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function bytesIdentity(buffer) {
  return { sha256: sha256(buffer), bytes: buffer.length, base64: buffer.toString('base64') };
}

function bytesDocument(value) {
  return { sha256: value.sha256, bytes: value.bytes, base64: value.base64 };
}

function decodeBytesIdentity(value, label) {
  exactKeys(value, ['sha256', 'bytes', 'base64'], label);
  if (!/^[a-f0-9]{64}$/u.test(value.sha256)
      || !Number.isSafeInteger(value.bytes) || value.bytes < 0
      || typeof value.base64 !== 'string') fail(`${label} is malformed`);
  const buffer = Buffer.from(value.base64, 'base64');
  if (buffer.toString('base64') !== value.base64 || buffer.length !== value.bytes
      || sha256(buffer) !== value.sha256) fail(`${label} does not match its encoded bytes`);
  return { ...value, buffer };
}

const FILESYSTEM_IDENTITY_KEYS = Object.freeze([
  'dev', 'ino', 'uid', 'nlink', 'size', 'mode', 'mtime_ns', 'ctime_ns',
]);

function filesystemIdentity(identity) {
  const receipt = {
    dev: String(identity.dev),
    ino: String(identity.ino),
    uid: String(identity.uid),
    nlink: String(identity.nlink),
    size: String(identity.size),
    mode: String(identity.mode),
    mtime_ns: String(identity.mtimeNs),
    ctime_ns: String(identity.ctimeNs),
  };
  return { receipt, identity };
}

function decodeFilesystemIdentity(value, label) {
  exactKeys(value, FILESYSTEM_IDENTITY_KEYS, label);
  if (FILESYSTEM_IDENTITY_KEYS.some((key) => !/^(?:0|[1-9]\d*)$/u.test(value[key]))) {
    fail(`${label} is malformed`);
  }
  return {
    receipt: value,
    identity: {
      dev: BigInt(value.dev),
      ino: BigInt(value.ino),
      uid: BigInt(value.uid),
      nlink: BigInt(value.nlink),
      size: BigInt(value.size),
      mode: BigInt(value.mode),
      mtimeNs: BigInt(value.mtime_ns),
      ctimeNs: BigInt(value.ctime_ns),
    },
  };
}

function filesystemDocument(value) {
  return value.receipt;
}

function sameOwnedInode(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs;
}

function transactionOutputDocument(output) {
  return {
    path: output.path,
    mode: output.mode,
    changed: output.changed,
    after_temporary_path: output.after_temporary_path,
    rollback_temporary_path: output.rollback_temporary_path,
    before: bytesDocument(output.before),
    after: bytesDocument(output.after),
    progress: {
      before_target_identity: filesystemDocument(output.progress.before_target_identity),
      after_staged_identity: output.progress.after_staged_identity
        ? filesystemDocument(output.progress.after_staged_identity) : null,
      rollback_staged_identity: output.progress.rollback_staged_identity
        ? filesystemDocument(output.progress.rollback_staged_identity) : null,
    },
  };
}

function transactionDocument(transaction) {
  return {
    schema_version: transaction.schema_version,
    artifact_kind: transaction.artifact_kind,
    transaction_id: transaction.transaction_id,
    owner_pid: transaction.owner_pid,
    state: transaction.state,
    outputs: {
      manifest: transactionOutputDocument(transaction.outputs.manifest),
      source_registry: transactionOutputDocument(transaction.outputs.source_registry),
    },
  };
}

function transactionBytes(transaction) {
  return Buffer.from(`${JSON.stringify(transactionDocument(transaction))}\n`, 'utf8');
}

function transactionOutput(artifact, after, changed, ownerPid, transactionId) {
  return {
    path: artifact.path,
    mode: artifact.mode,
    changed,
    after_temporary_path: outputTemporaryPath(
      artifact.path, ownerPid, transactionId, 'after',
    ),
    rollback_temporary_path: outputTemporaryPath(
      artifact.path, ownerPid, transactionId, 'rollback',
    ),
    before: decodeBytesIdentity(bytesIdentity(artifact.buffer), `${artifact.path}.before`),
    after: decodeBytesIdentity(bytesIdentity(after), `${artifact.path}.after`),
    progress: {
      before_target_identity: filesystemIdentity(artifact.identity),
      after_staged_identity: null,
      rollback_staged_identity: null,
    },
  };
}

function buildTransaction(
  manifestArtifact,
  registryArtifact,
  manifestAfter,
  registryAfter,
  manifestChanged,
  registryChanged,
) {
  const transactionId = randomUUID();
  const ownerPid = process.pid;
  return {
    schema_version: 2,
    artifact_kind: 'zh_hs_2017_2020_research_corpus_rebind_transaction',
    transaction_id: transactionId,
    owner_pid: ownerPid,
    state: 'prepared',
    outputs: {
      manifest: transactionOutput(
        manifestArtifact, manifestAfter, manifestChanged, ownerPid, transactionId,
      ),
      source_registry: transactionOutput(
        registryArtifact, registryAfter, registryChanged, ownerPid, transactionId,
      ),
    },
  };
}

function validateTransactionOutput(value, expectedPath, ownerPid, transactionId, state, label) {
  exactKeys(value, [
    'path', 'mode', 'changed', 'after_temporary_path', 'rollback_temporary_path',
    'before', 'after', 'progress',
  ], label);
  if (value.path !== expectedPath
      || value.after_temporary_path !== outputTemporaryPath(
        expectedPath, ownerPid, transactionId, 'after',
      )
      || value.rollback_temporary_path !== outputTemporaryPath(
        expectedPath, ownerPid, transactionId, 'rollback',
      )
      || typeof value.changed !== 'boolean'
      || !Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o777) {
    fail(`${label} target identity is invalid`);
  }
  exactKeys(value.progress, [
    'before_target_identity', 'after_staged_identity', 'rollback_staged_identity',
  ], `${label}.progress`);
  const before = decodeBytesIdentity(value.before, `${label}.before`);
  const after = decodeBytesIdentity(value.after, `${label}.after`);
  const beforeTarget = decodeFilesystemIdentity(
    value.progress.before_target_identity, `${label}.progress.before_target_identity`,
  );
  const afterStaged = value.progress.after_staged_identity === null ? null
    : decodeFilesystemIdentity(
      value.progress.after_staged_identity, `${label}.progress.after_staged_identity`,
    );
  const rollbackStaged = value.progress.rollback_staged_identity === null ? null
    : decodeFilesystemIdentity(
      value.progress.rollback_staged_identity, `${label}.progress.rollback_staged_identity`,
    );
  const stagedRequired = value.changed && state !== 'prepared';
  if ((stagedRequired && (!afterStaged || !rollbackStaged))
      || ((!stagedRequired || !value.changed) && (afterStaged || rollbackStaged))) {
    fail(`${label} staged identity receipts do not match ${state}`);
  }
  for (const [receipt, bytes, identityLabel] of [
    [beforeTarget, before, 'before target'],
    ...(afterStaged ? [[afterStaged, after, 'after staged']] : []),
    ...(rollbackStaged ? [[rollbackStaged, before, 'rollback staged']] : []),
  ]) {
    if (receipt.identity.nlink !== 1n
        || receipt.identity.size !== BigInt(bytes.bytes)
        || Number(receipt.identity.mode & 0o777n) !== value.mode
        || (typeof process.getuid === 'function'
          && receipt.identity.uid !== BigInt(process.getuid()))) {
      fail(`${label} ${identityLabel} receipt is inconsistent`);
    }
  }
  return {
    ...value,
    before,
    after,
    progress: {
      before_target_identity: beforeTarget,
      after_staged_identity: afterStaged,
      rollback_staged_identity: rollbackStaged,
    },
  };
}

function validateTransaction(value) {
  exactKeys(value, [
    'schema_version', 'artifact_kind', 'transaction_id', 'owner_pid', 'state', 'outputs',
  ], 'transaction journal');
  if (value.schema_version !== 2
      || value.artifact_kind !== 'zh_hs_2017_2020_research_corpus_rebind_transaction'
      || !canonicalUuid(value.transaction_id)
      || !Number.isSafeInteger(value.owner_pid) || value.owner_pid < 1
      || !['prepared', 'staged', 'validated'].includes(value.state)) {
    fail('transaction journal identity or state is invalid');
  }
  exactKeys(value.outputs, ['manifest', 'source_registry'], 'transaction outputs');
  return {
    ...value,
    outputs: {
      manifest: validateTransactionOutput(
        value.outputs.manifest, MANIFEST_PATH, value.owner_pid, value.transaction_id,
        value.state, 'transaction manifest',
      ),
      source_registry: validateTransactionOutput(
        value.outputs.source_registry, SOURCE_REGISTRY_PATH, value.owner_pid,
        value.transaction_id, value.state, 'transaction source registry',
      ),
    },
  };
}

async function readTransaction(projectRoot) {
  try {
    const artifact = await readStableProjectFile(
      projectRoot,
      TRANSACTION_PATH,
      'transaction journal',
      { allowedNlinks: [1n, 2n] },
    );
    if (artifact.mode !== 0o600) fail('transaction journal must be owner-only');
    const raw = parseJson(artifact, 'transaction journal');
    const transaction = validateTransaction(raw);
    if (!sameBytes(artifact.buffer, transactionBytes(transaction))) {
      fail('transaction journal bytes are not canonical');
    }
    let linkedTemporary = null;
    if (artifact.identity.nlink === 2n) {
      if (transaction.state !== 'prepared') {
        fail('only a prepared journal may retain its no-replace hard-link temporary');
      }
      const relativePath = journalTemporaryPath(
        transaction.owner_pid, transaction.transaction_id, 'journal',
      );
      const temporary = await readStableProjectFile(
        projectRoot,
        relativePath,
        'linked transaction journal temporary',
        { allowedNlinks: [2n] },
      );
      if (temporary.mode !== 0o600
          || !sameIdentity(temporary.identity, artifact.identity)
          || !sameBytes(temporary.buffer, artifact.buffer)) {
        fail('transaction journal nlink=2 pair is not the exact canonical same-inode pair');
      }
      linkedTemporary = { relativePath, artifact: temporary };
    }
    return { artifact, transaction, linkedTemporary };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readOptionalProjectFile(projectRoot, relativePath, label, options = {}) {
  try {
    return await readStableProjectFile(projectRoot, relativePath, label, options);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function unlinkExactArtifact(artifact, label) {
  const current = await readStableAbsoluteFile(
    artifact.absolute,
    label,
    { allowedNlinks: [artifact.identity.nlink] },
  );
  if (!sameIdentity(current.identity, artifact.identity)
      || !sameBytes(current.buffer, artifact.buffer)) {
    fail(`${label} changed before unlink`);
  }
  await unlink(artifact.absolute);
  await syncDirectory(dirname(artifact.absolute));
}

async function normalizeTransactionJournalLink(projectRoot, pending) {
  if (!pending?.linkedTemporary) return pending;
  await unlinkExactArtifact(
    pending.linkedTemporary.artifact,
    'linked transaction journal temporary',
  );
  const normalized = await readTransaction(projectRoot);
  if (!normalized || normalized.linkedTemporary
      || normalized.transaction.transaction_id !== pending.transaction.transaction_id
      || normalized.artifact.identity.nlink !== 1n) {
    fail('transaction journal hard-link pair did not normalize safely');
  }
  return normalized;
}

async function orphanJournalTemporaries(projectRoot) {
  const directory = resolve(projectRoot, 'data/research-evidence');
  const matches = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const match = entry.name.match(JOURNAL_TEMP_PATTERN);
    if (!match) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) {
      fail(`orphan journal temporary is unsafe: ${entry.name}`);
    }
    matches.push({
      path: join(directory, entry.name),
      phase: match[1],
      ownerPid: Number(match[2]),
      transactionId: match[3],
      name: entry.name,
    });
  }
  return matches;
}

async function expectedOrphanJournalBytes(projectRoot, entry, transaction) {
  if (entry.phase === 'journal') {
    if (transaction) fail(`unexpected journal temporary beside a durable transaction: ${entry.name}`);
    return {
      buffer: Buffer.from(
        `{"schema_version":2,"artifact_kind":"zh_hs_2017_2020_research_corpus_rebind_transaction","transaction_id":"${entry.transactionId}","owner_pid":${entry.ownerPid},`,
        'utf8',
      ),
      headerOnly: true,
    };
  }
  if (!transaction
      || transaction.owner_pid !== entry.ownerPid
      || transaction.transaction_id !== entry.transactionId) {
    fail(`orphan ${entry.phase} journal has no exact durable predecessor: ${entry.name}`);
  }
  if (entry.phase === 'validated') {
    if (transaction.state !== 'staged') {
      fail(`validated journal temporary has no staged predecessor: ${entry.name}`);
    }
    return {
      buffer: transactionBytes({ ...transaction, state: 'validated' }),
      headerOnly: false,
    };
  }
  if (transaction.state !== 'prepared') {
    fail(`staged journal temporary has no prepared predecessor: ${entry.name}`);
  }
  const staged = {
    ...transaction,
    state: 'staged',
    outputs: Object.fromEntries(await Promise.all(
      Object.entries(transaction.outputs).map(async ([key, output]) => {
        if (!output.changed) return [key, output];
        const after = await readStableProjectFile(
          projectRoot,
          output.after_temporary_path,
          `${output.path} recoverable staged after-image`,
        );
        const rollback = await readStableProjectFile(
          projectRoot,
          output.rollback_temporary_path,
          `${output.path} recoverable staged rollback image`,
        );
        if (after.mode !== output.mode || rollback.mode !== output.mode
            || !sameBytes(after.buffer, output.after.buffer)
            || !sameBytes(rollback.buffer, output.before.buffer)) {
          fail(`${output.path} staged receipts cannot be reconstructed safely`);
        }
        return [key, {
          ...output,
          progress: {
            ...output.progress,
            after_staged_identity: filesystemIdentity(after.identity),
            rollback_staged_identity: filesystemIdentity(rollback.identity),
          },
        }];
      }),
    )),
  };
  return { buffer: transactionBytes(staged), headerOnly: false };
}

async function cleanupOrphanJournalTemporaries(projectRoot, {
  transaction = null,
} = {}) {
  for (const entry of await orphanJournalTemporaries(projectRoot)) {
    if (!Number.isSafeInteger(entry.ownerPid) || entry.ownerPid < 1
        || !canonicalUuid(entry.transactionId)) {
      fail(`transaction temporary filename identity is invalid: ${entry.name}`);
    }
    const artifact = await readStableAbsoluteFile(entry.path, `orphan ${entry.phase} journal`);
    if (artifact.mode !== 0o600) fail(`orphan journal temporary is not owner-only: ${entry.name}`);
    const expected = await expectedOrphanJournalBytes(projectRoot, entry, transaction);
    const comparedLength = Math.min(artifact.buffer.length, expected.buffer.length);
    if ((!expected.headerOnly && artifact.buffer.length > expected.buffer.length)
        || !sameBytes(
          artifact.buffer.subarray(0, comparedLength),
          expected.buffer.subarray(0, comparedLength),
        )) {
      fail(`orphan journal temporary is not an attributable ${entry.phase} prefix`);
    }
    await unlinkExactArtifact(artifact, `orphan ${entry.phase} journal`);
  }
}

async function stageExactFile(absolutePath, buffer, mode, label, afterSync = null) {
  let handle = null;
  try {
    handle = await open(absolutePath, 'wx', mode);
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    const artifact = await readStableAbsoluteFile(absolutePath, label);
    if (artifact.mode !== mode || !sameBytes(artifact.buffer, buffer)) {
      fail(`${label} differs immediately after staging`);
    }
    await afterSync?.();
    return artifact;
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

async function removeOwnedTemporary(projectRoot, relativePath, expectedBytes, expectedIdentity, label) {
  safeRelativePath(relativePath, label);
  const artifact = await readOptionalProjectFile(projectRoot, relativePath, label);
  if (!artifact) return;
  if (expectedIdentity) {
    if (!sameIdentity(artifact.identity, expectedIdentity.identity)
        || !sameBytes(artifact.buffer, expectedBytes.buffer)) {
      fail(`${label} contains unowned or third-party bytes`);
    }
  } else if (artifact.buffer.length > expectedBytes.buffer.length
      || !sameBytes(
        artifact.buffer,
        expectedBytes.buffer.subarray(0, artifact.buffer.length),
      )) {
    fail(`${label} is not an attributable staged prefix`);
  }
  await unlinkExactArtifact(artifact, label);
}

async function cleanupTransactionTemporaries(projectRoot, transaction) {
  for (const output of Object.values(transaction.outputs)) {
    await removeOwnedTemporary(
      projectRoot,
      output.after_temporary_path,
      output.after,
      output.progress.after_staged_identity,
      `${output.path} after-image temporary`,
    );
    await removeOwnedTemporary(
      projectRoot,
      output.rollback_temporary_path,
      output.before,
      output.progress.rollback_staged_identity,
      `${output.path} rollback temporary`,
    );
  }
}

async function writeAtomic(artifact, buffer, temporary, afterTemporarySync = null) {
  if (dirname(temporary) !== dirname(artifact.absolute) || temporary === artifact.absolute) {
    fail(`temporary path is outside the governed output directory: ${artifact.path}`);
  }
  let staged = null;
  try {
    staged = await stageExactFile(
      temporary, buffer, artifact.mode, `${artifact.path} atomic temporary`, afterTemporarySync,
    );
    const currentTarget = await readStableAbsoluteFile(artifact.absolute, artifact.path);
    const currentTemporary = await readStableAbsoluteFile(temporary, `${artifact.path} atomic temporary`);
    if (!sameIdentity(currentTarget.identity, artifact.identity)
        || !sameBytes(currentTarget.buffer, artifact.buffer)
        || currentTarget.mode !== artifact.mode
        || !sameIdentity(currentTemporary.identity, staged.identity)
        || !sameBytes(currentTemporary.buffer, staged.buffer)) {
      fail(`${artifact.path} target or temporary identity changed before atomic rename`);
    }
    await rename(temporary, artifact.absolute);
    await syncDirectory(dirname(artifact.absolute));
    const written = await readStableAbsoluteFile(artifact.absolute, artifact.path);
    if (!sameOwnedInode(written.identity, staged.identity)
        || !sameBytes(written.buffer, buffer) || written.mode !== artifact.mode) {
      fail(`${artifact.path} rename did not preserve the staged inode and bytes`);
    }
    return written;
  } catch (error) {
    if (staged) {
      const current = await readOptionalProjectFile(
        dirname(staged.absolute), basename(staged.absolute), `${artifact.path} failed atomic temporary`,
      ).catch(() => null);
      if (current && sameIdentity(current.identity, staged.identity)
          && sameBytes(current.buffer, staged.buffer)) {
        await unlinkExactArtifact(current, `${artifact.path} failed atomic temporary`).catch(() => {});
      }
    }
    throw error;
  }
}

async function writeJournalNoReplace(
  projectRoot,
  transaction,
  afterTemporarySync = null,
  afterLink = null,
) {
  if (await readTransaction(projectRoot)) fail('another research rebind transaction already exists');
  const absolute = resolve(projectRoot, TRANSACTION_PATH);
  const relativeTemporary = journalTemporaryPath(
    transaction.owner_pid, transaction.transaction_id, 'journal',
  );
  const temporary = resolve(projectRoot, relativeTemporary);
  let staged = null;
  let linked = false;
  try {
    staged = await stageExactFile(
      temporary,
      transactionBytes(transaction),
      0o600,
      'prepared transaction journal temporary',
      afterTemporarySync,
    );
    await link(temporary, absolute);
    linked = true;
    const linkedTemporary = await readStableAbsoluteFile(
      temporary, 'linked prepared journal temporary', { allowedNlinks: [2n] },
    );
    const linkedJournal = await readStableAbsoluteFile(
      absolute, 'linked prepared journal', { allowedNlinks: [2n] },
    );
    if (!sameIdentity(linkedTemporary.identity, linkedJournal.identity)
        || !sameOwnedInode(linkedTemporary.identity, staged.identity)
        || !sameBytes(linkedTemporary.buffer, transactionBytes(transaction))) {
      fail('prepared journal no-replace link is not the exact same-inode canonical pair');
    }
    await afterLink?.();
    await unlink(temporary);
    await syncDirectory(dirname(absolute));
  } catch (error) {
    if (!linked && staged) {
      await unlinkExactArtifact(staged, 'failed prepared journal temporary').catch(() => {});
    }
    throw error;
  }
  const written = await readTransaction(projectRoot);
  if (!written || written.linkedTemporary
      || written.transaction.transaction_id !== transaction.transaction_id) {
    fail('prepared transaction journal was not durably normalized');
  }
  return written;
}

async function stageTransactionOutputs(projectRoot, transaction, testHooks) {
  for (const [key, output] of Object.entries(transaction.outputs)) {
    if (!output.changed) continue;
    const after = await stageExactFile(
      resolve(projectRoot, output.after_temporary_path),
      output.after.buffer,
      output.mode,
      `${output.path} staged after-image`,
    );
    const rollback = await stageExactFile(
      resolve(projectRoot, output.rollback_temporary_path),
      output.before.buffer,
      output.mode,
      `${output.path} staged rollback image`,
    );
    output.progress.after_staged_identity = filesystemIdentity(after.identity);
    output.progress.rollback_staged_identity = filesystemIdentity(rollback.identity);
    if (key === 'manifest') await testHooks?.afterManifestTemporarySync();
  }
  transaction.state = 'staged';
  return transaction;
}

async function markTransactionState(
  projectRoot,
  transaction,
  expectedState,
  nextState,
  afterTemporarySync = null,
) {
  const pending = await readTransaction(projectRoot);
  if (!pending || pending.linkedTemporary
      || pending.transaction.transaction_id !== transaction.transaction_id
      || pending.transaction.state !== expectedState) {
    fail(`${expectedState} transaction changed before ${nextState} commit`);
  }
  const next = { ...transaction, state: nextState };
  await writeAtomic(
    pending.artifact,
    transactionBytes(next),
    resolve(projectRoot, journalTemporaryPath(
      transaction.owner_pid, transaction.transaction_id, nextState,
    )),
    afterTemporarySync,
  );
  transaction.state = nextState;
  const written = await readTransaction(projectRoot);
  if (!written || written.transaction.transaction_id !== transaction.transaction_id
      || written.transaction.state !== nextState) {
    fail(`transaction journal did not enter ${nextState}`);
  }
  return written;
}

function classifyTarget(artifact, output) {
  if (sameIdentity(artifact.identity, output.progress.before_target_identity.identity)
      && sameBytes(artifact.buffer, output.before.buffer)) return 'before';
  if (output.progress.after_staged_identity
      && sameOwnedInode(artifact.identity, output.progress.after_staged_identity.identity)
      && sameBytes(artifact.buffer, output.after.buffer)) return 'after_owned';
  if (output.progress.rollback_staged_identity
      && sameOwnedInode(artifact.identity, output.progress.rollback_staged_identity.identity)
      && sameBytes(artifact.buffer, output.before.buffer)) return 'rollback_owned';
  return 'third_party';
}

async function commitStagedOutput(projectRoot, output) {
  if (!output.changed) return;
  const target = await readStableProjectFile(projectRoot, output.path, output.path);
  const staged = await readStableProjectFile(
    projectRoot, output.after_temporary_path, `${output.path} staged after-image`,
  );
  if (classifyTarget(target, output) !== 'before'
      || !sameIdentity(staged.identity, output.progress.after_staged_identity.identity)
      || !sameBytes(staged.buffer, output.after.buffer)) {
    fail(`${output.path} target or staged after-image changed before governed rename`);
  }
  await rename(staged.absolute, target.absolute);
  await syncDirectory(dirname(target.absolute));
  const written = await readStableProjectFile(projectRoot, output.path, output.path);
  if (classifyTarget(written, output) !== 'after_owned') {
    fail(`${output.path} governed rename did not preserve its staged inode`);
  }
}

function assertCommittedOutput(artifact, output) {
  const expected = output.changed ? 'after_owned' : 'before';
  if (classifyTarget(artifact, output) !== expected) {
    fail(`${output.path} final inode topology differs from its transaction receipt`);
  }
}

async function removeJournal(artifact) {
  await unlinkExactArtifact(artifact, 'transaction journal');
}

async function recoverTransaction(projectRoot, {
  expectedId = null,
  testHooks = null,
} = {}) {
  let pending = await readTransaction(projectRoot);
  if (!pending) return null;
  if (pending.linkedTemporary) pending = await normalizeTransactionJournalLink(projectRoot, pending);
  const { artifact: journalArtifact, transaction } = pending;
  if (expectedId !== null && transaction.transaction_id !== expectedId) {
    fail('transaction journal belongs to another invocation');
  }
  const targets = [];
  for (const output of Object.values(transaction.outputs)) {
    const artifact = await readStableProjectFile(projectRoot, output.path, `recovery ${output.path}`);
    const classification = classifyTarget(artifact, output);
    if (classification === 'third_party'
        || (!output.changed && classification !== 'before')
        || (transaction.state === 'prepared' && classification !== 'before')
        || (transaction.state === 'validated' && classification !== 'after_owned')) {
      fail(`${output.path} has an unowned identity or third-party bytes during recovery`);
    }
    targets.push({ artifact, output, classification });
  }
  if (transaction.state === 'validated') {
    await cleanupOrphanJournalTemporaries(projectRoot, {
      transaction,
    });
    await cleanupTransactionTemporaries(projectRoot, transaction);
    await removeJournal(journalArtifact);
    return 'completed_validated_transaction';
  }
  if (transaction.state === 'staged') {
    for (const target of targets) {
      if (target.classification !== 'after_owned') continue;
      const rollback = await readStableProjectFile(
        projectRoot,
        target.output.rollback_temporary_path,
        `${target.output.path} staged rollback image`,
      );
      if (!sameIdentity(
        rollback.identity, target.output.progress.rollback_staged_identity.identity,
      ) || !sameBytes(rollback.buffer, target.output.before.buffer)) {
        fail(`${target.output.path} rollback image is not the exact staged inode`);
      }
    }
    for (const target of targets) {
      if (target.classification !== 'after_owned') continue;
      const rollback = await readStableProjectFile(
        projectRoot,
        target.output.rollback_temporary_path,
        `${target.output.path} staged rollback image`,
      );
      await rename(rollback.absolute, target.artifact.absolute);
      await syncDirectory(dirname(target.artifact.absolute));
      await testHooks?.afterRecoveryOutputRollback();
    }
    for (const output of Object.values(transaction.outputs)) {
      const restored = await readStableProjectFile(
        projectRoot, output.path, `restored ${output.path}`,
      );
      const classification = classifyTarget(restored, output);
      if (!['before', 'rollback_owned'].includes(classification)
          || !sameBytes(restored.buffer, output.before.buffer)) {
        fail(`${output.path} rollback did not restore transaction-owned before bytes`);
      }
    }
  }
  await cleanupOrphanJournalTemporaries(projectRoot, {
    transaction,
  });
  await cleanupTransactionTemporaries(projectRoot, transaction);
  const currentJournal = await readTransaction(projectRoot);
  if (!currentJournal
      || currentJournal.transaction.transaction_id !== transaction.transaction_id) {
    fail('transaction journal changed during recovery');
  }
  await removeJournal(currentJournal.artifact);
  return transaction.state === 'staged'
    ? 'rolled_back_staged_transaction'
    : 'rolled_back_prepared_transaction';
}

async function advisoryLockPath(projectRoot) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const base = process.platform === 'darwin' ? '/private/tmp' : '/tmp';
  const directory = join(base, `curriculum-atlas-research-locks-${uid}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()
      || (typeof process.getuid === 'function' && info.uid !== BigInt(uid))
      || (info.mode & 0o077n) !== 0n) {
    fail('advisory lock directory must be an owner-only real directory');
  }
  return join(directory, `${sha256(projectRoot)}.lock`);
}

function advisoryLockCommand(lockPath) {
  if (process.platform === 'darwin') {
    return {
      executable: '/usr/bin/lockf',
      args: ['-k', '-t', '0', lockPath, '/usr/bin/tee'],
    };
  }
  if (process.platform === 'linux') {
    return {
      executable: '/usr/bin/flock',
      args: ['--exclusive', '--nonblock', lockPath, '/usr/bin/tee'],
    };
  }
  fail(`unsupported advisory lock platform: ${process.platform}`);
}

async function acquireAdvisoryLock(projectRoot, testHooks) {
  const lockPath = await advisoryLockPath(projectRoot);
  const command = advisoryLockCommand(lockPath);
  const child = spawn(command.executable, command.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const acquired = await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error('advisory lock helper did not become ready'));
    }, 5_000);
    const reject = (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    };
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(
        `research rebind advisory lock is held by another process (exit=${code} signal=${signal || 'none'} stderr=${stderr.slice(0, 512)})`,
      ));
    });
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-64);
      if (stdout === 'LOCKED\n') {
        clearTimeout(timeout);
        child.removeListener('error', reject);
        child.removeAllListeners('exit');
        resolvePromise({ child, lockPath, released: false });
      } else if (!'LOCKED\n'.startsWith(stdout)) {
        reject(new Error('advisory lock helper emitted an invalid readiness marker'));
      }
    });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8192); });
    child.stdin.write('LOCKED\n');
  });
  try {
    await testHooks?.afterAdvisoryLock();
    return acquired;
  } catch (error) {
    try {
      await releaseAdvisoryLock(acquired);
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        'research rebind advisory lock hook and release both failed',
      );
    }
    throw error;
  }
}

async function releaseAdvisoryLock(lock) {
  if (lock.released) return;
  lock.released = true;
  if (lock.child.exitCode !== null || lock.child.signalCode !== null) {
    fail('research rebind advisory lock helper exited before release');
  }
  const exit = new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      lock.child.kill('SIGKILL');
      rejectPromise(new Error('advisory lock helper did not exit after release'));
    }, 5_000);
    lock.child.once('error', (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    lock.child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 && signal === null) resolvePromise();
      else rejectPromise(new Error(`advisory lock helper release failed: code=${code} signal=${signal}`));
    });
  });
  lock.child.stdin.end();
  await exit;
}

async function assertDryRunRecoveryFree(projectRoot) {
  const [transaction, journalTemps] = await Promise.all([
    readTransaction(projectRoot),
    orphanJournalTemporaries(projectRoot),
  ]);
  if (transaction || journalTemps.length > 0) {
    fail('an interrupted transaction requires --apply recovery; dry-run never mutates recovery state');
  }
}

export async function rebindResearchEvidenceCorpus({
  root = DEFAULT_ROOT,
  resourceMap = process.env.CURRICULUM_RESEARCH_EVIDENCE_RESOURCE_MAP || null,
  apply = false,
  testHooks = null,
  renderPageImage = renderPinnedPage,
} = {}) {
  if (apply !== true && apply !== false) fail('apply must be a boolean');
  const projectRoot = await realpath(resolve(root));
  if (testHooks !== null) {
    exactKeys(testHooks, [
      'afterAdvisoryLock', 'afterJournalTemporarySync',
      'afterManifestTemporarySync', 'afterManifestWrite', 'afterOutputsCommitted',
      'afterRecoveryOutputRollback',
      'afterStagedJournalTemporarySync', 'afterTransactionStaged',
      'afterValidatedJournalTemporarySync', 'afterTransactionValidated', 'validateCandidate',
    ], 'testHooks');
    if (Object.values(testHooks).some((callback) => typeof callback !== 'function')) {
      fail('all testHooks values must be functions');
    }
    if (projectRoot === await realpath(DEFAULT_ROOT)) fail('testHooks are forbidden on the real project root');
  }
  if (typeof renderPageImage !== 'function') fail('renderPageImage must be a function');
  if (renderPageImage !== renderPinnedPage && projectRoot === await realpath(DEFAULT_ROOT)) {
    fail('the production page renderer cannot be overridden on the real project root');
  }
  if (ACTIVE_ROOTS.has(projectRoot)) fail('another research evidence rebind is active for this root');
  ACTIVE_ROOTS.add(projectRoot);
  let corpus = null;
  let advisoryLock = null;
  let bodyError = null;
  try {
    advisoryLock = await acquireAdvisoryLock(projectRoot, testHooks);
    let recoveredTransaction = null;
    if (apply) {
      const pending = await readTransaction(projectRoot);
      if (pending) {
        recoveredTransaction = await recoverTransaction(projectRoot, { testHooks });
      } else {
        await cleanupOrphanJournalTemporaries(projectRoot);
      }
    } else {
      await assertDryRunRecoveryFree(projectRoot);
    }

    const manifestArtifact = await readStableProjectFile(projectRoot, MANIFEST_PATH, 'research manifest');
    const registryArtifact = await readStableProjectFile(projectRoot, SOURCE_REGISTRY_PATH, 'source registry');
    const schemaArtifact = await readStableProjectFile(projectRoot, SCHEMA_PATH, 'research evidence schema');
    const manifest = parseJson(manifestArtifact, 'research manifest');
    const sourceRegistry = parseJson(registryArtifact, 'source registry');
    const schema = parseJson(schemaArtifact, 'research evidence schema');
    assertFailClosed(manifest);

    corpus = await materializeCorpus(projectRoot);
    corpus.manifest.__raw_sha256 = corpus.manifestArtifact.sha256;
    const resources = await loadResourceMap(resourceMap, manifest);
    const located = locateEvidence(corpus.database, manifest, corpus.manifest);
    delete corpus.manifest.__raw_sha256;
    assertOnlyAllowedManifestChanges(manifest, located.candidate);
    const computedRegistry = buildResearchSourceRegistry(located.candidate, corpus.database);
    if (JSON.stringify(registryInvariantProjection(computedRegistry))
        !== JSON.stringify(registryInvariantProjection(sourceRegistry))) {
      fail('current corpus would change the Git-pinned research source scope or contracts');
    }
    const candidateManifestBuffer = patchResearchManifestBytes(manifestArtifact, located.candidate);
    const candidateManifest = JSON.parse(candidateManifestBuffer.toString('utf8'));
    assertOnlyAllowedManifestChanges(manifest, candidateManifest);
    const candidateRegistryBuffer = patchRegistryBytes(
      registryArtifact, computedRegistry.research_corpus_rowset_sha256,
    );
    const candidateRegistry = JSON.parse(candidateRegistryBuffer.toString('utf8'));
    if (JSON.stringify(candidateRegistry) !== JSON.stringify(computedRegistry)) {
      fail('byte-preserving source registry patch differs from the computed registry');
    }
    const candidateValidator = testHooks?.validateCandidate || validateCandidate;
    const validation = candidateValidator({
      manifest: candidateManifest,
      schema,
      sourceRegistry: candidateRegistry,
      corpus,
      resources,
      renderPageImage,
    });
    await assertInputsUnchanged(projectRoot, corpus, resources, schemaArtifact);
    await assertArtifactUnchanged(manifestArtifact, MANIFEST_PATH);
    await assertArtifactUnchanged(registryArtifact, SOURCE_REGISTRY_PATH);

    const manifestChanged = !sameBytes(manifestArtifact.buffer, candidateManifestBuffer);
    const registryChanged = !sameBytes(registryArtifact.buffer, candidateRegistryBuffer);
    const result = {
      mode: apply ? 'apply' : 'dry-run',
      changed: manifestChanged || registryChanged,
      recovered_transaction: recoveredTransaction,
      corpus: {
        release_id: candidateManifest.corpus.release_id,
        release_fingerprint_sha256: candidateManifest.corpus.release_fingerprint_sha256,
        manifest_sha256: candidateManifest.corpus.manifest_sha256,
        manifest_internal_sha256: corpus.manifest.manifest_sha256,
        documents: corpus.manifest.documents,
        paragraphs: corpus.manifest.paragraphs,
        sql_chunks: corpus.manifest.sql_files.length,
        text_assets: corpus.manifest.text_assets.length,
      },
      outputs: {
        manifest: {
          path: MANIFEST_PATH,
          before_sha256: manifestArtifact.sha256,
          after_sha256: sha256(candidateManifestBuffer),
          changed: manifestChanged,
        },
        source_registry: {
          path: SOURCE_REGISTRY_PATH,
          before_sha256: registryArtifact.sha256,
          after_sha256: sha256(candidateRegistryBuffer),
          changed: registryChanged,
          research_corpus_rowset_sha256: candidateRegistry.research_corpus_rowset_sha256,
        },
      },
      evidence_mappings: located.mappings,
      publication: {
        evidence_integrity_valid: validation.validation.evidence_integrity_valid,
        strict_publication_exit: 3,
        assertions: validation.validation.assertions.map((entry) => ({
          assertion_id: entry.assertion_id,
          publication_eligible: entry.publication_eligible,
          blockers: entry.blockers,
        })),
      },
    };
    if (!apply || (!manifestChanged && !registryChanged)) return result;

    const transaction = buildTransaction(
      manifestArtifact, registryArtifact, candidateManifestBuffer, candidateRegistryBuffer,
      manifestChanged, registryChanged,
    );
    let transactionWritten = false;
    try {
      try {
        await writeJournalNoReplace(
          projectRoot, transaction, testHooks?.afterJournalTemporarySync,
        );
        transactionWritten = true;
      } catch (error) {
        const journal = await readTransaction(projectRoot);
        if (journal?.transaction.transaction_id === transaction.transaction_id) transactionWritten = true;
        throw error;
      }
      await stageTransactionOutputs(projectRoot, transaction, testHooks);
      await markTransactionState(
        projectRoot,
        transaction,
        'prepared',
        'staged',
        testHooks?.afterStagedJournalTemporarySync,
      );
      await testHooks?.afterTransactionStaged();
      await commitStagedOutput(projectRoot, transaction.outputs.manifest);
      await testHooks?.afterManifestWrite();
      await commitStagedOutput(projectRoot, transaction.outputs.source_registry);
      await testHooks?.afterOutputsCommitted();
      const writtenManifest = await readStableProjectFile(projectRoot, MANIFEST_PATH, 'written research manifest');
      const writtenRegistry = await readStableProjectFile(projectRoot, SOURCE_REGISTRY_PATH, 'written source registry');
      if (!sameBytes(writtenManifest.buffer, candidateManifestBuffer)
          || !sameBytes(writtenRegistry.buffer, candidateRegistryBuffer)) {
        fail('governed outputs do not match both exact candidate after-images');
      }
      assertCommittedOutput(writtenManifest, transaction.outputs.manifest);
      assertCommittedOutput(writtenRegistry, transaction.outputs.source_registry);
      await assertInputsUnchanged(projectRoot, corpus, resources, schemaArtifact);
      candidateValidator({
        manifest: JSON.parse(writtenManifest.buffer.toString('utf8')),
        schema,
        sourceRegistry: JSON.parse(writtenRegistry.buffer.toString('utf8')),
        corpus,
        resources,
        renderPageImage,
      });
      const validatedJournal = await markTransactionState(
        projectRoot,
        transaction,
        'staged',
        'validated',
        testHooks?.afterValidatedJournalTemporarySync,
      );
      await testHooks?.afterTransactionValidated();
      await cleanupTransactionTemporaries(projectRoot, transaction);
      await cleanupOrphanJournalTemporaries(projectRoot, {
        transaction,
      });
      await removeJournal(validatedJournal.artifact);
      return result;
    } catch (error) {
      if (transactionWritten) {
        try {
          await recoverTransaction(projectRoot, {
            expectedId: transaction.transaction_id,
            testHooks,
          });
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'research evidence corpus rebind failed and rollback also failed',
          );
        }
      }
      throw error;
    }
  } catch (error) {
    bodyError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    try {
      await corpus?.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (advisoryLock) {
      try {
        await releaseAdvisoryLock(advisoryLock);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    ACTIVE_ROOTS.delete(projectRoot);
    if (cleanupErrors.length > 0) {
      if (bodyError) {
        throw new AggregateError(
          [bodyError, ...cleanupErrors],
          'research evidence corpus rebind failed and advisory lock cleanup also failed',
        );
      }
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      throw new AggregateError(cleanupErrors, 'research evidence corpus rebind cleanup failed');
    }
  }
}

export function parseArgs(argv) {
  const options = {
    root: DEFAULT_ROOT,
    resourceMap: process.env.CURRICULUM_RESEARCH_EVIDENCE_RESOURCE_MAP || null,
    apply: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      options.apply = true;
      continue;
    }
    if (!['--root', '--resource-map'].includes(argument)) fail(`unexpected argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`${argument} requires a path`);
    if (argument === '--root') options.root = value;
    else options.resourceMap = value;
    index += 1;
  }
  if (!options.resourceMap) fail('--resource-map or CURRICULUM_RESEARCH_EVIDENCE_RESOURCE_MAP is required');
  return options;
}

async function main() {
  const result = await rebindResearchEvidenceCorpus(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
