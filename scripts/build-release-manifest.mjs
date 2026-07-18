#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { auditProjectAssets } from './audit-project-assets.mjs';
import { validateDownloadsAuditReceipt } from './build-downloads-asset-audit-receipt.mjs';
import { validateEnvironmentEvidenceReceipt } from './collect-release-environment-evidence.mjs';
import {
  validateCorpusManifest,
  validateCorpusManifestSourceBindings,
} from './import-corpus.mjs';
import { validatePageEvidenceForRelease } from './page-evidence-release-hook.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_POLICY = 'data/release-assets-policy.json';

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

function normalizeRelativePath(input, name = 'path') {
  const value = String(input || '').replaceAll('\\', '/');
  if (!value || isAbsolute(value) || value === '..' || value.startsWith('../') || value.includes('/../')) {
    throw new Error(`${name} must be a non-empty project-relative path: ${input}`);
  }
  return value.replace(/^\.\//, '').replace(/\/+/g, '/');
}

function projectPath(root, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const absolute = resolve(root, normalized);
  const relativeToRoot = relative(root, absolute);
  if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${sep}`) || isAbsolute(relativeToRoot)) {
    throw new Error(`path escapes project root: ${relativePath}`);
  }
  return absolute;
}

async function walkFiles(root, relativeRoot) {
  const normalizedRoot = normalizeRelativePath(relativeRoot, 'source tree root');
  const output = [];

  async function visit(relativeDirectory) {
    const entries = await readdir(projectPath(root, relativeDirectory), { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const child = `${relativeDirectory}/${entry.name}`.replace(/\/+/g, '/');
      if (entry.isSymbolicLink()) throw new Error(`release source tree may not contain symlinks: ${child}`);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) output.push(child);
      else throw new Error(`unsupported release source tree entry: ${child}`);
    }
  }

  const rootStat = await stat(projectPath(root, normalizedRoot));
  if (!rootStat.isDirectory()) throw new Error(`source tree root is not a directory: ${normalizedRoot}`);
  await visit(normalizedRoot);
  return output;
}

function contentTypeFor(relativePath) {
  const extension = extname(relativePath).toLowerCase();
  return ({
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
  })[extension] || 'application/octet-stream';
}

async function inspectFile(root, relativePath) {
  const source = normalizeRelativePath(relativePath, 'asset source');
  const buffer = await readFile(projectPath(root, source));
  return {
    source,
    sha256: sha256(buffer),
    bytes: buffer.byteLength,
    content_type: contentTypeFor(source),
    buffer,
  };
}

function parseJsonAsset(asset) {
  try {
    return JSON.parse(asset.buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`invalid JSON in ${asset.source}: ${error.message}`);
  }
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function collectionLength(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

function sum(values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

function countBy(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = String(selector(item) ?? 'unknown');
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right, 'en')));
}

function countAsset(role, value) {
  switch (role) {
    case 'artifact_registry':
      return {
        artifacts: arrayLength(value.artifacts),
        source_archive_containers: arrayLength(value.source_archive_containers),
        document_aliases: arrayLength(value.document_aliases),
        source_roots: arrayLength(value.source_roots),
        expected_counts: value.expected_counts || null,
      };
    case 'catalog': {
      const documents = Array.isArray(value.documents) ? value.documents : [];
      return {
        documents: documents.length,
        unique_document_ids: new Set(documents.map((item) => item.id)).size,
        citation_ready: documents.filter((item) => item.citation_allowed === true).length,
        by_text_quality_status: countBy(documents, (item) => item.text_quality_status),
        declared: value.counts || null,
      };
    }
    case 'ingest_manifest': {
      const entries = Array.isArray(value.entries) ? value.entries : [];
      return {
        entries: entries.length,
        unique_document_ids: new Set(entries.map((item) => item.id)).size,
        fetched: entries.filter((item) => item.fetched === true).length,
        source_bytes: sum(entries.map((item) => item.source_bytes)),
        text_bytes: sum(entries.map((item) => item.text_bytes)),
      };
    }
    case 'ocr_queue': {
      const documents = Array.isArray(value.documents) ? value.documents : [];
      return {
        documents: documents.length,
        unique_document_ids: new Set(documents.map((item) => item.id)).size,
        pages: sum(documents.map((item) => item.page_count)),
        blocked: arrayLength(value.blocked),
        by_priority: countBy(documents, (item) => item.priority),
        declared: value.counts || null,
      };
    }
    case 'page_publication_manifest': {
      const documents = Array.isArray(value.documents) ? value.documents : [];
      const pages = documents.flatMap((item) => Array.isArray(item.pages) ? item.pages : []);
      return {
        documents: documents.length,
        pages: pages.length,
        display_allowed_pages: pages.filter((item) => item.display_allowed === true).length,
        citation_allowed_pages: pages.filter((item) => item.citation_allowed === true).length,
      };
    }
    case 'semantic_publication_policy': {
      const controls = Array.isArray(value.page_controls) ? value.page_controls : [];
      return {
        quality_profiles: value.quality_profiles && typeof value.quality_profiles === 'object'
          ? Object.keys(value.quality_profiles).length : 0,
        document_aliases: arrayLength(value.document_aliases),
        page_controls: controls.length,
        unresolved_page_controls: controls.filter((item) => String(item.status || '').startsWith('unresolved')).length,
      };
    }
    case 'online_verification_standard':
      return {
        gates: collectionLength(value.gates),
        verification_statuses: arrayLength(value.verification_statuses),
        edition_match_statuses: arrayLength(value.edition_match_statuses),
      };
    case 'online_verification_validation':
      return {
        valid: value.valid === true,
        results: arrayLength(value.results),
        failed_results: (value.results || []).filter((item) => item.valid !== true).length,
      };
    case 'online_verification_samples':
      return { samples: arrayLength(value.samples) };
    case 'online_verification_r6_foreign_language_map':
      return {
        documents: arrayLength(value.documents),
        rules: collectionLength(value.rules),
        scope_document_ids: arrayLength(value.scope_document_ids),
      };
    case 'online_verification_zh_compulsory_2022_claims':
      return {
        claims: arrayLength(value.claims),
        sources: arrayLength(value.sources),
        transcription_conflicts: arrayLength(value.transcription_conflicts),
      };
    case 'release_assets_policy':
      return {
        r2_objects: arrayLength(value.r2?.objects),
        source_tree_roots: arrayLength(value.source_tree?.roots),
        environments: ['local', 'preview', 'production'].filter((key) => value.environment_snapshot?.[key]).length,
      };
    default:
      return {
        schema_version: value?.schema_version ?? null,
        top_level_keys: value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : 0,
      };
  }
}

function graphCounts(value) {
  const keys = [
    'concepts', 'concept_senses', 'surface_forms', 'curriculum_lines', 'works', 'editions',
    'revisions', 'embedded_items', 'occurrences', 'episodes', 'edges', 'relations', 'evidence',
    'coverage_cells', 'ontology_nodes', 'ontology_relations', 'ontology_evidence',
  ];
  return Object.fromEntries(keys.filter((key) => Array.isArray(value[key])).map((key) => [key, value[key].length]));
}

function assertUniqueIds(items, label) {
  const ids = items.map((item) => String(item?.id || ''));
  if (ids.some((id) => !id)) throw new Error(`${label} contains an empty id`);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate ids`);
  return new Set(ids);
}

