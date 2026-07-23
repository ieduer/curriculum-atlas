import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('public/index.html', root), 'utf8');
const app = await readFile(new URL('public/app.js', root), 'utf8');
const atlas = await readFile(new URL('public/atlas.js', root), 'utf8');
const styles = await readFile(new URL('public/styles.css', root), 'utf8');

function elementBlock(source, openingMarker, closingMarker) {
  const start = source.indexOf(openingMarker);
  assert.ok(start >= 0, `missing ${openingMarker}`);
  const end = source.indexOf(closingMarker, start);
  assert.ok(end > start, `missing ${closingMarker} after ${openingMarker}`);
  return source.slice(start, end + closingMarker.length);
}

test('the primary viewport is the curriculum cosmos rather than a marketing page', () => {
  assert.match(html, /class="cosmos-stage"/);
  assert.match(html, /id="cosmos-mount"/);
  assert.doesNotMatch(html, /class="hero-copy"|class="main-nav"/);
});

test('the century archive feeds the single concept cosmos without a second time axis', () => {
  assert.doesNotMatch(html, /id="century-timeline"|id="century-track"|百年文件时间轴/);
  assert.doesNotMatch(styles, /\.century-track \{|\.century-node\./);
  assert.match(app, /centuryLayer\.star_projection\.episodes/);
  assert.match(app, /conceptGraph\.episodes = \[\.\.\.conceptGraph\.episodes, \.\.\.centuryLayer\.star_projection\.episodes\]/);
  assert.match(app, /path === '\/timeline' \|\| path === '\/archive'/);
  assert.match(app, /renderHistoricalItem/);
});

test('OCR candidates use the original star material, motion, labels, and interaction path', () => {
  assert.match(atlas, /effects: starEffectProfile\(display\)/);
  assert.match(atlas, /pulseAmplitude/);
  assert.match(atlas, /haloOpacity/);
  assert.match(atlas, /spikeScale/);
  assert.match(atlas, /starAutoLabelEligible\(node\)/);
  assert.match(atlas, /evidenceRing: 'none'/);
  assert.doesNotMatch(atlas, /setLineDash|candidate_dashed|warning_dashed/);
  assert.doesNotMatch(styles, /dashed|stroke-dasharray/);
  assert.doesNotMatch(atlas, /node\.display === 'solid' \? rgba\(node\.color, depthAlpha\)/);
  assert.doesNotMatch(atlas, /node\.display === 'solid' \? 'rgba\(244,247,255/);
});

test('subjects and concepts are controlled inside the star map', () => {
  assert.match(html, /id="subject-orbit"/);
  assert.match(html, /id="subject-status">12\/12 · 全部显示/);
  assert.match(html, /id="show-all-subjects"/);
  assert.match(html, /data-map-mode="cross"/);
  assert.match(html, /data-map-mode="structure"/);
  assert.match(html, /id="concept-layers"/);
  assert.doesNotMatch(html, /id="subject-panel"|class="subject-more"/);
  assert.doesNotMatch(html, /href="\/subjects"|href="\/terms"/);
  assert.match(app, /path === '\/terms'[\s\S]*setMapMode\('cross'\)/);
});

test('subject hide-all clears every node and edge without a redundant count readout', () => {
  assert.match(app, /hideAllSubjects: false/);
  assert.match(app, /episodeVisibleForSubjectFilter\(episode, state\.hiddenSubjects, state\.hideAllSubjects/);
  assert.match(atlas, /this\.filters\.hideAll/);
  assert.match(atlas, /!source \|\| !target \|\| !this\.visible\(source\) \|\| !this\.visible\(target\)/);
  assert.doesNotMatch(html, /dock-status|颗概念星|条观察关系|个待核节点/);
  assert.doesNotMatch(app, /颗概念星|条观察关系|个待核节点/);
});

test('the map loads validated concept episodes and fails closed instead of drawing document stars', () => {
  assert.match(app, /data\/concept-evolution\.json/);
  assert.match(app, /data\/century-observation-layer\.json/);
  assert.match(app, /data\/pre2001-subject-detail-observation-layer\.json/);
  assert.match(app, /pre2001Layer\.node_semantics !== 'pre2001_subject_detail_concept_observation_episode_not_document'/);
  assert.match(app, /data\/concept-evolution-families\.json/);
  assert.match(app, /episode\.evolution_family_id = membership\.family_id/);
  assert.match(atlas, /selectedEvolutionNodeIds\(this\.nodes, this\.selectedId\)/);
  assert.match(atlas, /selectedRelationshipNodeIds\(this\.nodes, this\.relationshipEdges, this\.selectedId\)/);
  assert.match(atlas, /if \(this\.activeSelectionIds\.size\) return this\.activeSelectionIds\.has\(node\.id\)/);
  assert.match(atlas, /focusSelection\(\)/);
  assert.match(atlas, /edge\.mode === 'discipline'/);
  assert.match(atlas, /this\.evolutionEdges\.filter/);
  assert.match(app, /概念星图数据未通过结构校验/);
  assert.match(app, /setData\(state\.conceptGraph\)/);
  assert.doesNotMatch(app, /setData\(state\.documents/);
  assert.doesNotMatch(app, /setData\(centuryLayer\.items/);
});

test('left tools default collapsed while year visibility lives horizontally inside the cosmos', () => {
  const rail = elementBlock(html, '<aside class="map-control-column is-collapsed"', '</aside>');
  const subjectIndex = rail.indexOf('id="subject-orbit"');
  const searchIndex = rail.indexOf('id="cosmos-search"');
  const modeIndex = rail.indexOf('class="mode-switch"');
  const libraryIndex = rail.indexOf('data-workspace="library"');
  const researchIndex = rail.indexOf('data-workspace="research"');
  const evidenceIndex = rail.indexOf('id="ocr-layer-status"');
  assert.ok(subjectIndex >= 0
    && subjectIndex < searchIndex
    && searchIndex < modeIndex
    && modeIndex < libraryIndex
    && libraryIndex < researchIndex
    && researchIndex < evidenceIndex,
  'collapsed tool drawer order must be subjects -> search -> modes -> workspaces -> evidence');
  assert.equal(rail.includes('id="era-buttons"'), false);
  assert.equal(rail.includes('id="year-range"'), false);
  const years = elementBlock(html, '<section class="cosmos-year-control"', '</section>');
  assert.match(years, /id="era-buttons"/);
  assert.match(years, /id="year-range"/);
  assert.doesNotMatch(html, /百年纵轴|class="era-cluster"/);
  assert.match(html, /id="map-tools-toggle"[^>]*aria-expanded="false"/);
  assert.match(html, /id="map-controls"[^>]*aria-hidden="true"/);
  assert.equal((rail.match(/data-workspace=/g) || []).length, 2);
  assert.match(styles, /\.map-control-column \{[^}]*left:/);
  assert.match(styles, /\.map-control-column \{[^}]*overflow-y:\s*auto;/);
  assert.match(styles, /\.subject-orbit \{[^}]*grid-template-columns:\s*repeat\(2,minmax\(0,1fr\)\);/);
  assert.match(styles, /\.search-orbit \{[^}]*position:\s*relative;/);
  assert.match(styles, /\.search-orbit input::\-webkit-search-cancel-button \{[^}]*display:\s*none;/);
  assert.match(styles, /\.mode-switch \{[^}]*position:\s*relative;/);
  assert.match(styles, /\.map-control-column\.is-collapsed \{/);
  assert.match(styles, /\.cosmos-year-control \{[^}]*left:\s*50%;[^}]*bottom:/);
  assert.match(styles, /\.year-scrubber input \{[^}]*width:\s*100%;[^}]*cursor:\s*ew-resize;/);
  assert.doesNotMatch(styles, /writing-mode:\s*vertical-lr|cursor:\s*ns-resize/);
  assert.match(app, /function setMapControlsExpanded\(expanded\)/);
  assert.match(styles, /\.research-dock \{[^}]*position:\s*relative;/);
  assert.doesNotMatch(html, /timeline-library-column/);
  assert.doesNotMatch(styles, /\.research-dock \{[^}]*inset:\s*auto\s+0\s+0/);
  assert.doesNotMatch(styles, /--dock-h|height:\s*var\(--dock-h\)/);
});

test('legacy pages remain merged into the two rail-launched workspaces', () => {
  assert.match(html, /版本 · 资料/);
  assert.match(html, /研究 · 讨论/);
  assert.match(app, /path === '\/compare'/);
  assert.match(app, /path === '\/sources' \|\| path === '\/search'/);
  assert.match(app, /path === '\/timeline' \|\| path === '\/archive'/);
  assert.match(app, /path === '\/ai'/);
  assert.match(app, /path === '\/discussions'/);
});

test('camera motion follows system preference and no redundant header controls remain', () => {
  assert.doesNotMatch(html, /motion-toggle|reset-view|>静<|>◎</);
  assert.doesNotMatch(app, /localStorage|motionToggle|resetView|curriculum:stable/);
  assert.doesNotMatch(styles, /body\.stable/);
  assert.match(atlas, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
});

test('the graph fits its data bounds inside responsive safe areas', () => {
  assert.match(atlas, /fitToGraph\(\{ immediate = false, nodes = this\.nodes, maxZoom = 1, preserveOrientation = false \} = \{\}\)/);
  assert.match(atlas, /fitToVisibleGraph\(options = \{\}\)/);
  assert.match(atlas, /nodes: this\.nodes\.filter\(\(node\) => this\.visible\(node\)\)/);
  assert.match(atlas, /safeViewport\(\)/);
  assert.match(atlas, /const MIN_ZOOM = \.2/);
  assert.match(atlas, /boxesOverlap\(box, candidate\)/);
  assert.match(atlas, /visibilitychange/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*?\.map-control-column \{[^}]*left:\s*7px;/);
  assert.doesNotMatch(styles, /timeline-library-column/);
  assert.doesNotMatch(styles, /\.subject-orbit > \.subject-button:nth-of-type/);
  assert.match(styles, /\.subject-orbit \{[^}]*grid-template-columns:\s*repeat\(2,minmax\(0,1fr\)\);/);
  assert.match(styles, /\.map-control-column \{[^}]*overflow-y:\s*auto;/);
});

test('deep concept exploration remains inside the star map and preserves evidence boundaries', () => {
  assert.match(app, /function renderConceptLayers\(\)/);
  assert.match(app, /function showOntologyInspector\(node\)/);
  assert.match(app, /版本边界：/);
  assert.match(app, /reviewed_inference/);
  assert.match(styles, /\.ontology-center/);
  assert.match(styles, /\.ontology-star\.inferred/);
});

test('deep ontology search matches definitions and source terms and renders an in-map constellation', () => {
  const helperStart = app.indexOf('function ontologySearchText(');
  const helperEnd = app.indexOf('\n}\n\nfunction renderConceptLayers', helperStart) + 2;
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'ontology search helper missing');
  const ontologySearchText = Function(
    'state',
    'ONTOLOGY_TYPE_LABELS',
    `"use strict"; ${app.slice(helperStart, helperEnd)}; return ontologySearchText;`,
  )(
    { ontologyScopeById: new Map([['scope-1', { version_scope: '2022 年版' }]]) },
    { ability_descriptor: '能力描述' },
  );
  const indexed = ontologySearchText({
    label: '梳理与探究',
    definition: '比较语言材料并形成解释',
    source_terms: ['比较', '归纳', '探究'],
    node_type: 'ability_descriptor',
    scope_id: 'scope-1',
  });
  for (const expected of ['梳理与探究', '比较语言材料并形成解释', '归纳', '能力描述', '2022 年版']) {
    assert.ok(indexed.includes(expected.toLocaleLowerCase('zh-CN')), `ontology search omitted ${expected}`);
  }
  assert.match(app, /queryMatches = state\.query \? state\.conceptGraph\.ontology_nodes/);
  assert.match(app, /const queryHasEpisodeMatch = state\.query && state\.conceptGraph\.episodes\.some/);
  assert.match(app, /state\.mode !== 'structure' && \(!queryMatches\.length \|\| queryHasEpisodeMatch\)/);
  assert.match(app, /searchableSubjects\.has\(ontologyNodeSubject\(node\)\)/);
  assert.match(app, /data-ontology-search-result=/);
  assert.match(app, /ontology-center ontology-search-center/);
  assert.match(app, /官方概念、术语与能力描述/);
});

test('concept deep-dive preserves the selected subject and fails closed when no ontology is released for it', () => {
  const modeStart = app.indexOf('function setMapMode(');
  const modeEnd = app.indexOf('\nfunction openWorkbench(', modeStart);
  assert.ok(modeStart >= 0 && modeEnd > modeStart, 'setMapMode implementation missing');
  const implementation = app.slice(modeStart, modeEnd);
  assert.match(implementation, /activeOntologyContext\(\)/);
  assert.doesNotMatch(implementation, /firstRoot|hiddenSubjects\.clear|hiddenSubjects\.add|renderSubjectControls/);
  assert.match(app, /const \{ activeSubject, root \} = activeOntologyContext\(\)/);
  assert.match(app, /深层模型尚未达到发布门槛/);
});

test('changing the isolated subject clears an ontology inspector from the previous subject', () => {
  const reconcileStart = app.indexOf('function reconcileOntologyInspectorSubject(');
  const reconcileEnd = app.indexOf('\n}\n\nfunction renderConceptLayers', reconcileStart) + 2;
  assert.ok(reconcileStart >= 0 && reconcileEnd > reconcileStart, 'ontology inspector reconciliation is missing');
  const reconcile = app.slice(reconcileStart, reconcileEnd);
  assert.match(reconcile, /visibleSubjects\.length === 1 \? visibleSubjects\[0\] : null/);
  assert.match(reconcile, /ontologyNodeSubject\(focus\) === activeSubject/);
  assert.match(reconcile, /state\.ontologyFocusId = null/);
  assert.match(reconcile, /inspector\.hidden = true/);

  const statusStart = app.indexOf('function updateMapStatus(');
  const statusEnd = app.indexOf('\n}\n\nfunction subjectButton', statusStart) + 2;
  const update = app.slice(statusStart, statusEnd);
  assert.match(update, /reconcileOntologyInspectorSubject\(visibleSubjects\)/);
});
