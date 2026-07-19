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
  activation_nonce_sha256 TEXT NOT NULL CHECK (length(activation_nonce_sha256) = 64),
  expires_unix INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS release_publication_prefix_state (
  release_id TEXT PRIMARY KEY,
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  owner_fence INTEGER NOT NULL CHECK (owner_fence > 0),
  active_creates INTEGER NOT NULL DEFAULT 0 CHECK (active_creates >= 0),
  sealed INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0,1)),
  activated INTEGER NOT NULL DEFAULT 0 CHECK (activated IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER IF NOT EXISTS release_activation_claim_guard
BEFORE INSERT ON release_publication_activation_claim
BEGIN
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM release_publication_prefix_state
    WHERE release_id=NEW.release_id AND active_creates>0
  ) THEN RAISE(ABORT,'release prefix has active immutable creates') END;
END;

CREATE TRIGGER IF NOT EXISTS release_activation_claim_update_guard
BEFORE UPDATE ON release_publication_activation_claim
BEGIN
  SELECT CASE WHEN OLD.expires_unix>CAST(strftime('%s','now') AS INTEGER)
    THEN RAISE(ABORT,'release activation claim is already active') END;
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM release_publication_prefix_state
    WHERE release_id=NEW.release_id AND active_creates>0
  ) THEN RAISE(ABORT,'release prefix has active immutable creates') END;
END;

CREATE TRIGGER IF NOT EXISTS release_activation_claim_seal
AFTER INSERT ON release_publication_activation_claim
BEGIN
  INSERT INTO release_publication_prefix_state(
    release_id,manifest_sha256,owner_fence,active_creates,sealed,activated,updated_at
  ) VALUES(NEW.release_id,NEW.manifest_sha256,NEW.owner_fence,0,1,0,CURRENT_TIMESTAMP)
  ON CONFLICT(release_id) DO UPDATE SET
    manifest_sha256=excluded.manifest_sha256,
    owner_fence=excluded.owner_fence,
    sealed=1,
    updated_at=CURRENT_TIMESTAMP
  WHERE release_publication_prefix_state.active_creates=0
    AND release_publication_prefix_state.manifest_sha256=excluded.manifest_sha256
    AND release_publication_prefix_state.owner_fence<=excluded.owner_fence;
  UPDATE release_publication_ownership
  SET expires_unix=MIN(expires_unix,NEW.expires_unix),updated_at=CURRENT_TIMESTAMP
  WHERE id=1 AND release_id=NEW.release_id AND manifest_sha256=NEW.manifest_sha256
    AND owner_token_sha256=NEW.owner_token_sha256 AND owner_fence=NEW.owner_fence;
END;

CREATE TRIGGER IF NOT EXISTS release_activation_claim_update_seal
AFTER UPDATE ON release_publication_activation_claim
BEGIN
  INSERT INTO release_publication_prefix_state(
    release_id,manifest_sha256,owner_fence,active_creates,sealed,activated,updated_at
  ) VALUES(NEW.release_id,NEW.manifest_sha256,NEW.owner_fence,0,1,0,CURRENT_TIMESTAMP)
  ON CONFLICT(release_id) DO UPDATE SET
    manifest_sha256=excluded.manifest_sha256,
    owner_fence=excluded.owner_fence,
    sealed=1,
    updated_at=CURRENT_TIMESTAMP
  WHERE release_publication_prefix_state.active_creates=0
    AND release_publication_prefix_state.manifest_sha256=excluded.manifest_sha256
    AND release_publication_prefix_state.owner_fence<=excluded.owner_fence;
  UPDATE release_publication_ownership
  SET expires_unix=MIN(expires_unix,NEW.expires_unix),updated_at=CURRENT_TIMESTAMP
  WHERE id=1 AND release_id=NEW.release_id AND manifest_sha256=NEW.manifest_sha256
    AND owner_token_sha256=NEW.owner_token_sha256 AND owner_fence=NEW.owner_fence;
END;

CREATE TRIGGER IF NOT EXISTS release_activation_claim_unseal
AFTER DELETE ON release_publication_activation_claim
BEGIN
  UPDATE release_publication_prefix_state SET sealed=0,updated_at=CURRENT_TIMESTAMP
  WHERE release_id=OLD.release_id AND manifest_sha256=OLD.manifest_sha256
    AND owner_fence=OLD.owner_fence AND activated=0;
END;

INSERT OR REPLACE INTO site_meta(key,value) VALUES
  ('corpus_import_ownership_schema_version','2'),
  ('release_publication_coordination_schema_version','3');
