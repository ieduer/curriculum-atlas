import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertBufferParity,
  assertGitSnapshotUnchanged,
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
import {
  desiredReleaseManifestArtifact,
  desiredReleasePin,
  parseDesiredReleaseManifestArtifact,
} from '../scripts/lib/desired-release-manifest.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE_RELEASE_ID = `release-${'f'.repeat(32)}`;

function publicationCoordination() {
  return {
    policy: 'd1_activation_claimed_r2_binding_v3',
    lease_key: 'r2_release_publication_lease',
    lease_ttl_seconds: 3600,
    databases: { preview: 'fixture-preview', production: 'fixture-production' },
    coordinator_urls: {
      preview: 'https://preview.example.test/api/admin/release-coordinate',
      production: 'https://production.example.test/api/admin/release-coordinate',
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
  assert.equal(
    manifest.source_tree.files.some((file) => file.path === 'data/release-environment-evidence.json'),
    false,
    'mutable environment evidence must stay outside the governed source tree',
  );

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
  ]) assert.ok(byRole.has(role), `missing ${role}`);

  assert.equal(byRole.get('catalog').counts.documents, catalog.documents.length);
  assert.equal(byRole.get('catalog').counts.citation_ready, catalog.documents.filter((item) => item.citation_allowed === true).length);
  assert.equal(byRole.get('ocr_queue').counts.documents, queue.documents.length);
  assert.equal(byRole.get('ocr_queue').counts.pages, queue.documents.reduce((total, item) => total + item.page_count, 0));
  assert.equal(manifest.r2.managed_object_count, manifest.data_assets.length);
  assert.equal(
    manifest.data_assets.some((asset) => asset.source === 'data/release-environment-evidence.json'),
    false,
    'environment evidence is a governance receipt, not a release data asset',
  );
  assert.equal(
    manifest.r2.objects.some((object) => object.source === 'data/release-environment-evidence.json'),
    false,
    'environment evidence must never enter the versioned R2 release',
  );
  assert.equal(new Set(manifest.r2.objects.map((object) => object.key)).size, manifest.r2.managed_object_count);
  assert.ok(manifest.r2.objects.every((object) => object.release_key.startsWith(`${manifest.r2.release_prefix}/${manifest.release_id}/`)));
  assert.equal(manifest.r2.release_manifest_key, `${manifest.r2.release_prefix}/${manifest.release_id}/manifest.json`);
  assert.equal(manifest.r2.current_pointer_key, 'release/current.json');
  assert.deepEqual(manifest.corpus_release.counts.core_table_counts, {
    subjects: 0,
    periods: 5,
    document_relations: 0,
    chapters: 0,
    document_classifications: 195,
    document_sources: 252,
    primary_document_sources: 195,
    subject_insights: 6,
    terms: 5,
    term_relations: 4,
    version_diffs: 0,
    online_verifications: 1,
    online_evidence: 5,
    embedded_items: 0,
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
  assert.equal(manifest.subject_ontology_v2.valid, true);
  assert.equal(manifest.subject_ontology_v2.publishable, false);
  assert.equal(manifest.subject_ontology_v2.mode, 'ordinary_nonpublishable');
  assert.equal(manifest.subject_ontology_v2.release_boundary.frontend_consumer_allowed, false);
  assert.equal(manifest.subject_ontology_v2.release_boundary.r2_consumer_allowed, false);
  assert.deepEqual(manifest.release_identity.subject_ontology_v2, manifest.subject_ontology_v2);
  const ontologyReport = await readFile(new URL('../data/subject-ontology-v2-validation.json', import.meta.url));
  assert.equal(manifest.subject_ontology_v2.report.sha256, createHash('sha256').update(ontologyReport).digest('hex'));
  assert.equal(manifest.subject_ontology_v2.report.bytes, ontologyReport.byteLength);

  assert.equal(manifest.graph_assets.length, 2);
  assert.equal(manifest.graph_assets[0].build_revision, manifest.graph_assets[1].build_revision);
  assert.ok(manifest.graph_assets.every((asset) => asset.sha256.length === 64 && asset.bytes > 0));
  assert.ok(manifest.graph_assets.every((asset) => asset.deploy_path.startsWith('dist/data/')));
  assert.ok(manifest.graph_shards.length > 2);
  assert.ok(manifest.graph_shards.every((asset) => asset.build_revision === manifest.graph_assets[0].build_revision));
  assert.ok(manifest.graph_shards.every((asset) => asset.sha256.length === 64 && asset.bytes > 0 && asset.bytes <= 512 * 1024));
  assert.ok(manifest.graph_shards.every((asset) => asset.source.startsWith('public/data/graph-shards/')));
  assert.ok(manifest.graph_shards.every((asset) => asset.deploy_path.startsWith('dist/data/graph-shards/')));
  assert.equal(manifest.static_assets.source_root, 'public');
  assert.equal(manifest.static_assets.deploy_root, 'dist');
  assert.ok(manifest.static_assets.files.some((asset) => asset.path === 'public/subject-facets.js'));
  assert.ok(manifest.static_assets.files.some((asset) => asset.path === 'public/index.html'));
  assert.ok(manifest.static_assets.files.every((asset) => asset.deploy_path.startsWith('dist/')));

  assert.equal(manifest.environment_snapshot.environments.local.worker_revision, 'working-tree-v13');
  assert.equal(manifest.environment_snapshot.required_migration, '0008_release_ownership_fences.sql');
  assert.deepEqual(manifest.environment_snapshot.required_migrations, [
    '0008_release_ownership_fences.sql',
    '0009_compendium_embedded_items.sql',
  ]);
  assert.equal(manifest.environment_snapshot.environments.local.r2_release_reader, 'versioned_manifest_v2_fenced');
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
    assert.equal(
      state.asset_git_commit_deployment_parity,
      !state.release_blockers.some((blocker) => blocker.code === 'worker_graph_shard_git_parity_required'),
    );
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

test('release manifest content read is fenced by an exact final Git snapshot recheck', async () => {
  const clean = {
    head: 'a'.repeat(40),
    branch: 'codex/release-fixture',
    upstream_head: 'a'.repeat(40),
    dirty: false,
    status_entries: 0,
    status_sha256: createHash('sha256').update('').digest('hex'),
  };
  assert.equal(assertGitSnapshotUnchanged(clean, { ...clean }), true);
  assert.throws(
    () => assertGitSnapshotUnchanged(clean, { ...clean, head: 'b'.repeat(40) }),
    /Git HEAD changed while release content was read/,
  );
  assert.throws(
    () => assertGitSnapshotUnchanged(clean, {
      ...clean,
      dirty: true,
      status_entries: 1,
      status_sha256: 'c'.repeat(64),
    }),
    /Git status changed while release content was read/,
  );

  const source = await readFile(new URL('../scripts/build-release-manifest.mjs', import.meta.url), 'utf8');
  const initial = source.indexOf('const initialGit = gitOverride || inspectGitSnapshot(');
  const contentRead = source.indexOf('const policyAsset = await inspectFile(');
  const final = source.indexOf('const finalGit = inspectGitSnapshot(gitRepositoryRoot, runCommand);');
  assert.ok(initial >= 0 && initial < contentRead && contentRead < final);
});

test('prepared manifest overrides require one exact materialized Git blob identity', async () => {
  const gitOverride = {
    head: 'a'.repeat(40),
    branch: 'codex/prepared-fixture',
    upstream_head: 'a'.repeat(40),
    dirty: false,
    status_entries: 0,
    status_sha256: '0'.repeat(64),
    materialized_from_git_blobs: true,
  };
  await assert.rejects(
    buildReleaseManifest({ root, gitOverride }),
    /gitOverride and sourceTreeOverride must be supplied together/,
  );
  await assert.rejects(
    buildReleaseManifest({
      root,
      gitOverride,
      sourceTreeOverride: { materialized_from_git_blobs: false },
    }),
    /exact materialized Git blob tree/,
  );
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

test('one canonical desired release artifact is complete across Worker, R2, and evidence without observations', async () => {
  const manifest = await buildHermeticReleaseManifest('2026-07-17T00:00:00.000Z');
  const artifact = desiredReleaseManifestArtifact(manifest);
  const parsed = parseDesiredReleaseManifestArtifact(artifact.buffer);
  const pin = desiredReleasePin(parsed);
  assert.equal(pin.git_head, manifest.git.head);
  assert.equal(pin.release_id, manifest.release_id);
  assert.equal(pin.release_manifest_sha256, artifact.sha256);
  assert.equal(pin.release_manifest_bytes, artifact.bytes);
  assert.equal(pin.source_tree_sha256, manifest.source_tree.sha256);
  assert.equal(pin.corpus_release_id, manifest.corpus_release.release_id);
  assert.equal(pin.corpus_manifest_sha256, manifest.corpus_release.manifest_sha256);
  assert.equal(parsed.value.r2.release_manifest_key, `releases/${manifest.release_id}/manifest.json`);
  assert.equal(parsed.value.r2.managed_object_count, parsed.value.r2.objects.length);
  assert.deepEqual(
    parsed.value.release_identity.subject_ontology_v2,
    manifest.subject_ontology_v2,
    'desired-release identity must bind the exact ontology validation report and dependencies',
  );
  const serialized = artifact.buffer.toString('utf8');
  for (const forbidden of ['environment_snapshot', 'release_blockers', 'published_at', 'observed_at', 'health', 'generated_at']) {
    assert.doesNotMatch(serialized, new RegExp(`"${forbidden}"`));
  }

  const drift = structuredClone(parsed.value);
  drift.release_id = `release-${'0'.repeat(32)}`;
  assert.throws(
    () => parseDesiredReleaseManifestArtifact(Buffer.from(`${JSON.stringify(drift, null, 2)}\n`)),
    /release_id does not match release_identity/,
  );
});

test('desired release rejects a stripped or weakened ontology identity even after release-id rebinding', async () => {
  const manifest = await buildHermeticReleaseManifest('2026-07-22T05:00:00.000Z');
  for (const mutate of [
    (ontology) => { delete ontology.dependencies; },
    (ontology) => { delete ontology.counts.coverage_universes; },
    (ontology) => { ontology.release_boundary.same_commit_scope_evidence_self_attestation_allowed = true; },
  ]) {
    const desired = desiredReleaseManifestArtifact(manifest).value;
    mutate(desired.release_identity.subject_ontology_v2);
    desired.release_id = releaseIdFromIdentity(desired.release_identity);
    const artifact = desiredReleaseManifestArtifact(desired);
    assert.throws(
      () => parseDesiredReleaseManifestArtifact(artifact.buffer),
      /exact fail-closed subject ontology v2 validation identity/,
    );
  }
});

test('D1 publication lease serializes different owners even for the same release', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE corpus_import_guards(guard_key TEXT PRIMARY KEY,ok INTEGER NOT NULL CHECK(ok=1));
    CREATE TABLE release_publication_fence_state(id INTEGER PRIMARY KEY,last_fence INTEGER NOT NULL);
    INSERT INTO release_publication_fence_state(id,last_fence) VALUES(1,0);
    CREATE TABLE release_publication_ownership(
      id INTEGER PRIMARY KEY,release_id TEXT NOT NULL,manifest_sha256 TEXT NOT NULL,
      owner_token_sha256 TEXT NOT NULL,owner_fence INTEGER NOT NULL,expires_unix INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE release_publication_activation_claim(
      id INTEGER PRIMARY KEY,release_id TEXT NOT NULL,manifest_sha256 TEXT NOT NULL,
      owner_token_sha256 TEXT NOT NULL,owner_fence INTEGER NOT NULL,expires_unix INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`);
  const common = {
    releaseId: FIXTURE_RELEASE_ID,
    manifestSha256: 'f'.repeat(64),
    ttlSeconds: 3600,
  };
  db.exec(buildPublicationLeaseAcquireSql({ ...common, token: 'publication-owner-a' }));
  assert.throws(
    () => db.exec(buildPublicationLeaseAcquireSql({ ...common, token: 'publication-owner-b' })),
    /CHECK constraint failed/,
  );
  assert.equal(Number(db.prepare('SELECT owner_fence FROM release_publication_ownership WHERE id=1').get().owner_fence), 1);
  db.exec(buildPublicationLeaseReleaseSql({ ...common, token: 'publication-owner-a', ownerFence: 1 }));
  db.exec(buildPublicationLeaseAcquireSql({ ...common, token: 'publication-owner-b' }));
  assert.equal(Number(db.prepare('SELECT owner_fence FROM release_publication_ownership WHERE id=1').get().owner_fence), 2);
  db.close();
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
  assert.match(packageJson.scripts['release:evidence:preview'], /--output \.wrangler\/release-environment-evidence\.json/);
  assert.match(packageJson.scripts['metadata:publish:preview'], /--evidence \.wrangler\/release-environment-evidence\.json/);
  assert.match(packageJson.scripts['metadata:publish:production'], /--evidence \.wrangler\/release-environment-evidence\.json/);
  assert.match(packageJson.scripts['metadata:publish:page-evidence:preview'], /--page-evidence-promotion/);
  assert.match(packageJson.scripts['metadata:publish:page-evidence:production'], /--page-evidence-promotion/);
  assert.match(publisher, /rendererPath/);
  assert.match(publisher, /--renderer/);
  assert.doesNotMatch(publisher, /buildReleaseManifest/);
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
