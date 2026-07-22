import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';
import { gunzip as gunzipCallback } from 'node:zlib';

import {
  A2_READONLY_COLLECTION_SPEC,
  collectA2ReadonlySnapshot,
} from '../scripts/collect-remote-ocr-a2-readonly-snapshot.mjs';
import {
  loadA2ReadonlyPreflightGateManifest,
  validateA2ReadonlyPreflightSnapshot,
} from '../scripts/validate-remote-ocr-a2-preflight.mjs';
import { canonicalJson } from '../scripts/lib/remote-ocr-local-snapshot.mjs';

const gunzip = promisify(gunzipCallback);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fixtureRoot = new URL('./fixtures/remote-ocr/a2-readonly-preflight/', import.meta.url);
const requiredCheckFields = [
  'check_id',
  'status',
  'expected',
  'actual',
  'evidence',
  'error',
];
const allowedStatuses = new Set(['pass', 'fail', 'error', 'not_applicable']);

async function readProductionFixture() {
  const fixtureManifest = JSON.parse(await readFile(new URL('fixture-manifest.json', fixtureRoot), 'utf8'));
  const compressed = await readFile(new URL(fixtureManifest.snapshot.path, fixtureRoot));
  const raw = await gunzip(compressed);
  return {
    fixtureManifest,
    compressed,
    raw,
    snapshot: JSON.parse(raw.toString('utf8')),
  };
}

test('versioned gate manifest enumerates every required A2 preflight domain', async () => {
  const { manifest } = await loadA2ReadonlyPreflightGateManifest();
  const groups = new Set(manifest.gates.map(({ group }) => group));
  for (const group of [
    'profile',
    'snapshot',
    'runtime',
    'path',
    'unit',
    'file',
    'sidecar',
    'inventory',
    'semantic',
    'forward_only',
    'receiver',
    'fixture',
    'apply_only',
  ]) {
    assert.equal(groups.has(group), true, `missing gate domain: ${group}`);
  }
  assert.equal(manifest.gates.length, 91);
  assert.deepEqual(manifest.frozen_profile.units, Object.values(A2_READONLY_COLLECTION_SPEC.units));
  assert.deepEqual(Object.keys(manifest.frozen_profile.frozen_hashes).sort(), [
    'document_log_sha256',
    'document_state_sha256',
    'document_status_sha256',
    'run_status_sha256',
  ]);
  assert.equal(manifest.frozen_profile.forward_only, true);
  assert.equal(manifest.target.citation_allowed, false);
});

test('collector attempts every bounded resource and records failures without short-circuiting', async () => {
  const calls = { directories: 0, files: 0, trees: 0, units: 0 };
  const fail = (collection) => async () => {
    calls[collection] += 1;
    throw Object.assign(new Error(`injected ${collection} failure`), { code: 'INJECTED' });
  };
  const snapshot = await collectA2ReadonlySnapshot({
    inspectPathFn: fail('directories'),
    readStableFn: fail('files'),
    inspectTreeFn: fail('trees'),
    inspectUnitFn: fail('units'),
  });
  assert.deepEqual(calls, {
    directories: Object.keys(A2_READONLY_COLLECTION_SPEC.directories).length,
    files: Object.keys(A2_READONLY_COLLECTION_SPEC.files).length,
    trees: Object.keys(A2_READONLY_COLLECTION_SPEC.trees).length,
    units: Object.keys(A2_READONLY_COLLECTION_SPEC.units).length,
  });
  assert.equal(Object.values(snapshot.directories).every(({ ok }) => ok === false), true);
  assert.equal(Object.values(snapshot.files).every(({ ok }) => ok === false), true);
  assert.equal(Object.values(snapshot.trees).every(({ ok }) => ok === false), true);
  assert.equal(Object.values(snapshot.units).every(({ ok }) => ok === false), true);
  assert.equal(snapshot.mutation_performed, false);
  assert.equal(snapshot.ocr_content_exported, false);
});

test('validator reports every declared gate with the exact non-short-circuit result schema', async () => {
  const { manifest } = await loadA2ReadonlyPreflightGateManifest();
  const report = await validateA2ReadonlyPreflightSnapshot({});
  assert.equal(report.valid, false);
  assert.equal(report.summary.declared, manifest.gates.length);
  assert.equal(report.checks.length, manifest.gates.length);
  assert.deepEqual(
    report.checks.map(({ check_id: checkId }) => checkId),
    manifest.gates.map(({ check_id: checkId }) => checkId),
  );
  for (const check of report.checks) {
    for (const field of requiredCheckFields) assert.equal(Object.hasOwn(check, field), true);
    assert.equal(allowedStatuses.has(check.status), true, check.check_id);
  }
  assert.equal(report.checks.some(({ check_id: checkId }) => checkId === 'semantics.single_authority_lineage'), true);
  assert.equal(report.checks.some(({ check_id: checkId }) => checkId === 'receiver.ready_after_continuation'), true);
  assert.equal(report.summary.error > 0, true);
});

test('production fixture is byte-bound to the real bounded metadata snapshot and canonical digest', async () => {
  const { fixtureManifest, compressed, raw, snapshot } = await readProductionFixture();
  const { manifest } = await loadA2ReadonlyPreflightGateManifest();
  assert.equal(compressed.byteLength, fixtureManifest.snapshot.compressed_bytes);
  assert.equal(sha256(compressed), fixtureManifest.snapshot.compressed_sha256);
  assert.equal(raw.byteLength, fixtureManifest.snapshot.uncompressed_bytes);
  assert.equal(sha256(raw), fixtureManifest.snapshot.uncompressed_sha256);
  const canonicalDigest = sha256(Buffer.from(canonicalJson(snapshot)));
  assert.equal(canonicalDigest, fixtureManifest.snapshot.canonical_sha256);
  assert.equal(canonicalDigest, manifest.anchors.production_snapshot_sha256);
  assert.equal(snapshot.mutation_performed, false);
  assert.equal(snapshot.ocr_content_exported, false);
});

test('production metadata fixture executes every gate with zero fail and zero error', async () => {
  const { snapshot } = await readProductionFixture();
  const report = await validateA2ReadonlyPreflightSnapshot(snapshot);
  assert.equal(report.valid, true);
  assert.deepEqual(report.summary, {
    total: 91,
    declared: 91,
    all_gates_executed: true,
    pass: 88,
    fail: 0,
    error: 0,
    not_applicable: 3,
  });
});

test('production fixture strict negatives fail independently without suppressing later gates', async () => {
  const { snapshot } = await readProductionFixture();
  const tampered = structuredClone(snapshot);
  tampered.files.document_state.value.sha256 = '0'.repeat(64);
  tampered.units.worker.value.properties.MainPID = '123';
  tampered.files.ledger_identity_sidecar = {
    ok: false,
    error: { label: 'injected', code: 'ENOENT', message: 'injected missing ledger sidecar' },
  };
  const report = await validateA2ReadonlyPreflightSnapshot(tampered);
  assert.equal(report.valid, false);
  assert.equal(report.summary.all_gates_executed, true);
  assert.equal(report.checks.length, report.summary.declared);
  assert.equal(report.checks.find(({ check_id: id }) => id === 'file.document_state').status, 'fail');
  assert.equal(report.checks.find(({ check_id: id }) => id === 'unit.worker').status, 'fail');
  assert.equal(report.checks.find(({ check_id: id }) => id === 'sidecar.ledger_identity').status, 'error');
  assert.equal(report.checks.find(({ check_id: id }) => id === 'receiver.ready_after_continuation').status, 'pass');
});
