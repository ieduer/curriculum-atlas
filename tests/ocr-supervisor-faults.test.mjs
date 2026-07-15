import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { selectPrimaryRecoveryPages } from '../scripts/ocr-supervisor.mjs';
import {
  classifyHealth,
  missingCompletedWitnessPages,
  nextPageRetry,
  pageRetryKey,
  retryBlocksPage,
  selectPendingPages,
  witnessRecordValid,
} from '../scripts/lib/ocr-supervisor-state.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function primaryFixture(t) {
  const primaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ocr-primary-recovery-'));
  t.after(() => rm(primaryRoot, { recursive: true, force: true }));
  const pageRoot = path.join(primaryRoot, 'doc', 'pages', '0001');
  await mkdir(pageRoot, { recursive: true });
  const content = '# Original OCR\n';
  const result = '{"text":"Original OCR"}\n';
  await Promise.all([
    writeFile(path.join(pageRoot, 'content.md'), content),
    writeFile(path.join(pageRoot, 'result.json'), result),
  ]);
  return {
    primaryRoot,
    pageRoot,
    document: { id: 'doc', page_count: 1 },
    state: {
      completed_pages: [1],
      pages: {
        1: {
          content_markdown_sha256: sha256(content),
          result_json_sha256: sha256(result),
        },
      },
    },
  };
}

test('one failed page does not block later eligible pages', () => {
  const now = Date.parse('2026-07-15T08:00:00Z');
  const pageRetries = {
    [pageRetryKey('doc', 1, 'vision')]: {
      attempts: 1,
      next_retry_at: '2026-07-15T08:10:00Z',
      quarantined: false,
    },
  };
  assert.deepEqual(selectPendingPages({
    pageCount: 6,
    completedPages: [],
    failedPages: {},
    pageRetries,
    documentId: 'doc',
    limit: 3,
    now,
  }), [2, 3, 4]);
});

test('page retry escalates independently and quarantines only that page-stage key', () => {
  const now = Date.parse('2026-07-15T08:00:00Z');
  let record;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    record = nextPageRetry(record, { stage: 'vision', code: 'VN:1', name: 'VisionError', message: 'transient' }, { now: now + attempt * 60_000 });
  }
  assert.equal(record.attempts, 5);
  assert.equal(record.quarantined, true);
  assert.equal(record.next_retry_at, null);
  assert.equal(retryBlocksPage({ [pageRetryKey('doc', 1, 'vision')]: record }, 'doc', 1, now), true);
  assert.equal(retryBlocksPage({ [pageRetryKey('doc', 1, 'vision')]: record }, 'doc', 2, now), false);
});

test('witness sidecar is rejected when document, page, PDF, image, or file identity drifts', () => {
  const record = {
    file: 'page-001.png',
    lines: [],
    document_id: 'doc',
    physical_pdf_page: 1,
    source_pdf_sha256: 'a'.repeat(64),
    rendered_image_sha256: 'b'.repeat(64),
    engine: 'Apple Vision',
    citation_allowed: false,
  };
  const expected = { file: 'page-001.png', documentId: 'doc', page: 1, pdfSha: 'a'.repeat(64), imageSha: 'b'.repeat(64) };
  assert.equal(witnessRecordValid(record, expected), true);
  assert.equal(witnessRecordValid({ ...record, physical_pdf_page: 2 }, expected), false);
  assert.equal(witnessRecordValid({ ...record, source_pdf_sha256: 'other' }, expected), false);
  assert.equal(witnessRecordValid({ ...record, rendered_image_sha256: 'other' }, expected), false);
  assert.equal(witnessRecordValid({ ...record, rendered_image_sha256: null }, {}), false);
  assert.equal(witnessRecordValid({ ...record, error: 'nilError' }, expected), false);
});

test('missing completed witness pages are a set difference, not a count subtraction', () => {
  assert.deepEqual(missingCompletedWitnessPages([1, 3, 4], [2, 3, 4]), [1]);
});

test('completed page with drifted content.md is selected for primary recovery', async (t) => {
  const fixture = await primaryFixture(t);
  assert.deepEqual(await selectPrimaryRecoveryPages(fixture.document, fixture.state, { primaryRoot: fixture.primaryRoot }), []);
  await writeFile(path.join(fixture.pageRoot, 'content.md'), '# Corrupted OCR\n');
  assert.deepEqual(await selectPrimaryRecoveryPages(fixture.document, fixture.state, { primaryRoot: fixture.primaryRoot }), [1]);
});

test('completed page with drifted result.json is selected for primary recovery', async (t) => {
  const fixture = await primaryFixture(t);
  assert.deepEqual(await selectPrimaryRecoveryPages(fixture.document, fixture.state, { primaryRoot: fixture.primaryRoot }), []);
  await writeFile(path.join(fixture.pageRoot, 'result.json'), '{"text":"Corrupted OCR"}\n');
  assert.deepEqual(await selectPrimaryRecoveryPages(fixture.document, fixture.state, { primaryRoot: fixture.primaryRoot }), [1]);
});

test('health exit code contract distinguishes active, degraded, failed, stalled, and blocked', () => {
  const base = { lockActive: false, stalled: false, diskHardStop: false, witnessErrors: 0, currentRun: { status: 'completed' }, documentRetries: {}, pageRetries: {} };
  assert.deepEqual(classifyHealth(base).overall, 'healthy');
  assert.equal(classifyHealth({ ...base, lockActive: true, currentRun: { status: 'running' } }).exit_code, 75);
  assert.equal(classifyHealth({ ...base, lockActive: true, witnessErrors: 1, currentRun: { status: 'running' } }).exit_code, 75);
  assert.equal(classifyHealth({ ...base, lockActive: true, diskHardStop: true, currentRun: { status: 'running' } }).exit_code, 12);
  assert.equal(classifyHealth({ ...base, pageRetries: { x: { next_retry_at: '2026-07-16T00:00:00Z' } } }).exit_code, 2);
  assert.equal(classifyHealth({ ...base, witnessErrors: 1 }).exit_code, 10);
  assert.equal(classifyHealth({ ...base, lockActive: true, stalled: true }).exit_code, 11);
  assert.equal(classifyHealth({ ...base, pageRetries: { x: { quarantined: true } } }).exit_code, 12);
  assert.equal(classifyHealth({ ...base, pageRetries: { x: { quarantined: true } }, hasEligibleWork: true }).exit_code, 2);
  assert.equal(classifyHealth({ ...base, currentRun: { status: 'failed', error_code: 'MODEL_CHECKSUM_MISMATCH' } }).exit_code, 12);
});
