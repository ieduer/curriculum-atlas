import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildParagraphIdentityGuardSql,
  buildCorpusImportFailureSql,
  buildCorpusImportFinalizeSql,
  buildCorpusImportOwnerAcquireSql,
  buildCorpusImportStartSql,
  buildCorpusChunkReceiptSql,
  collectD1TimeTravelReceipt,
  CORE_TABLE_COUNT_KEYS,
  parseD1TimeTravelReceipt,
  runCorpusFinalization,
  runCorpusImport,
  sealCorpusManifest,
  validateCorpusManifest,
} from '../scripts/import-corpus.mjs';
import { computeCorpusReleaseFingerprint } from '../scripts/lib/corpus-release-fingerprint.mjs';
import { createImmutableTreeSnapshot } from '../scripts/lib/immutable-release-snapshot.mjs';

const root = new URL('../', import.meta.url);
const builder = await readFile(new URL('scripts/build-corpus.mjs', root), 'utf8');
const worker = await readFile(new URL('src/index.ts', root), 'utf8');

function manifest(overrides = {}) {
  const projection = {
    generated_at: '2026-07-18T00:00:00.000Z',
    schema_version: 1,
    release_id: `corpus-${'b'.repeat(24)}`,
    release_fingerprint_sha256: 'b'.repeat(64),
    documents: 1,
    paragraphs: 1,
    fts_rows: 1,
    page_publication_gates: 1,
    displayed_paragraphs: 1,
    accepted_ocr_documents: 0,
    core_table_counts: {
      subjects: 0,
      periods: 5,
      document_relations: 0,
      chapters: 0,
      document_classifications: 1,
      document_sources: 1,
      primary_document_sources: 1,
      subject_insights: 0,
      terms: 0,
      term_relations: 0,
      version_diffs: 0,
      online_verifications: 0,
      online_evidence: 0,
    },
    text_asset_count: 1,
    text_assets: [{ document_id: 'doc-a', sha256: 'e'.repeat(64), bytes: 1 }],
    sql_chunks: 1,
    sql_files: [{ name: '000-core.sql', sha256: 'f'.repeat(64), bytes: 1 }],
    closed_ocr_paragraphs: 0,
    skipped_ocr_documents: 0,
    excluded_exact_duplicate_alias_documents: 0,
    semantic_excluded_pages: 0,
    page_publication_schema_version: 1,
    semantic_publication_schema_version: 1,
    semantic_publication_revision_sha256: 'a'.repeat(64),
    ...overrides,
  };
  return sealCorpusManifest(projection);
}

function rawAuditManifest(overrides = {}) {
  return {
    generated_at: '2026-07-18T00:00:00.000Z',
    ...manifest(),
    closed_ocr_paragraphs: 0,
    skipped_ocr_documents: 0,
    excluded_exact_duplicate_alias_documents: 0,
    semantic_excluded_pages: 0,
    page_publication_schema_version: 1,
    semantic_publication_schema_version: 1,
    semantic_publication_revision_sha256: 'a'.repeat(64),
    ...overrides,
  };
}

async function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON;');
  const migrations = (await readdir(new URL('migrations/', root))).filter((name) => name.endsWith('.sql')).sort();
  for (const name of migrations) db.exec(await readFile(new URL(`migrations/${name}`, root), 'utf8'));
  return db;
}

