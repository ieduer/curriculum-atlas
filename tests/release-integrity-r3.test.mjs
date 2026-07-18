import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('release migrations reserve 0008 for ownership fences and 0009 for compendium items', async () => {
  const migrations = (await readdir(new URL('migrations/', root))).sort();
  assert.equal(migrations.includes('0008_release_ownership_fences.sql'), true);
  assert.equal(migrations.includes('0009_compendium_embedded_items.sql'), true);
  assert.equal(migrations.includes('0008_compendium_embedded_items.sql'), false);
});

test('collector generates an executable dual-schema bootstrap receipt that manifest and prepare gate verify', async () => {
  const collector = await source('scripts/collect-release-environment-evidence.mjs');
  const manifest = await source('scripts/build-release-manifest.mjs');
  const deploy = await source('scripts/deploy-worker.mjs');

  assert.match(collector, /verifyDualSchemaBootstrap/);
  assert.match(collector, /dual_schema_bootstrap_receipt/);
  assert.match(manifest, /dual_schema_bootstrap_receipt/);
  assert.match(deploy, /validateDualSchemaBootstrapReceipt/);
  assert.doesNotMatch(deploy, /target\.dual_schema_bootstrap_verified\s*!==\s*true/);
});

test('corpus import stages ready data without moving the public D1 release and activation coordinates D1 plus R2', async () => {
  const importer = await source('scripts/import-corpus.mjs');
  const coordinator = await source('src/release-coordinator.ts');

  const startSql = importer.slice(importer.indexOf('export function buildStartImportSql'), importer.indexOf('export function buildReadyImportSql'));
  assert.doesNotMatch(startSql, /current_corpus_release_id/);
  assert.match(coordinator, /activateD1CorpusRelease/);
  assert.match(coordinator, /rollbackR2Pointer/);
  assert.match(coordinator, /activation_claim/);
});

test('document, embedded-item, and comment APIs expose release-bound exhaustive pagination', async () => {
  const worker = await source('src/index.ts');
  const app = await source('public/app.js');

  assert.match(worker, /paragraph_cursor/);
  assert.match(worker, /comment_cursor/);
  assert.match(worker, /hasMore/);
  assert.match(worker, /total/);
  assert.match(app, /loadAllParagraphs/);
  assert.match(app, /loadAllComments/);
});
