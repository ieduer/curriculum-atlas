import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sealCorpusManifest } from '../scripts/import-corpus.mjs';
import {
  parseArgs,
  rebindResearchEvidenceCorpus,
} from '../scripts/rebind-research-evidence-corpus.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const MANIFEST_PATH = 'data/research-evidence/zh-hs-2017-2020.json';
const REGISTRY_PATH = 'data/research-evidence/zh-hs-2017-2020-source-registry.json';
const SCHEMA_PATH = 'data/research-evidence/research-evidence-slice.schema.json';
const CORPUS_MANIFEST_PATH = 'data/corpus-chunks/manifest.json';
const TRANSACTION_PATH = 'data/research-evidence/.zh-hs-2017-2020-corpus-rebind-transaction.json';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sql = (value) => value === null ? 'NULL' : typeof value === 'number'
  ? String(value)
  : `'${String(value).replaceAll("'", "''")}'`;

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function fakeCandidateValidation({ manifest }) {
  if (manifest.release_boundary?.deployment_allowed !== false
      || manifest.assertions.some((entry) => entry.release_gate?.allowed !== false
        || entry.review?.status !== 'pending_signed_editor_review'
        || entry.review?.reviewer_id !== null
        || entry.review?.decision_resource_id !== null
        || Object.values(entry.publication || {}).some((value) => value !== false))) {
    throw new Error('fixture publication boundary opened');
  }
  return {
    validation: {
      evidence_integrity_valid: true,
      assertions: manifest.assertions.map((entry) => ({
        assertion_id: entry.assertion_id,
        publication_eligible: false,
        blockers: [...entry.release_gate.blocked_by_statuses],
      })),
    },
    projection: { publication_state: 'fail_closed_pending_signed_editor_review' },
  };
}

function noOpHooks(overrides = {}) {
  return {
    afterJournalTemporarySync: async () => {},
    afterManifestTemporarySync: async () => {},
    afterManifestWrite: async () => {},
    validateCandidate: fakeCandidateValidation,
    ...overrides,
  };
}

async function writeJson(root, relativePath, value, mode = 0o644) {
  const destination = join(root, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, { mode });
  return destination;
}

