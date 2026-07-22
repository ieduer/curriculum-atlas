#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSourceRecoveryOnlineReceipt } from './source-recovery-online-receipt.mjs';
import { validateSourceRecoveryProofs } from './validate-source-recovery-proofs.mjs';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PDF_MAGIC = Buffer.from('%PDF-');
const DEFAULT_PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

function normalizeRelative(filePath) {
  return filePath.split(path.sep).join('/').replace(/^\.\//, '');
}

function sameStringSet(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function sorted(values) {
  return [...values].sort((left, right) => String(left).localeCompare(String(right)));
}

function issue(area, code, message, details = undefined) {
  return details === undefined
    ? { area, code, message }
    : { area, code, message, details };
}

async function readJson(projectRoot, relativePath) {
  return JSON.parse(await readFile(path.join(projectRoot, relativePath), 'utf8'));
}

function resolveInside(projectRoot, relativePath) {
  const absolute = path.resolve(projectRoot, relativePath);
  const relation = path.relative(projectRoot, absolute);
  if (relation === '' || (!relation.startsWith('..') && !path.isAbsolute(relation))) return absolute;
  throw new Error(`Path escapes project root: ${relativePath}`);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkPdfFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) files.push(absolute);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function inspectFile(filePath) {
  const hash = createHash('sha256');
  let prefix = Buffer.alloc(0);
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    if (prefix.length < 8) prefix = Buffer.concat([prefix, chunk.subarray(0, 8 - prefix.length)]);
  }
  const metadata = await stat(filePath);
  return {
    sha256: hash.digest('hex'),
    size_bytes: metadata.size,
    magic_hex: prefix.toString('hex'),
    is_pdf: prefix.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC),
  };
}

async function mapLimit(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, worker));
  return results;
}

function uniqueIdMap(records, label, errors) {
  const result = new Map();
  for (const record of records) {
    const id = record?.id;
    if (typeof id !== 'string' || id.length === 0) {
      errors.push(issue('data', 'missing_record_id', `${label} contains a record without an id`));
      continue;
    }
    if (result.has(id)) {
      errors.push(issue('data', 'duplicate_record_id', `${label} contains duplicate id ${id}`));
      continue;
    }
    result.set(id, record);
  }
  return result;
}

function addReference(referencesByHash, sha256, reference, errors) {
  if (!sha256) return;
  const normalized = String(sha256).toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    errors.push(issue('data', 'invalid_reference_sha256', `${reference.source} has an invalid SHA-256`, reference));
    return;
  }
  if (!referencesByHash.has(normalized)) referencesByHash.set(normalized, []);
  referencesByHash.get(normalized).push({ ...reference, sha256: normalized });
}

function compareExpectedCount(registry, key, actual, errors) {
  const expected = registry.expected_counts?.[key];
  if (expected === undefined) return;
  if (actual !== expected) {
    errors.push(issue('counts', 'expected_count_mismatch', `${key}: expected ${expected}, observed ${actual}`, {
      key,
      expected,
      actual,
    }));
  }
}

function resolveDisposition(sha256, explicitByHash, referencesByHash, errors, reportConflict = true) {
  const explicit = explicitByHash.get(sha256);
  const references = referencesByHash.get(sha256) ?? [];
  const inferred = new Set(references.map((reference) => reference.disposition));
  if (explicit) {
    const conflicts = sorted([...inferred].filter((value) => value !== explicit.disposition));
    if (conflicts.length > 0 && reportConflict) {
      errors.push(issue('source_inventory', 'explicit_disposition_conflict', `${sha256} is registered as ${explicit.disposition} but referenced as ${conflicts.join(', ')}`, {
        artifact_id: explicit.artifact_id,
        references,
      }));
    }
    return explicit.disposition;
  }
  if (inferred.size === 1) return [...inferred][0];
  if (inferred.size > 1 && reportConflict) {
    errors.push(issue('source_inventory', 'inferred_disposition_conflict', `${sha256} has conflicting inferred dispositions`, {
      dispositions: sorted(inferred),
      references,
    }));
  }
  return null;
}

