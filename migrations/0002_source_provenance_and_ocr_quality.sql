ALTER TABLE documents ADD COLUMN text_quality_status TEXT NOT NULL DEFAULT 'not_assessed';
ALTER TABLE documents ADD COLUMN ocr_engine TEXT;
ALTER TABLE documents ADD COLUMN ocr_audit_ref TEXT;
ALTER TABLE documents ADD COLUMN citation_allowed INTEGER NOT NULL DEFAULT 0 CHECK (citation_allowed IN (0, 1));
ALTER TABLE documents ADD COLUMN page_count INTEGER;

ALTER TABLE paragraphs ADD COLUMN text_quality_status TEXT NOT NULL DEFAULT 'native_or_official_text';
ALTER TABLE paragraphs ADD COLUMN ocr_quality_score REAL;
ALTER TABLE paragraphs ADD COLUMN citation_allowed INTEGER NOT NULL DEFAULT 1 CHECK (citation_allowed IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_paragraphs_citation_allowed ON paragraphs(citation_allowed, document_id, ordinal);

CREATE TABLE IF NOT EXISTS document_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  source_page_url TEXT NOT NULL,
  source_url TEXT NOT NULL,
  checksum_sha256 TEXT,
  access_status TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  note TEXT,
  UNIQUE(document_id, source_url)
);

CREATE INDEX IF NOT EXISTS idx_document_sources_document ON document_sources(document_id, is_primary DESC);

UPDATE documents
SET text_quality_status = CASE
      WHEN file_format IN ('html', 'catalog') THEN 'official_native_text'
      WHEN id LIKE 'moe-hs-2020-%' OR id LIKE 'neea-2019-%' THEN 'official_native_text'
      ELSE 'ocr_required'
    END,
    citation_allowed = CASE
      WHEN file_format IN ('html', 'catalog') THEN 1
      WHEN id LIKE 'moe-hs-2020-%' OR id LIKE 'neea-2019-%' THEN 1
      ELSE 0
    END;

INSERT OR REPLACE INTO site_meta(key, value) VALUES
  ('schema_version', '2'),
  ('ocr_policy', 'fail_closed_page_level_cross_engine_and_manual_review');
