import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createImmutableTreeSnapshot } from './immutable-release-snapshot.mjs';

const TRACKED_CORPUS_SOURCES = [
  'data/catalog.json',
  'data/ingest-manifest.json',
  'data/document-sources.json',
  'data/subject-insights.json',
  'data/online-verification-samples.json',
  'data/page-publication-manifest.json',
  'data/semantic-publication-policy.json',
  'data/concept-model-v2.json',
];

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function inspect(root, path) {
  const buffer = await readFile(resolve(root, path));
  return { path, sha256: sha256(buffer), bytes: buffer.length };
}

export async function createCorpusSourceSnapshot({ root, manifest } = {}) {
  if (!manifest || !Array.isArray(manifest.sql_files) || !Array.isArray(manifest.text_assets)) {
    throw new Error('corpus source snapshot requires a validated manifest');
  }
  const expectedSql = manifest.sql_files.map((entry) => entry.name);
  const actualSql = (await readdir(resolve(root, 'data/corpus-chunks')))
    .filter((name) => /^\d{3}-(?:core|paragraphs)\.sql$/.test(name)).sort();
  if (JSON.stringify(expectedSql) !== JSON.stringify(actualSql)) {
    throw new Error('corpus source snapshot SQL set differs from manifest');
  }
  const files = [];
  for (const path of TRACKED_CORPUS_SOURCES) files.push(await inspect(root, path));
  files.push(await inspect(root, 'data/corpus-chunks/manifest.json'));
  for (const entry of manifest.sql_files) {
    files.push({ path: `data/corpus-chunks/${entry.name}`, sha256: entry.sha256, bytes: entry.bytes });
  }
  for (const entry of manifest.text_assets) {
    files.push({ path: `.cache/text/${entry.document_id}.txt`, sha256: entry.sha256, bytes: entry.bytes });
  }
  const snapshot = await createImmutableTreeSnapshot({
    root,
    files,
    label: 'complete corpus source and SQL snapshot',
  });
  return {
    ...snapshot,
    manifest_path: 'data/corpus-chunks/manifest.json',
    sql_paths: manifest.sql_files.map((entry) => `data/corpus-chunks/${entry.name}`),
    text_paths: manifest.text_assets.map((entry) => `.cache/text/${entry.document_id}.txt`),
    tracked_source_paths: TRACKED_CORPUS_SOURCES,
  };
}
