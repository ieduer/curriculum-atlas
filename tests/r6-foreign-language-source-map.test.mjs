import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const [mapping, schema, catalog, policy] = await Promise.all([
  readFile(new URL('data/online-verification/r6-foreign-language-source-map.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('data/online-verification/r6-foreign-language-source-map.schema.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('data/catalog.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('data/semantic-publication-policy.json', root), 'utf8').then(JSON.parse),
]);

const expectedIds = [
  'ictr-3db457c6f361',
  'ictr-d39597b0d7f5',
  'moe-2011-04',
  'moe-2022-08',
  'ictr-f985431f376f',
];
const catalogById = new Map(catalog.documents.map((record) => [record.id, record]));
const mappingById = new Map(mapping.documents.map((record) => [record.document_id, record]));

function controlledByCurrentPolicy(documentId, pageStart, pageEnd, qualityProfile) {
  return policy.page_controls.some((control) =>
    control.document_id === documentId
    && control.quality_profile === qualityProfile
    && control.status === 'unresolved_fail_closed'
    && control.page_start <= pageStart
    && control.page_end >= pageEnd);
}

test('mapping is task-scoped and cannot change publication state', () => {
  assert.equal(schema.properties.schema_version.const, 1);
  assert.equal(schema.properties.publication_gate_changed.const, false);
  assert.equal(schema.properties.can_unlock.const, false);
  assert.equal(mapping.schema_version, 1);
  assert.equal(mapping.mapping_policy, 'same_edition_online_verification_fail_closed_v1');
  assert.equal(mapping.publication_gate_changed, false);
  assert.equal(mapping.can_unlock, false);
  assert.equal(mapping.policy_snapshot.use, 'read_only_input');
  assert.match(mapping.policy_snapshot.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(mapping.scope_document_ids, expectedIds);
  assert.deepEqual(mapping.documents.map((record) => record.document_id), expectedIds);
});

test('all five identities bind the exact catalog artifact and current unresolved controls', () => {
  for (const document of mapping.documents) {
    const catalogRecord = catalogById.get(document.document_id);
    assert.ok(catalogRecord, `missing catalog record ${document.document_id}`);
    assert.equal(document.identity.title, catalogRecord.title);
    assert.equal(document.identity.subject, catalogRecord.subject);
    assert.equal(document.identity.stage, catalogRecord.stage);
    assert.equal(document.identity.version_label, catalogRecord.version_label);
    assert.equal(document.identity.issued_by, catalogRecord.issued_by);
    assert.equal(document.identity.source_url, catalogRecord.source_url);
    assert.equal(document.identity.source_artifact_sha256, catalogRecord.checksum_sha256);
    assert.equal(document.identity.pdf_page_count, catalogRecord.page_count);
    assert.equal(document.conclusion.publication_gate_changed, false);
    assert.equal(document.conclusion.can_unlock, false);

    for (const controlled of document.controlled_pages) {
      assert.equal(
        controlledByCurrentPolicy(
          document.document_id,
          controlled.page_start,
          controlled.page_end,
          controlled.quality_profile,
        ),
        true,
        `${document.document_id} ${controlled.page_start}-${controlled.page_end} must remain fail-closed`,
      );
    }
  }
});

test('exact artifacts and same-artifact search extraction are never independent witnesses', () => {
  const exactArtifacts = mapping.documents.flatMap((document) =>
    document.online_sources.filter((source) => source.edition_match === 'exact_artifact'));
  assert.ok(exactArtifacts.length >= 6);
  for (const source of exactArtifacts) {
    assert.equal(source.hash_matches_local, true);
    assert.equal(source.independent_text_corroboration, 'none');
    assert.ok(source.not_usable_for.some((value) => value.includes('independent')
      || value.includes('automatic')));
  }

  const sameArtifactExtractions = exactArtifacts.filter((source) =>
    source.text_status === 'same_artifact_search_extraction');
  assert.equal(sameArtifactExtractions.length, 2);
  assert.deepEqual(
    new Set(sameArtifactExtractions.map((source) => source.artifact_sha256)),
    new Set(['42c9c10a4374ca9b88009a666b86c622b828050da5ebaa636e72ca026b54e1cd']),
  );
});

test('2011 Russian secondary artifact has an explicit two-blank-page mapping and remains unconfirmed', () => {
  const document = mappingById.get('moe-2011-04');
  const secondary = document.online_sources.find((source) =>
    source.source_id === 'ictr-compulsory-russian-2011-secondary-pdf');
  assert.equal(secondary.edition_match, 'same_edition_different_artifact');
  assert.equal(secondary.artifact_sha256, '775c9c3989567aa5a81daba7f51684906b09cdd0ef77ce526c55d416b1d95318');
  assert.equal(secondary.pdf_page_count, 90);
  assert.equal(secondary.hash_matches_local, false);
  assert.equal(secondary.independent_text_corroboration, 'unconfirmed');
  assert.deepEqual(document.page_mapping.removed_local_blank_pages, [2, 5]);
  assert.deepEqual(document.page_mapping.controlled_range_mapping, {
    local_page_start: 37,
    local_page_end: 72,
    online_page_start: 35,
    online_page_end: 70,
  });
  assert.equal(document.conclusion.best_online_status, 'same_edition_text_independence_unconfirmed');
  assert.equal(document.conclusion.can_unlock, false);
});

test('Japanese Foundation translation corroborates lexical rows but cannot unlock them', () => {
  const document = mappingById.get('ictr-f985431f376f');
  const translation = document.online_sources.find((source) =>
    source.source_id === 'japan-foundation-2002-china-japanese-standard-translation');
  assert.equal(translation.edition_match, 'same_edition_translation');
  assert.equal(translation.text_status, 'searchable_same_edition_translation');
  assert.equal(translation.independent_text_corroboration, 'translation_only');
  assert.equal(translation.pdf_page_count, 78);
  assert.ok(translation.not_usable_for.includes('automatic release'));

  const page61 = document.page_mapping.local_to_online_physical_pages
    .find((entry) => entry.local_page === 61);
  assert.deepEqual(page61.online_pages, [48, 49]);
  assert.ok(page61.anchors.includes('こおり [氷] 冰'));
  assert.ok(page61.anchors.includes('こくばん [黒板] 黑板'));
  assert.equal(document.conclusion.independent_text_corroboration, 'translation_only');
  assert.equal(document.conclusion.can_unlock, false);
});

test('different editions are warning-only and cannot adjudicate controlled text', () => {
  const differentEditions = mapping.documents.flatMap((document) =>
    document.online_sources.filter((source) => source.edition_match === 'different_edition'));
  assert.ok(differentEditions.length >= 4);
  for (const source of differentEditions) {
    assert.equal(source.independent_text_corroboration, 'none');
    assert.deepEqual(source.usable_for, ['version-difference warning only']);
    assert.ok(source.not_usable_for.length > 0);
  }
});
