import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const ACADEMIC_GRAPH_SHARD_MAX_BYTES = 512 * 1024;
export const ACADEMIC_GRAPH_SHARD_TRANSPORT = 'immutable-content-addressed-academic-graph-shards-v1';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ARRAY_COLLECTIONS = [
  'subject_taxonomy', 'subject_entity_audit', 'subject_facets', 'concepts', 'concept_senses',
  'surface_forms', 'curriculum_lines', 'works', 'editions', 'revisions', 'embedded_items',
  'text_reuse_clusters', 'occurrences', 'episodes', 'relations', 'relation_reviews', 'edges',
  'evidence', 'coverage_cells', 'editorial_audit', 'ontology_scopes', 'ontology_nodes',
  'ontology_relations', 'ontology_evidence',
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const safeKey = (value) => String(value || 'collection')
  .normalize('NFKC')
  .replace(/[^\p{Letter}\p{Number}._-]+/gu, '-')
  .replace(/^-+|-+$/g, '') || 'collection';

function payloadFor(buildRevision, collection, chunkIndex, items) {
  return {
    schema_version: 1,
    artifact_profile: 'curriculum-academic-graph-shard-v1',
    transport_profile: ACADEMIC_GRAPH_SHARD_TRANSPORT,
    build_revision: buildRevision,
    descriptor_id: `academic:${safeKey(collection)}:${chunkIndex}`,
    collection,
    chunk_index: chunkIndex,
    count: items.length,
    items,
  };
}

function packCollection(buildRevision, collection, items) {
  if (!items.length) return [];
  const chunks = [];
  let current = [];
  for (const item of items) {
    const candidate = [...current, item];
    if (jsonBytes(payloadFor(buildRevision, collection, chunks.length + 1, candidate)).byteLength
      <= ACADEMIC_GRAPH_SHARD_MAX_BYTES) {
      current = candidate;
      continue;
    }
    if (!current.length) throw new Error(`${collection} contains an item larger than the academic graph shard cap`);
    chunks.push(current);
    current = [item];
  }
  if (current.length) chunks.push(current);
  return chunks.map((chunk, index) => {
    const payload = payloadFor(buildRevision, collection, index + 1, chunk);
    const bytes = jsonBytes(payload);
    const digest = sha256(bytes);
    const relativePath = `academic/${safeKey(collection)}/${safeKey(payload.descriptor_id)}-${digest.slice(0, 24)}.json`;
    return {
      relativePath,
      bytes,
      descriptor: {
        id: payload.descriptor_id,
        collection,
        chunk_index: index + 1,
        path: `/data/graph-shards/${relativePath}`,
        bytes: bytes.byteLength,
        sha256: digest,
        count: chunk.length,
        build_revision: buildRevision,
      },
    };
  });
}

export function createAcademicGraphShardBundle(graph) {
  if (!graph?.build_revision) throw new Error('academic graph build revision is required');
  const assets = [];
  for (const collection of ARRAY_COLLECTIONS) {
    if (!Array.isArray(graph[collection])) throw new Error(`academic graph collection is missing: ${collection}`);
    assets.push(...packCollection(graph.build_revision, collection, graph[collection]));
  }
  const metadata = Object.fromEntries(Object.entries(graph)
    .filter(([key]) => !ARRAY_COLLECTIONS.includes(key)));
  const index = {
    ...metadata,
    artifact_profile: 'curriculum-concept-evolution-academic-index-v1',
    transport_profile: ACADEMIC_GRAPH_SHARD_TRANSPORT,
    materialized_artifact_profile: graph.artifact_profile,
    shard_manifest: {
      schema_version: 1,
      transport_profile: ACADEMIC_GRAPH_SHARD_TRANSPORT,
      build_revision: graph.build_revision,
      max_shard_bytes: ACADEMIC_GRAPH_SHARD_MAX_BYTES,
      logical_counts: Object.fromEntries(ARRAY_COLLECTIONS.map((collection) => [
        collection,
        graph[collection].length,
      ])),
      assets: assets.map((asset) => asset.descriptor),
    },
  };
  const indexBytes = jsonBytes(index);
  if (indexBytes.byteLength > ACADEMIC_GRAPH_SHARD_MAX_BYTES) {
    throw new Error(`academic graph index exceeds shard cap: ${indexBytes.byteLength}`);
  }
  return {
    index,
    indexBytes,
    indexSha256: sha256(indexBytes),
    assets,
    totalShardBytes: assets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0),
  };
}

