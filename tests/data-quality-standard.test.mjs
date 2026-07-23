import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const [standard, receipt] = await Promise.all([
  readFile(new URL('data/data-quality-standard.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('data/data-quality-validation.json', root), 'utf8').then(JSON.parse),
]);

test('the data standard is a non-overridable deployment gate', () => {
  assert.equal(standard.standard_id, 'curriculum-atlas-data-quality-v1');
  assert.equal(standard.release_policy.failure_blocks_preview, true);
  assert.equal(standard.release_policy.failure_blocks_production, true);
  assert.equal(standard.release_policy.manual_override_allowed, false);
  assert.equal(standard.release_policy.ocr_completion_does_not_imply_citation, true);
  assert.equal(standard.release_policy.candidate_observation_does_not_imply_semantic_relation, true);
});

test('the checked-in data validation receipt passes every gate', () => {
  assert.equal(receipt.standard_id, standard.standard_id);
  assert.equal(receipt.release_decision, 'pass');
  assert.equal(receipt.deployment_allowed, true);
  assert.equal(receipt.manual_override_allowed, false);
  assert.ok(receipt.counts.checks >= 20);
  assert.equal(receipt.counts.failed, 0);
  assert.equal(receipt.counts.passed, receipt.counts.checks);
  assert.ok(receipt.checks.every((item) => item.passed === true));
});

test('the receipt preserves OCR candidate, citation, and remaining-page denominators', () => {
  assert.equal(receipt.counts.ocr_nominal_pages, 11847);
  assert.equal(receipt.counts.ocr_candidate_covered_pages, 10770);
  assert.equal(receipt.counts.ocr_candidate_remaining_pages, 1077);
  assert.equal(receipt.counts.ocr_citation_ready_pages, 0);
});