async function createFixture({ duplicateFirstLocator = false } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'curriculum-research-rebind-test-'));
  const manifest = JSON.parse(await readFile(join(projectRoot, MANIFEST_PATH), 'utf8'));
  const registry = JSON.parse(await readFile(join(projectRoot, REGISTRY_PATH), 'utf8'));
  const schema = JSON.parse(await readFile(join(projectRoot, SCHEMA_PATH), 'utf8'));
  const releaseFingerprint = 'a'.repeat(64);
  const releaseId = `corpus-${releaseFingerprint.slice(0, 24)}`;
  const paragraphRows = [];
  const pageRows = [];
  for (const [index, evidence] of manifest.evidence.entries()) {
    const body = `${'甲'.repeat(evidence.utf16_start)}${evidence.exact_text}乙乙乙`;
    const bodySha256 = sha256(body);
    const pageFinalTextSha256 = sha256(`fixture-page:${evidence.evidence_id}`);
    evidence.paragraph_id = 1_000 + index;
    evidence.paragraph_body_sha256 = bodySha256;
    evidence.page_final_text_sha256 = pageFinalTextSha256;
    paragraphRows.push({
      id: 2_000 + index,
      document_id: evidence.document_id,
      ordinal: evidence.paragraph_ordinal,
      page_number: evidence.physical_pdf_page,
      body,
      body_sha256: bodySha256,
      source_artifact_sha256: evidence.source_artifact_sha256,
      page_final_text_sha256: pageFinalTextSha256,
      provenance_locator: `${evidence.page_publication_stable_locator}:block:1:body:${bodySha256}`,
    });
    pageRows.push({
      document_id: evidence.document_id,
      page_number: evidence.physical_pdf_page,
      source_artifact_sha256: evidence.source_artifact_sha256,
      final_text_sha256: pageFinalTextSha256,
      stable_locator: evidence.page_publication_stable_locator,
    });
  }

  const migration = `
    CREATE TABLE documents(
      id TEXT PRIMARY KEY,title TEXT,subject TEXT,stage TEXT,document_type TEXT,version_label TEXT,
      issued_by TEXT,sort_year INTEGER,checksum_sha256 TEXT,text_quality_status TEXT,
      citation_allowed INTEGER,corpus_release_id TEXT
    );
    CREATE TABLE document_classifications(
      document_id TEXT,taxonomy_entity_kind TEXT,canonical_subject TEXT,display_facet TEXT
    );
    CREATE TABLE paragraphs(
      id INTEGER PRIMARY KEY,document_id TEXT,ordinal INTEGER,page_number INTEGER,body TEXT,
      body_sha256 TEXT,display_allowed INTEGER,citation_allowed INTEGER,source_artifact_sha256 TEXT,
      page_final_text_sha256 TEXT,provenance_locator TEXT,corpus_release_id TEXT
    );
    CREATE TABLE page_publication_gates(
      document_id TEXT,page_number INTEGER,source_artifact_sha256 TEXT,final_text_sha256 TEXT,
      stable_locator TEXT,publication_basis TEXT,review_status TEXT,display_allowed INTEGER,
      citation_allowed INTEGER,corpus_release_id TEXT
    );
  `;
  await mkdir(join(root, 'migrations'), { recursive: true });
  await writeFile(join(root, 'migrations/0001_fixture.sql'), migration);

  const coreSql = [
    ...manifest.documents.map((document) => `INSERT INTO documents VALUES(${[
      document.document_id,
      document.title,
      document.subject,
      document.stage,
      document.document_type,
      document.version_label,
      document.issued_by,
      document.sort_year,
      document.source_artifact_sha256,
      'official_native_text',
      1,
      releaseId,
    ].map(sql).join(',')});`),
    ...manifest.documents.map((document) => `INSERT INTO document_classifications VALUES(${[
      document.document_id, 'subject', '语文', '语文',
    ].map(sql).join(',')});`),
    ...pageRows.map((page) => `INSERT INTO page_publication_gates VALUES(${[
      page.document_id,
      page.page_number,
      page.source_artifact_sha256,
      page.final_text_sha256,
      page.stable_locator,
      'official_native_text',
      'official_native_text',
      1,
      1,
      releaseId,
    ].map(sql).join(',')});`),
  ].join('\n');
  const rows = duplicateFirstLocator ? [...paragraphRows, { ...paragraphRows[0], id: 9_999 }] : paragraphRows;
  const paragraphSql = rows.map((row) => `INSERT INTO paragraphs VALUES(${[
    row.id,
    row.document_id,
    row.ordinal,
    row.page_number,
    row.body,
    row.body_sha256,
    1,
    1,
    row.source_artifact_sha256,
    row.page_final_text_sha256,
    row.provenance_locator,
    releaseId,
  ].map(sql).join(',')});`).join('\n');
  const sqlFiles = [
    { name: '000-core.sql', bytes: Buffer.from(coreSql) },
    { name: '001-paragraphs.sql', bytes: Buffer.from(paragraphSql) },
  ];
  await mkdir(join(root, 'data/corpus-chunks'), { recursive: true });
  for (const entry of sqlFiles) await writeFile(join(root, 'data/corpus-chunks', entry.name), entry.bytes);

  const textAssets = [];
  await mkdir(join(root, '.cache/text'), { recursive: true });
  for (const document of manifest.documents) {
    const bytes = Buffer.from(`fixture text ${document.document_id}\n`);
    await writeFile(join(root, '.cache/text', `${document.document_id}.txt`), bytes);
    textAssets.push({ document_id: document.document_id, sha256: sha256(bytes), bytes: bytes.length });
  }
  const coreTableCounts = Object.fromEntries([
    'subjects', 'periods', 'document_relations', 'chapters', 'document_classifications',
    'document_sources', 'primary_document_sources', 'subject_insights', 'terms',
    'term_relations', 'version_diffs', 'online_verifications', 'online_evidence', 'embedded_items',
  ].map((key) => [key, 0]));
  coreTableCounts.document_classifications = 2;
  coreTableCounts.document_sources = 2;
  coreTableCounts.primary_document_sources = 2;
  const corpusManifest = sealCorpusManifest({
    generated_at: '2026-07-22T00:00:00.000Z',
    schema_version: 1,
    release_id: releaseId,
    release_fingerprint_sha256: releaseFingerprint,
    documents: 2,
    paragraphs: rows.length,
    fts_rows: rows.length,
    page_publication_gates: 6,
    displayed_paragraphs: rows.length,
    accepted_ocr_documents: 0,
    core_table_counts: coreTableCounts,
    text_asset_count: 2,
    text_assets: textAssets,
    sql_chunks: 2,
    sql_files: sqlFiles.map((entry) => ({
      name: entry.name,
      sha256: sha256(entry.bytes),
      bytes: entry.bytes.length,
    })),
    closed_ocr_paragraphs: 0,
    skipped_ocr_documents: 0,
    excluded_exact_duplicate_alias_documents: 0,
    semantic_excluded_pages: 0,
    page_publication_schema_version: 1,
    semantic_publication_schema_version: 1,
    semantic_publication_revision_sha256: 'b'.repeat(64),
  });
  await writeJson(root, CORPUS_MANIFEST_PATH, corpusManifest);
  await writeJson(root, MANIFEST_PATH, manifest);
  await writeJson(root, REGISTRY_PATH, registry);
  await writeJson(root, SCHEMA_PATH, schema);

  const requiredResourceIds = new Set([
    manifest.corpus.resource_id,
    manifest.corpus.manifest_resource_id,
    ...manifest.online_sources.map((entry) => entry.resource.resource_id),
    ...manifest.evidence.map((entry) => entry.page_image.resource_id),
  ]);
  const resources = {};
  await mkdir(join(root, 'private'), { recursive: true });
  for (const [index, resourceId] of [...requiredResourceIds].entries()) {
    if (resourceId === manifest.corpus.resource_id) {
      resources[resourceId] = join(root, 'private/unused.sqlite');
    } else if (resourceId === manifest.corpus.manifest_resource_id) {
      resources[resourceId] = join(root, CORPUS_MANIFEST_PATH);
    } else {
      const resourcePath = join(root, 'private', `${String(index).padStart(2, '0')}.bin`);
      await writeFile(resourcePath, `resource ${resourceId}\n`);
      resources[resourceId] = resourcePath;
    }
  }
  const resourceMap = await writeJson(root, 'private/resource-map.json', {
    schema_version: 1,
    policy: 'local_read_only_research_evidence_resources_v1',
    resources,
  }, 0o644);
  await chmod(resourceMap, 0o644);
  return { root, resourceMap, manifest, registry };
}

