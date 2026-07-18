import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sealCorpusManifest } from '../scripts/import-corpus.mjs';
import { publishVersionedRelease } from '../scripts/publish-metadata.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('metadata publisher stages the sealed local bytes only through the fenced coordinator', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curriculum-coordinator-publisher-'));
  try {
    const original = Buffer.from('{"asset":"sealed"}\n');
    await writeFile(join(root, 'asset.json'), original);
    const corpus = sealCorpusManifest({
      generated_at: '2026-07-18T00:00:00.000Z',
      schema_version: 1,
      release_id: `corpus-${'b'.repeat(24)}`,
      release_fingerprint_sha256: 'b'.repeat(64),
      documents: 1, paragraphs: 1, fts_rows: 1, page_publication_gates: 1,
      displayed_paragraphs: 1, accepted_ocr_documents: 0,
      core_table_counts: {
        subjects: 0, periods: 5, document_relations: 0, chapters: 0,
        document_classifications: 1, document_sources: 1, primary_document_sources: 1,
        subject_insights: 0, terms: 0, term_relations: 0, version_diffs: 0,
        online_verifications: 0, online_evidence: 0,
      },
      text_asset_count: 1,
      text_assets: [{ document_id: 'doc-a', sha256: 'e'.repeat(64), bytes: 1 }],
      sql_chunks: 1,
      sql_files: [{ name: '000-core.sql', sha256: 'f'.repeat(64), bytes: 1 }],
      closed_ocr_paragraphs: 0, skipped_ocr_documents: 0,
      excluded_exact_duplicate_alias_documents: 0, semantic_excluded_pages: 0,
      page_publication_schema_version: 1, semantic_publication_schema_version: 1,
      semantic_publication_revision_sha256: 'a'.repeat(64),
    });
    const corpusBytes = Buffer.from(`${JSON.stringify(corpus, null, 2)}\n`);
    await writeFile(join(root, 'corpus.json'), corpusBytes);
    const releaseId = `release-${'f'.repeat(32)}`;
    const object = {
      role: 'fixture', source: 'asset.json', key: 'quality/asset.json',
      release_key: `releases/${releaseId}/quality/asset.json`,
      content_type: 'application/json', sha256: sha256(original), bytes: original.length, counts: {},
    };
    const pageEvidence = { valid: true, publishable: false };
    const manifest = {
      schema_version: 1,
      policy: 'fixture',
      release_id: releaseId,
      git: { head: '1'.repeat(40) },
      source_tree: { sha256: '2'.repeat(64), files: [] },
      release_identity: {},
      page_evidence: pageEvidence,
      corpus_release: {
        source: 'corpus.json', sha256: sha256(corpusBytes), bytes: corpusBytes.length,
        release_id: corpus.release_id, release_fingerprint_sha256: corpus.release_fingerprint_sha256,
        manifest_sha256: corpus.manifest_sha256,
      },
      data_assets: [object], graph_assets: [], static_assets: { files: [] },
      r2: {
        release_prefix: 'releases', current_pointer_key: 'release/current.json',
        release_manifest_key: `releases/${releaseId}/manifest.json`, managed_object_count: 1,
        publication_coordination: {
          policy: 'd1_fenced_r2_binding_v2', lease_key: 'fixture', lease_ttl_seconds: 3600,
          databases: { preview: 'fixture-preview', production: 'fixture-production' },
          coordinator_urls: {
            preview: 'https://preview.example.test/api/admin/release-coordinate',
            production: 'https://production.example.test/api/admin/release-coordinate',
          },
        },
        objects: [object],
      },
    };
    const staged = new Map();
    let sourceMutated = false;
    const runCommand = (_command, args) => {
      assert.equal(args.includes('r2'), false, 'publisher must not call direct Wrangler R2 commands');
      if (!sourceMutated) {
        sourceMutated = true;
        writeFileSync(join(root, 'asset.json'), '{"asset":"mutated"}\n');
      }
      return args.includes('--json')
        ? { status: 0, stdout: Buffer.from('[{"results":[{"owner_fence":1}]}]'), stderr: Buffer.alloc(0) }
        : { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };
    const fetchImpl = async (input, init) => {
      const url = new URL(input);
      const operation = url.searchParams.get('operation');
      if (operation === 'inspect-pointer') return Response.json({ exists: false });
      if (operation === 'create') {
        const body = Buffer.from(await new Response(init.body).arrayBuffer());
        const key = url.searchParams.get('key');
        staged.set(key, {
          body,
          sha256: init.headers.get('x-content-sha256'),
          bytes: body.length,
          releaseId: init.headers.get('x-release-id'),
          manifestSha256: init.headers.get('x-release-manifest-sha256'),
        });
        return Response.json({ created: true, key, etag: `etag-${staged.size}`, version: `v-${staged.size}` });
      }
      if (operation === 'inventory') {
        return Response.json({
          objects: [...staged].map(([key, value]) => ({
            key,
            sha256: value.sha256,
            bytes: value.bytes,
            metadata_sha256: value.sha256,
            metadata_bytes: String(value.bytes),
            metadata_release_id: value.releaseId,
            metadata_manifest_sha256: value.manifestSha256,
          })),
        });
      }
      if (operation === 'activate') {
        return Response.json({ activated: true, etag: 'pointer-etag', version: 'pointer-v2' });
      }
      throw new Error(`unexpected coordinator operation: ${operation}`);
    };

    const result = await publishVersionedRelease({
      manifest,
      bucket: 'fixture-bucket',
      environment: 'preview',
      bootstrap: true,
      root,
      runCommand,
      pageEvidenceValidator: () => pageEvidence,
      coordinatorToken: 'fixture-coordinator-token',
      fetchImpl,
      postActivationVerifier: async () => ({ pointer: { sha256: '9'.repeat(64) }, health: { ok: true } }),
    });
    assert.equal(result.coordination, 'd1_fenced_r2_binding_v2');
    assert.equal(result.owner_fence, 1);
    assert.deepEqual(staged.get(object.release_key).body, original);
    assert.notDeepEqual(staged.get(object.release_key).body, Buffer.from('{"asset":"mutated"}\n'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
