import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  DISPLAY_SUBJECT_FACETS,
  STORAGE_SUBJECT_FACETS,
  buildSubjectFacetIndex,
  canonicalSubjectsForFacet,
  publicSubjectFacet,
} from '../public/subject-facets.js';

const root = new URL('../', import.meta.url);
const [lifecycle, graph, families, triage, publicOcrSummary, app, html, styles] = await Promise.all([
  readFile(new URL('public/data/discipline-lifecycle.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/data/concept-evolution.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/data/concept-evolution-families.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('data/ocr-review-triage.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/data/ocr-coverage-summary.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/app.js', root), 'utf8'),
  readFile(new URL('public/index.html', root), 'utf8'),
  readFile(new URL('public/styles.css', root), 'utf8'),
]);

test('history and history-and-society share one public query facet but preserve two storage identities', () => {
  assert.equal(DISPLAY_SUBJECT_FACETS.length, 11);
  assert.equal(STORAGE_SUBJECT_FACETS.length, 12);
  assert.equal(publicSubjectFacet('历史与社会'), '历史');
  const index = buildSubjectFacetIndex(graph, ['历史', '历史与社会']);
  assert.deepEqual(canonicalSubjectsForFacet('历史', index), ['历史', '历史与社会']);
  assert.equal(index.facets.includes('历史与社会'), false);
});

test('history lifecycle distinguishes grouping, choice, parallel issue, and standard-set adjustment', () => {
  assert.deepEqual(lifecycle.public_subject_facets, DISPLAY_SUBJECT_FACETS);
  const historyEvents = lifecycle.events.filter((event) => event.public_facets.includes('历史'));
  assert.deepEqual(historyEvents.map((event) => event.year), [1923, 2001, 2011, 2022]);
  assert.deepEqual(historyEvents.map((event) => event.event_type), [
    'integrated_grouping',
    'alternative_integrated_or_separate',
    'parallel_standard_paths',
    'national_standard_set_adjusted',
  ]);
  assert.ok(historyEvents.every((event) => event.source_ids.length > 0 && event.claim_boundary));
  assert.match(historyEvents[0].claim_boundary, /不等同于后来的历史与社会/);
  assert.match(historyEvents[1].claim_boundary, /不表示三个名称是同一学科/);
  assert.match(historyEvents[3].claim_boundary, /不推断地方课程立即取消/);
});

test('every public facet has source-bound course, practice, content, and ability branches', () => {
  const requiredTiers = [
    'subject-course-identity',
    'subject-practice-domain',
    'subject-content-domain',
    'subject-ability-domain',
  ];
  for (const facet of DISPLAY_SUBJECT_FACETS) {
    for (const tier of requiredTiers) {
      const matching = families.families.filter((family) =>
        family.concept_tier_id === tier
        && family.visibility_facets.some((candidate) => publicSubjectFacet(candidate) === facet));
      assert.ok(matching.length >= 1, `${facet}:${tier}`);
      assert.ok(matching.every((family) => family.episode_count > 0 && family.observed_concepts.length > 0));
    }
  }
});

test('the prior one-subject release-threshold message is gone and year linking is executable', () => {
  assert.doesNotMatch(app, /深层模型尚未达到发布门槛/);
  assert.match(app, /function buildDeepModels\(\)/);
  assert.match(app, /function linkConceptYears\(node\)/);
  assert.match(app, /data-concept-year/);
  assert.match(html, /id="concept-year-links"/);
});

test('review queue is exhaustively triaged without opening citation gates', () => {
  assert.equal(triage.counts.audited_dual_witness_pages, 6947);
  assert.equal(triage.counts.machine_concordant_sampling_pool, 66);
  assert.equal(triage.counts.text_or_structure_conflict_adjudication, 5028);
  assert.equal(triage.counts.table_cell_reconstruction, 1780);
  assert.equal(triage.counts.blank_visual_confirmation, 73);
  assert.equal(triage.counts.unclassified_pages, 0);
  assert.equal(triage.policy.citation_allowed, false);
  assert.equal(triage.root_cause.affected_pages, 6947);
  assert.equal(publicOcrSummary.coverage.candidate_covered_pages, 11847);
  assert.equal(publicOcrSummary.coverage.candidate_remaining_pages, 0);
  assert.equal(publicOcrSummary.coverage.dual_witness_audited_pages, 6947);
  assert.equal(publicOcrSummary.release_gate.citation_allowed, false);
});

test('inspector reserves a graph-safe viewport and uses a compact mobile fallback', () => {
  assert.match(app, /function positionInspector\(episodeId = null\)/);
  assert.match(app, /function applyInspectorAvoidance\(/);
  assert.match(app, /setViewportObstruction/);
  assert.match(app, /focusSelection\(\)/);
  assert.match(styles, /\.star-inspector\.dock-left/);
  assert.match(styles, /\.star-inspector\.dock-right/);
  assert.match(styles, /\.star-inspector\.overlap-softened/);
  assert.match(styles, /\.star-inspector:not\(\.is-expanded\)/);
  assert.match(styles, /\.inspector-expand/);
  assert.match(styles, /max-height:\s*min\(36svh/);
});

test('new header and progressive entry reveal are wired without a second axis', () => {
  assert.match(html, /assets\/century-curriculum-mark\.jpg/);
  assert.match(html, /<b>百年课标<\/b>/);
  assert.doesNotMatch(html, />纬<|20世纪—今天|century-timeline|century-track/);
  assert.match(app, /function startCenturyReveal\(\)/);
  assert.match(app, /const firstYear = state\.minYear/);
  assert.match(app, /requestAnimationFrame\(reveal\)/);
  assert.match(html, /id="year-options"/);
  assert.match(html, /id="year-boundary-compare"/);
  assert.doesNotMatch(html, /id="year-range"|type="range"/);
});
