import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const readJson = (relativePath) => readFile(path.join(root, relativePath), 'utf8').then(JSON.parse);

const [queue, runtime, review, decisions, ledger] = await Promise.all([
  readJson('data/ocr-queue.json'),
  readJson('data/ocr-runtime-status-snapshot.json'),
  readJson('data/ocr-review-queue-index.json'),
  readJson('data/ocr-review-decisions.json'),
  readJson('data/ocr-coverage-ledger.json'),
]);

test('OCR ledger preserves both catalog identity and physical source denominators', () => {
  assert.equal(ledger.contract, 'curriculum_ocr_coverage_ledger_v1');
  assert.equal(ledger.counts.nominal_documents, queue.counts.documents);
  assert.equal(ledger.counts.nominal_pages, queue.counts.pages);
  assert.equal(ledger.counts.nominal_documents, 86);
  assert.equal(ledger.counts.nominal_pages, 11847);
  assert.equal(ledger.counts.physical_documents, 85);
  assert.equal(ledger.counts.physical_pages, 11779);
  assert.deepEqual(ledger.duplicate_physical_sources, [{
    source_sha256: 'd5f080fee80df073ef67f6b0dbe303250913777aee32f98bea4f22df1c6247d8',
    canonical_document_id: 'moe-2022-17',
    alias_document_ids: ['ictr-6c6df9d121ac', 'moe-2022-17'],
    page_count: 68,
  }]);
});

test('OCR ledger has no silent document or page gaps', () => {
  assert.equal(ledger.release_gate.zero_silent_missing_documents, true);
  assert.equal(ledger.release_gate.zero_silent_missing_pages, true);
  assert.equal(ledger.counts.complete_documents, 83);
  assert.equal(ledger.counts.runtime_completed_pages_including_partial_prefixes, 10690);
  assert.equal(ledger.counts.runtime_remaining_pages, 1157);
  assert.equal(ledger.counts.candidate_covered_pages_including_review_evidence, 10770);
  assert.equal(ledger.counts.candidate_remaining_pages, 1077);
  assert.deepEqual(ledger.gaps.map((gap) => ({
    id: gap.document_id,
    range: gap.page_range,
    pages: gap.remaining_pages,
  })), [
    { id: 'legacy-compendium-geography', range: [97, 518], pages: 422 },
    { id: 'legacy-compendium-mathematics', range: [337, 697], pages: 361 },
    { id: 'legacy-compendium-politics', range: [129, 422], pages: 294 },
  ]);
  assert.equal(ledger.gaps.reduce((total, gap) => total + gap.remaining_pages, 0), 1077);
  assert.equal(ledger.documents.length, 86);
  assert.equal(new Set(ledger.documents.map((document) => document.document_id)).size, 86);
  assert.ok(ledger.documents.every((document) =>
    document.candidate_covered_pages + document.candidate_remaining_pages === document.page_count));
});

test('review queue and human decisions remain complete, traceable and fail closed', () => {
  assert.equal(review.queue.length, review.summary.queued_pages);
  assert.equal(review.queue.length, 6947);
  assert.equal(ledger.counts.dual_witness_audited_pages, 6947);
  assert.equal(ledger.counts.human_decided_non_citation_pages, 4);
  assert.equal(ledger.review_queue.pending_pages, 6943);
  assert.equal(decisions.decisions.length, 4);
  assert.ok(review.queue.every((page) => page.citation_allowed === false));
  assert.ok(decisions.decisions.every((decision) =>
    decision.citation_allowed === false && decision.semantic_promotion_allowed === false));
  assert.equal(ledger.counts.citation_ready_pages, 0);
  assert.equal(ledger.release_gate.citation_allowed, false);
  assert.equal(ledger.release_gate.semantic_promotion_allowed, false);
  assert.equal(ledger.release_gate.negative_claim_eligible, false);
});

test('runtime snapshot covers every queue identity exactly once with hash-bound receipts', () => {
  assert.equal(runtime.documents.length, queue.documents.length);
  assert.equal(new Set(runtime.documents.map((document) => document.id)).size, runtime.documents.length);
  assert.equal(runtime.input_receipts.length, 3);
  assert.ok(runtime.input_receipts.every((receipt) => /^[a-f0-9]{64}$/.test(receipt.sha256)));
  assert.deepEqual(
    [...runtime.documents.map((document) => document.id)].sort(),
    [...queue.documents.map((document) => document.id)].sort(),
  );
  assert.ok(runtime.documents.every((document) =>
    /^[a-f0-9]{64}$/.test(document.source_sha256)
    && document.completed_pages + document.remaining_pages === document.page_count
    && document.citation_allowed === false));
});

test('checked-in OCR coverage ledger regenerates byte-for-byte', async () => {
  const { stdout } = await run(process.execPath, ['scripts/build-ocr-coverage-ledger.mjs', '--check'], {
    cwd: root,
  });
  assert.match(stdout, /"documents":86/);
  assert.match(stdout, /"candidate_remaining_pages":1077/);
});
