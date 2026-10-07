import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const source=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');
const candidate=source.match(/async function currentCorpusRelease[\s\S]*?prepare\(`([\s\S]*?)`\)/)[1];
const before=readFileSync(new URL('./fixtures/corpus-counts-before.sql',import.meta.url),'utf8');
const sha='a'.repeat(64);
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 for(const file of ['0001_initial.sql','0002_source_provenance_and_ocr_quality.sql','0003_online_verification.sql','0004_document_classifications.sql','0005_page_publication_gate.sql','0006_corpus_import_release.sql','0007_document_taxonomy_contract.sql'])db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 db.prepare(`INSERT INTO corpus_import_releases(release_id,release_fingerprint_sha256,manifest_sha256,state,expected_documents,expected_paragraphs,expected_fts_rows,expected_page_gates,expected_displayed_paragraphs,accepted_ocr_documents,expected_chunks,expected_core_counts_json) VALUES('current',?,?,'ready',2,3,4,3,1,1,0,'{}')`).run(sha,sha);
 for(const [k,v] of [['current_corpus_release_id','current'],['current_corpus_manifest_sha256',sha],['corpus_import_state','ready']])db.prepare('INSERT OR REPLACE INTO site_meta(key,value) VALUES(?,?)').run(k,v);
 const columns=['id','title','subject','stage','document_type','version_label','issued_by','current_status','source_tier','access_status','source_page_url','source_url','file_format','redistribution'];
 for(const [id,release] of [['a','current'],['b','current'],['other','other-release'],['unscoped',null]]){
  db.prepare(`INSERT INTO documents(${columns.join(',')},corpus_release_id) VALUES(${columns.map(()=>'?').join(',')},?)`).run(...columns.map(k=>k==='id'?id:'synthetic'),release);
 }
 for(const [doc,ordinal,shown,release] of [['a',1,1,'current'],['a',2,0,'current'],['b',1,0,'current'],['other',1,1,'other-release']])db.prepare('INSERT INTO paragraphs(document_id,ordinal,body,source_locator,body_sha256,display_allowed,corpus_release_id) VALUES(?,?,?,?,?,?,?)').run(doc,ordinal,'synthetic text','fixture',sha,shown,release);
 for(const [doc,page,basis,release] of [['a',1,'accepted_ocr_page_manifest','current'],['a',2,'accepted_ocr_page_manifest','current'],['b',1,'official_native_text','current'],['other',1,'accepted_ocr_page_manifest','other-release']])db.prepare('INSERT INTO page_publication_gates(document_id,page_number,source_artifact_sha256,final_text_sha256,stable_locator,publication_basis,review_status,corpus_release_id) VALUES(?,?,?,?,?,?,?,?)').run(doc,page,sha,sha,'fixture',basis,'accepted',release);
 return {db,check(){const old=db.prepare(before).all(),now=db.prepare(candidate).all();assert.deepEqual(now,old);return now[0]}};
}
test('same complete result with hidden paragraphs, duplicate OCR pages and other releases',t=>{const f=fixture(t),r=f.check();assert.equal(r.live_paragraphs,3);assert.equal(r.live_displayed_paragraphs,1);assert.equal(r.live_page_gates,3);assert.equal(r.live_accepted_ocr_documents,1);assert.equal(r.live_fts_rows,4)});
for(const [name,change] of [
 ['missing paragraph',"DELETE FROM paragraphs WHERE document_id='a' AND ordinal=1"],
 ['display eligibility change',"UPDATE paragraphs SET display_allowed=1 WHERE document_id='b'"],
 ['missing page gate',"DELETE FROM page_publication_gates WHERE document_id='a'"],
 ['empty current paragraphs',"DELETE FROM paragraphs WHERE corpus_release_id='current'"],
 ['empty current gates',"DELETE FROM page_publication_gates WHERE corpus_release_id='current'"],
 ['unscoped and noncurrent rows',"UPDATE paragraphs SET corpus_release_id=NULL WHERE document_id='a'"],
 ['missing current release',"DELETE FROM site_meta WHERE key='current_corpus_release_id'"],
 ['wrong manifest',"UPDATE site_meta SET value='wrong' WHERE key='current_corpus_manifest_sha256'"],
 ['wrong state',"UPDATE site_meta SET value='in_progress' WHERE key='corpus_import_state'"],
 ['FTS-only drift',"INSERT INTO paragraph_fts(body,heading,document_id,paragraph_id) VALUES('drift','','other',999)"],
])test(`${name} remains immediately observable without cached acceptance`,t=>{const f=fixture(t);f.check();f.db.exec(change);f.check()});
test('missing required table remains an error, caught by the existing fail-closed runtime',t=>{const f=fixture(t);f.db.exec('DROP TABLE term_relations');assert.throws(()=>f.db.prepare(before).all());assert.throws(()=>f.db.prepare(candidate).all());assert.match(source,/catch \{\s+return null;\s+\}\s+\}\s+\nasync function requireCorpusReady/)});
