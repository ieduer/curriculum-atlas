import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validatePageEvidenceRelease } from '../scripts/page-evidence-publication.mjs';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);
const reviewedCatalogIdentity = {
  sha256: 'd67830c39f35d56e704fe79e2379cbd1baf6647c63de59519c4a63031e66afa3',
  bytes: 282948,
};
const zeroPublication = {
  documents: 0,
  pages: 0,
  display_pages: 0,
  citation_pages: 0,
  resolved_semantic_controls: 0,
};

async function json(locator) {
  return JSON.parse(await readFile(new URL(locator, root), 'utf8'));
}

test('reviewed source-recovery catalog rebind remains structurally zero-publication', async () => {
  const [catalogBytes, release, pagePublication, semanticPolicy, recoveryProofs] = await Promise.all([
    readFile(new URL('data/catalog.json', root)),
    json('scripts/page-evidence/fail-closed-manifest.json'),
    json('data/page-publication-manifest.json'),
    json('data/semantic-publication-policy.json'),
    json('data/source-recovery-proofs.json'),
  ]);
  const actualCatalogIdentity = {
    sha256: createHash('sha256').update(catalogBytes).digest('hex'),
    bytes: catalogBytes.length,
  };

  assert.deepEqual(actualCatalogIdentity, reviewedCatalogIdentity);
  assert.deepEqual(release.bindings.catalog, {
    locator: 'data/catalog.json',
    ...reviewedCatalogIdentity,
  });
  assert.equal(release.status, 'unresolved_fail_closed');
  assert.deepEqual(release.bundles, []);
  assert.deepEqual(release.expected_publication, zeroPublication);
  assert.deepEqual(pagePublication.documents, []);
  assert.equal(
    semanticPolicy.page_controls.filter((control) => control.status === 'resolved_after_review').length,
    0,
  );

  const governedDocumentIds = new Set([
    ...recoveryProofs.corrupt_payload_recoveries.map((entry) => entry.document_id),
    ...recoveryProofs.official_archives.flatMap((entry) => entry.members.map((member) => member[0])),
    ...recoveryProofs.official_same_work_scan_variants.map((entry) => entry[0]),
    ...recoveryProofs.native_attachments.map((entry) => entry.document_id),
  ]);
  const catalog = JSON.parse(catalogBytes.toString('utf8'));
  const catalogById = new Map(catalog.documents.map((document) => [document.id, document]));
  assert.equal(catalog.documents.length, 195);
  assert.equal(governedDocumentIds.size, 42);
  for (const documentId of governedDocumentIds) {
    const document = catalogById.get(documentId);
    assert.ok(document, documentId);
    assert.equal(Object.hasOwn(document, 'native_text_cache_path'), true, documentId);
    assert.equal(Object.hasOwn(document, 'native_text_sha256'), true, documentId);
  }

  const result = validatePageEvidenceRelease({ root: rootPath });
  assert.equal(result.valid, true);
  assert.equal(result.publishable, false);
  assert.equal(result.status, 'unresolved_fail_closed');
  assert.deepEqual(result.counts, zeroPublication);
  assert.throws(
    () => validatePageEvidenceRelease({ root: rootPath, requirePublishable: true }),
    /promotion requires/,
  );
});
