import { createHash, randomUUID } from 'node:crypto';
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
import { createImmutableBufferSnapshot } from './lib/immutable-release-snapshot.mjs';
import { createCorpusSourceSnapshot } from './lib/corpus-source-snapshot.mjs';
import { parseDesiredReleaseManifestArtifact } from './lib/desired-release-manifest.mjs';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RELEASE_ID_PATTERN = /^corpus-[a-f0-9]{24}$/;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DEFAULT_OWNER_TTL_SECONDS = 3600;
const DEFAULT_DESIRED_RELEASE_MANIFEST = '.wrangler/release-manifest.json';
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

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function desiredCorpusProjection(manifest, manifestBuffer, sqlFiles) {
  return {
    source: 'data/corpus-chunks/manifest.json',
    sha256: createHash('sha256').update(manifestBuffer).digest('hex'),
    bytes: manifestBuffer.length,
    release_id: manifest.release_id,
    release_fingerprint_sha256: manifest.release_fingerprint_sha256,
    manifest_sha256: manifest.manifest_sha256,
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
    chunks: sqlFiles.map((entry) => ({
      source: `data/corpus-chunks/${entry.name}`,
      name: entry.name,
      sha256: entry.sha256,
      bytes: entry.bytes,
    })),
  };
}

export function assertCorpusManifestMatchesDesiredRelease(artifact, manifestInput, manifestBuffer, sqlFiles) {
  const manifest = validateCorpusManifest(manifestInput, sqlFiles.length);
  if (!Buffer.isBuffer(manifestBuffer) || !Array.isArray(sqlFiles)) {
    throw new Error('desired release corpus identity requires fixed manifest bytes and SQL inventory');
  }
  const expected = artifact?.value?.corpus_release;
  const actual = desiredCorpusProjection(manifest, manifestBuffer, sqlFiles);
  if (!expected || stableStringify(expected) !== stableStringify(actual)) {
    throw new Error('desired release corpus identity mismatch');
  }
  return actual;
}

async function loadDesiredReleaseForCorpusImport({ root, manifestPath = DEFAULT_DESIRED_RELEASE_MANIFEST } = {}) {
  const rootUrl = root instanceof URL ? root : pathToFileURL(`${path.resolve(String(root))}${path.sep}`);
  const normalized = String(manifestPath || '').replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')
      || normalized.includes('/../') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('desired release manifest path must remain inside the project root');
  }
  const buffer = await readFile(new URL(normalized, rootUrl));
  const artifact = parseDesiredReleaseManifestArtifact(buffer);
  const snapshot = await createImmutableBufferSnapshot({
    buffer,
    label: 'desired release artifact for corpus import',
  });
  return { artifact, snapshot };
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

function ownerTokenSha256(ownerToken, label = 'corpus import owner token') {
  const token = String(ownerToken || '');
  if (!/^[A-Za-z0-9._:-]{16,200}$/.test(token)) throw new Error(`${label} is invalid`);
  return createHash('sha256').update(token).digest('hex');
}

function ownerFence(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('corpus import owner fence must be a positive integer');
  return value;
}

function ownerTtl(value) {
  if (!Number.isSafeInteger(value) || value < 60 || value > 7200) {
    throw new Error('corpus import owner TTL must be between 60 and 7200 seconds');
  }
  return value;
}

function prechangeReceipt(value) {
  const raw = Buffer.from(String(value?.raw_json || ''), 'utf8');
  if (!value || !SHA256_PATTERN.test(String(value.sha256 || ''))
      || !Number.isSafeInteger(value.bytes) || value.bytes <= 0
      || typeof value.bookmark !== 'string' || !value.bookmark
      || typeof value.timestamp !== 'string' || Number.isNaN(Date.parse(value.timestamp))
      || raw.length !== value.bytes
      || createHash('sha256').update(raw).digest('hex') !== value.sha256) {
    throw new Error('corpus import requires an exact prechange D1 Time Travel receipt');
  }
  try {
    JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('corpus import prechange D1 Time Travel receipt is not JSON');
  }
  return value;
}

