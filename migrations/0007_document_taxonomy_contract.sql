CREATE TABLE document_classifications_v2 (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('subject', 'scope')),
  taxonomy_entity_kind TEXT NOT NULL CHECK (taxonomy_entity_kind IN (
    'subject', 'assessment_subject', 'curriculum_course', 'assessment_domain',
    'source_collection', 'cross_cutting_framework', 'unclassified'
  )),
  canonical_subject TEXT,
  display_facet TEXT CHECK (display_facet IS NULL OR display_facet IN (
    '语文', '数学', '外语', '思想政治与道德法治', '历史', '历史与社会',
    '地理', '科学类', '技术', '劳动', '艺术', '体育与健康'
  )),
  subject_family TEXT,
  scope_kind TEXT,
  scope_label TEXT,
  source_subject_label TEXT NOT NULL,
  decision_basis TEXT NOT NULL,
  reviewed_at TEXT,
  CHECK (
    (
      entity_kind = 'subject'
      AND taxonomy_entity_kind IN ('subject', 'assessment_subject')
      AND canonical_subject IS NOT NULL AND TRIM(canonical_subject) != ''
      AND display_facet IS NOT NULL
      AND scope_kind IS NULL AND scope_label IS NULL
    )
    OR
    (
      entity_kind = 'scope'
      AND taxonomy_entity_kind IN (
        'curriculum_course', 'assessment_domain', 'source_collection',
        'cross_cutting_framework', 'unclassified'
      )
      AND canonical_subject IS NULL AND display_facet IS NULL
      AND scope_kind IS NOT NULL AND scope_label IS NOT NULL
    )
  )
);

INSERT INTO document_classifications_v2(
  document_id, entity_kind, taxonomy_entity_kind, canonical_subject, display_facet,
  subject_family, scope_kind, scope_label, source_subject_label, decision_basis, reviewed_at
)
SELECT
  document_id,
  entity_kind,
  CASE
    WHEN entity_kind = 'subject' AND decision_basis = 'concept_model_v2:assessment_subject' THEN 'assessment_subject'
    WHEN entity_kind = 'subject' THEN 'subject'
    WHEN scope_kind = 'curriculum_course' THEN 'curriculum_course'
    WHEN scope_kind IN ('assessment_framework', 'evaluation_framework') THEN 'assessment_domain'
    WHEN scope_kind IN ('source_collection', 'subject_collection') THEN 'source_collection'
    WHEN scope_kind = 'unclassified' THEN 'unclassified'
    ELSE 'cross_cutting_framework'
  END,
  canonical_subject,
  CASE
    WHEN canonical_subject IN ('语文', '汉语') THEN '语文'
    WHEN canonical_subject = '数学' THEN '数学'
    WHEN canonical_subject IN ('英语', '俄语', '日语', '西班牙语', '德语', '法语') THEN '外语'
    WHEN canonical_subject IN ('思想政治', '思想品德', '品德与生活', '品德与社会', '道德与法治') THEN '思想政治与道德法治'
    WHEN canonical_subject = '历史' THEN '历史'
    WHEN canonical_subject = '历史与社会' THEN '历史与社会'
    WHEN canonical_subject = '地理' THEN '地理'
    WHEN canonical_subject IN ('科学', '物理', '化学', '生物学') THEN '科学类'
    WHEN canonical_subject IN ('信息科技', '信息技术', '通用技术') THEN '技术'
    WHEN canonical_subject = '劳动' THEN '劳动'
    WHEN canonical_subject IN ('艺术', '音乐', '美术') THEN '艺术'
    WHEN canonical_subject = '体育与健康' THEN '体育与健康'
    ELSE NULL
  END,
  subject_family,
  scope_kind,
  scope_label,
  source_subject_label,
  decision_basis,
  reviewed_at
FROM document_classifications;

DROP TABLE document_classifications;
ALTER TABLE document_classifications_v2 RENAME TO document_classifications;

CREATE INDEX idx_document_classifications_subject
  ON document_classifications(entity_kind, canonical_subject, document_id);
CREATE INDEX idx_document_classifications_scope
  ON document_classifications(scope_kind, scope_label, document_id);
CREATE INDEX idx_document_classifications_display_facet
  ON document_classifications(display_facet, taxonomy_entity_kind, canonical_subject, document_id);
CREATE INDEX idx_document_classifications_taxonomy_identity
  ON document_classifications(taxonomy_entity_kind, canonical_subject, document_id);

INSERT OR REPLACE INTO site_meta(key, value) VALUES
  ('document_classification_schema_version', '2'),
  ('document_classification_policy', 'twelve_display_facets_with_exact_query_identities');
