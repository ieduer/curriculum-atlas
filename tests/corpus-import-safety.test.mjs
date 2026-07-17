import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  buildParagraphIdentityGuardSql,
  buildCorpusImportFailureSql,
  buildCorpusImportFinalizeSql,
  buildCorpusImportStartSql,
  buildCorpusChunkReceiptSql,
  CORE_TABLE_COUNT_KEYS,
  runCorpusFinalization,
  validateCorpusManifest,
} from '../scripts/import-corpus.mjs';

const root = new URL('../', import.meta.url);
const builder = await readFile(new URL('scripts/build-corpus.mjs', root), 'utf8');
const worker = await readFile(new URL('src/index.ts', root), 'utf8');

function manifest(overrides = {}) {
  const projection = {
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
    ...overrides,
  };
  return {
    ...projection,
    manifest_sha256: createHash('sha256').update(JSON.stringify(projection)).digest('hex'),
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
    document_id,entity_kind,canonical_subject,subject_family,scope_kind,scope_label,
    source_subject_label,decision_basis
  ) VALUES('doc-a','subject','语文','语文',NULL,NULL,'语文','fixture');
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

function recordAllChunks(db, value) {
  for (const chunk of value.sql_files) db.exec(buildCorpusChunkReceiptSql(value, chunk.name));
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
  for (const command of [
    buildCorpusImportStartSql(manifest()),
    buildCorpusImportFailureSql(manifest()),
    buildCorpusImportFinalizeSql(manifest()),
  ]) {
    assert.doesNotMatch(command, /\b(?:BEGIN|COMMIT|SAVEPOINT|ROLLBACK)\b/i);
  }
});

test('FTS release invariants use indexed rowid identity instead of the UNINDEXED paragraph_id column', () => {
  const finalize = buildCorpusImportFinalizeSql(manifest());
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

test('a transport-level failure report cannot downgrade an already activated release', async () => {
  const db = await database();
  seedOldCorpus(db);
  const next = manifest();
  db.exec(buildCorpusImportStartSql(next));
  importCurrentOneParagraph(db, next.release_id);
  recordAllChunks(db, next);
  db.exec(buildCorpusImportFinalizeSql(next));
  db.exec(buildCorpusImportFailureSql(next, 'ambiguous_client_failure'));

  assert.equal(db.prepare('SELECT state FROM corpus_import_releases WHERE release_id=?').get(next.release_id).state, 'ready');
  assert.equal(db.prepare("SELECT value FROM site_meta WHERE key='corpus_import_state'").get().value, 'ready');
});

test('shortened corpus removes unreferenced stale rows, preserves discussion rows closed, and preserves stable row ids', async () => {
  const db = await database();
  const seeded = seedOldCorpus(db);
  const next = manifest();
  db.exec(`INSERT INTO rate_limits(bucket,actor_hash,window_start,count) VALUES('fixture','actor',1,3);
    INSERT INTO ai_citation_logs(
      id,actor_hash,query_hash,retrieved_paragraph_ids,cited_paragraph_ids,model_label,status
    ) VALUES('ai-log-1','actor','query','[]','[]','fixture','ok');`);
  db.exec(buildCorpusImportStartSql(next));
  assert.equal(db.prepare("SELECT value FROM site_meta WHERE key='corpus_import_state'").get().value, 'in_progress');
  importCurrentOneParagraph(db, next.release_id);
  recordAllChunks(db, next);
  db.exec(buildCorpusImportFinalizeSql(next));

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
      assert.throws(() => db.exec(buildCorpusImportStartSql(next)), /CHECK constraint failed/);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM corpus_import_releases WHERE release_id=?').get(next.release_id).n, 0);
      assert.notEqual(db.prepare("SELECT value FROM site_meta WHERE key='corpus_import_state'").get().value, 'in_progress');
    });
  }
});

test('drift in a release-owned core table prevents finalization', async () => {
  const db = await database();
  seedOldCorpus(db);
  const next = manifest();
  db.exec(buildCorpusImportStartSql(next));
  importCurrentOneParagraph(db, next.release_id);
  db.exec(`INSERT INTO document_sources(
    document_id,provider,source_page_url,source_url,access_status,is_primary
  ) VALUES('doc-a','镜像','https://example.test/page-2','https://example.test/file-2','verified_online',0)`);
  recordAllChunks(db, next);
  assert.throws(() => db.exec(buildCorpusImportFinalizeSql(next)), /CHECK constraint failed/);
  assert.equal(db.prepare('SELECT state FROM corpus_import_releases WHERE release_id=?').get(next.release_id).state, 'in_progress');
});

test('interrupted or count-mixed release cannot become ready', async () => {
  const db = await database();
  seedOldCorpus(db);
  const next = manifest({ paragraphs: 2, fts_rows: 2 });
  db.exec(buildCorpusImportStartSql(next));
  importCurrentOneParagraph(db, next.release_id);
  recordAllChunks(db, next);
  assert.throws(() => db.exec(buildCorpusImportFinalizeSql(next)), /CHECK constraint failed/);
  if (db.isTransaction) db.exec('ROLLBACK');
  assert.equal(db.prepare("SELECT value FROM site_meta WHERE key='corpus_import_state'").get().value, 'in_progress');
  db.exec(buildCorpusImportFailureSql(next, 'fixture_count_mismatch'));
  assert.equal(db.prepare("SELECT value FROM site_meta WHERE key='corpus_import_state'").get().value, 'failed');
});

test('accepted OCR count cannot be claimed without an imported OCR page gate', async () => {
  const db = await database();
  seedOldCorpus(db);
  const forged = manifest({ accepted_ocr_documents: 1 });
  db.exec(buildCorpusImportStartSql(forged));
  importCurrentOneParagraph(db, forged.release_id);
  recordAllChunks(db, forged);
  assert.throws(() => db.exec(buildCorpusImportFinalizeSql(forged)), /CHECK constraint failed/);
  if (db.isTransaction) db.exec('ROLLBACK');
  assert.equal(db.prepare("SELECT state FROM corpus_import_releases WHERE release_id=?").get(forged.release_id).state, 'in_progress');
});

test('missing or drifted SQL chunk receipts keep a release closed', async () => {
  const db = await database();
  seedOldCorpus(db);
  const next = manifest();
  db.exec(buildCorpusImportStartSql(next));
  importCurrentOneParagraph(db, next.release_id);
  assert.throws(() => db.exec(buildCorpusImportFinalizeSql(next)), /CHECK constraint failed/);
  assert.equal(db.prepare("SELECT state FROM corpus_import_releases WHERE release_id=?").get(next.release_id).state, 'in_progress');
});

test('worker fails closed on every D1-backed route while a release is not ready', () => {
  assert.match(worker, /await requireCorpusReady\(env\);/);
  assert.match(worker, /资料库正在进行一致性更新/);
  assert.match(worker, /corpusReleaseReady\(corpus\)/);
});
