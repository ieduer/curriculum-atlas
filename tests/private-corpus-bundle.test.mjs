import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { sealCorpusManifest } from '../scripts/import-corpus.mjs';
import {
  BUNDLE_CONTRACT,
  CLASSIFICATION,
  DESCRIPTOR_CONTRACT,
  PUBLISH_RECEIPT_CONTRACT,
  assertParsedBundleMatchesBuildReceipt,
  assertParsedBundleMatchesDescriptor,
  buildPrivateCorpusTar,
  canonicalJsonBuffer,
  createBuildReceipt,
  createDeterministicUstar,
  hydratePrivateCorpusTar,
  parsePrivateCorpusTar,
  parseUstar,
  readPrivateFile,
  sha256,
  validateCorpusArtifactDescriptor,
  validatePublishReceipt,
} from '../scripts/lib/private-corpus-bundle.mjs';
import {
  buildEncryptedPrivateCorpusBundle,
  compressAndEncryptAge,
} from '../scripts/build-private-corpus-bundle.mjs';
import {
  decryptAndDecompressAge,
  hydrateCorpusFromDescriptor,
  validatePublishReceiptAgainstDescriptor,
} from '../scripts/hydrate-corpus.mjs';
import {
  getObject,
  publishPrivateCorpusBundle,
  putObjectIfAbsent,
  signR2Request,
} from '../scripts/publish-private-corpus-bundle.mjs';

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

const FIXTURE_AGE_RECIPIENT = `age1${'q'.repeat(58)}`;

async function put(root, path, value) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, value);
  return Buffer.from(value);
}

function corpusManifest(sql, text) {
  return sealCorpusManifest({
    generated_at: '2026-07-18T00:00:00.000Z',
    schema_version: 1,
    release_id: `corpus-${'b'.repeat(24)}`,
    release_fingerprint_sha256: 'b'.repeat(64),
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
    text_assets: [{ document_id: 'doc-a', sha256: hash(text), bytes: text.length }],
    sql_chunks: 1,
    sql_files: [{ name: '000-core.sql', sha256: hash(sql), bytes: sql.length }],
    closed_ocr_paragraphs: 0,
    skipped_ocr_documents: 0,
    excluded_exact_duplicate_alias_documents: 0,
    semantic_excluded_pages: 0,
    page_publication_schema_version: 1,
    semantic_publication_schema_version: 1,
    semantic_publication_revision_sha256: 'a'.repeat(64),
  });
}

async function corpusFixture() {
  const root = await mkdtemp(join(tmpdir(), 'curriculum-private-corpus-fixture-'));
  const sql = Buffer.from('SELECT 1;\n');
  const text = Buffer.from('可核查的课程标准正文。\n');
  const manifest = corpusManifest(sql, text);
  const manifestBuffer = canonicalJsonBuffer(manifest);
  await put(root, 'data/corpus-chunks/manifest.json', manifestBuffer);
  await put(root, 'data/corpus-chunks/000-core.sql', sql);
  await put(root, '.cache/text/doc-a.txt', text);
  return { root, sql, text, manifest, manifestBuffer };
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
    receipt: { sha256: '1'.repeat(64), bytes: 234 },
  };
}

function publishReceiptFromBuildReceipt(receipt) {
  return {
    schema_version: 1,
    contract: PUBLISH_RECEIPT_CONTRACT,
    classification: CLASSIFICATION,
    public_runtime: false,
    corpus: structuredClone(receipt.corpus),
    bundle: structuredClone(receipt.bundle),
    storage: {
      provider: 'cloudflare_r2_s3',
      bucket: 'bdfz-ops-backups',
      object_key: receipt.storage.object_key,
      etag: '"fixture-etag"',
    },
    verification: {
      conditional_create: true,
      ciphertext_readback: true,
      decrypt_replay: true,
      bundle_manifest_replay: true,
    },
  };
}

function bindPublishReceipt(descriptor, receipt) {
  const buffer = canonicalJsonBuffer(receipt);
  descriptor.receipt = { sha256: sha256(buffer), bytes: buffer.length };
  descriptor.storage.receipt_key = `curriculum-atlas/corpus-bundles/v1/receipts/sha256/${descriptor.receipt.sha256}.json`;
  return buffer;
}

