import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  buildCorpusImportFailureSql,
  buildCorpusImportFinalizeSql,
  buildCorpusImportOwnerAcquireSql,
  buildCorpusImportStartSql,
  buildCorpusChunkReceiptSql,
  buildOwnedCorpusChunkSql,
  sealCorpusManifest,
} from '../scripts/import-corpus.mjs';
import {
  buildPublicationActivationClaimAcquireSql,
  buildPublicationActivationClaimReleaseSql,
  buildPublicationLeaseAcquireSql,
  buildPublicationLeaseReleaseSql,
  buildPublicationLeaseRenewSql,
} from '../scripts/publish-metadata.mjs';

const root = new URL('../', import.meta.url);
const ownerA = 'corpus-owner-a-20260718';
const ownerB = 'corpus-owner-b-20260718';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function manifest(character, chunk, { records = 1 } = {}) {
  const fingerprint = character.repeat(64);
  return sealCorpusManifest({
    generated_at: '2026-07-18T00:00:00.000Z',
    schema_version: 1,
    release_id: `corpus-${fingerprint.slice(0, 24)}`,
    release_fingerprint_sha256: fingerprint,
    documents: records,
    paragraphs: records,
    fts_rows: records,
    page_publication_gates: records,
    displayed_paragraphs: records,
    accepted_ocr_documents: 0,
    core_table_counts: {
      subjects: 0,
      periods: 5,
      document_relations: 0,
      chapters: 0,
      document_classifications: records,
      document_sources: records,
      primary_document_sources: records,
      subject_insights: 0,
      terms: 0,
      term_relations: 0,
      version_diffs: 0,
      online_verifications: 0,
      online_evidence: 0,
      embedded_items: 0,
    },
    text_asset_count: records,
    text_assets: records ? [{ document_id: 'doc-a', sha256: 'e'.repeat(64), bytes: 1 }] : [],
    sql_chunks: 1,
    sql_files: [{ name: '000-core.sql', sha256: sha256(chunk), bytes: chunk.length }],
    closed_ocr_paragraphs: 0,
    skipped_ocr_documents: 0,
    excluded_exact_duplicate_alias_documents: 0,
    semantic_excluded_pages: 0,
    page_publication_schema_version: 1,
    semantic_publication_schema_version: 1,
    semantic_publication_revision_sha256: 'd'.repeat(64),
  });
}

function prechange(bookmark) {
  const raw = `${JSON.stringify([{ bookmark, timestamp: '2026-07-18T00:00:00.000Z' }])}\n`;
  return {
    bookmark,
    timestamp: '2026-07-18T00:00:00.000Z',
    sha256: sha256(raw),
    bytes: Buffer.byteLength(raw),
    raw_json: raw,
  };
}

async function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON;');
  const migrations = (await readdir(new URL('migrations/', root))).filter((name) => name.endsWith('.sql')).sort();
  for (const name of migrations) db.exec(await readFile(new URL(`migrations/${name}`, root), 'utf8'));
  return db;
}

function fence(db, table) {
  return Number(db.prepare(`SELECT owner_fence FROM ${table} WHERE id=1`).get().owner_fence);
}