function seedOldCorpus(db) {
  const oldRelease = `corpus-${'a'.repeat(24)}`;
  db.exec(`INSERT INTO documents(
    id,title,subject,stage,document_type,version_label,issued_by,current_status,source_tier,
    access_status,source_page_url,source_url,file_format,redistribution,text_quality_status,
    citation_allowed,corpus_release_id
  ) VALUES('doc-a','旧标题','语文','义务教育','课程标准','旧版','教育部','historical','primary_official',
    'verified_online','https://example.test/page','https://example.test/file','html','metadata_only',
    'official_native_text',1,'${oldRelease}');
  INSERT INTO document_classifications(
    document_id,entity_kind,taxonomy_entity_kind,canonical_subject,display_facet,
    subject_family,scope_kind,scope_label,source_subject_label,decision_basis
  ) VALUES('doc-a','subject','subject','语文','语文','语文',NULL,NULL,'语文','fixture');
  INSERT INTO document_sources(
    document_id,provider,source_page_url,source_url,access_status,is_primary
  ) VALUES('doc-a','教育部','https://example.test/page','https://example.test/file','verified_online',1);`);
  for (let page = 1; page <= 3; page += 1) {
    db.prepare(`INSERT INTO page_publication_gates(
      document_id,page_number,source_artifact_sha256,final_text_sha256,stable_locator,
      publication_basis,review_status,display_allowed,citation_allowed,corpus_release_id
    ) VALUES(?,?,?,?,?,'official_native_text','official_native_text',1,1,?)`).run(
      'doc-a', page, 'd'.repeat(64), createHash('sha256').update(`old-${page}`).digest('hex'),
      `doc-a:page:${page}`, oldRelease,
    );
    db.prepare(`INSERT INTO paragraphs(
      document_id,ordinal,page_number,body,source_locator,body_sha256,text_quality_status,
      citation_allowed,display_allowed,corpus_release_id
    ) VALUES(?,?,?,?,?,?, 'official_native_text',1,1,?)`).run(
      'doc-a', page, page, `old-${page}`, `第${page}页`,
      createHash('sha256').update(`old-${page}`).digest('hex'), oldRelease,
    );
  }
  const protectedParagraph = db.prepare("SELECT id FROM paragraphs WHERE document_id='doc-a' AND ordinal=3").get().id;
  db.prepare(`INSERT INTO comments(
    id,document_id,paragraph_id,author_name,author_kind,body,status
  ) VALUES('comment-1','doc-a',?,'教师','authenticated','保留讨论内容','approved')`).run(protectedParagraph);
  db.prepare(`INSERT INTO online_verifications(
    id,document_id,paragraph_id,entity_type,entity_label,edition_match_status,
    verification_status,resolution,citation_allowed,reviewed_by
  ) VALUES('verification-protected','doc-a',?,'paragraph','第三段',
    'exact_document_exact_edition','verified_exact','fixture',1,'fixture')`).run(protectedParagraph);
  return {
    oldRelease,
    stableParagraphId: db.prepare("SELECT id FROM paragraphs WHERE document_id='doc-a' AND ordinal=1").get().id,
    protectedParagraph,
  };
}

function importCurrentOneParagraph(db, releaseId) {
  const bodySha256 = createHash('sha256').update('new-1').digest('hex');
  const provenanceLocator = `doc-a:fixture:${bodySha256.slice(0, 16)}`;
  db.exec(buildParagraphIdentityGuardSql([{
    document_id: 'doc-a',
    ordinal: 1,
    page_number: 1,
    heading: null,
    source_locator: '第1页',
    body_sha256: bodySha256,
    provenance_locator: provenanceLocator,
  }], '001-paragraphs.sql'));
  db.prepare("UPDATE documents SET title='新标题',corpus_release_id=? WHERE id='doc-a'").run(releaseId);
  db.prepare(`INSERT INTO page_publication_gates(
    document_id,page_number,source_artifact_sha256,final_text_sha256,stable_locator,
    publication_basis,review_status,display_allowed,citation_allowed,corpus_release_id
  ) VALUES('doc-a',1,?,?,?,'official_native_text','official_native_text',1,1,?)
  ON CONFLICT(document_id,page_number) DO UPDATE SET
    final_text_sha256=excluded.final_text_sha256,display_allowed=1,citation_allowed=1,
    corpus_release_id=excluded.corpus_release_id`).run(
    'd'.repeat(64), createHash('sha256').update('new-1').digest('hex'), 'doc-a:page:1', releaseId,
  );
  db.prepare(`INSERT INTO paragraphs(
    document_id,ordinal,page_number,body,source_locator,body_sha256,text_quality_status,
    citation_allowed,display_allowed,provenance_locator,corpus_release_id
  ) VALUES('doc-a',1,1,'new-1','第1页',?,'official_native_text',1,1,?,?)
  ON CONFLICT(document_id,ordinal) DO UPDATE SET
    page_number=excluded.page_number,heading=excluded.heading,body=excluded.body,
    source_locator=excluded.source_locator,body_sha256=excluded.body_sha256,
    provenance_locator=excluded.provenance_locator,citation_allowed=1,display_allowed=1,
    corpus_release_id=excluded.corpus_release_id`).run(
    bodySha256, provenanceLocator, releaseId,
  );
}

function prechange(bookmark = 'fixture-bookmark') {
  const raw = `${JSON.stringify([{ bookmark, timestamp: '2026-07-18T00:00:00.000Z' }])}\n`;
  return {
    bookmark,
    timestamp: '2026-07-18T00:00:00.000Z',
    sha256: createHash('sha256').update(raw).digest('hex'),
    bytes: Buffer.byteLength(raw),
    raw_json: raw,
  };
}

test('D1 Time Travel receipt preserves Wrangler bytes and records an independent pre-command observation time', () => {
  const raw = Buffer.from('{"bookmark":"opaque-bookmark"}\n');
  const observedAt = '2026-07-18T01:02:03.004Z';
  const parsed = parseD1TimeTravelReceipt(raw, observedAt);
  assert.deepEqual(parsed, {
    bookmark: 'opaque-bookmark',
    timestamp: observedAt,
    sha256: createHash('sha256').update(raw).digest('hex'),
    bytes: raw.length,
    raw_json: raw.toString('utf8'),
  });
  assert.throws(
    () => parseD1TimeTravelReceipt(raw, '2026-07-18T01:02:03Z'),
    /canonical millisecond UTC timestamp/,
  );
});

