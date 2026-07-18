import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertBufferParity,
  assertGitCommitExists,
  buildReleaseManifest,
  compareManagedKeySets,
  releaseIdFromIdentity,
} from '../scripts/build-release-manifest.mjs';
import {
  assertEnvironmentReleaseReady,
  assertReleaseSourceReady,
  buildPublicationLeaseAcquireSql,
  buildPublicationLeaseReleaseSql,
  immutableVersionedManifestArtifact,
  publishVersionedRelease,
} from '../scripts/publish-metadata.mjs';
import { sealCorpusManifest } from '../scripts/import-corpus.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE_RELEASE_ID = `release-${'f'.repeat(32)}`;

function publicationCoordination() {
  return {
    policy: 'd1_single_writer_lease_v1',
    lease_key: 'r2_release_publication_lease',
    lease_ttl_seconds: 3600,
    databases: { preview: 'fixture-preview', production: 'fixture-production' },
  };
}

async function createPublishFixture(contents = [Buffer.from('{"asset":1}\n')]) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'release-publish-fixture-'));
  const objects = [];
  for (const [index, buffer] of contents.entries()) {
    const source = `asset-${index + 1}.json`;
    await writeFile(join(fixtureRoot, source), buffer);
    objects.push({
      role: `asset_${index + 1}`,
      source,
      key: `quality/${source}`,
      release_key: `releases/${FIXTURE_RELEASE_ID}/quality/${source}`,
      content_type: 'application/json',
      sha256: createHash('sha256').update(buffer).digest('hex'),
      bytes: buffer.length,
      counts: {},
    });
  }
  const corpusManifest = sealCorpusManifest({
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
    },
    text_asset_count: 1,
    text_assets: [{ document_id: 'doc-a', sha256: 'e'.repeat(64), bytes: 1 }],
    sql_chunks: 1,
    sql_files: [{ name: '000-core.sql', sha256: 'f'.repeat(64), bytes: 1 }],
    closed_ocr_paragraphs: 0,
    skipped_ocr_documents: 0,
    excluded_exact_duplicate_alias_documents: 0,
    semantic_excluded_pages: 0,
    page_publication_schema_version: 1,
    semantic_publication_schema_version: 1,
    semantic_publication_revision_sha256: 'a'.repeat(64),
  });
  const corpusBuffer = Buffer.from(`${JSON.stringify(corpusManifest, null, 2)}\n`);
  await writeFile(join(fixtureRoot, 'corpus-manifest.json'), corpusBuffer);
  return {
    fixtureRoot,
    contents,
    manifest: {
      schema_version: 1,
      policy: 'fixture',
      release_id: FIXTURE_RELEASE_ID,
      git: { head: 'a'.repeat(40) },
      source_tree: { sha256: 'c'.repeat(64), files: [] },
      page_evidence: { valid: true, publishable: false },
      corpus_release: {
        source: 'corpus-manifest.json',
        sha256: createHash('sha256').update(corpusBuffer).digest('hex'),
        bytes: corpusBuffer.length,
        release_id: corpusManifest.release_id,
        release_fingerprint_sha256: corpusManifest.release_fingerprint_sha256,
        manifest_sha256: corpusManifest.manifest_sha256,
      },
      data_assets: objects,
      graph_assets: [],
      static_assets: { files: [] },
      r2: {
        release_prefix: 'releases',
        current_pointer_key: 'release/current.json',
        release_manifest_key: `releases/${FIXTURE_RELEASE_ID}/manifest.json`,
        publication_coordination: publicationCoordination(),
        objects,
      },
    },
  };
}

async function buildHermeticReleaseManifest(generatedAt) {
  const registry = JSON.parse(await readFile(new URL('../data/artifact-registry.json', import.meta.url), 'utf8'));
  const counts = registry.expected_counts;
  return buildReleaseManifest({
    root,
    generatedAt,
    corpusSourceBindingValidator: async (manifest) => manifest,
    projectAssetAuditor: async () => ({
      ok: true,
      policy: registry.policy,
      checks: ['tracked_fixture_registry_shape'],
      source_inventory: {
        roots: registry.source_roots,
        pdf_files: counts.source_pdf_files,
        unique_artifacts: counts.unique_source_pdf_artifacts,
        valid_pdf_files: counts.source_pdf_files - counts.invalid_pdf_files,
        invalid_pdf_files: counts.invalid_pdf_files,
        dispositions: {},
        explicit_artifacts: Array.from({ length: counts.explicit_artifacts }, () => ({})),
        duplicate_artifacts: [],
        source_archive_containers: Array.from({ length: counts.source_archive_containers }, () => ({})),
      },
      queue: {
        nominal_documents: counts.nominal_queue_documents,
        nominal_pages: counts.nominal_queue_pages,
        unique_artifacts: counts.unique_queue_artifacts,
        unique_pages: counts.unique_queue_pages,
        blocked_documents: counts.blocked_documents,
        duplicate_artifacts: [],
      },
      warnings: [],
      errors: [],
    }),
  });
}