function importOwnerGuardSql({ manifest, ownerToken, ownerFence: fence, ttlSeconds, guardKey }) {
  const tokenHash = ownerTokenSha256(ownerToken);
  const exactFence = ownerFence(fence);
  const ttl = ownerTtl(ttlSeconds);
  const now = "CAST(strftime('%s','now') AS INTEGER)";
  return {
    tokenHash,
    fence: exactFence,
    now,
    prefix: `DELETE FROM corpus_import_guards WHERE guard_key=${sql(guardKey)};
INSERT INTO corpus_import_guards(guard_key,ok)
SELECT ${sql(guardKey)},CASE WHEN EXISTS(
  SELECT 1 FROM corpus_import_ownership
  WHERE id=1
    AND release_id=${sql(manifest.release_id)}
    AND manifest_sha256=${sql(manifest.manifest_sha256)}
    AND owner_token_sha256=${sql(tokenHash)}
    AND owner_fence=${exactFence}
    AND expires_unix>${now}
) THEN 1 ELSE 0 END;`,
    renew: `UPDATE corpus_import_ownership
SET expires_unix=${now}+${ttl},updated_at=CURRENT_TIMESTAMP
WHERE id=1 AND release_id=${sql(manifest.release_id)}
  AND manifest_sha256=${sql(manifest.manifest_sha256)}
  AND owner_token_sha256=${sql(tokenHash)} AND owner_fence=${exactFence}
  AND expires_unix>${now};`,
    suffix: `DELETE FROM corpus_import_guards WHERE guard_key=${sql(guardKey)};`,
  };
}

export function buildCorpusImportOwnerAcquireSql(manifestInput, {
  ownerToken,
  ttlSeconds = DEFAULT_OWNER_TTL_SECONDS,
} = {}) {
  const manifest = validateCorpusManifest(manifestInput);
  const tokenHash = ownerTokenSha256(ownerToken);
  const ttl = ownerTtl(ttlSeconds);
  const now = "CAST(strftime('%s','now') AS INTEGER)";
  return `DELETE FROM corpus_import_guards WHERE guard_key='corpus_import_owner_acquire';
INSERT INTO corpus_import_guards(guard_key,ok)
SELECT 'corpus_import_owner_acquire',CASE WHEN
  NOT EXISTS(SELECT 1 FROM corpus_import_ownership WHERE id=1)
  OR EXISTS(
    SELECT 1 FROM corpus_import_ownership WHERE id=1 AND (
      expires_unix<=${now}
      OR (
        release_id=${sql(manifest.release_id)}
        AND manifest_sha256=${sql(manifest.manifest_sha256)}
        AND owner_token_sha256=${sql(tokenHash)}
        AND expires_unix>${now}
      )
    )
  )
THEN 1 ELSE 0 END;
UPDATE corpus_import_fence_state SET last_fence=last_fence+1
WHERE id=1 AND (
  NOT EXISTS(SELECT 1 FROM corpus_import_ownership WHERE id=1)
  OR EXISTS(SELECT 1 FROM corpus_import_ownership WHERE id=1 AND expires_unix<=${now})
);
INSERT INTO corpus_import_ownership(
  id,release_id,manifest_sha256,owner_token_sha256,owner_fence,expires_unix,updated_at
) VALUES(
  1,${sql(manifest.release_id)},${sql(manifest.manifest_sha256)},${sql(tokenHash)},
  (SELECT last_fence FROM corpus_import_fence_state WHERE id=1),${now}+${ttl},CURRENT_TIMESTAMP
) ON CONFLICT(id) DO UPDATE SET
  release_id=excluded.release_id,
  manifest_sha256=excluded.manifest_sha256,
  owner_token_sha256=excluded.owner_token_sha256,
  owner_fence=CASE
    WHEN corpus_import_ownership.expires_unix<=${now} THEN excluded.owner_fence
    ELSE corpus_import_ownership.owner_fence
  END,
  expires_unix=excluded.expires_unix,
  updated_at=CURRENT_TIMESTAMP;
DELETE FROM corpus_import_guards WHERE guard_key='corpus_import_owner_acquire';
SELECT owner_fence FROM corpus_import_ownership
WHERE id=1 AND release_id=${sql(manifest.release_id)}
  AND manifest_sha256=${sql(manifest.manifest_sha256)}
  AND owner_token_sha256=${sql(tokenHash)} AND expires_unix>${now};`;
}

export function buildCorpusImportOwnerReadSql(manifestInput, { ownerToken } = {}) {
  const manifest = validateCorpusManifest(manifestInput);
  return `SELECT owner_fence FROM corpus_import_ownership
WHERE id=1 AND release_id=${sql(manifest.release_id)}
  AND manifest_sha256=${sql(manifest.manifest_sha256)}
  AND owner_token_sha256=${sql(ownerTokenSha256(ownerToken))}
  AND expires_unix>CAST(strftime('%s','now') AS INTEGER);`;
}

