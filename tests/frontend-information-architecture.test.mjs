import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('public/index.html', root), 'utf8');
const app = await readFile(new URL('public/app.js', root), 'utf8');

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
