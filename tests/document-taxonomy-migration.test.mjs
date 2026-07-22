import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { loadDocumentClassificationResolver } from '../scripts/document-classification.mjs';

const root = new URL('../', import.meta.url);
const [catalog, migration, classify] = await Promise.all([
  readFile(new URL('data/catalog.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('migrations/0007_document_taxonomy_contract.sql', root), 'utf8'),
  loadDocumentClassificationResolver(root),
]);

test('0007 migrates all 195 canonical work classifications to the exact v2 taxonomy without identity drift', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE documents(id TEXT PRIMARY KEY);
    CREATE TABLE site_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE document_classifications (
      document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('subject', 'scope')),
      canonical_subject TEXT,
      subject_family TEXT,
      scope_kind TEXT,
      scope_label TEXT,
      source_subject_label TEXT NOT NULL,
      decision_basis TEXT NOT NULL,
      reviewed_at TEXT
    );`);
  const insertDocument = db.prepare('INSERT INTO documents(id) VALUES(?)');
  const insertClassification = db.prepare(`INSERT INTO document_classifications(
    document_id,entity_kind,canonical_subject,subject_family,scope_kind,scope_label,
    source_subject_label,decision_basis,reviewed_at
  ) VALUES(?,?,?,?,?,?,?,?,?)`);
  const expected = new Map();
  for (const document of catalog.documents) {
    const classification = classify(document);
    expected.set(document.id, classification);
    insertDocument.run(document.id);
    insertClassification.run(
      document.id, classification.entity_kind, classification.canonical_subject,
      classification.subject_family, classification.scope_kind, classification.scope_label,
      classification.source_subject_label, classification.decision_basis, classification.reviewed_at,
    );
  }

  db.exec(migration);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  const counts = Object.fromEntries(db.prepare(
    'SELECT taxonomy_entity_kind AS kind,COUNT(*) AS count FROM document_classifications GROUP BY taxonomy_entity_kind',
  ).all().map((row) => [row.kind, Number(row.count)]));
  assert.deepEqual(counts, {
    assessment_domain: 3,
    assessment_subject: 1,
    cross_cutting_framework: 13,
    curriculum_course: 16,
    source_collection: 4,
    subject: 158,
  });
  assert.equal(Number(db.prepare(
    "SELECT COUNT(DISTINCT display_facet) AS count FROM document_classifications WHERE taxonomy_entity_kind='subject'",
  ).get().count), 12);
  assert.equal(Number(db.prepare(
    "SELECT COUNT(DISTINCT canonical_subject) AS count FROM document_classifications WHERE taxonomy_entity_kind='subject'",
  ).get().count), 28);

  for (const row of db.prepare('SELECT * FROM document_classifications ORDER BY document_id').all()) {
    const wanted = expected.get(row.document_id);
    assert.ok(wanted, row.document_id);
    assert.equal(row.taxonomy_entity_kind, wanted.taxonomy_entity_kind, row.document_id);
    assert.equal(row.display_facet, wanted.display_facet, row.document_id);
    assert.equal(row.canonical_subject, wanted.canonical_subject, row.document_id);
    assert.equal(row.scope_kind, wanted.scope_kind, row.document_id);
    assert.equal(row.scope_label, wanted.scope_label, row.document_id);
  }

  const han = db.prepare("SELECT * FROM document_classifications WHERE canonical_subject='汉语'").get();
  assert.equal(han.taxonomy_entity_kind, 'assessment_subject');
  assert.equal(han.display_facet, '语文');
  const technologyCourse = db.prepare("SELECT * FROM document_classifications WHERE scope_label='技术'").get();
  assert.equal(technologyCourse.taxonomy_entity_kind, 'curriculum_course');
  assert.equal(technologyCourse.display_facet, null);
  db.close();
});
