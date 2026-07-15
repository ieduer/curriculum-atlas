import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const builder = await readFile(new URL('scripts/build-corpus.mjs', root), 'utf8');
const coreSql = await readFile(new URL('data/corpus-chunks/000-core.sql', root), 'utf8');
const firstParagraphChunk = await readFile(new URL('data/corpus-chunks/001-paragraphs.sql', root), 'utf8');

test('document imports update in place and preserve dependent records', () => {
  assert.doesNotMatch(builder, /INSERT OR REPLACE INTO documents/);
  assert.match(coreSql, /ON CONFLICT\(id\) DO UPDATE SET/);
});

test('paragraph imports preserve row ids used by comments and verification links', () => {
  assert.doesNotMatch(builder, /INSERT OR (?:IGNORE|REPLACE) INTO paragraphs/);
  assert.match(firstParagraphChunk, /ON CONFLICT\(document_id,ordinal\) DO UPDATE SET/);
});
