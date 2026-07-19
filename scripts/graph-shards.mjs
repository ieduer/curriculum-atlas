import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const GRAPH_SHARD_MAX_BYTES = 512 * 1024;
export const GRAPH_SHARD_TRANSPORT = 'immutable-content-addressed-graph-shards-v1';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ACADEMIC_ARRAY_COLLECTIONS = [
  'subject_taxonomy', 'subject_entity_audit', 'subject_facets', 'concepts', 'concept_senses',
  'surface_forms', 'curriculum_lines', 'works', 'editions', 'revisions', 'embedded_items',
  'text_reuse_clusters', 'occurrences', 'episodes', 'relations', 'relation_reviews', 'edges',
  'evidence', 'coverage_cells', 'editorial_audit', 'ontology_scopes', 'ontology_nodes',
  'ontology_relations', 'ontology_evidence',
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);

function eraForYear(year) {
  const value = Number(year);
  if (value <= 1949) return '1902-1949';
  if (value <= 1977) return '1950-1977';
  if (value <= 2000) return '1978-2000';
  if (value <= 2010) return '2001-2010';
  if (value <= 2021) return '2011-2021';
  return '2022-present';
}

function safeKey(value) {
  return String(value || 'global').normalize('NFKC').replace(/[^\p{Letter}\p{Number}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'global';
}

function countsForData(data) {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Array.isArray(value) ? value.length : 0]));
}

function makePayload({ buildRevision, id, kind, filters = null, data }) {
  return {
    schema_version: 1,
    artifact_profile: 'curriculum-graph-shard-v1',
    transport_profile: GRAPH_SHARD_TRANSPORT,
    build_revision: buildRevision,
    descriptor_id: id,
    kind,
    filters,
    counts: countsForData(data),
    data,
  };
}

function assetFromPayload(relativeDirectory, payload) {
  const bytes = jsonBytes(payload);
  if (bytes.byteLength > GRAPH_SHARD_MAX_BYTES) {
    throw new Error(`${payload.descriptor_id} exceeds ${GRAPH_SHARD_MAX_BYTES} bytes`);
  }
  const digest = sha256(bytes);
  const filename = `${safeKey(payload.descriptor_id)}-${digest.slice(0, 24)}.json`;
  const relativePath = `${relativeDirectory}/${filename}`;
  return {
    relativePath,
    bytes,
    descriptor: {
      id: payload.descriptor_id,
      kind: payload.kind,
      path: `/data/graph-shards/${relativePath}`,
      bytes: bytes.byteLength,
      sha256: digest,
      counts: payload.counts,
      build_revision: payload.build_revision,
      filters: payload.filters,
    },
  };
}

function packItems({ buildRevision, kind, collection, items, relativeDirectory, filters = null, dataForItems = (chunk) => ({ items: chunk }) }) {
  if (!items.length) return [];
  const chunks = [];
  let current = [];
  for (const item of items) {
    const candidate = [...current, item];
    const candidatePayload = makePayload({
      buildRevision,
      id: `${kind}:${safeKey(collection)}:${chunks.length + 1}`,
      kind,
      filters: { ...filters, collection, chunk_index: chunks.length + 1 },
      data: dataForItems(candidate),
    });
    if (jsonBytes(candidatePayload).byteLength <= GRAPH_SHARD_MAX_BYTES) {
      current = candidate;
      continue;
    }
    if (!current.length) throw new Error(`${kind}:${collection} contains an item larger than the shard cap`);
    chunks.push(current);
    current = [item];
  }
  if (current.length) chunks.push(current);
  return chunks.map((chunk, index) => assetFromPayload(relativeDirectory, makePayload({
    buildRevision,
    id: `${kind}:${safeKey(collection)}:${index + 1}`,
    kind,
    filters: { ...filters, collection, chunk_index: index + 1 },
    data: dataForItems(chunk),
  })));
}

function coreEpisodeStub(episode, detailShardIds) {
  return {
    id: episode.id,
    concept_id: episode.concept_id,
    label: episode.label,
    ...(episode.aliases?.length ? { aliases: episode.aliases } : {}),
    category: episode.category,
    ontology_node_id: episode.ontology_node_id,
    curriculum_line: { id: episode.curriculum_line?.id, stage: episode.curriculum_line?.stage },
    time: { year: episode.time?.year },
    subject: {
      canonical: episode.subject?.canonical,
      source_label: episode.subject?.source_label,
      entity_kind: episode.subject?.entity_kind,
      facet_eligible: episode.subject?.facet_eligible,
      facet: episode.subject?.facet,
    },
    ...(episode.scope_entity ? { scope_entity: {
      canonical: episode.scope_entity.canonical,
      label: episode.scope_entity.label,
      entity_kind: episode.scope_entity.entity_kind,
    } } : {}),
    ...(episode.course_entity ? { course_entity: {
      canonical: episode.course_entity.canonical,
      entity_kind: episode.course_entity.entity_kind,
    } } : {}),
    visibility_facets: episode.visibility_facets,
    visibility_policy: episode.visibility_policy,
    observation: {
      status: episode.observation?.status,
      visual_strength: episode.observation?.visual_strength,
    },
    claim_policy: { display_level: episode.claim_policy?.display_level },
    ...(episode.embedded_item_id ? { embedded_item_id: episode.embedded_item_id } : {}),
    detail_shard_ids: detailShardIds,
  };
}

