import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { build } from 'esbuild';

import { buildCompendiumCorpusProjection } from '../scripts/compendium-corpus-projection.mjs';
import { compendiumItemCitationEntitlementSha256 } from '../scripts/compendium-evidence-receipt.mjs';
import {
  verifyCompendiumHeadingEvidence,
  verifyCompendiumItemPageEvidence,
} from '../scripts/compendium-item-publication.mjs';
import {
  buildCorpusChunkReceiptSql,
  buildCorpusImportFinalizeSql,
  buildCorpusImportStartSql,
} from '../scripts/import-corpus.mjs';
import {
  compendiumPageSetSha256,
  validateCompendiumItemBoundaries,
} from '../scripts/validate-compendium-item-boundaries.mjs';

const root = path.resolve(import.meta.dirname, '..');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const copy = (value) => structuredClone(value);

const [baseBoundaries, catalog, queue] = await Promise.all([
  readFile(path.join(root, 'data/compendium-item-boundaries.json'), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'data/catalog.json'), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'data/ocr-queue.json'), 'utf8').then(JSON.parse),
]);

function headingFixture(document, item, pageNumber, label) {
  const primaryBytes = Buffer.from(`# ${label}\n\n课程目标包括识字能力与阅读能力。\n`);
  const sourceImageBytes = Buffer.from(`fixture-image-${pageNumber}`);
  const witnessBytes = Buffer.from(JSON.stringify({
    document_id: document.document_id,
    physical_pdf_page: pageNumber,
    source_pdf_sha256: document.source_artifact_sha256,
    rendered_image_sha256: digest(sourceImageBytes),
    lines: [{ text: label, confidence: 1 }],
  }));
  const acceptedPage = {
    document_id: document.document_id,
    page_number: pageNumber,
    source_artifact_sha256: document.source_artifact_sha256,
    source_page_sha256: digest(sourceImageBytes),
    final_text_sha256: digest(primaryBytes),
    evidence_bundle_sha256: digest(`bundle-${pageNumber}`),
    stable_locator: `${document.document_id}:page:${pageNumber}`,
    display_allowed: true,
    citation_allowed: false,
  };
  item.body_heading = {
    verification_status: 'image_primary_witness_verified',
    physical_page: pageNumber,
    exact_text: label,
    exact_text_sha256: digest(label),
    source_image_sha256: digest(sourceImageBytes),
    primary_ocr_sha256: digest(primaryBytes),
    witness_sha256: digest(witnessBytes),
    reviewer_id: 'reviewer:activated-fixture',
    reviewed_at: '2026-07-18T18:05:00Z',
  };
  verifyCompendiumHeadingEvidence({
    documentBoundary: document,
    item,
    primaryBytes,
    witnessBytes,
    sourceImageBytes,
    acceptedPage,
  });
  return { primaryBytes, sourceImageBytes, witnessBytes, acceptedPage };
}

