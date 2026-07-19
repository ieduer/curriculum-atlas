import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const coordinatorToken = 'coordinator-test-token-20260718';
const corpusFixture = {
  releaseId: `corpus-${'d'.repeat(24)}`,
  fingerprint: 'd'.repeat(64),
  manifestSha256: 'e'.repeat(64),
  counts: {
    documents: 1,
    paragraphs: 1,
    fts_rows: 1,
    page_publication_gates: 1,
    displayed_paragraphs: 1,
    accepted_ocr_documents: 0,
    chunks: 1,
    core_table_counts: {
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
      embedded_items: 0,
    },
  },
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sqliteStatements(source) {
  const statements = [];
  let current = [];
  let trigger = false;
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('--')) continue;
    if (current.length === 0) trigger = /^CREATE TRIGGER\b/i.test(line);
    current.push(rawLine);
    if ((trigger && /^END;$/i.test(line)) || (!trigger && line.endsWith(';'))) {
      statements.push(current.join('\n'));
      current = [];
      trigger = false;
    }
  }
  assert.equal(current.length, 0, 'migration statement parser must consume every statement');
  return statements;
}

function releaseFixture(character) {
  const releaseId = `release-${character.repeat(32)}`;
  const objectBody = Buffer.from(`${JSON.stringify({ release: releaseId, value: character })}\n`);
  const object = {
    release_key: `releases/${releaseId}/quality/asset.json`,
    content_type: 'application/json',
    sha256: sha256(objectBody),
    bytes: objectBody.length,
  };
  const manifest = {
    manifest_contract: 'curriculum_desired_release_v2',
    release_id: releaseId,
    corpus_release: {
      release_id: corpusFixture.releaseId,
      release_fingerprint_sha256: corpusFixture.fingerprint,
      manifest_sha256: corpusFixture.manifestSha256,
      counts: corpusFixture.counts,
    },
    r2: {
      release_manifest_key: `releases/${releaseId}/manifest.json`,
      managed_object_count: 1,
      objects: [object],
    },
  };
  const manifestBody = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  return {
    releaseId,
    object,
    objectBody,
    manifestBody,
    manifestSha256: sha256(manifestBody),
  };
}

async function json(response) {
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`coordinator returned HTTP ${response.status}: ${text}`);
  }
  return { response, value };
}

