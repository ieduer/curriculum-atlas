import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { loadDocumentClassificationResolver } from './document-classification.mjs';
import {
  buildParagraphIdentityGuardSql,
  sealCorpusManifest,
  validateCorpusManifest,
} from './import-corpus.mjs';
import {
  bindAcceptedOcrDocument,
  isNativeTextRecord,
  paragraphProvenanceLocator,
  sha256Text,
  validatePagePublicationManifest,
} from './page-publication-gate.mjs';
import {
  applySemanticPagePublication,
  createSemanticPublicationGate,
  semanticDocumentDisposition,
} from './semantic-publication-gate.mjs';
import {
  canonicalParagraphBody,
  isCanonicalParagraphBody,
} from './canonical-paragraph-text.mjs';
import { createConceptPublicationGate } from './concept-page-publication.mjs';
import { validateCompendiumItemBoundaries } from './validate-compendium-item-boundaries.mjs';
import {
  buildCompendiumCorpusProjection,
  compendiumItemForPage,
} from './compendium-corpus-projection.mjs';
import {
  effectiveParagraphCitationAllowed,
  verifyCompendiumHeadingEvidence,
  verifyCompendiumItemPageEvidence,
  verifyCompendiumPageAssetEvidence,
  verifyCompendiumTocEvidenceArtifacts,
} from './compendium-item-publication.mjs';
import { validatePageEvidenceForRelease } from './page-evidence-release-hook.mjs';
import { computeCorpusReleaseFingerprint } from './lib/corpus-release-fingerprint.mjs';

const projectRoot = new URL('../', import.meta.url);
const buildArguments = process.argv.slice(2);
if (buildArguments.some((argument) => argument !== '--page-evidence-promotion')) {
  throw new Error('usage: node scripts/build-corpus.mjs [--page-evidence-promotion]');
}
if (buildArguments.filter((argument) => argument === '--page-evidence-promotion').length > 1) {
  throw new Error('--page-evidence-promotion may be specified only once');
}
const pageEvidencePromotion = buildArguments.includes('--page-evidence-promotion');
validatePageEvidenceForRelease({ root: projectRoot, pageEvidencePromotion });
const projectRootPath = fileURLToPath(projectRoot);
const ocrRoot = process.env.CORPUS_OCR_ROOT || process.env.CONCEPT_OCR_ROOT
  ? resolve(projectRootPath, process.env.CORPUS_OCR_ROOT || process.env.CONCEPT_OCR_ROOT)
  : join(projectRootPath, '.cache/ocr-production');
const witnessRoot = process.env.CORPUS_WITNESS_ROOT || process.env.CONCEPT_WITNESS_ROOT
  ? resolve(projectRootPath, process.env.CORPUS_WITNESS_ROOT || process.env.CONCEPT_WITNESS_ROOT)
  : join(projectRootPath, '.cache/ocr-witness');