test('D1 Time Travel collector timestamps before invoking Wrangler and accepts bookmark-only JSON', () => {
  const order = [];
  const observedAt = '2026-07-18T01:02:03.004Z';
  const receipt = collectD1TimeTravelReceipt({
    root,
    database: 'curriculum-atlas-preview',
    environment: 'preview',
    now: () => {
      order.push('clock');
      return new Date(observedAt);
    },
    runCommand: (command, args, options) => {
      order.push('wrangler');
      assert.equal(command, 'npx');
      assert.deepEqual(args, [
        '--no-install', 'wrangler', 'd1', 'time-travel', 'info',
        'curriculum-atlas-preview', '--env', 'preview', '--json',
      ]);
      assert.equal(options.encoding, null);
      return { status: 0, stdout: Buffer.from('{"bookmark":"before-change"}\n') };
    },
  });
  assert.deepEqual(order, ['clock', 'wrangler']);
  assert.equal(receipt.bookmark, 'before-change');
  assert.equal(receipt.timestamp, observedAt);
});

function acquireOwner(db, value, ownerToken = 'fixture-corpus-owner-20260718') {
  db.exec(buildCorpusImportOwnerAcquireSql(value, { ownerToken, ttlSeconds: 3600 }));
  const ownerFence = Number(db.prepare('SELECT owner_fence FROM corpus_import_ownership WHERE id=1').get().owner_fence);
  return { ownerToken, ownerFence, ttlSeconds: 3600, prechange: prechange() };
}

function ownerOptions() {
  return {
    ownerToken: 'fixture-corpus-owner-20260718',
    ownerFence: 1,
    ttlSeconds: 3600,
    prechange: prechange(),
  };
}

function recordAllChunks(db, value, options) {
  for (const chunk of value.sql_files) db.exec(buildCorpusChunkReceiptSql(value, chunk.name, null, options));
}

async function minimalCorpusSnapshotFactory({ root: fixtureRoot, manifest: value }) {
  const manifestBuffer = await readFile(join(fixtureRoot, 'data', 'corpus-chunks', 'manifest.json'));
  const files = [{
    path: 'data/corpus-chunks/manifest.json',
    sha256: createHash('sha256').update(manifestBuffer).digest('hex'),
    bytes: manifestBuffer.length,
  }, ...value.sql_files.map((entry) => ({
    path: `data/corpus-chunks/${entry.name}`,
    sha256: entry.sha256,
    bytes: entry.bytes,
  }))];
  return createImmutableTreeSnapshot({ root: fixtureRoot, files, label: 'minimal corpus test snapshot' });
}

test('document and paragraph imports update in place instead of replacing stable rows', () => {
  assert.doesNotMatch(builder, /INSERT OR REPLACE INTO documents/);
  assert.doesNotMatch(builder, /INSERT OR (?:IGNORE|REPLACE) INTO paragraphs/);
  assert.match(builder, /ON CONFLICT\(id\) DO UPDATE SET/);
  assert.match(builder, /ON CONFLICT\(document_id,ordinal\) DO UPDATE SET/);
});

test('paragraph identity guard stores only hashes and locators and blocks drift under an existing comment', async () => {
  assert.doesNotMatch(buildParagraphIdentityGuardSql.toString(), /row\.body(?!_sha256)/);
  assert.match(builder, /buildParagraphIdentityGuardSql\(paragraphIdentityRows, chunkName\)/);
  assert.doesNotMatch(builder, /DELETE FROM online_verifications;/);
  assert.match(builder, /online_verifications\([^)]*corpus_release_id\)/);

  const db = await database();
  const seeded = seedOldCorpus(db);
  db.prepare(`INSERT INTO comments(
    id,document_id,paragraph_id,author_name,author_kind,body,status
  ) VALUES('comment-current','doc-a',?,'教师','authenticated','绑定第一段','approved')`).run(seeded.stableParagraphId);
  const before = db.prepare('SELECT id,body,body_sha256,corpus_release_id FROM paragraphs WHERE id=?')
    .get(seeded.stableParagraphId);

  assert.throws(
    () => importCurrentOneParagraph(db, `corpus-${'b'.repeat(24)}`),
    /CHECK constraint failed/,
  );
  assert.deepEqual(
    { ...db.prepare('SELECT id,body,body_sha256,corpus_release_id FROM paragraphs WHERE id=?').get(seeded.stableParagraphId) },
    { ...before },
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM comments WHERE id='comment-current'").get().n, 1);
});