test('release manifest binds the complete data, graph, static, Git, and environment state', async () => {
  const environmentEvidence = JSON.parse(await readFile(new URL('../data/release-environment-evidence.json', import.meta.url), 'utf8'));
  const manifest = await buildHermeticReleaseManifest('2026-07-17T00:00:00.000Z');
  const catalog = JSON.parse(await readFile(new URL('../data/catalog.json', import.meta.url), 'utf8'));
  const queue = JSON.parse(await readFile(new URL('../data/ocr-queue.json', import.meta.url), 'utf8'));

  assert.equal(manifest.schema_version, 1);
  assert.match(manifest.release_id, /^release-[0-9a-f]{32}$/);
  assert.equal(manifest.integrity.valid, true);
  assert.equal(releaseIdFromIdentity(manifest.release_identity), manifest.release_id);
  assert.equal(
    manifest.release_blockers.some((blocker) => blocker.code === 'dirty_git_tree'),
    manifest.git.dirty,
  );
  assert.equal(
    manifest.release_blockers.some((blocker) => blocker.code === 'git_head_not_pushed'),
    manifest.git.upstream_head !== manifest.git.head,
  );
  assert.equal(manifest.source_tree.sha256.length, 64);
  assert.ok(manifest.source_tree.file_count > 100);
  assert.equal(manifest.source_tree.tracked_only, true);
  assert.ok(manifest.source_tree.files.some((file) => file.path === 'src/index.ts'));

  const byRole = new Map(manifest.data_assets.map((asset) => [asset.role, asset]));
  for (const role of [
    'artifact_registry',
    'catalog',
    'ingest_manifest',
    'ocr_queue',
    'page_publication_manifest',
    'page_publication_schema',
    'semantic_publication_policy',
    'semantic_publication_schema',
    'online_verification_standard',
    'online_verification_validation',
    'online_verification_samples',
    'online_verification_r6_foreign_language_map',
    'online_verification_r6_foreign_language_schema',
    'online_verification_zh_compulsory_2022_claims',
    'online_verification_zh_compulsory_2022_schema',
    'release_assets_policy',
    'release_environment_evidence',
  ]) assert.ok(byRole.has(role), `missing ${role}`);

  assert.equal(byRole.get('catalog').counts.documents, catalog.documents.length);
  assert.equal(byRole.get('catalog').counts.citation_ready, catalog.documents.filter((item) => item.citation_allowed === true).length);
  assert.equal(byRole.get('ocr_queue').counts.documents, queue.documents.length);
  assert.equal(byRole.get('ocr_queue').counts.pages, queue.documents.reduce((total, item) => total + item.page_count, 0));
  assert.equal(manifest.r2.managed_object_count, manifest.data_assets.length);
  assert.equal(new Set(manifest.r2.objects.map((object) => object.key)).size, manifest.r2.managed_object_count);
  assert.ok(manifest.r2.objects.every((object) => object.release_key.startsWith(`${manifest.r2.release_prefix}/${manifest.release_id}/`)));
  assert.equal(manifest.r2.release_manifest_key, `${manifest.r2.release_prefix}/${manifest.release_id}/manifest.json`);
  assert.equal(manifest.r2.current_pointer_key, 'release/current.json');
  assert.deepEqual(manifest.corpus_release.counts.core_table_counts, {
    subjects: 0,
    periods: 5,
    document_relations: 0,
    chapters: 0,
    document_classifications: 196,
    document_sources: 252,
    primary_document_sources: 196,
    subject_insights: 6,
    terms: 5,
    term_relations: 4,
    version_diffs: 0,
    online_verifications: 1,
    online_evidence: 5,
  });

  const assetAudit = manifest.integrity.project_asset_audit;
  assert.equal(assetAudit.ok, true);
  assert.equal(assetAudit.downloads_included, false);
  assert.equal(assetAudit.registry.sha256, byRole.get('artifact_registry').sha256);
  assert.equal(assetAudit.queue.nominal_documents, queue.documents.length);
  assert.equal(assetAudit.queue.nominal_pages, queue.documents.reduce((total, item) => total + item.page_count, 0));
  assert.equal(assetAudit.errors, 0);

  const rawCorpusManifest = await readFile(new URL('../data/corpus-chunks/manifest.json', import.meta.url));
  const rawCorpusBinding = {
    sha256: createHash('sha256').update(rawCorpusManifest).digest('hex'),
    bytes: rawCorpusManifest.byteLength,
  };
  assert.equal(manifest.corpus_release.sha256, rawCorpusBinding.sha256);
  assert.equal(manifest.corpus_release.bytes, rawCorpusBinding.bytes);
  assert.equal(manifest.page_evidence.valid, true);
  assert.equal(manifest.page_evidence.publishable, false);

  assert.equal(manifest.graph_assets.length, 2);
  assert.equal(manifest.graph_assets[0].build_revision, manifest.graph_assets[1].build_revision);
  assert.ok(manifest.graph_assets.every((asset) => asset.sha256.length === 64 && asset.bytes > 0));
  assert.ok(manifest.graph_assets.every((asset) => asset.deploy_path.startsWith('dist/data/')));
  assert.equal(manifest.static_assets.source_root, 'public');
  assert.equal(manifest.static_assets.deploy_root, 'dist');
  assert.ok(manifest.static_assets.files.some((asset) => asset.path === 'public/subject-facets.js'));
  assert.ok(manifest.static_assets.files.some((asset) => asset.path === 'public/index.html'));
  assert.ok(manifest.static_assets.files.every((asset) => asset.deploy_path.startsWith('dist/')));

  assert.equal(manifest.environment_snapshot.environments.local.worker_revision, 'working-tree-v10');
  assert.equal(manifest.environment_snapshot.required_migration, '0007_document_taxonomy_contract.sql');
  assert.equal(manifest.environment_snapshot.environments.local.r2_release_reader, 'versioned_manifest_v1');
  assert.equal(
    manifest.environment_snapshot.environments.local.release_blockers.some((blocker) => blocker.code === 'versioned_r2_reader_required'),
    false,
  );
  for (const environment of ['preview', 'production']) {
    const state = manifest.environment_snapshot.environments[environment];
    const observed = environmentEvidence.environments[environment];
    const expectedPendingMigrations = state.available_migrations
      .filter((migration) => !observed.applied_migrations.includes(migration));
    assert.match(state.asset_git_commit, /^[0-9a-f]{40}$/);
    assert.equal(state.asset_git_commit_object_exists, true);
    assert.equal(state.asset_git_commit_deployment_parity, true);
    assert.deepEqual(state.applied_migrations, [...observed.applied_migrations].sort());
    assert.deepEqual(state.pending_migrations, expectedPendingMigrations);
    assert.deepEqual(
      state.release_blockers
        .filter((blocker) => blocker.code === 'pending_d1_migration')
        .map((blocker) => blocker.migration),
      expectedPendingMigrations,
    );
    assert.equal(
      state.release_blockers.some((blocker) => blocker.code === 'versioned_r2_reader_required'),
      observed.r2_release_reader !== state.required_r2_release_reader,
    );
    assert.equal(state.release_ready, state.release_blockers.length === 0);
    assert.equal(state.readiness_status, state.release_ready ? 'ready' : 'blocked');
  }
});