export function buildCorpusImportStartSql(manifestInput, {
  resume = false,
  ownerToken,
  ownerFence: fence,
  ttlSeconds = DEFAULT_OWNER_TTL_SECONDS,
  prechange: prechangeInput,
} = {}) {
  const manifest = validateCorpusManifest(manifestInput);
  const owner = importOwnerGuardSql({
    manifest, ownerToken, ownerFence: fence, ttlSeconds, guardKey: resume ? 'corpus_import_resume' : 'corpus_import_start',
  });
  const prechange = prechangeReceipt(prechangeInput);
  const expectedCoreCountsJson = JSON.stringify(manifest.core_table_counts);
  const exactReady = `EXISTS(
  SELECT 1 FROM corpus_import_releases
  WHERE release_id=${sql(manifest.release_id)}
    AND release_fingerprint_sha256=${sql(manifest.release_fingerprint_sha256)}
    AND manifest_sha256=${sql(manifest.manifest_sha256)} AND state='ready'
)`;
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
    : `DELETE FROM corpus_import_chunks WHERE release_id=${sql(manifest.release_id)} AND NOT ${exactReady};\n`;
  return `${owner.prefix}
DELETE FROM corpus_import_guards WHERE guard_key='start';
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
AND NOT EXISTS(
  SELECT 1 FROM corpus_import_releases
  WHERE release_id=${sql(manifest.release_id)} AND state='ready'
    AND (release_fingerprint_sha256!=${sql(manifest.release_fingerprint_sha256)}
      OR manifest_sha256!=${sql(manifest.manifest_sha256)})
)
${resumeGuard}
THEN 1 ELSE 0 END;
INSERT INTO corpus_import_releases(
  release_id,release_fingerprint_sha256,manifest_sha256,state,expected_documents,expected_paragraphs,
  expected_fts_rows,expected_page_gates,expected_displayed_paragraphs,accepted_ocr_documents,
  expected_chunks,expected_core_counts_json,actual_documents,actual_paragraphs,actual_fts_rows,actual_page_gates,actual_displayed_paragraphs,actual_chunks,actual_core_counts_json,
  started_at,updated_at,ready_at,failure_reason,
  owner_token_sha256,owner_fence,owner_expires_unix,
  prechange_bookmark,prechange_timestamp,prechange_receipt_sha256,prechange_receipt_bytes,prechange_receipt_json
) VALUES(${[
    manifest.release_id, manifest.release_fingerprint_sha256, manifest.manifest_sha256, 'in_progress', manifest.documents,
    manifest.paragraphs, manifest.fts_rows, manifest.page_publication_gates,
    manifest.displayed_paragraphs, manifest.accepted_ocr_documents, manifest.sql_chunks, expectedCoreCountsJson,
  ].map(sql).join(',')},NULL,NULL,NULL,NULL,NULL,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL,NULL,
  ${sql(owner.tokenHash)},${owner.fence},${owner.now}+${ownerTtl(ttlSeconds)},
  ${sql(prechange.bookmark)},${sql(prechange.timestamp)},${sql(prechange.sha256)},${prechange.bytes},${sql(prechange.raw_json)})
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
  owner_token_sha256=excluded.owner_token_sha256,
  owner_fence=excluded.owner_fence,
  owner_expires_unix=excluded.owner_expires_unix,
  prechange_bookmark=COALESCE(corpus_import_releases.prechange_bookmark,excluded.prechange_bookmark),
  prechange_timestamp=COALESCE(corpus_import_releases.prechange_timestamp,excluded.prechange_timestamp),
  prechange_receipt_sha256=COALESCE(corpus_import_releases.prechange_receipt_sha256,excluded.prechange_receipt_sha256),
  prechange_receipt_bytes=COALESCE(corpus_import_releases.prechange_receipt_bytes,excluded.prechange_receipt_bytes),
  prechange_receipt_json=COALESCE(corpus_import_releases.prechange_receipt_json,excluded.prechange_receipt_json),
  updated_at=CURRENT_TIMESTAMP,ready_at=NULL,failure_reason=NULL
WHERE corpus_import_releases.state!='ready';
${resetReceipts}INSERT INTO site_meta(key,value)
  SELECT 'corpus_import_state','in_progress' WHERE NOT ${exactReady}
  ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP;
INSERT INTO site_meta(key,value)
  SELECT 'current_corpus_release_id',${sql(manifest.release_id)} WHERE NOT ${exactReady}
  ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP;
INSERT INTO site_meta(key,value)
  SELECT 'current_corpus_manifest_sha256',${sql(manifest.manifest_sha256)} WHERE NOT ${exactReady}
  ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP;
DELETE FROM corpus_import_guards WHERE guard_key='start';
${owner.renew}
${owner.suffix}`;
}

