import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertBufferParity,
  assertGitCommitExists,
  buildReleaseManifest,
  compareManagedKeySets,
} from '../scripts/build-release-manifest.mjs';
import {
  assertEnvironmentReleaseReady,
  assertReleaseSourceReady,
  publishVersionedRelease,
} from '../scripts/publish-metadata.mjs';
import { sealCorpusManifest } from '../scripts/import-corpus.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('release manifest binds the complete data, graph, static, Git, and environment state', async () => {
  const environmentEvidence = JSON.parse(await readFile(new URL('../data/release-environment-evidence.json', import.meta.url), 'utf8'));
  const manifest = await buildReleaseManifest({
    root,
    generatedAt: '2026-07-17T00:00:00.000Z',
  });
  const catalog = JSON.parse(await readFile(new URL('../data/catalog.json', import.meta.url), 'utf8'));
  const queue = JSON.parse(await readFile(new URL('../data/ocr-queue.json', import.meta.url), 'utf8'));

  assert.equal(manifest.schema_version, 1);
  assert.match(manifest.release_id, /^release-[0-9a-f]{32}$/);
  assert.equal(manifest.integrity.valid, true);
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
  const first = await buildReleaseManifest({ root, generatedAt: '2026-07-17T00:00:00.000Z' });
  const second = await buildReleaseManifest({ root, generatedAt: '2026-07-17T00:01:00.000Z' });
  assert.equal(first.release_id, second.release_id);
  assert.equal(first.source_tree.sha256, second.source_tree.sha256);
  assert.notEqual(first.generated_at, second.generated_at);
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
      release_id: 'release-fixture',
      page_evidence: fixture.page_evidence,
      r2: {
        release_prefix: 'releases',
        current_pointer_key: 'release/current.json',
        release_manifest_key: 'releases/release-fixture/manifest.json',
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
        release_id: 'release-fixture',
        page_evidence: pageEvidence,
        r2: {
          release_prefix: 'releases',
          current_pointer_key: 'release/current.json',
          release_manifest_key: 'releases/release-fixture/manifest.json',
          objects: [],
        },
      },
      bucket: 'fixture-bucket',
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
          release_id: 'release-fixture',
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
            release_manifest_key: 'releases/release-fixture/manifest.json',
            objects: [],
          },
        },
        bucket: 'fixture-bucket',
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
        release_key: `releases/release-fixture/quality/${source}`,
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
      release_id: 'release-fixture',
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
        release_manifest_key: 'releases/release-fixture/manifest.json',
        objects,
      },
    };

    const oldManifest = Buffer.from('{"release_id":"release-old"}\n');
    const oldPointer = Buffer.from(`${JSON.stringify({
      schema_version: 1,
      release_id: 'release-old',
      release_manifest_key: 'releases/release-old/manifest.json',
      release_manifest_sha256: createHash('sha256').update(oldManifest).digest('hex'),
      release_manifest_bytes: oldManifest.length,
    })}\n`);
    const putKeys = [];
    const runCommand = (_command, arguments_) => {
      const objectIndex = arguments_.indexOf('object');
      const operation = arguments_[objectIndex + 1];
      const objectPath = arguments_[objectIndex + 2];
      const key = objectPath.slice(objectPath.indexOf('/') + 1);
      if (operation === 'get') {
        if (key === 'release/current.json') return { status: 0, stdout: oldPointer, stderr: Buffer.alloc(0) };
        if (key === 'releases/release-old/manifest.json') return { status: 0, stdout: oldManifest, stderr: Buffer.alloc(0) };
        return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('NoSuchKey') };
      }
      if (operation === 'put') {
        putKeys.push(key);
        if (putKeys.length === 2) return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('simulated staging failure') };
        return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      throw new Error(`unexpected operation ${operation}`);
    };

    await assert.rejects(
      publishVersionedRelease({
        manifest,
        bucket: 'fixture-bucket',
        root: fixtureRoot,
        runCommand,
        pageEvidenceValidator: () => manifest.page_evidence,
      }),
      /R2 put releases\/release-fixture\/quality\/asset-2\.json failed/,
    );
    assert.deepEqual(putKeys, [
      'releases/release-fixture/quality/asset-1.json',
      'releases/release-fixture/quality/asset-2.json',
    ]);
    assert.equal(putKeys.includes('release/current.json'), false);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
