ALTER TABLE documents ADD COLUMN corpus_release_id TEXT;
ALTER TABLE paragraphs ADD COLUMN corpus_release_id TEXT;
ALTER TABLE page_publication_gates ADD COLUMN corpus_release_id TEXT;
ALTER TABLE online_verifications ADD COLUMN corpus_release_id TEXT;

CREATE INDEX IF NOT EXISTS idx_documents_corpus_release
  ON documents(corpus_release_id, id);
CREATE INDEX IF NOT EXISTS idx_paragraphs_corpus_release
  ON paragraphs(corpus_release_id, document_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_page_publication_corpus_release
  ON page_publication_gates(corpus_release_id, document_id, page_number);
CREATE INDEX IF NOT EXISTS idx_online_verifications_corpus_release
  ON online_verifications(corpus_release_id, document_id, physical_page);

CREATE TABLE IF NOT EXISTS corpus_import_releases (
  release_id TEXT PRIMARY KEY,
  release_fingerprint_sha256 TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in_progress', 'ready', 'failed')),
  expected_documents INTEGER NOT NULL CHECK (expected_documents >= 0),
  expected_paragraphs INTEGER NOT NULL CHECK (expected_paragraphs >= 0),
  expected_fts_rows INTEGER NOT NULL CHECK (expected_fts_rows >= 0),
  expected_page_gates INTEGER NOT NULL CHECK (expected_page_gates >= 0),
  expected_displayed_paragraphs INTEGER NOT NULL CHECK (expected_displayed_paragraphs >= 0),
  accepted_ocr_documents INTEGER NOT NULL CHECK (accepted_ocr_documents >= 0),
  expected_chunks INTEGER NOT NULL CHECK (expected_chunks >= 0),
  expected_core_counts_json TEXT NOT NULL CHECK (
    json_valid(expected_core_counts_json) AND json_type(expected_core_counts_json) = 'object'
  ),
  actual_documents INTEGER,
  actual_paragraphs INTEGER,
  actual_fts_rows INTEGER,
  actual_page_gates INTEGER,
  actual_displayed_paragraphs INTEGER,
  actual_chunks INTEGER,
  actual_core_counts_json TEXT CHECK (
    actual_core_counts_json IS NULL
    OR (json_valid(actual_core_counts_json) AND json_type(actual_core_counts_json) = 'object')
  ),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ready_at TEXT,
  failure_reason TEXT
);

CREATE TABLE IF NOT EXISTS corpus_import_chunks (
  release_id TEXT NOT NULL REFERENCES corpus_import_releases(release_id) ON DELETE CASCADE,
  chunk_name TEXT NOT NULL,
  chunk_sha256 TEXT NOT NULL CHECK (length(chunk_sha256) = 64),
  chunk_bytes INTEGER NOT NULL CHECK (chunk_bytes > 0),
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (release_id, chunk_name)
);

-- D1 rejects CREATE TEMP TABLE and explicit transaction statements. Wrangler executes
-- each multi-statement command atomically, so a persistent checked guard aborts the batch.
CREATE TABLE IF NOT EXISTS corpus_import_guards (
  guard_key TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK (ok = 1)
);

-- Existing installations remain readable while the first release-aware rebuild is prepared.
-- The bootstrap id is replaced atomically by scripts/import-corpus.mjs on the next import.
UPDATE documents SET corpus_release_id = 'legacy-bootstrap-0006' WHERE corpus_release_id IS NULL;
UPDATE paragraphs SET corpus_release_id = 'legacy-bootstrap-0006' WHERE corpus_release_id IS NULL;
UPDATE page_publication_gates SET corpus_release_id = 'legacy-bootstrap-0006' WHERE corpus_release_id IS NULL;
UPDATE online_verifications SET corpus_release_id = 'legacy-bootstrap-0006' WHERE corpus_release_id IS NULL;

INSERT OR IGNORE INTO corpus_import_releases(
  release_id, release_fingerprint_sha256, manifest_sha256, state,
  expected_documents, expected_paragraphs, expected_fts_rows, expected_page_gates,
  expected_displayed_paragraphs, accepted_ocr_documents, expected_chunks, expected_core_counts_json,
  actual_documents, actual_paragraphs, actual_fts_rows, actual_page_gates,
  actual_displayed_paragraphs, actual_chunks, actual_core_counts_json, ready_at
)
SELECT
  'legacy-bootstrap-0006',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000',
  'ready',
  (SELECT COUNT(*) FROM documents),
  (SELECT COUNT(*) FROM paragraphs),
  (SELECT COUNT(*) FROM paragraph_fts),
  (SELECT COUNT(*) FROM page_publication_gates),
  (SELECT COUNT(*) FROM paragraphs WHERE display_allowed = 1),
  CAST(COALESCE((SELECT value FROM site_meta WHERE key = 'accepted_ocr_document_count'), '0') AS INTEGER),
  0,
  json_object(
    'subjects', (SELECT COUNT(*) FROM subjects),
    'periods', (SELECT COUNT(*) FROM periods),
    'document_relations', (SELECT COUNT(*) FROM document_relations),
    'chapters', (SELECT COUNT(*) FROM chapters),
    'document_classifications', (SELECT COUNT(*) FROM document_classifications),
    'document_sources', (SELECT COUNT(*) FROM document_sources),
    'primary_document_sources', (SELECT COUNT(*) FROM document_sources WHERE is_primary = 1),
    'subject_insights', (SELECT COUNT(*) FROM subject_insights),
    'terms', (SELECT COUNT(*) FROM terms),
    'term_relations', (SELECT COUNT(*) FROM term_relations),
    'version_diffs', (SELECT COUNT(*) FROM version_diffs),
    'online_verifications', (SELECT COUNT(*) FROM online_verifications),
    'online_evidence', (SELECT COUNT(*) FROM online_evidence)
  ),
  (SELECT COUNT(*) FROM documents),
  (SELECT COUNT(*) FROM paragraphs),
  (SELECT COUNT(*) FROM paragraph_fts),
  (SELECT COUNT(*) FROM page_publication_gates),
  (SELECT COUNT(*) FROM paragraphs WHERE display_allowed = 1),
  0,
  json_object(
    'subjects', (SELECT COUNT(*) FROM subjects),
    'periods', (SELECT COUNT(*) FROM periods),
    'document_relations', (SELECT COUNT(*) FROM document_relations),
    'chapters', (SELECT COUNT(*) FROM chapters),
    'document_classifications', (SELECT COUNT(*) FROM document_classifications),
    'document_sources', (SELECT COUNT(*) FROM document_sources),
    'primary_document_sources', (SELECT COUNT(*) FROM document_sources WHERE is_primary = 1),
    'subject_insights', (SELECT COUNT(*) FROM subject_insights),
    'terms', (SELECT COUNT(*) FROM terms),
    'term_relations', (SELECT COUNT(*) FROM term_relations),
    'version_diffs', (SELECT COUNT(*) FROM version_diffs),
    'online_verifications', (SELECT COUNT(*) FROM online_verifications),
    'online_evidence', (SELECT COUNT(*) FROM online_evidence)
  ),
  CURRENT_TIMESTAMP;

INSERT OR REPLACE INTO site_meta(key, value) VALUES
  ('corpus_import_schema_version', '1'),
  ('corpus_import_state', 'ready'),
  ('current_corpus_release_id', 'legacy-bootstrap-0006'),
  ('current_corpus_manifest_sha256', '0000000000000000000000000000000000000000000000000000000000000000');
