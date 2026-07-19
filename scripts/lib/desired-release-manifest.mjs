import { createHash } from 'node:crypto';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RELEASE_ID_PATTERN = /^release-[a-f0-9]{32}$/;
const CORPUS_ID_PATTERN = /^corpus-[a-f0-9]{24}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function desiredCorpusRelease(value) {
  if (!value || typeof value !== 'object') return value;
  const { generated_at: _generatedAt, ...stable } = value;
  return stable;
}

export function desiredReleaseManifest(manifest) {
  return {
    manifest_contract: 'curriculum_desired_release_v2',
    schema_version: manifest.schema_version,
    policy: manifest.policy,
    release_id: manifest.release_id,
    release_identity: manifest.release_identity,
    git: { head: manifest.git?.head || null },
    source_tree: manifest.source_tree,
    corpus_release: desiredCorpusRelease(manifest.corpus_release),
    page_evidence: manifest.release_identity?.page_evidence || manifest.page_evidence,
    data_assets: manifest.data_assets,
    graph_assets: manifest.graph_assets,
    static_assets: manifest.static_assets,
    r2: manifest.r2,
  };
}

export function desiredReleaseManifestArtifact(manifest) {
  const value = desiredReleaseManifest(manifest);
  const buffer = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  return { value, buffer, sha256: sha256(buffer), bytes: buffer.length };
}

export function desiredReleasePin(artifact) {
  const manifest = artifact?.value;
  if (!manifest || !SHA256_PATTERN.test(String(artifact.sha256 || ''))
      || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
    throw new Error('desired release pin requires a validated artifact');
  }
  return {
    release_id: manifest.release_id,
    release_manifest_sha256: artifact.sha256,
    release_manifest_bytes: artifact.bytes,
    git_head: manifest.git.head,
    source_tree_sha256: manifest.source_tree.sha256,
    corpus_release_id: manifest.corpus_release.release_id,
    corpus_manifest_sha256: manifest.corpus_release.manifest_sha256,
    corpus_envelope_sha256: manifest.corpus_release.sha256,
  };
}

export function validateDesiredReleaseManifest(value) {
  if (!value || value.manifest_contract !== 'curriculum_desired_release_v2'
      || value.schema_version !== 1 || !RELEASE_ID_PATTERN.test(String(value.release_id || ''))) {
    throw new Error('unsupported desired release manifest');
  }
  if (!GIT_COMMIT_PATTERN.test(String(value.git?.head || ''))
      || !SHA256_PATTERN.test(String(value.source_tree?.sha256 || ''))
      || !CORPUS_ID_PATTERN.test(String(value.corpus_release?.release_id || ''))
      || !SHA256_PATTERN.test(String(value.corpus_release?.manifest_sha256 || ''))
      || !SHA256_PATTERN.test(String(value.corpus_release?.sha256 || ''))) {
    throw new Error('desired release manifest identity is incomplete');
  }
  if (value.release_identity?.git?.head !== value.git.head
      || value.release_identity?.source_tree_sha256 !== value.source_tree.sha256
      || value.release_identity?.corpus_release?.release_id !== value.corpus_release.release_id
      || value.release_identity?.corpus_release?.manifest_sha256 !== value.corpus_release.manifest_sha256) {
    throw new Error('desired release manifest cross-plane identity is inconsistent');
  }
  const expectedReleaseId = `release-${sha256(Buffer.from(stableStringify(value.release_identity))).slice(0, 32)}`;
  if (value.release_id !== expectedReleaseId) {
    throw new Error('desired release manifest release_id does not match release_identity');
  }
  if (Object.hasOwn(value.corpus_release, 'generated_at')) {
    throw new Error('desired release manifest must not contain corpus generation timestamps');
  }
  if (stableStringify(value.page_evidence) !== stableStringify(value.release_identity.page_evidence)) {
    throw new Error('desired release manifest page-evidence identity is inconsistent');
  }
  if (!Array.isArray(value.r2?.objects)
      || value.r2.managed_object_count !== value.r2.objects.length
      || value.r2.release_manifest_key !== `${value.r2.release_prefix}/${value.release_id}/manifest.json`) {
    throw new Error('desired release manifest R2 identity is invalid');
  }
  const dataAssets = Array.isArray(value.data_assets) ? value.data_assets : [];
  if (dataAssets.length !== value.r2.objects.length) {
    throw new Error('desired release manifest data/R2 object counts differ');
  }
  for (let index = 0; index < dataAssets.length; index += 1) {
    const data = dataAssets[index];
    const object = value.r2.objects[index];
    for (const key of ['role', 'source', 'key', 'release_key', 'content_type', 'sha256', 'bytes']) {
      if (data?.[key] !== object?.[key]) {
        throw new Error(`desired release manifest data/R2 object mismatch at ${index}.${key}`);
      }
    }
  }
  return value;
}

export function parseDesiredReleaseManifestArtifact(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('desired release artifact must be a Buffer');
  let value;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`desired release artifact is not JSON: ${error.message}`);
  }
  validateDesiredReleaseManifest(value);
  const canonical = desiredReleaseManifestArtifact(value);
  if (!canonical.buffer.equals(buffer)) {
    throw new Error('desired release artifact bytes are not canonical');
  }
  return { ...canonical, value };
}
