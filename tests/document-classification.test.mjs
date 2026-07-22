import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fallbackDocumentClassification, loadDocumentClassificationResolver, validateDocumentClassification } from '../scripts/document-classification.mjs';

const root = new URL('../', import.meta.url);
const classify = await loadDocumentClassificationResolver(root);

function record(id, subject, title = `${subject || '未标注'}课程标准`, documentType = '课程标准') {
  return { id, subject, title, document_type: documentType };
}

test('reserved framework, assessment, evaluation, and collection labels fail closed as scopes', () => {
  const cases = [
    ['课程方案', 'cross_cutting_framework', 'curriculum_framework', '课程方案'],
    ['考试大纲', 'assessment_domain', 'assessment_framework', '考试大纲'],
    ['考试评价', 'assessment_domain', 'evaluation_framework', '考试评价'],
    ['艺术与劳动', 'source_collection', 'subject_collection', '音乐美术劳技汇编'],
  ];
  for (const [label, taxonomyEntityKind, scopeKind, scopeLabel] of cases) {
    const value = classify(record(`scope-${label}`, label));
    assert.equal(value.entity_kind, 'scope');
    assert.equal(value.taxonomy_entity_kind, taxonomyEntityKind);
    assert.equal(value.canonical_subject, null);
    assert.equal(value.display_facet, null);
    assert.equal(value.scope_kind, scopeKind);
    assert.equal(value.scope_label, scopeLabel);
    assert.equal(value.source_subject_label, label);
  }
});

test('bare 综合 uses document-level review and otherwise remains outside subject facets', () => {
  const moral = classify(record(
    'ictr-d692b0ff2e6c', '综合', '全日制义务教育思想品德标准（实验稿）',
  ));
  const music = classify(record(
    'ictr-197f8a2e1cca', '综合', '全日制义务教育音乐标准（实验稿）',
  ));
  assert.equal(moral.entity_kind, 'subject');
  assert.equal(moral.canonical_subject, '思想品德');
  assert.equal(moral.display_facet, '思想政治与道德法治');
  assert.equal(moral.source_subject_label, '综合');
  assert.equal(music.entity_kind, 'subject');
  assert.equal(music.canonical_subject, '音乐');
  assert.equal(music.display_facet, '艺术');

  const curriculum = classify(record(
    'ictr-cfb2a39a2016', '综合', '聋校义务教育课程设置实验方案（2007年）',
  ));
  assert.equal(curriculum.entity_kind, 'scope');
  assert.equal(curriculum.scope_kind, 'curriculum_framework');
  assert.equal(curriculum.scope_label, '聋校课程设置方案');

  const overview = classify(record(
    'policy-1950-1993-overview', '综合', '中国基础教育课程沿革官方概述', '官方历史概述',
  ));
  assert.equal(overview.entity_kind, 'scope');
  assert.equal(overview.scope_kind, 'cross_subject');
  assert.equal(overview.scope_label, '课程沿革政策');
});

test('historical names normalize canonically while preserving their source label', () => {
  const cases = [
    ['普通高级中学 体育体育与健康', '体育与健康', '体育与健康', '体育与健康'],
    ['初中科学', '科学', '科学', '科学类'],
    ['文科数学', '数学', '数学', '数学'],
    ['理科数学', '数学', '数学', '数学'],
    ['生物', '生物学', '科学', '科学类'],
    ['生物学', '生物学', '科学', '科学类'],
    ['信息技术', '信息技术', 'information_technology_education', '技术'],
    ['信息科技', '信息科技', 'information_technology_education', '技术'],
  ];
  for (const [source, canonical, family, displayFacet] of cases) {
    const value = classify(record(`subject-${source}`, source));
    assert.equal(value.entity_kind, 'subject');
    assert.equal(value.canonical_subject, canonical);
    assert.equal(value.subject_family, family);
    assert.equal(value.display_facet, displayFacet);
    assert.equal(value.source_subject_label, source);
  }
});

test('missing labels and invalid entity kinds cannot silently become subject facets', () => {
  const missing = fallbackDocumentClassification(record('missing', '', '待核文档'));
  assert.equal(missing.entity_kind, 'scope');
  assert.equal(missing.canonical_subject, null);
  assert.equal(missing.scope_kind, 'unclassified');
  const unknown = fallbackDocumentClassification(record('unknown', '未来未审学科'));
  assert.equal(unknown.entity_kind, 'scope');
  assert.equal(unknown.scope_kind, 'unclassified');
  assert.throws(
    () => validateDocumentClassification({ entity_kind: 'other', scope_kind: 'x', scope_label: 'x' }, record('bad', '综合')),
    /Invalid entity_kind/,
  );
});

test('explicit taxonomy covers the catalog with separate subject, course, and scope semantics', async () => {
  const catalog = JSON.parse(await readFile(new URL('data/catalog.json', root), 'utf8'));
  const rows = catalog.documents.map(classify);
  assert.equal(rows.filter((item) => item.scope_kind === 'unclassified').length, 0);
  const courses = [
    '定向行走', '综合康复', '社会适应', '沟通与交往', '律动', '康复训练', '生活适应', '劳动技能',
    '运动与保健', '艺术休闲', '美工', '绘画与手工', '唱游与律动', '生活语文', '生活数学', '技术',
  ];
  for (const course of courses) {
    const matches = rows.filter((item) => item.source_subject_label === course);
    assert.equal(matches.length, 1, course);
    assert.equal(matches[0].entity_kind, 'scope', course);
    assert.equal(matches[0].taxonomy_entity_kind, 'curriculum_course', course);
    assert.equal(matches[0].scope_kind, 'curriculum_course', course);
  }
  const assessmentSubject = rows.find((item) => item.source_subject_label === '汉语');
  assert.equal(assessmentSubject.entity_kind, 'subject');
  assert.equal(assessmentSubject.taxonomy_entity_kind, 'assessment_subject');
  assert.equal(assessmentSubject.canonical_subject, '汉语');
  assert.equal(assessmentSubject.display_facet, '语文');
  const taxonomyCounts = Object.fromEntries([
    'subject', 'assessment_subject', 'curriculum_course', 'assessment_domain',
    'cross_cutting_framework', 'source_collection', 'unclassified',
  ].map((kind) => [kind, rows.filter((item) => item.taxonomy_entity_kind === kind).length]));
  assert.deepEqual(taxonomyCounts, {
    subject: 158,
    assessment_subject: 1,
    curriculum_course: 16,
    assessment_domain: 3,
    cross_cutting_framework: 13,
    source_collection: 4,
    unclassified: 0,
  });
  assert.equal(new Set(rows.filter((item) => item.entity_kind === 'subject').map((item) => item.display_facet)).size, 12);
  const counts = {
    subject: rows.filter((item) => item.entity_kind === 'subject').length,
    course: rows.filter((item) => item.scope_kind === 'curriculum_course').length,
    scope: rows.filter((item) => item.entity_kind === 'scope' && item.scope_kind !== 'curriculum_course').length,
    unclassified: rows.filter((item) => item.scope_kind === 'unclassified').length,
  };
  assert.deepEqual(counts, { subject: 159, course: 16, scope: 20, unclassified: 0 });
});
