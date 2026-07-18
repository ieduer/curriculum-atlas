import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  isNativeTextRecord,
  validatePagePublicationManifest,
} from './page-publication-gate.mjs';
import {
  createSemanticPublicationGate,
  semanticDocumentDisposition,
  semanticPageDisposition,
} from './semantic-publication-gate.mjs';
import { validatePageEvidenceForRelease } from './page-evidence-release-hook.mjs';
import { loadDocumentClassificationResolver } from './document-classification.mjs';
import { computeCorpusReleaseFingerprint } from './lib/corpus-release-fingerprint.mjs';
import { createImmutableFileSnapshot } from './lib/immutable-release-snapshot.mjs';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RELEASE_ID_PATTERN = /^corpus-[a-f0-9]{24}$/;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const CORPUS_MANIFEST_PROJECTION_KEYS = [
  'generated_at',
  'schema_version',
  'release_id',
  'release_fingerprint_sha256',
  'documents',
  'paragraphs',
  'fts_rows',
  'page_publication_gates',
  'displayed_paragraphs',
  'accepted_ocr_documents',
  'core_table_counts',
  'text_asset_count',
  'text_assets',
  'sql_chunks',
  'sql_files',
  'closed_ocr_paragraphs',
  'skipped_ocr_documents',
  'excluded_exact_duplicate_alias_documents',
  'semantic_excluded_pages',
  'page_publication_schema_version',
  'semantic_publication_schema_version',
  'semantic_publication_revision_sha256',
];
export const CORPUS_MANIFEST_KEYS = [...CORPUS_MANIFEST_PROJECTION_KEYS, 'manifest_sha256'];
export const CORE_TABLE_COUNT_KEYS = [
  'subjects',
  'periods',
  'document_relations',
  'chapters',
  'document_classifications',
  'document_sources',
  'primary_document_sources',
  'subject_insights',
  'terms',
  'term_relations',
  'version_diffs',
  'online_verifications',
  'online_evidence',
];
const LEGACY_ZERO_CORE_TABLES = new Set([
  'subjects',
  'document_relations',
  'chapters',
  'version_diffs',
]);

function sql(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildParagraphIdentityGuardSql(rows, chunkName) {
  if (rows.length === 0) return '';
  const guardKey = `paragraph_identity:${chunkName}`;
  const values = rows.map((row) => `(${[
    row.document_id,
    row.ordinal,
    row.page_number,
    row.heading,
    row.source_locator,
    row.body_sha256,
    row.provenance_locator,
  ].map(sql).join(',')})`).join(',\n    ');
  return `DELETE FROM corpus_import_guards WHERE guard_key=${sql(guardKey)};
WITH incoming(document_id,ordinal,page_number,heading,source_locator,body_sha256,provenance_locator) AS (
  VALUES ${values}
)
INSERT INTO corpus_import_guards(guard_key,ok)
SELECT ${sql(guardKey)},CASE WHEN NOT EXISTS(
  SELECT 1 FROM incoming i
  JOIN paragraphs p ON p.document_id=i.document_id AND p.ordinal=i.ordinal
  WHERE (
       EXISTS(SELECT 1 FROM comments c WHERE c.paragraph_id=p.id)
    OR EXISTS(SELECT 1 FROM online_verifications v WHERE v.paragraph_id=p.id)
  ) AND (p.page_number IS NOT i.page_number
     OR p.heading IS NOT i.heading
     OR p.source_locator IS NOT i.source_locator
     OR p.body_sha256 IS NOT i.body_sha256
     OR p.provenance_locator IS NOT i.provenance_locator)
) THEN 1 ELSE 0 END;
DELETE FROM corpus_import_guards WHERE guard_key=${sql(guardKey)};`;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a safe non-negative integer`);
  return value;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value);
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  const extra = actual.filter((key) => !expected.includes(key));
  if (missing.length || extra.length) {
    throw new Error(`${label} must contain exactly the supported fields; missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`);
  }
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP_PATTERN.test(value)
      || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be a canonical millisecond UTC timestamp`);
  }
  return value;
}

export function normalizeCorpusBlock(value) {
  return value
    .replace(/\u0000/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(/\s+([，。；：！？、])/g, '$1')
    .trim();
}

export function isUsefulCorpusBlock(value) {
  if (value.length < 24 || value.length > 2200) return false;
  const meaningful = (value.match(/[\p{Script=Han}A-Za-z0-9]/gu) || []).length;
  return meaningful / value.length > 0.55 && !/^(目\s*录|contents?)$/i.test(value);
}

function sha256Asset(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const sha256 = String(value.sha256 || '');
  if (!SHA256_PATTERN.test(sha256)) throw new Error(`${label}.sha256 is invalid`);
  const bytes = nonNegativeInteger(value.bytes, `${label}.bytes`);
  if (bytes === 0) throw new Error(`${label}.bytes must be positive`);
  return { sha256, bytes };
}

function validateTextAssets(value, count) {
  if (!Array.isArray(value) || value.length !== count) {
    throw new Error(`text_assets must contain exactly ${count} records`);
  }
  const ids = new Set();
  return value.map((entry, index) => {
    const label = `text_assets[${index}]`;
    const documentId = String(entry?.document_id || '');
    if (!documentId || documentId.length > 160 || /[/\\\0]/.test(documentId)) {
      throw new Error(`${label}.document_id is invalid`);
    }
    if (ids.has(documentId)) throw new Error(`text_assets contains duplicate document_id: ${documentId}`);
    ids.add(documentId);
    return { document_id: documentId, ...sha256Asset(entry, label) };
  });
}

function validateSqlFiles(value, count) {
  if (!Array.isArray(value) || value.length !== count || count < 1) {
    throw new Error(`sql_files must contain exactly ${count} records`);
  }
  return value.map((entry, index) => {
    const expectedName = index === 0
      ? '000-core.sql'
      : `${String(index).padStart(3, '0')}-paragraphs.sql`;
    const name = String(entry?.name || '');
    if (name !== expectedName) throw new Error(`sql_files[${index}].name must equal ${expectedName}`);
    return { name, ...sha256Asset(entry, `sql_files[${index}]`) };
  });
}

function validateCoreTableCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('core_table_counts must be an object');
  }
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== CORE_TABLE_COUNT_KEYS.length
      || CORE_TABLE_COUNT_KEYS.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`core_table_counts must contain exactly: ${CORE_TABLE_COUNT_KEYS.join(', ')}`);
  }
  const counts = {};
  for (const key of CORE_TABLE_COUNT_KEYS) {
    counts[key] = nonNegativeInteger(value[key], `core_table_counts.${key}`);
    if (LEGACY_ZERO_CORE_TABLES.has(key) && counts[key] !== 0) {
      throw new Error(`core_table_counts.${key} must equal 0`);
    }
  }
  return counts;
}

