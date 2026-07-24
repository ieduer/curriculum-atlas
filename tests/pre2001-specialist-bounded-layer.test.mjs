import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const [itemsArtifact, identityReceipt, layer, families] = await Promise.all([
  readFile(new URL('data/pre2001-specialist-bounded-items.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('data/pre2001-bounded-identity-verification.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/data/pre2001-subject-detail-observation-layer.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/data/concept-evolution-families.json', root), 'utf8').then(JSON.parse),
]);

const expectedFacets = [
  '语文', '数学', '外语', '思想政治与道德法治', '历史', '历史与社会',
  '地理', '科学类', '技术', '劳动', '艺术', '体育与健康',
];

test('the pre-2001 packet is source-bound, bounded, fail-closed, and covers every display facet', () => {
  assert.equal(layer.artifact_profile, 'curriculum-pre2001-subject-detail-observation-layer-v1');
  assert.equal(layer.publication_status, 'candidate_fail_closed');
  assert.equal(layer.counts.source_documents, 12);
  assert.equal(layer.counts.subject_facets, 12);
  assert.equal(layer.counts.bounded_items, 462);
  assert.equal(layer.counts.controlled_concepts, 36);
  assert.equal(layer.counts.observed_concepts, 36);
  assert.equal(layer.counts.episodes, 426);
  assert.equal(layer.counts.evidence, 821);
  assert.equal(itemsArtifact.items.length, 462);
  assert.equal(new Set(itemsArtifact.items.map((item) => item.id)).size, 462);
  assert.deepEqual(
    new Set(layer.concepts.flatMap((concept) => concept.visibility_facets)),
    new Set(expectedFacets),
  );
  assert.ok(itemsArtifact.items.every((item) =>
    item.physical_page_start >= 1
    && item.physical_page_end >= item.physical_page_start
    && item.page_count === item.physical_page_end - item.physical_page_start + 1
    && /^[a-f0-9]{64}$/.test(item.source_sha256)
    && /^[a-f0-9]{64}$/.test(item.range_content_sha256)
    && item.citation_allowed === false
    && item.semantic_claim_allowed === false));
  assert.ok(layer.episodes.every((episode) =>
    episode.time.year < 2001
    && episode.claim_policy.display_level === 'uniform_star'
    && episode.claim_policy.quotation_allowed === false
    && episode.claim_policy.semantic_relation_allowed === false));
});

test('all 462 bounded items have reproducible source-bound identity receipts', () => {
  assert.equal(identityReceipt.artifact_profile, 'curriculum-pre2001-bounded-identity-verification-v1');
  assert.deepEqual(identityReceipt.counts, {
    items: 462,
    unique_item_ids: 462,
    unique_identity_keys: 462,
    unique_physical_ranges: 461,
    intentional_shared_physical_ranges: 1,
    source_item_links: 135,
    distinct_source_items_resolved: 134,
    failed_receipts: 0,
  });
  assert.equal(identityReceipt.receipts.length, 462);
  assert.ok(identityReceipt.receipts.every((receipt) =>
    /^[a-f0-9]{64}$/.test(receipt.identity_sha256)
    && /^[a-f0-9]{64}$/.test(receipt.source_sha256)
    && /^[a-f0-9]{64}$/.test(receipt.ocr_state_sha256)
    && /^[a-f0-9]{64}$/.test(receipt.range_content_sha256)
    && Object.values(receipt.checks).every(Boolean)));
  assert.deepEqual(identityReceipt.shared_physical_ranges, [{
    range_key: 'legacy-compendium-plans|122|125',
    item_ids: [
      'pre2001-item:legacy-compendium-plans:d3c163e6c0b5e7c569',
      'pre2001-item:legacy-compendium-plans:f1ae73f74155b1493e',
    ],
    visibility_facets: ['历史与社会', '体育与健康'],
    disposition: 'intentional_distinct_facet_identities_on_shared_source_range',
  }]);
  assert.equal(identityReceipt.release_gate.deployment_allowed, true);
  assert.equal(identityReceipt.release_gate.citation_allowed, false);
  assert.equal(identityReceipt.release_gate.semantic_claim_allowed, false);
});

test('every facet now crosses the century at practice, content, and ability grain', () => {
  for (const facet of expectedFacets) {
    for (const tier of ['subject-practice-domain', 'subject-content-domain', 'subject-ability-domain']) {
      const family = families.families.find((item) =>
        item.concept_tier_id === tier && item.visibility_facets.includes(facet));
      assert.ok(family, `${facet} ${tier}`);
      assert.ok(family.first_observed_year < 2001, `${facet} ${tier}`);
      assert.ok(family.last_observed_year >= 2001, `${facet} ${tier}`);
    }
  }
});

test('the only released discipline split-merge assertion is the sourced 1923 social-studies grouping', () => {
  assert.equal(layer.discipline_relations.length, 1);
  const relation = layer.discipline_relations[0];
  assert.equal(relation.relation_type, 'integrated_curriculum_contains_disciplines');
  assert.equal(relation.hub_concept_id, 'course-history-society-social-studies');
  assert.deepEqual(relation.member_concept_ids, [
    'course-civics-citizenship',
    'course-history',
    'course-geography',
  ]);
  assert.deepEqual(relation.evidence_pages, [123, 124]);
  assert.ok(relation.claim_boundary.includes('不表示历史演变成'));
});