export async function auditProjectAssets(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? DEFAULT_PROJECT_ROOT);
  const downloadsRoot = options.downloadsRoot ? path.resolve(options.downloadsRoot) : null;
  const errors = [];
  const warnings = [];

  const [catalog, documentSources, ingest, queue, registry] = await Promise.all([
    readJson(projectRoot, 'data/catalog.json'),
    readJson(projectRoot, 'data/document-sources.json'),
    readJson(projectRoot, 'data/ingest-manifest.json'),
    readJson(projectRoot, 'data/ocr-queue.json'),
    readJson(projectRoot, 'data/artifact-registry.json'),
  ]);

  const catalogDocuments = Array.isArray(catalog.documents) ? catalog.documents : [];
  const sourceRecords = Array.isArray(documentSources.sources) ? documentSources.sources : [];
  const ingestEntries = Array.isArray(ingest.entries) ? ingest.entries : [];
  const queueDocuments = Array.isArray(queue.documents) ? queue.documents : [];
  const blockedDocuments = Array.isArray(queue.blocked) ? queue.blocked : [];
  const explicitArtifacts = Array.isArray(registry.artifacts) ? registry.artifacts : [];
  const archiveContainers = Array.isArray(registry.source_archive_containers)
    ? registry.source_archive_containers
    : [];
  const aliases = Array.isArray(registry.document_aliases) ? registry.document_aliases : [];

  if (registry.schema_version !== 1) {
    errors.push(issue('registry', 'unsupported_registry_schema', `Expected artifact registry schema_version 1, observed ${registry.schema_version}`));
  }

  compareExpectedCount(registry, 'catalog_documents', catalogDocuments.length, errors);
  compareExpectedCount(registry, 'document_source_records', sourceRecords.length, errors);
  compareExpectedCount(registry, 'ingest_entries', ingestEntries.length, errors);
  compareExpectedCount(registry, 'explicit_artifacts', explicitArtifacts.length, errors);
  compareExpectedCount(registry, 'quarantine_artifacts', explicitArtifacts.filter((artifact) => artifact.disposition === 'quarantine').length, errors);
  compareExpectedCount(registry, 'source_archive_containers', archiveContainers.length, errors);

  const catalogById = uniqueIdMap(catalogDocuments, 'catalog.documents', errors);
  const ingestById = uniqueIdMap(ingestEntries, 'ingest.entries', errors);
  const queueById = uniqueIdMap(queueDocuments, 'ocr-queue.documents', errors);
  const blockedById = uniqueIdMap(blockedDocuments, 'ocr-queue.blocked', errors);

  const catalogIds = new Set(catalogById.keys());
  const ingestIds = new Set(ingestById.keys());
  if (!sameStringSet(catalogIds, ingestIds)) {
    errors.push(issue('data', 'catalog_ingest_id_drift', 'catalog and ingest manifest document ids differ', {
      catalog_only: sorted([...catalogIds].filter((id) => !ingestIds.has(id))),
      ingest_only: sorted([...ingestIds].filter((id) => !catalogIds.has(id))),
    }));
  }

  for (const source of sourceRecords) {
    const catalogDocument = catalogById.get(source.document_id);
    if (!catalogDocument) {
      errors.push(issue('data', 'source_record_unknown_document', `document-sources references unknown document ${source.document_id}`));
      continue;
    }
    if (typeof source.source_url === 'string' && source.source_url
      && typeof catalogDocument.source_url === 'string' && catalogDocument.source_url) {
      const expectedPrimary = source.source_url === catalogDocument.source_url ? 1 : 0;
      if (Number(source.is_primary) !== expectedPrimary) {
        errors.push(issue('data', 'source_primary_mismatch', `${source.document_id} source primary flag disagrees with the catalog canonical URL`, {
          source_url: source.source_url,
          catalog_source_url: catalogDocument.source_url,
          expected_is_primary: expectedPrimary,
          observed_is_primary: source.is_primary,
        }));
      }
    }
  }

  const referencesByHash = new Map();
  const declaredPaths = new Map();
  for (const document of catalogDocuments) {
    if (document.local_cache_path && String(document.file_format || '').startsWith('pdf')) {
      if (!SHA256_PATTERN.test(String(document.checksum_sha256 || '').toLowerCase())) {
        errors.push(issue('data', 'catalog_local_path_without_checksum', `${document.id} has local_cache_path without a valid checksum`));
      } else {
        const relativePath = normalizeRelative(document.local_cache_path);
        declaredPaths.set(relativePath, {
          sha256: document.checksum_sha256.toLowerCase(),
          source: 'catalog.local_cache_path',
          document_id: document.id,
        });
      }
    }
    addReference(referencesByHash, document.checksum_sha256, {
      disposition: 'canonical',
      source: 'catalog',
      document_id: document.id,
      path: document.local_cache_path ?? null,
    }, errors);
    for (const variant of document.scan_variants ?? []) {
      const relativePath = normalizeRelative(variant.local_cache_path || '');
      if (relativePath) {
        declaredPaths.set(relativePath, {
          sha256: String(variant.checksum_sha256 || '').toLowerCase(),
          source: 'catalog.scan_variants',
          document_id: document.id,
        });
      }
      addReference(referencesByHash, variant.checksum_sha256, {
        disposition: 'variant',
        source: 'catalog.scan_variants',
        document_id: document.id,
        path: variant.local_cache_path ?? null,
      }, errors);
    }
  }

  for (const source of sourceRecords) {
    const disposition = source.artifact_disposition ?? 'canonical';
    if (!(registry.allowed_dispositions ?? []).includes(disposition)) {
      errors.push(issue('data', 'invalid_source_artifact_disposition', `${source.document_id} has unsupported source artifact disposition ${disposition}`));
    }
    addReference(referencesByHash, source.checksum_sha256, {
      disposition,
      source: 'document-sources',
      document_id: source.document_id,
      path: null,
    }, errors);
  }

  for (const entry of ingestEntries) {
    if (entry.fetched && entry.source_bytes !== null && entry.source_bytes !== undefined
      && !SHA256_PATTERN.test(String(entry.source_sha256 || '').toLowerCase())) {
      errors.push(issue('data', 'fetched_ingest_without_checksum', `${entry.id} is fetched but has no valid source SHA-256`));
    }
    addReference(referencesByHash, entry.source_sha256, {
      disposition: 'canonical',
      source: 'ingest-manifest',
      document_id: entry.id,
      path: null,
    }, errors);
    const catalogDocument = catalogById.get(entry.id);
    if (catalogDocument?.checksum_sha256 && entry.source_sha256
      && catalogDocument.checksum_sha256.toLowerCase() !== entry.source_sha256.toLowerCase()) {
      errors.push(issue('data', 'catalog_ingest_checksum_drift', `${entry.id} checksum differs between catalog and ingest manifest`, {
        catalog: catalogDocument.checksum_sha256,
        ingest: entry.source_sha256,
      }));
    }
  }

  const allowedDispositions = new Set(registry.allowed_dispositions ?? []);
  const explicitByHash = new Map();
  const explicitPathOwners = new Map();
  const artifactIds = new Set();
  for (const artifact of explicitArtifacts) {
    if (!artifact.artifact_id || artifactIds.has(artifact.artifact_id)) {
      errors.push(issue('registry', 'duplicate_or_missing_artifact_id', `Invalid artifact_id ${artifact.artifact_id ?? '<missing>'}`));
    } else artifactIds.add(artifact.artifact_id);
    const sha256 = String(artifact.sha256 || '').toLowerCase();
    if (!SHA256_PATTERN.test(sha256)) {
      errors.push(issue('registry', 'invalid_artifact_sha256', `${artifact.artifact_id} has an invalid SHA-256`));
      continue;
    }
    if (!allowedDispositions.has(artifact.disposition)) {
      errors.push(issue('registry', 'invalid_artifact_disposition', `${artifact.artifact_id} has unsupported disposition ${artifact.disposition}`));
    }
    if (explicitByHash.has(sha256)) {
      errors.push(issue('registry', 'duplicate_explicit_artifact_hash', `${sha256} appears in multiple explicit artifact records`));
    } else explicitByHash.set(sha256, artifact);
    if (!Array.isArray(artifact.paths) || artifact.paths.length === 0) {
      errors.push(issue('registry', 'artifact_without_paths', `${artifact.artifact_id} has no paths`));
    }
    for (const rawPath of artifact.paths ?? []) {
      const relativePath = normalizeRelative(rawPath);
      if (explicitPathOwners.has(relativePath)) {
        errors.push(issue('registry', 'duplicate_explicit_artifact_path', `${relativePath} belongs to multiple artifact records`));
      } else explicitPathOwners.set(relativePath, artifact.artifact_id);
    }
    if (artifact.disposition !== 'canonical' && (artifact.queue_eligible !== false || artifact.publication_eligible !== false)) {
      errors.push(issue('registry', 'noncanonical_artifact_not_fail_closed', `${artifact.artifact_id} must be queue_eligible=false and publication_eligible=false`));
    }
    const parentId = artifact.parent_document_id ?? artifact.intended_document_id;
    if (parentId && !catalogById.has(parentId)) {
      errors.push(issue('registry', 'artifact_parent_missing', `${artifact.artifact_id} references unknown document ${parentId}`));
    }
    if (artifact.parent_document_id && artifact.parent_sha256) {
      const parent = catalogById.get(artifact.parent_document_id);
      if (parent?.checksum_sha256 !== artifact.parent_sha256) {
        errors.push(issue('registry', 'artifact_parent_checksum_drift', `${artifact.artifact_id} parent checksum no longer matches catalog`, {
          registered: artifact.parent_sha256,
          catalog: parent?.checksum_sha256 ?? null,
        }));
      }
    }
    if (artifact.disposition === 'derived' && artifact.lineage_status !== 'complete') {
      warnings.push(issue('registry', 'derived_lineage_incomplete', `${artifact.artifact_id} remains publication-blocked pending reproducible lineage`));
    }
  }

  const sourceFiles = [];
  for (const rootEntry of registry.source_roots ?? []) {
    let absoluteRoot;
    try {
      absoluteRoot = resolveInside(projectRoot, rootEntry);
    } catch (error) {
      errors.push(issue('source_inventory', 'source_root_outside_project', error.message));
      continue;
    }
    if (!await exists(absoluteRoot)) {
      errors.push(issue('source_inventory', 'source_root_missing', `Source root is missing: ${rootEntry}`));
      continue;
    }
    sourceFiles.push(...await walkPdfFiles(absoluteRoot));
  }

  const inspectedSources = await mapLimit(sourceFiles, 8, async (filePath) => ({
    absolute_path: filePath,
    path: normalizeRelative(path.relative(projectRoot, filePath)),
    ...await inspectFile(filePath),
  }));
  const sourceByPath = new Map(inspectedSources.map((record) => [record.path, record]));
  const sourceByHash = new Map();
  for (const record of inspectedSources) {
    if (!sourceByHash.has(record.sha256)) sourceByHash.set(record.sha256, []);
    sourceByHash.get(record.sha256).push(record);
  }

  compareExpectedCount(registry, 'source_pdf_files', inspectedSources.length, errors);
  compareExpectedCount(registry, 'unique_source_pdf_artifacts', sourceByHash.size, errors);
  compareExpectedCount(registry, 'invalid_pdf_files', inspectedSources.filter((record) => !record.is_pdf).length, errors);

  for (const [relativePath, declared] of declaredPaths) {
    const actual = sourceByPath.get(relativePath);
    if (!actual) {
      errors.push(issue('source_inventory', 'declared_source_path_missing', `${declared.source} path is missing: ${relativePath}`, declared));
    } else if (actual.sha256 !== declared.sha256) {
      errors.push(issue('source_inventory', 'declared_source_checksum_mismatch', `${relativePath} does not match its declared checksum`, {
        ...declared,
        actual_sha256: actual.sha256,
      }));
    }
  }

  for (const artifact of explicitArtifacts) {
    const observedPaths = sourceByHash.get(artifact.sha256)?.map((record) => record.path) ?? [];
    const registeredPaths = (artifact.paths ?? []).map(normalizeRelative);
    if (!sameStringSet(new Set(observedPaths), new Set(registeredPaths))) {
      errors.push(issue('source_inventory', 'explicit_artifact_path_drift', `${artifact.artifact_id} observed paths differ from registry`, {
        registered: sorted(registeredPaths),
        observed: sorted(observedPaths),
      }));
    }
    for (const relativePath of registeredPaths) {
      const actual = sourceByPath.get(relativePath);
      if (!actual) continue;
      if (actual.sha256 !== artifact.sha256) {
        errors.push(issue('source_inventory', 'explicit_artifact_checksum_mismatch', `${relativePath} checksum differs from ${artifact.artifact_id}`, {
          registered: artifact.sha256,
          observed: actual.sha256,
        }));
      }
      if (Number.isInteger(artifact.size_bytes) && actual.size_bytes !== artifact.size_bytes) {
        errors.push(issue('source_inventory', 'explicit_artifact_size_mismatch', `${relativePath} size differs from ${artifact.artifact_id}`, {
          registered: artifact.size_bytes,
          observed: actual.size_bytes,
        }));
      }
      if (artifact.valid_pdf_required === true && !actual.is_pdf) {
        errors.push(issue('source_inventory', 'registered_pdf_magic_missing', `${relativePath} is registered as a valid PDF but lacks PDF magic`));
      }
      if (artifact.expected_pdf_magic === false && actual.is_pdf) {
        errors.push(issue('source_inventory', 'quarantine_payload_unexpectedly_pdf', `${relativePath} now has PDF magic; replace or re-adjudicate the quarantine record`));
      }
    }
  }

  const dispositionByHash = new Map();
  for (const [sha256, records] of sourceByHash) {
    const disposition = resolveDisposition(sha256, explicitByHash, referencesByHash, errors);
    if (!disposition) {
      errors.push(issue('source_inventory', 'unregistered_source_artifact', `${sha256} has no unique disposition`, {
        paths: sorted(records.map((record) => record.path)),
        pdf_magic: records[0].is_pdf,
      }));
      continue;
    }
    dispositionByHash.set(sha256, disposition);
    if (disposition !== 'quarantine' && records.some((record) => !record.is_pdf)) {
      errors.push(issue('source_inventory', 'nonquarantine_invalid_pdf', `${sha256} lacks PDF magic but is classified as ${disposition}`, {
        paths: sorted(records.map((record) => record.path)),
      }));
    }
  }

  const inspectedContainers = [];
  for (const container of archiveContainers) {
    for (const rawPath of container.paths ?? []) {
      const relativePath = normalizeRelative(rawPath);
      const absolutePath = resolveInside(projectRoot, relativePath);
      if (!await exists(absolutePath)) {
        errors.push(issue('source_inventory', 'source_archive_missing', `Source archive is missing: ${relativePath}`));
        continue;
      }
      const actual = await inspectFile(absolutePath);
      inspectedContainers.push({ artifact_id: container.artifact_id, path: relativePath, ...actual });
      if (actual.sha256 !== container.sha256) {
        errors.push(issue('source_inventory', 'source_archive_checksum_mismatch', `${relativePath} archive checksum mismatch`, {
          registered: container.sha256,
          observed: actual.sha256,
        }));
      }
      if (Number.isInteger(container.size_bytes) && actual.size_bytes !== container.size_bytes) {
        errors.push(issue('source_inventory', 'source_archive_size_mismatch', `${relativePath} archive size mismatch`, {
          registered: container.size_bytes,
          observed: actual.size_bytes,
        }));
      }
      if (container.expected_magic_hex && !actual.magic_hex.startsWith(container.expected_magic_hex.toLowerCase())) {
        errors.push(issue('source_inventory', 'source_archive_magic_mismatch', `${relativePath} archive magic mismatch`, {
          expected_prefix: container.expected_magic_hex,
          observed_prefix: actual.magic_hex.slice(0, container.expected_magic_hex.length),
        }));
      }
    }
  }

  const ocrStatuses = new Set(registry.ocr_queue_statuses ?? []);
  const expectedOcrIds = new Set(catalogDocuments
    .filter((document) => ocrStatuses.has(document.text_quality_status))
    .map((document) => document.id));
  const queuedIds = new Set(queueById.keys());
  const blockedIds = new Set(blockedById.keys());
  const overlap = sorted([...queuedIds].filter((id) => blockedIds.has(id)));
  if (overlap.length > 0) {
    errors.push(issue('queue', 'queue_blocked_overlap', 'Documents appear in both OCR queue and blocked set', { document_ids: overlap }));
  }
  const coveredOcrIds = new Set([...queuedIds, ...blockedIds]);
  if (!sameStringSet(expectedOcrIds, coveredOcrIds)) {
    errors.push(issue('queue', 'ocr_queue_coverage_drift', 'OCR queue plus blocked records do not exactly cover fail-closed OCR statuses', {
      missing: sorted([...expectedOcrIds].filter((id) => !coveredOcrIds.has(id))),
      unexpected: sorted([...coveredOcrIds].filter((id) => !expectedOcrIds.has(id))),
    }));
  }

  const nominalQueuePages = queueDocuments.reduce((sum, document) => sum + (Number(document.page_count) || 0), 0);
  compareExpectedCount(registry, 'nominal_queue_documents', queueDocuments.length, errors);
  compareExpectedCount(registry, 'nominal_queue_pages', nominalQueuePages, errors);
  compareExpectedCount(registry, 'blocked_documents', blockedDocuments.length, errors);
  if (queue.counts?.documents !== queueDocuments.length
    || queue.counts?.pages !== nominalQueuePages
    || queue.counts?.blocked_documents !== blockedDocuments.length) {
    errors.push(issue('queue', 'ocr_queue_declared_counts_drift', 'ocr-queue counts do not match its records', {
      declared: queue.counts ?? null,
      observed: {
        documents: queueDocuments.length,
        pages: nominalQueuePages,
        blocked_documents: blockedDocuments.length,
      },
    }));
  }

  const queueByHash = new Map();
  for (const document of queueDocuments) {
    const catalogDocument = catalogById.get(document.id);
    if (!catalogDocument) {
      errors.push(issue('queue', 'queued_document_missing_from_catalog', `${document.id} is queued but absent from catalog`));
      continue;
    }
    if (document.input_quality_status !== catalogDocument.text_quality_status) {
      errors.push(issue('queue', 'queued_quality_status_drift', `${document.id} queue and catalog quality statuses differ`, {
        queue: document.input_quality_status,
        catalog: catalogDocument.text_quality_status,
      }));
    }
    if (document.local_cache_path !== catalogDocument.local_cache_path
      || document.source_sha256 !== catalogDocument.checksum_sha256
      || document.page_count !== catalogDocument.page_count) {
      errors.push(issue('queue', 'queued_document_metadata_drift', `${document.id} queue source metadata differs from catalog`, {
        queue: {
          path: document.local_cache_path,
          sha256: document.source_sha256,
          page_count: document.page_count,
        },
        catalog: {
          path: catalogDocument.local_cache_path,
          sha256: catalogDocument.checksum_sha256,
          page_count: catalogDocument.page_count,
        },
      }));
    }
    const actual = sourceByPath.get(normalizeRelative(document.local_cache_path || ''));
    if (!actual) {
      errors.push(issue('queue', 'queued_source_file_missing', `${document.id} queued source path is missing`));
    } else if (actual.sha256 !== document.source_sha256) {
      errors.push(issue('queue', 'queued_source_checksum_mismatch', `${document.id} queued source checksum differs from disk`, {
        queue: document.source_sha256,
        observed: actual.sha256,
      }));
    }
    if (dispositionByHash.get(document.source_sha256) !== 'canonical') {
      errors.push(issue('queue', 'noncanonical_artifact_in_queue', `${document.id} queue source is not canonical`, {
        sha256: document.source_sha256,
        disposition: dispositionByHash.get(document.source_sha256) ?? null,
      }));
    }
    if (!SHA256_PATTERN.test(String(document.source_sha256 || ''))) {
      errors.push(issue('queue', 'queued_source_invalid_sha256', `${document.id} has an invalid queue SHA-256`));
      continue;
    }
    if (!queueByHash.has(document.source_sha256)) queueByHash.set(document.source_sha256, []);
    queueByHash.get(document.source_sha256).push(document);
  }

  for (const blocked of blockedDocuments) {
    const catalogDocument = catalogById.get(blocked.id);
    if (!catalogDocument) {
      errors.push(issue('queue', 'blocked_document_missing_from_catalog', `${blocked.id} is blocked but absent from catalog`));
      continue;
    }
    const queueEligible = Boolean(
      catalogDocument.local_cache_path
      && Number.isInteger(catalogDocument.page_count)
      && catalogDocument.page_count > 0
      && SHA256_PATTERN.test(String(catalogDocument.checksum_sha256 || ''))
    );
    if (queueEligible) {
      errors.push(issue('queue', 'blocked_document_has_complete_source', `${blocked.id} is blocked despite complete catalog source metadata`));
    }
  }

  const aliasByHash = new Map();
  for (const alias of aliases) {
    const sha256 = String(alias.source_artifact_sha256 || '').toLowerCase();
    if (!SHA256_PATTERN.test(sha256) || aliasByHash.has(sha256)) {
      errors.push(issue('registry', 'invalid_or_duplicate_alias_hash', `Invalid or duplicate alias mapping for ${sha256 || '<missing>'}`));
      continue;
    }
    aliasByHash.set(sha256, alias);
    const ids = [alias.canonical_document_id, ...(alias.alias_document_ids ?? [])];
    if (new Set(ids).size !== ids.length || ids.some((id) => !catalogById.has(id))) {
      errors.push(issue('registry', 'invalid_alias_document_set', `${sha256} alias mapping has duplicate or unknown document ids`, { document_ids: ids }));
    }
    for (const id of ids) {
      if (catalogById.get(id)?.checksum_sha256 !== sha256) {
        errors.push(issue('registry', 'alias_checksum_drift', `${id} no longer resolves to alias SHA ${sha256}`, {
          catalog_sha256: catalogById.get(id)?.checksum_sha256 ?? null,
        }));
      }
    }
  }

  const catalogDocumentsByHash = new Map();
  for (const document of catalogDocuments) {
    if (!SHA256_PATTERN.test(String(document.checksum_sha256 || ''))) continue;
    if (!catalogDocumentsByHash.has(document.checksum_sha256)) catalogDocumentsByHash.set(document.checksum_sha256, []);
    catalogDocumentsByHash.get(document.checksum_sha256).push(document.id);
  }
  for (const [sha256, documentIds] of catalogDocumentsByHash) {
    if (documentIds.length < 2) continue;
    const alias = aliasByHash.get(sha256);
    const registeredIds = alias
      ? new Set([alias.canonical_document_id, ...(alias.alias_document_ids ?? [])])
      : new Set();
    if (!alias || !sameStringSet(new Set(documentIds), registeredIds)) {
      errors.push(issue('registry', 'catalog_duplicate_without_exact_alias', `${sha256} has duplicate catalog documents without an exact alias mapping`, {
        document_ids: sorted(documentIds),
      }));
    }
  }

  let uniqueQueuePages = 0;
  for (const [sha256, documents] of queueByHash) {
    const pageCounts = new Set(documents.map((document) => document.page_count));
    if (pageCounts.size !== 1) {
      errors.push(issue('queue', 'duplicate_queue_artifact_page_count_drift', `${sha256} queue aliases have different page counts`, {
        document_ids: documents.map((document) => document.id),
        page_counts: sorted(pageCounts),
      }));
    }
    uniqueQueuePages += Number(documents[0]?.page_count) || 0;
    if (documents.length > 1) {
      const alias = aliasByHash.get(sha256);
      const registeredIds = alias
        ? new Set([alias.canonical_document_id, ...(alias.alias_document_ids ?? [])])
        : new Set();
      const queuedDocumentIds = new Set(documents.map((document) => document.id));
      if (!alias || !sameStringSet(registeredIds, queuedDocumentIds)) {
        errors.push(issue('queue', 'duplicate_queue_artifact_without_alias', `${sha256} is counted more than once in the nominal queue without an exact alias mapping`, {
          queued_document_ids: sorted(queuedDocumentIds),
        }));
      }
    }
  }
  compareExpectedCount(registry, 'unique_queue_artifacts', queueByHash.size, errors);
  compareExpectedCount(registry, 'unique_queue_pages', uniqueQueuePages, errors);

  const queueHashes = new Set(queueByHash.keys());
  for (const artifact of explicitArtifacts) {
    if (artifact.queue_eligible === false && queueHashes.has(artifact.sha256)) {
      errors.push(issue('queue', 'fail_closed_artifact_in_queue', `${artifact.artifact_id} is queue-ineligible but appears in OCR queue`));
    }
  }

  let downloads = { enabled: false };
  if (downloadsRoot) {
    if (!await exists(downloadsRoot)) {
      errors.push(issue('downloads', 'downloads_root_missing', `Downloads root is missing: ${downloadsRoot}`));
      downloads = { enabled: true, root: downloadsRoot, pdf_files: 0, relevant_files: 0, relevant_artifacts: [] };
    } else {
      let namePattern;
      try {
        namePattern = new RegExp(registry.downloads_relevant_name_pattern, 'i');
      } catch (error) {
        errors.push(issue('registry', 'invalid_download_name_pattern', error.message));
        namePattern = /$a/;
      }
      const downloadFiles = await walkPdfFiles(downloadsRoot);
      const inspectedDownloads = await mapLimit(downloadFiles, 6, async (filePath) => ({
        path: filePath,
        basename: path.basename(filePath),
        ...await inspectFile(filePath),
      }));
      const relevantDownloads = inspectedDownloads.filter((record) => (
        namePattern.test(record.basename)
        || sourceByHash.has(record.sha256)
        || explicitByHash.has(record.sha256)
        || referencesByHash.has(record.sha256)
      ));
      for (const record of relevantDownloads) {
        const disposition = resolveDisposition(record.sha256, explicitByHash, referencesByHash, errors, false);
        if (!disposition) {
          errors.push(issue('downloads', 'unregistered_download_artifact', `${record.path} matches curriculum asset scope but has no disposition`, {
            sha256: record.sha256,
          }));
        } else if (!sourceByHash.has(record.sha256)) {
          errors.push(issue('downloads', 'download_artifact_not_ingested', `${record.path} is known but has no copy in registered source roots`, {
            sha256: record.sha256,
            disposition,
          }));
        }
      }
      downloads = {
        enabled: true,
        root: downloadsRoot,
        pdf_files: inspectedDownloads.length,
        relevant_files: relevantDownloads.length,
        unique_relevant_artifacts: new Set(relevantDownloads.map((record) => record.sha256)).size,
        relevant_artifacts: relevantDownloads.map((record) => ({
          path: record.path,
          sha256: record.sha256,
          size_bytes: record.size_bytes,
          pdf_magic: record.is_pdf,
          disposition: resolveDisposition(record.sha256, explicitByHash, referencesByHash, [], false),
          ingested: sourceByHash.has(record.sha256),
        })),
      };
    }
  }

  let sourceRecovery = null;
  const sourceRecoveryProofPath = path.join(projectRoot, 'data/source-recovery-proofs.json');
  if (await exists(sourceRecoveryProofPath)) {
    sourceRecovery = await validateSourceRecoveryProofs({
      root: projectRoot,
      catalog,
      artifactRegistry: registry,
      ocrQueue: queue,
      requireLocal: true,
      deepArchive: true,
    });
    for (const recoveryError of sourceRecovery.errors) {
      errors.push(issue(
        'source_recovery',
        recoveryError.code,
        recoveryError.detail,
      ));
    }
  }
  let sourceRecoveryOnline = null;
  const sourceRecoveryOnlinePath = path.join(projectRoot, 'data/source-recovery-online-receipt.json');
  if (await exists(sourceRecoveryOnlinePath)) {
    sourceRecoveryOnline = await validateSourceRecoveryOnlineReceipt({
      root: projectRoot,
      requireFresh: false,
      requireLocal: true,
    });
    for (const receiptError of sourceRecoveryOnline.errors) {
      errors.push(issue('source_recovery_online', receiptError.code, receiptError.detail));
    }
  }

  const dispositionCounts = { canonical: 0, variant: 0, derived: 0, quarantine: 0 };
  for (const disposition of dispositionByHash.values()) {
    if (Object.hasOwn(dispositionCounts, disposition)) dispositionCounts[disposition] += 1;
  }
  const duplicateSourceArtifacts = [...sourceByHash.entries()]
    .filter(([, records]) => records.length > 1)
    .map(([sha256, records]) => ({
      sha256,
      disposition: dispositionByHash.get(sha256) ?? null,
      paths: sorted(records.map((record) => record.path)),
    }))
    .sort((left, right) => left.sha256.localeCompare(right.sha256));
  const queueDuplicates = [...queueByHash.entries()]
    .filter(([, documents]) => documents.length > 1)
    .map(([sha256, documents]) => ({
      sha256,
      canonical_document_id: aliasByHash.get(sha256)?.canonical_document_id ?? null,
      document_ids: sorted(documents.map((document) => document.id)),
      nominal_pages: documents.reduce((sum, document) => sum + document.page_count, 0),
      unique_pages: documents[0]?.page_count ?? 0,
    }));

  const result = {
    schema_version: 1,
    policy: registry.policy,
    audited_at: new Date().toISOString(),
    project_root: projectRoot,
    ok: errors.length === 0,
    checks: {
      catalog_ingest_id_parity: !errors.some((entry) => entry.code === 'catalog_ingest_id_drift'),
      source_disposition_complete: !errors.some((entry) => [
        'unregistered_source_artifact',
        'inferred_disposition_conflict',
        'explicit_disposition_conflict',
      ].includes(entry.code)),
      explicit_artifacts_match_disk: !errors.some((entry) => entry.code.startsWith('explicit_artifact_') || entry.code === 'registered_pdf_magic_missing'),
      queue_exactly_covers_ocr_statuses: !errors.some((entry) => entry.code === 'ocr_queue_coverage_drift'),
      queue_uses_canonical_artifacts_only: !errors.some((entry) => entry.code === 'noncanonical_artifact_in_queue' || entry.code === 'fail_closed_artifact_in_queue'),
      duplicate_documents_have_aliases: !errors.some((entry) => entry.code.includes('without_alias') || entry.code === 'catalog_duplicate_without_exact_alias'),
      downloads_ingested: downloads.enabled
        ? !errors.some((entry) => entry.area === 'downloads')
        : null,
      source_recovery_exact: sourceRecovery ? sourceRecovery.ok : null,
      source_recovery_online_receipt_exact: sourceRecoveryOnline ? sourceRecoveryOnline.ok : null,
    },
    data_layer: {
      catalog_documents: catalogDocuments.length,
      document_source_records: sourceRecords.length,
      ingest_entries: ingestEntries.length,
      ocr_status_documents: expectedOcrIds.size,
    },
    source_inventory: {
      roots: registry.source_roots,
      pdf_files: inspectedSources.length,
      unique_artifacts: sourceByHash.size,
      valid_pdf_files: inspectedSources.filter((record) => record.is_pdf).length,
      invalid_pdf_files: inspectedSources.filter((record) => !record.is_pdf).length,
      dispositions: dispositionCounts,
      explicit_artifacts: explicitArtifacts.map((artifact) => ({
        artifact_id: artifact.artifact_id,
        disposition: artifact.disposition,
        sha256: artifact.sha256,
        paths: artifact.paths,
        queue_eligible: artifact.queue_eligible,
        publication_eligible: artifact.publication_eligible,
      })),
      duplicate_artifacts: duplicateSourceArtifacts,
      source_archive_containers: inspectedContainers.map((container) => ({
        artifact_id: container.artifact_id,
        path: container.path,
        sha256: container.sha256,
        size_bytes: container.size_bytes,
      })),
    },
    queue: {
      nominal_documents: queueDocuments.length,
      nominal_pages: nominalQueuePages,
      unique_artifacts: queueByHash.size,
      unique_pages: uniqueQueuePages,
      blocked_documents: blockedDocuments.length,
      duplicate_artifacts: queueDuplicates,
    },
    downloads,
    source_recovery: sourceRecovery,
    source_recovery_online: sourceRecoveryOnline,
    warnings,
    errors,
  };
  result.ok = result.errors.length === 0;
  return result;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--project-root') {
      if (!argv[index + 1]) throw new Error('--project-root requires a path');
      options.projectRoot = argv[index + 1];
      index += 1;
    } else if (argument === '--downloads') {
      if (!argv[index + 1]) throw new Error('--downloads requires a path');
      options.downloadsRoot = argv[index + 1];
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: node scripts/audit-project-assets.mjs [--project-root <path>] [--downloads <path>]');
      return;
    }
    const result = await auditProjectAssets(options);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({
      schema_version: 1,
      ok: false,
      errors: [issue('fatal', 'asset_audit_failed', error.message)],
    }, null, 2));
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await main();