function normalizeCorpusManifestProjection(value, { exactProjection = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('corpus manifest must be an object');
  if (exactProjection) assertExactKeys(value, CORPUS_MANIFEST_PROJECTION_KEYS, 'corpus manifest projection');
  if (value.schema_version !== 1) throw new Error('corpus manifest schema_version must equal 1');
  if (!RELEASE_ID_PATTERN.test(String(value.release_id || ''))) throw new Error('corpus manifest release_id is invalid');
  if (!SHA256_PATTERN.test(String(value.release_fingerprint_sha256 || ''))) {
    throw new Error('corpus manifest release_fingerprint_sha256 is invalid');
  }
  const releaseFingerprint = String(value.release_fingerprint_sha256);
  if (value.release_id !== `corpus-${releaseFingerprint.slice(0, 24)}`) {
    throw new Error('corpus manifest release_id does not match release fingerprint');
  }
  const textAssetCount = nonNegativeInteger(value.text_asset_count, 'text_asset_count');
  const sqlChunks = nonNegativeInteger(value.sql_chunks, 'sql_chunks');
  const manifest = {
    generated_at: canonicalTimestamp(value.generated_at, 'generated_at'),
    schema_version: 1,
    release_id: value.release_id,
    release_fingerprint_sha256: releaseFingerprint,
    documents: nonNegativeInteger(value.documents, 'documents'),
    paragraphs: nonNegativeInteger(value.paragraphs, 'paragraphs'),
    fts_rows: nonNegativeInteger(value.fts_rows, 'fts_rows'),
    page_publication_gates: nonNegativeInteger(value.page_publication_gates, 'page_publication_gates'),
    displayed_paragraphs: nonNegativeInteger(value.displayed_paragraphs, 'displayed_paragraphs'),
    accepted_ocr_documents: nonNegativeInteger(value.accepted_ocr_documents, 'accepted_ocr_documents'),
    core_table_counts: validateCoreTableCounts(value.core_table_counts),
    text_asset_count: textAssetCount,
    text_assets: validateTextAssets(value.text_assets, textAssetCount),
    sql_chunks: sqlChunks,
    sql_files: validateSqlFiles(value.sql_files, sqlChunks),
    closed_ocr_paragraphs: nonNegativeInteger(value.closed_ocr_paragraphs, 'closed_ocr_paragraphs'),
    skipped_ocr_documents: nonNegativeInteger(value.skipped_ocr_documents, 'skipped_ocr_documents'),
    excluded_exact_duplicate_alias_documents: nonNegativeInteger(
      value.excluded_exact_duplicate_alias_documents,
      'excluded_exact_duplicate_alias_documents',
    ),
    semantic_excluded_pages: nonNegativeInteger(value.semantic_excluded_pages, 'semantic_excluded_pages'),
    page_publication_schema_version: nonNegativeInteger(
      value.page_publication_schema_version,
      'page_publication_schema_version',
    ),
    semantic_publication_schema_version: nonNegativeInteger(
      value.semantic_publication_schema_version,
      'semantic_publication_schema_version',
    ),
    semantic_publication_revision_sha256: String(value.semantic_publication_revision_sha256 || ''),
  };
  if (!SHA256_PATTERN.test(manifest.semantic_publication_revision_sha256)) {
    throw new Error('semantic_publication_revision_sha256 is invalid');
  }
  if (manifest.fts_rows !== manifest.paragraphs) throw new Error('fts_rows must equal paragraphs');
  if (manifest.displayed_paragraphs > manifest.paragraphs) {
    throw new Error('displayed_paragraphs cannot exceed paragraphs');
  }
  if (manifest.displayed_paragraphs + manifest.closed_ocr_paragraphs !== manifest.paragraphs) {
    throw new Error('displayed_paragraphs plus closed_ocr_paragraphs must equal paragraphs');
  }
  if (manifest.text_asset_count + manifest.skipped_ocr_documents
      + manifest.excluded_exact_duplicate_alias_documents !== manifest.documents) {
    throw new Error('text asset, skipped OCR and exact duplicate alias document counts must equal documents');
  }
  if (manifest.accepted_ocr_documents > manifest.text_asset_count) {
    throw new Error('accepted_ocr_documents cannot exceed text_asset_count');
  }
  if (manifest.semantic_excluded_pages > manifest.page_publication_gates) {
    throw new Error('semantic_excluded_pages cannot exceed page_publication_gates');
  }
  if (manifest.page_publication_schema_version !== 1) {
    throw new Error('page_publication_schema_version must equal 1');
  }
  if (manifest.semantic_publication_schema_version !== 1) {
    throw new Error('semantic_publication_schema_version must equal 1');
  }
  if (manifest.core_table_counts.document_classifications !== manifest.documents) {
    throw new Error('core_table_counts.document_classifications must equal documents');
  }
  if (manifest.core_table_counts.primary_document_sources !== manifest.documents) {
    throw new Error('core_table_counts.primary_document_sources must equal documents');
  }
  if (manifest.core_table_counts.document_sources < manifest.core_table_counts.primary_document_sources) {
    throw new Error('core_table_counts.document_sources cannot be less than primary_document_sources');
  }
  return manifest;
}

export function sealCorpusManifest(projectionInput) {
  const projection = normalizeCorpusManifestProjection(projectionInput, { exactProjection: true });
  return {
    ...projection,
    manifest_sha256: createHash('sha256').update(JSON.stringify(projection)).digest('hex'),
  };
}

export function validateCorpusManifest(value, sqlFileCount = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('corpus manifest must be an object');
  assertExactKeys(value, CORPUS_MANIFEST_KEYS, 'corpus manifest');
  if (!SHA256_PATTERN.test(String(value.manifest_sha256 || ''))) throw new Error('corpus manifest manifest_sha256 is invalid');
  const manifest = normalizeCorpusManifestProjection(value);
  if (sqlFileCount !== null && manifest.sql_chunks !== sqlFileCount) {
    throw new Error(`corpus manifest expects ${manifest.sql_chunks} SQL chunks but found ${sqlFileCount}`);
  }
  const actualManifestSha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  if (actualManifestSha256 !== value.manifest_sha256) throw new Error('corpus manifest hash mismatch');
  return { ...manifest, manifest_sha256: value.manifest_sha256 };
}

export async function validateCorpusManifestSourceBindings(manifestInput, { root } = {}) {
  const manifest = validateCorpusManifest(manifestInput);
  if (!root) throw new Error('corpus manifest source binding validation requires root');
  const source = (relativePath) => root instanceof URL
    ? new URL(relativePath, root)
    : path.resolve(String(root), relativePath);
  const catalog = JSON.parse(await readFile(source('data/catalog.json'), 'utf8'));
  const ingest = JSON.parse(await readFile(source('data/ingest-manifest.json'), 'utf8'));
  const documentedSources = JSON.parse(
    await readFile(source('data/document-sources.json'), 'utf8'),
  ).sources;
  const insights = JSON.parse(await readFile(source('data/subject-insights.json'), 'utf8'));
  const onlineVerificationSamples = JSON.parse(
    await readFile(source('data/online-verification-samples.json'), 'utf8'),
  ).samples;
  const pagePublication = validatePagePublicationManifest(
    JSON.parse(await readFile(source('data/page-publication-manifest.json'), 'utf8')),
  );
  const semanticPublicationPolicy = JSON.parse(
    await readFile(source('data/semantic-publication-policy.json'), 'utf8'),
  );
  const semanticGate = createSemanticPublicationGate({
    policy: semanticPublicationPolicy,
    records: catalog.documents,
  });
  const classifyDocument = await loadDocumentClassificationResolver(
    root instanceof URL ? root : pathToFileURL(`${path.resolve(String(root))}${path.sep}`),
  );
  const classifications = catalog.documents.map((record) => classifyDocument(record));
  const unclassified = classifications.filter((item) => item.scope_kind === 'unclassified');
  if (unclassified.length) {
    throw new Error(`corpus manifest source classifications are unresolved: ${unclassified.map((item) => item.document_id).join(', ')}`);
  }
  if (manifest.documents !== catalog.documents.length) {
    throw new Error('corpus manifest documents do not match catalog');
  }
  if (manifest.page_publication_schema_version !== pagePublication.schema_version) {
    throw new Error('corpus manifest page publication schema does not match source');
  }
  if (manifest.semantic_publication_schema_version !== semanticGate.schema_version) {
    throw new Error('corpus manifest semantic publication schema does not match source');
  }
  if (manifest.semantic_publication_revision_sha256 !== semanticGate.revision_sha256) {
    throw new Error('corpus manifest semantic publication revision does not match source');
  }
  if (manifest.excluded_exact_duplicate_alias_documents !== semanticGate.aliasById.size) {
    throw new Error('corpus manifest exact duplicate alias count does not match source');
  }
  const sourceRows = new Map(
    catalog.documents.map((record) => [`${record.id}\0${record.source_url}`, { is_primary: 1 }]),
  );
  for (const record of documentedSources) {
    sourceRows.set(`${record.document_id}\0${record.source_url}`, record);
  }
  const expectedCoreTableCounts = {
    subjects: 0,
    periods: 5,
    document_relations: 0,
    chapters: 0,
    document_classifications: catalog.documents.length,
    document_sources: sourceRows.size,
    primary_document_sources: [...sourceRows.values()].filter((record) => Number(record.is_primary) === 1).length,
    subject_insights: insights.insights.length,
    terms: insights.terms.length,
    term_relations: insights.relations.length,
    version_diffs: 0,
    online_verifications: onlineVerificationSamples.length,
    online_evidence: onlineVerificationSamples.reduce(
      (count, verification) => count + verification.online_evidence.length,
      0,
    ),
  };
  if (JSON.stringify(manifest.core_table_counts) !== JSON.stringify(expectedCoreTableCounts)) {
    throw new Error('corpus manifest core_table_counts do not match source');
  }
  const pagePublicationByDocument = new Map(
    pagePublication.documents.map((document) => [document.document_id, document]),
  );
  const catalogById = new Map(catalog.documents.map((record) => [record.id, record]));
  for (const document of pagePublication.documents) {
    const record = catalogById.get(document.document_id);
    if (!record) throw new Error(`corpus page publication source is absent from catalog: ${document.document_id}`);
    if (semanticDocumentDisposition(semanticGate, record).excluded) {
      throw new Error(`corpus page publication source is an exact duplicate alias: ${document.document_id}`);
    }
    if (isNativeTextRecord(record)) {
      throw new Error(`corpus page publication source must not override native text: ${document.document_id}`);
    }
  }
  const expectedTextAssets = [];
  let skippedOcrDocuments = 0;
  let acceptedOcrDocuments = 0;
  let pagePublicationGates = 0;
  let semanticExcludedPages = 0;
  let paragraphs = 0;
  let displayedParagraphs = 0;
  let closedOcrParagraphs = 0;
  for (const record of catalog.documents) {
    if (semanticDocumentDisposition(semanticGate, record).excluded) continue;
    const nativeText = isNativeTextRecord(record);
    const acceptedOcr = pagePublicationByDocument.get(record.id);
    if (!nativeText && !acceptedOcr) {
      skippedOcrDocuments += 1;
      continue;
    }
    let raw;
    try {
      raw = await readFile(source(`.cache/text/${record.id}.txt`), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`corpus manifest source text is missing: ${record.id}`);
      }
      throw error;
    }
    expectedTextAssets.push({
      document_id: record.id,
      sha256: createHash('sha256').update(raw).digest('hex'),
      bytes: Buffer.byteLength(raw, 'utf8'),
    });
    if (!nativeText) acceptedOcrDocuments += 1;
    const pages = raw.split('\f');
    if (acceptedOcr && acceptedOcr.pages.length !== pages.length) {
      throw new Error(`corpus manifest OCR page count does not match source: ${record.id}`);
    }
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      pagePublicationGates += 1;
      const semantic = semanticPageDisposition({
        gate: semanticGate,
        record,
        pageNumber: pageIndex + 1,
        rawText: pages[pageIndex],
      });
      if (semantic.blocked) {
        semanticExcludedPages += 1;
        continue;
      }
      const displayAllowed = nativeText || acceptedOcr.pages[pageIndex].display_allowed;
      for (const candidate of pages[pageIndex].split(/\n\s*\n/)) {
        const body = normalizeCorpusBlock(candidate);
        if (!isUsefulCorpusBlock(body)) continue;
        paragraphs += 1;
        if (displayAllowed) displayedParagraphs += 1;
        else closedOcrParagraphs += 1;
      }
    }
  }
  const expected = {
    text_assets: expectedTextAssets,
    text_asset_count: expectedTextAssets.length,
    skipped_ocr_documents: skippedOcrDocuments,
    accepted_ocr_documents: acceptedOcrDocuments,
    page_publication_gates: pagePublicationGates,
    semantic_excluded_pages: semanticExcludedPages,
    paragraphs,
    fts_rows: paragraphs,
    displayed_paragraphs: displayedParagraphs,
    closed_ocr_paragraphs: closedOcrParagraphs,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (JSON.stringify(manifest[field]) !== JSON.stringify(value)) {
      throw new Error(`corpus manifest ${field} does not match source`);
    }
  }
  const expectedFingerprint = computeCorpusReleaseFingerprint({
    catalog,
    ingest,
    documentedSources,
    insights,
    onlineVerificationSamples,
    classifications,
    pagePublicationManifest: pagePublication,
    semanticPublicationPolicy,
    semanticPublicationRevisionSha256: semanticGate.revision_sha256,
    textAssets: expectedTextAssets,
  });
  if (manifest.release_fingerprint_sha256 !== expectedFingerprint) {
    throw new Error('corpus manifest release fingerprint does not match the complete live source inputs');
  }
  return manifest;
}

