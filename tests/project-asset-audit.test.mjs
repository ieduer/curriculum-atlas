import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { auditProjectAssets } from '../scripts/audit-project-assets.mjs';

const run = promisify(execFile);
const auditScript = fileURLToPath(new URL('../scripts/audit-project-assets.mjs', import.meta.url));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function writeJson(root, relativePath, value) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(root, relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
}

async function makeFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'curriculum-asset-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.cache/sources'), { recursive: true });
  await mkdir(path.join(root, '.cache/high-school-2020'), { recursive: true });

  const canonical = Buffer.from('%PDF-1.4\ncanonical');
  const ingestOnly = Buffer.from('%PDF-1.4\ningest-only');
  const variant = Buffer.from('%PDF-1.4\nvariant');
  const derived = Buffer.from('%PDF-1.7\nderived-ocr-layer');
  const quarantine = Buffer.alloc(32);
  const sourceArchive = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
  const hashes = {
    canonical: sha256(canonical),
    ingestOnly: sha256(ingestOnly),
    variant: sha256(variant),
    derived: sha256(derived),
    quarantine: sha256(quarantine),
    sourceArchive: sha256(sourceArchive),
  };

  await Promise.all([
    writeFile(path.join(root, '.cache/sources/canonical.pdf'), canonical),
    writeFile(path.join(root, '.cache/sources/canonical-alias.pdf'), canonical),
    writeFile(path.join(root, '.cache/sources/variant.pdf'), variant),
    writeFile(path.join(root, '.cache/sources/derived.pdf'), derived),
    writeFile(path.join(root, '.cache/sources/bad.pdf'), quarantine),
    writeFile(path.join(root, '.cache/sources/source.zip'), sourceArchive),
    writeFile(path.join(root, '.cache/high-school-2020/ingest-only.pdf'), ingestOnly),
  ]);

  const catalog = {
    schema_version: 1,
    documents: [
      {
        id: 'doc-a',
        title: 'Document A',
        local_cache_path: '.cache/sources/canonical.pdf',
        checksum_sha256: hashes.canonical,
        page_count: 1,
        text_quality_status: 'ocr_required',
        citation_allowed: false,
        scan_variants: [
          {
            role: 'cross_validation_only',
            local_cache_path: '.cache/sources/variant.pdf',
            checksum_sha256: hashes.variant,
            page_count: 1,
          },
        ],
      },
      {
        id: 'doc-alias',
        title: 'Document A alias',
        local_cache_path: '.cache/sources/canonical-alias.pdf',
        checksum_sha256: hashes.canonical,
        page_count: 1,
        text_quality_status: 'ocr_required',
        citation_allowed: false,
      },
      {
        id: 'doc-native',
        title: 'Native text document',
        local_cache_path: null,
        checksum_sha256: null,
        page_count: null,
        text_quality_status: 'official_native_text',
        citation_allowed: true,
      },
    ],
  };
  const documentSources = {
    sources: [
      { document_id: 'doc-a', checksum_sha256: hashes.canonical },
    ],
  };
  const ingest = {
    entries: [
      { id: 'doc-a', fetched: true, source_sha256: hashes.canonical, source_bytes: canonical.length },
      { id: 'doc-alias', fetched: true, source_sha256: hashes.canonical, source_bytes: canonical.length },
      { id: 'doc-native', fetched: true, source_sha256: hashes.ingestOnly, source_bytes: ingestOnly.length },
    ],
  };
  const queue = {
    schema_version: 1,
    counts: { documents: 2, pages: 2, blocked_documents: 0 },
    documents: [
      {
        id: 'doc-a',
        local_cache_path: '.cache/sources/canonical.pdf',
        source_sha256: hashes.canonical,
        page_count: 1,
        input_quality_status: 'ocr_required',
      },
      {
        id: 'doc-alias',
        local_cache_path: '.cache/sources/canonical-alias.pdf',
        source_sha256: hashes.canonical,
        page_count: 1,
        input_quality_status: 'ocr_required',
      },
    ],
    blocked: [],
  };
  const registry = {
    schema_version: 1,
    policy: 'fixture_fail_closed_assets',
    source_roots: ['.cache/sources', '.cache/high-school-2020'],
    ocr_queue_statuses: ['ocr_required', 'ocr_in_quality_review'],
    allowed_dispositions: ['canonical', 'variant', 'derived', 'quarantine'],
    downloads_relevant_name_pattern: '课程标准|教学大纲',
    expected_counts: {
      catalog_documents: 3,
      document_source_records: 1,
      ingest_entries: 3,
      source_pdf_files: 6,
      unique_source_pdf_artifacts: 5,
      invalid_pdf_files: 1,
      explicit_artifacts: 3,
      quarantine_artifacts: 1,
      source_archive_containers: 1,
      nominal_queue_documents: 2,
      nominal_queue_pages: 2,
      unique_queue_artifacts: 1,
      unique_queue_pages: 1,
      blocked_documents: 0,
    },
    document_aliases: [
      {
        source_artifact_sha256: hashes.canonical,
        canonical_document_id: 'doc-a',
        alias_document_ids: ['doc-alias'],
        relation: 'exact_source_duplicate',
      },
    ],
    artifacts: [
      {
        artifact_id: 'variant-a',
        disposition: 'variant',
        sha256: hashes.variant,
        size_bytes: variant.length,
        paths: ['.cache/sources/variant.pdf'],
        parent_document_id: 'doc-a',
        parent_sha256: hashes.canonical,
        valid_pdf_required: true,
        queue_eligible: false,
        publication_eligible: false,
      },
      {
        artifact_id: 'derived-a',
        disposition: 'derived',
        sha256: hashes.derived,
        size_bytes: derived.length,
        paths: ['.cache/sources/derived.pdf'],
        parent_document_id: 'doc-a',
        parent_sha256: hashes.canonical,
        lineage_status: 'incomplete_review_required',
        valid_pdf_required: true,
        queue_eligible: false,
        publication_eligible: false,
      },
      {
        artifact_id: 'quarantine-a',
        disposition: 'quarantine',
        sha256: hashes.quarantine,
        size_bytes: quarantine.length,
        paths: ['.cache/sources/bad.pdf'],
        intended_document_id: 'doc-native',
        valid_pdf_required: false,
        expected_pdf_magic: false,
        queue_eligible: false,
        publication_eligible: false,
      },
    ],
    source_archive_containers: [
      {
        artifact_id: 'source-archive',
        sha256: hashes.sourceArchive,
        size_bytes: sourceArchive.length,
        paths: ['.cache/sources/source.zip'],
        expected_magic_hex: '504b0304',
        queue_eligible: false,
        publication_eligible: false,
      },
    ],
  };

  await Promise.all([
    writeJson(root, 'data/catalog.json', catalog),
    writeJson(root, 'data/document-sources.json', documentSources),
    writeJson(root, 'data/ingest-manifest.json', ingest),
    writeJson(root, 'data/ocr-queue.json', queue),
    writeJson(root, 'data/artifact-registry.json', registry),
  ]);
  return { root, hashes };
}

