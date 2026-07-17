import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CurriculumCosmos,
  episodeColor,
  episodeCanonicalSubject,
  episodeCourseEntity,
  episodeEntityLabel,
  episodeSubjectFacet,
  episodeVisibilityFacets,
  episodeVisibleForSubjectFilter,
  subjectColor,
} from '../public/atlas.js';
import {
  controlledSubjectFacetCounts,
} from '../public/subject-facets.js';

const root = new URL('../', import.meta.url);

test('star-map facet helper admits controlled subject and assessment-subject entities only', () => {
  const subject = {
    subject: { entity_kind: 'subject', facet_eligible: true, canonical: '语文', facet: '语文', source_label: '语文' },
  };
  assert.equal(episodeSubjectFacet(subject), '语文');
  assert.equal(episodeEntityLabel(subject), '语文');
  const assessmentSubject = {
    subject: { entity_kind: 'assessment_subject', facet_eligible: true, canonical: '汉语', facet: '语文', source_label: '汉语' },
  };
  assert.equal(episodeSubjectFacet(assessmentSubject), '语文');
  assert.equal(episodeCanonicalSubject(assessmentSubject), '汉语');
  assert.equal(episodeEntityLabel(assessmentSubject), '汉语');

  const course = {
    subject: { entity_kind: 'curriculum_course', facet_eligible: false, canonical: null },
    course_entity: { entity_kind: 'curriculum_course', canonical: '定向行走' },
    scope_entity: { entity_kind: 'curriculum_course', canonical: '定向行走' },
  };
  assert.equal(episodeSubjectFacet(course), null);
  assert.equal(episodeEntityLabel(course), '定向行走');
  assert.equal(episodeColor({
    ...course,
    visibility_facets: ['语文'],
  }), '#ff828b');

  for (const episode of [
    { subject: { entity_kind: 'scope', facet_eligible: false, canonical: null }, scope_entity: { kind: 'curriculum_framework', label: '课程方案' } },
    { subject: { canonical: '综合' }, scope_entity: { kind: 'cross_subject', label: '改革纲要' } },
    { subject: { entity_kind: 'subject', facet_eligible: false, canonical: '考试评价' }, scope_entity: { kind: 'evaluation_framework', label: '考试评价' } },
  ]) {
    assert.equal(episodeSubjectFacet(episode), null);
  }
  assert.equal(episodeEntityLabel({
    subject: { entity_kind: 'scope', facet_eligible: false, canonical: null },
    scope_entity: { entity_kind: 'cross_cutting_framework', canonical: '课程方案' },
  }), '课程方案');
});

test('D1 migration enforces canonical subject and scope invariants', async () => {
  const migration = await readFile(new URL('migrations/0004_document_classifications.sql', root), 'utf8');
  assert.match(migration, /entity_kind TEXT NOT NULL CHECK \(entity_kind IN \('subject', 'scope'\)\)/);
  assert.match(migration, /entity_kind = 'subject' AND canonical_subject IS NOT NULL/);
  assert.match(migration, /entity_kind != 'subject' AND canonical_subject IS NULL/);
  assert.match(migration, /'document_classification_schema_version', '1'/);
  assert.doesNotMatch(migration, /'schema_version', '4'/);
});

test('API, retrieval, and corpus persistence use document classifications rather than raw subjects', async () => {
  const [index, retrieval, corpus] = await Promise.all([
    readFile(new URL('src/index.ts', root), 'utf8'),
    readFile(new URL('src/retrieval.ts', root), 'utf8'),
    readFile(new URL('scripts/build-corpus.mjs', root), 'utf8'),
  ]);
  assert.match(index, /JOIN document_classifications dc ON dc\.document_id = d\.id/);
  assert.match(index, /dc\.entity_kind = 'subject' AND dc\.canonical_subject = \?/);
  assert.match(retrieval, /dc\.canonical_subject AS subject/);
  assert.match(retrieval, /dc\.entity_kind = 'subject' AND dc\.canonical_subject = \?/);
  assert.match(corpus, /INSERT INTO document_classifications/);
  assert.match(corpus, /classified_document_count/);
});