function coreCountsJsonSql(releaseId) {
  return `json_object(
    'subjects',(SELECT COUNT(*) FROM subjects),
    'periods',(SELECT COUNT(*) FROM periods),
    'document_relations',(SELECT COUNT(*) FROM document_relations),
    'chapters',(SELECT COUNT(*) FROM chapters),
    'document_classifications',(SELECT COUNT(*) FROM document_classifications dc JOIN documents d ON d.id=dc.document_id WHERE d.corpus_release_id=${releaseId}),
    'document_sources',(SELECT COUNT(*) FROM document_sources ds JOIN documents d ON d.id=ds.document_id WHERE d.corpus_release_id=${releaseId}),
    'primary_document_sources',(SELECT COUNT(*) FROM document_sources ds JOIN documents d ON d.id=ds.document_id WHERE d.corpus_release_id=${releaseId} AND ds.is_primary=1),
    'subject_insights',(SELECT COUNT(*) FROM subject_insights),
    'terms',(SELECT COUNT(*) FROM terms),
    'term_relations',(SELECT COUNT(*) FROM term_relations),
    'version_diffs',(SELECT COUNT(*) FROM version_diffs),
    'online_verifications',(SELECT COUNT(*) FROM online_verifications ov WHERE ov.corpus_release_id=${releaseId}),
    'online_evidence',(SELECT COUNT(*) FROM online_evidence oe JOIN online_verifications ov ON ov.id=oe.verification_id WHERE ov.corpus_release_id=${releaseId})
  )`;
}

