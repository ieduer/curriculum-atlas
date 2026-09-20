import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/retrieval.ts', import.meta.url))], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
const { retrieve } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE documents(id TEXT PRIMARY KEY,title TEXT,version_label TEXT,source_url TEXT,stage TEXT,sort_year INTEGER,citation_allowed INTEGER);
    CREATE TABLE document_classifications(document_id TEXT PRIMARY KEY,entity_kind TEXT,taxonomy_entity_kind TEXT,display_facet TEXT,canonical_subject TEXT,scope_label TEXT,source_subject_label TEXT,subject_family TEXT,scope_kind TEXT);
    CREATE TABLE paragraphs(id INTEGER PRIMARY KEY,document_id TEXT,page_number INTEGER,source_locator TEXT,body TEXT,ordinal INTEGER,citation_allowed INTEGER);
    CREATE VIRTUAL TABLE paragraph_fts USING fts5(body,heading,document_id UNINDEXED,paragraph_id UNINDEXED,tokenize='trigram');`);
  for (const [id, subject, kind, stage, year, allowed] of [
    ['new', '语文', 'subject', '高中', 2022, 1], ['old', '历史与社会', 'subject', '初中', 2001, 1],
    ['scope', '语文', 'scope', '高中', 2022, 1], ['hidden', '语文', 'subject', '高中', 2024, 0],
  ]) {
    db.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?)').run(id, id, String(year), 'https://example.test/source', stage, year, allowed);
    db.prepare('INSERT INTO document_classifications VALUES(?,?,?,?,?,?,?,?,?)').run(id, kind, kind, subject, subject, null, subject, subject, null);
  }
  let id = 0;
  for (const doc of ['new', 'old', 'scope', 'hidden']) {
    for (const [body, allowed] of [['课程核心素养；课程。评价；ABCDef；école；100%和a_b及a\\b；😀😀😀。', 1], ['课程核心素养；课程。评价；ABCDef。', 0]]) {
      id++;
      db.prepare('INSERT INTO paragraphs VALUES(?,?,?,?,?,?,?)').run(id, doc, id, `p${id}`, body, id, allowed);
      db.prepare('INSERT INTO paragraph_fts(rowid,body,heading,document_id,paragraph_id) VALUES(?,?,?,?,?)').run(id, body, '', doc, id);
    }
  }
  return db;
}

test('indexed fallback has identical rows, ordering and citation/taxonomy/stage restrictions', async () => {
  const db = fixture();
  try {
    for (const query of ['核心素养', '课程。评价', 'bCd', 'école', '不存在文本', '课程', '100%', 'a_b', 'a\\b', '😀😀😀', '😀😀', 'a\0b']) {
      for (const filters of [{}, { subject: '语文' }, { subject: '历史' }, { stage: '初中' }, { subject: '数学', stage: '高中' }]) {
        let usedIndexed = false;
        const env = { DB: { prepare(sql) { return { bind(...params) { return { async all() {
          // Force the fallback branch; MATCH behavior is covered separately.
          if (sql.includes(' MATCH ?')) return { results: [] };
          usedIndexed = sql.includes('paragraph_fts.body LIKE ?');
          const originalSql = sql.replace('paragraph_fts JOIN paragraphs p ON p.id = paragraph_fts.paragraph_id', 'paragraphs p')
            .replace('paragraph_fts.body LIKE ?', "p.body LIKE ? ESCAPE '\\'");
          const before = db.prepare(originalSql).all(...params);
          const after = db.prepare(sql).all(...params);
          assert.deepEqual(after, before, JSON.stringify({ query, filters }));
          assert.ok(after.every((row) => row.document_id !== 'hidden' && row.id % 2 === 1));
          if (usedIndexed) {
            assert.ok(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).some((p) => /VIRTUAL TABLE INDEX.*L0/.test(p.detail)));
          }
          return { results: after };
        } }; } }; } } };
        await retrieve(env, { query, ...filters, limit: 2 });
        assert.equal(usedIndexed, [...query].length >= 3 && !/[\\%_\u0000]/u.test(query));
      }
    }
  } finally { db.close(); }
});

test('successful MATCH never executes fallback and retains its original rank and limits', async () => {
  const db = fixture();
  let calls = 0;
  try {
    const env = { DB: { prepare(sql) { calls++; assert.match(sql, /paragraph_fts MATCH \?/);
      return { bind(...params) { return { async all() { return { results: db.prepare(sql).all(...params) }; } }; } };
    } } };
    const result = await retrieve(env, { query: '核心素养', subject: '语文', limit: 1 });
    assert.equal(calls, 1); assert.equal(result.length, 1); assert.equal(result[0].document_id, 'new');
  } finally { db.close(); }
});
