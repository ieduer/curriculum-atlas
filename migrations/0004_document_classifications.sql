CREATE TABLE IF NOT EXISTS document_classifications (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('subject', 'scope')),
  canonical_subject TEXT,
  subject_family TEXT,
  scope_kind TEXT,
  scope_label TEXT,
  source_subject_label TEXT NOT NULL,
  decision_basis TEXT NOT NULL,
  reviewed_at TEXT,
  CHECK (
    (entity_kind = 'subject' AND canonical_subject IS NOT NULL AND TRIM(canonical_subject) != '')
    OR
    (entity_kind != 'subject' AND canonical_subject IS NULL AND scope_kind IS NOT NULL AND scope_label IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_document_classifications_subject
  ON document_classifications(entity_kind, canonical_subject, document_id);
CREATE INDEX IF NOT EXISTS idx_document_classifications_scope
  ON document_classifications(scope_kind, scope_label, document_id);

INSERT INTO document_classifications(
  document_id, entity_kind, canonical_subject, subject_family, scope_kind, scope_label,
  source_subject_label, decision_basis, reviewed_at
)
SELECT
  id,
  CASE
    WHEN id IN ('ictr-d692b0ff2e6c', 'ictr-197f8a2e1cca') THEN 'subject'
    WHEN subject IN ('综合', '课程方案', '考试大纲', '考试评价', '艺术与劳动') THEN 'scope'
    ELSE 'scope'
  END,
  CASE
    WHEN id = 'ictr-d692b0ff2e6c' THEN '思想品德'
    WHEN id = 'ictr-197f8a2e1cca' THEN '音乐'
    ELSE NULL
  END,
  CASE
    WHEN id = 'ictr-d692b0ff2e6c' THEN '思想品德'
    WHEN id = 'ictr-197f8a2e1cca' THEN '音乐'
    ELSE NULL
  END,
  CASE
    WHEN subject = '课程方案' THEN 'curriculum_framework'
    WHEN subject = '考试大纲' THEN 'assessment_framework'
    WHEN subject = '考试评价' THEN 'evaluation_framework'
    WHEN subject = '综合' AND (title LIKE '%课程方案%' OR title LIKE '%课程设置%' OR title LIKE '%课程计划%') THEN 'curriculum_framework'
    WHEN subject = '综合' THEN 'cross_subject'
    WHEN subject = '艺术与劳动' THEN 'subject_collection'
    ELSE 'unclassified'
  END,
  CASE
    WHEN subject = '课程方案' THEN '课程方案'
    WHEN subject = '考试大纲' THEN '考试大纲'
    WHEN subject = '考试评价' THEN '考试评价'
    WHEN subject = '综合' AND (title LIKE '%课程方案%' OR title LIKE '%课程设置%' OR title LIKE '%课程计划%') THEN '课程方案'
    WHEN subject = '综合' THEN COALESCE(NULLIF(document_type, ''), '跨学科范围')
    WHEN subject = '艺术与劳动' THEN '艺术与劳动汇编'
    ELSE subject || '（分类待导入）'
  END,
  subject,
  CASE
    WHEN id IN ('ictr-d692b0ff2e6c', 'ictr-197f8a2e1cca') THEN 'document_title_reviewed_as_subject_not_raw_comprehensive_label'
    WHEN subject IN ('综合', '课程方案', '考试大纲', '考试评价', '艺术与劳动') THEN 'migration_reserved_scope_label'
    ELSE 'migration_fail_closed_pending_explicit_taxonomy_import'
  END,
  CASE WHEN id IN ('ictr-d692b0ff2e6c', 'ictr-197f8a2e1cca') THEN '2026-07-15' ELSE NULL END
FROM documents
WHERE 1
ON CONFLICT(document_id) DO NOTHING;

INSERT OR REPLACE INTO site_meta(key, value) VALUES
  ('document_classification_schema_version', '1'),
  ('document_classification_policy', 'canonical_subject_facets_fail_closed');
