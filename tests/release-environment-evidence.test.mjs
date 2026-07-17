import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { validateEnvironmentEvidenceReceipt } from '../scripts/collect-release-environment-evidence.mjs';

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function environment(name) {
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
  };
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
      method: 'five_live_assets_byte_equal_git_commit',
      assets: ['app.js', 'atlas.js', 'styles.css', 'data/concept-evolution.json', 'data/concept-evolution-academic.json']
        .map((path) => ({ path, sha256: 'b'.repeat(64), bytes: 1 })),
    },
    applied_migrations: ['0001_initial.sql'],
    pending_migrations: [],
    r2_release_reader: 'versioned_manifest_v1',
    health: { url: 'https://example.test/api/health', http_status: 200, ok: true, version: 'v9', release_git_commit: 'a'.repeat(40), body_sha256: 'c'.repeat(64), bytes: 1 },
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
