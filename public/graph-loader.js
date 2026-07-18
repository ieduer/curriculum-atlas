export const GRAPH_SHARD_TRANSPORT = 'immutable-content-addressed-graph-shards-v1';
export const GRAPH_SHARD_MAX_BYTES = 512 * 1024;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validDescriptor(index, descriptor) {
  return descriptor
    && typeof descriptor.id === 'string'
    && typeof descriptor.path === 'string'
    && descriptor.path.startsWith('/data/graph-shards/')
    && !descriptor.path.includes('..')
    && descriptor.build_revision === index.build_revision
    && SHA256_PATTERN.test(descriptor.sha256 || '')
    && Number.isInteger(descriptor.bytes)
    && descriptor.bytes > 0
    && descriptor.bytes <= GRAPH_SHARD_MAX_BYTES
    && descriptor.counts && typeof descriptor.counts === 'object';
}

export class GraphShardStore {
  constructor(index, { fetchImpl = fetch, cache = new Map() } = {}) {
    if (!index || index.transport_profile !== GRAPH_SHARD_TRANSPORT
      || index.shard_manifest?.transport_profile !== GRAPH_SHARD_TRANSPORT
      || index.shard_manifest?.build_revision !== index.build_revision
      || index.shard_manifest?.max_shard_bytes !== GRAPH_SHARD_MAX_BYTES
      || !Array.isArray(index.shard_manifest?.assets)) {
      throw new Error('星图分片索引未通过结构校验');
    }
    this.index = index;
    this.fetchImpl = fetchImpl;
    this.cache = cache;
    this.descriptorById = new Map();
    const descriptorPaths = new Set();
    for (const descriptor of index.shard_manifest.assets) {
      if (!validDescriptor(index, descriptor)
        || this.descriptorById.has(descriptor.id)
        || descriptorPaths.has(descriptor.path)) {
        throw new Error(`星图分片描述无效：${descriptor?.id || 'unknown'}`);
      }
      this.descriptorById.set(descriptor.id, descriptor);
      descriptorPaths.add(descriptor.path);
    }
    for (const episode of index.episodes || []) {
      const detailIds = episode.detail_shard_ids;
      if (!Array.isArray(detailIds)
        || detailIds.length === 0
        || new Set(detailIds).size !== detailIds.length
        || detailIds.some((id) => this.descriptorById.get(id)?.kind !== 'episode_detail')) {
        throw new Error(`星图节点分片引用无效：${episode.id}`);
      }
    }
    const episodeIds = new Set((index.episodes || []).map((episode) => episode.id));
    for (const edge of index.edges || []) {
      if (!episodeIds.has(edge.source) || !episodeIds.has(edge.target)) {
        throw new Error(`星图跨分片关系端点缺失：${edge.id}`);
      }
    }
  }

  async loadDescriptor(id) {
    const descriptor = this.descriptorById.get(id);
    if (!descriptor) throw new Error(`星图分片未登记：${id}`);
    const cacheKey = `${this.index.build_revision}:${descriptor.path}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      if (cached.buildRevision === this.index.build_revision && cached.sha256 === descriptor.sha256) return cached.payload;
      this.cache.delete(cacheKey);
    }
    const response = await this.fetchImpl(descriptor.path, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`星图分片读取失败：${descriptor.id}`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== descriptor.bytes || await sha256Hex(bytes) !== descriptor.sha256) {
      throw new Error(`星图分片完整性校验失败：${descriptor.id}`);
    }
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error(`星图分片不是有效 JSON：${descriptor.id}`);
    }
    if (payload.build_revision !== this.index.build_revision
      || payload.descriptor_id !== descriptor.id
      || payload.kind !== descriptor.kind
      || JSON.stringify(payload.counts) !== JSON.stringify(descriptor.counts)) {
      throw new Error(`星图分片版本或計數漂移：${descriptor.id}`);
    }
    for (const [collection, count] of Object.entries(descriptor.counts)) {
      if (!Array.isArray(payload.data?.[collection]) || payload.data[collection].length !== count) {
        throw new Error(`星图分片集合計數漂移：${descriptor.id}/${collection}`);
      }
    }
    this.cache.set(cacheKey, {
      buildRevision: this.index.build_revision,
      sha256: descriptor.sha256,
      payload,
    });
    return payload;
  }

  async loadEpisode(stub, facet = null) {
    const ids = (stub?.detail_shard_ids || []).filter((id) => {
      const descriptor = this.descriptorById.get(id);
      return descriptor?.kind === 'episode_detail'
        && (!facet || descriptor.filters?.facet === facet || descriptor.filters?.item_id === stub.embedded_item_id);
    });
    if (!ids.length) throw new Error('该概念节点没有当前范围的证据分片');
    for (const id of ids) {
      const payload = await this.loadDescriptor(id);
      const episode = payload.data.episodes.find((candidate) => candidate.id === stub.id);
      if (episode) return { episode, evidence: payload.data.evidence || [] };
    }
    throw new Error('该概念节点在已核分片中缺少完整记录');
  }

  async loadOntologyFacet(facet) {
    const descriptors = [...this.descriptorById.values()].filter(
      (descriptor) => descriptor.kind === 'ontology_detail' && descriptor.filters?.facet === facet,
    );
    if (descriptors.length !== 1) throw new Error(`${facet || '当前学科'}的深层概念分片尚未达到发布门槛`);
    return (await this.loadDescriptor(descriptors[0].id)).data;
  }
}
