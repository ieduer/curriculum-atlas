import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const rendererBinary = '/opt/homebrew/bin/mutool';
const readJson = (relativePath) => readFile(path.join(projectRoot, relativePath), 'utf8').then(JSON.parse);
const expectedIds = [
  ...Array.from({ length: 19 }, (_, index) => `moe-2011-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 17 }, (_, index) => `moe-2022-${String(index + 1).padStart(2, '0')}`),
];

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

test('all 36 cached MOE 2011/2022 scans are fail-closed catalog and queue records', async () => {
  const [metadata, catalog, queue, ingest] = await Promise.all([
    readJson('data/local-official-scans.json'),
    readJson('data/catalog.json'),
    readJson('data/ocr-queue.json'),
    readJson('data/ingest-manifest.json'),
  ]);
  assert.deepEqual(metadata.documents.map((record) => record.id), expectedIds);
  assert.equal(metadata.counts.documents, 36);

  const metadataById = new Map(metadata.documents.map((record) => [record.id, record]));
  const catalogById = new Map(catalog.documents.map((record) => [record.id, record]));
  const queueById = new Map(queue.documents.map((record) => [record.id, record]));
  const ingestById = new Map(ingest.entries.map((record) => [record.id, record]));
  for (const id of expectedIds) {
    const metadataRecord = metadataById.get(id);
    const catalogRecord = catalogById.get(id);
    const queueRecord = queueById.get(id);
    assert.ok(Number.isInteger(metadataRecord.page_count) && metadataRecord.page_count > 0, `${id}: verified page count`);
    assert.match(metadataRecord.checksum_sha256, /^[a-f0-9]{64}$/);
    assert.equal(catalogRecord.local_cache_path, `.cache/sources/${id}.pdf`);
    assert.equal(catalogRecord.page_count, metadataRecord.page_count);
    assert.equal(catalogRecord.text_quality_status, 'ocr_required');
    assert.equal(catalogRecord.citation_allowed, false);
    assert.equal(queueRecord.local_cache_path, catalogRecord.local_cache_path);
    assert.equal(queueRecord.page_count, metadataRecord.page_count);
    assert.equal(queueRecord.source_sha256, metadataRecord.checksum_sha256);
    assert.equal(ingestById.get(id).source_sha256, metadataRecord.checksum_sha256);
    assert.equal(queueRecord.input_quality_status, 'ocr_required');
  }
  assert.equal(queue.counts.priority_0_documents, 2);
  assert.deepEqual(queue.documents.slice(0, 2).map((record) => record.id), ['moe-2011-01', 'moe-2022-03']);
  assert.ok(queue.documents.slice(0, 2).every((record) => record.priority === 0));
  assert.ok(queue.blocked.every((record) => !expectedIds.includes(record.id)));
});

test('checked-in MOE scan metadata matches local PDF page counts and SHA-256 when cache is present', async (t) => {
  const metadata = await readJson('data/local-official-scans.json');
  const paths = metadata.documents.map((record) => path.join(projectRoot, record.local_cache_path));
  const presence = await Promise.all(paths.map(exists));
  if (!presence.some(Boolean)) return t.skip('local source cache is not available');
  assert.ok(presence.every(Boolean), 'local MOE scan cache must be complete when any scan is present');

  for (let index = 0; index < metadata.documents.length; index += 1) {
    const record = metadata.documents[index];
    const filePath = paths[index];
    const [{ stdout }, checksum] = await Promise.all([
      run(rendererBinary, ['info', filePath], { maxBuffer: 4 * 1024 * 1024 }),
      sha256(filePath),
    ]);
    const actualPages = Number(stdout.match(/^Pages:\s+(\d+)$/m)?.[1]);
    assert.equal(actualPages, record.page_count, `${record.id}: page count`);
    assert.equal(checksum, record.checksum_sha256, `${record.id}: checksum`);
  }
});
