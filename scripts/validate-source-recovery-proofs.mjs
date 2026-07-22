#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, relative, basename, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SHA256 = /^[0-9a-f]{64}$/;
const DOCUMENT_ID = /^[a-z0-9][a-z0-9-]*$/;
const REQUIRED_CORRUPT_RECOVERY_IDS = new Map([
  ['ictr-2a9f8ddd4169', 'quarantine-ictr-physics-2017-zero-prefix-corrupt'],
  ['ictr-24bb45bda31b', 'quarantine-ictr-english-experimental-zero-prefix-corrupt'],
]);
const WORK_IDENTITY_FIELDS = [
  'id', 'country', 'language', 'title', 'subject', 'stage', 'document_type',
  'version_label', 'issued_by', 'issued_date', 'published_date', 'current_status',
];
const CANONICAL_ARTIFACT_IDENTITY_FIELDS = [
  'id', 'source_tier', 'access_status', 'source_page_url', 'source_url', 'file_format',
  'redistribution', 'checksum_sha256', 'page_count', 'local_cache_path',
  'text_quality_status', 'citation_allowed', 'original_filename',
  'native_text_cache_path', 'native_text_sha256',
];
const REQUIRED_RULES = [
  'corrupt_payloads_remain_quarantined',
  'same_work_different_scan_is_not_byte_identity',
  'same_title_different_version_is_not_corroboration',
  'unresolved_text_conflicts_block_citation',
  'office_pagination_is_not_a_stable_locator',
  'non_pdf_text_requires_artifact_and_paragraph_anchors',
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function catalogIdentitySha256(record) {
  return sha256(JSON.stringify(WORK_IDENTITY_FIELDS.map((field) => record?.[field] ?? null)));
}

function canonicalArtifactIdentitySha256(record) {
  return sha256(JSON.stringify(
    CANONICAL_ARTIFACT_IDENTITY_FIELDS.map((field) => record?.[field] ?? null),
  ));
}

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function safePath(root, path) {
  const absolute = resolve(root, String(path || ''));
  const relation = relative(root, absolute);
  if (relation === '..' || relation.startsWith('../') || relation.startsWith('..\\')) {
    throw new Error(`path escapes project root: ${path}`);
  }
  return absolute;
}

function checkUrl(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function pdfPageCount(path, runCommand = spawnSync) {
  const result = runCommand('/opt/homebrew/bin/pdfinfo', [path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`pdfinfo failed for ${path}: ${String(result.stderr || '').trim()}`);
  const match = String(result.stdout || '').match(/^Pages:\s+(\d+)$/m);
  if (!match) throw new Error(`pdfinfo did not report Pages for ${path}`);
  return Number(match[1]);
}

function pdfPageCountFromBytes(bytes, label, runCommand = spawnSync) {
  const result = runCommand('/opt/homebrew/bin/pdfinfo', ['-'], {
    input: bytes,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`pdfinfo failed for archive member ${label}: ${String(result.stderr || '').trim()}`);
  }
  const match = String(result.stdout || '').match(/^Pages:\s+(\d+)$/m);
  if (!match) throw new Error(`pdfinfo did not report Pages for archive member ${label}`);
  return Number(match[1]);
}

function archiveMemberPaths(path, runCommand = spawnSync) {
  const result = runCommand('/usr/bin/bsdtar', ['-tf', path], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`bsdtar list failed for ${path}: ${String(result.stderr || '').trim()}`);
  return String(result.stdout || '')
    .split(/\r?\n/)
    .filter((entry) => entry.toLowerCase().endsWith('.pdf'));
}

function readArchiveMember(path, memberPath, runCommand = spawnSync) {
  const result = runCommand('/usr/bin/bsdtar', ['-xOf', path, memberPath], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`bsdtar extract failed for ${memberPath}: ${String(result.stderr || '').trim()}`);
  return Buffer.from(result.stdout);
}

function extractOfficeText(path, runCommand = spawnSync) {
  const result = runCommand('/usr/bin/textutil', ['-convert', 'txt', '-stdout', path], {
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`textutil failed for ${path}: ${Buffer.from(result.stderr || '').toString('utf8').trim()}`);
  }
  return Buffer.from(result.stdout);
}

function issue(errors, code, detail) {
  errors.push({ code, detail });
}

export async function validateSourceRecoveryProofs({
  root = DEFAULT_ROOT,
  proofs = null,
  catalog = null,
  artifactRegistry = null,
  ocrQueue = null,
  requireLocal = false,
  deepArchive = requireLocal,
  runCommand = spawnSync,
} = {}) {
  const projectRoot = resolve(root instanceof URL ? fileURLToPath(root) : root);
  const [proofData, catalogData, registryData, queueData] = await Promise.all([
    proofs || readFile(resolve(projectRoot, 'data/source-recovery-proofs.json'), 'utf8').then(JSON.parse),
    catalog || readFile(resolve(projectRoot, 'data/catalog.json'), 'utf8').then(JSON.parse),
    artifactRegistry || readFile(resolve(projectRoot, 'data/artifact-registry.json'), 'utf8').then(JSON.parse),
    ocrQueue || readFile(resolve(projectRoot, 'data/ocr-queue.json'), 'utf8').then(JSON.parse),
  ]);
  const errors = [];
  const documentById = new Map((catalogData.documents || []).map((record) => [record.id, record]));
  const quarantines = (registryData.artifacts || [])
    .filter((artifact) => artifact.disposition === 'quarantine' && artifact.intended_document_id);
  const quarantinesByDocument = new Map();
  for (const artifact of quarantines) {
    const records = quarantinesByDocument.get(artifact.intended_document_id) || [];
    records.push(artifact);
    quarantinesByDocument.set(artifact.intended_document_id, records);
  }

  if (!exactKeys(proofData, [
    '$schema', 'schema_version', 'policy', 'reviewed_at', 'reviewed_by', 'rules',
    'corrupt_payload_recoveries', 'official_archives', 'official_same_work_scan_variants',
    'same_work_scan_variant_context', 'native_attachments',
    'work_identity_fields', 'canonical_artifact_identity_fields',
    'catalog_identity_sha256_by_document', 'catalog_canonical_artifact_sha256_by_document',
  ])) issue(errors, 'root_contract', 'root keys are not exact');
  if (proofData.$schema !== './source-recovery-proofs.schema.json'
    || proofData.schema_version !== 2
    || proofData.policy !== 'exact_artifact_version_aware_source_recovery_v2') {
    issue(errors, 'root_identity', 'schema or policy identity is invalid');
  }
  if (JSON.stringify(proofData.work_identity_fields) !== JSON.stringify(WORK_IDENTITY_FIELDS)) {
    issue(errors, 'work_identity_fields', 'complete work identity field contract drifted');
  }
  if (JSON.stringify(proofData.canonical_artifact_identity_fields)
    !== JSON.stringify(CANONICAL_ARTIFACT_IDENTITY_FIELDS)) {
    issue(errors, 'canonical_artifact_identity_fields', 'canonical artifact identity field contract drifted');
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(proofData.reviewed_at || '')
    || Number.isNaN(Date.parse(proofData.reviewed_at))) issue(errors, 'review_time', 'reviewed_at is not exact UTC');
  if (typeof proofData.reviewed_by !== 'string' || !proofData.reviewed_by.trim()) issue(errors, 'reviewer', 'reviewed_by is missing');
  if (!exactKeys(proofData.rules, REQUIRED_RULES)
    || REQUIRED_RULES.some((rule) => proofData.rules?.[rule] !== true)) {
    issue(errors, 'rules', 'all fail-closed recovery rules must be explicitly true');
  }

  const recoveryIds = new Set();
  for (const recovery of proofData.corrupt_payload_recoveries || []) {
    if (!exactKeys(recovery, [
      'document_id', 'quarantine_artifact_id', 'corrupt_artifact', 'recovered_artifact',
      'relationship', 'canonical_use',
    ])) {
      issue(errors, 'corrupt_recovery_contract', recovery.document_id || '<missing>');
      continue;
    }
    if (!DOCUMENT_ID.test(recovery.document_id || '') || recoveryIds.has(recovery.document_id)) {
      issue(errors, 'corrupt_recovery_document_id', recovery.document_id || '<missing>');
    }
    recoveryIds.add(recovery.document_id);
    if (REQUIRED_CORRUPT_RECOVERY_IDS.get(recovery.document_id) !== recovery.quarantine_artifact_id) {
      issue(errors, 'corrupt_recovery_coverage', recovery.document_id);
    }
    const corrupt = recovery.corrupt_artifact || {};
    const recovered = recovery.recovered_artifact || {};
    if (!exactKeys(corrupt, ['sha256', 'bytes', 'path', 'zero_prefix_bytes', 'tail_start_offset', 'tail_sha256'])
      || !exactKeys(recovered, [
        'sha256', 'bytes', 'page_count', 'path', 'source_page_url', 'source_url',
        'source_archive_sha256', 'archive_member',
      ])) issue(errors, 'corrupt_recovery_artifact_contract', recovery.document_id);
    if (![corrupt.sha256, corrupt.tail_sha256, recovered.sha256]
      .every((value) => SHA256.test(value || ''))) issue(errors, 'corrupt_recovery_hash', recovery.document_id);
    if (!Number.isInteger(corrupt.bytes) || corrupt.bytes < 1 || corrupt.bytes !== recovered.bytes
      || !Number.isInteger(corrupt.zero_prefix_bytes) || corrupt.zero_prefix_bytes < 1
      || corrupt.zero_prefix_bytes !== corrupt.tail_start_offset
      || corrupt.zero_prefix_bytes >= corrupt.bytes) issue(errors, 'corrupt_recovery_length', recovery.document_id);
    if (!Number.isInteger(recovered.page_count) || recovered.page_count < 1
      || !checkUrl(recovered.source_page_url) || !checkUrl(recovered.source_url)
      || recovery.relationship !== 'same_length_zero_prefix_corruption_with_byte_identical_tail'
      || !['official_native_text', 'identity_witness_only'].includes(recovery.canonical_use)) {
      issue(errors, 'corrupt_recovery_relationship', recovery.document_id);
    }
    const documentQuarantines = quarantinesByDocument.get(recovery.document_id) || [];
    const quarantine = documentQuarantines[0];
    if (documentQuarantines.length !== 1 || quarantine?.artifact_id !== recovery.quarantine_artifact_id
      || quarantine.sha256 !== corrupt.sha256 || quarantine.size_bytes !== corrupt.bytes
      || quarantine.queue_eligible !== false || quarantine.publication_eligible !== false
      || !String(quarantine.note || '').includes('8192')
      || String(quarantine.note || '').includes('全零')) {
      issue(errors, 'quarantine_binding', recovery.document_id);
    }
    const document = documentById.get(recovery.document_id);
    if (!document) issue(errors, 'recovery_unknown_document', recovery.document_id);
    if (recovery.canonical_use === 'official_native_text'
      && (document?.checksum_sha256 !== recovered.sha256
        || document?.local_cache_path !== recovered.path
        || document?.page_count !== recovered.page_count
        || document?.source_url !== recovered.source_url
        || document?.source_page_url !== recovered.source_page_url
        || document?.text_quality_status !== 'official_native_text'
        || document?.citation_allowed !== true)) {
      issue(errors, 'canonical_recovery_catalog_binding', recovery.document_id);
    }
    if (recovery.canonical_use === 'identity_witness_only') {
      const variant = (document?.scan_variants || []).find((entry) => (
        entry.checksum_sha256 === recovered.sha256
      ));
      if (!variant || variant.local_cache_path !== recovered.path
        || variant.source_url !== recovered.source_url
        || variant.source_page_url !== recovered.source_page_url
        || variant.page_count !== recovered.page_count
        || variant.queue_eligible !== false || variant.publication_eligible !== false) {
        issue(errors, 'identity_recovery_catalog_binding', recovery.document_id);
      }
    }

    if (requireLocal) {
      try {
        const [corruptBytes, recoveredBytes] = await Promise.all([
          readFile(safePath(projectRoot, corrupt.path)),
          readFile(safePath(projectRoot, recovered.path)),
        ]);
        if (corruptBytes.length !== corrupt.bytes || sha256(corruptBytes) !== corrupt.sha256) issue(errors, 'corrupt_artifact_bytes', recovery.document_id);
        if (recoveredBytes.length !== recovered.bytes || sha256(recoveredBytes) !== recovered.sha256) issue(errors, 'recovered_artifact_bytes', recovery.document_id);
        if (!corruptBytes.subarray(0, corrupt.zero_prefix_bytes).every((byte) => byte === 0)) issue(errors, 'corrupt_prefix_not_zero', recovery.document_id);
        if (sha256(corruptBytes.subarray(corrupt.tail_start_offset)) !== corrupt.tail_sha256
          || sha256(recoveredBytes.subarray(corrupt.tail_start_offset)) !== corrupt.tail_sha256) {
          issue(errors, 'corrupt_tail_mismatch', recovery.document_id);
        }
        if (!recoveredBytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) issue(errors, 'recovered_pdf_magic', recovery.document_id);
        if (pdfPageCount(safePath(projectRoot, recovered.path), runCommand) !== recovered.page_count) issue(errors, 'recovered_pdf_pages', recovery.document_id);
      } catch (error) {
        issue(errors, 'local_recovery_read', `${recovery.document_id}: ${error.message}`);
      }
    }
  }
  if (recoveryIds.size !== REQUIRED_CORRUPT_RECOVERY_IDS.size
    || [...REQUIRED_CORRUPT_RECOVERY_IDS.keys()].some((documentId) => !recoveryIds.has(documentId))) {
    issue(errors, 'corrupt_recovery_coverage', `expected ${[...REQUIRED_CORRUPT_RECOVERY_IDS.keys()].join(',')}`);
  }
  const recoveryQuarantineIds = (proofData.corrupt_payload_recoveries || [])
    .map((entry) => entry.quarantine_artifact_id);
  if (new Set(recoveryQuarantineIds).size !== recoveryQuarantineIds.length
    || [...REQUIRED_CORRUPT_RECOVERY_IDS].some(([documentId, artifactId]) => {
      const matches = quarantines.filter((artifact) => (
        artifact.intended_document_id === documentId && artifact.artifact_id === artifactId
      ));
      return matches.length !== 1;
    })) issue(errors, 'quarantine_one_to_one', 'corrupt recoveries and quarantine artifacts are not bijective');

  const archiveIds = new Set();
  const archiveBySha256 = new Map();
  const archiveMemberByDocument = new Map();
  for (const archive of proofData.official_archives || []) {
    if (!exactKeys(archive, [
      'archive_id', 'source_page_url', 'source_url', 'path', 'media_type', 'sha256', 'bytes',
      'expected_magic_hex', 'member_count', 'members',
    ])) issue(errors, 'archive_contract', archive.archive_id || '<missing>');
    if (!archive.archive_id || archiveIds.has(archive.archive_id)) issue(errors, 'archive_id', archive.archive_id || '<missing>');
    archiveIds.add(archive.archive_id);
    if (!SHA256.test(archive.sha256 || '') || !Number.isInteger(archive.bytes) || archive.bytes < 1
      || !/^[0-9a-f]+$/.test(archive.expected_magic_hex || '')
      || !checkUrl(archive.source_page_url) || !checkUrl(archive.source_url)
      || archive.member_count !== archive.members?.length) issue(errors, 'archive_identity', archive.archive_id);
    if (archiveBySha256.has(archive.sha256)) issue(errors, 'archive_sha256_duplicate', archive.archive_id);
    archiveBySha256.set(archive.sha256, archive);
    const memberNames = new Set();
    for (const tuple of archive.members || []) {
      if (!Array.isArray(tuple) || tuple.length !== 6) {
        issue(errors, 'archive_member_contract', archive.archive_id);
        continue;
      }
      const [documentId, title, filename, memberSha, bytes, pages] = tuple;
      if (!DOCUMENT_ID.test(documentId || '') || memberNames.has(filename) || archiveMemberByDocument.has(documentId)
        || typeof title !== 'string' || !title || typeof filename !== 'string' || !filename.endsWith('.pdf')
        || !SHA256.test(memberSha || '') || !Number.isInteger(bytes) || bytes < 1
        || !Number.isInteger(pages) || pages < 1) issue(errors, 'archive_member_identity', `${archive.archive_id}:${documentId}`);
      memberNames.add(filename);
      archiveMemberByDocument.set(documentId, tuple);
      const document = documentById.get(documentId);
      const expectedPath = `${dirname(archive.path)}/${filename}`.replaceAll('\\', '/');
      const isArchiveRecovery = (proofData.corrupt_payload_recoveries || []).some((entry) => (
        entry.document_id === documentId && entry.recovered_artifact.archive_member === filename
      ));
      if (!document || document.title !== title || document.checksum_sha256 !== memberSha
        || document.page_count !== pages || document.file_format !== 'pdf_local'
        || (isArchiveRecovery && (
          document.local_cache_path !== expectedPath
          || document.source_page_url !== archive.source_page_url
          || document.source_url !== archive.source_url
        ))) {
        issue(errors, 'archive_member_catalog_binding', documentId);
      }
    }
    if (requireLocal) {
      try {
        const archivePath = safePath(projectRoot, archive.path);
        const bytes = await readFile(archivePath);
        if (bytes.length !== archive.bytes || sha256(bytes) !== archive.sha256
          || !bytes.subarray(0, archive.expected_magic_hex.length / 2)
            .equals(Buffer.from(archive.expected_magic_hex, 'hex'))) issue(errors, 'archive_bytes', archive.archive_id);
        if (deepArchive) {
          const physicalMembers = archiveMemberPaths(archivePath, runCommand);
          const byBasename = new Map();
          for (const memberPath of physicalMembers) {
            const name = basename(memberPath);
            if (byBasename.has(name)) issue(errors, 'archive_duplicate_basename', name);
            byBasename.set(name, memberPath);
          }
          if (byBasename.size !== archive.member_count) issue(errors, 'archive_member_count', archive.archive_id);
          for (const [, , filename, memberSha, memberBytes, pages] of archive.members || []) {
            const memberPath = byBasename.get(filename);
            if (!memberPath) {
              issue(errors, 'archive_member_missing', filename);
              continue;
            }
            const payload = readArchiveMember(archivePath, memberPath, runCommand);
            if (payload.length !== memberBytes || sha256(payload) !== memberSha
              || !payload.subarray(0, 5).equals(Buffer.from('%PDF-'))) issue(errors, 'archive_member_bytes', filename);
            const recovered = (proofData.corrupt_payload_recoveries || [])
              .find((entry) => entry.recovered_artifact.archive_member === filename)?.recovered_artifact;
            if (recovered && recovered.sha256 !== memberSha) issue(errors, 'archive_recovery_member_binding', filename);
            if (pdfPageCountFromBytes(payload, filename, runCommand) !== pages) {
              issue(errors, 'archive_member_pages', filename);
            }
          }
        }
      } catch (error) {
        issue(errors, 'local_archive_read', `${archive.archive_id}: ${error.message}`);
      }
    }
  }
  if (archiveMemberByDocument.size !== 21) issue(errors, 'archive_2017_coverage', `expected 21, observed ${archiveMemberByDocument.size}`);

  for (const recovery of proofData.corrupt_payload_recoveries || []) {
    const recovered = recovery.recovered_artifact || {};
    if (recovered.source_archive_sha256 === null || recovered.archive_member === null) {
      if (recovered.source_archive_sha256 !== null || recovered.archive_member !== null
        || recovery.canonical_use !== 'identity_witness_only'
        || !String(recovered.source_url || '').toLowerCase().endsWith('.pdf')) {
        issue(errors, 'direct_recovery_binding', recovery.document_id);
      }
      continue;
    }
    const archive = archiveBySha256.get(recovered.source_archive_sha256);
    const member = archive?.members?.find((entry) => entry[2] === recovered.archive_member);
    if (!archive || archive.source_url !== recovered.source_url
      || archive.source_page_url !== recovered.source_page_url
      || !member || member[0] !== recovery.document_id
      || member[3] !== recovered.sha256 || member[4] !== recovered.bytes
      || member[5] !== recovered.page_count) {
      issue(errors, 'archive_recovery_binding', recovery.document_id);
    }
  }

  const scanContext = proofData.same_work_scan_variant_context || {};
  if (!exactKeys(scanContext, [
    'source_page_url', 'path_prefix', 'source_url_prefix', 'publication_eligible', 'purpose',
    'canonical_document_ids',
  ]) || scanContext.publication_eligible !== false
    || scanContext.purpose !== 'independent_same_work_version_witness'
    || !checkUrl(scanContext.source_page_url) || !checkUrl(scanContext.source_url_prefix)) {
    issue(errors, 'scan_context', 'same-work scan context is invalid');
  }
  const canonicalScanIds = new Set(scanContext.canonical_document_ids || []);
  const scanIds = new Set();
  for (const tuple of proofData.official_same_work_scan_variants || []) {
    if (!Array.isArray(tuple) || tuple.length !== 6) {
      issue(errors, 'scan_variant_contract', '<invalid tuple>');
      continue;
    }
    const [documentId, title, filename, artifactSha, bytes, pages] = tuple;
    const document = documentById.get(documentId);
    if (!DOCUMENT_ID.test(documentId || '') || scanIds.has(documentId) || !document
      || document.title !== title || !filename.endsWith('.pdf') || !SHA256.test(artifactSha || '')
      || !Number.isInteger(bytes) || bytes < 1 || !Number.isInteger(pages) || pages < 1
      || document.page_count !== pages) issue(errors, 'scan_variant_identity', documentId || '<missing>');
    scanIds.add(documentId);
    const localPath = `${scanContext.path_prefix}${filename}`;
    const sourceUrl = `${scanContext.source_url_prefix}${filename}`;
    if (canonicalScanIds.has(documentId)) {
      if (document.checksum_sha256 !== artifactSha || document.local_cache_path !== localPath
        || document.source_url !== sourceUrl || document.source_page_url !== scanContext.source_page_url
        || document.text_quality_status !== 'ocr_required' || document.citation_allowed !== false) {
        issue(errors, 'scan_canonical_binding', documentId);
      }
    } else {
      const variant = (document.scan_variants || []).find((entry) => entry.checksum_sha256 === artifactSha);
      if (!variant || variant.local_cache_path !== localPath || variant.page_count !== pages
        || variant.source_url !== sourceUrl || variant.publication_eligible !== false) {
        issue(errors, 'scan_variant_catalog_binding', documentId);
      }
      if (document.checksum_sha256 === artifactSha) issue(errors, 'scan_variant_not_independent', documentId);
    }
    if (requireLocal) {
      try {
        const path = safePath(projectRoot, localPath);
        const payload = await readFile(path);
        if (payload.length !== bytes || sha256(payload) !== artifactSha
          || !payload.subarray(0, 5).equals(Buffer.from('%PDF-'))) issue(errors, 'scan_variant_bytes', documentId);
        if (pdfPageCount(path, runCommand) !== pages) issue(errors, 'scan_variant_pages', documentId);
      } catch (error) {
        issue(errors, 'local_scan_variant_read', `${documentId}: ${error.message}`);
      }
    }
  }
  if (scanIds.size !== 16 || canonicalScanIds.size !== 1 || !scanIds.has('ictr-24bb45bda31b')) {
    issue(errors, 'scan_2003_coverage', `scan_ids=${scanIds.size} canonical_ids=${canonicalScanIds.size}`);
  }

  const attachmentIds = new Set();
  for (const attachment of proofData.native_attachments || []) {
    if (!exactKeys(attachment, [
      'document_id', 'canonical', 'variants', 'conflicts', 'text_status', 'citation_allowed',
      'pagination_status',
    ], ['online_text_witness'])) issue(errors, 'attachment_contract', attachment.document_id || '<missing>');
    if (!DOCUMENT_ID.test(attachment.document_id || '') || attachmentIds.has(attachment.document_id)) {
      issue(errors, 'attachment_id', attachment.document_id || '<missing>');
    }
    attachmentIds.add(attachment.document_id);
    const artifacts = [attachment.canonical, ...(attachment.variants || [])];
    for (const artifact of artifacts) {
      if (!exactKeys(artifact, [
        'provider', 'source_page_url', 'source_url', 'path', 'media_type', 'sha256', 'bytes',
        'text_path', 'text_sha256', 'text_bytes',
      ]) || !checkUrl(artifact.source_page_url) || !checkUrl(artifact.source_url)
        || !SHA256.test(artifact.sha256 || '') || !SHA256.test(artifact.text_sha256 || '')
        || !Number.isInteger(artifact.bytes) || artifact.bytes < 1
        || !Number.isInteger(artifact.text_bytes) || artifact.text_bytes < 1
        || !/\.docx?$/.test(artifact.path || '') || !/\.txt$/.test(artifact.text_path || '')) {
        issue(errors, 'attachment_artifact', attachment.document_id);
      }
    }
    if (!['native_text_version_conflict', 'native_text_structure_review'].includes(attachment.text_status)
      || attachment.citation_allowed !== false || attachment.pagination_status !== 'unstable_office_layout') {
      issue(errors, 'attachment_disposition', attachment.document_id);
    }
    const document = documentById.get(attachment.document_id);
    if (!document || document.checksum_sha256 !== attachment.canonical.sha256
      || document.local_cache_path !== attachment.canonical.path
      || document.source_url !== attachment.canonical.source_url
      || document.source_page_url !== attachment.canonical.source_page_url
      || document.text_quality_status !== attachment.text_status
      || document.citation_allowed !== false || document.page_count !== null) {
      issue(errors, 'attachment_catalog_binding', attachment.document_id);
    }
    if ((attachment.conflicts || []).length > 0 && attachment.text_status !== 'native_text_version_conflict') {
      issue(errors, 'attachment_conflict_disposition', attachment.document_id);
    }
    for (const conflict of attachment.conflicts || []) {
      if (!exactKeys(conflict, [
        'conflict_id', 'locator', 'canonical_text', 'variant_text', 'status', 'publication_effect',
      ]) || !conflict.conflict_id || conflict.canonical_text === conflict.variant_text
        || conflict.status !== 'unresolved_attachment_revision'
        || conflict.publication_effect !== 'exact_artifact_binding_required') {
        issue(errors, 'attachment_conflict', attachment.document_id);
      }
    }
    if (attachment.text_status === 'native_text_version_conflict' && (attachment.conflicts || []).length === 0) {
      issue(errors, 'attachment_conflict_omitted', attachment.document_id);
    }
    if (requireLocal) {
      const texts = [];
      for (const artifact of artifacts) {
        try {
          const [binary, text] = await Promise.all([
            readFile(safePath(projectRoot, artifact.path)),
            readFile(safePath(projectRoot, artifact.text_path)),
          ]);
          const expectedMagic = artifact.path.endsWith('.docx')
            ? Buffer.from('504b0304', 'hex')
            : Buffer.from('d0cf11e0a1b11ae1', 'hex');
          if (binary.length !== artifact.bytes || sha256(binary) !== artifact.sha256
            || !binary.subarray(0, expectedMagic.length).equals(expectedMagic)) issue(errors, 'attachment_binary_bytes', artifact.path);
          if (text.length !== artifact.text_bytes || sha256(text) !== artifact.text_sha256) issue(errors, 'attachment_text_bytes', artifact.text_path);
          const extractedText = extractOfficeText(safePath(projectRoot, artifact.path), runCommand);
          if (!extractedText.equals(text)) issue(errors, 'attachment_text_derivation', artifact.path);
          texts.push(text.toString('utf8'));
        } catch (error) {
          issue(errors, 'local_attachment_read', `${attachment.document_id}: ${error.message}`);
        }
      }
      if (attachment.document_id === 'ictr-a027c4d6e30e' && texts.length === 2) {
        if (texts[0].length !== texts[1].length) issue(errors, 'political_variant_length', attachment.document_id);
        const mismatches = [];
        for (let index = 0; index < Math.min(texts[0].length, texts[1].length); index += 1) {
          if (texts[0][index] !== texts[1][index]) mismatches.push([index, texts[0][index], texts[1][index]]);
        }
        if (mismatches.length !== 1 || mismatches[0][1] !== '解' || mismatches[0][2] !== '节') {
          issue(errors, 'political_variant_not_one_character', JSON.stringify(mismatches.slice(0, 4)));
        }
        const conflict = attachment.conflicts?.[0];
        if (!texts[0].includes(conflict?.canonical_text || '') || !texts[1].includes(conflict?.variant_text || '')) {
          issue(errors, 'political_conflict_text_unbound', attachment.document_id);
        }
      }
    }
  }
  if (attachmentIds.size !== 5) issue(errors, 'native_attachment_coverage', `expected 5, observed ${attachmentIds.size}`);

  const identityBindings = proofData.catalog_identity_sha256_by_document;
  const canonicalArtifactBindings = proofData.catalog_canonical_artifact_sha256_by_document;
  const governedDocumentIds = new Set([
    ...recoveryIds,
    ...archiveMemberByDocument.keys(),
    ...scanIds,
    ...attachmentIds,
  ]);
  if (!identityBindings || typeof identityBindings !== 'object' || Array.isArray(identityBindings)) {
    issue(errors, 'catalog_identity_contract', 'catalog identity bindings must be an object');
  } else {
    const boundIds = Object.keys(identityBindings);
    if (boundIds.length !== governedDocumentIds.size
      || boundIds.some((documentId) => !governedDocumentIds.has(documentId))) {
      issue(errors, 'catalog_identity_coverage', `expected ${governedDocumentIds.size}, observed ${boundIds.length}`);
    }
    for (const documentId of governedDocumentIds) {
      const document = documentById.get(documentId);
      const expected = document ? catalogIdentitySha256(document) : null;
      if (!SHA256.test(identityBindings[documentId] || '') || identityBindings[documentId] !== expected) {
        issue(errors, 'catalog_work_version_binding', documentId);
      }
    }
  }
  if (!canonicalArtifactBindings || typeof canonicalArtifactBindings !== 'object'
    || Array.isArray(canonicalArtifactBindings)) {
    issue(errors, 'catalog_canonical_artifact_contract', 'canonical artifact bindings must be an object');
  } else {
    const boundIds = Object.keys(canonicalArtifactBindings);
    if (boundIds.length !== governedDocumentIds.size
      || boundIds.some((documentId) => !governedDocumentIds.has(documentId))) {
      issue(errors, 'catalog_canonical_artifact_coverage', `expected ${governedDocumentIds.size}, observed ${boundIds.length}`);
    }
    for (const documentId of governedDocumentIds) {
      const document = documentById.get(documentId);
      const expected = document ? canonicalArtifactIdentitySha256(document) : null;
      if (!SHA256.test(canonicalArtifactBindings[documentId] || '')
        || canonicalArtifactBindings[documentId] !== expected) {
        issue(errors, 'catalog_canonical_artifact_binding', documentId);
      }
    }
  }

  const queueDocuments = queueData.documents || [];
  const queueIds = new Set();
  for (const queued of queueDocuments) {
    const document = documentById.get(queued.id);
    if (!document || queueIds.has(queued.id)
      || queued.local_cache_path !== document.local_cache_path
      || queued.source_sha256 !== document.checksum_sha256
      || queued.page_count !== document.page_count
      || !String(queued.local_cache_path || '').toLowerCase().endsWith('.pdf')) {
      issue(errors, 'queue_catalog_binding', queued.id || '<missing>');
    }
    queueIds.add(queued.id);
  }

  const canonicalPdfDocuments = (catalogData.documents || []).filter((document) => (
    String(document.local_cache_path || '').toLowerCase().endsWith('.pdf')
    && SHA256.test(document.checksum_sha256 || '')
    && Number.isInteger(document.page_count)
    && document.page_count > 0
  ));
  if (requireLocal) {
    for (const document of canonicalPdfDocuments) {
      try {
        const absolute = safePath(projectRoot, document.local_cache_path);
        if (pdfPageCount(absolute, runCommand) !== document.page_count) {
          issue(errors, 'canonical_pdf_pages', document.id);
        }
      } catch (error) {
        issue(errors, 'canonical_pdf_pages', `${document.id}: ${error.message}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    counts: {
      corrupt_recoveries: recoveryIds.size,
      official_archives: archiveIds.size,
      archive_members: archiveMemberByDocument.size,
      official_same_work_scans: scanIds.size,
      native_attachments: attachmentIds.size,
      unresolved_conflicts: (proofData.native_attachments || []).reduce((sum, entry) => sum + (entry.conflicts || []).length, 0),
      canonical_pdf_documents: canonicalPdfDocuments.length,
      queue_documents: queueDocuments.length,
    },
  };
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, requireLocal: false, deepArchive: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--require-local') options.requireLocal = true;
    else if (argument === '--deep-archive') options.deepArchive = true;
    else if (argument === '--root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--root requires a path');
      options.root = value;
      index += 1;
    } else throw new Error(`unexpected argument: ${argument}`);
  }
  if (options.deepArchive && !options.requireLocal) throw new Error('--deep-archive requires --require-local');
  return options;
}

async function main() {
  const report = await validateSourceRecoveryProofs(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`source-recovery-proof: ${error.message}\n`);
    process.exitCode = 1;
  });
}