test('deterministic USTAR is byte-identical, canonically ordered, and round-trips regular files', () => {
  const first = createDeterministicUstar([
    { path: 'z-last.txt', buffer: Buffer.from('z') },
    { path: 'corpus/text/语文.txt', buffer: Buffer.from('中文路径') },
    { path: 'a-first.txt', buffer: Buffer.from('a') },
  ]);
  const second = createDeterministicUstar([
    { path: 'a-first.txt', buffer: Buffer.from('a') },
    { path: 'z-last.txt', buffer: Buffer.from('z') },
    { path: 'corpus/text/语文.txt', buffer: Buffer.from('中文路径') },
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.length % 512, 0);
  assert.deepEqual(parseUstar(first).map(({ path, buffer }) => [path, buffer.toString()]), [
    ['a-first.txt', 'a'],
    ['corpus/text/语文.txt', '中文路径'],
    ['z-last.txt', 'z'],
  ]);
});

test('USTAR creator rejects traversal, absolute, duplicate, backslash, and overlong paths', () => {
  for (const path of ['../escape', '/absolute', 'a\\b', './dot', 'a//b', `${'x'.repeat(101)}`]) {
    assert.throws(
      () => createDeterministicUstar([{ path, buffer: Buffer.from('x') }]),
      /archive path|USTAR path/,
    );
  }
  assert.throws(
    () => createDeterministicUstar([
      { path: 'same', buffer: Buffer.from('a') },
      { path: 'same', buffer: Buffer.from('b') },
    ]),
    /duplicate archive path/,
  );
});

test('strict USTAR parser rejects checksum, payload padding, header metadata, and trailing bytes', () => {
  const valid = createDeterministicUstar([{ path: 'file.txt', buffer: Buffer.from('x') }]);
  const corruptChecksum = Buffer.from(valid);
  corruptChecksum[0] ^= 1;
  assert.throws(() => parseUstar(corruptChecksum), /checksum|canonical/);

  const corruptPadding = Buffer.from(valid);
  corruptPadding[513] = 1;
  assert.throws(() => parseUstar(corruptPadding), /padding/);

  const linkHeader = Buffer.from(valid);
  linkHeader[156] = '2'.charCodeAt(0);
  linkHeader.fill(0x20, 148, 156);
  const checksum = linkHeader.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  linkHeader.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  assert.throws(() => parseUstar(linkHeader), /regular|canonical/);

  assert.throws(() => parseUstar(Buffer.concat([valid, Buffer.alloc(512)])), /terminator|trailing/);
});

test('private corpus tar contains only the canonical bundle manifest and exact declared payload', async () => {
  const fixture = await corpusFixture();
  try {
    const built = await buildPrivateCorpusTar({ root: fixture.root, ageRecipient: FIXTURE_AGE_RECIPIENT });
    assert.equal(built.bundle_manifest.contract, BUNDLE_CONTRACT);
    assert.equal(built.bundle_manifest.classification, CLASSIFICATION);
    assert.equal(built.bundle_manifest.public_runtime, false);
    assert.equal(built.bundle_manifest.age_recipient, FIXTURE_AGE_RECIPIENT);
    assert.equal(built.bundle_manifest.payload_file_count, 3);
    assert.equal(built.bundle_manifest.archive_file_count, 4);
    assert.deepEqual(built.bundle_manifest.files.map((entry) => entry.path), [
      'corpus/manifest.json',
      'corpus/sql/000-core.sql',
      'corpus/text/doc-a.txt',
    ]);
    const parsed = parsePrivateCorpusTar(built.tar_buffer);
    assert.deepEqual(parsed.bundle_manifest, built.bundle_manifest);
    assert.equal(parsed.bundle_manifest_sha256, built.bundle_manifest_sha256);
    assert.deepEqual(parsed.files.get('corpus/manifest.json'), fixture.manifestBuffer);
    assert.deepEqual(parsed.files.get('corpus/sql/000-core.sql'), fixture.sql);
    assert.deepEqual(parsed.files.get('corpus/text/doc-a.txt'), fixture.text);
    assert.equal(sha256(built.tar_buffer), built.plaintext_tar_sha256);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('private corpus builder fails closed on missing, extra, mismatched, or symlinked inputs', async () => {
  const missing = await corpusFixture();
  try {
    await rm(join(missing.root, '.cache/text/doc-a.txt'));
    await assert.rejects(
      buildPrivateCorpusTar({ root: missing.root, ageRecipient: FIXTURE_AGE_RECIPIENT }),
      /missing|ENOENT/,
    );
  } finally {
    await rm(missing.root, { recursive: true, force: true });
  }

  const extra = await corpusFixture();
  try {
    await put(extra.root, 'data/corpus-chunks/001-paragraphs.sql', 'extra');
    await assert.rejects(
      buildPrivateCorpusTar({ root: extra.root, ageRecipient: FIXTURE_AGE_RECIPIENT }),
      /SQL inventory contains undeclared/,
    );
  } finally {
    await rm(extra.root, { recursive: true, force: true });
  }

  const mismatch = await corpusFixture();
  try {
    await writeFile(join(mismatch.root, '.cache/text/doc-a.txt'), 'mutated');
    await assert.rejects(
      buildPrivateCorpusTar({ root: mismatch.root, ageRecipient: FIXTURE_AGE_RECIPIENT }),
      /hash or byte mismatch/,
    );
  } finally {
    await rm(mismatch.root, { recursive: true, force: true });
  }

  const linked = await corpusFixture();
  try {
    const target = join(linked.root, 'real.txt');
    await writeFile(target, linked.text);
    await rm(join(linked.root, '.cache/text/doc-a.txt'));
    await symlink(target, join(linked.root, '.cache/text/doc-a.txt'));
    await assert.rejects(
      buildPrivateCorpusTar({ root: linked.root, ageRecipient: FIXTURE_AGE_RECIPIENT }),
      /symbolic link|regular file/,
    );
  } finally {
    await rm(linked.root, { recursive: true, force: true });
  }
});

test('private corpus parser rejects a tampered bundle manifest and undeclared archive members', async () => {
  const fixture = await corpusFixture();
  try {
    const built = await buildPrivateCorpusTar({ root: fixture.root, ageRecipient: FIXTURE_AGE_RECIPIENT });
    const entries = parseUstar(built.tar_buffer);
    const manifestEntry = entries[0];
    const manifest = JSON.parse(manifestEntry.buffer);
    manifest.payload_bytes += 1;
    const tamperedManifest = createDeterministicUstar([
      { path: 'bundle-manifest.json', buffer: canonicalJsonBuffer(manifest) },
      ...entries.slice(1),
    ]);
    assert.throws(() => parsePrivateCorpusTar(tamperedManifest), /payload bytes|identity/);

    const extra = createDeterministicUstar([
      ...entries,
      { path: 'corpus/text/undeclared.txt', buffer: Buffer.from('extra') },
    ]);
    assert.throws(() => parsePrivateCorpusTar(extra), /archive inventory/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('every derivable build-receipt and descriptor identity is bound before publication or hydration', async () => {
  const fixture = await corpusFixture();
  try {
    const built = await buildPrivateCorpusTar({ root: fixture.root, ageRecipient: FIXTURE_AGE_RECIPIENT });
    const ciphertext = Buffer.from('fixture encrypted bytes');
    const receipt = createBuildReceipt({ built, ciphertextBuffer: ciphertext });
    const parsed = parsePrivateCorpusTar(built.tar_buffer);
    assert.equal(assertParsedBundleMatchesBuildReceipt(parsed, receipt), receipt);
    const descriptor = descriptorFromBuildReceipt(receipt);
    assert.equal(assertParsedBundleMatchesDescriptor(parsed, descriptor), descriptor);

    const mutations = [
      ['corpus', 'release_id', `corpus-${'c'.repeat(24)}`],
      ['corpus', 'release_fingerprint_sha256', 'c'.repeat(64)],
      ['corpus', 'manifest_sha256', 'c'.repeat(64)],
      ['corpus', 'manifest_bytes', receipt.corpus.manifest_bytes + 1],
      ['bundle', 'bundle_id', `corpus-bundle-${'c'.repeat(24)}`],
      ['bundle', 'age_recipient', `age1${'r'.repeat(58)}`],
      ['bundle', 'bundle_manifest_sha256', 'c'.repeat(64)],
      ['bundle', 'payload_sha256', 'c'.repeat(64)],
      ['bundle', 'archive_file_count', receipt.bundle.archive_file_count + 1],
      ['bundle', 'plaintext_tar_sha256', 'c'.repeat(64)],
      ['bundle', 'plaintext_tar_bytes', receipt.bundle.plaintext_tar_bytes + 512],
    ];
    for (const [section, field, value] of mutations) {
      const changedReceipt = structuredClone(receipt);
      changedReceipt[section][field] = value;
      await assert.rejects(
        Promise.resolve().then(() => assertParsedBundleMatchesBuildReceipt(parsed, changedReceipt)),
        /differs from parsed bundle|storage identity/,
        `${section}.${field}`,
      );
      const changedDescriptor = descriptorFromBuildReceipt(receipt);
      changedDescriptor[section][field] = value;
      if (field === 'ciphertext_sha256') {
        changedDescriptor.storage.object_key = `curriculum-atlas/corpus-bundles/v1/objects/sha256/${value}.tar.zst.age`;
      }
      await assert.rejects(
        Promise.resolve().then(() => assertParsedBundleMatchesDescriptor(parsed, changedDescriptor)),
        /differs from parsed bundle|content-addressed object key/,
        `descriptor ${section}.${field}`,
      );
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('hydration preserves the tracked manifest, installs only exact missing assets, and is idempotent', async () => {
  const source = await corpusFixture();
  const destination = await mkdtemp(join(tmpdir(), 'curriculum-private-corpus-hydrate-'));
  try {
    const built = await buildPrivateCorpusTar({ root: source.root, ageRecipient: FIXTURE_AGE_RECIPIENT });
    const tracked = Buffer.from(source.manifestBuffer);
    await put(destination, 'data/corpus-chunks/manifest.json', tracked);
    const first = await hydratePrivateCorpusTar({ root: destination, tarBuffer: built.tar_buffer });
    const second = await hydratePrivateCorpusTar({ root: destination, tarBuffer: built.tar_buffer });
    assert.equal(first.bundle_id, built.bundle_manifest.bundle_id);
    assert.equal(second.status, 'already_hydrated');
    assert.deepEqual(await readFile(join(destination, 'data/corpus-chunks/manifest.json')), tracked);
    assert.deepEqual(await readFile(join(destination, 'data/corpus-chunks/000-core.sql')), source.sql);
    assert.deepEqual(await readFile(join(destination, '.cache/text/doc-a.txt')), source.text);
    assert.equal((await lstat(join(destination, 'data/corpus-chunks/000-core.sql'))).isFile(), true);
    assert.deepEqual(
      (await readdir(join(destination, '.cache/corpus-hydration/receipts'))).length,
      1,
    );
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
});

test('hydration never overwrites the tracked manifest or mismatched existing payload', async () => {
  const source = await corpusFixture();
  const destination = await mkdtemp(join(tmpdir(), 'curriculum-private-corpus-hydrate-reject-'));
  try {
    const built = await buildPrivateCorpusTar({ root: source.root, ageRecipient: FIXTURE_AGE_RECIPIENT });
    await put(destination, 'data/corpus-chunks/manifest.json', '{}\n');
    await assert.rejects(
      hydratePrivateCorpusTar({ root: destination, tarBuffer: built.tar_buffer }),
      /tracked corpus manifest differs/,
    );
    assert.equal(await readFile(join(destination, 'data/corpus-chunks/manifest.json'), 'utf8'), '{}\n');

    await writeFile(join(destination, 'data/corpus-chunks/manifest.json'), source.manifestBuffer);
    await put(destination, 'data/corpus-chunks/000-core.sql', 'wrong');
    await assert.rejects(
      hydratePrivateCorpusTar({ root: destination, tarBuffer: built.tar_buffer }),
      /existing hydrated file differs/,
    );
    assert.equal(await readFile(join(destination, 'data/corpus-chunks/000-core.sql'), 'utf8'), 'wrong');

    await rm(join(destination, 'data/corpus-chunks/000-core.sql'));
    const linkTarget = await put(destination, 'outside.sql', source.sql);
    await symlink(join(destination, 'outside.sql'), join(destination, 'data/corpus-chunks/000-core.sql'));
    await assert.rejects(
      hydratePrivateCorpusTar({ root: destination, tarBuffer: built.tar_buffer }),
      /not a regular file/,
    );
    assert.deepEqual(await readFile(join(destination, 'outside.sql')), linkTarget);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
});

test('hydration refuses a symlinked destination directory before installing any payload', async () => {
  const source = await corpusFixture();
  const destination = await mkdtemp(join(tmpdir(), 'curriculum-private-corpus-parent-link-'));
  try {
    const built = await buildPrivateCorpusTar({ root: source.root, ageRecipient: FIXTURE_AGE_RECIPIENT });
    await put(destination, 'data/corpus-chunks/manifest.json', source.manifestBuffer);
    await mkdir(join(destination, '.cache'), { recursive: true });
    await mkdir(join(destination, 'outside-text'), { recursive: true });
    await symlink(join(destination, 'outside-text'), join(destination, '.cache/text'));
    await assert.rejects(
      hydratePrivateCorpusTar({ root: destination, tarBuffer: built.tar_buffer }),
      /private directory component is not a real directory/,
    );
    assert.deepEqual(await readdir(join(destination, 'outside-text')), []);
    await assert.rejects(readFile(join(destination, 'data/corpus-chunks/000-core.sql')), /ENOENT/);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
});

test('corpus artifact descriptor is exact, private, immutable, and content-addressed', () => {
  const descriptor = {
    schema_version: 1,
    contract: DESCRIPTOR_CONTRACT,
    classification: CLASSIFICATION,
    public_runtime: false,
    corpus: {
      release_id: `corpus-${'a'.repeat(24)}`,
      release_fingerprint_sha256: 'a'.repeat(64),
      manifest_sha256: 'b'.repeat(64),
      manifest_bytes: 123,
    },
    bundle: {
      bundle_id: `corpus-bundle-${'c'.repeat(24)}`,
      age_recipient: FIXTURE_AGE_RECIPIENT,
      bundle_manifest_sha256: 'c'.repeat(64),
      payload_sha256: 'd'.repeat(64),
      archive_file_count: 194,
      plaintext_tar_sha256: 'e'.repeat(64),
      plaintext_tar_bytes: 456,
      ciphertext_sha256: 'f'.repeat(64),
      ciphertext_bytes: 321,
    },
    storage: {
      provider: 'cloudflare_r2_s3',
      bucket: 'bdfz-ops-backups',
      object_key: `curriculum-atlas/corpus-bundles/v1/objects/sha256/${'f'.repeat(64)}.tar.zst.age`,
      receipt_key: `curriculum-atlas/corpus-bundles/v1/receipts/sha256/${'1'.repeat(64)}.json`,
    },
    receipt: { sha256: '1'.repeat(64), bytes: 234 },
  };
  assert.deepEqual(validateCorpusArtifactDescriptor(descriptor), descriptor);
  assert.throws(
    () => validateCorpusArtifactDescriptor({ ...descriptor, public_runtime: true }),
    /public_runtime/,
  );
  assert.throws(
    () => validateCorpusArtifactDescriptor({ ...descriptor, extra: true }),
    /exactly the supported fields/,
  );
  assert.throws(
    () => validateCorpusArtifactDescriptor({
      ...descriptor,
      storage: { ...descriptor.storage, object_key: 'mutable/latest.tar.zst.age' },
    }),
    /content-addressed object key/,
  );
});

test('corpus artifact schema shares the runtime safe-integer boundary', async () => {
  const schema = JSON.parse(await readFile(new URL('../data/corpus-artifact.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$defs.positiveInteger.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(schema.properties.bundle.properties.age_recipient.pattern, '^age1[0-9a-z]{58}$');
});

test('publish receipt is structurally exact and descriptor comparison is key-order independent', async () => {
  const fixture = await corpusFixture();
  try {
    const built = await buildPrivateCorpusTar({ root: fixture.root, ageRecipient: FIXTURE_AGE_RECIPIENT });
    const buildReceipt = createBuildReceipt({ built, ciphertextBuffer: Buffer.from('encrypted fixture') });
    const receipt = publishReceiptFromBuildReceipt(buildReceipt);
    const descriptor = descriptorFromBuildReceipt(buildReceipt);
    const buffer = bindPublishReceipt(descriptor, receipt);
    assert.equal(validatePublishReceipt(receipt), receipt);
    const reordered = {
      ...descriptor,
      corpus: Object.fromEntries(Object.entries(descriptor.corpus).reverse()),
      bundle: Object.fromEntries(Object.entries(descriptor.bundle).reverse()),
    };
    assert.deepEqual(validatePublishReceiptAgainstDescriptor(buffer, reordered), receipt);

    for (const mutation of [
      (value) => { value.extra = true; },
      (value) => { value.storage.extra = true; },
      (value) => { value.verification.extra = true; },
      (value) => { value.storage.etag = 'bad\nvalue'; },
    ]) {
      const changedReceipt = structuredClone(receipt);
      mutation(changedReceipt);
      const changedDescriptor = structuredClone(descriptor);
      const changedBuffer = bindPublishReceipt(changedDescriptor, changedReceipt);
      assert.throws(
        () => validatePublishReceiptAgainstDescriptor(changedBuffer, changedDescriptor),
        /exactly the supported fields|ETag/,
      );
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('conditional R2 upload is idempotent and never replaces different remote bytes', async () => {
  const body = Buffer.from('ciphertext');
  const calls = [];
  const fetchCreated = async (url, init) => {
    calls.push({ url, init });
    return new Response('', { status: 200, headers: { etag: '"created"' } });
  };
  const created = await putObjectIfAbsent({
    endpoint: 'https://example.invalid',
    bucket: 'private',
    key: 'objects/value',
    body,
    accessKeyId: 'fixture-access',
    secretAccessKey: 'fixture-secret',
    now: new Date('2026-07-18T00:00:00.000Z'),
    fetchImpl: fetchCreated,
  });
  assert.equal(created.status, 'created');
  assert.equal(calls[0].init.headers['if-none-match'], '*');
  assert.equal(String(calls[0].init.headers.authorization).includes('fixture-secret'), false);

  const existingFetch = async (_url, init) => {
    if (init.method === 'PUT') return new Response('', { status: 412 });
    assert.equal(init.headers['x-amz-content-sha256'], hash(Buffer.alloc(0)));
    return new Response(body, { status: 200, headers: { etag: '"existing"' } });
  };
  const unchanged = await putObjectIfAbsent({
    endpoint: 'https://example.invalid',
    bucket: 'private',
    key: 'objects/value',
    body,
    accessKeyId: 'fixture-access',
    secretAccessKey: 'fixture-secret',
    now: new Date('2026-07-18T00:00:00.000Z'),
    fetchImpl: existingFetch,
  });
  assert.equal(unchanged.status, 'already_exists_exact');

  const differentFetch = async (_url, init) => init.method === 'PUT'
    ? new Response('', { status: 412 })
    : new Response('different', { status: 200 });
  await assert.rejects(
    putObjectIfAbsent({
      endpoint: 'https://example.invalid',
      bucket: 'private',
      key: 'objects/value',
      body,
      accessKeyId: 'fixture-access',
      secretAccessKey: 'fixture-secret',
      now: new Date('2026-07-18T00:00:00.000Z'),
      fetchImpl: differentFetch,
    }),
    /different bytes|byte count differs/,
  );
});

test('R2 SigV4 signing stays byte-pinned for conditional content-addressed PUT', () => {
  const headers = signR2Request({
    method: 'PUT',
    url: 'https://example.invalid/private/objects/value',
    body: Buffer.from('ciphertext'),
    accessKeyId: 'fixture-access',
    secretAccessKey: 'fixture-secret',
    now: new Date('2026-07-18T00:00:00.000Z'),
    headers: { 'content-type': 'application/octet-stream', 'if-none-match': '*' },
  });
  assert.equal(headers['x-amz-content-sha256'], '305531dcc50ebca31cf1d5b31e9fc76ed51f66b3b6dd5a030c6539ae6532f979');
  assert.equal(
    headers.authorization,
    'AWS4-HMAC-SHA256 Credential=fixture-access/20260718/auto/s3/aws4_request, SignedHeaders=content-type;host;if-none-match;x-amz-content-sha256;x-amz-date, Signature=e9babfdf313e277cc84ce1b211506ce95aca83e2a5f73b9516859d4ed78531d9',
  );
});

test('signed R2 GET returns exact bytes and rejects non-success status', async () => {
  const body = Buffer.from('remote bytes');
  const exact = await getObject({
    endpoint: 'https://example.invalid',
    bucket: 'private',
    key: 'objects/value',
    accessKeyId: 'fixture-access',
    secretAccessKey: 'fixture-secret',
    now: new Date('2026-07-18T00:00:00.000Z'),
    fetchImpl: async () => new Response(body, { status: 200, headers: { etag: '"fixture"' } }),
  });
  assert.deepEqual(exact.body, body);
  assert.equal(exact.etag, '"fixture"');
  await assert.rejects(
    getObject({
      endpoint: 'https://example.invalid',
      bucket: 'private',
      key: 'objects/value',
      accessKeyId: 'fixture-access',
      secretAccessKey: 'fixture-secret',
      now: new Date('2026-07-18T00:00:00.000Z'),
      fetchImpl: async () => new Response('denied', { status: 403 }),
    }),
    /R2 GET failed with HTTP 403/,
  );
});

test('R2 GET enforces streamed exact-byte limits before allocating an unbounded body', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3, 4]));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    getObject({
      endpoint: 'https://example.invalid',
      bucket: 'private',
      key: 'objects/value',
      accessKeyId: 'fixture-access',
      secretAccessKey: 'fixture-secret',
      now: new Date('2026-07-18T00:00:00.000Z'),
      expectedBytes: 3,
      maxBytes: 3,
      fetchImpl: async () => new Response(body, { status: 200 }),
    }),
    /exceeds private artifact safety limit/,
  );
  assert.equal(cancelled, true);
});

test('local private reads reject symlinks and oversized sparse files before allocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curriculum-private-corpus-local-read-'));
  try {
    const exactPath = join(root, 'exact.bin');
    const linkPath = join(root, 'linked.bin');
    const oversizedPath = join(root, 'oversized.bin');
    await writeFile(exactPath, 'exact');
    await symlink(exactPath, linkPath);
    await writeFile(oversizedPath, '');
    await truncate(oversizedPath, 2 * 1024 * 1024);
    assert.deepEqual(
      await readPrivateFile(exactPath, { expectedBytes: 5, maxBytes: 5, label: 'fixture' }),
      Buffer.from('exact'),
    );
    await assert.rejects(
      readPrivateFile(linkPath, { maxBytes: 1024, label: 'fixture link' }),
      /symbolic link|regular file/,
    );
    await assert.rejects(
      readPrivateFile(oversizedPath, { maxBytes: 1024 * 1024, label: 'fixture sparse file' }),
      /safety limit|byte count/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('age identity input is owner-only, bounded, and contains exactly one native identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curriculum-private-corpus-identity-contract-'));
  try {
    const multiple = join(root, 'multiple.txt');
    const oversized = join(root, 'oversized.txt');
    const identityLine = `AGE-SECRET-KEY-1${'Q'.repeat(58)}`;
    await writeFile(multiple, `${identityLine}\n${identityLine}\n`, { mode: 0o600 });
    await writeFile(oversized, '', { mode: 0o600 });
    await truncate(oversized, 4097);
    let spawnCalls = 0;
    const forbiddenSpawn = () => {
      spawnCalls += 1;
      throw new Error('transform child must not start');
    };
    await assert.rejects(
      decryptAndDecompressAge({
        ciphertext: Buffer.from('fixture'),
        identityFile: multiple,
        expectedPlaintextBytes: 512,
        spawnImpl: forbiddenSpawn,
      }),
      /exactly one canonical native age identity/,
    );
    await assert.rejects(
      decryptAndDecompressAge({
        ciphertext: Buffer.from('fixture'),
        identityFile: oversized,
        expectedPlaintextBytes: 512,
        spawnImpl: forbiddenSpawn,
      }),
      /private safety limit/,
    );
    assert.equal(spawnCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('transform failures contain EPIPE and synchronously thrown second spawns while reaping the first child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curriculum-private-corpus-transform-failure-'));
  try {
    const recipients = join(root, 'recipients.txt');
    const identity = join(root, 'identity.txt');
    await writeFile(recipients, `${FIXTURE_AGE_RECIPIENT}\n`, { mode: 0o600 });
    await writeFile(identity, `AGE-SECRET-KEY-1${'Q'.repeat(58)}\n`, { mode: 0o600 });

    const earlyExitSpawn = (command, _args, options) => command === 'zstd'
      ? spawn(process.execPath, ['-e', 'process.exit(7)'], options)
      : spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'], options);
    await assert.rejects(
      compressAndEncryptAge({
        plaintext: Buffer.alloc(4 * 1024 * 1024, 1),
        recipientFile: recipients,
        expectedRecipient: FIXTURE_AGE_RECIPIENT,
        spawnImpl: earlyExitSpawn,
      }),
      /zstd compress|transform pipeline|EPIPE/,
    );

    for (const operation of ['encrypt', 'decrypt']) {
      let firstChild = null;
      let calls = 0;
      const throwOnSecondSpawn = (_command, _args, options) => {
        calls += 1;
        if (calls === 2) throw new Error(`injected ${operation} second spawn failure`);
        firstChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], options);
        return firstChild;
      };
      const invocation = operation === 'encrypt'
        ? compressAndEncryptAge({
          plaintext: Buffer.from('fixture'),
          recipientFile: recipients,
          expectedRecipient: FIXTURE_AGE_RECIPIENT,
          spawnImpl: throwOnSecondSpawn,
        })
        : decryptAndDecompressAge({
          ciphertext: Buffer.from('fixture'),
          identityFile: identity,
          expectedPlaintextBytes: 512,
          spawnImpl: throwOnSecondSpawn,
        });
      await assert.rejects(invocation, new RegExp(`injected ${operation} second spawn failure`));
      assert.ok(firstChild);
      assert.ok(firstChild.exitCode !== null || firstChild.signalCode !== null, `${operation} first child was not reaped`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('terminal transform output errors enter the controlled kill-and-reap path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curriculum-private-corpus-terminal-output-'));
  try {
    const recipients = join(root, 'recipients.txt');
    const identity = join(root, 'identity.txt');
    await writeFile(recipients, `${FIXTURE_AGE_RECIPIENT}\n`, { mode: 0o600 });
    await writeFile(identity, `AGE-SECRET-KEY-1${'Q'.repeat(58)}\n`, { mode: 0o600 });
    const passthroughWithTerminalFailure = (terminalCommand) => (command, _args, options) => {
      const child = spawn(process.execPath, ['-e', 'process.stdin.pipe(process.stdout);'], options);
      if (command === terminalCommand) {
        queueMicrotask(() => child.stdout.emit('error', new Error(`${terminalCommand} terminal output failure`)));
      }
      return child;
    };
    await assert.rejects(
      compressAndEncryptAge({
        plaintext: Buffer.from('fixture'),
        recipientFile: recipients,
        expectedRecipient: FIXTURE_AGE_RECIPIENT,
        spawnImpl: passthroughWithTerminalFailure('age'),
      }),
      /age terminal transform output failed|age terminal output failure/,
    );
    await assert.rejects(
      decryptAndDecompressAge({
        ciphertext: Buffer.from('fixture'),
        identityFile: identity,
        expectedPlaintextBytes: 512,
        spawnImpl: passthroughWithTerminalFailure('zstd'),
      }),
      /zstd terminal transform output failed|zstd terminal output failure/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('age and zstd round-trip through retained file descriptors without inheriting unrelated secrets', async (context) => {
  if (spawnSync('age', ['--version'], { stdio: 'ignore' }).status !== 0
      || spawnSync('zstd', ['--version'], { stdio: 'ignore' }).status !== 0
      || spawnSync('age-keygen', ['--version'], { stdio: 'ignore' }).status !== 0) {
    context.skip('age, age-keygen, or zstd is unavailable');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'curriculum-private-corpus-age-roundtrip-'));
  const previousSecret = process.env.PRIVATE_BUNDLE_TEST_SECRET;
  try {
    const identity = join(root, 'identity.txt');
    const recipients = join(root, 'recipients.txt');
    const generated = spawnSync('age-keygen', ['-o', identity], { stdio: ['ignore', 'ignore', 'ignore'] });
    assert.equal(generated.status, 0);
    await chmod(identity, 0o600);
    const publicKey = spawnSync('age-keygen', ['-y', identity], { encoding: null, stdio: ['ignore', 'pipe', 'ignore'] });
    assert.equal(publicKey.status, 0);
    await writeFile(recipients, publicKey.stdout, { mode: 0o600 });
    process.env.PRIVATE_BUNDLE_TEST_SECRET = 'must-not-reach-transform-children';
    const checkedSpawn = (command, args, options) => {
      assert.equal(Object.hasOwn(options.env, 'PRIVATE_BUNDLE_TEST_SECRET'), false);
      if (command === 'age') {
        assert.equal(args.includes('/dev/fd/3'), true);
        if (args.includes('--encrypt')) assert.equal(Number.isInteger(options.stdio[3]), true);
        else assert.equal(options.stdio[3], 'pipe');
      }
      return spawn(command, args, options);
    };
    const tar = createDeterministicUstar([{ path: 'fixture.txt', buffer: Buffer.from('offline age replay') }]);
    const ciphertext = await compressAndEncryptAge({
      plaintext: tar,
      recipientFile: recipients,
      expectedRecipient: publicKey.stdout.toString('utf8').trim(),
      spawnImpl: checkedSpawn,
    });
    const plaintext = await decryptAndDecompressAge({
      ciphertext,
      identityFile: identity,
      expectedPlaintextBytes: tar.length,
      spawnImpl: checkedSpawn,
    });
    assert.deepEqual(plaintext, tar);

    const secondIdentity = join(root, 'second-identity.txt');
    assert.equal(spawnSync('age-keygen', ['-o', secondIdentity], { stdio: ['ignore', 'ignore', 'ignore'] }).status, 0);
    await chmod(secondIdentity, 0o600);
    const secondPublicKey = spawnSync('age-keygen', ['-y', secondIdentity], {
      encoding: null,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    assert.equal(secondPublicKey.status, 0);
    await writeFile(recipients, Buffer.concat([publicKey.stdout, secondPublicKey.stdout]), { mode: 0o600 });
    await assert.rejects(
      compressAndEncryptAge({
        plaintext: tar,
        recipientFile: recipients,
        expectedRecipient: publicKey.stdout.toString('utf8').trim(),
      }),
      /exactly one canonical age recipient/,
    );
  } finally {
    if (previousSecret === undefined) delete process.env.PRIVATE_BUNDLE_TEST_SECRET;
    else process.env.PRIVATE_BUNDLE_TEST_SECRET = previousSecret;
    await rm(root, { recursive: true, force: true });
  }
});

test('publication rejects a valid age envelope that authorizes a second recipient', async (context) => {
  if (spawnSync('age', ['--version'], { stdio: 'ignore' }).status !== 0
      || spawnSync('zstd', ['--version'], { stdio: 'ignore' }).status !== 0
      || spawnSync('age-keygen', ['--version'], { stdio: 'ignore' }).status !== 0) {
    context.skip('age, age-keygen, or zstd is unavailable');
    return;
  }
  const source = await corpusFixture();
  const operator = await mkdtemp(join(tmpdir(), 'curriculum-private-corpus-multiple-recipients-'));
  try {
    const firstIdentity = join(operator, 'first-identity.txt');
    const secondIdentity = join(operator, 'second-identity.txt');
    const recipients = join(operator, 'recipients.txt');
    for (const identity of [firstIdentity, secondIdentity]) {
      assert.equal(spawnSync('age-keygen', ['-o', identity], { stdio: ['ignore', 'ignore', 'ignore'] }).status, 0);
      await chmod(identity, 0o600);
    }
    const firstPublic = spawnSync('age-keygen', ['-y', firstIdentity], {
      encoding: null,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const secondPublic = spawnSync('age-keygen', ['-y', secondIdentity], {
      encoding: null,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    assert.equal(firstPublic.status, 0);
    assert.equal(secondPublic.status, 0);
    await writeFile(recipients, Buffer.concat([firstPublic.stdout, secondPublic.stdout]), { mode: 0o600 });

    const firstRecipient = firstPublic.stdout.toString('utf8').trim();
    const built = await buildPrivateCorpusTar({ root: source.root, ageRecipient: firstRecipient });
    const compressed = spawnSync(
      'zstd',
      ['--compress', '--stdout', '--quiet', '--threads=1', '--no-progress'],
      { input: built.tar_buffer, encoding: null, maxBuffer: 16 * 1024 * 1024 },
    );
    assert.equal(compressed.status, 0);
    const encrypted = spawnSync(
      'age',
      ['--encrypt', '--recipients-file', recipients],
      { input: compressed.stdout, encoding: null, maxBuffer: 16 * 1024 * 1024 },
    );
    assert.equal(encrypted.status, 0);
    const artifactPath = join(operator, 'multiple-recipients.tar.zst.age');
    const buildReceiptPath = join(operator, 'build-receipt.json');
    await writeFile(artifactPath, encrypted.stdout, { mode: 0o600 });
    await writeFile(
      buildReceiptPath,
      canonicalJsonBuffer(createBuildReceipt({ built, ciphertextBuffer: encrypted.stdout })),
      { mode: 0o600 },
    );
    let networkCalled = false;
    await assert.rejects(
      publishPrivateCorpusBundle({
        artifactPath,
        buildReceiptPath,
        identityFile: firstIdentity,
        endpoint: 'https://example.invalid',
        accessKeyId: 'fixture-access',
        secretAccessKey: 'fixture-secret',
        allowPrivateUpload: true,
        fetchImpl: async () => {
          networkCalled = true;
          throw new Error('network must not be reached');
        },
      }),
      /exactly one native X25519 recipient stanza/,
    );
    assert.equal(networkCalled, false);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(operator, { recursive: true, force: true });
  }
});

test('declared age recipient must equal the supplied identity before publish or hydrate network access', async (context) => {
  if (spawnSync('age', ['--version'], { stdio: 'ignore' }).status !== 0
      || spawnSync('zstd', ['--version'], { stdio: 'ignore' }).status !== 0
      || spawnSync('age-keygen', ['--version'], { stdio: 'ignore' }).status !== 0) {
    context.skip('age, age-keygen, or zstd is unavailable');
    return;
  }
  const source = await corpusFixture();
  const operator = await mkdtemp(join(tmpdir(), 'curriculum-private-corpus-recipient-drift-'));
  const destination = await mkdtemp(join(tmpdir(), 'curriculum-private-corpus-recipient-drift-hydrate-'));
  try {
    const identityA = join(operator, 'identity-a.txt');
    const identityB = join(operator, 'identity-b.txt');
    const recipientsA = join(operator, 'recipients-a.txt');
    for (const identity of [identityA, identityB]) {
      assert.equal(spawnSync('age-keygen', ['-o', identity], { stdio: ['ignore', 'ignore', 'ignore'] }).status, 0);
      await chmod(identity, 0o600);
    }
    const publicA = spawnSync('age-keygen', ['-y', identityA], {
      encoding: null,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const publicB = spawnSync('age-keygen', ['-y', identityB], {
      encoding: null,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    assert.equal(publicA.status, 0);
    assert.equal(publicB.status, 0);
    const recipientA = publicA.stdout.toString('utf8').trim();
    const recipientB = publicB.stdout.toString('utf8').trim();
    await writeFile(recipientsA, publicA.stdout, { mode: 0o600 });

    const builtClaimingB = await buildPrivateCorpusTar({ root: source.root, ageRecipient: recipientB });
    const ciphertextForA = await compressAndEncryptAge({
      plaintext: builtClaimingB.tar_buffer,
      recipientFile: recipientsA,
      expectedRecipient: recipientA,
    });
    const buildReceipt = createBuildReceipt({ built: builtClaimingB, ciphertextBuffer: ciphertextForA });
    const artifactPath = join(operator, 'artifact.tar.zst.age');
    const buildReceiptPath = join(operator, 'build-receipt.json');
    await writeFile(artifactPath, ciphertextForA, { mode: 0o600 });
    await writeFile(buildReceiptPath, canonicalJsonBuffer(buildReceipt), { mode: 0o600 });
    let publishFetchCalls = 0;
    await assert.rejects(
      publishPrivateCorpusBundle({
        artifactPath,
        buildReceiptPath,
        identityFile: identityA,
        endpoint: 'https://example.invalid',
        accessKeyId: 'fixture-access',
        secretAccessKey: 'fixture-secret',
        allowPrivateUpload: true,
        fetchImpl: async () => {
          publishFetchCalls += 1;
          throw new Error('publish network must not be reached');
        },
      }),
      /derived age recipient differs from declared recipient/,
    );
    assert.equal(publishFetchCalls, 0);

    const descriptor = descriptorFromBuildReceipt(buildReceipt);
    await put(destination, 'data/corpus-chunks/manifest.json', source.manifestBuffer);
    await put(destination, 'data/corpus-artifact.json', canonicalJsonBuffer(descriptor));
    let hydrateFetchCalls = 0;
    await assert.rejects(
      hydrateCorpusFromDescriptor({
        root: destination,
        identityFile: identityA,
        endpoint: 'https://example.invalid',
        accessKeyId: 'fixture-access',
        secretAccessKey: 'fixture-secret',
        allowPrivateDownload: true,
        fetchImpl: async () => {
          hydrateFetchCalls += 1;
          throw new Error('hydrate network must not be reached');
        },
      }),
      /derived age recipient differs from declared recipient/,
    );
    assert.equal(hydrateFetchCalls, 0);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(operator, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
});

test('offline full build, conditional publish, descriptor, receipt, download, decrypt, and hydrate replay', async (context) => {
  if (spawnSync('age', ['--version'], { stdio: 'ignore' }).status !== 0
      || spawnSync('zstd', ['--version'], { stdio: 'ignore' }).status !== 0
      || spawnSync('age-keygen', ['--version'], { stdio: 'ignore' }).status !== 0) {
    context.skip('age, age-keygen, or zstd is unavailable');
    return;
  }
  const source = await corpusFixture();
  const operator = await mkdtemp(join(tmpdir(), 'curriculum-private-corpus-offline-publish-'));
  const destination = await mkdtemp(join(tmpdir(), 'curriculum-private-corpus-offline-hydrate-'));
  try {
    const identity = join(operator, 'identity.txt');
    const recipients = join(operator, 'recipients.txt');
    assert.equal(spawnSync('age-keygen', ['-o', identity], { stdio: ['ignore', 'ignore', 'ignore'] }).status, 0);
    await chmod(identity, 0o600);
    const publicKey = spawnSync('age-keygen', ['-y', identity], { encoding: null, stdio: ['ignore', 'pipe', 'ignore'] });
    assert.equal(publicKey.status, 0);
    await writeFile(recipients, publicKey.stdout, { mode: 0o600 });
    const artifactPath = join(operator, 'bundle.tar.zst.age');
    const buildReceiptPath = join(operator, 'build-receipt.json');
    const publishReceiptPath = join(operator, 'publish-receipt.json');
    const descriptorPath = join(operator, 'corpus-artifact.json');
    await buildEncryptedPrivateCorpusBundle({
      root: source.root,
      outputPath: artifactPath,
      receiptPath: buildReceiptPath,
      recipientFile: recipients,
      identityFile: identity,
    });

    const objects = new Map();
    const fetchImpl = async (url, init) => {
      const key = new URL(url).pathname;
      if (init.method === 'PUT') {
        assert.equal(init.headers['if-none-match'], '*');
        if (objects.has(key)) return new Response('', { status: 412 });
        const bytes = Buffer.from(init.body);
        objects.set(key, bytes);
        return new Response('', { status: 200, headers: { etag: `"${hash(bytes).slice(0, 32)}"` } });
      }
      if (init.method === 'GET' && objects.has(key)) {
        const bytes = objects.get(key);
        return new Response(bytes, {
          status: 200,
          headers: { etag: `"${hash(bytes).slice(0, 32)}"`, 'content-length': String(bytes.length) },
        });
      }
      return new Response('', { status: 404 });
    };
    const published = await publishPrivateCorpusBundle({
      artifactPath,
      buildReceiptPath,
      identityFile: identity,
      publishReceiptPath,
      descriptorPath,
      endpoint: 'https://example.invalid',
      accessKeyId: 'fixture-access',
      secretAccessKey: 'fixture-secret',
      allowPrivateUpload: true,
      fetchImpl,
    });
    assert.equal(objects.size, 2);
    assert.equal(published.descriptor.public_runtime, false);
    await put(destination, 'data/corpus-chunks/manifest.json', source.manifestBuffer);
    await put(destination, 'data/corpus-artifact.json', await readFile(descriptorPath));
    const hydrated = await hydrateCorpusFromDescriptor({
      root: destination,
      identityFile: identity,
      endpoint: 'https://example.invalid',
      accessKeyId: 'fixture-access',
      secretAccessKey: 'fixture-secret',
      allowPrivateDownload: true,
      fetchImpl,
    });
    assert.equal(hydrated.status, 'hydrated');
    assert.deepEqual(await readFile(join(destination, 'data/corpus-chunks/000-core.sql')), source.sql);
    assert.deepEqual(await readFile(join(destination, '.cache/text/doc-a.txt')), source.text);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(operator, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
});

test('hydrated files are owner-only even when the process umask is permissive', async () => {
  const source = await corpusFixture();
  const destination = await mkdtemp(join(tmpdir(), 'curriculum-private-corpus-mode-'));
  try {
    const built = await buildPrivateCorpusTar({ root: source.root, ageRecipient: FIXTURE_AGE_RECIPIENT });
    await put(destination, 'data/corpus-chunks/manifest.json', source.manifestBuffer);
    await chmod(join(destination, 'data/corpus-chunks/manifest.json'), 0o644);
    await hydratePrivateCorpusTar({ root: destination, tarBuffer: built.tar_buffer });
    assert.equal((await lstat(join(destination, 'data/corpus-chunks/000-core.sql'))).mode & 0o777, 0o600);
    assert.equal((await lstat(join(destination, '.cache/text/doc-a.txt'))).mode & 0o777, 0o600);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
});