function coreCountChecks(manifest, releaseId) {
  const counts = manifest.core_table_counts;
  return [
    `(SELECT COUNT(*) FROM subjects)=${counts.subjects}`,
    `(SELECT COUNT(*) FROM periods)=${counts.periods}`,
    `(SELECT COUNT(*) FROM document_relations)=${counts.document_relations}`,
    `(SELECT COUNT(*) FROM chapters)=${counts.chapters}`,
    `(SELECT COUNT(*) FROM document_classifications dc JOIN documents d ON d.id=dc.document_id WHERE d.corpus_release_id=${releaseId})=${counts.document_classifications}`,
    `(SELECT COUNT(*) FROM document_sources ds JOIN documents d ON d.id=ds.document_id WHERE d.corpus_release_id=${releaseId})=${counts.document_sources}`,
    `(SELECT COUNT(*) FROM document_sources ds JOIN documents d ON d.id=ds.document_id WHERE d.corpus_release_id=${releaseId} AND ds.is_primary=1)=${counts.primary_document_sources}`,
    `(SELECT COUNT(*) FROM subject_insights)=${counts.subject_insights}`,
    `(SELECT COUNT(*) FROM terms)=${counts.terms}`,
    `(SELECT COUNT(*) FROM term_relations)=${counts.term_relations}`,
    `(SELECT COUNT(*) FROM version_diffs)=${counts.version_diffs}`,
    `(SELECT COUNT(*) FROM online_verifications ov WHERE ov.corpus_release_id=${releaseId})=${counts.online_verifications}`,
    `(SELECT COUNT(*) FROM online_evidence oe JOIN online_verifications ov ON ov.id=oe.verification_id WHERE ov.corpus_release_id=${releaseId})=${counts.online_evidence}`,
  ];
}

