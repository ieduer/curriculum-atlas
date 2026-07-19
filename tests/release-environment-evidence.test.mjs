import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  collectReleaseEnvironmentEvidence,
  validateEnvironmentEvidenceReceipt,
} from '../scripts/collect-release-environment-evidence.mjs';
import { verifyDualSchemaBootstrap } from '../scripts/verify-dual-schema-bootstrap.mjs';

const dualSchemaBootstrapReceipt = verifyDualSchemaBootstrap();

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const desiredRelease = {
  release_id: `release-${'1'.repeat(32)}`,
  release_manifest_sha256: '2'.repeat(64),
  release_manifest_bytes: 123,
  git_head: 'a'.repeat(40),
  source_tree_sha256: '3'.repeat(64),
  corpus_release_id: `corpus-${'d'.repeat(24)}`,
  corpus_manifest_sha256: 'e'.repeat(64),
  corpus_envelope_sha256: '4'.repeat(64),
};

function environment(name, desired = null) {
  const coreTableCounts = {
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
  };
  const assetPaths = [
    'app.js', 'atlas.js', 'styles.css', 'data/concept-evolution.json',
    'data/concept-evolution-academic.json', 'data/graph-shards/fixture.json',
  ].sort();
  return {
    environment: name,
    observed_at: '2026-07-17T00:00:00.000Z',
    worker_name: `worker-${name}`,
    worker_version_id: '1'.repeat(8) + '-1111-4111-8111-' + '1'.repeat(12),
    deployment_id: '2'.repeat(8) + '-2222-4222-8222-' + '2'.repeat(12),
    deployment_created_on: '2026-07-17T00:00:00.000Z',
    asset_git_commit: 'a'.repeat(40),
    asset_parity: {
      valid: true,
      method: 'git_graph_manifest_live_assets_byte_equal_commit',
      transport_profile: 'immutable-content-addressed-graph-shards-v1',
      build_revision: 'b'.repeat(64),
      graph_shard_count: 1,
      asset_paths_sha256: createHash('sha256').update(assetPaths.join('\0')).digest('hex'),
      assets: assetPaths.map((path) => ({ path, sha256: 'b'.repeat(64), bytes: 1 })),
    },
    applied_migrations: ['0001_initial.sql'],
    pending_migrations: [],
    r2_release_reader: desired ? 'versioned_manifest_v2_fenced' : 'versioned_manifest_v1',
    desired_release: desired || undefined,
    health: {
      url: 'https://example.test/api/health', http_status: 200, ok: true, version: 'v9',
      release_git_commit: 'a'.repeat(40),
      release_id: desired?.release_id,
      release_manifest_sha256: desired?.release_manifest_sha256,
      release_source_tree_sha256: desired?.source_tree_sha256,
      corpus_release_id: desired?.corpus_release_id,
      corpus_manifest_sha256: desired?.corpus_manifest_sha256,
      body_sha256: 'c'.repeat(64), bytes: 1,
    },
    corpus: {
      ready: true,
      release_id: `corpus-${'d'.repeat(24)}`,
      release_fingerprint_sha256: 'd'.repeat(64),
      manifest_sha256: 'e'.repeat(64),
      counts: { documents: 1, paragraphs: 1, fts_rows: 1, page_publication_gates: 1, displayed_paragraphs: 1, accepted_ocr_documents: 0, chunks: 1, core_table_counts: coreTableCounts },
    },
    r2_current_pointer: { exists: false },
    command_receipts: [{ id: 'fixture', command: 'fixture', exit_code: 0, stdout_sha256: 'f'.repeat(64), stdout_bytes: 1, stderr_sha256: '0'.repeat(64), stderr_bytes: 0 }],
  };
}

function receipt() {
  const value = {
    schema_version: 1,
    contract: 'curriculum_release_environment_evidence_v1',
    generated_by: 'scripts/collect-release-environment-evidence.mjs',
    observed_at: '2026-07-17T00:00:00.000Z',
    environments: { preview: environment('preview'), production: environment('production') },
  };
  return { ...value, receipt_sha256: createHash('sha256').update(stableStringify(value)).digest('hex') };
}

function desiredReceipt() {
  const value = {
    schema_version: 2,
    contract: 'curriculum_release_environment_evidence_v2',
    generated_by: 'scripts/collect-release-environment-evidence.mjs',
    observed_at: '2026-07-17T00:00:00.000Z',
    dual_schema_bootstrap_receipt: dualSchemaBootstrapReceipt,
    desired_release: desiredRelease,
    environments: {
      preview: environment('preview', desiredRelease),
      production: environment('production', desiredRelease),
    },
  };
  return { ...value, receipt_sha256: createHash('sha256').update(stableStringify(value)).digest('hex') };
}

test('release environment evidence is command, deployment, asset, and corpus bound', () => {
  const valid = receipt();
  assert.equal(validateEnvironmentEvidenceReceipt(valid), valid);
  assert.throws(() => validateEnvironmentEvidenceReceipt({
    ...valid,
    environments: { ...valid.environments, preview: { ...valid.environments.preview, corpus: null } },
  }), /hash mismatch/);
  const invalid = receipt();
  invalid.environments.preview.asset_parity.valid = false;
  assert.throws(() => validateEnvironmentEvidenceReceipt(invalid), /asset parity evidence is invalid/);
});

test('environment evidence v2 pins Worker assets, health, corpus, and artifact bytes to one desired release', () => {
  const valid = desiredReceipt();
  assert.equal(validateEnvironmentEvidenceReceipt(valid), valid);
  const drift = desiredReceipt();
  drift.environments.preview.health.release_manifest_sha256 = '9'.repeat(64);
  const { receipt_sha256: _old, ...projection } = drift;
  drift.receipt_sha256 = createHash('sha256').update(stableStringify(projection)).digest('hex');
  assert.throws(() => validateEnvironmentEvidenceReceipt(drift), /complete desired release/);
});

test('environment evidence collector cannot read a desired artifact outside the project root', async () => {
  await assert.rejects(
    collectReleaseEnvironmentEvidence({
      root: '/private/tmp/curriculum-evidence-contained-root',
      manifestPath: '../release-manifest.json',
      environment: 'preview',
    }),
    /desired release manifest must remain inside the project root/,
  );
});