function assertExactSet(expected, actual, label) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = [...expectedSet].filter((item) => !actualSet.has(item)).sort();
  const extra = [...actualSet].filter((item) => !expectedSet.has(item)).sort();
  if (missing.length || extra.length) {
    throw new Error(`${label} mismatch; missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`);
  }
}

export function compareManagedKeySets(expectedKeys, actualKeys) {
  const expected = new Set(expectedKeys);
  const actual = new Set(actualKeys);
  return {
    missing: [...expected].filter((key) => !actual.has(key)).sort(),
    extra: [...actual].filter((key) => !expected.has(key)).sort(),
  };
}

export function assertBufferParity(expected, actualBuffer, label) {
  const actual = {
    sha256: sha256(actualBuffer),
    bytes: actualBuffer.byteLength,
  };
  if (expected.sha256 !== actual.sha256 || expected.bytes !== actual.bytes) {
    throw new Error(`${label} parity failure: expected sha256=${expected.sha256} bytes=${expected.bytes}; actual sha256=${actual.sha256} bytes=${actual.bytes}`);
  }
  return actual;
}

function gitValue(root, arguments_, { optional = false } = {}) {
  const result = spawnSync('git', arguments_, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    if (optional) return null;
    throw new Error(`git ${arguments_.join(' ')} failed: ${(result.stderr || '').trim()}`);
  }
  return result.stdout.trim();
}

export function assertGitCommitExists(root, value, label = 'Git commit') {
  const commit = String(value || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`${label} must be an exact 40-character Git commit SHA: ${value || '<unset>'}`);
  }
  const result = spawnSync('git', ['cat-file', '-t', commit], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0 || result.stdout.trim() !== 'commit') {
    throw new Error(`${label} does not exist as a commit in this repository: ${commit}`);
  }
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (ancestor.status !== 0) throw new Error(`${label} is not an ancestor of the current Git HEAD: ${commit}`);
  return commit;
}

async function buildSourceTree(root, policy) {
  const trackedFiles = gitValue(root, ['ls-files', '-z']).split('\0').filter(Boolean)
    .map((file) => normalizeRelativePath(file, 'tracked source file'));
  const trackedSet = new Set(trackedFiles);
  const roots = (policy.source_tree?.roots || []).map((directory) => normalizeRelativePath(directory, 'source tree root'));
  const configuredFiles = (policy.source_tree?.files || []).map((file) => normalizeRelativePath(file, 'source tree file'));
  for (const file of configuredFiles) {
    if (!trackedSet.has(file)) throw new Error(`configured source tree file is not tracked in Git: ${file}`);
  }
  const excluded = new Set((policy.source_tree?.excluded_paths || []).map((item) => normalizeRelativePath(item, 'excluded path')));
  const uniqueFiles = trackedFiles.filter((file) =>
    (configuredFiles.includes(file) || roots.some((directory) => file.startsWith(`${directory}/`)))
    && !excluded.has(file)).sort();
  const inventory = [];
  for (const file of uniqueFiles) {
    const inspected = await inspectFile(root, file);
    inventory.push({ path: file, sha256: inspected.sha256, bytes: inspected.bytes });
  }
  const digestInput = inventory.map((item) => `${item.path}\0${item.sha256}\0${item.bytes}\n`).join('');
  return {
    tracked_only: true,
    git_index_file_count: trackedFiles.length,
    sha256: sha256(Buffer.from(digestInput)),
    file_count: inventory.length,
    total_bytes: sum(inventory.map((item) => item.bytes)),
    files: inventory,
  };
}

