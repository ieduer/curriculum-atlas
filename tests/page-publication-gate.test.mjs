import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import {
  bindAcceptedOcrDocument,
  isNativeTextRecord,
  paragraphProvenanceLocator,
  sha256Text,
  validatePagePublicationManifest,
} from '../scripts/page-publication-gate.mjs';

const root = new URL('../', import.meta.url);
const SOURCE_SHA = 'a'.repeat(64);
const PAGE_SHA_1 = 'b'.repeat(64);
const PAGE_SHA_2 = 'c'.repeat(64);
const EVIDENCE_SHA_1 = 'd'.repeat(64);
const EVIDENCE_SHA_2 = 'e'.repeat(64);
const EMPTY_CORE_TABLE_COUNTS_JSON = JSON.stringify({
  subjects: 0,
  periods: 0,
  document_relations: 0,
  chapters: 0,
  document_classifications: 0,
  document_sources: 0,
  primary_document_sources: 0,
  subject_insights: 0,
  terms: 0,
  term_relations: 0,
  version_diffs: 0,
  online_verifications: 0,
  online_evidence: 0,
  embedded_items: 0,
});

function manifestFor(rawPages, pageOverrides = []) {
  return {
    schema_version: 1,
    policy: 'fail_closed_page_publication_v1',
    documents: [{
      document_id: 'ocr-document',
      source_artifact_sha256: SOURCE_SHA,
      acceptance_status: 'accepted_page_manifest',
      reviewed_by: 'editorial-review',
      reviewed_at: '2026-07-16T14:00:00.000Z',
      pages: rawPages.map((text, index) => ({
        page_number: index + 1,
        source_page_sha256: index === 0 ? PAGE_SHA_1 : PAGE_SHA_2,
        final_text_sha256: sha256Text(text),
        evidence_bundle_sha256: index === 0 ? EVIDENCE_SHA_1 : EVIDENCE_SHA_2,
        stable_locator: `ocr-document:page:${index + 1}`,
        review_status: 'accepted',
        ...pageOverrides[index],
      })),
    }],
  };
}

async function loadWorker() {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('src/index.ts', root))],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  });
  const encoded = Buffer.from(bundle.outputFiles[0].text).toString('base64');
  return (await import(`data:text/javascript;base64,${encoded}`)).default;
}

test('manifest flags default closed and bind exact OCR page provenance', () => {
  const rawPages = ['第一页最终文本\n', '第二页最终文本\n'];
  const manifest = validatePagePublicationManifest(manifestFor(rawPages, [
    { display_allowed: true },
    undefined,
  ]));
  assert.equal(manifest.documents[0].pages[0].display_allowed, true);
  assert.equal(manifest.documents[0].pages[0].citation_allowed, false);
  assert.equal(manifest.documents[0].pages[1].display_allowed, false);
  assert.equal(manifest.documents[0].pages[1].citation_allowed, false);

  const pages = bindAcceptedOcrDocument({
    record: { id: 'ocr-document', page_count: 2 },
    sourceArtifactSha256: SOURCE_SHA,
    rawPages,
    manifestDocument: manifest.documents[0],
    documentCitationAllowed: false,
  });
  assert.deepEqual(pages.map((page) => page.display_allowed), [true, false]);
  assert.deepEqual(pages.map((page) => page.citation_allowed), [false, false]);
  assert.equal(pages[0].source_artifact_sha256, SOURCE_SHA);
  assert.equal(pages[0].source_page_sha256, PAGE_SHA_1);
  assert.equal(pages[0].page_final_text_sha256, sha256Text(rawPages[0]));
  assert.equal(pages[0].evidence_bundle_sha256, EVIDENCE_SHA_1);
  assert.equal(pages[0].stable_locator, 'ocr-document:page:1');
});

test('accepted OCR manifests fail closed on source, page-count, text, or citation drift', () => {
  const rawPages = ['第一页最终文本\n', '第二页最终文本\n'];
  const manifest = validatePagePublicationManifest(manifestFor(rawPages));
  const base = {
    record: { id: 'ocr-document', page_count: 2 },
    sourceArtifactSha256: SOURCE_SHA,
    rawPages,
    manifestDocument: manifest.documents[0],
    documentCitationAllowed: false,
  };
  assert.throws(
    () => bindAcceptedOcrDocument({ ...base, sourceArtifactSha256: 'f'.repeat(64) }),
    /source artifact hash drift/,
  );
  assert.throws(
    () => bindAcceptedOcrDocument({ ...base, rawPages: [rawPages[0]] }),
    /page count does not match/,
  );
  assert.throws(
    () => bindAcceptedOcrDocument({ ...base, rawPages: ['漂移文本', rawPages[1]] }),
    /page 1 final text hash drift/,
  );

  const citationManifest = validatePagePublicationManifest(manifestFor(rawPages, [
    { display_allowed: true, citation_allowed: true },
    undefined,
  ]));
  assert.throws(
    () => bindAcceptedOcrDocument({ ...base, manifestDocument: citationManifest.documents[0] }),
    /citation is open while the document gate is closed/,
  );
});

