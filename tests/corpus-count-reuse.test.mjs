import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const source=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');
const full=source.match(/async function currentCorpusRelease[\s\S]*?prepare\(`([\s\S]*?)`\)/)[1];
const pointer=source.match(/async function currentCorpusPointer[\s\S]*?prepare\(`([\s\S]*?)`\)/)[1];
const sha='a'.repeat(64);
const identity=(row)=>JSON.stringify(Object.entries(row).filter(([key])=>!key.startsWith('live_')).sort(([a],[b])=>(a<b?-1:a>b?1:0)));
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 for(const file of ['0001_initial.sql','0002_source_provenance_and_ocr_quality.sql','0003_online_verification.sql','0004_document_classifications.sql','0005_page_publication_gate.sql','0006_corpus_import_release.sql','0007_document_taxonomy_contract.sql'])db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 db.prepare(`INSERT INTO corpus_import_releases(release_id,release_fingerprint_sha256,manifest_sha256,state,expected_documents,expected_paragraphs,expected_fts_rows,expected_page_gates,expected_displayed_paragraphs,accepted_ocr_documents,expected_chunks,expected_core_counts_json) VALUES('current',?,?,'ready',1,1,1,1,1,0,0,'{}')`).run(sha,sha);
 db.prepare(`INSERT INTO corpus_import_releases(release_id,release_fingerprint_sha256,manifest_sha256,state,expected_documents,expected_paragraphs,expected_fts_rows,expected_page_gates,expected_displayed_paragraphs,accepted_ocr_documents,expected_chunks,expected_core_counts_json) VALUES('next',?,?,'in_progress',1,1,1,1,1,0,0,'{}')`).run('b'.repeat(64),'b'.repeat(64));
 for(const [k,v] of [['current_corpus_release_id','current'],['current_corpus_manifest_sha256',sha],['corpus_import_state','ready']])db.prepare('INSERT OR REPLACE INTO site_meta(key,value) VALUES(?,?)').run(k,v);
 return db;
}
test('the pointer lookup returns exactly the release row that the full count reports',t=>{
 const db=fixture(t);
 const p=db.prepare(pointer).all(),f=db.prepare(full).all();
 assert.equal(p.length,1);assert.equal(f.length,1);
 assert.equal(identity(p[0]),identity(f[0]));
 assert.deepEqual(Object.keys(f[0]).filter(k=>!Object.hasOwn(p[0],k)).sort(),['live_accepted_ocr_documents','live_chunks','live_core_counts_json','live_displayed_paragraphs','live_documents','live_fts_rows','live_page_gates','live_paragraphs']);
 assert.ok(Object.keys(p[0]).every(k=>!k.startsWith('live_')));
});
for(const [name,change] of [
 ['missing current release',"DELETE FROM site_meta WHERE key='current_corpus_release_id'"],
 ['switched to an in-progress release',"UPDATE site_meta SET value='next' WHERE key='current_corpus_release_id'"],
 ['wrong manifest',"UPDATE site_meta SET value='wrong' WHERE key='current_corpus_manifest_sha256'"],
 ['wrong state',"UPDATE site_meta SET value='in_progress' WHERE key='corpus_import_state'"],
])test(`${name}: the pointer lookup finds no ready release, so reads fail closed without reuse`,t=>{
 const db=fixture(t);db.exec(change);
 assert.equal(db.prepare(pointer).all().length,0);
});
for(const [name,change] of [
 ['recorded actual counts',"UPDATE corpus_import_releases SET actual_documents=1 WHERE release_id='current'"],
 ['release timestamps',"UPDATE corpus_import_releases SET ready_at='2026-10-26T00:00:00Z' WHERE release_id='current'"],
 ['switched release',"UPDATE corpus_import_releases SET state='ready' WHERE release_id='next'; UPDATE site_meta SET value='next' WHERE key='current_corpus_release_id'; UPDATE site_meta SET value='"+'b'.repeat(64)+"' WHERE key='current_corpus_manifest_sha256'"],
])test(`${name}: any change to the active release row changes the pointer identity`,t=>{
 const db=fixture(t);const before=identity(db.prepare(pointer).get());
 db.exec(change);const row=db.prepare(pointer).get();
 assert.ok(row);assert.notEqual(identity(row),before);
});
test('the pointer lookup reads only the release row, not the corpus tables',()=>{
 for(const table of ['paragraphs','paragraph_fts','page_publication_gates','documents','corpus_import_chunks'])assert.doesNotMatch(pointer,new RegExp(`\\b${table}\\b`));
 assert.match(source,/rememberCorpusCounts\(corpus, countedAt\)/);
 assert.match(source,/const corpus = await corpusForReads\(env\);/);
});