test('SQLite rejects active corpus owners, increments takeover fences, and invalidates every stale mutation path', async () => {
  const db = await database();
  try {
    const chunk = Buffer.from("INSERT INTO site_meta(key,value) VALUES('fenced_chunk_marker','owner-a') ON CONFLICT(key) DO UPDATE SET value=excluded.value;\n");
    const releaseA = manifest('a', chunk);
    const releaseB = manifest('b', chunk);
    db.exec(buildCorpusImportOwnerAcquireSql(releaseA, { ownerToken: ownerA, ttlSeconds: 3600 }));
    assert.equal(fence(db, 'corpus_import_ownership'), 1);
    assert.throws(
      () => db.exec(buildCorpusImportOwnerAcquireSql(releaseA, { ownerToken: ownerB, ttlSeconds: 3600 })),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => db.exec(buildCorpusImportOwnerAcquireSql(releaseB, { ownerToken: ownerB, ttlSeconds: 3600 })),
      /CHECK constraint failed/,
    );
    assert.equal(fence(db, 'corpus_import_ownership'), 1);

    db.exec('UPDATE corpus_import_ownership SET expires_unix=0 WHERE id=1');
    db.exec(buildCorpusImportOwnerAcquireSql(releaseB, { ownerToken: ownerB, ttlSeconds: 3600 }));
    assert.equal(fence(db, 'corpus_import_ownership'), 2);
    for (const staleSql of [
      buildCorpusImportStartSql(releaseA, {
        ownerToken: ownerA, ownerFence: 1, ttlSeconds: 3600, prechange: prechange('bookmark-a'),
      }),
      buildCorpusImportStartSql(releaseA, {
        resume: true, ownerToken: ownerA, ownerFence: 1, ttlSeconds: 3600,
        prechange: prechange('bookmark-a-resume'),
      }),
      buildCorpusImportFailureSql(releaseA, 'stale-failure', {
        ownerToken: ownerA, ownerFence: 1, ttlSeconds: 3600,
      }),
      buildCorpusImportFinalizeSql(releaseA, {
        ownerToken: ownerA, ownerFence: 1, ttlSeconds: 3600,
      }),
    ]) assert.throws(() => db.exec(staleSql), /CHECK constraint failed/);

    db.exec(buildCorpusImportStartSql(releaseB, {
      ownerToken: ownerB, ownerFence: 2, ttlSeconds: 3600, prechange: prechange('bookmark-b'),
    }));
    const receipt = db.prepare(`SELECT prechange_bookmark,prechange_receipt_json,owner_fence
      FROM corpus_import_releases WHERE release_id=?`).get(releaseB.release_id);
    assert.equal(receipt.prechange_bookmark, 'bookmark-b');
    assert.match(receipt.prechange_receipt_json, /bookmark-b/);
    assert.equal(Number(receipt.owner_fence), 2);

    db.exec(buildOwnedCorpusChunkSql(releaseB, '000-core.sql', chunk, {
      ownerToken: ownerB, ownerFence: 2, ttlSeconds: 3600,
    }).toString('utf8'));
    assert.equal(db.prepare("SELECT value FROM site_meta WHERE key='fenced_chunk_marker'").get().value, 'owner-a');
    assert.equal(Number(db.prepare(`SELECT owner_fence FROM corpus_import_chunks
      WHERE release_id=? AND chunk_name='000-core.sql'`).get(releaseB.release_id).owner_fence), 2);

    db.exec('UPDATE corpus_import_ownership SET expires_unix=0 WHERE id=1');
    db.exec(buildCorpusImportOwnerAcquireSql(releaseB, { ownerToken: ownerA, ttlSeconds: 3600 }));
    assert.equal(fence(db, 'corpus_import_ownership'), 3);
    db.exec("UPDATE site_meta SET value='new-owner' WHERE key='fenced_chunk_marker'");
    assert.throws(() => db.exec(buildOwnedCorpusChunkSql(
      releaseB, '000-core.sql', chunk,
      { ownerToken: ownerB, ownerFence: 2, ttlSeconds: 3600 },
    ).toString('utf8')), /CHECK constraint failed/);
    assert.equal(db.prepare("SELECT value FROM site_meta WHERE key='fenced_chunk_marker'").get().value, 'new-owner');

    db.exec(buildCorpusImportStartSql(releaseB, {
      resume: true,
      ownerToken: ownerA,
      ownerFence: 3,
      ttlSeconds: 3600,
      prechange: prechange('bookmark-after-takeover'),
    }));
    const preserved = db.prepare(`SELECT prechange_bookmark,prechange_receipt_json,owner_fence
      FROM corpus_import_releases WHERE release_id=?`).get(releaseB.release_id);
    assert.equal(preserved.prechange_bookmark, 'bookmark-b');
    assert.match(preserved.prechange_receipt_json, /bookmark-b/);
    assert.equal(Number(preserved.owner_fence), 3);
  } finally {
    db.close();
  }
});

