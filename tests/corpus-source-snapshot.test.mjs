import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { createCorpusSourceSnapshot } from '../scripts/lib/corpus-source-snapshot.mjs';

const trackedSources = [
  'data/catalog.json',
  'data/ingest-manifest.json',
  'data/document-sources.json',
  'data/subject-insights.json',
  'data/online-verification-samples.json',
  'data/page-publication-manifest.json',
  'data/semantic-publication-policy.json',
  'data/concept-model-v2.json',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function put(root, path, value) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, value);
}

test('one immutable corpus snapshot seals every builder input, text asset, manifest, and SQL chunk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curriculum-corpus-source-snapshot-'));
  let snapshot = null;
  try {
    for (const path of trackedSources) await put(root, path, `${JSON.stringify({ path })}\n`);
    const sql = Buffer.from('SELECT 1;\n');
    const text = Buffer.from('fixture corpus text\n');
    const manifestBody = Buffer.from('{"fixture":true}\n');
    await put(root, 'data/corpus-chunks/manifest.json', manifestBody);
    await put(root, 'data/corpus-chunks/000-core.sql', sql);
    await put(root, '.cache/text/doc-a.txt', text);
    snapshot = await createCorpusSourceSnapshot({
      root,
      manifest: {
        sql_files: [{ name: '000-core.sql', sha256: sha256(sql), bytes: sql.length }],
        text_assets: [{ document_id: 'doc-a', sha256: sha256(text), bytes: text.length }],
      },
    });
    assert.deepEqual(snapshot.tracked_source_paths, trackedSources);
    assert.deepEqual(snapshot.sql_paths, ['data/corpus-chunks/000-core.sql']);
    assert.deepEqual(snapshot.text_paths, ['.cache/text/doc-a.txt']);
    await snapshot.verify();

    await put(root, 'data/catalog.json', '{"mutated":true}\n');
    await put(root, 'data/corpus-chunks/000-core.sql', 'SELECT evil;\n');
    assert.match(await readFile(join(snapshot.root, 'data/catalog.json'), 'utf8'), /data\/catalog\.json/);
    assert.equal(await readFile(join(snapshot.root, 'data/corpus-chunks/000-core.sql'), 'utf8'), 'SELECT 1;\n');
    await snapshot.verify();
  } finally {
    await snapshot?.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