export async function verifyCorpusSqlFiles(manifestInput, directory) {
  const manifest = validateCorpusManifest(manifestInput);
  const actualNames = (await readdir(directory))
    .filter((name) => /^\d{3}-(?:core|paragraphs)\.sql$/.test(name))
    .sort();
  const expectedNames = manifest.sql_files.map((entry) => entry.name);
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error('corpus SQL file set does not match manifest');
  }
  for (const expected of manifest.sql_files) {
    const content = await readFile(new URL(expected.name, directory));
    const actual = {
      bytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new Error(`corpus SQL file integrity mismatch: ${expected.name}`);
    }
  }
  return manifest;
}

export function buildCorpusImportStartSql(manifestInput, { resume = false } = {}) {
  const manifest = validateCorpusManifest(manifestInput);
  const expectedCoreCountsJson = JSON.stringify(manifest.core_table_counts);
  const resumeGuard = resume
    ? `AND EXISTS(
  SELECT 1 FROM corpus_import_releases
  WHERE release_id=${sql(manifest.release_id)}
    AND release_fingerprint_sha256=${sql(manifest.release_fingerprint_sha256)}
    AND manifest_sha256=${sql(manifest.manifest_sha256)}
    AND state IN ('in_progress','failed')
)`
    : '';
  const resetReceipts = resume
    ? ''
    : `DELETE FROM corpus_import_chunks WHERE release_id=${sql(manifest.release_id)};\n`;
  return `DELETE FROM corpus_import_guards WHERE guard_key='start';
INSERT INTO corpus_import_guards(guard_key,ok)
SELECT 'start',CASE WHEN NOT EXISTS(
  SELECT 1 FROM corpus_import_releases
  WHERE state = 'in_progress' AND release_id != ${sql(manifest.release_id)}
)
AND (SELECT COUNT(*) FROM subjects)=0
AND (SELECT COUNT(*) FROM periods)=${manifest.core_table_counts.periods}
AND (SELECT COUNT(*) FROM document_relations)=0
AND (SELECT COUNT(*) FROM chapters)=0
AND (SELECT COUNT(*) FROM version_diffs)=0
${resumeGuard}
THEN 1 ELSE 0 END;
INSERT INTO corpus_import_releases(
  release_id,release_fingerprint_sha256,manifest_sha256,state,expected_documents,expected_paragraphs,
  expected_fts_rows,expected_page_gates,expected_displayed_paragraphs,accepted_ocr_documents,
  expected_chunks,expected_core_counts_json,actual_documents,actual_paragraphs,actual_fts_rows,actual_page_gates,actual_displayed_paragraphs,actual_chunks,actual_core_counts_json,
  started_at,updated_at,ready_at,failure_reason
) VALUES(${[
    manifest.release_id, manifest.release_fingerprint_sha256, manifest.manifest_sha256, 'in_progress', manifest.documents,
    manifest.paragraphs, manifest.fts_rows, manifest.page_publication_gates,
    manifest.displayed_paragraphs, manifest.accepted_ocr_documents, manifest.sql_chunks, expectedCoreCountsJson,
  ].map(sql).join(',')},NULL,NULL,NULL,NULL,NULL,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL,NULL)
ON CONFLICT(release_id) DO UPDATE SET
  release_fingerprint_sha256=excluded.release_fingerprint_sha256,
  manifest_sha256=excluded.manifest_sha256,
  state='in_progress',
  expected_documents=excluded.expected_documents,
  expected_paragraphs=excluded.expected_paragraphs,
  expected_fts_rows=excluded.expected_fts_rows,
  expected_page_gates=excluded.expected_page_gates,
  expected_displayed_paragraphs=excluded.expected_displayed_paragraphs,
  accepted_ocr_documents=excluded.accepted_ocr_documents,
  expected_chunks=excluded.expected_chunks,
  expected_core_counts_json=excluded.expected_core_counts_json,
  actual_documents=NULL,actual_paragraphs=NULL,actual_fts_rows=NULL,
  actual_page_gates=NULL,actual_displayed_paragraphs=NULL,actual_chunks=NULL,
  actual_core_counts_json=NULL,
  updated_at=CURRENT_TIMESTAMP,ready_at=NULL,failure_reason=NULL;
${resetReceipts}INSERT INTO site_meta(key,value) VALUES('corpus_import_state','in_progress')
  ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP;
INSERT INTO site_meta(key,value) VALUES('current_corpus_release_id',${sql(manifest.release_id)})
  ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP;
INSERT INTO site_meta(key,value) VALUES('current_corpus_manifest_sha256',${sql(manifest.manifest_sha256)})
  ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP;
DELETE FROM corpus_import_guards WHERE guard_key='start';`;
}

