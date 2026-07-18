import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const coordinatorToken = 'coordinator-test-token-20260718';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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
    for (const statement of [
      'CREATE TABLE release_publication_fence_state (id INTEGER PRIMARY KEY CHECK (id = 1), last_fence INTEGER NOT NULL CHECK (last_fence >= 0))',
      'INSERT INTO release_publication_fence_state(id,last_fence) VALUES(1,0)',
      'CREATE TABLE release_publication_ownership (id INTEGER PRIMARY KEY CHECK (id = 1), release_id TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, owner_token_sha256 TEXT NOT NULL, owner_fence INTEGER NOT NULL, expires_unix INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)',
      'CREATE TABLE release_publication_activation_claim (id INTEGER PRIMARY KEY CHECK (id = 1), release_id TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, owner_token_sha256 TEXT NOT NULL, owner_fence INTEGER NOT NULL, expires_unix INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)',
    ]) await database.prepare(statement).run();

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
    const activatedA = await activate(releaseA, tokenA, fenceA, { exists: false });
    assert.equal(activatedA.response.status, 200);
    assert.equal(activatedA.value.value.fence, 1);

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

    await database.exec('UPDATE release_publication_ownership SET expires_unix=0 WHERE id=1');
    const releaseB = releaseFixture('b');
    const tokenB = 'publication-owner-b-20260718';
    const fenceB = await acquire(releaseB, tokenB);
    assert.equal(fenceB, 2);
    await stage(releaseB, tokenB, fenceB);
    const predecessorA = await inspect();
    assert.equal(predecessorA.value.value.schema_version, 1);
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
    const releaseC = releaseFixture('c');
    const tokenC = 'publication-owner-c-20260718';
    const fenceC = await acquire(releaseC, tokenC);
    assert.equal(fenceC, 3);
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
    assert.equal(fenceD, 4);
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