export function buildCorpusChunkReceiptSql(manifestInput, chunkName, executed = null, {
  ownerToken,
  ownerFence: fence,
  ttlSeconds = DEFAULT_OWNER_TTL_SECONDS,
} = {}) {
  const manifest = validateCorpusManifest(manifestInput);
  const owner = importOwnerGuardSql({
    manifest, ownerToken, ownerFence: fence, ttlSeconds, guardKey: `corpus_import_receipt:${chunkName}`,
  });
  const chunk = manifest.sql_files.find((entry) => entry.name === chunkName);
  if (!chunk) throw new Error(`chunk is not declared by corpus manifest: ${chunkName}`);
  const actual = executed || chunk;
  if (actual.sha256 !== chunk.sha256 || actual.bytes !== chunk.bytes) {
    throw new Error(`executed chunk bytes do not match corpus manifest: ${chunkName}`);
  }
  return `${owner.prefix}
INSERT INTO corpus_import_chunks(release_id,chunk_name,chunk_sha256,chunk_bytes,imported_at,owner_fence)
VALUES(${sql(manifest.release_id)},${sql(chunk.name)},${sql(actual.sha256)},${sql(actual.bytes)},CURRENT_TIMESTAMP,${owner.fence})
ON CONFLICT(release_id,chunk_name) DO UPDATE SET
  chunk_sha256=excluded.chunk_sha256,chunk_bytes=excluded.chunk_bytes,
  imported_at=CURRENT_TIMESTAMP,owner_fence=excluded.owner_fence;
${owner.renew}
${owner.suffix}`;
}

export function buildOwnedCorpusChunkSql(manifestInput, chunkName, chunkBuffer, ownerOptions = {}) {
  const manifest = validateCorpusManifest(manifestInput);
  const chunk = manifest.sql_files.find((entry) => entry.name === chunkName);
  if (!chunk || !Buffer.isBuffer(chunkBuffer)) throw new Error(`owned corpus chunk is invalid: ${chunkName}`);
  const executed = { sha256: createHash('sha256').update(chunkBuffer).digest('hex'), bytes: chunkBuffer.length };
  if (executed.sha256 !== chunk.sha256 || executed.bytes !== chunk.bytes) {
    throw new Error(`executed chunk bytes do not match corpus manifest: ${chunkName}`);
  }
  const owner = importOwnerGuardSql({
    manifest,
    ownerToken: ownerOptions.ownerToken,
    ownerFence: ownerOptions.ownerFence,
    ttlSeconds: ownerOptions.ttlSeconds ?? DEFAULT_OWNER_TTL_SECONDS,
    guardKey: `corpus_import_chunk:${chunkName}`,
  });
  const chunkSql = chunkBuffer.toString('utf8');
  if (Buffer.from(chunkSql, 'utf8').length !== chunkBuffer.length) {
    throw new Error(`corpus SQL chunk is not canonical UTF-8: ${chunkName}`);
  }
  return Buffer.from(`${owner.prefix}\n${chunkSql.trimEnd()}\nINSERT INTO corpus_import_chunks(
  release_id,chunk_name,chunk_sha256,chunk_bytes,imported_at,owner_fence
) VALUES(
  ${sql(manifest.release_id)},${sql(chunk.name)},${sql(executed.sha256)},${executed.bytes},CURRENT_TIMESTAMP,${owner.fence}
) ON CONFLICT(release_id,chunk_name) DO UPDATE SET
  chunk_sha256=excluded.chunk_sha256,chunk_bytes=excluded.chunk_bytes,
  imported_at=CURRENT_TIMESTAMP,owner_fence=excluded.owner_fence;
${owner.renew}
${owner.suffix}\n`);
}

export function buildCorpusImportFailureSql(manifestInput, reason = 'corpus_import_failed', {
  ownerToken,
  ownerFence: fence,
  ttlSeconds = DEFAULT_OWNER_TTL_SECONDS,
} = {}) {
  const manifest = validateCorpusManifest(manifestInput);
  const owner = importOwnerGuardSql({
    manifest, ownerToken, ownerFence: fence, ttlSeconds, guardKey: 'corpus_import_failure',
  });
  const safeReason = String(reason).slice(0, 240);
  return `${owner.prefix}
UPDATE corpus_import_releases
SET state='failed',failure_reason=${sql(safeReason)},updated_at=CURRENT_TIMESTAMP
WHERE release_id=${sql(manifest.release_id)} AND state!='ready'
  AND owner_token_sha256=${sql(owner.tokenHash)} AND owner_fence=${owner.fence};
UPDATE site_meta SET value='failed',updated_at=CURRENT_TIMESTAMP
WHERE key='corpus_import_state'
  AND (SELECT value FROM site_meta WHERE key='current_corpus_release_id')=${sql(manifest.release_id)}
  AND EXISTS(
    SELECT 1 FROM corpus_import_releases
    WHERE release_id=${sql(manifest.release_id)} AND state='failed'
  );
UPDATE corpus_import_ownership SET expires_unix=${owner.now},updated_at=CURRENT_TIMESTAMP
WHERE id=1 AND release_id=${sql(manifest.release_id)}
  AND manifest_sha256=${sql(manifest.manifest_sha256)}
  AND owner_token_sha256=${sql(owner.tokenHash)} AND owner_fence=${owner.fence};
UPDATE corpus_import_releases SET owner_expires_unix=${owner.now},updated_at=CURRENT_TIMESTAMP
WHERE release_id=${sql(manifest.release_id)}
  AND owner_token_sha256=${sql(owner.tokenHash)} AND owner_fence=${owner.fence};
${owner.suffix}`;
}