test('paragraph identity guard also blocks drift under paragraph-scoped online verification evidence', async () => {
  const db = await database();
  const seeded = seedOldCorpus(db);
  db.prepare(`INSERT INTO online_verifications(
    id,document_id,paragraph_id,entity_type,entity_label,edition_match_status,
    verification_status,resolution,citation_allowed,reviewed_by
  ) VALUES('verification-current','doc-a',?,'paragraph','第一段',
    'exact_document_exact_edition','verified_exact','fixture',0,'fixture')`).run(seeded.stableParagraphId);
  const before = db.prepare('SELECT id,body,body_sha256,corpus_release_id FROM paragraphs WHERE id=?')
    .get(seeded.stableParagraphId);

  assert.throws(
    () => importCurrentOneParagraph(db, `corpus-${'b'.repeat(24)}`),
    /CHECK constraint failed/,
  );
  assert.deepEqual(
    { ...db.prepare('SELECT id,body,body_sha256,corpus_release_id FROM paragraphs WHERE id=?').get(seeded.stableParagraphId) },
    { ...before },
  );
  assert.equal(db.prepare("SELECT paragraph_id FROM online_verifications WHERE id='verification-current'").get().paragraph_id, seeded.stableParagraphId);
});

test('builder requires explicit catalog disposition and counts only OCR documents actually bound to text', () => {
  assert.match(builder, /lacks explicit text_quality_status/);
  assert.match(builder, /lacks explicit citation_allowed/);
  assert.match(builder, /Accepted OCR document is missing final text/);
  assert.match(builder, /if \(!nativeText\) acceptedOcrDocuments \+= 1/);
  assert.doesNotMatch(builder, /accepted_ocr_documents:\s*pagePublicationManifest\.documents\.length/);
});

test('manifest rejects count drift and forged snapshot hashes', () => {
  assert.throws(() => validateCorpusManifest({ ...manifest(), paragraphs: 2 }), /fts_rows must equal paragraphs|hash mismatch/);
  assert.throws(() => validateCorpusManifest({ ...manifest(), manifest_sha256: 'f'.repeat(64) }), /hash mismatch/);
  assert.throws(() => validateCorpusManifest(manifest(), 2), /expects 1 SQL chunks but found 2/);
  assert.throws(
    () => validateCorpusManifest({ ...manifest(), release_id: `corpus-${'c'.repeat(24)}` }),
    /release_id does not match release fingerprint/,
  );
});

test('manifest hash binds the exact raw audit envelope and canonical timestamp', () => {
  const raw = rawAuditManifest();
  assert.equal(validateCorpusManifest(raw).release_id, raw.release_id);

  const missing = { ...raw };
  delete missing.closed_ocr_paragraphs;
  assert.throws(() => validateCorpusManifest(missing), /exactly|closed_ocr_paragraphs/);
  assert.throws(() => validateCorpusManifest({ ...raw, unexpected_audit_field: 0 }), /exactly|not allowed/);
  assert.throws(() => validateCorpusManifest({ ...raw, generated_at: '2026-07-18T00:00:00Z' }), /generated_at.*canonical/);

  for (const [field, value] of [
    ['closed_ocr_paragraphs', 1],
    ['skipped_ocr_documents', 1],
    ['excluded_exact_duplicate_alias_documents', 1],
    ['semantic_excluded_pages', 1],
    ['page_publication_schema_version', 2],
    ['semantic_publication_schema_version', 2],
    ['semantic_publication_revision_sha256', 'c'.repeat(64)],
  ]) {
    assert.throws(
      () => validateCorpusManifest({ ...raw, [field]: value }),
      /hash mismatch|must equal|cannot exceed|count mismatch/,
      `${field} must be authenticated and semantically checked`,
    );
  }
});

test('manifest rejects unsafe integers even when its snapshot hash is recomputed', () => {
  assert.throws(
    () => validateCorpusManifest(manifest({ documents: Number.MAX_SAFE_INTEGER + 1 })),
    /safe non-negative integer/,
  );
});

