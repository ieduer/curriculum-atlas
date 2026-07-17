import assert from 'node:assert/strict';
import test from 'node:test';

import { sourceManifest } from '../scripts/source-manifest.mjs';

test('every catalog record has an explicit fail-closed text-quality disposition', () => {
  assert.equal(sourceManifest.length, 196);
  for (const record of sourceManifest) {
    assert.equal(typeof record.citation_allowed, 'boolean', `${record.id} citation_allowed`);
    assert.match(String(record.text_quality_status || ''), /\S/u, `${record.id} text_quality_status`);
  }

  const citationReady = sourceManifest.filter((record) => record.citation_allowed === true);
  assert.equal(citationReady.length, 101);
});

test('catalog-only records never impersonate citable body text', () => {
  const catalogOnly = sourceManifest.filter((record) => record.file_format === 'catalog');
  assert.deepEqual(catalogOnly.map((record) => record.id).sort(), [
    'catalog-legacy-originals',
    'catalog-revision-watch',
  ]);
  for (const record of catalogOnly) {
    assert.equal(record.text_quality_status, 'metadata_only');
    assert.equal(record.citation_allowed, false);
  }
});