function buildAcademicAssets(academicGraph) {
  const assets = [];
  for (const collection of ACADEMIC_ARRAY_COLLECTIONS) {
    const items = academicGraph[collection];
    if (!Array.isArray(items)) throw new Error(`academic graph collection is missing: ${collection}`);
    assets.push(...packItems({
      buildRevision: academicGraph.build_revision,
      kind: 'academic_collection',
      collection,
      items,
      relativeDirectory: `academic/${safeKey(collection)}`,
    }));
  }
  return assets;
}

function buildCoreDetailAssets(coreGraph) {
  const episodeByGroup = new Map();
  const groupIdsByEpisode = new Map();
  for (const episode of coreGraph.episodes) {
    const facets = episode.visibility_facets?.length ? episode.visibility_facets : ['global'];
    const era = eraForYear(episode.time?.year);
    const groups = facets.map((facet) => ({ id: `facet:${facet}:era:${era}`, facet, era, item_id: null }));
    if (episode.embedded_item_id) groups.push({
      id: `item:${episode.embedded_item_id}`,
      facet: facets.length === 1 ? facets[0] : null,
      era,
      item_id: episode.embedded_item_id,
    });
    groupIdsByEpisode.set(episode.id, groups.map((group) => group.id));
    for (const group of groups) {
      if (!episodeByGroup.has(group.id)) episodeByGroup.set(group.id, { ...group, episodes: [] });
      episodeByGroup.get(group.id).episodes.push(episode);
    }
  }
  const evidenceById = new Map(coreGraph.evidence.map((item) => [item.id, item]));
  const assets = [];
  for (const group of [...episodeByGroup.values()].sort((left, right) => left.id.localeCompare(right.id, 'en'))) {
    assets.push(...packItems({
      buildRevision: coreGraph.build_revision,
      kind: 'episode_detail',
      collection: group.id,
      items: group.episodes,
      relativeDirectory: `details/${safeKey(group.id)}`,
      filters: { facet: group.facet, era: group.era, item_id: group.item_id },
      dataForItems: (episodes) => {
        const evidenceIds = new Set(episodes.flatMap((episode) => episode.evidence_ids || []));
        return { episodes, evidence: [...evidenceIds].map((id) => evidenceById.get(id)).filter(Boolean) };
      },
    }));
  }

  for (const facet of [...new Set(coreGraph.ontology_scopes.map((scope) => scope.subject_facet))].sort()) {
    const scopes = coreGraph.ontology_scopes.filter((scope) => scope.subject_facet === facet);
    const scopeIds = new Set(scopes.map((scope) => scope.id));
    const nodes = coreGraph.ontology_nodes.filter((node) => scopeIds.has(node.scope_id));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const relations = coreGraph.ontology_relations.filter((relation) => nodeIds.has(relation.source) && nodeIds.has(relation.target));
    const evidenceIds = new Set([
      ...nodes.flatMap((node) => node.evidence_anchor_ids || []),
      ...relations.flatMap((relation) => relation.evidence_anchor_ids || []),
    ]);
    const data = {
      ontology_scopes: scopes,
      ontology_nodes: nodes,
      ontology_relations: relations,
      ontology_evidence: coreGraph.ontology_evidence.filter((entry) => evidenceIds.has(entry.id)),
    };
    const payload = makePayload({
      buildRevision: coreGraph.build_revision,
      id: `ontology:${facet}`,
      kind: 'ontology_detail',
      filters: { facet, scope_ids: [...scopeIds], collection: 'ontology', chunk_index: 1 },
      data,
    });
    assets.push(assetFromPayload(`ontology/${safeKey(facet)}`, payload));
  }
  const descriptorIdsByGroup = new Map();
  for (const asset of assets.filter((entry) => entry.descriptor.kind === 'episode_detail')) {
    const groupId = asset.descriptor.filters.collection;
    if (!descriptorIdsByGroup.has(groupId)) descriptorIdsByGroup.set(groupId, []);
    descriptorIdsByGroup.get(groupId).push(asset.descriptor.id);
  }
  const detailShardIdsByEpisode = new Map([...groupIdsByEpisode].map(([episodeId, groupIds]) => [
    episodeId,
    [...new Set(groupIds.flatMap((groupId) => descriptorIdsByGroup.get(groupId) || []))],
  ]));
  return { assets, detailShardIdsByEpisode };
}