test('Miniflare enforces immutable R2 creates, exact inventory, predecessor CAS, and monotonic D1 fences', async () => {
  const bundle = await build({
    entryPoints: [`${root}/tests/fixtures/release-coordinator-worker.ts`],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  });
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-07-15',
    bindings: { RELEASE_COORDINATOR_TOKEN: coordinatorToken },
    d1Databases: { DB: 'release-coordinator-test' },
    r2Buckets: { SOURCES: 'release-coordinator-test' },
  });
  try {
    const database = await mf.getD1Database('DB');
    const baseSchema = [
      'CREATE TABLE site_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)',
      'CREATE TABLE corpus_import_guards(guard_key TEXT PRIMARY KEY,ok INTEGER NOT NULL CHECK(ok=1))',
      `CREATE TABLE corpus_import_releases(
        release_id TEXT PRIMARY KEY,release_fingerprint_sha256 TEXT NOT NULL,manifest_sha256 TEXT NOT NULL,
        state TEXT NOT NULL,expected_documents INTEGER NOT NULL,expected_paragraphs INTEGER NOT NULL,
        expected_fts_rows INTEGER NOT NULL,expected_page_gates INTEGER NOT NULL,
        expected_displayed_paragraphs INTEGER NOT NULL,accepted_ocr_documents INTEGER NOT NULL,
        expected_chunks INTEGER NOT NULL,expected_core_counts_json TEXT NOT NULL,
        actual_documents INTEGER,actual_paragraphs INTEGER,actual_fts_rows INTEGER,actual_page_gates INTEGER,
        actual_displayed_paragraphs INTEGER,actual_chunks INTEGER,actual_core_counts_json TEXT,
        started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ready_at TEXT,failure_reason TEXT
      )`,
      `CREATE TABLE corpus_import_chunks(
        release_id TEXT NOT NULL,chunk_name TEXT NOT NULL,chunk_sha256 TEXT NOT NULL,
        chunk_bytes INTEGER NOT NULL,imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(release_id,chunk_name)
      )`,
      `CREATE TABLE documents(
        id TEXT PRIMARY KEY,title TEXT,subject TEXT,stage TEXT,document_type TEXT,version_label TEXT,
        issued_by TEXT,current_status TEXT,source_tier TEXT,access_status TEXT,source_page_url TEXT,
        source_url TEXT,file_format TEXT,redistribution TEXT,text_quality_status TEXT,
        citation_allowed INTEGER,corpus_release_id TEXT
      )`,
      `CREATE TABLE paragraphs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,document_id TEXT,ordinal INTEGER,page_number INTEGER,
        body TEXT,source_locator TEXT,body_sha256 TEXT,text_quality_status TEXT,
        citation_allowed INTEGER,display_allowed INTEGER,corpus_release_id TEXT
      )`,
      'CREATE TABLE paragraph_fts(rowid INTEGER PRIMARY KEY,body TEXT)',
      `CREATE TABLE comments(
        id TEXT PRIMARY KEY,parent_id TEXT,document_id TEXT,paragraph_id INTEGER,author_name TEXT,
        author_kind TEXT,body TEXT,status TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE page_publication_gates(
        document_id TEXT,page_number INTEGER,source_artifact_sha256 TEXT,final_text_sha256 TEXT,
        stable_locator TEXT,publication_basis TEXT,review_status TEXT,display_allowed INTEGER,
        citation_allowed INTEGER,corpus_release_id TEXT,PRIMARY KEY(document_id,page_number)
      )`,
      'CREATE TABLE subjects(id TEXT PRIMARY KEY)',
      'CREATE TABLE periods(id TEXT PRIMARY KEY)',
      'CREATE TABLE document_relations(id INTEGER PRIMARY KEY)',
      'CREATE TABLE chapters(id INTEGER PRIMARY KEY)',
      `CREATE TABLE document_classifications(
        document_id TEXT PRIMARY KEY,entity_kind TEXT,taxonomy_entity_kind TEXT,canonical_subject TEXT,
        display_facet TEXT,subject_family TEXT,scope_kind TEXT,scope_label TEXT,source_subject_label TEXT,
        decision_basis TEXT
      )`,
      `CREATE TABLE document_sources(
        id INTEGER PRIMARY KEY AUTOINCREMENT,document_id TEXT,provider TEXT,source_page_url TEXT,
        source_url TEXT,access_status TEXT,is_primary INTEGER
      )`,
      'CREATE TABLE subject_insights(id TEXT PRIMARY KEY)',
      'CREATE TABLE terms(id TEXT PRIMARY KEY)',
      'CREATE TABLE term_relations(id INTEGER PRIMARY KEY)',
      'CREATE TABLE version_diffs(id TEXT PRIMARY KEY)',
      'CREATE TABLE online_verifications(id TEXT PRIMARY KEY,corpus_release_id TEXT)',
      'CREATE TABLE online_evidence(id TEXT PRIMARY KEY,verification_id TEXT)',
    ];
    for (const statement of baseSchema) await database.prepare(statement).run();
    for (const migration of ['0008_release_ownership_fences.sql', '0009_compendium_embedded_items.sql']) {
      for (const statement of sqliteStatements(await readFile(`${root}/migrations/${migration}`, 'utf8'))) {
        await database.prepare(statement).run();
      }
    }
    for (let index = 1; index <= 5; index += 1) {
      await database.prepare('INSERT INTO periods(id) VALUES(?)').bind(`period-${index}`).run();
    }
    const coreCounts = JSON.stringify(corpusFixture.counts.core_table_counts);
    const seedSql = `INSERT INTO documents(
      id,title,subject,stage,document_type,version_label,issued_by,current_status,source_tier,
      access_status,source_page_url,source_url,file_format,redistribution,text_quality_status,
      citation_allowed,corpus_release_id
    ) VALUES('doc-a','Fixture','语文','义务教育','课程标准','fixture','教育部','current','primary_official',
      'verified_online','https://example.test/page','https://example.test/file','html','metadata_only',
      'official_native_text',1,'${corpusFixture.releaseId}');
    INSERT INTO document_classifications(
      document_id,entity_kind,taxonomy_entity_kind,canonical_subject,display_facet,
      subject_family,scope_kind,scope_label,source_subject_label,decision_basis
    ) VALUES('doc-a','subject','subject','语文','语文','语文',NULL,NULL,'语文','fixture');
    INSERT INTO document_sources(
      document_id,provider,source_page_url,source_url,access_status,is_primary
    ) VALUES('doc-a','教育部','https://example.test/page','https://example.test/file','verified_online',1);
    INSERT INTO page_publication_gates(
      document_id,page_number,source_artifact_sha256,final_text_sha256,stable_locator,
      publication_basis,review_status,display_allowed,citation_allowed,corpus_release_id
    ) VALUES('doc-a',1,'${'1'.repeat(64)}','${'2'.repeat(64)}','doc-a:page:1',
      'official_native_text','official_native_text',1,1,'${corpusFixture.releaseId}');
    INSERT INTO paragraphs(
      document_id,ordinal,page_number,body,source_locator,body_sha256,text_quality_status,
      citation_allowed,display_allowed,corpus_release_id
    ) VALUES('doc-a',1,1,'fixture body','第1页','${'3'.repeat(64)}','official_native_text',1,1,
      '${corpusFixture.releaseId}');
    INSERT INTO paragraph_fts(rowid,body) SELECT id,body FROM paragraphs WHERE document_id='doc-a';
    INSERT INTO corpus_import_releases(
      release_id,release_fingerprint_sha256,manifest_sha256,state,
      expected_documents,expected_paragraphs,expected_fts_rows,expected_page_gates,
      expected_displayed_paragraphs,accepted_ocr_documents,expected_chunks,expected_core_counts_json,
      actual_documents,actual_paragraphs,actual_fts_rows,actual_page_gates,
      actual_displayed_paragraphs,actual_chunks,actual_core_counts_json,ready_at
    ) VALUES(
      '${corpusFixture.releaseId}','${corpusFixture.fingerprint}','${corpusFixture.manifestSha256}','ready',
      1,1,1,1,1,0,1,'${coreCounts}',1,1,1,1,1,1,'${coreCounts}',CURRENT_TIMESTAMP
    );
    INSERT INTO corpus_import_chunks(release_id,chunk_name,chunk_sha256,chunk_bytes,owner_fence)
    VALUES('${corpusFixture.releaseId}','000-core.sql','${'4'.repeat(64)}',1,1);
    INSERT OR REPLACE INTO site_meta(key,value) VALUES
      ('current_corpus_release_id','${corpusFixture.releaseId}'),
      ('current_corpus_manifest_sha256','${corpusFixture.manifestSha256}'),
      ('corpus_import_state','ready'),
      ('accepted_ocr_document_count','0');`;
    for (const statement of sqliteStatements(seedSql)) await database.prepare(statement).run();

    const acquire = async (fixture, token) => {
      const state = await database.prepare('SELECT last_fence FROM release_publication_fence_state WHERE id=1').first();
      const fence = Number(state.last_fence) + 1;
      await database.batch([
        database.prepare('UPDATE release_publication_fence_state SET last_fence=? WHERE id=1').bind(fence),
        database.prepare(`INSERT INTO release_publication_ownership(
          id,release_id,manifest_sha256,owner_token_sha256,owner_fence,expires_unix
        ) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          release_id=excluded.release_id,manifest_sha256=excluded.manifest_sha256,
          owner_token_sha256=excluded.owner_token_sha256,owner_fence=excluded.owner_fence,
          expires_unix=excluded.expires_unix,updated_at=CURRENT_TIMESTAMP`).bind(
          fixture.releaseId, fixture.manifestSha256, sha256(token), fence,
          Math.floor(Date.now() / 1000) + 3600,
        ),
      ]);
      const owner = await database.prepare('SELECT owner_fence FROM release_publication_ownership WHERE id=1').first();
      return Number(owner.owner_fence);
    };
    const request = (operation, init = {}, query = {}) => {
      const url = new URL('https://coordinator.test/api/admin/release-coordinate');
      url.searchParams.set('operation', operation);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      const headers = new Headers(init.headers || {});
      headers.set('authorization', `Bearer ${coordinatorToken}`);
      return mf.dispatchFetch(url, { ...init, headers });
    };
    const create = async (fixture, token, fence, key, body, hash = sha256(body)) => json(await request('create', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.length),
        'x-content-sha256': hash,
        'x-release-id': fixture.releaseId,
        'x-release-manifest-sha256': fixture.manifestSha256,
        'x-release-owner-fence': String(fence),
        'x-release-owner-token': token,
      },
      body,
    }, { key }));
    const stage = async (fixture, token, fence) => {
      assert.equal((await create(
        fixture, token, fence, fixture.object.release_key, fixture.objectBody,
      )).response.status, 200);
      assert.equal((await create(
        fixture, token, fence, `releases/${fixture.releaseId}/manifest.json`, fixture.manifestBody,
      )).response.status, 200);
    };
    const inspect = async () => json(await request('inspect-pointer', { method: 'POST' }));
    const activate = async (fixture, token, fence, predecessor) => json(await request('activate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-release-owner-token': token,
      },
      body: JSON.stringify({
        release_id: fixture.releaseId,
        release_manifest_sha256: fixture.manifestSha256,
        release_manifest_bytes: fixture.manifestBody.length,
        managed_object_count: 1,
        owner_fence: fence,
        predecessor,
      }),
    }));

    const bucket = await mf.getR2Bucket('SOURCES');
    const legacyReleaseId = `release-${'9'.repeat(32)}`;
    const legacyManifest = Buffer.from(`${JSON.stringify({ release_id: legacyReleaseId })}\n`);
    const legacyManifestKey = `releases/${legacyReleaseId}/manifest.json`;
    await bucket.put(legacyManifestKey, legacyManifest);
    await bucket.put('release/current.json', `${JSON.stringify({
      schema_version: 1,
      release_id: legacyReleaseId,
      release_manifest_key: legacyManifestKey,
      release_manifest_sha256: sha256(legacyManifest),
      release_manifest_bytes: legacyManifest.length,
      managed_object_count: 1,
      published_at: '2026-07-17T00:00:00.000Z',
    })}\n`);

    const releaseA = releaseFixture('a');
    const tokenA = 'publication-owner-a-20260718';
    const fenceA = await acquire(releaseA, tokenA);
    assert.equal(fenceA, 1);
    await stage(releaseA, tokenA, fenceA);
    const exactRetry = await create(
      releaseA, tokenA, fenceA, releaseA.object.release_key, releaseA.objectBody,
    );
    assert.equal(exactRetry.response.status, 200);
    assert.equal(exactRetry.value.created, false);
    const collisionBody = Buffer.from('{"different":true}\n');
    const collision = await create(
      releaseA, tokenA, fenceA, releaseA.object.release_key, collisionBody,
    );
    assert.equal(collision.response.status, 409);
    const predecessorLegacy = await inspect();
    const activatedA = await activate(releaseA, tokenA, fenceA, {
      exists: true,
      etag: predecessorLegacy.value.etag,
      version: predecessorLegacy.value.version,
    });
    assert.equal(activatedA.response.status, 200);
    assert.equal(activatedA.value.value.fence, 1);

    await database.exec('UPDATE release_publication_ownership SET expires_unix=0 WHERE id=1');
    const releaseB = releaseFixture('b');
    const tokenB = 'publication-owner-b-20260718';
    const fenceB = await acquire(releaseB, tokenB);
    assert.equal(fenceB, 2);
    await stage(releaseB, tokenB, fenceB);
    const predecessorA = await inspect();
    assert.equal(predecessorA.value.value.schema_version, 2);
    const activatedB = await activate(releaseB, tokenB, fenceB, {
      exists: true,
      etag: predecessorA.value.etag,
      version: predecessorA.value.version,
    });
    assert.equal(activatedB.response.status, 200);
    assert.equal(activatedB.value.value.release_id, releaseB.releaseId);

    const staleA = await activate(releaseA, tokenA, fenceA, {
      exists: true,
      etag: activatedB.value.etag,
      version: activatedB.value.version,
    });
    assert.equal(staleA.response.status, 409);
    assert.match(staleA.value.error, /ownership|activation claim/);
    assert.equal((await inspect()).value.value.release_id, releaseB.releaseId);

    const lowerToken = 'publication-owner-lower-fence-20260718';
    await database.prepare(`UPDATE release_publication_ownership SET
      release_id=?,manifest_sha256=?,owner_token_sha256=?,owner_fence=1,expires_unix=? WHERE id=1`).bind(
      releaseB.releaseId, releaseB.manifestSha256, sha256(lowerToken), Math.floor(Date.now() / 1000) + 3600,
    ).run();
    const lowerFenceRetry = await activate(releaseB, lowerToken, 1, {
      exists: true,
      etag: activatedB.value.etag,
      version: activatedB.value.version,
    });
    assert.equal(lowerFenceRetry.response.status, 409);
    assert.match(lowerFenceRetry.value.error, /not monotonic/);

    await database.exec('UPDATE release_publication_ownership SET expires_unix=0 WHERE id=1');
    const releaseFailure = releaseFixture('e');
    const tokenFailure = 'publication-owner-failure-20260718';
    const fenceFailure = await acquire(releaseFailure, tokenFailure);
    assert.equal(fenceFailure, 3);
    const heldCreate = mf.dispatchFetch(
      'https://coordinator.test/__test/hold-create?delayMs=250',
      {
        headers: {
          'x-release-id': releaseFailure.releaseId,
          'x-release-manifest-sha256': releaseFailure.manifestSha256,
          'x-release-owner-fence': String(fenceFailure),
        },
      },
    );
    let activeCreates = 0;
    for (let attempt = 0; attempt < 100 && activeCreates !== 1; attempt += 1) {
      const prefix = await database.prepare(`SELECT active_creates
        FROM release_publication_prefix_state WHERE release_id=?`).bind(releaseFailure.releaseId).first();
      activeCreates = Number(prefix?.active_creates || 0);
      if (activeCreates !== 1) await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(activeCreates, 1, 'the delayed immutable create must hold the prefix lease');
    const racePredecessor = await inspect();
    const activationDuringCreate = await activate(releaseFailure, tokenFailure, fenceFailure, {
      exists: true,
      etag: racePredecessor.value.etag,
      version: racePredecessor.value.version,
    });
    assert.equal(activationDuringCreate.response.status, 409);
    assert.match(activationDuringCreate.value.error, /active immutable creates/);
    assert.equal((await heldCreate).status, 200);
    await stage(releaseFailure, tokenFailure, fenceFailure);
    const beforeFailure = await inspect();
    const beforeFailurePointer = await bucket.get('release/current.json');
    assert.ok(beforeFailurePointer);
    const beforeFailureBytes = Buffer.from(await beforeFailurePointer.arrayBuffer());
    await database.prepare(`CREATE TRIGGER fail_release_activation
      BEFORE UPDATE OF value ON site_meta
      WHEN OLD.key='current_release_id' AND NEW.value='${releaseFailure.releaseId}'
      BEGIN SELECT RAISE(ABORT,'fixture D1 activation failure'); END;`).run();
    const failedActivation = await activate(releaseFailure, tokenFailure, fenceFailure, {
      exists: true,
      etag: beforeFailure.value.etag,
      version: beforeFailure.value.version,
    });
    assert.equal(failedActivation.response.status, 409);
    assert.match(failedActivation.value.error, /exact predecessor restored/);
    await database.prepare('DROP TRIGGER fail_release_activation').run();
    const afterFailure = await inspect();
    const afterFailurePointer = await bucket.get('release/current.json');
    assert.ok(afterFailurePointer);
    assert.deepEqual(
      Buffer.from(await afterFailurePointer.arrayBuffer()),
      beforeFailureBytes,
      'D1 activation failure must restore the exact predecessor R2 pointer bytes',
    );
    assert.equal(afterFailure.value.value.release_id, releaseB.releaseId);
    assert.equal(afterFailure.value.value.fence, fenceB);
    const d1AfterFailure = await database.prepare(`SELECT key,value FROM site_meta WHERE key IN (
      'current_corpus_release_id','current_corpus_manifest_sha256','corpus_import_state',
      'current_release_id','current_release_manifest_key','current_release_manifest_sha256',
      'current_release_manifest_bytes','current_release_managed_object_count','current_release_fence'
    ) ORDER BY key`).all();
    const d1Values = Object.fromEntries(d1AfterFailure.results.map((row) => [row.key, row.value]));
    assert.equal(d1Values.current_release_id, releaseB.releaseId);
    assert.equal(d1Values.current_release_manifest_sha256, releaseB.manifestSha256);
    assert.equal(Number(d1Values.current_release_fence), fenceB);
    assert.equal(d1Values.current_corpus_release_id, corpusFixture.releaseId);
    assert.equal(d1Values.corpus_import_state, 'ready');
    const restoredPrefix = await database.prepare(`SELECT owner_fence,active_creates,sealed,activated
      FROM release_publication_prefix_state WHERE release_id=?`).bind(releaseB.releaseId).first();
    assert.deepEqual({
      ownerFence: Number(restoredPrefix.owner_fence),
      activeCreates: Number(restoredPrefix.active_creates),
      sealed: Number(restoredPrefix.sealed),
      activated: Number(restoredPrefix.activated),
    }, { ownerFence: fenceB, activeCreates: 0, sealed: 1, activated: 1 });

    await database.exec('UPDATE release_publication_ownership SET expires_unix=0 WHERE id=1');
    const releaseC = releaseFixture('c');
    const tokenC = 'publication-owner-c-20260718';
    const fenceC = await acquire(releaseC, tokenC);
    assert.equal(fenceC, 4);
    await stage(releaseC, tokenC, fenceC);
    await bucket.put(`releases/${releaseC.releaseId}/pollution.json`, '{}', {
      customMetadata: { sha256: sha256('{}'), bytes: '2' },
    });
    const predecessorB = await inspect();
    const polluted = await activate(releaseC, tokenC, fenceC, {
      exists: true,
      etag: predecessorB.value.etag,
      version: predecessorB.value.version,
    });
    assert.equal(polluted.response.status, 409);
    assert.match(polluted.value.error, /polluted/);
    assert.equal((await inspect()).value.value.release_id, releaseB.releaseId);

    await database.exec('UPDATE release_publication_ownership SET expires_unix=0 WHERE id=1');
    const releaseD = releaseFixture('d');
    const tokenD = 'publication-owner-d-20260718';
    const fenceD = await acquire(releaseD, tokenD);
    assert.equal(fenceD, 5);
    await bucket.put(releaseD.object.release_key, releaseD.objectBody, {
      customMetadata: { sha256: releaseD.object.sha256, bytes: String(releaseD.object.bytes) },
    });
    const missingMetadata = await create(
      releaseD, tokenD, fenceD, releaseD.object.release_key, releaseD.objectBody,
    );
    assert.equal(missingMetadata.response.status, 409);
    assert.match(missingMetadata.value.error, /immutable key collision/);
    assert.equal((await inspect()).value.value.release_id, releaseB.releaseId);

    await bucket.delete(releaseD.object.release_key);
    await bucket.put(releaseD.object.release_key, releaseD.objectBody, {
      httpMetadata: { contentType: 'text/html' },
      customMetadata: {
        release_id: releaseD.releaseId,
        manifest_sha256: releaseD.manifestSha256,
        sha256: releaseD.object.sha256,
        bytes: String(releaseD.object.bytes),
        content_type: 'text/html',
        fence: String(fenceD),
      },
    });
    const wrongContentType = await create(
      releaseD, tokenD, fenceD, releaseD.object.release_key, releaseD.objectBody,
    );
    assert.equal(wrongContentType.response.status, 409);
    assert.match(wrongContentType.value.error, /immutable key collision/);

    const observedPointer = await bucket.get('release/current.json');
    assert.ok(observedPointer);
    const concurrentBody = '{"concurrent":"newer"}\n';
    await bucket.put('release/current.json', concurrentBody);
    const staleConditionalWrite = await bucket.put('release/current.json', '{"stale":"older"}\n', {
      onlyIf: { etagMatches: observedPointer.etag },
    });
    assert.equal(staleConditionalWrite, null);
    assert.equal(await (await bucket.get('release/current.json')).text(), concurrentBody);
  } finally {
    await mf.dispose();
  }
});