function activatedBoundaryFixture() {
  const boundaries = copy(baseBoundaries);
  const document = boundaries.documents[0];
  const item = document.items[0];
  const next = document.items[1];
  const releaseId = `page-gate-${'c'.repeat(24)}`;
  const current = headingFixture(document, item, item.candidate_physical_page_start, '钦定蒙学堂章程（摘录）');
  headingFixture(document, next, next.candidate_physical_page_start, '钦定小学堂章程（摘录）');
  next.identity_status = 'body_boundary_verified';

  const rawPages = [current.primaryBytes.toString('utf8')];
  const boundPages = [current.acceptedPage];
  const primaryItemTextSha256 = digest(rawPages.join('\f'));
  const onlineTextSha256 = digest('same-edition-online-full-item-text');
  const sourceId = 'online:activated-item-fixture';
  const pageSetSha256 = compendiumPageSetSha256({
    documentId: document.document_id,
    sourceArtifactSha256: document.source_artifact_sha256,
    pagePublicationReleaseId: releaseId,
    physicalPageStart: item.candidate_physical_page_start,
    physicalPageEnd: item.candidate_physical_page_end,
    pages: boundPages,
  });
  item.page_evidence = {
    verification_status: 'all_pages_citation_verified',
    page_publication_release_id: releaseId,
    physical_page_start: item.candidate_physical_page_start,
    physical_page_end: item.candidate_physical_page_end,
    accepted_page_count: boundPages.length,
    page_set_sha256: pageSetSha256,
    item_citation_entitlement_sha256: compendiumItemCitationEntitlementSha256({
      itemId: item.item_id,
      parentDocumentId: document.document_id,
      sourceArtifactSha256: document.source_artifact_sha256,
      pageSetSha256,
      primaryItemTextSha256,
      onlineTextSha256,
      onlineSourceIds: [sourceId],
    }),
  };
  item.online_verification = {
    verification_status: 'same_edition_exact_text_verified',
    version_relation: 'same_work_same_edition',
    source_ids: [sourceId],
    comparison_scope: 'full_item_text',
    primary_item_text_sha256: primaryItemTextSha256,
    online_text_sha256: onlineTextSha256,
    reviewer_id: 'reviewer:activated-fixture',
    reviewed_at: '2026-07-18T18:06:00Z',
    verification_note: 'Activated fixture binds the complete item text to the exact edition.',
    uncertainty_note: null,
  };
  item.identity_status = 'verified_full_item';
  item.display_allowed = true;
  item.citation_allowed = true;
  item.semantic_claim_allowed = false;

  const onlineVerifications = {
    samples: [{
      id: sourceId,
      document_id: document.document_id,
      contained_document: item.raw_title,
      edition_match_status: 'exact_document_exact_edition',
      verification_status: 'verified_exact',
      primary_ocr_sha256: primaryItemTextSha256,
      online_text_sha256: onlineTextSha256,
      citation_allowed: true,
    }],
  };
  const validation = validateCompendiumItemBoundaries(boundaries, {
    catalog,
    queue,
    onlineVerifications,
  });
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.deepEqual(validation.counts, {
    documents: 1,
    items: 61,
    display_allowed: 1,
    citation_allowed: 1,
    semantic_claim_allowed: 0,
  });
  const evidence = verifyCompendiumItemPageEvidence({
    documentBoundary: document,
    item,
    boundPages,
    rawPages,
    currentPagePublicationReleaseId: releaseId,
  });
  assert.equal(evidence.item_citation_entitlement_sha256, item.page_evidence.item_citation_entitlement_sha256);
  return { boundaries, document, item, sourceId, boundPage: current.acceptedPage };
}

async function migratedDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON;');
  const migrations = (await readdir(path.join(root, 'migrations'))).filter((name) => name.endsWith('.sql')).sort();
  for (const name of migrations) db.exec(await readFile(path.join(root, 'migrations', name), 'utf8'));
  return db;
}

function corpusManifest() {
  const projection = {
    schema_version: 1,
    release_id: `corpus-${'b'.repeat(24)}`,
    release_fingerprint_sha256: 'b'.repeat(64),
    documents: 1,
    paragraphs: 1,
    fts_rows: 1,
    page_publication_gates: 1,
    displayed_paragraphs: 1,
    accepted_ocr_documents: 1,
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
      online_verifications: 1,
      online_evidence: 0,
      embedded_items: 1,
    },
    text_asset_count: 1,
    text_assets: [{ document_id: 'legacy-compendium-chinese', sha256: 'e'.repeat(64), bytes: 1 }],
    sql_chunks: 1,
    sql_files: [{ name: '000-core.sql', sha256: 'f'.repeat(64), bytes: 1 }],
  };
  return {
    ...projection,
    manifest_sha256: digest(JSON.stringify(projection)),
  };
}

function d1Adapter(db) {
  return {
    prepare(sql) {
      const state = { values: [] };
      return {
        bind(...values) {
          state.values = values;
          return this;
        },
        async all() {
          return { results: db.prepare(sql).all(...state.values) };
        },
        async first() {
          return db.prepare(sql).get(...state.values) || null;
        },
      };
    },
  };
}

