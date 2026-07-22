import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { sealCorpusManifest } from '../scripts/import-corpus.mjs';
import {
  CLASSIFICATION,
  DESCRIPTOR_CONTRACT,
  buildPrivateCorpusTar,
  canonicalJsonBuffer,
  createBuildReceipt,
  hydratePrivateCorpusTar,
} from '../scripts/lib/private-corpus-bundle.mjs';
import { hydrateCorpusFromDescriptor } from '../scripts/hydrate-corpus.mjs';
import { publishPrivateCorpusBundle } from '../scripts/publish-private-corpus-bundle.mjs';
import { verifyHydratedCorpusArtifact } from '../scripts/verify-hydrated-corpus.mjs';

const policy = JSON.parse(await readFile(new URL('../data/release-assets-policy.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const fixtureRecipient = `age1${'q'.repeat(58)}`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function put(root, path, value) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, value, { mode: 0o600 });
}

function fixtureManifest(sql, text) {
  return sealCorpusManifest({
    generated_at: '2026-07-22T00:00:00.000Z',
    schema_version: 1,
    release_id: `corpus-${'c'.repeat(24)}`,
    release_fingerprint_sha256: 'c'.repeat(64),
    documents: 1,
    paragraphs: 1,
    fts_rows: 1,
    page_publication_gates: 1,
    displayed_paragraphs: 1,
    accepted_ocr_documents: 0,
    core_table_counts: {
      subjects: 0,
      periods: 5,
      document_relations: 0,
      chapters: 0,
      document_classifications: 1,
      document_sources: 1,
      primary_document_sources: 1,
      subject_insights: 0,
      terms: 0,
      term_relations: 0,
      version_diffs: 0,
      online_verifications: 0,
      online_evidence: 0,
      embedded_items: 0,
    },
    text_asset_count: 1,
    text_assets: [{ document_id: 'doc-a', sha256: sha256(text), bytes: text.length }],
    sql_chunks: 1,
    sql_files: [{ name: '000-core.sql', sha256: sha256(sql), bytes: sql.length }],
    closed_ocr_paragraphs: 0,
    skipped_ocr_documents: 0,
    excluded_exact_duplicate_alias_documents: 0,
    semantic_excluded_pages: 0,
    page_publication_schema_version: 1,
    semantic_publication_schema_version: 1,
    semantic_publication_revision_sha256: 'd'.repeat(64),
  });
}

function descriptorFromBuildReceipt(receipt) {
  return {
    schema_version: 1,
    contract: DESCRIPTOR_CONTRACT,
    classification: CLASSIFICATION,
    public_runtime: false,
    corpus: structuredClone(receipt.corpus),
    bundle: structuredClone(receipt.bundle),
    storage: {
      provider: 'cloudflare_r2_s3',
      bucket: 'bdfz-ops-backups',
      object_key: receipt.storage.object_key,
      receipt_key: `curriculum-atlas/corpus-bundles/v1/receipts/sha256/${'1'.repeat(64)}.json`,
    },
    receipt: { sha256: '1'.repeat(64), bytes: 1 },
  };
}

test('private corpus descriptor schema is explicitly private release inventory', () => {
  const entries = policy.data_inventory.files.filter((entry) =>
    entry.path === 'data/corpus-artifact.schema.json');

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    path: 'data/corpus-artifact.schema.json',
    disposition: 'quality_evidence_private',
    consumers: ['private_corpus_bundle', 'release_manifest'],
  });
  assert.ok(policy.data_inventory.allowed_dispositions.includes(entries[0].disposition));
  assert.notEqual(entries[0].disposition, 'r2_public_metadata');
});

test('package scripts expose each private corpus operator CLI without hidden arguments', () => {
  assert.deepEqual({
    build: packageJson.scripts['corpus:private:build'],
    publish: packageJson.scripts['corpus:private:publish'],
    hydrate: packageJson.scripts['corpus:private:hydrate'],
    verify: packageJson.scripts['corpus:private:verify'],
  }, {
    build: 'node scripts/build-private-corpus-bundle.mjs',
    publish: 'node scripts/publish-private-corpus-bundle.mjs',
    hydrate: 'node scripts/hydrate-corpus.mjs',
    verify: 'node scripts/verify-hydrated-corpus.mjs',
  });
});