async function validateR2PolicyCoverage(root, policy) {
  if (!Array.isArray(policy.r2?.objects) || policy.r2.objects.length === 0) {
    throw new Error('release policy must define at least one r2 object');
  }

  const roles = [];
  const sources = [];
  const keys = [];
  for (const object of policy.r2.objects) {
    roles.push(String(object.role || ''));
    sources.push(normalizeRelativePath(object.source, 'r2 object source'));
    const key = normalizeRelativePath(object.key, 'r2 object key');
    keys.push(key);
    if (!object.role) throw new Error(`r2 object ${object.source} is missing role`);
    if (!object.content_type) throw new Error(`r2 object ${object.source} is missing content_type`);
  }
  for (const [values, label] of [[roles, 'r2 roles'], [sources, 'r2 sources'], [keys, 'r2 keys']]) {
    if (new Set(values).size !== values.length) throw new Error(`${label} contain duplicates`);
  }
  const currentPointerKey = normalizeRelativePath(policy.r2.current_pointer_key, 'r2 current pointer key');
  normalizeRelativePath(policy.r2.release_prefix, 'r2 release prefix');
  if (keys.includes(currentPointerKey)) throw new Error('r2 current_pointer_key must not collide with a managed object key');

  const dataFiles = await walkFiles(root, 'data');
  const governedFiles = new Set((policy.r2.governed_source_files || []).map((item) => normalizeRelativePath(item, 'governed source file')));
  const governedPrefixes = (policy.r2.governed_source_prefixes || []).map((item) => normalizeRelativePath(item, 'governed source prefix'));
  const discovered = dataFiles.filter((file) => governedFiles.has(file) || governedPrefixes.some((prefix) => file.startsWith(prefix)));
  assertExactSet(discovered, sources, 'governed R2 source coverage');

  return policy.r2.objects.map((object) => ({
    ...object,
    source: normalizeRelativePath(object.source),
    key: normalizeRelativePath(object.key),
  }));
}

async function inspectCorpusRelease(root) {
  const manifestAsset = await inspectFile(root, 'data/corpus-chunks/manifest.json');
  const manifestJson = parseJsonAsset(manifestAsset);
  const sqlFiles = Array.isArray(manifestJson.sql_files) ? manifestJson.sql_files : [];
  const manifest = validateCorpusManifest(manifestJson, sqlFiles.length);
  await validateCorpusManifestSourceBindings(manifest, { root });
  const actualSqlPaths = (await walkFiles(root, 'data/corpus-chunks'))
    .filter((file) => file.endsWith('.sql'));
  const expectedSqlPaths = sqlFiles.map((file) =>
    `data/corpus-chunks/${normalizeRelativePath(file.name, 'corpus SQL chunk')}`);
  assertExactSet(expectedSqlPaths, actualSqlPaths, 'corpus SQL chunk set');
  const chunks = [];
  for (const expected of sqlFiles) {
    const source = `data/corpus-chunks/${normalizeRelativePath(expected.name, 'corpus SQL chunk')}`;
    const inspected = await inspectFile(root, source);
    assertBufferParity(expected, inspected.buffer, `corpus SQL chunk ${expected.name}`);
    chunks.push({ source, name: expected.name, sha256: inspected.sha256, bytes: inspected.bytes });
  }
  return {
    source: manifestAsset.source,
    sha256: manifestAsset.sha256,
    bytes: manifestAsset.bytes,
    release_id: manifest.release_id,
    release_fingerprint_sha256: manifest.release_fingerprint_sha256,
    manifest_sha256: manifest.manifest_sha256,
    generated_at: manifest.generated_at,
    audit: {
      closed_ocr_paragraphs: manifest.closed_ocr_paragraphs,
      skipped_ocr_documents: manifest.skipped_ocr_documents,
      excluded_exact_duplicate_alias_documents: manifest.excluded_exact_duplicate_alias_documents,
      semantic_excluded_pages: manifest.semantic_excluded_pages,
      page_publication_schema_version: manifest.page_publication_schema_version,
      semantic_publication_schema_version: manifest.semantic_publication_schema_version,
      semantic_publication_revision_sha256: manifest.semantic_publication_revision_sha256,
    },
    counts: {
      documents: manifest.documents,
      paragraphs: manifest.paragraphs,
      fts_rows: manifest.fts_rows,
      page_publication_gates: manifest.page_publication_gates,
      displayed_paragraphs: manifest.displayed_paragraphs,
      accepted_ocr_documents: manifest.accepted_ocr_documents,
      chunks: manifest.sql_chunks,
      core_table_counts: manifest.core_table_counts,
    },
    chunks,
  };
}

async function validateDataInventory(root, policy, r2Objects) {
  const inventory = policy.data_inventory;
  if (!inventory || !Array.isArray(inventory.files) || inventory.files.length === 0) {
    throw new Error('release policy data_inventory is missing or empty');
  }
  const allowed = new Set(inventory.allowed_dispositions || []);
  const entries = inventory.files.map((entry) => ({
    path: normalizeRelativePath(entry.path, 'data inventory path'),
    disposition: String(entry.disposition || ''),
    consumers: [...new Set(entry.consumers || [])].sort(),
  }));
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new Error('data inventory contains duplicate paths');
  }
  for (const entry of entries) {
    if (!allowed.has(entry.disposition)) {
      throw new Error(`data inventory has invalid disposition for ${entry.path}: ${entry.disposition}`);
    }
  }
  const excludedPrefixes = (inventory.excluded_prefixes || [])
    .map((prefix) => normalizeRelativePath(prefix, 'data inventory excluded prefix'));
  const actual = (await walkFiles(root, 'data')).filter((file) =>
    !excludedPrefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)));
  assertExactSet(entries.map((entry) => entry.path), actual, 'data inventory coverage');
  const r2Sources = new Set(r2Objects.map((object) => object.source));
  const publicMetadata = entries
    .filter((entry) => entry.disposition === 'r2_public_metadata')
    .map((entry) => entry.path);
  assertExactSet(publicMetadata, r2Sources, 'data inventory R2 public metadata subset');
  return {
    file_count: entries.length,
    excluded_prefixes: excludedPrefixes,
    by_disposition: countBy(entries, (entry) => entry.disposition),
    files: entries,
  };
}