async function bundledRetrieve() {
  const result = await build({
    entryPoints: [path.join(root, 'src/retrieval.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`)
    .then((module) => module.retrieve);
}

async function bundledWorker() {
  const result = await build({
    entryPoints: [path.join(root, 'src/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`)
    .then((module) => module.default);
}

test('activated item remains independently citable from verified receipts through D1 retrieval', async () => {
  const { boundaries, document, item, sourceId, boundPage } = activatedBoundaryFixture();
  const manifest = corpusManifest();
  const projection = buildCompendiumCorpusProjection(boundaries, manifest.release_id);
  assert.equal(projection.rows.length, 1);
  const projectedItem = projection.rows[0];
  assert.equal(projectedItem.id, item.item_id);
  assert.equal(projectedItem.issuing_body, null);
  assert.equal(projectedItem.citation_allowed, 1);

  const db = await migratedDatabase();
  db.exec(buildCorpusImportStartSql(manifest));
  db.prepare(`INSERT INTO documents(
    id,title,subject,stage,document_type,version_label,issued_by,current_status,source_tier,
    access_status,source_page_url,source_url,file_format,redistribution,checksum_sha256,
    period_id,sort_year,text_quality_status,citation_allowed,page_count,corpus_release_id
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    document.document_id, '汇编载体', '语文', '小学', '课程标准汇编', '汇编版', '课程教材研究所',
    'historical', 'archival_scan', 'verified_local', 'https://example.test/page', 'https://example.test/file',
    'pdf', 'metadata_only', document.source_artifact_sha256, 'foundation', 1902, 'ocr_required', 0,
    document.physical_page_count, manifest.release_id,
  );
  db.prepare(`INSERT INTO document_classifications(
    document_id,entity_kind,taxonomy_entity_kind,canonical_subject,display_facet,subject_family,
    scope_kind,scope_label,source_subject_label,decision_basis
  ) VALUES(?,'subject','subject','语文','语文','语文',NULL,NULL,'语文','activated_fixture')`).run(document.document_id);
  db.prepare(`INSERT INTO document_sources(
    document_id,provider,source_page_url,source_url,checksum_sha256,access_status,is_primary
  ) VALUES(?,'课程教材研究所','https://example.test/page','https://example.test/file',?,'verified_local',1)`).run(
    document.document_id, document.source_artifact_sha256,
  );
  db.prepare(`INSERT INTO online_verifications(
    id,document_id,entity_type,entity_label,edition_match_status,verification_status,resolution,
    citation_allowed,reviewed_by,corpus_release_id
  ) VALUES(?,?,'embedded_item',?,'exact_document_exact_edition','verified_exact','full_item_exact',1,
    'reviewer:activated-fixture',?)`).run(sourceId, document.document_id, item.title, manifest.release_id);
  db.prepare(`INSERT INTO embedded_items(
    id,parent_document_id,parent_item_id,sequence,item_kind,title,raw_title,stage,display_year,year_basis,
    physical_page_start,physical_page_end,printed_page_start,issuing_body,identity_status,
    page_publication_release_id,page_set_sha256,item_citation_entitlement_sha256,
    online_verification_status,online_source_ids_json,display_allowed,citation_allowed,
    semantic_claim_allowed,uncertainty_note,corpus_release_id
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    projectedItem.id, projectedItem.parent_document_id, projectedItem.parent_item_id, projectedItem.sequence,
    projectedItem.item_kind, projectedItem.title, projectedItem.raw_title, projectedItem.stage,
    projectedItem.display_year, projectedItem.year_basis, projectedItem.physical_page_start,
    projectedItem.physical_page_end, projectedItem.printed_page_start, projectedItem.issuing_body,
    projectedItem.identity_status, projectedItem.page_publication_release_id, projectedItem.page_set_sha256,
    projectedItem.item_citation_entitlement_sha256, projectedItem.online_verification_status,
    projectedItem.online_source_ids_json, projectedItem.display_allowed, projectedItem.citation_allowed,
    projectedItem.semantic_claim_allowed, projectedItem.uncertainty_note, projectedItem.corpus_release_id,
  );
  db.prepare(`INSERT INTO page_publication_gates(
    document_id,page_number,source_artifact_sha256,source_page_sha256,final_text_sha256,
    evidence_bundle_sha256,stable_locator,publication_basis,review_status,display_allowed,
    citation_allowed,corpus_release_id
  ) VALUES(?,?,?,?,?,?,?,'accepted_ocr_page_manifest','accepted',1,0,?)`).run(
    document.document_id, boundPage.page_number, boundPage.source_artifact_sha256,
    boundPage.source_page_sha256, boundPage.final_text_sha256, boundPage.evidence_bundle_sha256,
    boundPage.stable_locator, manifest.release_id,
  );
  const body = '课程目标包括识字能力、阅读能力与语言文字运用。';
  db.prepare(`INSERT INTO paragraphs(
    document_id,ordinal,page_number,heading,body,source_locator,body_sha256,text_quality_status,
    citation_allowed,display_allowed,source_artifact_sha256,source_page_sha256,page_final_text_sha256,
    evidence_bundle_sha256,provenance_locator,corpus_release_id,embedded_item_id
  ) VALUES(?,1,?,?,?,?,?,'verified_ocr_item',1,1,?,?,?,?,?,?,?)`).run(
    document.document_id, boundPage.page_number, item.title, body, '第3页', digest(body),
    boundPage.source_artifact_sha256, boundPage.source_page_sha256, boundPage.final_text_sha256,
    boundPage.evidence_bundle_sha256, `${item.item_id}:page:${boundPage.page_number}:paragraph:1`,
    manifest.release_id, item.item_id,
  );
  db.exec(buildCorpusChunkReceiptSql(manifest, '000-core.sql'));
  db.exec(buildCorpusImportFinalizeSql(manifest));
  assert.equal(db.prepare('SELECT state FROM corpus_import_releases WHERE release_id=?').get(manifest.release_id).state, 'ready');

  const retrieve = await bundledRetrieve();
  const results = await retrieve({ DB: d1Adapter(db) }, {
    query: '识字能力',
    subject: '语文',
    stage: '小学',
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].document_id, item.item_id);
  assert.equal(results[0].parent_document_id, document.document_id);
  assert.equal(results[0].embedded_item_id, item.item_id);
  assert.equal(results[0].title, item.title);
  assert.equal(results[0].version_label, '1902');

  const worker = await bundledWorker();
  const itemResponse = await worker.fetch(new Request(
    `https://curriculum.example/api/items/${encodeURIComponent(item.item_id)}`,
  ), {
    DB: d1Adapter(db),
    ENVIRONMENT: 'test',
    SITE_ORIGIN: 'https://curriculum.example',
    ASSETS: { fetch: async () => new Response('not used') },
    SOURCES: {},
    APIS: {},
    USER_CENTER: {},
  });
  assert.equal(itemResponse.status, 200);
  const itemDetail = await itemResponse.json();
  assert.equal(itemDetail.item.id, item.item_id);
  assert.equal(itemDetail.item.issued_by, null);
  assert.equal(itemDetail.discussionDocumentId, document.document_id);
  assert.equal(itemDetail.paragraphs.length, 1);
  assert.equal(itemDetail.verifications.length, 1);
  assert.equal(itemDetail.verifications[0].id, sourceId);

  db.prepare('UPDATE embedded_items SET citation_allowed=0,item_citation_entitlement_sha256=NULL WHERE id=?').run(item.item_id);
  assert.deepEqual(await retrieve({ DB: d1Adapter(db) }, { query: '识字能力', subject: '语文' }), []);
});

test('activated item finalizer binds every cited source id to an exact-edition D1 verification', async () => {
  const { boundaries } = activatedBoundaryFixture();
  const manifest = corpusManifest();
  const projected = buildCompendiumCorpusProjection(boundaries, manifest.release_id).rows[0];
  const db = await migratedDatabase();
  assert.equal(projected.citation_allowed, 1);
  assert.match(buildCorpusImportFinalizeSql(manifest), /JOIN json_each\(ei\.online_source_ids_json\)/);
  assert.match(buildCorpusImportFinalizeSql(manifest), /ov\.verification_status='verified_exact'/);
  db.close();
});
