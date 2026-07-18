ALTER TABLE corpus_import_releases ADD COLUMN owner_token_sha256 TEXT;
ALTER TABLE corpus_import_releases ADD COLUMN owner_fence INTEGER;
ALTER TABLE corpus_import_releases ADD COLUMN owner_expires_unix INTEGER;
ALTER TABLE corpus_import_releases ADD COLUMN prechange_bookmark TEXT;
ALTER TABLE corpus_import_releases ADD COLUMN prechange_timestamp TEXT;
ALTER TABLE corpus_import_releases ADD COLUMN prechange_receipt_sha256 TEXT;
ALTER TABLE corpus_import_releases ADD COLUMN prechange_receipt_bytes INTEGER;
ALTER TABLE corpus_import_releases ADD COLUMN prechange_receipt_json TEXT CHECK (
  prechange_receipt_json IS NULL OR json_valid(prechange_receipt_json)
);

ALTER TABLE corpus_import_chunks ADD COLUMN owner_fence INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS corpus_import_fence_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_fence INTEGER NOT NULL CHECK (last_fence >= 0)
);
INSERT OR IGNORE INTO corpus_import_fence_state(id,last_fence) VALUES(1,0);

CREATE TABLE IF NOT EXISTS corpus_import_ownership (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  release_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  owner_token_sha256 TEXT NOT NULL CHECK (length(owner_token_sha256) = 64),
  owner_fence INTEGER NOT NULL CHECK (owner_fence > 0),
  expires_unix INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS release_publication_fence_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_fence INTEGER NOT NULL CHECK (last_fence >= 0)
);
INSERT OR IGNORE INTO release_publication_fence_state(id,last_fence) VALUES(1,0);

CREATE TABLE IF NOT EXISTS release_publication_ownership (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  release_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  owner_token_sha256 TEXT NOT NULL CHECK (length(owner_token_sha256) = 64),
  owner_fence INTEGER NOT NULL CHECK (owner_fence > 0),
  expires_unix INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS release_publication_activation_claim (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  release_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  owner_token_sha256 TEXT NOT NULL CHECK (length(owner_token_sha256) = 64),
  owner_fence INTEGER NOT NULL CHECK (owner_fence > 0),
  expires_unix INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR REPLACE INTO site_meta(key,value) VALUES
  ('corpus_import_ownership_schema_version','2'),
  ('release_publication_coordination_schema_version','3');