export function buildCorpusChunkReceiptSql(manifestInput, chunkName, executed = null) {
  const manifest = validateCorpusManifest(manifestInput);
  const chunk = manifest.sql_files.find((entry) => entry.name === chunkName);
  if (!chunk) throw new Error(`chunk is not declared by corpus manifest: ${chunkName}`);
  const actual = executed || chunk;
  if (actual.sha256 !== chunk.sha256 || actual.bytes !== chunk.bytes) {
    throw new Error(`executed chunk bytes do not match corpus manifest: ${chunkName}`);
  }
  return `INSERT INTO corpus_import_chunks(release_id,chunk_name,chunk_sha256,chunk_bytes,imported_at)
VALUES(${sql(manifest.release_id)},${sql(chunk.name)},${sql(actual.sha256)},${sql(actual.bytes)},CURRENT_TIMESTAMP)
ON CONFLICT(release_id,chunk_name) DO UPDATE SET
  chunk_sha256=excluded.chunk_sha256,chunk_bytes=excluded.chunk_bytes,imported_at=CURRENT_TIMESTAMP;`;
}

export function buildCorpusImportFailureSql(manifestInput, reason = 'corpus_import_failed') {
  const manifest = validateCorpusManifest(manifestInput);
  const safeReason = String(reason).slice(0, 240);
  return `UPDATE corpus_import_releases
SET state='failed',failure_reason=${sql(safeReason)},updated_at=CURRENT_TIMESTAMP
WHERE release_id=${sql(manifest.release_id)} AND state!='ready';
UPDATE site_meta SET value='failed',updated_at=CURRENT_TIMESTAMP
WHERE key='corpus_import_state'
  AND (SELECT value FROM site_meta WHERE key='current_corpus_release_id')=${sql(manifest.release_id)}
  AND EXISTS(
    SELECT 1 FROM corpus_import_releases
    WHERE release_id=${sql(manifest.release_id)} AND state='failed'
  );`;
}