export function buildCorpusImportOwnerReleaseSql(manifestInput, {
  ownerToken,
  ownerFence: fence,
} = {}) {
  const manifest = validateCorpusManifest(manifestInput);
  const tokenHash = ownerTokenSha256(ownerToken);
  const exactFence = ownerFence(fence);
  const now = "CAST(strftime('%s','now') AS INTEGER)";
  return `UPDATE corpus_import_ownership SET expires_unix=${now},updated_at=CURRENT_TIMESTAMP
WHERE id=1 AND release_id=${sql(manifest.release_id)}
  AND manifest_sha256=${sql(manifest.manifest_sha256)}
  AND owner_token_sha256=${sql(tokenHash)} AND owner_fence=${exactFence};
UPDATE corpus_import_releases SET owner_expires_unix=${now},updated_at=CURRENT_TIMESTAMP
WHERE release_id=${sql(manifest.release_id)}
  AND owner_token_sha256=${sql(tokenHash)} AND owner_fence=${exactFence};`;
}

export function buildCorpusImportFinalizeSql(manifestInput, {
  ownerToken,
  ownerFence: fence,
  ttlSeconds = DEFAULT_OWNER_TTL_SECONDS,
} = {}) {
  const manifest = validateCorpusManifest(manifestInput);
  const owner = importOwnerGuardSql({
    manifest, ownerToken, ownerFence: fence, ttlSeconds, guardKey: 'corpus_import_finalize_owner',
  });
  const releaseId = sql(manifest.release_id);
  const manifestSha256 = sql(manifest.manifest_sha256);
  const chunkValues = manifest.sql_files.map((chunk) => `(${[
    chunk.name, chunk.sha256, chunk.bytes,
  ].map(sql).join(',')})`).join(',\n    ');
  const coreChecks = coreCountChecks(manifest, releaseId).map((check) => `  AND ${check}`).join('\n');
  return `${owner.prefix}
DELETE FROM corpus_import_guards WHERE guard_key='finalize';
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
      AND owner_token_sha256=${sql(owner.tokenHash)} AND owner_fence=${owner.fence}
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
WHERE release_id=${releaseId}
  AND owner_token_sha256=${sql(owner.tokenHash)} AND owner_fence=${owner.fence};
INSERT INTO site_meta(key,value) VALUES('accepted_ocr_document_count',${sql(String(manifest.accepted_ocr_documents))})
  ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP;
UPDATE site_meta SET value='ready',updated_at=CURRENT_TIMESTAMP WHERE key='corpus_import_state';
UPDATE corpus_import_ownership SET expires_unix=${owner.now},updated_at=CURRENT_TIMESTAMP
WHERE id=1 AND release_id=${releaseId} AND manifest_sha256=${manifestSha256}
  AND owner_token_sha256=${sql(owner.tokenHash)} AND owner_fence=${owner.fence};
UPDATE corpus_import_releases SET owner_expires_unix=${owner.now},updated_at=CURRENT_TIMESTAMP
WHERE release_id=${releaseId}
  AND owner_token_sha256=${sql(owner.tokenHash)} AND owner_fence=${owner.fence};
DELETE FROM corpus_import_guards WHERE guard_key='finalize';
${owner.suffix}`;
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
  const command = ['--no-install', 'wrangler', 'd1', 'execute', database];
  if (environment) command.push('--env', environment);
  command.push('--remote', ...commandArgs);
  return spawnSync('npx', command, { cwd: root.pathname, stdio, encoding: stdio === 'pipe' ? 'utf8' : undefined });
}