test('accepts a complete asset ledger with canonical, alias, variant, derived, quarantine, and archive records', async (t) => {
  const { root } = await makeFixture(t);
  const result = await auditProjectAssets({ projectRoot: root });
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.deepEqual(result.source_inventory.dispositions, {
    canonical: 2,
    variant: 1,
    derived: 1,
    quarantine: 1,
  });
  assert.equal(result.queue.nominal_documents, 2);
  assert.equal(result.queue.unique_artifacts, 1);
  assert.equal(result.queue.unique_pages, 1);
});

test('document source records may identify a same-edition scan as a variant artifact', async (t) => {
  const { root, hashes } = await makeFixture(t);
  const sources = await readJson(root, 'data/document-sources.json');
  sources.sources.push({
    document_id: 'doc-a',
    checksum_sha256: hashes.variant,
    artifact_disposition: 'variant',
    is_primary: 0,
  });
  await writeJson(root, 'data/document-sources.json', sources);

  const registry = await readJson(root, 'data/artifact-registry.json');
  registry.expected_counts.document_source_records = 2;
  await writeJson(root, 'data/artifact-registry.json', registry);

  const result = await auditProjectAssets({ projectRoot: root });
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});

test('fails closed when a physical source PDF has no disposition', async (t) => {
  const { root } = await makeFixture(t);
  await writeFile(path.join(root, '.cache/sources/forgotten.pdf'), Buffer.from('%PDF-1.4\nforgotten'));
  const result = await auditProjectAssets({ projectRoot: root });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.code === 'unregistered_source_artifact'));
});

test('fails closed when duplicate catalog or queue documents lack an exact alias mapping', async (t) => {
  const { root } = await makeFixture(t);
  const registry = await readJson(root, 'data/artifact-registry.json');
  registry.document_aliases = [];
  await writeJson(root, 'data/artifact-registry.json', registry);
  const result = await auditProjectAssets({ projectRoot: root });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.code === 'catalog_duplicate_without_exact_alias'));
  assert.ok(result.errors.some((entry) => entry.code === 'duplicate_queue_artifact_without_alias'));
});

test('fails closed when queue plus blocked records do not cover OCR-required catalog documents', async (t) => {
  const { root } = await makeFixture(t);
  const [queue, registry] = await Promise.all([
    readJson(root, 'data/ocr-queue.json'),
    readJson(root, 'data/artifact-registry.json'),
  ]);
  queue.documents = queue.documents.slice(0, 1);
  queue.counts.documents = 1;
  queue.counts.pages = 1;
  registry.expected_counts.nominal_queue_documents = 1;
  registry.expected_counts.nominal_queue_pages = 1;
  await Promise.all([
    writeJson(root, 'data/ocr-queue.json', queue),
    writeJson(root, 'data/artifact-registry.json', registry),
  ]);
  const result = await auditProjectAssets({ projectRoot: root });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.code === 'ocr_queue_coverage_drift'));
});

test('audits relevant Downloads copies and rejects a matching but unregistered file', async (t) => {
  const { root } = await makeFixture(t);
  const downloadsRoot = path.join(root, 'Downloads');
  await mkdir(downloadsRoot);
  const canonical = await readFile(path.join(root, '.cache/sources/canonical.pdf'));
  await Promise.all([
    writeFile(path.join(downloadsRoot, '课程标准.pdf'), canonical),
    writeFile(path.join(downloadsRoot, '教学大纲.pdf'), Buffer.from('%PDF-1.4\nnot-ingested')),
  ]);
  const result = await auditProjectAssets({ projectRoot: root, downloadsRoot });
  assert.equal(result.ok, false);
  assert.equal(result.downloads.relevant_files, 2);
  assert.ok(result.errors.some((entry) => entry.code === 'unregistered_download_artifact'));
});

test('CLI exits non-zero and emits JSON when the audit fails', async (t) => {
  const { root } = await makeFixture(t);
  await writeFile(path.join(root, '.cache/sources/forgotten.pdf'), Buffer.from('%PDF-1.4\nforgotten-cli'));
  await assert.rejects(
    run(process.execPath, [auditScript, '--project-root', root]),
    (error) => {
      assert.equal(error.code, 1);
      const result = JSON.parse(error.stdout);
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((entry) => entry.code === 'unregistered_source_artifact'));
      return true;
    },
  );
});
