import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('public/index.html', root), 'utf8');
const app = await readFile(new URL('public/app.js', root), 'utf8');
const atlas = await readFile(new URL('public/atlas.js', root), 'utf8');
const styles = await readFile(new URL('public/styles.css', root), 'utf8');

test('the primary viewport is the curriculum cosmos rather than a marketing page', () => {
  assert.match(html, /class="cosmos-stage"/);
  assert.match(html, /id="cosmos-mount"/);
  assert.doesNotMatch(html, /class="hero-copy"|class="main-nav"/);
});

test('subjects and concepts are controlled inside the star map', () => {
  assert.match(html, /id="subject-orbit"/);
  assert.match(html, /data-map-mode="cross"/);
  assert.doesNotMatch(html, /href="\/subjects"|href="\/terms"/);
  assert.match(app, /path === '\/terms'[\s\S]*setMapMode\('cross'\)/);
});

test('subject hide-all clears every node and edge without a redundant count readout', () => {
  assert.match(app, /hideAllSubjects: false/);
  assert.match(app, /state\.hideAllSubjects = true/);
  assert.match(atlas, /this\.filters\.hideAll/);
  assert.match(atlas, /!source \|\| !target \|\| !this\.visible\(source\) \|\| !this\.visible\(target\)/);
  assert.doesNotMatch(html, /dock-status|颗概念星|条观察关系|个待核节点/);
  assert.doesNotMatch(app, /颗概念星|条观察关系|个待核节点/);
});

test('the map loads validated concept episodes and fails closed instead of drawing document stars', () => {
  assert.match(app, /data\/concept-evolution\.json/);
  assert.match(app, /概念星图数据未通过结构校验/);
  assert.match(app, /setData\(state\.conceptGraph\)/);
  assert.doesNotMatch(app, /setData\(state\.documents/);
});

test('legacy pages are merged into two bottom workspaces', () => {
  assert.match(html, /版本 · 资料/);
  assert.match(html, /研究 · 讨论/);
  assert.match(app, /path === '\/compare'/);
  assert.match(app, /path === '\/sources' \|\| path === '\/search'/);
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
  assert.match(atlas, /fitToGraph\(\{ immediate = false \} = \{\}\)/);
  assert.match(atlas, /safeViewport\(\)/);
  assert.match(atlas, /const MIN_ZOOM = \.2/);
  assert.match(atlas, /boxesOverlap\(box, candidate\)/);
  assert.match(atlas, /visibilitychange/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*?\.search-orbit \{[^}]*right: 136px;[^}]*width: auto;/);
  assert.match(styles, /\.subject-orbit > \.subject-button:nth-of-type\(n\+8\)/);
  assert.doesNotMatch(styles, /\n\s*\.subject-button:nth-of-type\(n\+8\)/);
});