test('environment asset commits must be exact existing Git commit objects', () => {
  const head = assertGitCommitExists(root, 'f464de0293987a227df2c07e3b0c87a153f04232', 'fixture');
  assert.equal(head, 'f464de0293987a227df2c07e3b0c87a153f04232');
  assert.throws(() => assertGitCommitExists(root, 'ececd77', 'fixture'), /exact 40-character Git commit SHA/);
  assert.throws(() => assertGitCommitExists(root, '0000000000000000000000000000000000000000', 'fixture'), /does not exist as a commit/);
});

test('release identity is deterministic while generated_at remains an audit timestamp', async () => {
  const first = await buildHermeticReleaseManifest('2026-07-17T00:00:00.000Z');
  const second = await buildHermeticReleaseManifest('2026-07-17T00:01:00.000Z');
  assert.equal(first.release_id, second.release_id);
  assert.equal(first.source_tree.sha256, second.source_tree.sha256);
  assert.notEqual(first.generated_at, second.generated_at);
});

test('immutable versioned manifest bytes exclude every volatile audit age for retry-safe keys', async () => {
  const firstManifest = await buildHermeticReleaseManifest('2026-07-17T00:00:00.000Z');
  const secondManifest = await buildHermeticReleaseManifest('2026-07-17T00:01:00.000Z');
  assert.equal(firstManifest.release_id, secondManifest.release_id);
  assert.notEqual(firstManifest.generated_at, secondManifest.generated_at);
  assert.notEqual(
    firstManifest.downloads_asset_audit.age_hours,
    secondManifest.downloads_asset_audit.age_hours,
  );
  const first = immutableVersionedManifestArtifact(firstManifest);
  const second = immutableVersionedManifestArtifact(secondManifest);
  assert.deepEqual(first.buffer, second.buffer);
  assert.equal(first.sha256, second.sha256);
});