test('SQLite publication lease serializes same and different releases and rejects stale renewal after takeover', async () => {
  const db = await database();
  try {
    const releaseA = `release-${'a'.repeat(32)}`;
    const releaseB = `release-${'b'.repeat(32)}`;
    const hashA = 'a'.repeat(64);
    const hashB = 'b'.repeat(64);
    db.exec(buildPublicationLeaseAcquireSql({
      token: ownerA, releaseId: releaseA, manifestSha256: hashA, ttlSeconds: 3600,
    }));
    assert.equal(fence(db, 'release_publication_ownership'), 1);
    assert.throws(() => db.exec(buildPublicationLeaseAcquireSql({
      token: ownerB, releaseId: releaseA, manifestSha256: hashA, ttlSeconds: 3600,
    })), /CHECK constraint failed/);
    assert.throws(() => db.exec(buildPublicationLeaseAcquireSql({
      token: ownerB, releaseId: releaseB, manifestSha256: hashB, ttlSeconds: 3600,
    })), /CHECK constraint failed/);
    db.exec('UPDATE release_publication_ownership SET expires_unix=0 WHERE id=1');
    db.exec(buildPublicationLeaseAcquireSql({
      token: ownerB, releaseId: releaseB, manifestSha256: hashB, ttlSeconds: 3600,
    }));
    assert.equal(fence(db, 'release_publication_ownership'), 2);
    assert.throws(() => db.exec(buildPublicationLeaseRenewSql({
      token: ownerA, releaseId: releaseA, manifestSha256: hashA, ownerFence: 1, ttlSeconds: 3600,
    })), /CHECK constraint failed/);
    const current = db.prepare('SELECT release_id,owner_fence FROM release_publication_ownership WHERE id=1').get();
    assert.equal(current.release_id, releaseB);
    assert.equal(Number(current.owner_fence), 2);
  } finally {
    db.close();
  }
});

test('only the exact current ready corpus with live-count parity is an idempotent no-op', async () => {
  const db = await database();
  try {
    const chunk = Buffer.from("INSERT INTO site_meta(key,value) VALUES('ready_marker','ok') ON CONFLICT(key) DO UPDATE SET value=excluded.value;\n");
    const release = manifest('c', chunk, { records: 0 });
    db.exec(buildCorpusImportOwnerAcquireSql(release, { ownerToken: ownerA, ttlSeconds: 3600 }));
    db.exec(buildCorpusImportStartSql(release, {
      ownerToken: ownerA, ownerFence: 1, ttlSeconds: 3600, prechange: prechange('ready-first'),
    }));
    db.exec(buildCorpusChunkReceiptSql(release, '000-core.sql', null, {
      ownerToken: ownerA, ownerFence: 1, ttlSeconds: 3600,
    }));
    const coreCounts = JSON.stringify(release.core_table_counts);
    db.prepare(`UPDATE corpus_import_releases SET
      state='ready',actual_documents=0,actual_paragraphs=0,actual_fts_rows=0,
      actual_page_gates=0,actual_displayed_paragraphs=0,actual_chunks=1,
      actual_core_counts_json=?,ready_at=CURRENT_TIMESTAMP
      WHERE release_id=?`).run(coreCounts, release.release_id);
    db.prepare(`INSERT OR REPLACE INTO site_meta(key,value) VALUES
      ('current_corpus_release_id',?),
      ('current_corpus_manifest_sha256',?),
      ('corpus_import_state','ready')`).run(release.release_id, release.manifest_sha256);
    db.exec('UPDATE corpus_import_ownership SET expires_unix=0 WHERE id=1');
    db.exec(buildCorpusImportOwnerAcquireSql(release, { ownerToken: ownerB, ttlSeconds: 3600 }));
    const nextFence = fence(db, 'corpus_import_ownership');
    db.exec(buildCorpusImportStartSql(release, {
      ownerToken: ownerB, ownerFence: nextFence, ttlSeconds: 3600, prechange: prechange('ready-rerun'),
    }));
    assert.deepEqual({
      state: db.prepare('SELECT state FROM corpus_import_releases WHERE release_id=?').get(release.release_id).state,
      siteState: db.prepare("SELECT value FROM site_meta WHERE key='corpus_import_state'").get().value,
      receipts: Number(db.prepare('SELECT COUNT(*) AS count FROM corpus_import_chunks WHERE release_id=?').get(release.release_id).count),
    }, { state: 'ready', siteState: 'ready', receipts: 1 });
    db.exec("UPDATE site_meta SET value='corpus-bbbbbbbbbbbbbbbbbbbbbbbb' WHERE key='current_corpus_release_id'");
    db.exec(buildCorpusImportStartSql(release, {
      ownerToken: ownerB, ownerFence: nextFence, ttlSeconds: 3600, prechange: prechange('historical-rerun'),
    }));
    assert.equal(
      db.prepare('SELECT state FROM corpus_import_releases WHERE release_id=?').get(release.release_id).state,
      'in_progress',
      'a historical ready row must not no-op while another corpus is current',
    );
  } finally {
    db.close();
  }
});

