import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const standard = JSON.parse(await readFile(new URL('data/online-verification-standard.json', root), 'utf8'));
const samples = JSON.parse(await readFile(new URL('data/online-verification-samples.json', root), 'utf8')).samples;

test('verification policy forbids cross-edition text replacement', () => {
  assert.ok(standard.gates.forbidden.includes('silently replacing historical wording with a newer edition'));
  assert.ok(standard.edition_match_statuses.includes('same_work_different_edition'));
  assert.ok(standard.verification_statuses.includes('human_judgment_with_warning'));
  assert.ok(standard.verification_statuses.includes('unresolved_fail_closed'));
});

test('citation-enabled samples satisfy the version-aware evidence gate', () => {
  assert.ok(samples.length > 0);
  for (const sample of samples.filter((item) => item.citation_allowed)) {
    assert.match(sample.source_image_sha256, /^[a-f0-9]{64}$/);
    assert.match(sample.primary_ocr_sha256, /^[a-f0-9]{64}$/);
    assert.ok(['verified_exact', 'verified_stable_fact_only'].includes(sample.verification_status));
    assert.equal(sample.uncertainty_note, null);
    assert.ok(sample.ocr_witnesses.filter((item) => item.assessment.startsWith('supports')).length >= 2);
    assert.ok(sample.online_evidence.some((item) => item.version_match === 'exact_document_exact_edition'));
    assert.ok(sample.online_evidence.length >= 2);
  }
});

test('different-edition witnesses are scoped to stable facts', () => {
  for (const sample of samples) {
    for (const evidence of sample.online_evidence.filter((item) => item.version_match === 'same_work_different_edition')) {
      assert.match(evidence.role, /stable_/);
    }
  }
});
