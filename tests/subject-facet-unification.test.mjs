import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { episodeVisibleForSubjectFilter } from '../public/atlas.js';
import {
  DISPLAY_SUBJECT_FACETS,
  buildSubjectFacetIndex,
  canonicalSubjectsForFacet,
  filterDocumentsBySubjectFacet,
  normalizeSubjectFacet,
  planSubjectFacetQueries,
} from '../public/subject-facets.js';

const root = new URL('../', import.meta.url);
const graph = JSON.parse(await readFile(new URL('public/data/concept-evolution.json', root), 'utf8'));
const availableSubjects = [...new Set(graph.subject_taxonomy
  .filter((item) => item.facet_eligible === true && item.entity_kind === 'subject')
  .map((item) => item.canonical))];

test('exactly twelve display facets expand to canonical academic identities', () => {
  const index = buildSubjectFacetIndex(graph, availableSubjects);
  assert.deepEqual(index.facets, DISPLAY_SUBJECT_FACETS);
  assert.deepEqual([...canonicalSubjectsForFacet('外语', index)].sort(), ['俄语', '德语', '日语', '法语', '英语', '西班牙语'].sort());
  assert.deepEqual([...canonicalSubjectsForFacet('思想政治与道德法治', index)].sort(), ['品德与生活', '品德与社会', '思想品德', '思想政治', '道德与法治'].sort());
  assert.deepEqual([...canonicalSubjectsForFacet('技术', index)].sort(), ['信息技术', '信息科技', '通用技术'].sort());
  assert.deepEqual([...canonicalSubjectsForFacet('科学类', index)].sort(), ['化学', '物理', '生物学', '科学'].sort());
  assert.equal(normalizeSubjectFacet('科学', index), '科学类');
  assert.equal(normalizeSubjectFacet('初中科学', index), '科学类');
  assert.equal(normalizeSubjectFacet('汉语', index), null, 'assessment-only 汉语 must not become a queryable academic subject');
  for (const forbidden of ['英语', '俄语', '日语', '西班牙语', '思想政治', '思想品德', '品德与社会', '道德与法治', '信息技术', '信息科技', '通用技术', '科学']) {
    assert.equal(index.facets.includes(forbidden), false, `${forbidden} leaked into the display-facet list`);
  }
});

test('query plans intersect live canonical subjects and never send a display facet to an exact-subject API', () => {
  const liveSubjects = ['语文', '英语', '俄语', '日语', '西班牙语', '思想政治', '道德与法治', '科学', '物理', '化学', '生物学', '信息科技', '通用技术'];
  const index = buildSubjectFacetIndex(graph, liveSubjects);
  assert.deepEqual(planSubjectFacetQueries('外语', index).map((item) => item.canonicalSubject), ['英语', '俄语', '日语', '西班牙语']);
  assert.deepEqual(planSubjectFacetQueries('技术', index).map((item) => item.canonicalSubject), ['信息科技', '通用技术']);
  assert.deepEqual(planSubjectFacetQueries('科学', index).map((item) => item.canonicalSubject), ['科学', '物理', '化学', '生物学']);
  for (const facet of index.facets) {
    for (const query of planSubjectFacetQueries(facet, index)) {
      assert.equal(query.facet, facet);
      assert.notEqual(query.canonicalSubject, '外语');
      assert.notEqual(query.canonicalSubject, '科学类');
      assert.notEqual(query.canonicalSubject, '思想政治与道德法治');
      assert.ok(liveSubjects.includes(query.canonicalSubject));
    }
  }
});

test('facet filtering is strict and preserves canonical labels and edition identity', () => {
  const index = buildSubjectFacetIndex(graph, availableSubjects);
  const documents = [
    { id: 'en-2011', entity_kind: 'subject', canonical_subject: '英语', version_label: '2011年版' },
    { id: 'ru-2011', entity_kind: 'subject', canonical_subject: '俄语', version_label: '2011年版' },
    { id: 'pe-2011', entity_kind: 'subject', canonical_subject: '体育与健康', version_label: '2011年版' },
    { id: 'framework', entity_kind: 'scope', canonical_subject: null, scope_label: '课程方案' },
    { id: 'assessment', entity_kind: 'subject', canonical_subject: '汉语', version_label: '考试大纲' },
  ];
  const filtered = filterDocumentsBySubjectFacet(documents, '外语', index);
  assert.deepEqual(filtered.map((item) => item.id), ['en-2011', 'ru-2011']);
  assert.deepEqual(filtered.map((item) => item.canonical_subject), ['英语', '俄语']);
  assert.deepEqual(filtered.map((item) => item.version_label), ['2011年版', '2011年版']);
});

test('hide-all suppresses subject, assessment, scope, and metadata episodes without leakage', () => {
  const episodes = [
    { subject: { entity_kind: 'subject', facet_eligible: true, facet: '语文' } },
    { subject: { entity_kind: 'assessment_subject', facet_eligible: true, facet: '语文' } },
    { visibility_facets: ['科学类'], scope_entity: { entity_kind: 'assessment_domain', canonical: '学业质量' } },
    { scope_entity: { entity_kind: 'cross_cutting_framework', canonical: '课程方案' } },
  ];
  for (const episode of episodes) {
    assert.equal(episodeVisibleForSubjectFilter(episode, new Set(), true, DISPLAY_SUBJECT_FACETS), false);
    assert.equal(episodeVisibleForSubjectFilter(episode, new Set(DISPLAY_SUBJECT_FACETS), false, DISPLAY_SUBJECT_FACETS), false);
  }
});

test('frontend selectors use facets while compare, search, and AI expand exact canonical queries', async () => {
  const [app, backend] = await Promise.all([
    readFile(new URL('public/app.js', root), 'utf8'),
    readFile(new URL('src/index.ts', root), 'utf8'),
  ]);
  assert.doesNotMatch(app, /全部学科/);
  assert.match(app, /const subjects = subjectFacetNames\(\)/);
  assert.match(app, /compareSubjectFacet\(subject\)/);
  assert.match(app, /searchSubjectFacet\(query, subject\)/);
  assert.match(app, /researchSubjectFacet\(payload\.query, facet\)/);
  assert.match(app, /api\(`\/api\/compare\?subject=\$\{encodeURIComponent\(canonicalSubject\)\}`\)/);
  assert.match(app, /api\(`\/api\/search\?q=\$\{encodeURIComponent\(query\)\}&subject=\$\{encodeURIComponent\(canonicalSubject\)\}`\)/);
  assert.match(app, /JSON\.stringify\(\{ query, subject: canonicalSubject \}\)/);
  assert.match(app, /canonical_subject: document\.canonical_subject \|\| canonicalSubject/);
  assert.match(app, /state\.hideAllSubjects = subjects\.every/);
  assert.match(backend, /await requireCanonicalSubject\(env, subject\)/);
  assert.match(backend, /dc\.canonical_subject = \?/);
});
