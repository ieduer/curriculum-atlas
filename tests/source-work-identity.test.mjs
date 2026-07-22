import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { sourceManifest } from '../scripts/source-manifest.mjs';

const projectRoot = new URL('../', import.meta.url);

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, projectRoot), 'utf8'));
}

test('the 2011 junior-secondary science standard is one work with an ICTR scan variant', async () => {
  const [supplemental, sources, queue, registry] = await Promise.all([
    readJson('data/supplemental-sources.json'),
    readJson('data/document-sources.json'),
    readJson('data/ocr-queue.json'),
    readJson('data/artifact-registry.json'),
  ]);

  const canonical = sourceManifest.find((document) => document.id === 'moe-2011-12');
  assert.ok(canonical);
  assert.equal(canonical.title, '义务教育初中科学课程标准（2011年版）');
  assert.equal(canonical.subject, '科学');

  assert.equal(sourceManifest.some((document) => document.id === 'ictr-f6754fe2f491'), false);
  assert.equal(supplemental.documents.some((document) => document.id === 'ictr-f6754fe2f491'), false);
  assert.equal(queue.documents.some((document) => document.id === 'ictr-f6754fe2f491'), false);
  assert.equal(queue.documents.filter((document) => document.id === 'moe-2011-12').length, 1);

  const ictrSource = sources.sources.find((source) => (
    source.checksum_sha256 === '3cf8c2ddedd1cffa1196aa5f722056ebc48d6588c474d6b432b3bf31083b2818'
  ));
  assert.ok(ictrSource);
  assert.equal(ictrSource.document_id, 'moe-2011-12');
  assert.equal(ictrSource.is_primary, 0);
  assert.equal(ictrSource.artifact_disposition, 'variant');

  const variant = registry.artifacts.find((artifact) => artifact.artifact_id === 'moe-2011-12-ictr-scan');
  assert.ok(variant);
  assert.equal(variant.parent_document_id, 'moe-2011-12');
  assert.equal(variant.parent_sha256, canonical.checksum_sha256);
  assert.equal(variant.sha256, ictrSource.checksum_sha256);
  assert.equal(variant.relation, 'same_edition_cross_validation_scan');
  assert.equal(variant.queue_eligible, false);
  assert.equal(variant.publication_eligible, false);
});