const catalog = JSON.parse(await readFile(new URL('data/catalog.json', projectRoot), 'utf8'));
const queue = JSON.parse(await readFile(new URL('data/ocr-queue.json', projectRoot), 'utf8'));
const insights = JSON.parse(await readFile(new URL('data/subject-insights.json', projectRoot), 'utf8'));
const ingest = JSON.parse(await readFile(new URL('data/ingest-manifest.json', projectRoot), 'utf8'));
const documentedSources = JSON.parse(await readFile(new URL('data/document-sources.json', projectRoot), 'utf8')).sources;
const onlineVerificationSamples = JSON.parse(await readFile(new URL('data/online-verification-samples.json', projectRoot), 'utf8')).samples;
const compendiumItemBoundaries = JSON.parse(
  await readFile(new URL('data/compendium-item-boundaries.json', projectRoot), 'utf8'),
);
const pagePublicationManifest = validatePagePublicationManifest(
  JSON.parse(await readFile(new URL('data/page-publication-manifest.json', projectRoot), 'utf8')),
);
const semanticPublicationPolicy = JSON.parse(
  await readFile(new URL('data/semantic-publication-policy.json', projectRoot), 'utf8'),
);
const semanticPublicationGate = createSemanticPublicationGate({
  policy: semanticPublicationPolicy,
  records: catalog.documents,
});
const conceptPublicationGate = createConceptPublicationGate({
  manifest: pagePublicationManifest,
  semanticPolicy: semanticPublicationPolicy,
  records: catalog.documents,
});
const currentPagePublicationReleaseId = `page-gate-${conceptPublicationGate.revision_sha256.slice(0, 24)}`;
const compendiumBoundaryValidation = validateCompendiumItemBoundaries(compendiumItemBoundaries, {
  catalog,
  queue,
  onlineVerifications: { samples: onlineVerificationSamples },
});
if (!compendiumBoundaryValidation.valid) {
  throw new Error(`Compendium item boundary gate failed: ${JSON.stringify(compendiumBoundaryValidation.errors)}`);
}
for (const documentBoundary of compendiumItemBoundaries.documents) {
  await verifyCompendiumTocEvidenceArtifacts({ documentBoundary, ocrRoot, witnessRoot });
}
const checksumById = new Map(ingest.entries.map((entry) => [entry.id, entry.source_sha256]));
const catalogById = new Map(catalog.documents.map((record) => [record.id, record]));
const pagePublicationByDocument = new Map(pagePublicationManifest.documents.map((document) => [document.document_id, document]));
const compendiumBoundaryByDocument = new Map(
  compendiumItemBoundaries.documents.map((document) => [document.document_id, document]),
);
for (const record of catalog.documents) {
  if (typeof record.text_quality_status !== 'string' || !record.text_quality_status.trim()) {
    throw new Error(`Catalog document lacks explicit text_quality_status: ${record.id}`);
  }
  if (typeof record.citation_allowed !== 'boolean') {
    throw new Error(`Catalog document lacks explicit citation_allowed: ${record.id}`);
  }
}
for (const document of pagePublicationManifest.documents) {
  const record = catalogById.get(document.document_id);
  if (!record) throw new Error(`Page publication manifest references unknown document: ${document.document_id}`);
  if (semanticDocumentDisposition(semanticPublicationGate, record).excluded) {
    throw new Error(`Page publication manifest must not accept exact duplicate alias: ${document.document_id}`);
  }
  if (isNativeTextRecord(record)) {
    throw new Error(`Page publication manifest must not override native text document: ${document.document_id}`);
  }
}
const classifyDocument = await loadDocumentClassificationResolver(projectRoot);
const classifications = new Map(catalog.documents.map((record) => [record.id, classifyDocument(record)]));
const unclassified = [...classifications.values()].filter((item) => item.scope_kind === 'unclassified');
if (unclassified.length) {
  throw new Error(`Unclassified document subjects: ${unclassified.map((item) => `${item.document_id}:${item.source_subject_label}`).join(', ')}`);
}
const corpusTextById = new Map();
const corpusTextAssets = [];
for (const record of catalog.documents) {
  if (semanticDocumentDisposition(semanticPublicationGate, record).excluded) continue;
  const nativeText = isNativeTextRecord(record);
  const acceptedOcrDocument = pagePublicationByDocument.get(record.id);
  if (!nativeText && !acceptedOcrDocument) continue;
  let raw;
  try {
    raw = await readFile(new URL(`.cache/text/${record.id}.txt`, projectRoot), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (acceptedOcrDocument) throw new Error(`Accepted OCR document is missing final text: ${record.id}`);
    if (nativeText && record.citation_allowed) {
      throw new Error(`Citation-enabled native document is missing source text: ${record.id}`);
    }
    continue;
  }
  corpusTextById.set(record.id, raw);
  corpusTextAssets.push({
    document_id: record.id,
    sha256: sha256Text(raw),
    bytes: Buffer.byteLength(raw, 'utf8'),
  });
}
const corpusReleaseFingerprint = computeCorpusReleaseFingerprint({
  catalog,
  ingest,
  documentedSources,
  insights,
  onlineVerificationSamples,
  classifications: [...classifications.values()],
  pagePublicationManifest,
  semanticPublicationPolicy,
  semanticPublicationRevisionSha256: semanticPublicationGate.revision_sha256,
  compendiumItemBoundaries,
  textAssets: corpusTextAssets,
});
const corpusReleaseId = `corpus-${corpusReleaseFingerprint.slice(0, 24)}`;
const compendiumProjection = buildCompendiumCorpusProjection(compendiumItemBoundaries, corpusReleaseId);
const compendiumProjectionById = new Map(compendiumProjection.rows.map((item) => [item.id, item]));
for (const item of compendiumProjection.rows) {
  if (item.page_publication_release_id !== currentPagePublicationReleaseId) {
    throw new Error(`${item.id}: page-publication release is stale`);
  }
  if (!pagePublicationByDocument.has(item.parent_document_id)) {
    throw new Error(`${item.id}: parent document lacks an accepted page manifest`);
  }
}

const compendiumPageAssetCache = new Map();
async function readCompendiumPageAsset(documentId, pageNumber) {
  const key = `${documentId}:${pageNumber}`;
  if (compendiumPageAssetCache.has(key)) return compendiumPageAssetCache.get(key);
  const [primaryBytes, witnessBytes, sourceImageBytes] = await Promise.all([
    readFile(join(ocrRoot, documentId, 'pages', String(pageNumber).padStart(4, '0'), 'content.md')),
    readFile(join(witnessRoot, documentId, 'vision', `page-${String(pageNumber).padStart(3, '0')}.json`)),
    readFile(join(witnessRoot, documentId, 'images', `page-${String(pageNumber).padStart(3, '0')}.png`)),
  ]);
  const asset = { primaryBytes, witnessBytes, sourceImageBytes };
  compendiumPageAssetCache.set(key, asset);
  return asset;
}

async function verifyCorpusCompendiumItems({ documentBoundary, pagePublication }) {
  const activeItems = documentBoundary.items.filter((item) => item.display_allowed);
  if (activeItems.length === 0) return;
  const acceptedPageByNumber = new Map(pagePublication.map((page) => [page.page_number, {
    document_id: documentBoundary.document_id,
    page_number: page.page_number,
    source_artifact_sha256: page.source_artifact_sha256,
    source_page_sha256: page.source_page_sha256,
    final_text_sha256: page.page_final_text_sha256,
    evidence_bundle_sha256: page.evidence_bundle_sha256,
    stable_locator: page.stable_locator,
    display_allowed: page.display_allowed,
    citation_allowed: page.citation_allowed,
  }]));

  for (const item of activeItems) {
    const pageNumbers = Array.from(
      { length: item.candidate_physical_page_end - item.candidate_physical_page_start + 1 },
      (_, index) => item.candidate_physical_page_start + index,
    );
    const boundPages = [];
    const rawPages = [];
    for (const pageNumber of pageNumbers) {
      const acceptedPage = acceptedPageByNumber.get(pageNumber);
      if (!acceptedPage?.display_allowed) {
        throw new Error(`${item.item_id}: page ${pageNumber} is absent from the current display-accepted corpus`);
      }
      const asset = await readCompendiumPageAsset(documentBoundary.document_id, pageNumber);
      verifyCompendiumPageAssetEvidence({
        documentBoundary,
        pageNumber,
        primaryBytes: asset.primaryBytes,
        witnessBytes: asset.witnessBytes,
        sourceImageBytes: asset.sourceImageBytes,
        acceptedPage,
      });
      boundPages.push(acceptedPage);
      rawPages.push(asset.primaryBytes.toString('utf8'));
    }

    const firstPageAsset = await readCompendiumPageAsset(
      documentBoundary.document_id,
      item.body_heading.physical_page,
    );
    verifyCompendiumHeadingEvidence({
      documentBoundary,
      item,
      primaryBytes: firstPageAsset.primaryBytes,
      witnessBytes: firstPageAsset.witnessBytes,
      sourceImageBytes: firstPageAsset.sourceImageBytes,
      acceptedPage: boundPages[0],
    });
    const nextItem = documentBoundary.items[item.sequence];
    if (nextItem) {
      const nextHeadingAsset = await readCompendiumPageAsset(
        documentBoundary.document_id,
        nextItem.body_heading.physical_page,
      );
      verifyCompendiumHeadingEvidence({
        documentBoundary,
        item: nextItem,
        primaryBytes: nextHeadingAsset.primaryBytes,
        witnessBytes: nextHeadingAsset.witnessBytes,
        sourceImageBytes: nextHeadingAsset.sourceImageBytes,
      });
    }

    const verified = verifyCompendiumItemPageEvidence({
      documentBoundary,
      item,
      boundPages,
      rawPages,
      currentPagePublicationReleaseId,
    });
    const projected = compendiumProjectionById.get(item.item_id);
    if (!projected
      || projected.page_set_sha256 !== verified.page_set_sha256
      || projected.item_citation_entitlement_sha256 !== verified.item_citation_entitlement_sha256) {
      throw new Error(`${item.item_id}: D1 projection drifted from the actual page evidence`);
    }
  }
}
const outputDir = new URL('data/corpus-chunks/', projectRoot);
let previousCorpusManifest = null;
try {
  const previousRawManifest = JSON.parse(
    await readFile(new URL('manifest.json', outputDir), 'utf8'),
  );
  try {
    previousCorpusManifest = validateCorpusManifest(previousRawManifest);
  } catch {
    // A legacy envelope cannot supply a reusable audit timestamp.
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

function sql(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function stableHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function yearFor(record) {
  const value = record.issued_date || record.published_date || record.version_label;
  const match = String(value || '').match(/(19|20)\d{2}/);
  return match ? Number(match[0]) : null;
}

function periodFor(year) {
  if (!year) return null;
  if (year <= 1985) return 'foundation';
  if (year <= 2000) return 'compulsory';
  if (year <= 2010) return 'new-curriculum';
  if (year <= 2016) return 'standards';
  return 'competencies';
}

function textQualityFor(record) {
  return record.text_quality_status;
}

function citationAllowedFor(record) {
  return record.citation_allowed ? 1 : 0;
}

function providerFor(record) {
  if (record.id.startsWith('ictr-') || record.id.startsWith('legacy-compendium-')) return '教育部课程教材研究所';
  if (record.id.startsWith('neea-')) return '教育部考试中心';
  return record.issued_by || '来源机构待核';
}

const statements = [];
for (const record of catalog.documents) {
  const year = yearFor(record);
  statements.push(`INSERT INTO documents(id,title,subject,stage,document_type,version_label,issued_by,issued_date,published_date,current_status,source_tier,access_status,source_page_url,source_url,file_format,redistribution,checksum_sha256,note,period_id,sort_year,text_quality_status,ocr_engine,ocr_audit_ref,citation_allowed,page_count,corpus_release_id) VALUES(${[
    record.id, record.title, record.subject, record.stage, record.document_type, record.version_label,
    record.issued_by, record.issued_date, record.published_date, record.current_status, record.source_tier,
    record.access_status, record.source_page_url, record.source_url, record.file_format, record.redistribution,
    checksumById.get(record.id) || record.checksum_sha256, record.note, periodFor(year), year,
    textQualityFor(record), record.ocr_engine, record.ocr_audit_ref, citationAllowedFor(record), record.page_count,
    corpusReleaseId,
  ].map(sql).join(',')}) ON CONFLICT(id) DO UPDATE SET title=excluded.title,subject=excluded.subject,stage=excluded.stage,document_type=excluded.document_type,version_label=excluded.version_label,issued_by=excluded.issued_by,issued_date=excluded.issued_date,published_date=excluded.published_date,current_status=excluded.current_status,source_tier=excluded.source_tier,access_status=excluded.access_status,source_page_url=excluded.source_page_url,source_url=excluded.source_url,file_format=excluded.file_format,redistribution=excluded.redistribution,checksum_sha256=excluded.checksum_sha256,note=excluded.note,period_id=excluded.period_id,sort_year=excluded.sort_year,text_quality_status=excluded.text_quality_status,ocr_engine=excluded.ocr_engine,ocr_audit_ref=excluded.ocr_audit_ref,citation_allowed=excluded.citation_allowed,page_count=excluded.page_count,corpus_release_id=excluded.corpus_release_id;`);
  const classification = classifications.get(record.id);
  statements.push(`INSERT INTO document_classifications(document_id,entity_kind,taxonomy_entity_kind,canonical_subject,display_facet,subject_family,scope_kind,scope_label,source_subject_label,decision_basis,reviewed_at) VALUES(${[
    classification.document_id, classification.entity_kind, classification.taxonomy_entity_kind,
    classification.canonical_subject, classification.display_facet, classification.subject_family,
    classification.scope_kind, classification.scope_label, classification.source_subject_label,
    classification.decision_basis, classification.reviewed_at,
  ].map(sql).join(',')}) ON CONFLICT(document_id) DO UPDATE SET entity_kind=excluded.entity_kind,taxonomy_entity_kind=excluded.taxonomy_entity_kind,canonical_subject=excluded.canonical_subject,display_facet=excluded.display_facet,subject_family=excluded.subject_family,scope_kind=excluded.scope_kind,scope_label=excluded.scope_label,source_subject_label=excluded.source_subject_label,decision_basis=excluded.decision_basis,reviewed_at=excluded.reviewed_at;`);
}
statements.push(`DELETE FROM document_sources WHERE document_id IN (
  SELECT id FROM documents WHERE corpus_release_id=${sql(corpusReleaseId)}
);`);
statements.push('DELETE FROM subject_insights;');
statements.push('DELETE FROM term_relations;');
statements.push('DELETE FROM terms;');
statements.push(`UPDATE paragraphs SET display_allowed=0,citation_allowed=0 WHERE document_id IN (
  SELECT id FROM documents WHERE text_quality_status != 'official_native_text'
);`);
statements.push(`UPDATE page_publication_gates SET display_allowed=0,citation_allowed=0
  WHERE publication_basis='accepted_ocr_page_manifest';`);

const sourceRows = new Map();
for (const record of catalog.documents) {
  sourceRows.set(`${record.id}\0${record.source_url}`, {
    document_id: record.id,
    provider: providerFor(record),
    source_page_url: record.source_page_url,
    source_url: record.source_url,
    checksum_sha256: checksumById.get(record.id) || record.checksum_sha256 || null,
    access_status: record.access_status,
    is_primary: 1,
    note: record.note || null,
  });
}
for (const source of documentedSources) {
  sourceRows.set(`${source.document_id}\0${source.source_url}`, source);
}
const coreTableCounts = {
  subjects: 0,
  periods: 5,
  document_relations: 0,
  chapters: 0,
  document_classifications: classifications.size,
  document_sources: sourceRows.size,
  primary_document_sources: [...sourceRows.values()].filter((source) => Number(source.is_primary) === 1).length,
  subject_insights: insights.insights.length,
  terms: insights.terms.length,
  term_relations: insights.relations.length,
  version_diffs: 0,
  online_verifications: onlineVerificationSamples.length,
  online_evidence: onlineVerificationSamples.reduce(
    (count, verification) => count + verification.online_evidence.length,
    0,
  ),
  embedded_items: compendiumProjection.rows.length,
};
for (const item of compendiumProjection.rows) {
  statements.push(`INSERT INTO embedded_items(id,parent_document_id,parent_item_id,sequence,item_kind,title,raw_title,stage,display_year,year_basis,physical_page_start,physical_page_end,printed_page_start,issuing_body,identity_status,page_publication_release_id,page_set_sha256,item_citation_entitlement_sha256,online_verification_status,online_source_ids_json,display_allowed,citation_allowed,semantic_claim_allowed,uncertainty_note,corpus_release_id) VALUES(${[
    item.id, item.parent_document_id, item.parent_item_id, item.sequence, item.item_kind, item.title,
    item.raw_title, item.stage, item.display_year, item.year_basis, item.physical_page_start,
    item.physical_page_end, item.printed_page_start, item.issuing_body, item.identity_status,
    item.page_publication_release_id, item.page_set_sha256, item.item_citation_entitlement_sha256,
    item.online_verification_status, item.online_source_ids_json, item.display_allowed,
    item.citation_allowed, item.semantic_claim_allowed, item.uncertainty_note, item.corpus_release_id,
  ].map(sql).join(',')}) ON CONFLICT(id) DO UPDATE SET parent_document_id=excluded.parent_document_id,parent_item_id=excluded.parent_item_id,sequence=excluded.sequence,item_kind=excluded.item_kind,title=excluded.title,raw_title=excluded.raw_title,stage=excluded.stage,display_year=excluded.display_year,year_basis=excluded.year_basis,physical_page_start=excluded.physical_page_start,physical_page_end=excluded.physical_page_end,printed_page_start=excluded.printed_page_start,issuing_body=excluded.issuing_body,identity_status=excluded.identity_status,page_publication_release_id=excluded.page_publication_release_id,page_set_sha256=excluded.page_set_sha256,item_citation_entitlement_sha256=excluded.item_citation_entitlement_sha256,online_verification_status=excluded.online_verification_status,online_source_ids_json=excluded.online_source_ids_json,display_allowed=excluded.display_allowed,citation_allowed=excluded.citation_allowed,semantic_claim_allowed=excluded.semantic_claim_allowed,uncertainty_note=excluded.uncertainty_note,corpus_release_id=excluded.corpus_release_id;`);
}
for (const source of sourceRows.values()) {
  statements.push(`INSERT OR REPLACE INTO document_sources(document_id,provider,source_page_url,source_url,checksum_sha256,access_status,is_primary,note) VALUES(${[
    source.document_id, source.provider, source.source_page_url, source.source_url, source.checksum_sha256,
    source.access_status, source.is_primary, source.note,
  ].map(sql).join(',')});`);
}

for (const item of insights.insights) {
  statements.push(`INSERT OR REPLACE INTO subject_insights(id,subject,era,dimension,title,summary,evidence_document_ids,sort_order) VALUES(${[
    item.id, item.subject, item.era, item.dimension, item.title, item.summary, JSON.stringify(item.evidence_document_ids), item.sort_order,
  ].map(sql).join(',')});`);
}
for (const term of insights.terms) {
  statements.push(`INSERT OR REPLACE INTO terms(id,label,definition,first_seen_year,category,evidence_document_ids) VALUES(${[
    term.id, term.label, term.definition, term.first_seen_year, term.category, JSON.stringify(term.evidence_document_ids),
  ].map(sql).join(',')});`);
}
for (const relation of insights.relations) {
  statements.push(`INSERT OR REPLACE INTO term_relations(source_term_id,target_term_id,relation_type,weight,evidence_document_ids) VALUES(${[
    relation.source, relation.target, relation.relation_type, relation.weight, JSON.stringify(relation.evidence_document_ids),
  ].map(sql).join(',')});`);
}
for (const verification of onlineVerificationSamples) {
  statements.push(`INSERT INTO online_verifications(id,document_id,paragraph_id,physical_page,printed_page,entity_type,entity_label,source_image_sha256,primary_ocr_sha256,edition_match_status,verification_status,resolution,uncertainty_note,citation_allowed,reviewed_by,corpus_release_id) VALUES(${[
    verification.id, verification.document_id, null, verification.physical_pdf_page, verification.printed_page,
    verification.entity_type, verification.entity_label, verification.source_image_sha256,
    verification.primary_ocr_sha256, verification.edition_match_status, verification.verification_status,
    verification.resolution, verification.uncertainty_note, verification.citation_allowed ? 1 : 0,
    verification.reviewed_by, corpusReleaseId,
  ].map(sql).join(',')}) ON CONFLICT(id) DO UPDATE SET document_id=excluded.document_id,paragraph_id=excluded.paragraph_id,physical_page=excluded.physical_page,printed_page=excluded.printed_page,entity_type=excluded.entity_type,entity_label=excluded.entity_label,source_image_sha256=excluded.source_image_sha256,primary_ocr_sha256=excluded.primary_ocr_sha256,edition_match_status=excluded.edition_match_status,verification_status=excluded.verification_status,resolution=excluded.resolution,uncertainty_note=excluded.uncertainty_note,citation_allowed=excluded.citation_allowed,reviewed_by=excluded.reviewed_by,corpus_release_id=excluded.corpus_release_id,updated_at=CURRENT_TIMESTAMP;`);
  statements.push(`DELETE FROM online_evidence WHERE verification_id=${sql(verification.id)};`);
  for (const evidence of verification.online_evidence) {
    statements.push(`INSERT INTO online_evidence(verification_id,role,publisher,source_type,source_title,source_url,published_at,retrieved_at,version_match,fact_summary,content_sha256) VALUES(${[
      verification.id, evidence.role, evidence.publisher, evidence.source_type, evidence.source_title || null,
      evidence.url, evidence.published_at || null, evidence.retrieved_at || '2026-07-15', evidence.version_match,
      evidence.fact, evidence.content_sha256 || null,
    ].map(sql).join(',')});`);
  }
}
statements.push(`INSERT OR REPLACE INTO site_meta(key,value) VALUES('catalog_document_count', ${sql(String(catalog.documents.length))});`);
statements.push(`INSERT OR REPLACE INTO site_meta(key,value) VALUES('citation_ready_document_count', ${sql(String(catalog.documents.filter((record) => citationAllowedFor(record)).length))});`);
statements.push(`INSERT OR REPLACE INTO site_meta(key,value) VALUES('classified_document_count', ${sql(String(classifications.size))});`);
statements.push(`INSERT OR REPLACE INTO site_meta(key,value) VALUES('unclassified_document_count', ${sql(String(unclassified.length))});`);
statements.push(`INSERT OR REPLACE INTO site_meta(key,value) VALUES('document_classification_schema_version', '2');`);
statements.push(`INSERT OR REPLACE INTO site_meta(key,value) VALUES('page_publication_schema_version', '1');`);
statements.push(`INSERT OR REPLACE INTO site_meta(key,value) VALUES('semantic_publication_schema_version', ${sql(String(semanticPublicationGate.schema_version))});`);
statements.push(`INSERT OR REPLACE INTO site_meta(key,value) VALUES('semantic_publication_policy', ${sql(semanticPublicationGate.policy)});`);
statements.push(`INSERT OR REPLACE INTO site_meta(key,value) VALUES('semantic_publication_revision_sha256', ${sql(semanticPublicationGate.revision_sha256)});`);
statements.push(`INSERT OR REPLACE INTO site_meta(key,value) VALUES('exact_duplicate_alias_document_count', ${sql(String(semanticPublicationGate.aliasById.size))});`);

let paragraphStatements = [];
let paragraphIdentityRows = [];
let chunkIndex = 1;
let totalParagraphs = 0;
let displayedParagraphs = 0;
let closedOcrParagraphs = 0;
let skippedOcrDocuments = 0;
let excludedAliasDocuments = 0;
let semanticExcludedPages = 0;
let acceptedOcrDocuments = 0;
let pagePublicationGates = 0;
const sqlFiles = [];
async function writeSqlFile(name, content) {
  await writeFile(join(outputDir.pathname, name), content);
  sqlFiles.push({
    name,
    sha256: stableHash(content),
    bytes: Buffer.byteLength(content, 'utf8'),
  });
}
async function flush() {
  if (paragraphStatements.length === 0) return;
  const chunkName = `${String(chunkIndex).padStart(3, '0')}-paragraphs.sql`;
  const identityGuard = buildParagraphIdentityGuardSql(paragraphIdentityRows, chunkName);
  const content = [identityGuard, ...paragraphStatements, ''].filter(Boolean).join('\n');
  await writeSqlFile(chunkName, content);
  chunkIndex += 1;
  paragraphStatements = [];
  paragraphIdentityRows = [];
}

for (const record of catalog.documents) {
  if (semanticDocumentDisposition(semanticPublicationGate, record).excluded) {
    excludedAliasDocuments += 1;
    continue;
  }
  const nativeText = isNativeTextRecord(record);
  const acceptedOcrDocument = pagePublicationByDocument.get(record.id);
  if (!nativeText && !acceptedOcrDocument) {
    skippedOcrDocuments += 1;
    continue;
  }
  const raw = corpusTextById.get(record.id);
  if (raw === undefined) continue;
  const pages = raw.split('\f');
  const documentCitationAllowed = citationAllowedFor(record);
  const textQualityStatus = textQualityFor(record);
  const sourceArtifactSha256 = checksumById.get(record.id) || record.checksum_sha256
    || (nativeText ? sha256Text(raw) : null);
  const acceptedPagePublication = nativeText
    ? pages.map((page, pageIndex) => ({
      page_number: pageIndex + 1,
      source_artifact_sha256: sourceArtifactSha256,
      source_page_sha256: null,
      page_final_text_sha256: sha256Text(page),
      evidence_bundle_sha256: null,
      stable_locator: `${record.id}:page:${pageIndex + 1}`,
      review_status: 'official_native_text',
      reviewed_by: null,
      reviewed_at: null,
      uncertainty_note: null,
      display_allowed: true,
      citation_allowed: Boolean(documentCitationAllowed),
    }))
    : bindAcceptedOcrDocument({
      record,
      sourceArtifactSha256,
      rawPages: pages,
      manifestDocument: acceptedOcrDocument,
      documentCitationAllowed: Boolean(documentCitationAllowed),
    });
  if (!nativeText) acceptedOcrDocuments += 1;
  const pagePublication = acceptedPagePublication.map((page, pageIndex) => applySemanticPagePublication({
    gate: semanticPublicationGate,
    record,
    page,
    rawText: pages[pageIndex],
  }));
  const compendiumBoundary = compendiumBoundaryByDocument.get(record.id);
  if (compendiumBoundary) {
    await verifyCorpusCompendiumItems({ documentBoundary: compendiumBoundary, pagePublication });
  }
  let ordinal = 0;
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const pageGate = pagePublication[pageIndex];
    pagePublicationGates += 1;
    paragraphStatements.push(`INSERT INTO page_publication_gates(document_id,page_number,source_artifact_sha256,source_page_sha256,final_text_sha256,evidence_bundle_sha256,stable_locator,publication_basis,review_status,reviewed_by,reviewed_at,uncertainty_note,display_allowed,citation_allowed,corpus_release_id) VALUES(${[
      record.id, pageGate.page_number, pageGate.source_artifact_sha256, pageGate.source_page_sha256,
      pageGate.page_final_text_sha256, pageGate.evidence_bundle_sha256, pageGate.stable_locator,
      nativeText ? 'official_native_text' : 'accepted_ocr_page_manifest', pageGate.review_status,
      pageGate.reviewed_by, pageGate.reviewed_at, pageGate.uncertainty_note,
      pageGate.display_allowed ? 1 : 0, pageGate.citation_allowed ? 1 : 0, corpusReleaseId,
    ].map(sql).join(',')}) ON CONFLICT(document_id,page_number) DO UPDATE SET source_artifact_sha256=excluded.source_artifact_sha256,source_page_sha256=excluded.source_page_sha256,final_text_sha256=excluded.final_text_sha256,evidence_bundle_sha256=excluded.evidence_bundle_sha256,stable_locator=excluded.stable_locator,publication_basis=excluded.publication_basis,review_status=excluded.review_status,reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at,uncertainty_note=excluded.uncertainty_note,display_allowed=excluded.display_allowed,citation_allowed=excluded.citation_allowed,corpus_release_id=excluded.corpus_release_id;`);
    if (paragraphStatements.length >= 250) await flush();
    if (pageGate.semantic_excluded) {
      semanticExcludedPages += 1;
      continue;
    }
    const candidates = pages[pageIndex].split(/\n\s*\n/);
    for (let blockIndex = 0; blockIndex < candidates.length; blockIndex += 1) {
      const candidate = candidates[blockIndex];
      const body = canonicalParagraphBody(candidate);
      if (!isCanonicalParagraphBody(body)) continue;
      ordinal += 1;
      totalParagraphs += 1;
      const locator = `第${pageIndex + 1}页·段${ordinal}`;
      const bodySha256 = stableHash(body);
      const provenanceLocator = paragraphProvenanceLocator(record.id, pageIndex + 1, blockIndex + 1, bodySha256);
      const embeddedItem = compendiumItemForPage(compendiumProjection, record.id, pageIndex + 1);
      const isCompendiumCarrier = compendiumProjection.byDocument.has(record.id);
      const paragraphDisplayAllowed = pageGate.display_allowed && (!isCompendiumCarrier || Boolean(embeddedItem));
      const paragraphCitationAllowed = effectiveParagraphCitationAllowed({
        paragraphAllowed: paragraphDisplayAllowed,
        pageAllowed: pageGate.citation_allowed,
        documentAllowed: documentCitationAllowed,
        embeddedItemId: embeddedItem?.id || null,
        itemAllowed: embeddedItem?.citation_allowed,
      });
      if (paragraphDisplayAllowed) displayedParagraphs += 1;
      else if (!nativeText) closedOcrParagraphs += 1;
      paragraphStatements.push(`INSERT INTO paragraphs(document_id,ordinal,page_number,heading,body,source_locator,body_sha256,text_quality_status,ocr_quality_score,citation_allowed,display_allowed,source_artifact_sha256,source_page_sha256,page_final_text_sha256,evidence_bundle_sha256,provenance_locator,uncertainty_note,corpus_release_id,embedded_item_id) VALUES(${[
        record.id, ordinal, pageIndex + 1, null, body, locator, bodySha256, textQualityStatus, null,
        paragraphCitationAllowed ? 1 : 0, paragraphDisplayAllowed ? 1 : 0,
        pageGate.source_artifact_sha256, pageGate.source_page_sha256, pageGate.page_final_text_sha256,
        pageGate.evidence_bundle_sha256, provenanceLocator, embeddedItem?.uncertainty_note || pageGate.uncertainty_note,
        corpusReleaseId, embeddedItem?.id || null,
      ].map(sql).join(',')}) ON CONFLICT(document_id,ordinal) DO UPDATE SET page_number=excluded.page_number,heading=excluded.heading,body=excluded.body,source_locator=excluded.source_locator,body_sha256=excluded.body_sha256,text_quality_status=excluded.text_quality_status,ocr_quality_score=excluded.ocr_quality_score,citation_allowed=excluded.citation_allowed,display_allowed=excluded.display_allowed,source_artifact_sha256=excluded.source_artifact_sha256,source_page_sha256=excluded.source_page_sha256,page_final_text_sha256=excluded.page_final_text_sha256,evidence_bundle_sha256=excluded.evidence_bundle_sha256,provenance_locator=excluded.provenance_locator,uncertainty_note=excluded.uncertainty_note,corpus_release_id=excluded.corpus_release_id,embedded_item_id=excluded.embedded_item_id;`);
      paragraphIdentityRows.push({
        document_id: record.id,
        ordinal,
        page_number: pageIndex + 1,
        heading: null,
        source_locator: locator,
        body_sha256: bodySha256,
        provenance_locator: provenanceLocator,
        embedded_item_id: embeddedItem?.id || null,
      });
      if (paragraphStatements.length >= 250) await flush();
    }
  }
}
await flush();
await writeSqlFile('000-core.sql', `${statements.join('\n')}\n`);
sqlFiles.sort((left, right) => left.name.localeCompare(right.name));
const manifestProjection = {
  generated_at: previousCorpusManifest?.generated_at || new Date().toISOString(),
  schema_version: 1,
  release_id: corpusReleaseId,
  release_fingerprint_sha256: corpusReleaseFingerprint,
  documents: catalog.documents.length,
  paragraphs: totalParagraphs,
  fts_rows: totalParagraphs,
  page_publication_gates: pagePublicationGates,
  displayed_paragraphs: displayedParagraphs,
  accepted_ocr_documents: acceptedOcrDocuments,
  core_table_counts: coreTableCounts,
  text_asset_count: corpusTextAssets.length,
  text_assets: corpusTextAssets,
  sql_chunks: sqlFiles.length,
  sql_files: sqlFiles,
  closed_ocr_paragraphs: closedOcrParagraphs,
  skipped_ocr_documents: skippedOcrDocuments,
  excluded_exact_duplicate_alias_documents: excludedAliasDocuments,
  semantic_excluded_pages: semanticExcludedPages,
  page_publication_schema_version: pagePublicationManifest.schema_version,
  semantic_publication_schema_version: semanticPublicationGate.schema_version,
  semantic_publication_revision_sha256: semanticPublicationGate.revision_sha256,
};
let corpusManifest = sealCorpusManifest(manifestProjection);
if (previousCorpusManifest && JSON.stringify(corpusManifest) !== JSON.stringify(previousCorpusManifest)) {
  corpusManifest = sealCorpusManifest({
    ...manifestProjection,
    generated_at: new Date().toISOString(),
  });
}
await writeFile(join(outputDir.pathname, 'manifest.json'), `${JSON.stringify(corpusManifest, null, 2)}\n`);
console.log(`Built ${totalParagraphs} paragraphs across ${sqlFiles.length} SQL chunks.`);