test('an active R2 activation claim blocks every acquisition and bounds cleanup failure', async () => {
  const db = await database();
  try {
    const releaseA = `release-${'a'.repeat(32)}`;
    const releaseB = `release-${'b'.repeat(32)}`;
    const hashA = 'a'.repeat(64);
    const hashB = 'b'.repeat(64);
    db.exec(buildPublicationLeaseAcquireSql({
      token: ownerA, releaseId: releaseA, manifestSha256: hashA, ttlSeconds: 3600,
    }));
    db.exec(buildPublicationActivationClaimAcquireSql({
      token: ownerA, releaseId: releaseA, manifestSha256: hashA, ownerFence: 1,
      activationNonce: 'activation-nonce-owner-a-20260718', ttlSeconds: 600,
    }));
    assert.throws(() => db.exec(buildPublicationActivationClaimAcquireSql({
      token: ownerA, releaseId: releaseA, manifestSha256: hashA, ownerFence: 1,
      activationNonce: 'activation-nonce-reentrant-20260718', ttlSeconds: 600,
    })), /CHECK constraint failed|already active/);
    db.exec(buildPublicationActivationClaimReleaseSql({
      token: ownerA, releaseId: releaseA, manifestSha256: hashA, ownerFence: 1,
      activationNonce: 'activation-nonce-not-owner-20260718',
    }));
    assert.equal(
      Number(db.prepare('SELECT COUNT(*) AS count FROM release_publication_activation_claim').get().count),
      1,
      'a non-owner nonce must not delete the active claim',
    );
    assert.throws(() => db.exec(buildPublicationLeaseAcquireSql({
      token: ownerA, releaseId: releaseA, manifestSha256: hashA, ttlSeconds: 3600,
    })), /CHECK constraint failed/);
    db.exec(buildPublicationLeaseReleaseSql({
      token: ownerA, releaseId: releaseA, manifestSha256: hashA, ownerFence: 1,
    }));
    const bounded = db.prepare(`SELECT o.expires_unix AS owner_expiry,c.expires_unix AS claim_expiry
      FROM release_publication_ownership o JOIN release_publication_activation_claim c ON c.id=o.id
      WHERE o.id=1`).get();
    assert.equal(Number(bounded.owner_expiry), Number(bounded.claim_expiry));
    assert.ok(Number(bounded.owner_expiry) > Math.floor(Date.now() / 1000));
    assert.throws(() => db.exec(buildPublicationLeaseAcquireSql({
      token: ownerB, releaseId: releaseB, manifestSha256: hashB, ttlSeconds: 3600,
    })), /CHECK constraint failed/);
    assert.equal(fence(db, 'release_publication_ownership'), 1);
    db.exec(buildPublicationActivationClaimReleaseSql({
      token: ownerA, releaseId: releaseA, manifestSha256: hashA, ownerFence: 1,
      activationNonce: 'activation-nonce-owner-a-20260718',
    }));
    db.exec('UPDATE release_publication_ownership SET expires_unix=0 WHERE id=1');
    db.exec(buildPublicationLeaseAcquireSql({
      token: ownerB, releaseId: releaseB, manifestSha256: hashB, ttlSeconds: 3600,
    }));
    assert.equal(fence(db, 'release_publication_ownership'), 2);
  } finally {
    db.close();
  }
});