test('manifest requires contiguous pages, stable locators, evidence hashes, and uncertainty notes', () => {
  const rawPages = ['第一页最终文本\n'];
  const missingPage = manifestFor(rawPages);
  missingPage.documents[0].pages[0].page_number = 2;
  assert.throws(() => validatePagePublicationManifest(missingPage), /contiguous 1-based page number/);

  const wrongLocator = manifestFor(rawPages);
  wrongLocator.documents[0].pages[0].stable_locator = 'unstable';
  assert.throws(() => validatePagePublicationManifest(wrongLocator), /stable_locator must equal/);

  const unresolved = manifestFor(rawPages);
  unresolved.documents[0].pages[0].review_status = 'unresolved_fail_closed';
  assert.throws(() => validatePagePublicationManifest(unresolved), /uncertainty_note is required/);

  const noEvidence = manifestFor(rawPages);
  noEvidence.documents[0].pages[0].evidence_bundle_sha256 = '';
  assert.throws(() => validatePagePublicationManifest(noEvidence), /evidence_bundle_sha256/);
});

test('native-text classification preserves verified native corpus behavior', () => {
  assert.equal(isNativeTextRecord({ id: 'native', text_quality_status: 'official_native_text', file_format: 'pdf' }), true);
  assert.equal(isNativeTextRecord({ id: 'zip', file_format: 'pdf_in_zip' }), false);
  assert.equal(isNativeTextRecord({ id: 'neea-2019-01', file_format: 'pdf' }), false);
  assert.equal(isNativeTextRecord({ id: 'ocr', text_quality_status: 'ocr_required', file_format: 'pdf_in_zip' }), false);

  const bodySha = sha256Text('段落正文');
  assert.equal(
    paragraphProvenanceLocator('ocr-document', 2, 4, bodySha),
    `ocr-document:page:2:block:4:body:${bodySha}`,
  );
});

test('builder and migration encode fail-closed display defaults and complete OCR provenance', async () => {
  const [builder, migration, schema, seedManifest] = await Promise.all([
    readFile(new URL('scripts/build-corpus.mjs', root), 'utf8'),
    readFile(new URL('migrations/0005_page_publication_gate.sql', root), 'utf8'),
    readFile(new URL('data/page-publication-manifest.schema.json', root), 'utf8').then(JSON.parse),
    readFile(new URL('data/page-publication-manifest.json', root), 'utf8').then(JSON.parse),
  ]);

  assert.equal(schema.properties.schema_version.const, 1);
  assert.deepEqual(seedManifest.documents, []);
  assert.match(migration, /display_allowed INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS page_publication_gates/);
  assert.match(migration, /paragraphs_fail_closed_citation_insert/);
  assert.match(migration, /NEW\.display_allowed = 0 AND NEW\.citation_allowed != 0/);
  assert.match(migration, /text_quality_status = 'official_native_text'/);
  assert.match(builder, /if \(!nativeText && !acceptedOcrDocument\)[\s\S]*?continue;/);
  assert.match(builder, /bindAcceptedOcrDocument/);
  assert.match(builder, /source_artifact_sha256,source_page_sha256,page_final_text_sha256,evidence_bundle_sha256,provenance_locator/);
  assert.match(builder, /UPDATE paragraphs SET display_allowed=0,citation_allowed=0/);
});

