import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildOcrReviewQueue,
  parseOcrReviewQueueArgs,
  writeOcrReviewQueue,
} from '../scripts/build-ocr-review-queue.mjs';

const SHA = {
  primary: 'a'.repeat(64),
  witness: 'b'.repeat(64),
  alternate: 'c'.repeat(64),
};

function auditPage(page, overrides = {}) {
  return {
    page,
    primary_path: `/evidence/primary/page-${page}.md`,
    witness_path: `/evidence/witness/page-${page}.json`,
    primary_sha256: SHA.primary,
    witness_sha256: SHA.witness,
    normalized_character_agreement: 0.99,
    primary_character_count: 100,
    witness_character_count: 100,
    title_exact: true,
    primary_heading: `Primary ${page}`,
    witness_heading: `Witness ${page}`,
    numeric_sequence_exact: true,
    primary_numbers: [`${page}`],
    witness_numbers: [`${page}`],
    critical_fields_declared: 0,
    critical_fields_exact: false,
    table_detected: false,
    average_vision_confidence: 0.9,
    low_confidence_line_count: 0,
    gate: 'manual_image_review_required',
    ...overrides,
  };
}

function auditReport(start, end, pages) {
  return {
    schema_version: 1,
    page_range: [start, end],
    summary: {
      pages: pages.length,
      automatic_witness_pass: pages.filter((page) => page.gate === 'automatic_witness_pass').length,
      manual_image_review_required: pages.filter((page) => page.gate === 'manual_image_review_required').length,
      blank_page_visual_confirmation_required: pages
        .filter((page) => page.gate === 'blank_page_visual_confirmation_required').length,
      unresolved_fail_closed: pages.filter((page) => page.gate === 'unresolved_fail_closed').length,
    },
    pages,
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ocr-review-queue-'));
  return {
    root,
    witnessRoot: path.join(root, 'witness'),
    outputPath: path.join(root, 'output', 'review-queue.json'),
  };
}

async function writeAudit(witnessRoot, documentId, start, end, pages) {
  const auditsRoot = path.join(witnessRoot, documentId, 'audits');
  await mkdir(auditsRoot, { recursive: true });
  const filename = `audit-${String(start).padStart(4, '0')}-${String(end).padStart(4, '0')}.json`;
  const target = path.join(auditsRoot, filename);
  await writeFile(target, `${JSON.stringify(auditReport(start, end, pages), null, 2)}\n`);
  return target;
}

test('builds a deterministic fail-closed queue with stable review priority', async () => {
  const value = await fixture();
  await writeAudit(value.witnessRoot, 'doc-b', 1, 1, [
    auditPage(1, { table_detected: true }),
  ]);
  await writeAudit(value.witnessRoot, 'doc-a', 2, 2, [
    auditPage(2, { numeric_sequence_exact: false, witness_numbers: ['200'] }),
  ]);
  await writeAudit(value.witnessRoot, 'doc-a', 3, 3, [
    auditPage(3, {
      normalized_character_agreement: 0.7,
      gate: 'unresolved_fail_closed',
    }),
  ]);
  await writeAudit(value.witnessRoot, 'doc-a', 4, 4, [
    auditPage(4),
  ]);
  await writeAudit(value.witnessRoot, 'doc-a', 5, 5, [
    auditPage(5, {
      gate: 'blank_page_visual_confirmation_required',
      normalized_character_agreement: 1,
      primary_character_count: 0,
      witness_character_count: 0,
      title_exact: false,
      primary_heading: '',
      witness_heading: '',
      primary_numbers: [],
      witness_numbers: [],
    }),
  ]);
  await writeAudit(value.witnessRoot, 'doc-a', 6, 6, [
    auditPage(6, {
      gate: 'automatic_witness_pass',
      normalized_character_agreement: 1,
      critical_fields_declared: 1,
      critical_fields_exact: true,
    }),
  ]);

  const first = await buildOcrReviewQueue({ witnessRoot: value.witnessRoot });
  const second = await buildOcrReviewQueue({ witnessRoot: value.witnessRoot });
  assert.deepEqual(second, first);
  assert.equal(first.policy.publication_mutation, 'none');
  assert.equal(first.summary.unique_pages, 6);
  assert.equal(first.summary.queued_pages, 5);
  assert.equal(first.summary.automatic_witness_pass_excluded, 1);
  assert.deepEqual(first.queue.map((page) => page.priority.code), [
    'table_reconstruction',
    'title_or_numeric_conflict',
    'low_character_agreement',
    'manual_image_review',
    'blank_visual_confirmation',
  ]);
  assert.deepEqual(first.queue.map((page) => page.stable_locator), [
    'doc-b:page:1',
    'doc-a:page:2',
    'doc-a:page:3',
    'doc-a:page:4',
    'doc-a:page:5',
  ]);
  assert.deepEqual(first.queue[0].primary, {
    paths: ['/evidence/primary/page-1.md'],
    sha256: SHA.primary,
  });
  assert.deepEqual(first.queue[0].witness, {
    paths: ['/evidence/witness/page-1.json'],
    sha256: SHA.witness,
  });
  assert.ok(first.queue[0].reasons.includes('table_detected_cell_by_cell_review_required'));
  assert.ok(first.queue[1].reasons.includes('numeric_sequence_conflict'));
  assert.ok(first.queue[2].reasons.includes('normalized_character_agreement_below_manual_threshold'));
  assert.deepEqual(first.queue[4].reasons, [
    'critical_fields_not_declared',
    'blank_page_visual_confirmation_required',
  ]);

  await writeOcrReviewQueue({
    witnessRoot: value.witnessRoot,
    outputPath: value.outputPath,
  });
  const firstOutput = await readFile(value.outputPath, 'utf8');
  await writeOcrReviewQueue({
    witnessRoot: value.witnessRoot,
    outputPath: value.outputPath,
  });
  assert.equal(await readFile(value.outputPath, 'utf8'), firstOutput);
});

test('deduplicates only identical overlapping page evidence and records every audit path', async () => {
  const value = await fixture();
  const duplicatePage = auditPage(1, { table_detected: true });
  await writeAudit(value.witnessRoot, 'doc-a', 1, 1, [duplicatePage]);
  await writeAudit(value.witnessRoot, 'doc-a', 1, 2, [
    auditPage(1, {
      table_detected: true,
      primary_path: '.cache/primary/page-1.md',
      witness_path: '.cache/witness/page-1.json',
    }),
    auditPage(2, {
      gate: 'automatic_witness_pass',
      normalized_character_agreement: 1,
      critical_fields_declared: 1,
      critical_fields_exact: true,
    }),
  ]);

  const artifact = await buildOcrReviewQueue({ witnessRoot: value.witnessRoot });
  assert.equal(artifact.summary.input_page_records, 3);
  assert.equal(artifact.summary.unique_pages, 2);
  assert.equal(artifact.summary.duplicate_page_records, 1);
  assert.equal(artifact.queue.length, 1);
  assert.deepEqual(artifact.queue[0].source_audit_paths, [
    'doc-a/audits/audit-0001-0001.json',
    'doc-a/audits/audit-0001-0002.json',
  ]);
  assert.deepEqual(artifact.queue[0].primary.paths, [
    '.cache/primary/page-1.md',
    '/evidence/primary/page-1.md',
  ]);
  assert.deepEqual(artifact.queue[0].witness.paths, [
    '.cache/witness/page-1.json',
    '/evidence/witness/page-1.json',
  ]);
});

test('fails closed when overlapping page evidence conflicts', async () => {
  const value = await fixture();
  await writeAudit(value.witnessRoot, 'doc-a', 1, 1, [auditPage(1)]);
  await writeAudit(value.witnessRoot, 'doc-a', 1, 2, [
    auditPage(1, { witness_sha256: SHA.alternate }),
    auditPage(2),
  ]);

  await assert.rejects(
    writeOcrReviewQueue({
      witnessRoot: value.witnessRoot,
      outputPath: value.outputPath,
    }),
    /conflicting duplicate page record for doc-a:page:1/,
  );
  await assert.rejects(access(value.outputPath), /ENOENT/);
});

test('fails explicitly on malformed JSON or missing required page fields without writing output', async (t) => {
  await t.test('malformed JSON', async () => {
    const value = await fixture();
    const auditsRoot = path.join(value.witnessRoot, 'doc-a', 'audits');
    await mkdir(auditsRoot, { recursive: true });
    await writeFile(path.join(auditsRoot, 'audit-0001-0001.json'), '{"pages":');
    await assert.rejects(
      writeOcrReviewQueue({
        witnessRoot: value.witnessRoot,
        outputPath: value.outputPath,
      }),
      /contains invalid JSON/,
    );
    await assert.rejects(access(value.outputPath), /ENOENT/);
  });

  await t.test('missing hash', async () => {
    const value = await fixture();
    const page = auditPage(1);
    delete page.primary_sha256;
    await writeAudit(value.witnessRoot, 'doc-a', 1, 1, [page]);
    await assert.rejects(
      writeOcrReviewQueue({
        witnessRoot: value.witnessRoot,
        outputPath: value.outputPath,
      }),
      /primary_sha256 is required/,
    );
    await assert.rejects(access(value.outputPath), /ENOENT/);
  });

  await t.test('invalid audit filename', async () => {
    const value = await fixture();
    const auditsRoot = path.join(value.witnessRoot, 'doc-a', 'audits');
    await mkdir(auditsRoot, { recursive: true });
    await writeFile(path.join(auditsRoot, 'audit-latest.json'), '{}\n');
    await assert.rejects(
      writeOcrReviewQueue({
        witnessRoot: value.witnessRoot,
        outputPath: value.outputPath,
      }),
      /has an invalid audit filename/,
    );
    await assert.rejects(access(value.outputPath), /ENOENT/);
  });

  await t.test('gate does not match recomputed evidence', async () => {
    const value = await fixture();
    await writeAudit(value.witnessRoot, 'doc-a', 1, 1, [
      auditPage(1, {
        gate: 'automatic_witness_pass',
        normalized_character_agreement: 1,
        critical_fields_declared: 1,
        critical_fields_exact: true,
        table_detected: true,
      }),
    ]);
    await assert.rejects(
      writeOcrReviewQueue({
        witnessRoot: value.witnessRoot,
        outputPath: value.outputPath,
      }),
      /does not match recomputed gate/,
    );
    await assert.rejects(access(value.outputPath), /ENOENT/);
  });
});

test('CLI arguments require one witness root and one output path', () => {
  assert.deepEqual(
    parseOcrReviewQueueArgs(['--witness-root', 'witness', '--output', 'queue.json']),
    { witnessRoot: 'witness', outputPath: 'queue.json' },
  );
  assert.throws(
    () => parseOcrReviewQueueArgs(['--witness-root', 'witness']),
    /--output is required/,
  );
  assert.throws(
    () => parseOcrReviewQueueArgs(['--witness-root', 'one', '--witness-root', 'two', '--output', 'queue']),
    /duplicate argument/,
  );
});
