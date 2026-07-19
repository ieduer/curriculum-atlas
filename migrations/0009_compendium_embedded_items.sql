CREATE TABLE IF NOT EXISTS embedded_items (
  id TEXT PRIMARY KEY,
  parent_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  parent_item_id TEXT REFERENCES embedded_items(id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  item_kind TEXT NOT NULL CHECK (item_kind IN ('curriculum_document', 'attachment')),
  title TEXT NOT NULL,
  raw_title TEXT NOT NULL,
  stage TEXT NOT NULL,
  display_year INTEGER NOT NULL CHECK (display_year BETWEEN 1800 AND 2030),
  year_basis TEXT NOT NULL CHECK (year_basis IN ('toc_explicit_year', 'parent_notice_year')),
  physical_page_start INTEGER NOT NULL CHECK (physical_page_start > 0),
  physical_page_end INTEGER NOT NULL CHECK (physical_page_end >= physical_page_start),
  printed_page_start INTEGER NOT NULL CHECK (printed_page_start > 0),
  issuing_body TEXT,
  identity_status TEXT NOT NULL CHECK (identity_status IN ('verified_full_item', 'closed_tombstone')),
  page_publication_release_id TEXT NOT NULL,
  page_set_sha256 TEXT NOT NULL CHECK (length(page_set_sha256) = 64),
  item_citation_entitlement_sha256 TEXT CHECK (
    item_citation_entitlement_sha256 IS NULL OR length(item_citation_entitlement_sha256) = 64
  ),
  online_verification_status TEXT NOT NULL,
  online_source_ids_json TEXT NOT NULL CHECK (
    json_valid(online_source_ids_json) AND json_type(online_source_ids_json) = 'array'
  ),
  display_allowed INTEGER NOT NULL CHECK (display_allowed IN (0, 1)),
  citation_allowed INTEGER NOT NULL CHECK (citation_allowed IN (0, 1)),
  semantic_claim_allowed INTEGER NOT NULL CHECK (semantic_claim_allowed IN (0, 1)),
  uncertainty_note TEXT,
  corpus_release_id TEXT NOT NULL,
  UNIQUE(parent_document_id, corpus_release_id, sequence),
  CHECK (citation_allowed <= display_allowed),
  CHECK (semantic_claim_allowed <= citation_allowed),
  CHECK (
    (identity_status = 'verified_full_item' AND display_allowed = 1)
    OR (
      identity_status = 'closed_tombstone'
      AND display_allowed = 0
      AND citation_allowed = 0
      AND semantic_claim_allowed = 0
      AND item_citation_entitlement_sha256 IS NULL
    )
  ),
  CHECK (
    (citation_allowed = 0 AND item_citation_entitlement_sha256 IS NULL)
    OR (
      citation_allowed = 1
      AND item_citation_entitlement_sha256 IS NOT NULL
      AND online_verification_status = 'same_edition_exact_text_verified'
      AND json_array_length(online_source_ids_json) > 0
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_embedded_items_release
  ON embedded_items(corpus_release_id, parent_document_id, display_year, sequence);
CREATE INDEX IF NOT EXISTS idx_embedded_items_identity
  ON embedded_items(id, citation_allowed, corpus_release_id);

ALTER TABLE paragraphs ADD COLUMN embedded_item_id TEXT REFERENCES embedded_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_paragraphs_embedded_item
  ON paragraphs(embedded_item_id, citation_allowed, ordinal);

-- Existing carrier-level discussions remain NULL-scoped. Item discussions must
-- carry this key and are validated against both the parent document and any
-- referenced paragraph/parent comment by the Worker before insertion.
ALTER TABLE comments ADD COLUMN embedded_item_id TEXT REFERENCES embedded_items(id);
CREATE INDEX IF NOT EXISTS idx_comments_item_scope
  ON comments(document_id, embedded_item_id, paragraph_id, status, created_at);

UPDATE corpus_import_releases
SET expected_core_counts_json = json_set(expected_core_counts_json, '$.embedded_items', 0),
    actual_core_counts_json = CASE
      WHEN actual_core_counts_json IS NULL THEN NULL
      ELSE json_set(actual_core_counts_json, '$.embedded_items', 0)
    END;

INSERT OR REPLACE INTO site_meta(key, value) VALUES
  ('compendium_embedded_item_schema_version', '1'),
  ('compendium_embedded_item_policy', 'verified_full_range_item_scoped_identity_v1');