async function inspectDownloadsAuditReceipt(root, policy, generatedAt, registryAsset) {
  const source = normalizeRelativePath(
    policy.release_governance?.downloads_receipt_source || 'data/downloads-asset-audit-receipt.json',
    'Downloads receipt source',
  );
  const asset = await inspectFile(root, source);
  const receipt = validateDownloadsAuditReceipt(parseJsonAsset(asset));
  if (receipt.registry_sha256 !== registryAsset.sha256) {
    throw new Error('Downloads asset audit receipt is bound to a different artifact registry');
  }
  const maximumAgeHours = Number(policy.release_governance?.downloads_receipt_max_age_hours);
  if (!Number.isFinite(maximumAgeHours) || maximumAgeHours <= 0) {
    throw new Error('downloads_receipt_max_age_hours must be positive');
  }
  const observed = Date.parse(receipt.audited_at);
  const generated = Date.parse(generatedAt);
  if (!Number.isFinite(observed) || !Number.isFinite(generated)) throw new Error('Downloads receipt timestamp is invalid');
  const ageHours = (generated - observed) / 3_600_000;
  return {
    source,
    sha256: asset.sha256,
    bytes: asset.bytes,
    audited_at: receipt.audited_at,
    receipt_sha256: receipt.receipt_sha256,
    pdf_files: receipt.pdf_files,
    relevant_files: receipt.relevant_files,
    unique_relevant_artifacts: receipt.unique_relevant_artifacts,
    age_hours: ageHours,
    maximum_age_hours: maximumAgeHours,
    fresh: ageHours >= -0.25 && ageHours <= maximumAgeHours,
  };
}

async function inspectEnvironmentEvidence(root, policy, generatedAt) {
  const source = normalizeRelativePath(
    policy.release_governance?.environment_evidence_source || 'data/release-environment-evidence.json',
    'environment evidence source',
  );
  const asset = await inspectFile(root, source);
  const receipt = validateEnvironmentEvidenceReceipt(parseJsonAsset(asset));
  const maximumAgeHours = Number(policy.release_governance?.environment_evidence_max_age_hours);
  if (!Number.isFinite(maximumAgeHours) || maximumAgeHours <= 0) {
    throw new Error('environment_evidence_max_age_hours must be positive');
  }
  return { source, sha256: asset.sha256, bytes: asset.bytes, receipt, maximumAgeHours, generatedAt };
}

function sameCorpusRelease(observed, expected) {
  if (!observed || observed.ready !== true
    || observed.release_id !== expected.release_id
    || observed.release_fingerprint_sha256 !== expected.release_fingerprint_sha256
    || observed.manifest_sha256 !== expected.manifest_sha256) return false;
  return stableStringify(observed.counts) === stableStringify(expected.counts);
}

function downloadsReceiptIdentity(receipt) {
  const { age_hours: _ageHours, fresh: _fresh, ...stable } = receipt;
  return stable;
}

function environmentSnapshotIdentity(snapshot) {
  return {
    ...snapshot,
    environments: Object.fromEntries(Object.entries(snapshot.environments).map(([name, environment]) => {
      const {
        evidence_age_hours: _evidenceAgeHours,
        evidence_fresh: _evidenceFresh,
        release_blockers: blockers = [],
        ...stableEnvironment
      } = environment;
      return [name, {
        ...stableEnvironment,
        release_blockers: blockers.filter((blocker) => blocker.code !== 'environment_evidence_stale'),
      }];
    })),
  };
}

export function corpusReleaseIdentity(corpusRelease) {
  return corpusRelease;
}

export function releaseIdFromIdentity(releaseIdentity) {
  return `release-${sha256(Buffer.from(stableStringify(releaseIdentity))).slice(0, 32)}`;
}

