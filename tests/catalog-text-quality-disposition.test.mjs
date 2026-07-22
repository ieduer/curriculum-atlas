import assert from 'node:assert/strict';
import test from 'node:test';

import { sourceManifest } from '../scripts/source-manifest.mjs';

test('every catalog record has an explicit fail-closed text-quality disposition', () => {
  assert.equal(sourceManifest.length, 195);
  for (const record of sourceManifest) {
    assert.equal(typeof record.citation_allowed, 'boolean', `${record.id} citation_allowed`);
    assert.match(String(record.text_quality_status || ''), /\S/u, `${record.id} text_quality_status`);
  }

  const citationReady = sourceManifest.filter((record) => record.citation_allowed === true);
  assert.equal(citationReady.length, 102);

  const recoveredPhysics = sourceManifest.find((record) => record.id === 'ictr-2a9f8ddd4169');
  assert.ok(recoveredPhysics, 'the recovered 2017 physics standard must remain registered');
  assert.equal(recoveredPhysics.text_quality_status, 'official_native_text');
  assert.equal(recoveredPhysics.citation_allowed, true);
  assert.equal(
    recoveredPhysics.checksum_sha256,
    '50b77ebbbaa0a538a7a26843dac7ce8f9f615dec28689be2a3a7dcbbc0849cd2',
  );
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
