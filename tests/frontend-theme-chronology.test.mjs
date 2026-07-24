import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const [html, app, atlas, styles, themeInit] = await Promise.all([
  readFile(new URL('public/index.html', root), 'utf8'),
  readFile(new URL('public/app.js', root), 'utf8'),
  readFile(new URL('public/atlas.js', root), 'utf8'),
  readFile(new URL('public/styles.css', root), 'utf8'),
  readFile(new URL('public/theme-init.js', root), 'utf8'),
]);

function luminance(hex) {
  const channels = hex.match(/[a-f0-9]{2}/giu).map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(left, right) {
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('dark remains the default and the explicit user choice persists before first paint', () => {
  assert.match(html, /data-theme-choice="dark"[^>]*aria-pressed="true"/);
  assert.match(html, /data-theme-choice="light"[^>]*aria-pressed="false"/);
  assert.ok(html.indexOf('/theme-init.js?v=20260723v42') < html.indexOf('/styles.css?v=20260723v42'));
  assert.match(themeInit, /curriculum-atlas-theme-v1/);
  assert.match(themeInit, /stored === 'dark' \|\| stored === 'light'/);
  assert.match(app, /state\.cosmos\?\.setTheme\(state\.theme\)/);
  assert.match(atlas, /setTheme\(theme\)/);
});

test('light theme primary and muted text pass WCAG AA against the paper surface', () => {
  assert.ok(contrast('#16213a', '#edf1ee') >= 4.5);
  assert.ok(contrast('#4f5e75', '#edf1ee') >= 4.5);
  assert.ok(contrast('#67420c', '#edf1ee') >= 4.5);
  assert.match(styles, /\[data-theme="light"\]\s*\{[\s\S]*--ink:\s*#16213a;[\s\S]*--muted:\s*#4f5e75;/);
  assert.match(styles, /\[data-theme="light"\] \.star-inspector/);
  assert.match(atlas, /light:\s*\{[\s\S]*nodeLabel:\s*'rgba\(23,34,53,.98\)'/);
});

test('stage navigation and exact-year comparison are mutually exclusive panels', () => {
  assert.match(html, /id="chronology-era-panel"[^>]*role="tabpanel"/);
  assert.match(html, /id="chronology-compare-panel"[^>]*role="tabpanel"[^>]*hidden/);
  assert.match(app, /chronologyEraPanel\.hidden = compareActive/);
  assert.match(app, /chronologyComparePanel\.hidden = !compareActive/);
  assert.match(styles, /\.chronology-panel\[hidden\] \{ display: none; \}/);
  assert.match(atlas, /document\.querySelector\('\.cosmos-year-control'\)/);
  assert.doesNotMatch(atlas, /bottom:\s*this\.height - 166/);
});
