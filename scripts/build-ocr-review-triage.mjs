#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const inputPath = path.resolve(ROOT, process.argv[2] || '.cache/ocr-review-queue-20260723.json');
const outputPath = path.resolve(ROOT, process.argv[3] || 'data/ocr-review-triage.json');
const coveragePath = path.resolve(ROOT, 'data/ocr-coverage-ledger.json');
const publicSummaryPath = path.resolve(ROOT, 'public/data/ocr-coverage-summary.json');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function categoryFor(page) {
  if (page.gate === 'blank_page_visual_confirmation_required') return 'blank_visual_confirmation';
  if (page.table?.detected === true) return 'table_cell_reconstruction';
  if (page.agreement >= 0.995
    && page.title?.exact === true
    && page.numeric?.exact === true
    && page.confidence?.average_vision >= 0.8) {
    return 'machine_concordant_sampling_pool';
  }
  return 'text_or_structure_conflict_adjudication';
}

const raw = await readFile(inputPath);
const input = JSON.parse(raw);
if (input.schema_version !== 1
  || input.artifact_type !== 'ocr_review_queue'
  || !Array.isArray(input.queue)
  || input.queue.length !== input.summary?.queued_pages) {
  throw new Error('private OCR review queue contract mismatch');
}
const categoryOrder = [
  'machine_concordant_sampling_pool',
  'text_or_structure_conflict_adjudication',
  'table_cell_reconstruction',
  'blank_visual_confirmation',
];
const byDocument = new Map();
const counts = Object.fromEntries(categoryOrder.map((category) => [category, 0]));
for (const page of input.queue) {
  const category = categoryFor(page);
  counts[category] += 1;
  const documentCounts = byDocument.get(page.document_id)
    || Object.fromEntries(categoryOrder.map((name) => [name, 0]));
  documentCounts[category] += 1;
  byDocument.set(page.document_id, documentCounts);
}
const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
if (total !== input.queue.length) throw new Error('triage categories are not exhaustive');
const output = {
  schema_version: 1,
  artifact_profile: 'curriculum-ocr-review-triage-v1',
  generated_at: new Date().toISOString(),
  source_queue_sha256: sha256(raw),
  root_cause: {
    code: 'critical_field_declaration_contract_never_populated',
    affected_pages: input.queue.filter((page) =>
      page.reasons?.includes('critical_fields_not_declared')).length,
    explanation: 'The Apple Vision witness producer emitted an empty critical_fields array for every audited page, so the release gate correctly prevented all automatic citation passes. The total was therefore an adjudication backlog, not an unfinished dual-engine OCR count.'
  },
  policy: {
    machine_concordant_sampling_pool: 'High structural agreement may enter bounded sampling, but remains non-citation until the sample packet and edition identity are signed.',
    text_or_structure_conflict_adjudication: 'Resolve title, number, text or low-confidence conflict against the scan or an exact-document exact-edition source.',
    table_cell_reconstruction: 'Review tables cell by cell; no aggregate OCR score may release them.',
    blank_visual_confirmation: 'Confirm the rendered scan is genuinely blank.',
    publication_mutation: 'none',
    semantic_claim_allowed: false,
    citation_allowed: false
  },
  counts: {
    audited_dual_witness_pages: input.queue.length,
    ...counts,
    unclassified_pages: input.queue.length - total
  },
  documents: [...byDocument.entries()]
    .map(([document_id, categories]) => ({
      document_id,
      total: Object.values(categories).reduce((sum, count) => sum + count, 0),
      categories
    }))
    .sort((left, right) => left.document_id.localeCompare(right.document_id, 'en'))
};
const coverage = JSON.parse(await readFile(coveragePath, 'utf8'));
const publicSummary = {
  schema_version: 1,
  artifact_profile: 'curriculum-ocr-public-coverage-summary-v1',
  assertion_boundary: 'Candidate page coverage is complete, but OCR completion and dual-witness triage do not open quotation, citation, semantic continuity, first-appearance, disappearance, replacement, influence or causality claims.',
  coverage: {
    nominal_documents: coverage.counts.nominal_documents,
    nominal_pages: coverage.counts.nominal_pages,
    physical_documents: coverage.counts.physical_documents,
    physical_pages: coverage.counts.physical_pages,
    candidate_covered_pages: coverage.counts.candidate_covered_pages_including_review_evidence,
    candidate_remaining_pages: coverage.counts.candidate_remaining_pages,
    single_witness_candidate_fallback_pages: coverage.counts.single_witness_candidate_fallback_pages,
    dual_witness_audited_pages: coverage.counts.dual_witness_audited_pages,
    citation_ready_pages: coverage.counts.citation_ready_pages,
  },
  review_triage: output.counts,
  release_gate: {
    citation_allowed: false,
    semantic_promotion_allowed: false,
    negative_claim_eligible: false,
  },
};
await Promise.all([
  writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`),
  writeFile(publicSummaryPath, `${JSON.stringify(publicSummary, null, 2)}\n`),
]);
process.stdout.write(`${JSON.stringify(output.counts)}\n`);