function findField(value, names) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findField(item, names);
      if (found !== undefined) return found;
    }
  } else if (value && typeof value === 'object') {
    for (const name of names) if (Object.hasOwn(value, name)) return value[name];
    for (const item of Object.values(value)) {
      const found = findField(item, names);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function parseD1TimeTravelReceipt(stdout, observedAt) {
  const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout || ''));
  let value;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`D1 Time Travel receipt is not JSON: ${error.message}`);
  }
  const bookmark = String(findField(value, ['bookmark']) || '');
  if (!bookmark) throw new Error('D1 Time Travel receipt lacks a bookmark');
  const timestamp = canonicalTimestamp(observedAt, 'D1 Time Travel receipt observed_at');
  return {
    bookmark,
    timestamp,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    bytes: buffer.length,
    raw_json: buffer.toString('utf8'),
  };
}

export function collectD1TimeTravelReceipt({
  root,
  database,
  environment,
  runCommand = spawnSync,
  now = () => new Date(),
} = {}) {
  const args = ['--no-install', 'wrangler', 'd1', 'time-travel', 'info', database];
  if (environment) args.push('--env', environment);
  args.push('--json');
  const observedAt = now().toISOString();
  const result = runCommand('npx', args, {
    cwd: root instanceof URL ? root.pathname : String(root),
    encoding: null,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`D1 Time Travel prechange receipt failed with exit ${result.status ?? 'unknown'}`);
  }
  return parseD1TimeTravelReceipt(result.stdout, observedAt);
}

function parseOwnerFence(stdout) {
  const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout || ''));
  let value;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`corpus import owner fence receipt is not JSON: ${error.message}`);
  }
  const fence = Number(findField(value, ['owner_fence']));
  return ownerFence(fence);
}

export function acquireCorpusImportOwner({
  root,
  database,
  environment,
  manifest,
  ownerToken,
  ttlSeconds = DEFAULT_OWNER_TTL_SECONDS,
  runCommand = runWrangler,
} = {}) {
  const result = runCommand(root, database, environment, [
    '--command', buildCorpusImportOwnerAcquireSql(manifest, { ownerToken, ttlSeconds }), '--json',
  ], 'pipe');
  if (result.status !== 0) throw new Error('corpus import ownership acquisition failed');
  return parseOwnerFence(result.stdout);
}

export function corpusImportReleaseReadySql(manifestInput) {
  const manifest = validateCorpusManifest(manifestInput);
  return `SELECT CASE WHEN EXISTS(
  SELECT 1 FROM corpus_import_releases
  WHERE release_id=${sql(manifest.release_id)}
    AND release_fingerprint_sha256=${sql(manifest.release_fingerprint_sha256)}
    AND manifest_sha256=${sql(manifest.manifest_sha256)} AND state='ready'
) THEN 1 ELSE 0 END AS exact_ready;`;
}

export function checkCorpusImportReleaseReady({
  root,
  database,
  environment,
  manifest,
  runCommand = runWrangler,
} = {}) {
  const result = runCommand(root, database, environment, [
    '--command', corpusImportReleaseReadySql(manifest), '--json',
  ], 'pipe');
  if (result.status !== 0) throw new Error('corpus ready-state preflight failed');
  let value;
  try {
    value = JSON.parse(Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : String(result.stdout || ''));
  } catch (error) {
    throw new Error(`corpus ready-state receipt is not JSON: ${error.message}`);
  }
  return Number(findField(value, ['exact_ready'])) === 1;
}