test('migration preserves native visibility and coerces legacy or omitted OCR citation closed', async () => {
  const migrationUrls = [
    'migrations/0001_initial.sql',
    'migrations/0002_source_provenance_and_ocr_quality.sql',
    'migrations/0003_online_verification.sql',
    'migrations/0004_document_classifications.sql',
    'migrations/0005_page_publication_gate.sql',
  ];
  const migrations = await Promise.all(migrationUrls.map((path) => readFile(new URL(path, root), 'utf8')));
  const database = new DatabaseSync(':memory:');
  try {
    for (const migration of migrations.slice(0, 4)) database.exec(migration);
    database.exec(`
      INSERT INTO documents(
        id,title,subject,stage,document_type,version_label,issued_by,current_status,source_tier,
        access_status,source_page_url,source_url,file_format,redistribution,checksum_sha256,
        text_quality_status,citation_allowed
      ) VALUES
        ('native-doc','Native','语文','高中','标准','1','MOE','current','primary','verified',
         'https://example/native','https://example/native','html','metadata','${'a'.repeat(64)}',
         'official_native_text',1),
        ('ocr-doc','OCR','语文','高中','标准','1','MOE','current','primary','verified',
         'https://example/ocr','https://example/ocr','pdf','metadata','${'b'.repeat(64)}',
         'ocr_required',0);
      INSERT INTO paragraphs(
        document_id,ordinal,body,source_locator,body_sha256,text_quality_status,citation_allowed
      ) VALUES
        ('native-doc',1,'native body','p1','${'c'.repeat(64)}','official_native_text',1),
        ('ocr-doc',1,'legacy ocr body','p1','${'d'.repeat(64)}','ocr_required',1);
    `);
    database.exec(migrations[4]);
    database.exec(`
      INSERT INTO paragraphs(document_id,ordinal,body,source_locator,body_sha256,text_quality_status)
      VALUES('ocr-doc',2,'new ocr body','p2','${'e'.repeat(64)}','ocr_required');
      UPDATE paragraphs SET citation_allowed=1 WHERE document_id='ocr-doc' AND ordinal=2;
    `);

    const rows = database.prepare(`
      SELECT document_id,ordinal,display_allowed,citation_allowed
      FROM paragraphs ORDER BY document_id,ordinal
    `).all().map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      { document_id: 'native-doc', ordinal: 1, display_allowed: 1, citation_allowed: 1 },
      { document_id: 'ocr-doc', ordinal: 1, display_allowed: 0, citation_allowed: 0 },
      { document_id: 'ocr-doc', ordinal: 2, display_allowed: 0, citation_allowed: 0 },
    ]);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM paragraph_fts').get().count, 3);
  } finally {
    database.close();
  }
});

test('document detail API filters closed paragraphs and returns provenance only for open rows', async () => {
  const worker = await loadWorker();
  const openParagraph = {
    id: 1,
    body: '公开段落',
    display_allowed: 1,
    source_artifact_sha256: SOURCE_SHA,
    source_page_sha256: PAGE_SHA_1,
    page_final_text_sha256: sha256Text('第一页最终文本\n'),
    evidence_bundle_sha256: EVIDENCE_SHA_1,
    provenance_locator: 'ocr-document:page:1:block:1:body:hash',
  };
  const closedParagraph = { id: 2, body: '关闭段落', display_allowed: 0 };
  let paragraphSql = '';
  const env = {
    DB: {
      prepare(sql) {
        let values = [];
        return {
          bind(...nextValues) {
            values = nextValues;
            return this;
          },
          async first() {
            if (sql.includes('FROM corpus_import_releases r')) return {
              release_id: 'corpus-test-ready',
              manifest_sha256: 'a'.repeat(64),
              state: 'ready',
              expected_documents: 1,
              expected_paragraphs: 1,
              expected_fts_rows: 1,
              expected_page_gates: 1,
              expected_displayed_paragraphs: 1,
              accepted_ocr_documents: 0,
              expected_chunks: 1,
              expected_core_counts_json: EMPTY_CORE_TABLE_COUNTS_JSON,
              actual_documents: 1,
              actual_paragraphs: 1,
              actual_fts_rows: 1,
              actual_page_gates: 1,
              actual_displayed_paragraphs: 1,
              actual_chunks: 1,
              actual_core_counts_json: EMPTY_CORE_TABLE_COUNTS_JSON,
              live_documents: 1,
              live_paragraphs: 1,
              live_fts_rows: 1,
              live_page_gates: 1,
              live_displayed_paragraphs: 1,
              live_accepted_ocr_documents: 0,
              live_chunks: 1,
              live_core_counts_json: EMPTY_CORE_TABLE_COUNTS_JSON,
            };
            if (sql.includes('FROM documents d JOIN document_classifications')) {
              assert.equal(values[0], 'ocr-document');
              return { id: 'ocr-document', title: '测试资料' };
            }
            return null;
          },
          async all() {
            if (sql.includes('FROM paragraphs')) {
              paragraphSql = sql;
              return {
                results: sql.includes('display_allowed = 1')
                  ? [openParagraph]
                  : [openParagraph, closedParagraph],
              };
            }
            return { results: [] };
          },
        };
      },
    },
    SOURCES: {},
    APIS: {},
    USER_CENTER: {},
    ASSETS: { fetch: async () => new Response('asset') },
    ENVIRONMENT: 'test',
  };

  const response = await worker.fetch(new Request('https://curriculum.example/api/documents/ocr-document'), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const body = await response.json();
  assert.deepEqual(body.paragraphs.map((paragraph) => paragraph.id), [1]);
  assert.match(paragraphSql, /WHERE p\.document_id = \? AND p\.display_allowed = 1/);
  assert.match(paragraphSql, /p\.source_artifact_sha256,p\.source_page_sha256,p\.page_final_text_sha256,p\.evidence_bundle_sha256,p\.provenance_locator/);
});