test('hydrated corpus verification binds the payload, descriptor, and immutable hydration receipt', async () => {
  const source = await mkdtemp(join(tmpdir(), 'curriculum-private-verify-source-'));
  const destination = await mkdtemp(join(tmpdir(), 'curriculum-private-verify-destination-'));
  try {
    const sql = Buffer.from('SELECT 1;\n');
    const text = Buffer.from('可核查的课程标准正文。\n');
    const manifest = canonicalJsonBuffer(fixtureManifest(sql, text));
    await put(source, 'data/corpus-chunks/manifest.json', manifest);
    await put(source, 'data/corpus-chunks/000-core.sql', sql);
    await put(source, '.cache/text/doc-a.txt', text);

    const built = await buildPrivateCorpusTar({ root: source, ageRecipient: fixtureRecipient });
    const buildReceipt = createBuildReceipt({ built, ciphertextBuffer: Buffer.from('fixture ciphertext') });
    const descriptor = descriptorFromBuildReceipt(buildReceipt);
    const descriptorPath = join(destination, 'operator', 'corpus-artifact.json');
    await put(destination, 'data/corpus-chunks/manifest.json', manifest);
    await put(destination, 'operator/corpus-artifact.json', canonicalJsonBuffer(descriptor));
    const hydrated = await hydratePrivateCorpusTar({ root: destination, tarBuffer: built.tar_buffer });

    const verified = await verifyHydratedCorpusArtifact({ root: destination, descriptorPath });
    assert.equal(verified.valid, true);
    assert.equal(verified.rebuild_performed, false);
    assert.equal(verified.bundle_id, buildReceipt.bundle.bundle_id);
    assert.equal(verified.hydration_receipt, hydrated.receipt_path);

    await writeFile(join(destination, '.cache/text/doc-a.txt'), 'tampered\n');
    await assert.rejects(
      verifyHydratedCorpusArtifact({ root: destination, descriptorPath }),
      /\.cache\/text\/doc-a\.txt hash or byte mismatch/,
    );
    await writeFile(join(destination, '.cache/text/doc-a.txt'), text);
    await rm(join(destination, 'data/corpus-chunks/000-core.sql'));
    await assert.rejects(
      verifyHydratedCorpusArtifact({ root: destination, descriptorPath }),
      /ENOENT/,
    );
    await put(destination, 'data/corpus-chunks/000-core.sql', sql);

    const driftedDescriptor = structuredClone(descriptor);
    driftedDescriptor.corpus.manifest_sha256 = '0'.repeat(64);
    const driftedDescriptorPath = join(destination, 'operator', 'drifted-corpus-artifact.json');
    await writeFile(driftedDescriptorPath, canonicalJsonBuffer(driftedDescriptor));
    await assert.rejects(
      verifyHydratedCorpusArtifact({ root: destination, descriptorPath: driftedDescriptorPath }),
      /hydrated corpus differs from artifact descriptor corpus identity/,
    );

    const hydrationReceiptPath = join(destination, hydrated.receipt_path);
    const hydrationReceipt = JSON.parse(await readFile(hydrationReceiptPath, 'utf8'));
    hydrationReceipt.payload_sha256 = '0'.repeat(64);
    await writeFile(hydrationReceiptPath, canonicalJsonBuffer(hydrationReceipt));
    await assert.rejects(
      verifyHydratedCorpusArtifact({ root: destination, descriptorPath }),
      /hydration receipt does not match the exact private corpus artifact/,
    );
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
});

test('private publish and hydrate reject omitted authorization flags before network access', async () => {
  let networkCalls = 0;
  const fetchImpl = async () => {
    networkCalls += 1;
    throw new Error('network must not be reached');
  };
  await assert.rejects(
    publishPrivateCorpusBundle({ fetchImpl }),
    /private corpus upload requires explicit --allow-private-upload/,
  );
  await assert.rejects(
    hydrateCorpusFromDescriptor({ fetchImpl }),
    /private corpus download requires explicit --allow-private-download/,
  );
  assert.equal(networkCalls, 0);
});
