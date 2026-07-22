#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
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
  stat,
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
const JOURNAL_TEMP_PATTERN = /^\.zh-hs-2017-2020-corpus-rebind-(?:journal|validated)-(\d+)-([a-f0-9-]{36})\.tmp$/u;
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

async function readStableAbsoluteFile(absolutePath, label) {
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
    if (before.nlink !== 1n) fail(`${label} must have exactly one hard link`);
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

async function readStableProjectFile(root, relativePath, label = relativePath) {
  safeRelativePath(relativePath, label);
  const projectRoot = await realpath(root);
  const absolute = resolve(projectRoot, relativePath);
  contained(projectRoot, absolute, label);
  await assertNoProjectSymlink(projectRoot, relativePath, label);
  const resolved = await realpath(absolute);
  contained(projectRoot, resolved, label);
  const artifact = await readStableAbsoluteFile(resolved, label);
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

function outputTemporaryPath(path, ownerPid, transactionId) {
  return join(dirname(path), `.${basename(path)}.corpus-rebind-${ownerPid}-${transactionId}.tmp`)
    .replaceAll('\\', '/');
}

function journalTemporaryPath(ownerPid, transactionId, phase) {
  return `data/research-evidence/.zh-hs-2017-2020-corpus-rebind-${phase}-${ownerPid}-${transactionId}.tmp`;
}

function bytesIdentity(buffer) {
  return { sha256: sha256(buffer), bytes: buffer.length, base64: buffer.toString('base64') };
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

function transactionOutput(artifact, after, ownerPid, transactionId) {
  return {
    path: artifact.path,
    mode: artifact.mode,
    temporary_path: outputTemporaryPath(artifact.path, ownerPid, transactionId),
    before: bytesIdentity(artifact.buffer),
    after: bytesIdentity(after),
  };
}

function buildTransaction(manifestArtifact, registryArtifact, manifestAfter, registryAfter) {
  const transactionId = randomUUID();
  const ownerPid = process.pid;
  return {
    schema_version: 1,
    artifact_kind: 'zh_hs_2017_2020_research_corpus_rebind_transaction',
    transaction_id: transactionId,
    owner_pid: ownerPid,
    state: 'prepared',
    outputs: {
      manifest: transactionOutput(manifestArtifact, manifestAfter, ownerPid, transactionId),
      source_registry: transactionOutput(registryArtifact, registryAfter, ownerPid, transactionId),
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
    ...value,
    before: decodeBytesIdentity(value.before, `${label}.before`),
    after: decodeBytesIdentity(value.after, `${label}.after`),
  };
}

function validateTransaction(value) {
  exactKeys(value, [
    'schema_version', 'artifact_kind', 'transaction_id', 'owner_pid', 'state', 'outputs',
  ], 'transaction journal');
  if (value.schema_version !== 1
      || value.artifact_kind !== 'zh_hs_2017_2020_research_corpus_rebind_transaction'
      || !/^[a-f0-9-]{36}$/u.test(value.transaction_id)
      || !Number.isSafeInteger(value.owner_pid) || value.owner_pid < 1
      || !['prepared', 'validated'].includes(value.state)) {
    fail('transaction journal identity or state is invalid');
  }
  exactKeys(value.outputs, ['manifest', 'source_registry'], 'transaction outputs');
  return {
    ...value,
    outputs: {
      manifest: validateTransactionOutput(
        value.outputs.manifest, MANIFEST_PATH, value.owner_pid, value.transaction_id,
        'transaction manifest',
      ),
      source_registry: validateTransactionOutput(
        value.outputs.source_registry, SOURCE_REGISTRY_PATH, value.owner_pid, value.transaction_id,
        'transaction source registry',
      ),
    },
  };
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

async function readTransaction(projectRoot) {
  try {
    const artifact = await readStableProjectFile(projectRoot, TRANSACTION_PATH, 'transaction journal');
    if (artifact.mode !== 0o600) fail('transaction journal must be owner-only');
    return { artifact, transaction: validateTransaction(parseJson(artifact, 'transaction journal')) };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function removeKnownTemporary(projectRoot, relativePath) {
  safeRelativePath(relativePath, 'transaction temporary');
  const absolute = resolve(projectRoot, relativePath);
  contained(projectRoot, absolute, 'transaction temporary');
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile()) fail(`transaction temporary is unsafe: ${relativePath}`);
    await unlink(absolute);
    await syncDirectory(dirname(absolute));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function cleanupTransactionTemporaries(projectRoot, transaction) {
  for (const relativePath of [
    transaction.outputs.manifest.temporary_path,
    transaction.outputs.source_registry.temporary_path,
    journalTemporaryPath(transaction.owner_pid, transaction.transaction_id, 'journal'),
    journalTemporaryPath(transaction.owner_pid, transaction.transaction_id, 'validated'),
  ]) await removeKnownTemporary(projectRoot, relativePath);
}

async function orphanJournalTemporaries(projectRoot) {
  const directory = resolve(projectRoot, 'data/research-evidence');
  const matches = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const match = entry.name.match(JOURNAL_TEMP_PATTERN);
    if (!match) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) fail(`orphan journal temporary is unsafe: ${entry.name}`);
    matches.push({ path: join(directory, entry.name), ownerPid: Number(match[1]), name: entry.name });
  }
  return matches;
}

async function cleanupOrphanJournalTemporaries(projectRoot) {
  for (const entry of await orphanJournalTemporaries(projectRoot)) {
    if (!Number.isSafeInteger(entry.ownerPid) || entry.ownerPid < 1 || processIsAlive(entry.ownerPid)) {
      fail(`transaction initialization is still owned by a live process: ${entry.name}`);
    }
    const info = await stat(entry.path);
    if ((info.mode & 0o777) !== 0o600) fail(`orphan journal temporary is not owner-only: ${entry.name}`);
    await unlink(entry.path);
    await syncDirectory(dirname(entry.path));
  }
}

async function writeAtomic(artifact, buffer, temporary, afterTemporarySync = null) {
  if (dirname(temporary) !== dirname(artifact.absolute) || temporary === artifact.absolute) {
    fail(`temporary path is outside the governed output directory: ${artifact.path}`);
  }
  let handle = null;
  try {
    handle = await open(temporary, 'wx', artifact.mode);
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    await afterTemporarySync?.();
    const current = await readStableAbsoluteFile(artifact.absolute, artifact.path);
    if (!sameBytes(current.buffer, artifact.buffer) || current.mode !== artifact.mode) {
      fail(`${artifact.path} changed before its atomic rename`);
    }
    await rename(temporary, artifact.absolute);
    await syncDirectory(dirname(artifact.absolute));
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function writeJournalNoReplace(projectRoot, transaction, afterTemporarySync = null) {
  if (await readTransaction(projectRoot)) fail('another research rebind transaction already exists');
  const absolute = resolve(projectRoot, TRANSACTION_PATH);
  const temporary = resolve(projectRoot, journalTemporaryPath(
    transaction.owner_pid, transaction.transaction_id, 'journal',
  ));
  let handle = null;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(Buffer.from(`${JSON.stringify(transaction)}\n`, 'utf8'));
    await handle.sync();
    await handle.close();
    handle = null;
    await afterTemporarySync?.();
    await link(temporary, absolute);
    await unlink(temporary);
    await syncDirectory(dirname(absolute));
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return readStableProjectFile(projectRoot, TRANSACTION_PATH, 'written transaction journal');
}

async function markTransactionValidated(projectRoot, transaction) {
  const pending = await readTransaction(projectRoot);
  if (!pending || pending.transaction.transaction_id !== transaction.transaction_id
      || pending.transaction.state !== 'prepared') fail('prepared transaction changed before validation commit');
  const validated = { ...transaction, state: 'validated' };
  await writeAtomic(
    pending.artifact,
    Buffer.from(`${JSON.stringify(validated)}\n`, 'utf8'),
    resolve(projectRoot, journalTemporaryPath(
      transaction.owner_pid, transaction.transaction_id, 'validated',
    )),
  );
  return readStableProjectFile(projectRoot, TRANSACTION_PATH, 'validated transaction journal');
}

async function removeJournal(artifact) {
  await unlink(artifact.absolute);
  await syncDirectory(dirname(artifact.absolute));
}

async function recoverTransaction(projectRoot, { allowCurrentOwner = false, expectedId = null } = {}) {
  const pending = await readTransaction(projectRoot);
  if (!pending) return null;
  const { artifact: journalArtifact, transaction } = pending;
  if (expectedId !== null && transaction.transaction_id !== expectedId) {
    fail('transaction journal belongs to another invocation');
  }
  if (processIsAlive(transaction.owner_pid)
      && !(allowCurrentOwner && transaction.owner_pid === process.pid)) {
    fail(`transaction ${transaction.transaction_id} is still owned by a live process`);
  }
  await cleanupTransactionTemporaries(projectRoot, transaction);
  const manifestArtifact = await readStableProjectFile(projectRoot, MANIFEST_PATH, 'recovery manifest');
  const registryArtifact = await readStableProjectFile(projectRoot, SOURCE_REGISTRY_PATH, 'recovery source registry');
  const targets = [
    [manifestArtifact, transaction.outputs.manifest],
    [registryArtifact, transaction.outputs.source_registry],
  ];
  for (const [artifact, identity] of targets) {
    if (artifact.mode !== identity.mode
        || (!sameBytes(artifact.buffer, identity.before.buffer)
          && !sameBytes(artifact.buffer, identity.after.buffer))) {
      fail(`${identity.path} contains third-party bytes during transaction recovery`);
    }
  }
  if (transaction.state === 'validated') {
    if (!targets.every(([artifact, identity]) => sameBytes(artifact.buffer, identity.after.buffer))) {
      fail('validated transaction does not contain both exact after-images');
    }
    await removeJournal(journalArtifact);
    return 'completed_validated_transaction';
  }
  for (const [artifact, identity] of targets) {
    if (sameBytes(artifact.buffer, identity.after.buffer)) {
      await writeAtomic(
        artifact,
        identity.before.buffer,
        resolve(projectRoot, identity.temporary_path),
      );
    }
  }
  const restoredManifest = await readStableProjectFile(projectRoot, MANIFEST_PATH, 'restored manifest');
  const restoredRegistry = await readStableProjectFile(projectRoot, SOURCE_REGISTRY_PATH, 'restored registry');
  if (!sameBytes(restoredManifest.buffer, transaction.outputs.manifest.before.buffer)
      || !sameBytes(restoredRegistry.buffer, transaction.outputs.source_registry.before.buffer)) {
    fail('transaction rollback did not restore both exact before-images');
  }
  await removeJournal(journalArtifact);
  return 'rolled_back_prepared_transaction';
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
      'afterJournalTemporarySync', 'afterManifestTemporarySync', 'afterManifestWrite',
      'validateCandidate',
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
  try {
    const pending = await readTransaction(projectRoot);
    const orphans = await orphanJournalTemporaries(projectRoot);
    if (!apply && (pending || orphans.length > 0)) {
      fail('an interrupted transaction requires --apply recovery; dry-run never mutates recovery state');
    }
    let recoveredTransaction = null;
    if (apply) {
      await cleanupOrphanJournalTemporaries(projectRoot);
      recoveredTransaction = await recoverTransaction(projectRoot);
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
      if (manifestChanged) {
        await writeAtomic(
          manifestArtifact,
          candidateManifestBuffer,
          resolve(projectRoot, transaction.outputs.manifest.temporary_path),
          testHooks?.afterManifestTemporarySync,
        );
      }
      await testHooks?.afterManifestWrite();
      if (registryChanged) {
        await writeAtomic(
          registryArtifact,
          candidateRegistryBuffer,
          resolve(projectRoot, transaction.outputs.source_registry.temporary_path),
        );
      }
      const writtenManifest = await readStableProjectFile(projectRoot, MANIFEST_PATH, 'written research manifest');
      const writtenRegistry = await readStableProjectFile(projectRoot, SOURCE_REGISTRY_PATH, 'written source registry');
      if (!sameBytes(writtenManifest.buffer, candidateManifestBuffer)
          || !sameBytes(writtenRegistry.buffer, candidateRegistryBuffer)) {
        fail('governed outputs do not match both exact candidate after-images');
      }
      await assertInputsUnchanged(projectRoot, corpus, resources, schemaArtifact);
      candidateValidator({
        manifest: JSON.parse(writtenManifest.buffer.toString('utf8')),
        schema,
        sourceRegistry: JSON.parse(writtenRegistry.buffer.toString('utf8')),
        corpus,
        resources,
        renderPageImage,
      });
      const validatedJournal = await markTransactionValidated(projectRoot, transaction);
      await removeJournal(validatedJournal);
      return result;
    } catch (error) {
      if (transactionWritten) {
        try {
          await recoverTransaction(projectRoot, {
            allowCurrentOwner: true,
            expectedId: transaction.transaction_id,
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
  } finally {
    await corpus?.cleanup();
    ACTIVE_ROOTS.delete(projectRoot);
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