test('corpus release fingerprint binds every builder source input without private cache fixtures', () => {
  const inputs = {
    catalog: { documents: [{ id: 'doc-a', title: '原始标题' }] },
    ingest: { entries: [{ id: 'doc-a', source_sha256: 'a'.repeat(64) }] },
    documentedSources: [{ document_id: 'doc-a', source_url: 'https://example.test/source' }],
    insights: { insights: [{ id: 'insight-a' }], terms: [], relations: [] },
    onlineVerificationSamples: [{ id: 'sample-a', online_evidence: [] }],
    classifications: [{ document_id: 'doc-a', entity_kind: 'subject' }],
    pagePublicationManifest: { schema_version: 1, policy: 'fixture', documents: [] },
    semanticPublicationPolicy: { schema_version: 1, policy: 'fixture' },
    semanticPublicationRevisionSha256: 'b'.repeat(64),
    textAssets: [{ document_id: 'doc-a', sha256: 'c'.repeat(64), bytes: 12 }],
  };
  const baseline = computeCorpusReleaseFingerprint(inputs);
  assert.match(baseline, /^[a-f0-9]{64}$/);
  for (const [field, replacement] of [
    ['catalog', { documents: [{ id: 'doc-a', title: '漂移标题' }] }],
    ['ingest', { entries: [{ id: 'doc-a', source_sha256: 'd'.repeat(64) }] }],
    ['documentedSources', [{ document_id: 'doc-a', source_url: 'https://example.test/other' }]],
    ['insights', { insights: [{ id: 'insight-b' }], terms: [], relations: [] }],
    ['onlineVerificationSamples', [{ id: 'sample-b', online_evidence: [] }]],
    ['classifications', [{ document_id: 'doc-a', entity_kind: 'scope' }]],
    ['pagePublicationManifest', { schema_version: 1, policy: 'other', documents: [] }],
    ['semanticPublicationPolicy', { schema_version: 1, policy: 'other' }],
    ['semanticPublicationRevisionSha256', 'e'.repeat(64)],
    ['textAssets', [{ document_id: 'doc-a', sha256: 'f'.repeat(64), bytes: 12 }]],
  ]) {
    assert.notEqual(
      computeCorpusReleaseFingerprint({ ...inputs, [field]: replacement }),
      baseline,
      `${field} must be fingerprint-bound`,
    );
  }
});

test('manifest core table counts are an exact set and legacy tables must remain empty', () => {
  assert.deepEqual(Object.keys(validateCorpusManifest(manifest()).core_table_counts), CORE_TABLE_COUNT_KEYS);
  for (const mutable of ['comments', 'comment_reports', 'rate_limits', 'ai_citation_logs', 'content_audit_log']) {
    assert.equal(CORE_TABLE_COUNT_KEYS.includes(mutable), false);
    assert.doesNotMatch(builder, new RegExp(`DELETE FROM ${mutable}\\b`));
  }

  const missing = { ...manifest().core_table_counts };
  delete missing.online_evidence;
  assert.throws(() => validateCorpusManifest(manifest({ core_table_counts: missing })), /must contain exactly/);
  assert.throws(
    () => validateCorpusManifest(manifest({
      core_table_counts: { ...manifest().core_table_counts, unexpected_table: 0 },
    })),
    /must contain exactly/,
  );
  for (const table of ['subjects', 'document_relations', 'chapters', 'version_diffs']) {
    assert.throws(
      () => validateCorpusManifest(manifest({
        core_table_counts: { ...manifest().core_table_counts, [table]: 1 },
      })),
      new RegExp(`core_table_counts\\.${table} must equal 0`),
    );
  }
});

test('Wrangler D1 commands rely on its atomic SQL batch and never nest explicit transactions', () => {
  const options = ownerOptions();
  for (const command of [
    buildCorpusImportStartSql(manifest(), options),
    buildCorpusImportFailureSql(manifest(), 'fixture', options),
    buildCorpusImportFinalizeSql(manifest(), options),
  ]) {
    assert.doesNotMatch(command, /\b(?:BEGIN|COMMIT|SAVEPOINT|ROLLBACK)\b/i);
  }
});

test('FTS release invariants use indexed rowid identity instead of the UNINDEXED paragraph_id column', () => {
  const finalize = buildCorpusImportFinalizeSql(manifest(), ownerOptions());
  assert.match(finalize, /LEFT JOIN paragraph_fts f ON f\.rowid=p\.id/);
  assert.match(finalize, /LEFT JOIN paragraphs p ON p\.id=f\.rowid/);
  assert.match(finalize, /SELECT 1 FROM paragraph_fts WHERE paragraph_id IS NOT rowid/);
  assert.doesNotMatch(finalize, /JOIN paragraph_fts f ON f\.paragraph_id=p\.id/);
  assert.doesNotMatch(finalize, /JOIN paragraphs p ON p\.id=f\.paragraph_id/);
});

test('finalize-only recovery reopens the exact failed release without replaying chunks and fails closed', () => {
  const calls = [];
  const runCommand = (_root, _database, _environment, args) => {
    calls.push(args);
    return { status: calls.length === 2 ? 74 : 0 };
  };
  const outcome = runCorpusFinalization({
    root,
    database: 'fixture',
    environment: 'preview',
    manifest: manifest(),
    resume: true,
    ...ownerOptions(),
    runCommand,
  });

  assert.deepEqual(outcome, { status: 74, phase: 'finalize' });
  assert.equal(calls.length, 3);
  assert.match(calls[0][1], /state IN \('in_progress','failed'\)/);
  assert.doesNotMatch(calls[0][1], /DELETE FROM corpus_import_chunks/);
  assert.equal(calls[1][0], '--command');
  assert.match(calls[1][1], /UPDATE corpus_import_releases SET\s+state='ready'/);
  assert.match(calls[2][1], /SET state='failed'/);
  assert.equal(calls.some((args) => args[0] === '--file'), false);
});