export function buildCorpusImportFinalizeSql(manifestInput) {
  const manifest = validateCorpusManifest(manifestInput);
  const releaseId = sql(manifest.release_id);
  const manifestSha256 = sql(manifest.manifest_sha256);
  const chunkValues = manifest.sql_files.map((chunk) => `(${[
    chunk.name, chunk.sha256, chunk.bytes,
  ].map(sql).join(',')})`).join(',\n    ');
  const coreChecks = coreCountChecks(manifest, releaseId).map((check) => `  AND ${check}`).join('\n');
  return `DELETE FROM corpus_import_guards WHERE guard_key='finalize';
INSERT INTO corpus_import_guards(guard_key,ok)
SELECT 'finalize',CASE WHEN
  (SELECT value FROM site_meta WHERE key='corpus_import_state')='in_progress'
  AND (SELECT value FROM site_meta WHERE key='current_corpus_release_id')=${releaseId}
  AND (SELECT value FROM site_meta WHERE key='current_corpus_manifest_sha256')=${manifestSha256}
  AND EXISTS(
    SELECT 1 FROM corpus_import_releases
    WHERE release_id=${releaseId}
      AND release_fingerprint_sha256=${sql(manifest.release_fingerprint_sha256)}
      AND manifest_sha256=${manifestSha256} AND state='in_progress'
  )
THEN 1 ELSE 0 END;

UPDATE paragraphs SET display_allowed=0,citation_allowed=0
WHERE corpus_release_id IS NULL OR corpus_release_id != ${releaseId};
DELETE FROM paragraph_fts
WHERE paragraph_id IN (
  SELECT id FROM paragraphs WHERE corpus_release_id IS NULL OR corpus_release_id != ${releaseId}
);
DELETE FROM paragraphs
WHERE (corpus_release_id IS NULL OR corpus_release_id != ${releaseId})
  AND NOT EXISTS (SELECT 1 FROM comments WHERE comments.paragraph_id=paragraphs.id)
  AND NOT EXISTS (SELECT 1 FROM online_verifications WHERE online_verifications.paragraph_id=paragraphs.id);
DELETE FROM page_publication_gates
WHERE corpus_release_id IS NULL OR corpus_release_id != ${releaseId};
UPDATE documents SET citation_allowed=0
WHERE corpus_release_id IS NULL OR corpus_release_id != ${releaseId};
UPDATE online_verifications SET citation_allowed=0
WHERE corpus_release_id IS NULL OR corpus_release_id != ${releaseId};
DELETE FROM online_verifications
WHERE (corpus_release_id IS NULL OR corpus_release_id != ${releaseId})
  AND paragraph_id IS NULL;

DELETE FROM corpus_import_guards WHERE guard_key='finalize';
WITH expected_chunks(chunk_name,chunk_sha256,chunk_bytes) AS (
  VALUES ${chunkValues}
)
INSERT INTO corpus_import_guards(guard_key,ok)
SELECT 'finalize',CASE WHEN
  (SELECT COUNT(*) FROM documents WHERE corpus_release_id=${releaseId})=${manifest.documents}
  AND (SELECT COUNT(*) FROM paragraphs WHERE corpus_release_id=${releaseId})=${manifest.paragraphs}
  AND (SELECT COUNT(*) FROM paragraph_fts)=${manifest.fts_rows}
  AND (SELECT COUNT(*) FROM page_publication_gates WHERE corpus_release_id=${releaseId})=${manifest.page_publication_gates}
  AND (SELECT COUNT(*) FROM page_publication_gates)=${manifest.page_publication_gates}
  AND (SELECT COUNT(*) FROM paragraphs WHERE corpus_release_id=${releaseId} AND display_allowed=1)=${manifest.displayed_paragraphs}
  AND (SELECT COUNT(DISTINCT document_id) FROM page_publication_gates
       WHERE corpus_release_id=${releaseId} AND publication_basis='accepted_ocr_page_manifest')=${manifest.accepted_ocr_documents}
  AND (SELECT COUNT(*) FROM corpus_import_chunks WHERE release_id=${releaseId})=${manifest.sql_chunks}
  AND (SELECT COUNT(*) FROM expected_chunks e
       JOIN corpus_import_chunks c
         ON c.release_id=${releaseId} AND c.chunk_name=e.chunk_name
        AND c.chunk_sha256=e.chunk_sha256 AND c.chunk_bytes=e.chunk_bytes)=${manifest.sql_chunks}
${coreChecks}
  AND NOT EXISTS(
    SELECT 1 FROM paragraphs p
    LEFT JOIN documents d ON d.id=p.document_id AND d.corpus_release_id=${releaseId}
    WHERE p.corpus_release_id=${releaseId} AND d.id IS NULL
  )
  AND NOT EXISTS(
    SELECT 1 FROM documents d
    LEFT JOIN document_classifications dc ON dc.document_id=d.id
    WHERE d.corpus_release_id=${releaseId} AND dc.document_id IS NULL
  )
  AND NOT EXISTS(
    SELECT 1 FROM documents d
    LEFT JOIN document_sources ds ON ds.document_id=d.id AND ds.is_primary=1
    WHERE d.corpus_release_id=${releaseId}
    GROUP BY d.id HAVING COUNT(ds.id)=0
  )
  AND NOT EXISTS(
    SELECT 1 FROM paragraphs p
    LEFT JOIN page_publication_gates g
      ON g.document_id=p.document_id AND g.page_number=p.page_number AND g.corpus_release_id=${releaseId}
    WHERE p.corpus_release_id=${releaseId}
      AND (g.document_id IS NULL OR p.display_allowed!=g.display_allowed OR p.citation_allowed!=g.citation_allowed)
  )
  AND NOT EXISTS(
    SELECT 1 FROM paragraphs p
    JOIN documents d ON d.id=p.document_id
    WHERE p.corpus_release_id=${releaseId}
      AND (p.citation_allowed>p.display_allowed OR (p.citation_allowed=1 AND d.citation_allowed=0))
  )
  AND NOT EXISTS(
    SELECT 1 FROM paragraphs p
    LEFT JOIN paragraph_fts f ON f.rowid=p.id
    WHERE p.corpus_release_id=${releaseId} AND f.rowid IS NULL
  )
  AND NOT EXISTS(
    SELECT 1 FROM paragraph_fts f
    LEFT JOIN paragraphs p ON p.id=f.rowid AND p.corpus_release_id=${releaseId}
    WHERE p.id IS NULL
  )
  AND NOT EXISTS(
    SELECT 1 FROM paragraph_fts WHERE paragraph_id IS NOT rowid
  )
THEN 1 ELSE 0 END;

UPDATE corpus_import_releases SET
  state='ready',
  actual_documents=(SELECT COUNT(*) FROM documents WHERE corpus_release_id=${releaseId}),
  actual_paragraphs=(SELECT COUNT(*) FROM paragraphs WHERE corpus_release_id=${releaseId}),
  actual_fts_rows=(SELECT COUNT(*) FROM paragraph_fts),
  actual_page_gates=(SELECT COUNT(*) FROM page_publication_gates WHERE corpus_release_id=${releaseId}),
  actual_displayed_paragraphs=(SELECT COUNT(*) FROM paragraphs WHERE corpus_release_id=${releaseId} AND display_allowed=1),
  actual_chunks=(SELECT COUNT(*) FROM corpus_import_chunks WHERE release_id=${releaseId}),
  actual_core_counts_json=${coreCountsJsonSql(releaseId)},
  updated_at=CURRENT_TIMESTAMP,ready_at=CURRENT_TIMESTAMP,failure_reason=NULL
WHERE release_id=${releaseId};
INSERT INTO site_meta(key,value) VALUES('accepted_ocr_document_count',${sql(String(manifest.accepted_ocr_documents))})
  ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP;
UPDATE site_meta SET value='ready',updated_at=CURRENT_TIMESTAMP WHERE key='corpus_import_state';
DELETE FROM corpus_import_guards WHERE guard_key='finalize';`;
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    if (key === '--remote' || key === '--core-only' || key === '--finalize-only'
      || key === '--page-evidence-promotion') {
      args.set(key.slice(2), true);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    args.set(key.slice(2), value);
    index += 1;
  }
  return args;
}

function runWrangler(root, database, environment, commandArgs, stdio = 'inherit') {
  const command = ['wrangler', 'd1', 'execute', database];
  if (environment) command.push('--env', environment);
  command.push('--remote', ...commandArgs);
  return spawnSync('npx', command, { cwd: root.pathname, stdio });
}

export function runCorpusFinalization({
  root,
  database,
  environment,
  manifest,
  resume = false,
  runCommand = runWrangler,
} = {}) {
  if (resume) {
    const resumed = runCommand(root, database, environment, [
      '--command', buildCorpusImportStartSql(manifest, { resume: true }),
    ]);
    if (resumed.status !== 0) return { status: resumed.status || 1, phase: 'resume' };
  }

  const finalized = runCommand(root, database, environment, [
    '--command', buildCorpusImportFinalizeSql(manifest),
  ]);
  if (finalized.status !== 0) {
    runCommand(root, database, environment, [
      '--command', buildCorpusImportFailureSql(manifest, 'finalize_invariant_failed'),
    ]);
    return { status: finalized.status || 1, phase: 'finalize' };
  }
  return { status: 0, phase: 'ready' };
}