export async function writeAcademicGraphShardBundle(bundle, academicOutputPath) {
  const shardDirectory = path.join(path.dirname(academicOutputPath), 'graph-shards');
  const staging = `${shardDirectory}.staging-${process.pid}`;
  const backup = `${shardDirectory}.backup-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  for (const asset of bundle.assets) {
    const target = path.join(staging, asset.relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, asset.bytes);
  }
  let hadCurrent = false;
  try {
    await rename(shardDirectory, backup);
    hadCurrent = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await rename(staging, shardDirectory);
    if (hadCurrent) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (hadCurrent) await rename(backup, shardDirectory).catch(() => {});
    throw error;
  }
  const temporary = `${academicOutputPath}.${process.pid}.tmp`;
  await writeFile(temporary, bundle.indexBytes);
  await rename(temporary, academicOutputPath);
}

function resolveShardPath(publicRoot, descriptorPath) {
  if (!descriptorPath.startsWith('/data/graph-shards/') || descriptorPath.includes('..')) {
    throw new Error(`invalid academic graph shard path: ${descriptorPath}`);
  }
  const root = path.resolve(publicRoot);
  const resolved = path.resolve(root, descriptorPath.slice(1));
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('academic graph shard path escapes public root');
  return resolved;
}

export async function readVerifiedAcademicGraphShard(index, descriptor, publicRoot) {
  if (index?.transport_profile !== ACADEMIC_GRAPH_SHARD_TRANSPORT
    || descriptor?.build_revision !== index?.build_revision
    || !SHA256_PATTERN.test(descriptor?.sha256 || '')
    || !Number.isInteger(descriptor?.bytes)
    || descriptor.bytes < 1
    || descriptor.bytes > ACADEMIC_GRAPH_SHARD_MAX_BYTES) {
    throw new Error(`invalid academic graph shard descriptor: ${descriptor?.id || 'unknown'}`);
  }
  const bytes = await readFile(resolveShardPath(publicRoot, descriptor.path));
  if (bytes.byteLength !== descriptor.bytes || sha256(bytes) !== descriptor.sha256) {
    throw new Error(`academic graph shard integrity drift: ${descriptor.id}`);
  }
  const payload = JSON.parse(bytes.toString('utf8'));
  if (payload.build_revision !== index.build_revision
    || payload.descriptor_id !== descriptor.id
    || payload.collection !== descriptor.collection
    || payload.chunk_index !== descriptor.chunk_index
    || payload.count !== descriptor.count
    || !Array.isArray(payload.items)
    || payload.items.length !== descriptor.count) {
    throw new Error(`academic graph shard metadata drift: ${descriptor.id}`);
  }
  return payload;
}

export async function verifyAcademicGraphIndex(index, publicRoot) {
  const manifest = index?.shard_manifest;
  if (index?.artifact_profile !== 'curriculum-concept-evolution-academic-index-v1'
    || index?.transport_profile !== ACADEMIC_GRAPH_SHARD_TRANSPORT
    || manifest?.transport_profile !== ACADEMIC_GRAPH_SHARD_TRANSPORT
    || manifest?.build_revision !== index?.build_revision
    || manifest?.max_shard_bytes !== ACADEMIC_GRAPH_SHARD_MAX_BYTES
    || !Array.isArray(manifest?.assets)) {
    throw new Error('academic graph shard manifest is invalid');
  }
  const ids = new Set();
  const paths = new Set();
  const counts = Object.fromEntries(ARRAY_COLLECTIONS.map((collection) => [collection, 0]));
  for (const descriptor of manifest.assets) {
    if (ids.has(descriptor.id) || paths.has(descriptor.path) || !(descriptor.collection in counts)) {
      throw new Error(`duplicate or unknown academic graph shard descriptor: ${descriptor.id}`);
    }
    ids.add(descriptor.id);
    paths.add(descriptor.path);
    await readVerifiedAcademicGraphShard(index, descriptor, publicRoot);
    counts[descriptor.collection] += descriptor.count;
  }
  if (JSON.stringify(counts) !== JSON.stringify(manifest.logical_counts)) {
    throw new Error('academic graph shard logical counts drift');
  }
  return {
    shard_count: manifest.assets.length,
    total_shard_bytes: manifest.assets.reduce((sum, descriptor) => sum + descriptor.bytes, 0),
    maximum_shard_bytes: Math.max(0, ...manifest.assets.map((descriptor) => descriptor.bytes)),
  };
}

export async function materializeAcademicGraph(index, publicRoot) {
  if (index?.artifact_profile !== 'curriculum-concept-evolution-academic-index-v1') return index;
  await verifyAcademicGraphIndex(index, publicRoot);
  const graph = { ...index };
  delete graph.shard_manifest;
  delete graph.transport_profile;
  graph.artifact_profile = graph.materialized_artifact_profile;
  delete graph.materialized_artifact_profile;
  for (const collection of ARRAY_COLLECTIONS) graph[collection] = [];
  const descriptors = [...index.shard_manifest.assets].sort((left, right) =>
    ARRAY_COLLECTIONS.indexOf(left.collection) - ARRAY_COLLECTIONS.indexOf(right.collection)
    || left.chunk_index - right.chunk_index);
  for (const descriptor of descriptors) {
    const payload = await readVerifiedAcademicGraphShard(index, descriptor, publicRoot);
    graph[descriptor.collection].push(...payload.items);
  }
  return graph;
}