test('remote importer executes a private fixed SQL inode and receipts those exact bytes', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'corpus-import-snapshot-fixture-'));
  const chunkDirectory = join(fixtureRoot, 'data', 'corpus-chunks');
  try {
    await mkdir(chunkDirectory, { recursive: true });
    const sqlBytes = Buffer.from('SELECT 1;\n');
    const sqlSha256 = createHash('sha256').update(sqlBytes).digest('hex');
    const sealed = manifest({
      sql_files: [{ name: '000-core.sql', sha256: sqlSha256, bytes: sqlBytes.length }],
    });
    await writeFile(join(chunkDirectory, '000-core.sql'), sqlBytes);
    await writeFile(join(chunkDirectory, 'manifest.json'), `${JSON.stringify(sealed, null, 2)}\n`);

    const calls = [];
    let snapshotPath = null;
    let executedSql = '';
    const runCommand = (_root, _database, _environment, args) => {
      calls.push(args);
      if (calls.length === 1) {
        writeFileSync(join(chunkDirectory, '000-core.sql'), 'SELECT evil;\n');
      }
      if (args[0] === '--file') {
        snapshotPath = args[1];
        assert.notEqual(snapshotPath, join(chunkDirectory, '000-core.sql'));
        executedSql = readFileSync(snapshotPath, 'utf8');
        assert.match(executedSql, /SELECT 1;/);
        assert.equal(lstatSync(snapshotPath).mode & 0o222, 0);
      }
      return { status: 0 };
    };
    const outcome = await runCorpusImport({
      root: fixtureRoot,
      database: 'fixture',
      environment: 'preview',
      remote: true,
      runCommand,
      ownerToken: 'fixture-corpus-owner-20260718',
      timeTravelCollector: () => prechange(),
      ownerAcquirer: () => 1,
      corpusSnapshotFactory: minimalCorpusSnapshotFactory,
      pageEvidenceValidator: () => ({ valid: true, publishable: false }),
      sourceBindingValidator: async () => sealed,
    });
    assert.deepEqual(outcome, { status: 0, phase: 'ready' });
    assert.ok(snapshotPath);
    assert.equal(existsSync(snapshotPath), false, 'private SQL snapshot must be removed after import');
    assert.match(executedSql, new RegExp(sqlSha256));
    assert.match(executedSql, new RegExp(`${sqlBytes.length},CURRENT_TIMESTAMP`));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('empty chunk selection releases the acquired owner and removes the corpus snapshot', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'corpus-import-empty-selection-fixture-'));
  const chunkDirectory = join(fixtureRoot, 'data', 'corpus-chunks');
  let snapshotRoot = null;
  try {
    await mkdir(chunkDirectory, { recursive: true });
    const sqlBytes = Buffer.from('SELECT 1;\n');
    const sealed = manifest({
      sql_files: [{
        name: '000-core.sql',
        sha256: createHash('sha256').update(sqlBytes).digest('hex'),
        bytes: sqlBytes.length,
      }],
    });
    await writeFile(join(chunkDirectory, '000-core.sql'), sqlBytes);
    await writeFile(join(chunkDirectory, 'manifest.json'), `${JSON.stringify(sealed, null, 2)}\n`);
    const calls = [];
    await assert.rejects(runCorpusImport({
      root: fixtureRoot,
      database: 'fixture',
      environment: 'preview',
      remote: true,
      from: 1,
      runCommand: (_root, _database, _environment, args) => {
        calls.push(args);
        return { status: 0 };
      },
      ownerToken: 'fixture-corpus-owner-20260718',
      timeTravelCollector: () => prechange(),
      ownerAcquirer: () => 1,
      corpusSnapshotFactory: async (options) => {
        const snapshot = await minimalCorpusSnapshotFactory(options);
        snapshotRoot = snapshot.root;
        return snapshot;
      },
      pageEvidenceValidator: () => ({ valid: true, publishable: false }),
      sourceBindingValidator: async () => sealed,
    }), /no corpus SQL files selected/);
    assert.ok(calls.some((args) => args[0] === '--command'
      && /UPDATE corpus_import_ownership SET expires_unix/.test(args[1])));
    assert.equal(existsSync(snapshotRoot), false, 'empty-selection corpus snapshot must be removed');
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('remote importer fails the release when its private SQL snapshot changes during execution', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'corpus-import-snapshot-drift-fixture-'));
  const chunkDirectory = join(fixtureRoot, 'data', 'corpus-chunks');
  try {
    await mkdir(chunkDirectory, { recursive: true });
    const sqlBytes = Buffer.from('SELECT 1;\n');
    const sealed = manifest({
      sql_files: [{
        name: '000-core.sql',
        sha256: createHash('sha256').update(sqlBytes).digest('hex'),
        bytes: sqlBytes.length,
      }],
    });
    await writeFile(join(chunkDirectory, '000-core.sql'), sqlBytes);
    await writeFile(join(chunkDirectory, 'manifest.json'), `${JSON.stringify(sealed, null, 2)}\n`);

    const calls = [];
    let snapshotPath = null;
    const runCommand = (_root, _database, _environment, args) => {
      calls.push(args);
      if (args[0] === '--file') {
        snapshotPath = args[1];
        chmodSync(snapshotPath, 0o600);
        writeFileSync(snapshotPath, 'SELECT drift;\n');
      }
      return { status: 0 };
    };
    await assert.rejects(runCorpusImport({
      root: fixtureRoot,
      database: 'fixture',
      environment: 'preview',
      remote: true,
      runCommand,
      ownerToken: 'fixture-corpus-owner-20260718',
      timeTravelCollector: () => prechange(),
      ownerAcquirer: () => 1,
      corpusSnapshotFactory: minimalCorpusSnapshotFactory,
      pageEvidenceValidator: () => ({ valid: true, publishable: false }),
      sourceBindingValidator: async () => sealed,
    }), /private SQL snapshot became unstable/);
    assert.ok(snapshotPath);
    assert.equal(existsSync(snapshotPath), false, 'unstable private SQL snapshot must be removed');
    const failure = calls.find((args) => args[0] === '--command'
      && /chunk_snapshot_unstable:000-core\.sql/.test(args[1]));
    assert.ok(failure, 'release must receive a fail-closed snapshot-integrity status');
    assert.equal(calls.some((args) => args[0] === '--command'
      && /INSERT INTO corpus_import_chunks/.test(args[1])), false);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('a transport-level failure report cannot downgrade an already activated release', async () => {
  const db = await database();
  seedOldCorpus(db);
  const next = manifest();
  const options = acquireOwner(db, next);
  db.exec(buildCorpusImportStartSql(next, options));
  importCurrentOneParagraph(db, next.release_id);
  recordAllChunks(db, next, options);
  db.exec(buildCorpusImportFinalizeSql(next, options));
  assert.throws(
    () => db.exec(buildCorpusImportFailureSql(next, 'ambiguous_client_failure', options)),
    /CHECK constraint failed/,
  );

  assert.equal(db.prepare('SELECT state FROM corpus_import_releases WHERE release_id=?').get(next.release_id).state, 'ready');
  assert.equal(db.prepare("SELECT value FROM site_meta WHERE key='corpus_import_state'").get().value, 'ready');
});

test('shortened corpus removes unreferenced stale rows, preserves discussion rows closed, and preserves stable row ids', async () => {
  const db = await database();
  const seeded = seedOldCorpus(db);
  const next = manifest();
  const options = acquireOwner(db, next);
  db.exec(`INSERT INTO rate_limits(bucket,actor_hash,window_start,count) VALUES('fixture','actor',1,3);
    INSERT INTO ai_citation_logs(
      id,actor_hash,query_hash,retrieved_paragraph_ids,cited_paragraph_ids,model_label,status
    ) VALUES('ai-log-1','actor','query','[]','[]','fixture','ok');`);
  db.exec(buildCorpusImportStartSql(next, options));
  assert.equal(db.prepare("SELECT value FROM site_meta WHERE key='corpus_import_state'").get().value, 'in_progress');
  importCurrentOneParagraph(db, next.release_id);
  recordAllChunks(db, next, options);
  db.exec(buildCorpusImportFinalizeSql(next, options));

  assert.equal(db.prepare("SELECT value FROM site_meta WHERE key='corpus_import_state'").get().value, 'ready');
  assert.equal(db.prepare("SELECT id FROM paragraphs WHERE document_id='doc-a' AND ordinal=1").get().id, seeded.stableParagraphId);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM paragraphs WHERE ordinal=2").get().n, 0);
  const preserved = db.prepare('SELECT display_allowed,citation_allowed,corpus_release_id FROM paragraphs WHERE id=?')
    .get(seeded.protectedParagraph);
  assert.deepEqual({ ...preserved }, { display_allowed: 0, citation_allowed: 0, corpus_release_id: seeded.oldRelease });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM comments WHERE id='comment-1'").get().n, 1);
  const preservedVerification = db.prepare("SELECT paragraph_id,citation_allowed FROM online_verifications WHERE id='verification-protected'").get();
  assert.deepEqual({ ...preservedVerification }, { paragraph_id: seeded.protectedParagraph, citation_allowed: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paragraph_fts').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM page_publication_gates').get().n, 1);
  assert.equal(db.prepare("SELECT count FROM rate_limits WHERE bucket='fixture'").get().count, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_citation_logs WHERE id='ai-log-1'").get().n, 1);
});

test('nonzero legacy tables stop an import before release state mutates', async (t) => {
  const fixtures = {
    subjects: "INSERT INTO subjects(id,name,family,color) VALUES('legacy-subject','遗留','遗留','#000')",
    document_relations: "INSERT INTO document_relations(source_document_id,target_document_id,relation_type) VALUES('doc-a','doc-a','informs')",
    chapters: "INSERT INTO chapters(document_id,ordinal,title) VALUES('doc-a',1,'遗留章')",
    version_diffs: "INSERT INTO version_diffs(id,subject,from_document_id,to_document_id,dimension,summary,evidence_json) VALUES('legacy-diff','语文','doc-a','doc-a','goal','遗留','[]')",
  };
  for (const [table, statement] of Object.entries(fixtures)) {
    await t.test(table, async () => {
      const db = await database();
      seedOldCorpus(db);
      db.exec(statement);
      const next = manifest();
      const options = acquireOwner(db, next);
      assert.throws(() => db.exec(buildCorpusImportStartSql(next, options)), /CHECK constraint failed/);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM corpus_import_releases WHERE release_id=?').get(next.release_id).n, 0);
      assert.notEqual(db.prepare("SELECT value FROM site_meta WHERE key='corpus_import_state'").get().value, 'in_progress');
    });
  }
});

test('drift in a release-owned core table prevents finalization', async () => {
  const db = await database();
  seedOldCorpus(db);
  const next = manifest();
  const options = acquireOwner(db, next);
  db.exec(buildCorpusImportStartSql(next, options));
  importCurrentOneParagraph(db, next.release_id);
  db.exec(`INSERT INTO document_sources(
    document_id,provider,source_page_url,source_url,access_status,is_primary
  ) VALUES('doc-a','镜像','https://example.test/page-2','https://example.test/file-2','verified_online',0)`);
  recordAllChunks(db, next, options);
  assert.throws(() => db.exec(buildCorpusImportFinalizeSql(next, options)), /CHECK constraint failed/);
  assert.equal(db.prepare('SELECT state FROM corpus_import_releases WHERE release_id=?').get(next.release_id).state, 'in_progress');
});

test('interrupted or count-mixed release cannot become ready', async () => {
  const db = await database();
  seedOldCorpus(db);
  const next = manifest({ paragraphs: 2, fts_rows: 2, displayed_paragraphs: 2 });
  const options = acquireOwner(db, next);
  db.exec(buildCorpusImportStartSql(next, options));
  importCurrentOneParagraph(db, next.release_id);
  recordAllChunks(db, next, options);
  assert.throws(() => db.exec(buildCorpusImportFinalizeSql(next, options)), /CHECK constraint failed/);
  if (db.isTransaction) db.exec('ROLLBACK');
  assert.equal(db.prepare("SELECT value FROM site_meta WHERE key='corpus_import_state'").get().value, 'in_progress');
  db.exec(buildCorpusImportFailureSql(next, 'fixture_count_mismatch', options));
  assert.equal(db.prepare("SELECT value FROM site_meta WHERE key='corpus_import_state'").get().value, 'failed');
});

test('accepted OCR count cannot be claimed without an imported OCR page gate', async () => {
  const db = await database();
  seedOldCorpus(db);
  const forged = manifest({ accepted_ocr_documents: 1 });
  const options = acquireOwner(db, forged);
  db.exec(buildCorpusImportStartSql(forged, options));
  importCurrentOneParagraph(db, forged.release_id);
  recordAllChunks(db, forged, options);
  assert.throws(() => db.exec(buildCorpusImportFinalizeSql(forged, options)), /CHECK constraint failed/);
  if (db.isTransaction) db.exec('ROLLBACK');
  assert.equal(db.prepare("SELECT state FROM corpus_import_releases WHERE release_id=?").get(forged.release_id).state, 'in_progress');
});

test('missing or drifted SQL chunk receipts keep a release closed', async () => {
  const db = await database();
  seedOldCorpus(db);
  const next = manifest();
  const options = acquireOwner(db, next);
  db.exec(buildCorpusImportStartSql(next, options));
  importCurrentOneParagraph(db, next.release_id);
  assert.throws(() => db.exec(buildCorpusImportFinalizeSql(next, options)), /CHECK constraint failed/);
  assert.equal(db.prepare("SELECT state FROM corpus_import_releases WHERE release_id=?").get(next.release_id).state, 'in_progress');
});

test('worker fails closed on every D1-backed route while a release is not ready', () => {
  assert.match(worker, /await requireCorpusReady\(env\);/);
  assert.match(worker, /资料库正在进行一致性更新/);
  assert.match(worker, /corpusReleaseReady\(corpus\)/);
});
