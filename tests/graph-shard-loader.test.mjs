import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  GRAPH_SHARD_MAX_BYTES,
  GRAPH_SHARD_TRANSPORT,
  GraphShardStore,
} from '../public/graph-loader.js';

const revision = 'a'.repeat(64);
const path = '/data/graph-shards/details/fixture.json';
const payload = {
  schema_version: 1,
  artifact_profile: 'curriculum-graph-shard-v1',
  transport_profile: GRAPH_SHARD_TRANSPORT,
  build_revision: revision,
  descriptor_id: 'episode_detail:fixture:1',
  kind: 'episode_detail',
  filters: { facet: '语文', era: '2022-present', item_id: null, collection: 'fixture', chunk_index: 1 },
  counts: { episodes: 1, evidence: 1 },
  data: {
    episodes: [{ id: 'episode:1', evidence_ids: ['evidence:1'] }],
    evidence: [{ id: 'evidence:1' }],
  },
};
const bytes = Buffer.from(`${JSON.stringify(payload)}\n`);
const descriptor = {
  id: payload.descriptor_id,
  kind: payload.kind,
  path,
  bytes: bytes.byteLength,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  counts: payload.counts,
  build_revision: revision,
  filters: payload.filters,
};

function index(overrides = {}) {
  return {
    schema_version: 1,
    artifact_profile: 'curriculum-concept-evolution-core-index-v1',
    transport_profile: GRAPH_SHARD_TRANSPORT,
    build_revision: revision,
    episodes: [{ id: 'episode:1', detail_shard_ids: [descriptor.id], visibility_facets: ['语文'] }],
    edges: [],
    shard_manifest: {
      schema_version: 1,
      transport_profile: GRAPH_SHARD_TRANSPORT,
      build_revision: revision,
      max_shard_bytes: GRAPH_SHARD_MAX_BYTES,
      assets: [descriptor],
    },
    ...overrides,
  };
}

test('compact index performs no detail fetch until one episode is selected', async () => {
  let fetches = 0;
  const store = new GraphShardStore(index(), {
    fetchImpl: async () => { fetches += 1; return new Response(bytes); },
  });
  assert.equal(fetches, 0);
  const result = await store.loadEpisode(index().episodes[0], '语文');
  assert.equal(fetches, 1);
  assert.equal(result.episode.id, 'episode:1');
  assert.equal(result.evidence[0].id, 'evidence:1');
  await store.loadEpisode(index().episodes[0], '语文');
  assert.equal(fetches, 1, 'verified immutable shard should be reused');
});

test('stale cache entries never mix build revisions', async () => {
  let fetches = 0;
  const cache = new Map([[`${revision}:${path}`, {
    buildRevision: 'b'.repeat(64),
    sha256: descriptor.sha256,
    payload: { data: { episodes: [{ id: 'forged' }], evidence: [] } },
  }]]);
  const store = new GraphShardStore(index(), {
    cache,
    fetchImpl: async () => { fetches += 1; return new Response(bytes); },
  });
  const result = await store.loadEpisode(index().episodes[0], '语文');
  assert.equal(fetches, 1);
  assert.equal(result.episode.id, 'episode:1');
});

test('missing, hash-drifted, and cross-endpoint shards fail closed', async () => {
  const missing = new GraphShardStore(index(), { fetchImpl: async () => new Response('', { status: 404 }) });
  await assert.rejects(() => missing.loadEpisode(index().episodes[0], '语文'), /读取失败/);
  const drifted = new GraphShardStore(index(), { fetchImpl: async () => new Response('forged') });
  await assert.rejects(() => drifted.loadEpisode(index().episodes[0], '语文'), /完整性校验失败/);
  assert.throws(() => new GraphShardStore(index({
    edges: [{ id: 'edge:bad', source: 'episode:1', target: 'episode:missing' }],
  })), /关系端点缺失/);
  assert.throws(() => new GraphShardStore(index({
    episodes: [{ ...index().episodes[0], detail_shard_ids: ['episode_detail:missing'] }],
  })), /节点分片引用无效/);
  assert.throws(() => new GraphShardStore(index({
    shard_manifest: {
      ...index().shard_manifest,
      assets: [descriptor, { ...descriptor, id: 'episode_detail:duplicate-path' }],
    },
  })), /分片描述无效/);
});
