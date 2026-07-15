PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS subjects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  family TEXT NOT NULL,
  color TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS periods (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  start_year INTEGER NOT NULL,
  end_year INTEGER,
  summary TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  stage TEXT NOT NULL,
  document_type TEXT NOT NULL,
  version_label TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  issued_date TEXT,
  published_date TEXT,
  current_status TEXT NOT NULL,
  source_tier TEXT NOT NULL,
  access_status TEXT NOT NULL,
  source_page_url TEXT NOT NULL,
  source_url TEXT NOT NULL,
  file_format TEXT NOT NULL,
  redistribution TEXT NOT NULL,
  checksum_sha256 TEXT,
  note TEXT,
  period_id TEXT REFERENCES periods(id),
  sort_year INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_documents_subject ON documents(subject);
CREATE INDEX IF NOT EXISTS idx_documents_stage ON documents(stage);
CREATE INDEX IF NOT EXISTS idx_documents_year ON documents(sort_year);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(current_status);

CREATE TABLE IF NOT EXISTS document_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('supersedes','revises','implements','informs','contemporary_with')),
  note TEXT,
  UNIQUE(source_document_id, target_document_id, relation_type)
);

CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  page_start INTEGER,
  UNIQUE(document_id, ordinal)
);

CREATE TABLE IF NOT EXISTS paragraphs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
  ordinal INTEGER NOT NULL,
  page_number INTEGER,
  heading TEXT,
  body TEXT NOT NULL,
  source_locator TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  UNIQUE(document_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_paragraphs_document ON paragraphs(document_id, ordinal);

CREATE VIRTUAL TABLE IF NOT EXISTS paragraph_fts USING fts5(
  body,
  heading,
  document_id UNINDEXED,
  paragraph_id UNINDEXED,
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS paragraphs_ai AFTER INSERT ON paragraphs BEGIN
  INSERT INTO paragraph_fts(rowid, body, heading, document_id, paragraph_id)
  VALUES (new.id, new.body, COALESCE(new.heading, ''), new.document_id, new.id);
END;

CREATE TRIGGER IF NOT EXISTS paragraphs_ad AFTER DELETE ON paragraphs BEGIN
  DELETE FROM paragraph_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS paragraphs_au AFTER UPDATE ON paragraphs BEGIN
  DELETE FROM paragraph_fts WHERE rowid = old.id;
  INSERT INTO paragraph_fts(rowid, body, heading, document_id, paragraph_id)
  VALUES (new.id, new.body, COALESCE(new.heading, ''), new.document_id, new.id);
END;

CREATE TABLE IF NOT EXISTS subject_insights (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  era TEXT NOT NULL,
  dimension TEXT NOT NULL CHECK (dimension IN ('goal','content','task','requirement','evaluation','quality','concept')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_document_ids TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_insights_subject ON subject_insights(subject, sort_order);

CREATE TABLE IF NOT EXISTS terms (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  definition TEXT NOT NULL,
  first_seen_year INTEGER,
  category TEXT NOT NULL,
  evidence_document_ids TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS term_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_term_id TEXT NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  target_term_id TEXT NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  evidence_document_ids TEXT NOT NULL,
  UNIQUE(source_term_id, target_term_id, relation_type)
);

CREATE TABLE IF NOT EXISTS version_diffs (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  from_document_id TEXT NOT NULL REFERENCES documents(id),
  to_document_id TEXT NOT NULL REFERENCES documents(id),
  dimension TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'editor_reviewed'
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  paragraph_id INTEGER REFERENCES paragraphs(id) ON DELETE CASCADE,
  author_slug TEXT,
  author_name TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('authenticated','anonymous')),
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','deleted')),
  moderation_note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_comments_scope ON comments(document_id, paragraph_id, status, created_at);

CREATE TABLE IF NOT EXISTS comment_reports (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  reporter_slug TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT NOT NULL,
  actor_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY(bucket, actor_hash, window_start)
);

CREATE TABLE IF NOT EXISTS ai_citation_logs (
  id TEXT PRIMARY KEY,
  actor_hash TEXT,
  query_hash TEXT NOT NULL,
  subject_filter TEXT,
  retrieved_paragraph_ids TEXT NOT NULL,
  cited_paragraph_ids TEXT NOT NULL,
  model_label TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS content_audit_log (
  id TEXT PRIMARY KEY,
  actor_slug TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS site_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO periods(id, label, start_year, end_year, summary, sort_order) VALUES
  ('foundation', '国家课程体系奠基', 1950, 1985, '从课程标准转向统一教学大纲，建立新中国基础教育课程框架。', 1),
  ('compulsory', '义务教育制度化', 1986, 2000, '围绕义务教育法与九年义务教育课程计划形成分科教学大纲体系。', 2),
  ('new-curriculum', '新课程改革', 2001, 2010, '从知识本位走向三维目标、学习方式转变与课程标准实验。', 3),
  ('standards', '课程标准深化', 2011, 2016, '义务教育课程标准修订，强化学科实践和评价建议。', 4),
  ('competencies', '核心素养与学业质量', 2017, NULL, '高中与义务教育课程标准以核心素养、学业质量和教—学—评一致性重构。', 5);

INSERT OR REPLACE INTO site_meta(key, value) VALUES
  ('schema_version', '1'),
  ('data_class', 'teacher_owned'),
  ('source_policy', 'primary_official_fail_closed'),
  ('site_key', 'curriculum');