function buildEnvironmentState(root, policy, git, availableMigrations, corpusRelease, evidenceAsset) {
  const snapshot = policy.environment_snapshot || {};
  const requiredMigration = String(snapshot.required_migration || '');
  const requiredReleaseReader = String(snapshot.required_r2_release_reader || '');
  if (!requiredMigration || !availableMigrations.includes(requiredMigration)) {
    throw new Error(`required migration is absent from source: ${requiredMigration || '<unset>'}`);
  }
  if (!requiredReleaseReader) throw new Error('required_r2_release_reader is absent from environment snapshot');

  const generatedTimestamp = Date.parse(evidenceAsset.generatedAt);
  const environments = {};
  for (const name of ['local', 'preview', 'production']) {
    const local = name === 'local';
    const configured = local ? snapshot.local : evidenceAsset.receipt.environments?.[name];
    if (!configured && local) throw new Error('environment snapshot is missing local');
    const applied = Array.isArray(configured?.applied_migrations) ? [...configured.applied_migrations].sort() : null;
    if (applied) {
      const unknown = applied.filter((migration) => !availableMigrations.includes(migration));
      if (unknown.length) throw new Error(`${name} reports unknown applied migrations: ${unknown.join(', ')}`);
    }
    const pending = applied ? availableMigrations.filter((migration) => !applied.includes(migration)) : null;
    const blockers = (pending || []).map((migration) => ({
      code: 'pending_d1_migration',
      migration,
      message: `${name} D1 has not applied ${migration}`,
    }));
    if (!configured) {
      blockers.push({ code: 'environment_evidence_required', message: `${name} has no collected environment evidence` });
    }
    const observedAt = local ? null : configured?.observed_at;
    const ageHours = local ? null : (generatedTimestamp - Date.parse(observedAt)) / 3_600_000;
    const evidenceFresh = local || (Number.isFinite(ageHours) && ageHours >= -0.25 && ageHours <= evidenceAsset.maximumAgeHours);
    if (!evidenceFresh) {
      blockers.push({
        code: 'environment_evidence_stale',
        observed_at: observedAt || null,
        age_hours: Number.isFinite(ageHours) ? ageHours : null,
        maximum_age_hours: evidenceAsset.maximumAgeHours,
        message: `${name} environment evidence is outside the freshness window`,
      });
    }
    if (configured?.r2_release_reader !== requiredReleaseReader) {
      blockers.push({
        code: 'versioned_r2_reader_required',
        requirement: requiredReleaseReader,
        observed: configured?.r2_release_reader || null,
        message: `${name} Worker still reads stable R2 keys and cannot follow an atomic versioned release pointer`,
      });
    }
    const configuredAssetCommit = configured?.asset_git_commit === '$git_head'
      ? git.head
      : configured?.asset_git_commit;
    const assetGitCommit = assertGitCommitExists(root, configuredAssetCommit, `${name}.asset_git_commit`);
    const assetParityValid = local || configured?.asset_parity?.valid === true;
    if (!assetParityValid) {
      blockers.push({ code: 'worker_asset_git_parity_required', message: `${name} Worker assets lack byte-exact Git parity evidence` });
    }
    const healthReady = local || (configured?.health?.http_status === 200
      && configured?.health?.ok === true
      && configured?.health?.release_git_commit === assetGitCommit);
    if (!healthReady) {
      blockers.push({ code: 'worker_health_release_provenance_required', message: `${name} health does not prove a ready Git-bound release` });
    }
    const observedCorpus = local ? {
      ready: true,
      release_id: corpusRelease.release_id,
      release_fingerprint_sha256: corpusRelease.release_fingerprint_sha256,
      manifest_sha256: corpusRelease.manifest_sha256,
      counts: corpusRelease.counts,
    } : configured?.corpus || null;
    const corpusMatches = local || sameCorpusRelease(observedCorpus, corpusRelease);
    if (!corpusMatches) {
      blockers.push({
        code: 'corpus_release_mismatch',
        expected_release_id: corpusRelease.release_id,
        observed_release_id: observedCorpus?.release_id || null,
        message: `${name} D1 current corpus release does not match the local release manifest`,
      });
    }
    environments[name] = {
      worker_revision: local ? configured.worker_revision : configured?.health?.version || null,
      worker_version_id: configured?.worker_version_id || null,
      asset_git_commit: assetGitCommit,
      asset_git_commit_object_exists: true,
      asset_git_commit_deployment_parity: assetParityValid,
      migration_state: local ? configured.migration_state : 'collected_read_only_evidence',
      r2_release_reader: configured?.r2_release_reader || null,
      required_r2_release_reader: requiredReleaseReader,
      applied_migrations: applied,
      available_migrations: availableMigrations,
      pending_migrations: pending,
      corpus_release: observedCorpus,
      corpus_release_matches_local: corpusMatches,
      evidence_observed_at: observedAt,
      evidence_age_hours: ageHours,
      evidence_fresh: evidenceFresh,
      deployment_id: configured?.deployment_id || null,
      asset_parity: configured?.asset_parity || null,
      health: configured?.health || null,
      r2_current_pointer: configured?.r2_current_pointer || null,
      release_blockers: blockers,
      readiness_status: blockers.length ? 'blocked' : applied === null ? 'not_assessed' : 'ready',
      release_ready: blockers.length ? false : applied === null ? null : true,
    };
  }

  return {
    evidence: {
      source: evidenceAsset.source,
      sha256: evidenceAsset.sha256,
      bytes: evidenceAsset.bytes,
      receipt_sha256: evidenceAsset.receipt.receipt_sha256,
      observed_at: evidenceAsset.receipt.observed_at,
      maximum_age_hours: evidenceAsset.maximumAgeHours,
    },
    required_migration: requiredMigration,
    required_r2_release_reader: requiredReleaseReader,
    environments,
  };
}

