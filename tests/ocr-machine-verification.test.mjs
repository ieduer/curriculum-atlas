import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  baseLane,
  buildMachineVerification,
  normalizeExactText,
} from '../scripts/build-ocr-machine-verification.mjs';

const root = new URL('../', import.meta.url);
const [policy, receipt] = await Promise.all([
  readFile(new URL('data/ocr-machine-verification-policy.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('data/ocr-machine-verification.json', root), 'utf8').then(JSON.parse),
]);

test('normalization removes layout-only differences but preserves content', () => {
  assert.equal(normalizeExactText('## 第一部分 前言\n7～9 年级'), '第一部分前言7~9年级');
  assert.notEqual(normalizeExactText('课程目标 2022'), normalizeExactText('课程目标 2023'));
});

test('machine lanes are deterministic and tables stay outside the exact page gate', () => {
  const exact = {
    gate: 'manual_image_review_required',
    agreement: 1,
    title: { exact: true },
    numeric: { exact: true },
    confidence: { average_vision: 0.95 },
    table: { detected: false },
  };
  assert.equal(baseLane(exact, policy), 'exact_page_candidate');
  assert.equal(baseLane({ ...exact, table: { detected: true } }, policy), 'table_structure_consensus');
  assert.equal(baseLane({ ...exact, gate: 'blank_page_visual_confirmation_required' }, policy), 'blank_raster_consensus');
});

test('checked-in machine receipt is fail-closed, exhaustive, and reproducible', async () => {
  const rebuilt = await buildMachineVerification();
  assert.deepEqual(rebuilt, receipt);
  const counts = receipt.counts;
  assert.equal(counts.human_required_pages, 0);
  assert.equal(counts.production_citation_ready_pages, 0);
  assert.ok(counts.machine_verified_exact_pages > 0);
  assert.equal(counts.publication_manifest_eligible_pages, counts.machine_verified_exact_pages);
  assert.equal(counts.machine_verified_exact_pages
    + counts.third_engine_text_consensus_pages
    + counts.table_structure_consensus_pages
    + counts.blank_raster_consensus_pages, counts.audited_pages);
  assert.ok(receipt.verified_pages.every((page) =>
    page.publication_manifest_eligible === true
      && page.production_citation_ready === false
      && page.semantic_claim_allowed === false
      && /^[a-f0-9]{64}$/u.test(page.receipt_sha256)));
});
