ALTER TABLE paragraphs ADD COLUMN display_allowed INTEGER NOT NULL DEFAULT 0 CHECK (display_allowed IN (0, 1));
ALTER TABLE paragraphs ADD COLUMN source_artifact_sha256 TEXT;
ALTER TABLE paragraphs ADD COLUMN source_page_sha256 TEXT;
ALTER TABLE paragraphs ADD COLUMN page_final_text_sha256 TEXT;
ALTER TABLE paragraphs ADD COLUMN evidence_bundle_sha256 TEXT;
ALTER TABLE paragraphs ADD COLUMN provenance_locator TEXT;

CREATE INDEX IF NOT EXISTS idx_paragraphs_display_allowed
  ON paragraphs(display_allowed, document_id, ordinal);

CREATE TABLE IF NOT EXISTS page_publication_gates (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL CHECK (page_number > 0),
  source_artifact_sha256 TEXT NOT NULL,
  source_page_sha256 TEXT,
  final_text_sha256 TEXT NOT NULL,
  evidence_bundle_sha256 TEXT,
  stable_locator TEXT NOT NULL,
  publication_basis TEXT NOT NULL CHECK (publication_basis IN ('official_native_text', 'accepted_ocr_page_manifest')),
  review_status TEXT NOT NULL CHECK (review_status IN ('official_native_text', 'accepted', 'unresolved_fail_closed')),
  reviewed_by TEXT,
  reviewed_at TEXT,
  uncertainty_note TEXT,
  display_allowed INTEGER NOT NULL DEFAULT 0 CHECK (display_allowed IN (0, 1)),
  citation_allowed INTEGER NOT NULL DEFAULT 0 CHECK (citation_allowed IN (0, 1)),
  PRIMARY KEY(document_id, page_number),
  CHECK (citation_allowed <= display_allowed)
);

CREATE INDEX IF NOT EXISTS idx_page_publication_display
  ON page_publication_gates(display_allowed, document_id, page_number);

DROP TRIGGER IF EXISTS paragraphs_au;
CREATE TRIGGER paragraphs_au
AFTER UPDATE OF body, heading, document_id ON paragraphs
BEGIN
  DELETE FROM paragraph_fts WHERE rowid = old.id;
  INSERT INTO paragraph_fts(rowid, body, heading, document_id, paragraph_id)
  VALUES (new.id, new.body, COALESCE(new.heading, ''), new.document_id, new.id);
END;

CREATE TRIGGER IF NOT EXISTS paragraphs_fail_closed_citation_insert
AFTER INSERT ON paragraphs
WHEN NEW.display_allowed = 0 AND NEW.citation_allowed != 0
BEGIN
  UPDATE paragraphs SET citation_allowed = 0 WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS paragraphs_fail_closed_citation_update
AFTER UPDATE OF display_allowed, citation_allowed ON paragraphs
WHEN NEW.display_allowed = 0 AND NEW.citation_allowed != 0
BEGIN
  UPDATE paragraphs SET citation_allowed = 0 WHERE id = NEW.id;
END;

UPDATE paragraphs
SET display_allowed = CASE
      WHEN document_id IN (
        SELECT id FROM documents WHERE text_quality_status = 'official_native_text'
      ) THEN 1
      ELSE 0
    END,
    citation_allowed = CASE
      WHEN document_id IN (
        SELECT id FROM documents
        WHERE text_quality_status = 'official_native_text' AND citation_allowed = 1
      ) THEN citation_allowed
      ELSE 0
    END,
    source_artifact_sha256 = (
      SELECT checksum_sha256 FROM documents WHERE documents.id = paragraphs.document_id
    ),
    provenance_locator = document_id || ':legacy-ordinal:' || ordinal;

INSERT OR REPLACE INTO site_meta(key, value) VALUES
  ('page_publication_schema_version', '1'),
  ('page_publication_policy', 'fail_closed_page_publication_v1');
