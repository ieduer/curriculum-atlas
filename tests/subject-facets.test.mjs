import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { episodeEntityLabel, episodeSubjectFacet } from '../public/atlas.js';

const root = new URL('../', import.meta.url);

test('star-map facet helper admits only explicit subject entities', () => {
  const subject = {
    subject: { entity_kind: 'subject', facet_eligible: true, canonical: '语文', source_label: '语文' },
  };
  assert.equal(episodeSubjectFacet(subject), '语文');
  assert.equal(episodeEntityLabel(subject), '语文');

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

test('frontend subject controls consume strict facets and keep scopes visible', async () => {
  const [app, atlas, index] = await Promise.all([
    readFile(new URL('public/app.js', root), 'utf8'),
    readFile(new URL('public/atlas.js', root), 'utf8'),
    readFile(new URL('public/index.html', root), 'utf8'),
  ]);
  assert.match(app, /map\(episodeSubjectFacet\)\.filter\(Boolean\)/);
  assert.match(app, /document\?\.entity_kind === 'subject'/);
  assert.match(atlas, /\(node\.subject && this\.filters\.hiddenSubjects\.has\(node\.subject\)\)/);
  assert.match(atlas, /color: subject \? subjectColor\(subject\) : '#e7bd61'/);

  const appEntryVersion = index.match(/\/app\.js\?v=([^"']+)/)?.[1];
  const atlasModuleVersion = app.match(/\.\/atlas\.js\?v=([^'";]+)/)?.[1];
  const graphVersion = app.match(/concept-evolution\.json\?v=([^'";]+)/)?.[1];
  assert.ok(appEntryVersion, 'index app cache version missing');
  assert.equal(atlasModuleVersion, appEntryVersion, 'atlas module cache version drifted');
  assert.equal(graphVersion, appEntryVersion, 'concept graph cache version drifted');
});