test('D1 publication lease serializes different owners even for the same release', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE site_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE corpus_import_guards(guard_key TEXT PRIMARY KEY,ok INTEGER NOT NULL CHECK(ok=1));`);
  const common = {
    leaseKey: 'r2_release_publication_lease',
    releaseId: FIXTURE_RELEASE_ID,
    ttlSeconds: 3600,
  };
  db.exec(buildPublicationLeaseAcquireSql({ ...common, token: 'owner-a' }));
  assert.throws(
    () => db.exec(buildPublicationLeaseAcquireSql({ ...common, token: 'owner-b' })),
    /CHECK constraint failed/,
  );
  const held = JSON.parse(db.prepare("SELECT value FROM site_meta WHERE key='r2_release_publication_lease'").get().value);
  assert.equal(held.token, 'owner-a');
  db.exec(buildPublicationLeaseReleaseSql({ ...common, token: 'owner-a' }));
  db.exec(buildPublicationLeaseAcquireSql({ ...common, token: 'owner-b' }));
  assert.equal(
    JSON.parse(db.prepare("SELECT value FROM site_meta WHERE key='r2_release_publication_lease'").get().value).token,
    'owner-b',
  );
});

test('R2 publication reads every put from private snapshots after live source replacement', async () => {
  const fixture = await createPublishFixture();
  try {
    const remote = new Map();
    const putRecords = [];
    let sourceReplaced = false;
    const runCommand = (_command, arguments_) => {
      if (arguments_.includes('d1')) {
        if (!sourceReplaced) {
          writeFileSync(join(fixture.fixtureRoot, 'asset-1.json'), '{"asset":"replacement"}\n');
          sourceReplaced = true;
        }
        return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      const objectIndex = arguments_.indexOf('object');
      const operation = arguments_[objectIndex + 1];
      const objectPath = arguments_[objectIndex + 2];
      const key = objectPath.slice(objectPath.indexOf('/') + 1);
      if (operation === 'get') {
        return remote.has(key)
          ? { status: 0, stdout: remote.get(key), stderr: Buffer.alloc(0) }
          : { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('NoSuchKey') };
      }
      if (operation === 'put') {
        const fileIndex = arguments_.indexOf('--file');
        const snapshotPath = arguments_[fileIndex + 1];
        const buffer = readFileSync(snapshotPath);
        putRecords.push({ key, snapshotPath, buffer, mode: lstatSync(snapshotPath).mode });
        remote.set(key, buffer);
        return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      throw new Error(`unexpected operation ${operation}`);
    };
    const result = await publishVersionedRelease({
      manifest: fixture.manifest,
      bucket: 'fixture-bucket',
      environment: 'preview',
      bootstrap: true,
      root: fixture.fixtureRoot,
      runCommand,
      pageEvidenceValidator: () => fixture.manifest.page_evidence,
    });
    assert.equal(result.coordination, 'd1_single_writer_lease_v1');
    const objectPut = putRecords.find((record) => record.key.endsWith('/quality/asset-1.json'));
    assert.deepEqual(objectPut.buffer, fixture.contents[0]);
    assert.notEqual(objectPut.snapshotPath, join(fixture.fixtureRoot, 'asset-1.json'));
    assert.equal(objectPut.mode & 0o222, 0);
    assert.deepEqual(remote.get(`releases/${FIXTURE_RELEASE_ID}/quality/asset-1.json`), fixture.contents[0]);
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('polluted immutable R2 key fails before put and is never overwritten', async () => {
  const fixture = await createPublishFixture();
  try {
    const targetKey = fixture.manifest.r2.objects[0].release_key;
    const remote = new Map([[targetKey, Buffer.from('{"polluted":true}\n')]]);
    const putKeys = [];
    const runCommand = (_command, arguments_) => {
      if (arguments_.includes('d1')) return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      const objectIndex = arguments_.indexOf('object');
      const operation = arguments_[objectIndex + 1];
      const objectPath = arguments_[objectIndex + 2];
      const key = objectPath.slice(objectPath.indexOf('/') + 1);
      if (operation === 'get') {
        return remote.has(key)
          ? { status: 0, stdout: remote.get(key), stderr: Buffer.alloc(0) }
          : { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('NoSuchKey') };
      }
      if (operation === 'put') {
        putKeys.push(key);
        return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      throw new Error(`unexpected operation ${operation}`);
    };
    await assert.rejects(
      publishVersionedRelease({
        manifest: fixture.manifest,
        bucket: 'fixture-bucket',
        environment: 'preview',
        bootstrap: true,
        root: fixture.fixtureRoot,
        runCommand,
        pageEvidenceValidator: () => fixture.manifest.page_evidence,
      }),
      /immutable remote object.*parity failure/,
    );
    assert.deepEqual(putKeys, []);
    assert.deepEqual(remote.get(targetKey), Buffer.from('{"polluted":true}\n'));
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('an already exact release is idempotent and preserves the original pointer timestamp', async () => {
  const fixture = await createPublishFixture();
  try {
    const manifestArtifact = immutableVersionedManifestArtifact(fixture.manifest);
    const originalPublishedAt = '2026-07-17T00:00:00.000Z';
    const pointer = Buffer.from(`${JSON.stringify({
      schema_version: 1,
      release_id: FIXTURE_RELEASE_ID,
      release_manifest_key: fixture.manifest.r2.release_manifest_key,
      release_manifest_sha256: manifestArtifact.sha256,
      release_manifest_bytes: manifestArtifact.bytes,
      managed_object_count: fixture.manifest.r2.objects.length,
      published_at: originalPublishedAt,
    }, null, 2)}\n`);
    const remote = new Map([
      [fixture.manifest.r2.objects[0].release_key, fixture.contents[0]],
      [fixture.manifest.r2.release_manifest_key, manifestArtifact.buffer],
      [fixture.manifest.r2.current_pointer_key, pointer],
    ]);
    const putKeys = [];
    const runCommand = (_command, arguments_) => {
      if (arguments_.includes('d1')) {
        return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      const objectIndex = arguments_.indexOf('object');
      const operation = arguments_[objectIndex + 1];
      const objectPath = arguments_[objectIndex + 2];
      const key = objectPath.slice(objectPath.indexOf('/') + 1);
      if (operation === 'get') {
        return remote.has(key)
          ? { status: 0, stdout: remote.get(key), stderr: Buffer.alloc(0) }
          : { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('NoSuchKey') };
      }
      if (operation === 'put') {
        putKeys.push(key);
        return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      throw new Error(`unexpected operation ${operation}`);
    };
    const result = await publishVersionedRelease({
      manifest: fixture.manifest,
      bucket: 'fixture-bucket',
      environment: 'preview',
      root: fixture.fixtureRoot,
      runCommand,
      publishedAt: '2026-07-18T12:00:00.000Z',
      pageEvidenceValidator: () => fixture.manifest.page_evidence,
    });
    assert.equal(result.uploaded_objects, 0);
    assert.deepEqual(putKeys, []);
    assert.deepEqual(remote.get(fixture.manifest.r2.current_pointer_key), pointer);
    assert.equal(
      JSON.parse(remote.get(fixture.manifest.r2.current_pointer_key)).published_at,
      originalPublishedAt,
    );
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('pointer predecessor drift under the D1 lease refuses lost-update activation', async () => {
  const fixture = await createPublishFixture();
  try {
    const oldReleaseId = `release-${'1'.repeat(32)}`;
    const concurrentReleaseId = `release-${'2'.repeat(32)}`;
    const oldManifest = Buffer.from(`{"release_id":"${oldReleaseId}"}\n`);
    const oldPointer = Buffer.from(`${JSON.stringify({
      schema_version: 1,
      release_id: oldReleaseId,
      release_manifest_key: `releases/${oldReleaseId}/manifest.json`,
      release_manifest_sha256: createHash('sha256').update(oldManifest).digest('hex'),
      release_manifest_bytes: oldManifest.length,
      managed_object_count: 1,
      published_at: '2026-07-17T00:00:00.000Z',
    })}\n`);
    const concurrentPointer = Buffer.from(`${JSON.stringify({
      schema_version: 1,
      release_id: concurrentReleaseId,
      release_manifest_key: `releases/${concurrentReleaseId}/manifest.json`,
      release_manifest_sha256: '9'.repeat(64),
      release_manifest_bytes: 99,
      managed_object_count: 1,
      published_at: '2026-07-17T00:01:00.000Z',
    })}\n`);
    const remote = new Map([
      ['release/current.json', oldPointer],
      [`releases/${oldReleaseId}/manifest.json`, oldManifest],
    ]);
    let pointerGets = 0;
    const putKeys = [];
    const runCommand = (_command, arguments_) => {
      if (arguments_.includes('d1')) return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      const objectIndex = arguments_.indexOf('object');
      const operation = arguments_[objectIndex + 1];
      const objectPath = arguments_[objectIndex + 2];
      const key = objectPath.slice(objectPath.indexOf('/') + 1);
      if (operation === 'get') {
        if (key === 'release/current.json') {
          pointerGets += 1;
          return { status: 0, stdout: pointerGets === 1 ? oldPointer : concurrentPointer, stderr: Buffer.alloc(0) };
        }
        return remote.has(key)
          ? { status: 0, stdout: remote.get(key), stderr: Buffer.alloc(0) }
          : { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('NoSuchKey') };
      }
      if (operation === 'put') {
        const fileIndex = arguments_.indexOf('--file');
        const buffer = readFileSync(arguments_[fileIndex + 1]);
        putKeys.push(key);
        remote.set(key, buffer);
        return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      throw new Error(`unexpected operation ${operation}`);
    };
    await assert.rejects(
      publishVersionedRelease({
        manifest: fixture.manifest,
        bucket: 'fixture-bucket',
        environment: 'preview',
        root: fixture.fixtureRoot,
        runCommand,
        pageEvidenceValidator: () => fixture.manifest.page_evidence,
      }),
      /refusing lost-update activation/,
    );
    assert.equal(putKeys.includes('release/current.json'), false);
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('release identity retains the exact raw corpus envelope binding', async () => {
  const { corpusReleaseIdentity, releaseIdFromIdentity } = await import('../scripts/build-release-manifest.mjs');
  assert.equal(typeof corpusReleaseIdentity, 'function');
  const corpus = {
    source: 'data/corpus-chunks/manifest.json',
    sha256: 'a'.repeat(64),
    bytes: 100,
    release_id: `corpus-${'b'.repeat(24)}`,
    release_fingerprint_sha256: 'b'.repeat(64),
    manifest_sha256: 'c'.repeat(64),
    counts: { documents: 1 },
    chunks: [{ source: 'data/corpus-chunks/000-core.sql', sha256: 'd'.repeat(64), bytes: 50 }],
  };
  const first = corpusReleaseIdentity(corpus);
  const second = corpusReleaseIdentity({ ...corpus, sha256: 'e'.repeat(64), bytes: 101 });
  assert.notDeepEqual(first, second);
  assert.notEqual(
    releaseIdFromIdentity({ fixed: true, corpus_release: first }),
    releaseIdFromIdentity({ fixed: true, corpus_release: second }),
  );
  assert.equal(first.sha256, corpus.sha256);
  assert.equal(first.bytes, corpus.bytes);
  assert.notDeepEqual(first, corpusReleaseIdentity({ ...corpus, manifest_sha256: 'f'.repeat(64) }));
});

test('both R2 publication modes reject a mismatched page-evidence state before any remote command', async () => {
  for (const fixture of [
    {
      pageEvidencePromotion: false,
      page_evidence: { valid: true, publishable: true },
      message: /dedicated page-evidence promotion path/,
    },
    {
      pageEvidencePromotion: true,
      page_evidence: { valid: true, publishable: false },
      message: /promotion requires publishable page evidence/,
    },
  ]) {
    let remoteCommands = 0;
    const manifest = {
      schema_version: 1,
      release_id: FIXTURE_RELEASE_ID,
      page_evidence: fixture.page_evidence,
      r2: {
        release_prefix: 'releases',
        current_pointer_key: 'release/current.json',
        release_manifest_key: `releases/${FIXTURE_RELEASE_ID}/manifest.json`,
        objects: [],
      },
    };
    await assert.rejects(
      publishVersionedRelease({
        manifest,
        bucket: 'fixture-bucket',
        bootstrap: true,
        pageEvidencePromotion: fixture.pageEvidencePromotion,
        runCommand: () => {
          remoteCommands += 1;
          return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('NoSuchKey') };
        },
      }),
      fixture.message,
    );
    assert.equal(remoteCommands, 0);
  }
});

test('R2 preflight revalidates the bound page evidence with the same renderer path', async () => {
  const pageEvidence = {
    valid: true,
    publishable: false,
    manifest: { locator: 'scripts/page-evidence/fail-closed-manifest.json' },
  };
  let observed = null;
  await assert.rejects(
    publishVersionedRelease({
      manifest: {
        schema_version: 1,
        release_id: FIXTURE_RELEASE_ID,
        page_evidence: pageEvidence,
        r2: {
          release_prefix: 'releases',
          current_pointer_key: 'release/current.json',
          release_manifest_key: `releases/${FIXTURE_RELEASE_ID}/manifest.json`,
          publication_coordination: publicationCoordination(),
          objects: [],
        },
      },
      bucket: 'fixture-bucket',
      environment: 'preview',
      rendererPath: '/controlled/mutool',
      pageEvidenceValidator: (options) => {
        observed = options;
        return pageEvidence;
      },
      runCommand: () => {
        throw new Error('remote command must not run');
      },
    }),
    /missing its corpus_release binding/,
  );
  assert.equal(observed.rendererPath, '/controlled/mutool');
  assert.equal(observed.evidenceManifestPath, pageEvidence.manifest.locator);
  assert.equal(observed.pageEvidencePromotion, false);
});

test('metadata publishing exposes explicit default-off promotion commands and renderer forwarding', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const publisher = await readFile(new URL('../scripts/publish-metadata.mjs', import.meta.url), 'utf8');
  assert.match(packageJson.scripts['metadata:publish:page-evidence:preview'], /--page-evidence-promotion/);
  assert.match(packageJson.scripts['metadata:publish:page-evidence:production'], /--page-evidence-promotion/);
  assert.match(publisher, /rendererPath/);
  assert.match(publisher, /--renderer/);
});

test('raw corpus audit envelope hash and byte binding still rejects tampering', async () => {
  const raw = await readFile(new URL('../data/corpus-chunks/manifest.json', import.meta.url));
  const binding = {
    sha256: createHash('sha256').update(raw).digest('hex'),
    bytes: raw.byteLength,
  };
  assert.deepEqual(assertBufferParity(binding, raw, 'raw corpus manifest'), binding);
  assert.throws(
    () => assertBufferParity(
      binding,
      Buffer.concat([raw, Buffer.from(' ')]),
      'tampered raw corpus manifest',
    ),
    /parity failure/,
  );
});

test('a generated R2 release rejects raw corpus envelope drift before remote access', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'release-corpus-drift-test-'));
  try {
    const raw = await readFile(new URL('../data/corpus-chunks/manifest.json', import.meta.url));
    const parsed = JSON.parse(raw.toString('utf8'));
    const drifted = Buffer.from(`${raw.toString('utf8').trimEnd()} \n`);
    await writeFile(join(fixtureRoot, 'corpus-manifest.json'), drifted);
    let remoteCommands = 0;
    await assert.rejects(
      publishVersionedRelease({
        manifest: {
          schema_version: 1,
          release_id: FIXTURE_RELEASE_ID,
          page_evidence: { valid: true, publishable: false },
          corpus_release: {
            source: 'corpus-manifest.json',
            sha256: createHash('sha256').update(raw).digest('hex'),
            bytes: raw.length,
            release_id: parsed.release_id,
            release_fingerprint_sha256: parsed.release_fingerprint_sha256,
            manifest_sha256: parsed.manifest_sha256,
          },
          r2: {
            release_prefix: 'releases',
            current_pointer_key: 'release/current.json',
            release_manifest_key: `releases/${FIXTURE_RELEASE_ID}/manifest.json`,
            publication_coordination: publicationCoordination(),
            objects: [],
          },
        },
        bucket: 'fixture-bucket',
        environment: 'preview',
        bootstrap: true,
        root: fixtureRoot,
        pageEvidenceValidator: () => ({ valid: true, publishable: false }),
        runCommand: () => {
          remoteCommands += 1;
          return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('unexpected remote command') };
        },
      }),
      /local corpus envelope.*parity failure/,
    );
    assert.equal(remoteCommands, 0);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('hash and byte parity rejects stale content', () => {
  const expected = {
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    bytes: 3,
  };
  assert.deepEqual(assertBufferParity(expected, Buffer.from('abc'), 'fixture'), expected);
  assert.throws(
    () => assertBufferParity(expected, Buffer.from('abd'), 'fixture'),
    /parity failure/,
  );
  assert.throws(
    () => assertBufferParity(expected, Buffer.from('abc\n'), 'fixture'),
    /parity failure/,
  );
});

test('managed key comparison exposes every omission and extra key', () => {
  assert.deepEqual(
    compareManagedKeySets(['a.json', 'b.json'], ['b.json', 'c.json']),
    { missing: ['a.json'], extra: ['c.json'] },
  );
});

test('pending migration blocks R2 publication before any remote command can start', () => {
  let remoteCommands = 0;
  assert.throws(
    () => {
      assertReleaseSourceReady({
        git: { head: 'a'.repeat(40), dirty: false },
        release_blockers: [],
      });
      assertEnvironmentReleaseReady({
        environment_snapshot: {
          environments: {
            preview: {
              release_ready: false,
              release_blockers: [{ code: 'pending_d1_migration', migration: '0005_page_publication_gate.sql' }],
            },
          },
        },
      }, 'preview');
      remoteCommands += 1;
      throw new Error('remote command must not run');
      },
    /blocked before remote mutation.*0005_page_publication_gate\.sql/,
  );
  assert.equal(remoteCommands, 0);
});

test('environment readiness cannot be inferred when a blocker is present', () => {
  assert.throws(
    () => assertEnvironmentReleaseReady({
      environment_snapshot: {
        environments: {
          production: {
            release_ready: false,
            release_blockers: [{ code: 'pending_d1_migration', migration: '0005_page_publication_gate.sql' }],
          },
        },
      },
    }, 'production'),
    /blocked before remote mutation/,
  );
});

test('dirty or unbound release source blocks publication independently of environment readiness', () => {
  assert.throws(
    () => assertReleaseSourceReady({
      git: { head: 'a'.repeat(40), dirty: true },
      release_blockers: [{ environment: 'source', code: 'dirty_git_tree' }],
    }),
    /dirty Git working tree/,
  );
  assert.throws(
    () => assertReleaseSourceReady({ git: { dirty: false }, release_blockers: [] }),
    /missing exact Git HEAD/,
  );
  assert.throws(
    () => assertReleaseSourceReady({
      git: { head: 'a'.repeat(40), dirty: false },
      release_blockers: [{ environment: 'source', code: 'git_head_not_pushed' }],
    }),
    /git_head_not_pushed/,
  );
  assert.deepEqual(
    assertReleaseSourceReady({ git: { head: 'a'.repeat(40), dirty: false }, release_blockers: [] }),
    { head: 'a'.repeat(40), dirty: false },
  );
});

test('a staging failure leaves the existing current pointer untouched', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'release-pointer-test-'));
  try {
    const contents = [Buffer.from('{"asset":1}\n'), Buffer.from('{"asset":2}\n')];
    const objects = [];
    for (const [index, buffer] of contents.entries()) {
      const source = `asset-${index + 1}.json`;
      await writeFile(join(fixtureRoot, source), buffer);
      objects.push({
        role: `asset_${index + 1}`,
        source,
        key: `quality/${source}`,
        release_key: `releases/${FIXTURE_RELEASE_ID}/quality/${source}`,
        content_type: 'application/json',
        sha256: createHash('sha256').update(buffer).digest('hex'),
        bytes: buffer.length,
        counts: {},
      });
    }
    const corpusManifest = sealCorpusManifest({
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
      },
      text_asset_count: 1,
      text_assets: [{ document_id: 'doc-a', sha256: 'e'.repeat(64), bytes: 1 }],
      sql_chunks: 1,
      sql_files: [{ name: '000-core.sql', sha256: 'f'.repeat(64), bytes: 1 }],
      closed_ocr_paragraphs: 0,
      skipped_ocr_documents: 0,
      excluded_exact_duplicate_alias_documents: 0,
      semantic_excluded_pages: 0,
      page_publication_schema_version: 1,
      semantic_publication_schema_version: 1,
      semantic_publication_revision_sha256: 'a'.repeat(64),
    });
    const corpusBuffer = Buffer.from(`${JSON.stringify(corpusManifest, null, 2)}\n`);
    await writeFile(join(fixtureRoot, 'corpus-manifest.json'), corpusBuffer);
    const manifest = {
      schema_version: 1,
      release_id: FIXTURE_RELEASE_ID,
      page_evidence: { valid: true, publishable: false },
      corpus_release: {
        source: 'corpus-manifest.json',
        sha256: createHash('sha256').update(corpusBuffer).digest('hex'),
        bytes: corpusBuffer.length,
        release_id: corpusManifest.release_id,
        release_fingerprint_sha256: corpusManifest.release_fingerprint_sha256,
        manifest_sha256: corpusManifest.manifest_sha256,
      },
      r2: {
        release_prefix: 'releases',
        current_pointer_key: 'release/current.json',
        release_manifest_key: `releases/${FIXTURE_RELEASE_ID}/manifest.json`,
        publication_coordination: publicationCoordination(),
        objects,
      },
    };

    const oldReleaseId = `release-${'1'.repeat(32)}`;
    const oldManifest = Buffer.from(`{"release_id":"${oldReleaseId}"}\n`);
    const oldPointer = Buffer.from(`${JSON.stringify({
      schema_version: 1,
      release_id: oldReleaseId,
      release_manifest_key: `releases/${oldReleaseId}/manifest.json`,
      release_manifest_sha256: createHash('sha256').update(oldManifest).digest('hex'),
      release_manifest_bytes: oldManifest.length,
      managed_object_count: 1,
      published_at: '2026-07-17T00:00:00.000Z',
    })}\n`);
    const putKeys = [];
    const remoteObjects = new Map([
      ['release/current.json', oldPointer],
      [`releases/${oldReleaseId}/manifest.json`, oldManifest],
    ]);
    const runCommand = (_command, arguments_) => {
      if (arguments_.includes('d1')) {
        return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      const objectIndex = arguments_.indexOf('object');
      const operation = arguments_[objectIndex + 1];
      const objectPath = arguments_[objectIndex + 2];
      const key = objectPath.slice(objectPath.indexOf('/') + 1);
      if (operation === 'get') {
        if (remoteObjects.has(key)) {
          return { status: 0, stdout: remoteObjects.get(key), stderr: Buffer.alloc(0) };
        }
        return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('NoSuchKey') };
      }
      if (operation === 'put') {
        putKeys.push(key);
        if (putKeys.length === 2) return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('simulated staging failure') };
        const fileIndex = arguments_.indexOf('--file');
        remoteObjects.set(key, readFileSync(arguments_[fileIndex + 1]));
        return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      throw new Error(`unexpected operation ${operation}`);
    };

    await assert.rejects(
      publishVersionedRelease({
        manifest,
        bucket: 'fixture-bucket',
        environment: 'preview',
        root: fixtureRoot,
        runCommand,
        pageEvidenceValidator: () => manifest.page_evidence,
      }),
      new RegExp(`R2 put releases/${FIXTURE_RELEASE_ID}/quality/asset-2\\.json failed`),
    );
    assert.deepEqual(putKeys, [
      `releases/${FIXTURE_RELEASE_ID}/quality/asset-1.json`,
      `releases/${FIXTURE_RELEASE_ID}/quality/asset-2.json`,
    ]);
    assert.equal(putKeys.includes('release/current.json'), false);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