test('frontend subject controls consume strict display facets and hide all nodes atomically', async () => {
  const [app, atlas, index, facets] = await Promise.all([
    readFile(new URL('public/app.js', root), 'utf8'),
    readFile(new URL('public/atlas.js', root), 'utf8'),
    readFile(new URL('public/index.html', root), 'utf8'),
    readFile(new URL('public/subject-facets.js', root), 'utf8'),
  ]);
  assert.match(app, /controlledSubjectFacetCounts\(state\.conceptGraph\)/);
  assert.match(app, /episodeVisibleForSubjectFilter\(episode, state\.hiddenSubjects, state\.hideAllSubjects/);
  assert.match(app, /from '\.\/subject-facets\.js\?v=[^']+'/);
  assert.match(facets, /item\?\.facet_eligible !== true \|\| item\?\.entity_kind !== 'subject'/);
  assert.match(facets, /DISPLAY_SUBJECT_FACETS/);
  assert.match(app, /document\?\.entity_kind === 'subject'/);
  assert.match(atlas, /node\.year > this\.filters\.maxYear \|\| !episodeVisibleForSubjectFilter/);
  assert.match(atlas, /!source \|\| !target \|\| !this\.visible\(source\) \|\| !this\.visible\(target\)/);
  assert.match(atlas, /color: episodeColor\(episode\)/);
  assert.match(atlas, /if \(node\.course\)[\s\S]*context\.rotate\(Math\.PI \/ 4\)/);
  assert.match(app, /location\.hostname !== 'curriculum\.bdfz\.net'/);
  assert.match(app, /https:\/\/my\.bdfz\.net\/site-auth\.js/);
  assert.match(app, /https:\/\/pulse\.bdfz\.net\/beacon\.js/);
  assert.doesNotMatch(index, /id="subject-panel"|class="subject-more"/);
  assert.doesNotMatch(index, /src="https:\/\/my\.bdfz\.net\/site-auth\.js"/);
  assert.doesNotMatch(index, /src="https:\/\/pulse\.bdfz\.net\/beacon\.js"/);

  const appEntryVersion = index.match(/\/app\.js\?v=([^"']+)/)?.[1];
  const stylesheetVersion = index.match(/\/styles\.css\?v=([^"']+)/)?.[1];
  const subjectFacetImportVersion = app.match(/\.\/subject-facets\.js\?v=([^'";]+)/)?.[1];
  const subjectFacetPreloadVersion = index.match(/rel="modulepreload" href="\/subject-facets\.js\?v=([^"']+)"/)?.[1];
  const atlasModuleVersion = app.match(/\.\/atlas\.js\?v=([^'";]+)/)?.[1];
  const graphVersion = app.match(/concept-evolution\.json\?v=([^'";]+)/)?.[1];
  assert.ok(appEntryVersion, 'index app cache version missing');
  assert.equal(stylesheetVersion, appEntryVersion, 'stylesheet cache version drifted');
  assert.equal(subjectFacetImportVersion, appEntryVersion, 'subject facet module cache version drifted');
  assert.equal(subjectFacetPreloadVersion, appEntryVersion, 'subject facet preload cache version drifted');
  assert.equal(atlasModuleVersion, appEntryVersion, 'atlas module cache version drifted');
  assert.equal(graphVersion, appEntryVersion, 'concept graph cache version drifted');
});

test('real reviewed course relations inherit one subject-facet color while preserving course identity', async () => {
  const graph = JSON.parse(await readFile(new URL('public/data/concept-evolution.json', root), 'utf8'));
  const reviewedCourses = graph.episodes.filter((episode) => episode.visibility_policy === 'reviewed_course_relation');
  assert.equal(reviewedCourses.length, 19);
  for (const episode of reviewedCourses) {
    assert.equal(episode.visibility_facets.length, 1, episode.id);
    assert.ok(episodeCourseEntity(episode), episode.id);
    assert.equal(episodeColor(episode), subjectColor(episode.visibility_facets[0]), episode.id);
  }

  const cosmos = {
    nodes: [],
    subjects: [],
    tracks: [],
    buildEdges() {},
    fitToGraph() {},
  };
  CurriculumCosmos.prototype.setData.call(cosmos, { ...graph, edges: [] });
  for (const episode of reviewedCourses) {
    const node = cosmos.nodes.find((candidate) => candidate.id === episode.id);
    assert.ok(node, episode.id);
    assert.equal(node.course, episodeCourseEntity(episode).canonical, episode.id);
    assert.equal(node.color, subjectColor(episode.visibility_facets[0]), episode.id);
  }

  const futureScope = {
    subject: { entity_kind: 'scope', facet_eligible: false, canonical: null },
    scope_entity: { entity_kind: 'cross_cutting_framework', canonical: '未来范围节点' },
    visibility_facets: ['语文'],
  };
  assert.equal(episodeColor(futureScope), '#e7bd61');
});

test('subject focus fits visible nodes, restores the full map, preserves Shift camera, and fits legacy routes', async () => {
  const app = await readFile(new URL('public/app.js', root), 'utf8');
  const controlsStart = app.indexOf('function renderSubjectControls(');
  const controlsEnd = app.indexOf('\n}\n\nfunction renderEraControls', controlsStart) + 2;
  assert.ok(controlsStart >= 0 && controlsEnd > controlsStart, 'subject control handler missing');
  const controls = app.slice(controlsStart, controlsEnd);
  assert.match(controls, /if \(event\.shiftKey\)/);
  assert.match(controls, /visibleSubjects\.length === 1 && visibleSubjects\[0\] === subject[\s\S]*state\.hiddenSubjects\.clear\(\)/);
  assert.match(controls, /updateMapStatus\(\{ fitVisible: !event\.shiftKey \}\)/,
    'ordinary isolate and restore-all clicks must fit, while Shift multi-select must not');
  assert.match(app, /visibleSubjectCount === 1 \? 1\.32 : 1/,
    'single-subject fit must use 1.32 while restore-all returns to the full-map cap');
  assert.match(app, /path === '\/subjects'[\s\S]*updateMapStatus\(\{ fitVisible: true \}\)/,
    'legacy subject routes must fit the isolated subject');
});

test('the cosmos fit API receives only visible nodes and honors the requested zoom cap', () => {
  const nodes = [{ id: 'visible' }, { id: 'hidden' }];
  let fitOptions = null;
  const focused = CurriculumCosmos.prototype.fitToVisibleGraph.call({
    nodes,
    visible: (node) => node.id === 'visible',
    fitToGraph: (options) => {
      fitOptions = options;
      return true;
    },
  }, { maxZoom: 1.32, preserveOrientation: true });
  assert.equal(focused, true);
  assert.deepEqual(fitOptions.nodes, [nodes[0]]);
  assert.equal(fitOptions.maxZoom, 1.32);
  assert.equal(fitOptions.preserveOrientation, true);

  let drawCount = 0;
  let filterFit = null;
  const filtered = {
    filters: { hiddenSubjects: new Set(), hideAll: false, maxYear: 2022, query: '' },
    fitToVisibleGraph: (options) => {
      filterFit = options;
      return true;
    },
    draw: () => { drawCount += 1; },
  };
  CurriculumCosmos.prototype.setFilters.call(filtered, {
    hiddenSubjects: new Set(['数学']), hideAll: false, maxYear: 2022, query: '',
  }, { fitVisible: true, maxZoom: 1.32 });
  assert.deepEqual(filterFit, { maxZoom: 1.32, preserveOrientation: true });
  assert.equal(drawCount, 0, 'successful focus fitting must not issue a redundant draw');

  CurriculumCosmos.prototype.setFilters.call(filtered, {
    hiddenSubjects: new Set(), hideAll: false, maxYear: 2022, query: '',
  });
  assert.equal(drawCount, 1, 'non-fitting filter changes must preserve the current camera and redraw only');
});

test('each subject isolate is fail-closed and Chinese cannot inherit sports-course concepts', async () => {
  const graph = JSON.parse(await readFile(new URL('public/data/concept-evolution.json', root), 'utf8'));
  const subjects = graph.subject_facets;
  assert.equal(subjects.length, 12);

  assert.equal(graph.episodes.filter((episode) => episodeVisibleForSubjectFilter(episode, new Set(), false, subjects)).length, graph.episodes.length);
  assert.equal(graph.episodes.filter((episode) => episodeVisibleForSubjectFilter(episode, new Set(subjects), false, subjects)).length, 0);
  assert.equal(graph.episodes.filter((episode) => episodeVisibleForSubjectFilter(episode, new Set(), true, subjects)).length, 0);

  for (const subject of subjects) {
    const hidden = new Set(subjects.filter((name) => name !== subject));
    const visible = graph.episodes.filter((episode) => episodeVisibleForSubjectFilter(episode, hidden, false, subjects));
    assert.ok(visible.length > 0 || ['历史与社会', '劳动'].includes(subject), `${subject} isolate unexpectedly empty`);
    assert.ok(visible.every((episode) => episodeVisibilityFacets(episode).includes(subject)), `${subject} isolate leaked an unrelated episode`);
    if (subject === '语文') {
      assert.equal(visible.some((episode) => episode.label === '运动能力'), false, 'Chinese isolate leaked sports motor ability');
      assert.equal(visible.some((episode) => ['综合康复', '运动与保健'].includes(episode.scope_entity?.canonical)), false, 'Chinese isolate leaked a sports or rehabilitation course');
    }
  }
});

test('the 12 display groups preserve exact identities and remain stable controls', async () => {
  const graphSource = await readFile(new URL('public/data/concept-evolution.json', root), 'utf8');
  const graph = JSON.parse(graphSource);

  const { subjects, counts } = controlledSubjectFacetCounts(graph);
  assert.equal(subjects.length, 12);
  assert.deepEqual(subjects, graph.subject_facets, 'graph-defined facet order must remain stable');
  assert.deepEqual(subjects, ['语文', '数学', '外语', '思想政治与道德法治', '历史', '历史与社会', '地理', '科学类', '技术', '劳动', '艺术', '体育与健康']);
  const zeroEpisodeSubjects = subjects.filter((subject) => counts.get(subject) === 0);
  assert.deepEqual(zeroEpisodeSubjects, ['历史与社会', '劳动']);
  for (const forbidden of ['汉语', '日语', '西班牙语', '思想品德', '道德与法治', '信息技术', '信息科技', '通用技术', '科学', '物理', '化学', '生物学']) {
    assert.equal(subjects.includes(forbidden), false, `${forbidden} must not be a standalone display facet`);
  }

  const contaminatedGraph = structuredClone(graph);
  contaminatedGraph.subject_facets.push('定向行走', '美工', '课程方案', '考试评价');
  assert.deepEqual(controlledSubjectFacetCounts(contaminatedGraph).subjects, subjects, 'course and scope labels must remain outside subject controls');

  const hiddenSubjects = new Set();
  hiddenSubjects.add(zeroEpisodeSubjects[0]);
  assert.equal(hiddenSubjects.has(zeroEpisodeSubjects[0]), true);
  hiddenSubjects.delete(zeroEpisodeSubjects[0]);
  assert.equal(hiddenSubjects.has(zeroEpisodeSubjects[0]), false);
  assert.deepEqual(controlledSubjectFacetCounts(graph).subjects, subjects, 'zero-episode toggles must not reorder controls');
});

test('every controlled academic identity resolves to exactly one display group', async () => {
  const model = JSON.parse(await readFile(new URL('data/concept-model-v2.json', root), 'utf8'));
  const groups = Object.entries(model.subject_facet_groups);
  const mappedMembers = new Set(groups.flatMap(([, members]) => members));
  for (const [sourceLabel, entry] of Object.entries(model.subject_taxonomy)) {
    const matches = groups.filter(([, members]) => members.includes(sourceLabel) || members.includes(entry.canonical));
    if (entry.facet_eligible) {
      assert.equal(matches.length, 1, `${sourceLabel} must resolve to exactly one display group`);
      assert.ok(['subject', 'assessment_subject'].includes(entry.entity_kind), `${sourceLabel} has an invalid academic entity kind`);
    } else {
      assert.equal(matches.length, 0, `${sourceLabel} is not a subject but leaked into ${matches.map(([name]) => name).join(', ')}`);
    }
  }
  for (const member of mappedMembers) {
    assert.ok(model.subject_taxonomy[member]
      || Object.values(model.subject_taxonomy).some((entry) => entry.canonical === member), `${member} has no exact taxonomy identity`);
  }
});
