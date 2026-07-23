import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const [html, styles, appJs] = await Promise.all([
  readFile(new URL('public/index.html', root), 'utf8'),
  readFile(new URL('public/styles.css', root), 'utf8'),
  readFile(new URL('public/app.js', root), 'utf8'),
]);

const assetVersion = '20260723v21';

function block(source, opening, closing = '}') {
  const start = source.indexOf(opening);
  assert.ok(start >= 0, `missing ${opening}`);
  const end = source.indexOf(closing, start);
  assert.ok(end > start, `missing ${closing} after ${opening}`);
  return source.slice(start, end + closing.length);
}

test('versioned subject facets are preloaded before the versioned app entry without an inline import map', () => {
  const preload = html.indexOf(`<link rel="modulepreload" href="/subject-facets.js?v=${assetVersion}">`);
  const app = html.indexOf(`<script type="module" src="/app.js?v=${assetVersion}"></script>`);
  assert.match(html, new RegExp(`/styles\\.css\\?v=${assetVersion}`));
  assert.doesNotMatch(html, /<script type="importmap">/);
  assert.match(appJs, new RegExp(`from './subject-facets\\.js\\?v=${assetVersion}'`));
  assert.ok(preload >= 0 && preload < app, 'subject-facet preload must precede the app module');
  assert.doesNotMatch(html, /(?:styles\.css|subject-facets\.js|app\.js)\?v=20260715v11/);
});

test('the compare workspace contains intrinsic width while leaving the version river scrollable', () => {
  const workbench = block(styles, '.workbench {');
  const body = block(styles, '.workbench-body {');
  const workspace = block(styles, '.workspace-grid {');
  const river = block(styles, '.version-river {');
  assert.match(workbench, /width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*100vw;/);
  assert.match(body, /width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/);
  assert.match(body, /overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/);
  assert.match(workspace, /width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/);
  assert.match(workspace, /grid-template-columns:\s*minmax\(230px,\.72fr\)\s+minmax\(0,1\.8fr\);/);
  assert.match(styles, /\.workspace-grid > \*, \.reader-grid > \*, \.ai-grid > \* \{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/);
  assert.match(river, /width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/);
  assert.match(river, /overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;/);
  assert.match(styles, /@media \(max-width: 980px\)[\s\S]*?\.workspace-grid, \.reader-grid, \.ai-grid \{ grid-template-columns: minmax\(0,1fr\); \}/);
});

test('mobile inspector and workbench preserve the two-entry bottom dock', () => {
  const rail = block(html, '<aside class="timeline-library-column"', '</aside>');
  assert.equal((rail.match(/data-workspace=/g) || []).length, 2);
  assert.match(rail, /data-workspace="library"/);
  assert.match(rail, /data-workspace="research"/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*--mobile-dock-clearance:\s*96px;/);
  assert.match(styles, /\.star-inspector \{[\s\S]*?inset:\s*auto 9px calc\(var\(--mobile-dock-clearance\) \+ env\(safe-area-inset-bottom\)\) 9px;/);
  assert.match(styles, /body:has\(\.workbench:not\(\[hidden\]\)\) \.timeline-library-column \{ z-index: 82; \}/);
  assert.match(styles, /body:has\(\.workbench:not\(\[hidden\]\)\) \.timeline-library-column \.era-rail,[\s\S]*?visibility:\s*hidden; pointer-events:\s*none;/);
  assert.match(styles, /\.workbench-body \{[\s\S]*?scroll-padding-bottom:\s*calc\(var\(--mobile-dock-clearance\) \+ 24px\);/);
  assert.match(styles, /\.scrim \{ position: fixed; z-index: 79;/);
  assert.match(styles, /\.workbench \{[\s\S]*?z-index: 80;/);
});