function manifestFor(buildRevision, assets) {
  return {
    schema_version: 1,
    transport_profile: GRAPH_SHARD_TRANSPORT,
    build_revision: buildRevision,
    max_shard_bytes: GRAPH_SHARD_MAX_BYTES,
    assets: assets.map((asset) => asset.descriptor),
  };
}

async function replaceShardDirectory(directory, assets) {
  const staging = `${directory}.staging-${process.pid}`;
  const backup = `${directory}.backup-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  for (const asset of assets) {
    const target = path.join(staging, asset.relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, asset.bytes);
  }
  let hadCurrent = false;
  try {
    await rename(directory, backup);
    hadCurrent = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await rename(staging, directory);
    if (hadCurrent) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (hadCurrent) await rename(backup, directory).catch(() => {});
    throw error;
  }
}

export async function writeGraphShardBundle({ coreGraph, academicGraph, coreOutputPath, academicOutputPath }) {
  if (!coreGraph?.build_revision || coreGraph.build_revision !== academicGraph?.build_revision) {
    throw new Error('core and academic build revisions must match');
  }
  const academicAssets = buildAcademicAssets(academicGraph);
  const academicMetadata = Object.fromEntries(Object.entries(academicGraph)
    .filter(([key]) => !ACADEMIC_ARRAY_COLLECTIONS.includes(key)));
  const academicIndex = {
    ...academicMetadata,
    artifact_profile: 'curriculum-concept-evolution-academic-index-v1',
    transport_profile: GRAPH_SHARD_TRANSPORT,
    shard_manifest: manifestFor(academicGraph.build_revision, academicAssets),
  };
  const academicIndexBytes = jsonBytes(academicIndex);
  if (academicIndexBytes.byteLength > GRAPH_SHARD_MAX_BYTES) throw new Error('academic graph index exceeds shard cap');

  const { assets: coreAssets, detailShardIdsByEpisode } = buildCoreDetailAssets(coreGraph);
  const academicIndexSha256 = sha256(academicIndexBytes);
  const coreIndex = {
    ...coreGraph,
    artifact_profile: 'curriculum-concept-evolution-core-index-v1',
    transport_profile: GRAPH_SHARD_TRANSPORT,
    academic_model_ref: {
      ...coreGraph.academic_model_ref,
      path: `/data/${path.basename(academicOutputPath)}`,
      sha256: academicIndexSha256,
      bytes: academicIndexBytes.byteLength,
      transport_profile: GRAPH_SHARD_TRANSPORT,
    },
    episodes: coreGraph.episodes.map((episode) => coreEpisodeStub(episode, detailShardIdsByEpisode.get(episode.id) || [])),
    edges: coreGraph.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: edge.type, mode: edge.mode })),
    concepts: [],
    course_families: {},
    course_to_subject_links: {},
    evidence: [],
    ontology_scopes: [],
    ontology_nodes: [],
    ontology_relations: [],
    ontology_evidence: [],
    shard_manifest: manifestFor(coreGraph.build_revision, coreAssets),
  };
  const coreIndexBytes = jsonBytes(coreIndex);
  if (coreIndexBytes.byteLength > GRAPH_SHARD_MAX_BYTES) throw new Error(`core graph index exceeds shard cap: ${coreIndexBytes.byteLength}`);

  const shardDirectory = path.join(path.dirname(coreOutputPath), 'graph-shards');
  await replaceShardDirectory(shardDirectory, [...academicAssets, ...coreAssets]);
  await Promise.all([
    writeFile(`${coreOutputPath}.${process.pid}.tmp`, coreIndexBytes),
    writeFile(`${academicOutputPath}.${process.pid}.tmp`, academicIndexBytes),
  ]);
  await Promise.all([
    rename(`${coreOutputPath}.${process.pid}.tmp`, coreOutputPath),
    rename(`${academicOutputPath}.${process.pid}.tmp`, academicOutputPath),
  ]);
  return {
    coreIndex,
    academicIndex,
    coreIndexBytes,
    academicIndexBytes,
    shardAssets: [...academicAssets, ...coreAssets].map((asset) => asset.descriptor),
  };
}

function resolveShardPath(publicRoot, descriptorPath) {
  if (!descriptorPath.startsWith('/data/graph-shards/') || descriptorPath.includes('..')) {
    throw new Error(`invalid graph shard path: ${descriptorPath}`);
  }
  const resolved = path.resolve(publicRoot, descriptorPath.slice(1));
  if (!resolved.startsWith(`${path.resolve(publicRoot)}${path.sep}`)) throw new Error('graph shard path escapes public root');
  return resolved;
}

export async function readVerifiedGraphShard(index, descriptor, publicRoot) {
  if (index?.transport_profile !== GRAPH_SHARD_TRANSPORT
    || index?.shard_manifest?.build_revision !== index?.build_revision
    || descriptor?.build_revision !== index?.build_revision
    || !SHA256_PATTERN.test(descriptor?.sha256 || '')
    || !Number.isInteger(descriptor?.bytes) || descriptor.bytes < 1 || descriptor.bytes > GRAPH_SHARD_MAX_BYTES) {
    throw new Error(`invalid graph shard descriptor: ${descriptor?.id || 'unknown'}`);
  }
  const bytes = await readFile(resolveShardPath(publicRoot, descriptor.path));
  if (bytes.byteLength !== descriptor.bytes || sha256(bytes) !== descriptor.sha256) {
    throw new Error(`graph shard integrity drift: ${descriptor.id}`);
  }
  const payload = JSON.parse(bytes.toString('utf8'));
  if (payload.build_revision !== index.build_revision || payload.descriptor_id !== descriptor.id
    || payload.kind !== descriptor.kind || JSON.stringify(payload.counts) !== JSON.stringify(descriptor.counts)) {
    throw new Error(`graph shard metadata drift: ${descriptor.id}`);
  }
  for (const [collection, count] of Object.entries(descriptor.counts)) {
    if (!Array.isArray(payload.data?.[collection]) || payload.data[collection].length !== count) {
      throw new Error(`graph shard count drift: ${descriptor.id}:${collection}`);
    }
  }
  return payload;
}

export async function materializeAcademicGraph(index, publicRoot) {
  if (index?.artifact_profile !== 'curriculum-concept-evolution-academic-index-v1') return index;
  const graph = { ...index };
  delete graph.shard_manifest;
  delete graph.transport_profile;
  graph.artifact_profile = 'curriculum-concept-evolution-academic-v2';
  for (const collection of ACADEMIC_ARRAY_COLLECTIONS) graph[collection] = [];
  const descriptors = [...index.shard_manifest.assets]
    .filter((descriptor) => descriptor.kind === 'academic_collection')
    .sort((left, right) => left.filters.collection.localeCompare(right.filters.collection, 'en')
      || left.filters.chunk_index - right.filters.chunk_index);
  for (const descriptor of descriptors) {
    const payload = await readVerifiedGraphShard(index, descriptor, publicRoot);
    graph[descriptor.filters.collection].push(...payload.data.items);
  }
  return graph;
}

export async function verifyGraphIndexShards(index, publicRoot) {
  if (index?.transport_profile !== GRAPH_SHARD_TRANSPORT
    || index?.shard_manifest?.transport_profile !== GRAPH_SHARD_TRANSPORT
    || index.shard_manifest.build_revision !== index.build_revision
    || index.shard_manifest.max_shard_bytes !== GRAPH_SHARD_MAX_BYTES) {
    throw new Error('graph shard manifest is invalid');
  }
  const ids = new Set();
  const paths = new Set();
  const kindById = new Map();
  for (const descriptor of index.shard_manifest.assets) {
    if (ids.has(descriptor.id) || paths.has(descriptor.path)) {
      throw new Error(`duplicate graph shard descriptor or path: ${descriptor.id}`);
    }
    ids.add(descriptor.id);
    paths.add(descriptor.path);
    kindById.set(descriptor.id, descriptor.kind);
    await readVerifiedGraphShard(index, descriptor, publicRoot);
  }
  if (Array.isArray(index.episodes) && Array.isArray(index.edges)) {
    const episodeIds = new Set(index.episodes.map((episode) => episode.id));
    for (const edge of index.edges) {
      if (!episodeIds.has(edge.source) || !episodeIds.has(edge.target)) throw new Error(`cross-shard edge endpoint missing: ${edge.id}`);
    }
    for (const episode of index.episodes) {
      if (!episode.detail_shard_ids?.length
        || new Set(episode.detail_shard_ids).size !== episode.detail_shard_ids.length
        || episode.detail_shard_ids.some((id) => kindById.get(id) !== 'episode_detail')) {
        throw new Error(`episode detail shard is unresolved: ${episode.id}`);
      }
    }
  }
  return true;
}