function verifyCrossAssetIntegrity(dataByRole, graphByRole) {
  const catalogAsset = dataByRole.get('catalog');
  const ingestAsset = dataByRole.get('ingest_manifest');
  const queueAsset = dataByRole.get('ocr_queue');
  const validationAsset = dataByRole.get('online_verification_validation');
  const coreAsset = graphByRole.get('concept_graph_core');
  const academicAsset = graphByRole.get('concept_graph_academic');
  for (const [asset, label] of [
    [catalogAsset, 'catalog'], [ingestAsset, 'ingest manifest'], [queueAsset, 'OCR queue'],
    [validationAsset, 'online verification validation'], [coreAsset, 'core graph'], [academicAsset, 'academic graph'],
  ]) {
    if (!asset) throw new Error(`release manifest is missing required ${label} asset`);
  }

  const catalog = catalogAsset.json;
  const ingest = ingestAsset.json;
  const queue = queueAsset.json;
  const core = coreAsset.json;
  const academic = academicAsset.json;
  const catalogIds = assertUniqueIds(catalog.documents || [], 'catalog documents');
  const ingestIds = assertUniqueIds(ingest.entries || [], 'ingest entries');
  const queueIds = assertUniqueIds(queue.documents || [], 'OCR queue documents');
  assertExactSet(catalogIds, ingestIds, 'catalog/ingest document identity');
  const queueOutsideCatalog = [...queueIds].filter((id) => !catalogIds.has(id));
  if (queueOutsideCatalog.length) throw new Error(`OCR queue contains documents absent from catalog: ${queueOutsideCatalog.join(', ')}`);
  if (catalog.counts?.documents !== (catalog.documents || []).length) throw new Error('catalog declared document count is stale');
  if (queue.counts?.documents !== (queue.documents || []).length) throw new Error('OCR queue declared document count is stale');
  if (queue.counts?.pages !== sum((queue.documents || []).map((item) => item.page_count))) throw new Error('OCR queue declared page count is stale');
  if (validationAsset.json.valid !== true || (validationAsset.json.results || []).some((item) => item.valid !== true)) {
    throw new Error('online verification validation is not fully valid');
  }
  if (core.build_revision !== academic.build_revision) throw new Error('core and academic graph build revisions differ');
  if (core.academic_model_ref?.sha256 !== academicAsset.sha256) throw new Error('core graph academic_model_ref hash is stale');
  for (const [label, graph] of [['core', core], ['academic', academic]]) {
    if (graph.input_fingerprints?.catalog_sha256 !== catalogAsset.sha256) throw new Error(`${label} graph catalog fingerprint is stale`);
    if (graph.input_fingerprints?.queue_sha256 !== queueAsset.sha256) throw new Error(`${label} graph OCR queue fingerprint is stale`);
  }
  for (const [key, expected] of Object.entries(core.academic_model_ref?.counts || {})) {
    if (Array.isArray(academic[key]) && academic[key].length !== expected) {
      throw new Error(`core graph academic_model_ref count is stale for ${key}`);
    }
  }
}

