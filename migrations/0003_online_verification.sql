ALTER TABLE paragraphs ADD COLUMN online_verification_status TEXT NOT NULL DEFAULT 'not_assessed';
ALTER TABLE paragraphs ADD COLUMN evidence_triad_status TEXT NOT NULL DEFAULT 'not_assessed';
ALTER TABLE paragraphs ADD COLUMN uncertainty_note TEXT;

CREATE TABLE IF NOT EXISTS online_verifications (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  paragraph_id INTEGER REFERENCES paragraphs(id) ON DELETE SET NULL,
  physical_page INTEGER,
  printed_page TEXT,
  entity_type TEXT NOT NULL,
  entity_label TEXT NOT NULL,
  source_image_sha256 TEXT,
  primary_ocr_sha256 TEXT,
  edition_match_status TEXT NOT NULL CHECK (edition_match_status IN (
    'exact_document_exact_edition','exact_document_revision_uncertain','same_work_different_edition','stable_fact_only','not_matched'
  )),
  verification_status TEXT NOT NULL CHECK (verification_status IN (
    'verified_exact','verified_stable_fact_only','version_variant_reference_only','conflict_requires_review','human_judgment_with_warning','unresolved_fail_closed'
  )),
  resolution TEXT NOT NULL,
  uncertainty_note TEXT,
  citation_allowed INTEGER NOT NULL DEFAULT 0 CHECK (citation_allowed IN (0, 1)),
  reviewed_by TEXT NOT NULL,
  reviewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_online_verifications_document
  ON online_verifications(document_id, physical_page, verification_status);

CREATE TABLE IF NOT EXISTS online_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  verification_id TEXT NOT NULL REFERENCES online_verifications(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  publisher TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_title TEXT,
  source_url TEXT NOT NULL,
  published_at TEXT,
  retrieved_at TEXT NOT NULL,
  version_match TEXT NOT NULL CHECK (version_match IN (
    'exact_document_exact_edition','exact_document_revision_uncertain','same_work_different_edition','stable_fact_only','not_matched'
  )),
  fact_summary TEXT NOT NULL,
  content_sha256 TEXT,
  UNIQUE(verification_id, source_url, role)
);

CREATE INDEX IF NOT EXISTS idx_online_evidence_verification ON online_evidence(verification_id);

INSERT OR REPLACE INTO site_meta(key, value) VALUES
  ('schema_version', '3'),
  ('online_verification_policy', 'scan_ocr_online_version_aware_triangulation');