async function governedBytes(fixture) {
  return {
    manifest: await readFile(join(fixture.root, MANIFEST_PATH)),
    registry: await readFile(join(fixture.root, REGISTRY_PATH)),
  };
}

test('CLI is dry-run by default and accepts only explicit apply/root/resource-map flags', () => {
  const dryRun = parseArgs(['--resource-map', '/tmp/map.json']);
  assert.equal(dryRun.apply, false);
  assert.equal(dryRun.resourceMap, '/tmp/map.json');
  const apply = parseArgs(['--apply', '--root', '/tmp/root', '--resource-map', '/tmp/map.json']);
  assert.equal(apply.apply, true);
  assert.equal(apply.root, '/tmp/root');
  assert.throws(() => parseArgs(['--promotion', '--resource-map', '/tmp/map.json']), /unexpected argument/i);
  assert.throws(() => parseArgs([]), /resource-map/i);
});

test('dry-run is mutation-free; apply changes only corpus identity, paragraph IDs and registry rowset; rerun is byte-idempotent', async () => {
  const fixture = await createFixture();
  try {
    const before = await governedBytes(fixture);
    const dryRun = await rebindResearchEvidenceCorpus({
      root: fixture.root,
      resourceMap: fixture.resourceMap,
      testHooks: noOpHooks(),
      renderPageImage: () => Buffer.alloc(0),
    });
    assert.equal(dryRun.mode, 'dry-run');
    assert.equal(dryRun.changed, true);
    assert.deepEqual(await governedBytes(fixture), before);
    assert.deepEqual(dryRun.evidence_mappings.map((entry) => entry.after_paragraph_id), [
      2_000, 2_001, 2_002, 2_003, 2_004, 2_005,
    ]);
    assert.equal(dryRun.publication.strict_publication_exit, 3);
    assert.equal(dryRun.publication.assertions.every((entry) => entry.publication_eligible === false), true);

    const first = await rebindResearchEvidenceCorpus({
      root: fixture.root,
      resourceMap: fixture.resourceMap,
      apply: true,
      testHooks: noOpHooks(),
      renderPageImage: () => Buffer.alloc(0),
    });
    assert.equal(first.changed, true);
    const afterFirst = await governedBytes(fixture);
    const manifest = JSON.parse(afterFirst.manifest);
    assert.deepEqual(manifest.evidence.map((entry) => entry.paragraph_id), [
      2_000, 2_001, 2_002, 2_003, 2_004, 2_005,
    ]);
    assert.equal(manifest.conflicts[0].status, 'unresolved_fail_closed');
    assert.equal(manifest.assertions.every((entry) => entry.review.reviewer_id === null
      && entry.review.decision_resource_id === null
      && entry.release_gate.allowed === false
      && Object.values(entry.publication).every((value) => value === false)), true);

    const second = await rebindResearchEvidenceCorpus({
      root: fixture.root,
      resourceMap: fixture.resourceMap,
      apply: true,
      testHooks: noOpHooks(),
      renderPageImage: () => Buffer.alloc(0),
    });
    assert.equal(second.changed, false);
    assert.deepEqual(await governedBytes(fixture), afterFirst);
    assert.equal(await exists(join(fixture.root, TRANSACTION_PATH)), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('duplicate evidence locator and corpus asset hash drift fail before either governed output changes', async (t) => {
  await t.test('duplicate locator', async () => {
    const fixture = await createFixture({ duplicateFirstLocator: true });
    try {
      const before = await governedBytes(fixture);
      await assert.rejects(rebindResearchEvidenceCorpus({
        root: fixture.root,
        resourceMap: fixture.resourceMap,
        testHooks: noOpHooks(),
        renderPageImage: () => Buffer.alloc(0),
      }), /locator resolved 2 current paragraphs/i);
      assert.deepEqual(await governedBytes(fixture), before);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test('SQL hash drift', async () => {
    const fixture = await createFixture();
    try {
      const before = await governedBytes(fixture);
      await writeFile(join(fixture.root, 'data/corpus-chunks/001-paragraphs.sql'), 'tampered\n');
      await assert.rejects(rebindResearchEvidenceCorpus({
        root: fixture.root,
        resourceMap: fixture.resourceMap,
        testHooks: noOpHooks(),
        renderPageImage: () => Buffer.alloc(0),
      }), /differs from the immutable corpus manifest/i);
      assert.deepEqual(await governedBytes(fixture), before);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

test('symlinks, hard links, and group/world-writable inputs are rejected without writes', async (t) => {
  await t.test('symlinked corpus text', async () => {
    const fixture = await createFixture();
    try {
      const before = await governedBytes(fixture);
      const target = join(fixture.root, '.cache/text/ictr-a71e3780f934.txt');
      const bytes = await readFile(target);
      await rm(target);
      await writeFile(`${target}.real`, bytes);
      await symlink(`${target}.real`, target);
      await assert.rejects(rebindResearchEvidenceCorpus({
        root: fixture.root,
        resourceMap: fixture.resourceMap,
        testHooks: noOpHooks(),
        renderPageImage: () => Buffer.alloc(0),
      }), /symbolic link|non-symlink/i);
      assert.deepEqual(await governedBytes(fixture), before);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test('resource map mode', async () => {
    const fixture = await createFixture();
    try {
      const before = await governedBytes(fixture);
      await chmod(fixture.resourceMap, 0o664);
      await assert.rejects(rebindResearchEvidenceCorpus({
        root: fixture.root,
        resourceMap: fixture.resourceMap,
        testHooks: noOpHooks(),
        renderPageImage: () => Buffer.alloc(0),
      }), /group\/world writable/i);
      assert.deepEqual(await governedBytes(fixture), before);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test('resource map ancestor symlink', async () => {
    const fixture = await createFixture();
    try {
      const before = await governedBytes(fixture);
      const alias = join(fixture.root, 'private-alias');
      await symlink('private', alias, 'dir');
      await assert.rejects(rebindResearchEvidenceCorpus({
        root: fixture.root,
        resourceMap: join(alias, 'resource-map.json'),
        testHooks: noOpHooks(),
        renderPageImage: () => Buffer.alloc(0),
      }), /symbolic-link path component/i);
      assert.deepEqual(await governedBytes(fixture), before);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test('resource map hard link', async () => {
    const fixture = await createFixture();
    try {
      const before = await governedBytes(fixture);
      const alias = join(fixture.root, 'private/resource-map-hard-link.json');
      await link(fixture.resourceMap, alias);
      await assert.rejects(rebindResearchEvidenceCorpus({
        root: fixture.root,
        resourceMap: alias,
        testHooks: noOpHooks(),
        renderPageImage: () => Buffer.alloc(0),
      }), /exactly one hard link/i);
      assert.deepEqual(await governedBytes(fixture), before);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

test('ordinary exception after the first output rename rolls both files back exactly', async () => {
  const fixture = await createFixture();
  try {
    const before = await governedBytes(fixture);
    await assert.rejects(rebindResearchEvidenceCorpus({
      root: fixture.root,
      resourceMap: fixture.resourceMap,
      apply: true,
      testHooks: noOpHooks({
        afterManifestWrite: async () => { throw new Error('fixture interruption'); },
      }),
      renderPageImage: () => Buffer.alloc(0),
    }), /fixture interruption/i);
    assert.deepEqual(await governedBytes(fixture), before);
    assert.equal(await exists(join(fixture.root, TRANSACTION_PATH)), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('SIGKILL after the first governed rename is recovered on the next apply', async () => {
  const fixture = await createFixture();
  let child = null;
  try {
    const before = await governedBytes(fixture);
    const moduleUrl = pathToFileURL(join(projectRoot, 'scripts/rebind-research-evidence-corpus.mjs')).href;
    const source = [
      `import { rebindResearchEvidenceCorpus } from ${JSON.stringify(moduleUrl)};`,
      `const validateCandidate = ${fakeCandidateValidation.toString()};`,
      'await rebindResearchEvidenceCorpus({',
      '  root: process.env.REBIND_ROOT,',
      '  resourceMap: process.env.REBIND_MAP,',
      '  apply: true,',
      '  renderPageImage: () => Buffer.alloc(0),',
      '  testHooks: {',
      '    afterJournalTemporarySync: async () => {},',
      '    afterManifestTemporarySync: async () => {},',
      '    afterManifestWrite: async () => new Promise((resolve) => setTimeout(resolve, 60_000)),',
      '    validateCandidate,',
      '  },',
      '});',
    ].join('\n');
    child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        REBIND_ROOT: fixture.root,
        REBIND_MAP: fixture.resourceMap,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`child exited before crash point: ${stderr}`);
      }
      if (!(await exists(join(fixture.root, TRANSACTION_PATH)))) return false;
      const current = await governedBytes(fixture);
      return !current.manifest.equals(before.manifest) && current.registry.equals(before.registry);
    }, 'durable journal and first governed rename');
    const interrupted = await governedBytes(fixture);
    await assert.rejects(rebindResearchEvidenceCorpus({
      root: fixture.root,
      resourceMap: fixture.resourceMap,
      testHooks: noOpHooks(),
      renderPageImage: () => Buffer.alloc(0),
    }), /dry-run never mutates recovery state/i);
    assert.deepEqual(await governedBytes(fixture), interrupted);
    await assert.rejects(rebindResearchEvidenceCorpus({
      root: fixture.root,
      resourceMap: fixture.resourceMap,
      apply: true,
      testHooks: noOpHooks(),
      renderPageImage: () => Buffer.alloc(0),
    }), /still owned by a live process/i);
    const exit = once(child, 'exit');
    assert.equal(child.kill('SIGKILL'), true);
    const [code, signal] = await exit;
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
    child = null;

    const recovered = await rebindResearchEvidenceCorpus({
      root: fixture.root,
      resourceMap: fixture.resourceMap,
      apply: true,
      testHooks: noOpHooks(),
      renderPageImage: () => Buffer.alloc(0),
    });
    assert.equal(recovered.recovered_transaction, 'rolled_back_prepared_transaction');
    assert.equal(recovered.changed, true);
    assert.equal(await exists(join(fixture.root, TRANSACTION_PATH)), false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit').catch(() => {});
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('SIGKILL before the no-replace journal link leaves one scoped temp; dry-run preserves it and apply removes it', async () => {
  const fixture = await createFixture();
  let child = null;
  try {
    const before = await governedBytes(fixture);
    const unrelated = join(fixture.root, 'data/research-evidence/.unrelated-preserve.txt');
    await writeFile(unrelated, 'preserve me\n');
    const moduleUrl = pathToFileURL(join(projectRoot, 'scripts/rebind-research-evidence-corpus.mjs')).href;
    const source = [
      `import { rebindResearchEvidenceCorpus } from ${JSON.stringify(moduleUrl)};`,
      `const validateCandidate = ${fakeCandidateValidation.toString()};`,
      'await rebindResearchEvidenceCorpus({',
      '  root: process.env.REBIND_ROOT,',
      '  resourceMap: process.env.REBIND_MAP,',
      '  apply: true,',
      '  renderPageImage: () => Buffer.alloc(0),',
      '  testHooks: {',
      '    afterJournalTemporarySync: async () => new Promise((resolve) => setTimeout(resolve, 60_000)),',
      '    afterManifestTemporarySync: async () => {},',
      '    afterManifestWrite: async () => {},',
      '    validateCandidate,',
      '  },',
      '});',
    ].join('\n');
    child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        REBIND_ROOT: fixture.root,
        REBIND_MAP: fixture.resourceMap,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    let journalTemporary;
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`child exited before journal-temp crash point: ${stderr}`);
      }
      const entries = await readdir(join(fixture.root, 'data/research-evidence'));
      const matches = entries.filter((name) => (
        /^\.zh-hs-2017-2020-corpus-rebind-journal-\d+-[a-f0-9-]{36}\.tmp$/u.test(name)
      ));
      if (matches.length !== 1 || await exists(join(fixture.root, TRANSACTION_PATH))) return false;
      journalTemporary = join(fixture.root, 'data/research-evidence', matches[0]);
      return true;
    }, 'fsynced journal temporary before no-replace link');
    const exit = once(child, 'exit');
    assert.equal(child.kill('SIGKILL'), true);
    const [code, signal] = await exit;
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
    child = null;
    assert.equal(await exists(journalTemporary), true);
    assert.deepEqual(await governedBytes(fixture), before);

    await assert.rejects(rebindResearchEvidenceCorpus({
      root: fixture.root,
      resourceMap: fixture.resourceMap,
      testHooks: noOpHooks(),
      renderPageImage: () => Buffer.alloc(0),
    }), /dry-run never mutates recovery state/i);
    assert.equal(await exists(journalTemporary), true);
    const recovered = await rebindResearchEvidenceCorpus({
      root: fixture.root,
      resourceMap: fixture.resourceMap,
      apply: true,
      testHooks: noOpHooks(),
      renderPageImage: () => Buffer.alloc(0),
    });
    assert.equal(recovered.recovered_transaction, null);
    assert.equal(await exists(journalTemporary), false);
    assert.equal(await readFile(unrelated, 'utf8'), 'preserve me\n');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit').catch(() => {});
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('third-party bytes during rollback are never overwritten and leave a recovery journal', async () => {
  const fixture = await createFixture();
  try {
    const rogue = Buffer.from('{"third_party":true}\n');
    await assert.rejects(rebindResearchEvidenceCorpus({
      root: fixture.root,
      resourceMap: fixture.resourceMap,
      apply: true,
      testHooks: noOpHooks({
        afterManifestWrite: async () => {
          await writeFile(join(fixture.root, REGISTRY_PATH), rogue);
          throw new Error('third-party interruption');
        },
      }),
      renderPageImage: () => Buffer.alloc(0),
    }), AggregateError);
    assert.deepEqual(await readFile(join(fixture.root, REGISTRY_PATH)), rogue);
    assert.equal(await exists(join(fixture.root, TRANSACTION_PATH)), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