export function runCorpusFinalization({
  root,
  database,
  environment,
  manifest,
  resume = false,
  ownerToken,
  ownerFence: fence,
  prechange,
  ttlSeconds = DEFAULT_OWNER_TTL_SECONDS,
  runCommand = runWrangler,
} = {}) {
  const ownerOptions = { ownerToken, ownerFence: fence, prechange, ttlSeconds };
  if (resume) {
    const resumed = runCommand(root, database, environment, [
      '--command', buildCorpusImportStartSql(manifest, { resume: true, ...ownerOptions }),
    ]);
    if (resumed.status !== 0) return { status: resumed.status || 1, phase: 'resume' };
  }

  const finalized = runCommand(root, database, environment, [
    '--command', buildCorpusImportFinalizeSql(manifest, ownerOptions),
  ]);
  if (finalized.status !== 0) {
    runCommand(root, database, environment, [
      '--command', buildCorpusImportFailureSql(manifest, 'finalize_invariant_failed', ownerOptions),
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
  ownerToken = process.env.CURRICULUM_CORPUS_IMPORT_OWNER_TOKEN || randomUUID(),
  ownerTtlSeconds = DEFAULT_OWNER_TTL_SECONDS,
  runCommand = runWrangler,
  timeTravelCollector = collectD1TimeTravelReceipt,
  ownerAcquirer = acquireCorpusImportOwner,
  corpusSnapshotFactory = createCorpusSourceSnapshot,
  pageEvidenceValidator = validatePageEvidenceForRelease,
  sourceBindingValidator = validateCorpusManifestSourceBindings,
  desiredReleaseManifestPath = DEFAULT_DESIRED_RELEASE_MANIFEST,
  desiredReleaseArtifactLoader = loadDesiredReleaseForCorpusImport,
  desiredCorpusBindingValidator = assertCorpusManifestMatchesDesiredRelease,
  readyReleaseChecker = checkCorpusImportReleaseReady,
} = {}) {
  database = String(database || '');
  if (!database) throw new Error('--database is required');
  if (!remote) throw new Error('refusing remote mutation without explicit --remote');
  from = Math.max(0, Number(from || 0));
  to = Math.max(from, Number(to ?? Number.MAX_SAFE_INTEGER));
  if (finalizeOnly && (coreOnly || from > 0 || to !== Number.MAX_SAFE_INTEGER)) {
    throw new Error('--finalize-only cannot be combined with --core-only, --from, or --to');
  }
  const rootUrl = root instanceof URL
    ? root
    : pathToFileURL(`${path.resolve(String(root))}${path.sep}`);
  const desiredRelease = await desiredReleaseArtifactLoader({
    root: rootUrl,
    manifestPath: desiredReleaseManifestPath,
  });
  if (!desiredRelease?.artifact || !desiredRelease?.snapshot) {
    throw new Error('desired release artifact loader returned an invalid fixed snapshot');
  }
  let corpusSnapshot;
  try {
    await desiredRelease.snapshot.verify();
    pageEvidenceValidator({
      root: rootUrl,
      pageEvidencePromotion: Boolean(pageEvidencePromotion),
    });
    const liveDirectory = new URL('data/corpus-chunks/', rootUrl);
    const liveFiles = (await readdir(liveDirectory))
      .filter((name) => /^\d{3}-(?:core|paragraphs)\.sql$/.test(name))
      .sort();
    const liveManifestBuffer = await readFile(new URL('manifest.json', liveDirectory));
    const liveManifest = validateCorpusManifest(
      JSON.parse(liveManifestBuffer.toString('utf8')),
      liveFiles.length,
    );
    desiredCorpusBindingValidator(
      desiredRelease.artifact,
      liveManifest,
      liveManifestBuffer,
      liveManifest.sql_files,
    );
    corpusSnapshot = await corpusSnapshotFactory({ root: rootUrl.pathname, manifest: liveManifest });
  } catch (error) {
    await desiredRelease.snapshot.cleanup();
    throw error;
  }
  let snapshotRoot;
  let directory;
  let allFiles;
  let manifest;
  let prechange;
  let fence;
  try {
    snapshotRoot = pathToFileURL(`${corpusSnapshot.root}${path.sep}`);
    directory = new URL('data/corpus-chunks/', snapshotRoot);
    allFiles = (await readdir(directory))
      .filter((name) => /^\d{3}-(?:core|paragraphs)\.sql$/.test(name)).sort();
    const snapshotManifestBuffer = await readFile(new URL('manifest.json', directory));
    manifest = await verifyCorpusSqlFiles(
      validateCorpusManifest(JSON.parse(snapshotManifestBuffer.toString('utf8')), allFiles.length),
      directory,
    );
    desiredCorpusBindingValidator(
      desiredRelease.artifact,
      manifest,
      snapshotManifestBuffer,
      manifest.sql_files,
    );
    await desiredRelease.snapshot.verify();
    await corpusSnapshot.verify();
    await sourceBindingValidator(manifest, { root: snapshotRoot });
    prechange = timeTravelCollector({ root: rootUrl, database, environment });
    fence = ownerAcquirer({
      root: rootUrl,
      database,
      environment,
      manifest,
      ownerToken,
      ttlSeconds: ownerTtlSeconds,
      runCommand,
    });
  } catch (error) {
    await Promise.allSettled([corpusSnapshot.cleanup(), desiredRelease.snapshot.cleanup()]);
    throw error;
  }
  const ownerOptions = {
    ownerToken,
    ownerFence: fence,
    ttlSeconds: ownerTtlSeconds,
    prechange,
  };
  const releaseOwner = () => runCommand(rootUrl, database, environment, [
    '--command', buildCorpusImportOwnerReleaseSql(manifest, ownerOptions),
  ]);
  const releaseOwnerSafely = (message) => {
    try {
      const result = releaseOwner();
      return result.status === 0 ? null : new Error(`${message} with exit ${result.status ?? 'unknown'}`);
    } catch (error) {
      return new Error(message, { cause: error });
    }
  };
  let alreadyReady;
  try {
    alreadyReady = readyReleaseChecker({
      root: rootUrl,
      database,
      environment,
      manifest,
      runCommand,
    });
  } catch (error) {
    const releaseError = releaseOwnerSafely('corpus import owner release failed after ready-state preflight');
    await Promise.allSettled([corpusSnapshot.cleanup(), desiredRelease.snapshot.cleanup()]);
    if (releaseError) {
      throw new AggregateError([error, releaseError], 'corpus ready-state preflight and owner release both failed');
    }
    throw error;
  }
  if (alreadyReady) {
    const releaseError = releaseOwnerSafely('corpus import owner release failed after exact ready no-op');
    await Promise.allSettled([corpusSnapshot.cleanup(), desiredRelease.snapshot.cleanup()]);
    if (releaseError) throw releaseError;
    return { status: 0, phase: 'already_ready', release_id: manifest.release_id };
  }
  if (finalizeOnly) {
    let caughtError = null;
    try {
      const outcome = runCorpusFinalization({
        root: rootUrl, database, environment, manifest, resume: true, runCommand, ...ownerOptions,
      });
      if (outcome.status === 0) process.stdout.write(`release ${manifest.release_id} ready\n`);
      return outcome;
    } catch (error) {
      caughtError = error;
      throw error;
    } finally {
      const releaseError = releaseOwnerSafely('corpus import owner release failed after finalization');
      await Promise.allSettled([corpusSnapshot.cleanup(), desiredRelease.snapshot.cleanup()]);
      if (releaseError && !caughtError) throw releaseError;
    }
  }
  let files = coreOnly ? allFiles.filter((name) => name.startsWith('000-')) : allFiles;
  files = files.filter((name) => {
    const index = Number(name.slice(0, 3));
    return index >= from && index <= to;
  });
  if (!files.length) {
    const releaseError = releaseOwnerSafely('corpus import owner release failed after empty selection');
    await Promise.allSettled([corpusSnapshot.cleanup(), desiredRelease.snapshot.cleanup()]);
    if (releaseError) throw releaseError;
    throw new Error('no corpus SQL files selected');
  }

  const snapshots = [];
  let caughtError = null;
  try {
    for (const file of files) {
      const declared = manifest.sql_files.find((entry) => entry.name === file);
      const chunkBuffer = await readFile(new URL(file, directory));
      const ownedBuffer = buildOwnedCorpusChunkSql(manifest, file, chunkBuffer, ownerOptions);
      snapshots.push(await createImmutableBufferSnapshot({
        buffer: ownedBuffer,
        label: `owned atomic corpus SQL chunk ${file}`,
      }));
    }
    for (const snapshot of snapshots) await snapshot.verify();

    const start = runCommand(rootUrl, database, environment, [
      '--command', buildCorpusImportStartSql(manifest, { resume: from > 0, ...ownerOptions }),
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
            '--command', buildCorpusImportFailureSql(manifest, `chunk_snapshot_unstable:${file}`, ownerOptions),
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
          '--command', buildCorpusImportFailureSql(manifest, `chunk_failed:${file}`, ownerOptions),
        ]);
        process.stderr.write(`import stopped at ${file}; rerun with --from ${file.slice(0, 3)}\n`);
        return { status: result.status || 1, phase: 'chunk', chunk: file };
      }
    }

    const lastFileIndex = Number(allFiles.at(-1).slice(0, 3));
    const selectedLastIndex = Number(files.at(-1).slice(0, 3));
    if (coreOnly || selectedLastIndex < lastFileIndex) {
      process.stdout.write(`release ${manifest.release_id} remains in_progress; import the remaining chunks before finalization\n`);
      return { status: 0, phase: 'in_progress' };
    }

    const outcome = runCorpusFinalization({
      root: rootUrl, database, environment, manifest, runCommand, ...ownerOptions,
    });
    if (outcome.status === 0) process.stdout.write(`release ${manifest.release_id} ready\n`);
    return outcome;
  } catch (error) {
    caughtError = error;
    throw error;
  } finally {
    const releaseError = releaseOwnerSafely('corpus import owner release failed');
    await Promise.allSettled([
      ...snapshots.map((snapshot) => snapshot.cleanup()),
      corpusSnapshot.cleanup(),
      desiredRelease.snapshot.cleanup(),
    ]);
    if (releaseError && !caughtError) throw releaseError;
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
