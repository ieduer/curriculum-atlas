import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const [html, app, styles] = await Promise.all([
  readFile(new URL('public/index.html', root), 'utf8'),
  readFile(new URL('public/app.js', root), 'utf8'),
  readFile(new URL('public/styles.css', root), 'utf8'),
]);

test('the collapsed search drawer exposes a keyboard list backed by star episodes', () => {
  assert.match(html, /id="cosmos-query"[^>]*role="combobox"[^>]*aria-controls="concept-result-list"/s);
  assert.match(html, /id="concept-result-list" role="listbox"/);
  assert.match(app, /state\.conceptGraph\.episodes[\s\S]*episodeSearchText\(episode\)\.includes\(state\.query\)/);
  assert.match(app, /data-episode-id=/);
  assert.match(app, /role="option"/);
  assert.match(app, /onSelect:\s*selectConceptEpisode/);
  assert.match(app, /selectConceptEpisode\(state\.searchResultEpisodes\.find/);
});

test('arrow keys and Enter use the same concept selection path as Canvas clicks', () => {
  assert.match(app, /searchForm\.addEventListener\('submit'[\s\S]*selectConceptEpisode\(state\.searchResultEpisodes\[0\]\)/);
  assert.match(app, /searchInput\.addEventListener\('keydown'[\s\S]*ArrowDown[\s\S]*ArrowUp/);
  assert.match(app, /conceptResultList\.addEventListener\('keydown'[\s\S]*Home[\s\S]*End[\s\S]*event\.key === 'Enter' \|\| event\.key === ' '/);
  assert.match(app, /event\.key === 'Enter' \|\| event\.key === ' '[\s\S]*selectConceptEpisode\(state\.searchResultEpisodes\.find/);
  assert.match(app, /event\.key === 'Enter' \|\| event\.key === ' '[\s\S]*Escape/);
  assert.match(styles, /\.concept-results \{[^}]*flex:\s*0 1 230px;/);
  assert.match(styles, /#concept-result-list \{[^}]*overflow-y:\s*auto;/);
});