export async function runCorpusImport({
  root = new URL('../', import.meta.url),
  database,
  environment = '',
  remote = false,
  from = 0,
  to = Number.MAX_SAFE_INTEGER,
  coreOnly = false,
  finalizeOnly = false,
  pageEvidencePromotion = false,
  runCommand = runWrangler,
  pageEvidenceValidator = validatePageEvidenceForRelease,
  sourceBindingValidator = validateCorpusManifestSourceBindings,
} = {}) {
  database = String(database || '');
  if (!database) throw new Error('--database is required');
  if (!remote) throw new Error('refusing remote mutation without explicit --remote');
  from = Math.max(0, Number(from || 0));
  to = Math.max(from, Number(to ?? Number.MAX_SAFE_INTEGER));
  const rootUrl = root instanceof URL
    ? root
    : pathToFileURL(`${path.resolve(String(root))}${path.sep}`);
  pageEvidenceValidator({
    root: rootUrl,
    pageEvidencePromotion: Boolean(pageEvidencePromotion),
  });
  const directory = new URL('data/corpus-chunks/', rootUrl);
  const allFiles = (await readdir(directory))
    .filter((name) => /^\d{3}-(?:core|paragraphs)\.sql$/.test(name))
    .sort();
  const manifest = await verifyCorpusSqlFiles(
    validateCorpusManifest(
      JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8')),
      allFiles.length,
    ),
    directory,
  );
  await sourceBindingValidator(manifest, { root: rootUrl });
  if (finalizeOnly) {
    if (coreOnly || from > 0 || to !== Number.MAX_SAFE_INTEGER) {
      throw new Error('--finalize-only cannot be combined with --core-only, --from, or --to');
    }
    const outcome = runCorpusFinalization({
      root: rootUrl, database, environment, manifest, resume: true, runCommand,
    });
    if (outcome.status === 0) process.stdout.write(`release ${manifest.release_id} ready\n`);
    return outcome;
  }
  let files = coreOnly ? allFiles.filter((name) => name.startsWith('000-')) : allFiles;
  files = files.filter((name) => {
    const index = Number(name.slice(0, 3));
    return index >= from && index <= to;
  });
  if (!files.length) throw new Error('no corpus SQL files selected');

  const snapshots = [];
  try {
    for (const file of files) {
      const declared = manifest.sql_files.find((entry) => entry.name === file);
      snapshots.push(await createImmutableFileSnapshot({
        root: directory,
        source: file,
        expected: declared,
        label: `corpus SQL chunk ${file}`,
      }));
    }
    for (const snapshot of snapshots) await snapshot.verify();

    const start = runCommand(rootUrl, database, environment, [
      '--command', buildCorpusImportStartSql(manifest, { resume: from > 0 }),
    ]);
    if (start.status !== 0) return { status: start.status || 1, phase: 'start' };

    for (const [position, snapshot] of snapshots.entries()) {
      const file = files[position];
      process.stdout.write(`[${position + 1}/${files.length}] ${file}\n`);
      let executed;
      let result;
      try {
        executed = await snapshot.verify();
        result = runCommand(rootUrl, database, environment, ['--file', snapshot.path]);
        await snapshot.verify();
      } catch (error) {
        try {
          runCommand(rootUrl, database, environment, [
            '--command', buildCorpusImportFailureSql(manifest, `chunk_snapshot_unstable:${file}`),
          ]);
        } catch {
          // Preserve the snapshot-integrity error even if the best-effort failure receipt also fails.
        }
        throw new Error(`private SQL snapshot became unstable while executing ${file}: ${error.message}`, {
          cause: error,
        });
      }
      if (result.status !== 0) {
        runCommand(rootUrl, database, environment, [
          '--command', buildCorpusImportFailureSql(manifest, `chunk_failed:${file}`),
        ]);
        process.stderr.write(`import stopped at ${file}; rerun with --from ${file.slice(0, 3)}\n`);
        return { status: result.status || 1, phase: 'chunk', chunk: file };
      }
      const receipt = runCommand(rootUrl, database, environment, [
        '--command', buildCorpusChunkReceiptSql(manifest, file, executed),
      ]);
      if (receipt.status !== 0) {
        runCommand(rootUrl, database, environment, [
          '--command', buildCorpusImportFailureSql(manifest, `chunk_receipt_failed:${file}`),
        ]);
        process.stderr.write(`chunk imported but receipt failed at ${file}; rerun with --from ${file.slice(0, 3)}\n`);
        return { status: receipt.status || 1, phase: 'receipt', chunk: file };
      }
    }

    const lastFileIndex = Number(allFiles.at(-1).slice(0, 3));
    const selectedLastIndex = Number(files.at(-1).slice(0, 3));
    if (coreOnly || selectedLastIndex < lastFileIndex) {
      process.stdout.write(`release ${manifest.release_id} remains in_progress; import the remaining chunks before finalization\n`);
      return { status: 0, phase: 'in_progress' };
    }

    const outcome = runCorpusFinalization({
      root: rootUrl, database, environment, manifest, runCommand,
    });
    if (outcome.status === 0) process.stdout.write(`release ${manifest.release_id} ready\n`);
    return outcome;
  } finally {
    await Promise.allSettled(snapshots.map((snapshot) => snapshot.cleanup()));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outcome = await runCorpusImport({
    database: String(args.get('database') || ''),
    environment: String(args.get('env') || ''),
    remote: args.get('remote') === true,
    from: args.has('from') ? Number(args.get('from')) : 0,
    to: args.has('to') ? Number(args.get('to')) : Number.MAX_SAFE_INTEGER,
    coreOnly: args.get('core-only') === true,
    finalizeOnly: args.get('finalize-only') === true,
    pageEvidencePromotion: args.get('page-evidence-promotion') === true,
  });
  if (outcome.status !== 0) process.exit(outcome.status);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await main();