export async function buildReleaseManifest({
  root = DEFAULT_ROOT,
  policyPath = DEFAULT_POLICY,
  generatedAt = new Date().toISOString(),
  pageEvidencePromotion = false,
  rendererPath = null,
} = {}) {
  const projectRoot = resolve(root);
  const pageEvidence = validatePageEvidenceForRelease({
    root: projectRoot,
    pageEvidencePromotion,
    rendererPath,
  });
  const normalizedPolicyPath = normalizeRelativePath(policyPath, 'policy path');
  const policyAsset = await inspectFile(projectRoot, normalizedPolicyPath);
  const policy = parseJsonAsset(policyAsset);
  if (policy.schema_version !== 1 || policy.policy !== 'fail_closed_release_assets_v1') {
    throw new Error(`unsupported release assets policy: ${policy.policy || '<unset>'} schema ${policy.schema_version ?? '<unset>'}`);
  }

  const projectAssetAudit = await auditProjectAssets({ projectRoot });
  if (!projectAssetAudit.ok) {
    const issues = projectAssetAudit.errors.map((issue) => `${issue.area}:${issue.code}`).join(', ');
    throw new Error(`project asset audit failed closed: ${issues || 'unknown error'}`);
  }

  const r2Objects = await validateR2PolicyCoverage(projectRoot, policy);
  const dataInventory = await validateDataInventory(projectRoot, policy, r2Objects);
  const gitStatus = gitValue(projectRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  const git = {
    head: gitValue(projectRoot, ['rev-parse', 'HEAD']),
    branch: gitValue(projectRoot, ['branch', '--show-current']),
    upstream_head: gitValue(projectRoot, ['rev-parse', '@{upstream}'], { optional: true }),
    dirty: Boolean(gitStatus),
    status_entries: gitStatus ? gitStatus.split('\n').length : 0,
    status_sha256: sha256(Buffer.from(gitStatus)),
  };

  const sourceTree = await buildSourceTree(projectRoot, policy);
  const corpusRelease = await inspectCorpusRelease(projectRoot);
  const dataAssets = [];
  const dataByRole = new Map();
  for (const object of r2Objects) {
    const inspected = await inspectFile(projectRoot, object.source);
    const json = parseJsonAsset(inspected);
    const asset = {
      role: object.role,
      source: object.source,
      key: object.key,
      content_type: object.content_type,
      sha256: inspected.sha256,
      bytes: inspected.bytes,
      counts: countAsset(object.role, json),
      json,
    };
    dataAssets.push(asset);
    dataByRole.set(object.role, asset);
  }
  const registryAsset = dataByRole.get('artifact_registry');
  if (!registryAsset) throw new Error('release manifest is missing required artifact registry asset');
  const downloadsAssetAudit = await inspectDownloadsAuditReceipt(projectRoot, policy, generatedAt, registryAsset);
  const environmentEvidence = await inspectEnvironmentEvidence(projectRoot, policy, generatedAt);
  const assetAuditSummary = {
    command: 'node scripts/audit-project-assets.mjs --project-root .',
    downloads_included: false,
    ok: true,
    checks: projectAssetAudit.checks,
    registry: {
      source: registryAsset.source,
      sha256: registryAsset.sha256,
      bytes: registryAsset.bytes,
      policy: projectAssetAudit.policy,
      expected_counts: registryAsset.json.expected_counts || null,
    },
    source_inventory: {
      roots: projectAssetAudit.source_inventory.roots,
      pdf_files: projectAssetAudit.source_inventory.pdf_files,
      unique_artifacts: projectAssetAudit.source_inventory.unique_artifacts,
      valid_pdf_files: projectAssetAudit.source_inventory.valid_pdf_files,
      invalid_pdf_files: projectAssetAudit.source_inventory.invalid_pdf_files,
      dispositions: projectAssetAudit.source_inventory.dispositions,
      explicit_artifacts: projectAssetAudit.source_inventory.explicit_artifacts.length,
      duplicate_artifacts: projectAssetAudit.source_inventory.duplicate_artifacts.length,
      source_archive_containers: projectAssetAudit.source_inventory.source_archive_containers.length,
    },
    queue: {
      nominal_documents: projectAssetAudit.queue.nominal_documents,
      nominal_pages: projectAssetAudit.queue.nominal_pages,
      unique_artifacts: projectAssetAudit.queue.unique_artifacts,
      unique_pages: projectAssetAudit.queue.unique_pages,
      blocked_documents: projectAssetAudit.queue.blocked_documents,
      duplicate_artifacts: projectAssetAudit.queue.duplicate_artifacts.length,
    },
    warnings: projectAssetAudit.warnings.map((warning) => ({ area: warning.area, code: warning.code })),
    errors: 0,
  };
  assetAuditSummary.sha256 = sha256(Buffer.from(stableStringify(assetAuditSummary)));

  const graphAssets = [];
  const graphByRole = new Map();
  const staticSourceRoot = normalizeRelativePath(policy.static_assets?.source_root, 'static source root');
  const staticDeployRoot = normalizeRelativePath(policy.static_assets?.deploy_root, 'static deploy root');
  for (const configured of policy.graph_assets || []) {
    const inspected = await inspectFile(projectRoot, configured.source);
    if (!inspected.source.startsWith(`${staticSourceRoot}/`)) {
      throw new Error(`graph asset is outside static source root: ${inspected.source}`);
    }
    const deployPath = `${staticDeployRoot}/${inspected.source.slice(staticSourceRoot.length + 1)}`;
    const deployed = await inspectFile(projectRoot, deployPath);
    assertBufferParity(inspected, deployed.buffer, `deploy graph ${deployPath}`);
    const json = parseJsonAsset(inspected);
    const asset = {
      role: configured.role,
      source: configured.source,
      deploy_path: deployPath,
      sha256: inspected.sha256,
      bytes: inspected.bytes,
      build_revision: json.build_revision || null,
      counts: graphCounts(json),
      input_fingerprints: json.input_fingerprints || null,
      json,
    };
    graphAssets.push(asset);
    graphByRole.set(configured.role, asset);
  }
  if (graphAssets.length !== 2) throw new Error(`release policy must define exactly two graph assets; found ${graphAssets.length}`);

  verifyCrossAssetIntegrity(dataByRole, graphByRole);

  const graphSources = new Set(graphAssets.map((item) => item.source));
  const publicFiles = await walkFiles(projectRoot, staticSourceRoot);
  const deployFiles = await walkFiles(projectRoot, staticDeployRoot);
  const expectedDeployFiles = publicFiles.map((source) =>
    `${staticDeployRoot}/${source.slice(staticSourceRoot.length + 1)}`);
  assertExactSet(expectedDeployFiles, deployFiles, 'source/deploy static asset set');
  const staticAssets = [];
  for (const source of publicFiles.filter((file) => !graphSources.has(file))) {
    const inspected = await inspectFile(projectRoot, source);
    const deployPath = `${staticDeployRoot}/${source.slice(staticSourceRoot.length + 1)}`;
    const deployed = await inspectFile(projectRoot, deployPath);
    assertBufferParity(inspected, deployed.buffer, `deploy static asset ${deployPath}`);
    staticAssets.push({
      path: source,
      source_path: source,
      deploy_path: deployPath,
      sha256: inspected.sha256,
      bytes: inspected.bytes,
      content_type: inspected.content_type,
    });
  }

  const migrationFiles = (await walkFiles(projectRoot, 'migrations'))
    .filter((file) => /^migrations\/\d{4}_.+\.sql$/.test(file))
    .map((file) => file.slice('migrations/'.length))
    .sort();
  const environmentState = buildEnvironmentState(
    projectRoot,
    policy,
    git,
    migrationFiles,
    corpusRelease,
    environmentEvidence,
  );

  const publicAssetPaths = [...staticAssets.map((item) => item.path), ...graphAssets.map((item) => item.source)];
  assertExactSet(publicFiles, publicAssetPaths, 'public static asset coverage');
  const manifestDeployPaths = [...staticAssets.map((item) => item.deploy_path), ...graphAssets.map((item) => item.deploy_path)];
  assertExactSet(deployFiles, manifestDeployPaths, 'deploy static asset coverage');

  const cleanDataAssets = dataAssets.map(({ json, ...asset }) => asset);
  const cleanGraphAssets = graphAssets.map(({ json, ...asset }) => asset);
  const staticSummary = {
    source_root: staticSourceRoot,
    deploy_root: staticDeployRoot,
    file_count: staticAssets.length,
    total_bytes: sum(staticAssets.map((item) => item.bytes)),
    by_extension: countBy(staticAssets, (item) => extname(item.path).toLowerCase() || '<none>'),
    files: staticAssets,
  };
  const releaseIdentity = {
    policy_sha256: policyAsset.sha256,
    git: { head: git.head },
    source_tree_sha256: sourceTree.sha256,
    data_inventory: dataInventory,
    corpus_release: corpusReleaseIdentity(corpusRelease),
    page_evidence: pageEvidence,
    downloads_asset_audit: downloadsReceiptIdentity(downloadsAssetAudit),
    data_assets: cleanDataAssets.map(({ role, source, key, sha256: hash, bytes }) => ({ role, source, key, sha256: hash, bytes })),
    graph_assets: cleanGraphAssets.map(({ role, source, deploy_path, sha256: hash, bytes, build_revision }) => ({ role, source, deploy_path, sha256: hash, bytes, build_revision })),
    static_assets: staticAssets.map(({ path, deploy_path, sha256: hash, bytes }) => ({ path, deploy_path, sha256: hash, bytes })),
    environment_snapshot: environmentSnapshotIdentity(environmentState),
    project_asset_audit: assetAuditSummary,
  };
  const releaseId = releaseIdFromIdentity(releaseIdentity);
  const releasePrefix = normalizeRelativePath(policy.r2.release_prefix, 'r2 release prefix');
  const releasedDataAssets = cleanDataAssets.map((asset) => ({
    ...asset,
    release_key: `${releasePrefix}/${releaseId}/${asset.key}`,
  }));
  const releaseManifestKey = `${releasePrefix}/${releaseId}/manifest.json`;
  const releaseKeys = releasedDataAssets.map((asset) => asset.release_key);
  if (new Set(releaseKeys).size !== releaseKeys.length || releaseKeys.includes(releaseManifestKey)) {
    throw new Error('versioned R2 release keys contain a collision');
  }
  const sourceBlockers = [];
  if (git.dirty) {
    sourceBlockers.push({
      environment: 'source',
      code: 'dirty_git_tree',
      status_entries: git.status_entries,
      status_sha256: git.status_sha256,
      message: 'release source contains tracked or untracked changes',
    });
  }
  if (!/^[0-9a-f]{40}$/.test(String(git.upstream_head || '')) || git.upstream_head !== git.head) {
    sourceBlockers.push({
      environment: 'source',
      code: 'git_head_not_pushed',
      head: git.head,
      upstream_head: git.upstream_head || null,
      message: 'release source HEAD is not exactly present at its configured upstream',
    });
  }
  if (!downloadsAssetAudit.fresh) {
    sourceBlockers.push({
      environment: 'source',
      code: 'downloads_asset_audit_stale',
      audited_at: downloadsAssetAudit.audited_at,
      age_hours: downloadsAssetAudit.age_hours,
      maximum_age_hours: downloadsAssetAudit.maximum_age_hours,
      message: 'Downloads asset audit receipt is missing the release freshness window',
    });
  }
  const allBlockers = [
    ...sourceBlockers,
    ...Object.entries(environmentState.environments).flatMap(([environment, value]) =>
      value.release_blockers.map((blocker) => ({ environment, ...blocker }))),
  ];

  return {
    schema_version: policy.release_manifest_schema_version,
    policy: policy.policy,
    generated_at: generatedAt,
    release_id: releaseId,
    release_ready: allBlockers.length === 0,
    release_blockers: allBlockers,
    git,
    source_tree: sourceTree,
    data_inventory: dataInventory,
    corpus_release: corpusRelease,
    page_evidence: pageEvidence,
    downloads_asset_audit: downloadsAssetAudit,
    environment_snapshot: environmentState,
    data_assets: releasedDataAssets,
    graph_assets: cleanGraphAssets,
    static_assets: staticSummary,
    r2: {
      current_pointer_key: policy.r2.current_pointer_key,
      release_prefix: releasePrefix,
      release_manifest_key: releaseManifestKey,
      buckets: policy.r2.buckets,
      managed_object_count: releasedDataAssets.length,
      objects: releasedDataAssets.map(({ role, source, key, release_key, content_type, sha256: hash, bytes, counts }) => ({
        role, source, key, release_key, content_type, sha256: hash, bytes, counts,
      })),
    },
    integrity: {
      valid: true,
      project_asset_audit: {
        ...assetAuditSummary,
        audited_at: generatedAt,
      },
      checks: [
        'project_asset_registry_audit_passed_without_downloads_scan',
        'downloads_asset_audit_receipt_hash_bound_and_freshness_gated',
        'git_tracked_source_tree_only',
        'data_inventory_exact_with_explicit_dispositions',
        'corpus_release_manifest_and_sql_chunks_exact',
        'governed_r2_source_set_exact',
        'catalog_ingest_document_set_exact',
        'ocr_queue_subset_of_catalog',
        'declared_catalog_and_queue_counts_current',
        'online_verification_validation_passed',
        'core_academic_build_revision_exact',
        'graph_catalog_and_queue_fingerprints_exact',
        'core_academic_reference_hash_and_counts_exact',
        'public_asset_set_exact',
        'source_to_deploy_asset_hash_and_size_exact',
        'versioned_r2_release_keys_unique_and_immutable',
        'required_migration_present_and_environment_state_bound',
        'environment_asset_git_commits_exist_as_exact_commit_objects',
        'dirty_release_source_reported_as_fail_closed_blocker'
      ]
    }
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    if (key === '--page-evidence-promotion') {
      args[key.slice(2)] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    args[key.slice(2)] = value;
    index += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root ? resolve(args.root) : DEFAULT_ROOT;
  const manifest = await buildReleaseManifest({
    root,
    policyPath: args.policy || DEFAULT_POLICY,
    generatedAt: args['generated-at'] || new Date().toISOString(),
    pageEvidencePromotion: args['page-evidence-promotion'] === true,
    rendererPath: args.renderer || null,
  });
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (args.output) {
    const output = resolve(args.output);
    const relativeOutput = relative(root, output).replaceAll('\\', '/');
    const governed = [...manifest.source_tree.files.map((item) => item.path)];
    if (relativeOutput && !relativeOutput.startsWith('../') && governed.includes(relativeOutput)) {
      throw new Error(`output path is part of the governed source tree and would make the manifest self-referential: ${relativeOutput}`);
    }
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, serialized, 'utf8');
    process.stdout.write(`${manifest.release_id} assets=${manifest.static_assets.file_count + manifest.graph_assets.length} r2=${manifest.r2.managed_object_count} blockers=${manifest.release_blockers.length}\n`);
  } else {
    process.stdout.write(serialized);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`build-release-manifest: ${error.message}\n`);
    process.exitCode = 1;
  });
}
