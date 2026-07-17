import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { validateDownloadsAuditReceipt } from '../scripts/build-downloads-asset-audit-receipt.mjs';

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fixture() {
  const receipt = {
    schema_version: 1,
    contract: 'curriculum_downloads_asset_audit_v1',
    generated_by: 'scripts/build-downloads-asset-audit-receipt.mjs',
    audited_at: '2026-07-17T00:00:00.000Z',
    downloads_root_label: 'operator_downloads',
    ok: true,
    downloads_ingested: true,
    pdf_files: 15,
    relevant_files: 15,
    unique_relevant_artifacts: 12,
    relevant_artifacts: [{
      sha256: 'a'.repeat(64), size_bytes: 100, pdf_magic: true, disposition: 'canonical', ingested: true,
    }],
    project_source_pdf_files: 245,
    project_unique_source_artifacts: 240,
    project_unique_queue_pages: 11779,
    registry_sha256: 'b'.repeat(64),
    errors: 0,
    warnings: 0,
  };
  return {
    ...receipt,
    receipt_sha256: createHash('sha256').update(stableStringify(receipt)).digest('hex'),
  };
}

test('Downloads audit receipt is path-sanitized, hash-bound, and fail-closed', () => {
  const valid = fixture();
  assert.equal(validateDownloadsAuditReceipt(valid), valid);
  assert.equal(JSON.stringify(valid).includes('/Users/'), false);
  assert.throws(() => validateDownloadsAuditReceipt({ ...valid, relevant_files: 16 }), /hash mismatch/);
  const failed = { ...valid, ok: false };
  assert.throws(() => validateDownloadsAuditReceipt(failed), /not fully passing/);
});
