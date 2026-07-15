import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadDocumentClassificationResolver } from './document-classification.mjs';

const projectRoot = new URL('../', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('data/catalog.json', projectRoot), 'utf8'));
const insights = JSON.parse(await readFile(new URL('data/subject-insights.json', projectRoot), 'utf8'));
const ingest = JSON.parse(await readFile(new URL('data/ingest-manifest.json', projectRoot), 'utf8'));
const documentedSources = JSON.parse(await readFile(new URL('data/document-sources.json', projectRoot), 'utf8')).sources;
const onlineVerificationSamples = JSON.parse(await readFile(new URL('data/online-verification-samples.json', projectRoot), 'utf8')).samples;
const checksumById = new Map(ingest.entries.map((entry) => [entry.id, entry.source_sha256]));
const classifyDocument = await loadDocumentClassificationResolver(projectRoot);
const classifications = new Map(catalog.documents.map((record) => [record.id, classifyDocument(record)]));
const unclassified = [...classifications.values()].filter((item) => item.scope_kind === 'unclassified');
if (unclassified.length) {
  throw new Error(`Unclassified document subjects: ${unclassified.map((item) => `${item.document_id}:${item.source_subject_label}`).join(', ')}`);
}
const outputDir = new URL('data/corpus-chunks/', projectRoot);
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

function normalizeBlock(value) {
  return value
    .replace(/\u0000/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(/\s+([，。；：！？、])/g, '$1')
    .trim();
}

function useful(value) {
  if (value.length < 24 || value.length > 2200) return false;
  const meaningful = (value.match(/[\p{Script=Han}A-Za-z0-9]/gu) || []).length;
  return meaningful / value.length > 0.55 && !/^(目\s*录|contents?)$/i.test(value);
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
  if (record.text_quality_status) return record.text_quality_status;
  if (['html', 'catalog'].includes(record.file_format)) return 'official_native_text';
  if (record.file_format === 'pdf_in_zip' || record.id.startsWith('neea-2019-')) return 'official_native_text';
  return 'not_assessed';
}

function citationAllowedFor(record) {
  if (record.citation_allowed === true) return 1;
  if (record.citation_allowed === false) return 0;
  return ['html', 'catalog', 'pdf_in_zip'].includes(record.file_format) || record.id.startsWith('neea-2019-') ? 1 : 0;
}

function providerFor(record) {
  if (record.id.startsWith('ictr-') || record.id.startsWith('legacy-compendium-')) return '教育部课程教材研究所';
  if (record.id.startsWith('neea-')) return '教育部考试中心';
  return record.issued_by || '来源机构待核';
}

const statements = [];
for (const record of catalog.documents) {
  const year = yearFor(record);
  statements.push(`INSERT INTO documents(id,title,subject,stage,document_type,version_label,issued_by,issued_date,published_date,current_status,source_tier,access_status,source_page_url,source_url,file_format,redistribution,checksum_sha256,note,period_id,sort_year,text_quality_status,ocr_engine,ocr_audit_ref,citation_allowed,page_count) VALUES(${[
    record.id, record.title, record.subject, record.stage, record.document_type, record.version_label,
    record.issued_by, record.issued_date, record.published_date, record.current_status, record.source_tier,
    record.access_status, record.source_page_url, record.source_url, record.file_format, record.redistribution,
    checksumById.get(record.id) || record.checksum_sha256, record.note, periodFor(year), year,
    textQualityFor(record), record.ocr_engine, record.ocr_audit_ref, citationAllowedFor(record), record.page_count,
  ].map(sql).join(',')}) ON CONFLICT(id) DO UPDATE SET title=excluded.title,subject=excluded.subject,stage=excluded.stage,document_type=excluded.document_type,version_label=excluded.version_label,issued_by=excluded.issued_by,issued_date=excluded.issued_date,published_date=excluded.published_date,current_status=excluded.current_status,source_tier=excluded.source_tier,access_status=excluded.access_status,source_page_url=excluded.source_page_url,source_url=excluded.source_url,file_format=excluded.file_format,redistribution=excluded.redistribution,checksum_sha256=excluded.checksum_sha256,note=excluded.note,period_id=excluded.period_id,sort_year=excluded.sort_year,text_quality_status=excluded.text_quality_status,ocr_engine=excluded.ocr_engine,ocr_audit_ref=excluded.ocr_audit_ref,citation_allowed=excluded.citation_allowed,page_count=excluded.page_count;`);
  const classification = classifications.get(record.id);
  statements.push(`INSERT INTO document_classifications(document_id,entity_kind,canonical_subject,subject_family,scope_kind,scope_label,source_subject_label,decision_basis,reviewed_at) VALUES(${[
    classification.document_id, classification.entity_kind, classification.canonical_subject, classification.subject_family,
    classification.scope_kind, classification.scope_label, classification.source_subject_label,
    classification.decision_basis, classification.reviewed_at,
  ].map(sql).join(',')}) ON CONFLICT(document_id) DO UPDATE SET entity_kind=excluded.entity_kind,canonical_subject=excluded.canonical_subject,subject_family=excluded.subject_family,scope_kind=excluded.scope_kind,scope_label=excluded.scope_label,source_subject_label=excluded.source_subject_label,decision_basis=excluded.decision_basis,reviewed_at=excluded.reviewed_at;`);
}

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
  statements.push(`INSERT OR REPLACE INTO online_verifications(id,document_id,paragraph_id,physical_page,printed_page,entity_type,entity_label,source_image_sha256,primary_ocr_sha256,edition_match_status,verification_status,resolution,uncertainty_note,citation_allowed,reviewed_by) VALUES(${[
    verification.id, verification.document_id, null, verification.physical_pdf_page, verification.printed_page,
    verification.entity_type, verification.entity_label, verification.source_image_sha256,
    verification.primary_ocr_sha256, verification.edition_match_status, verification.verification_status,
    verification.resolution, verification.uncertainty_note, verification.citation_allowed ? 1 : 0,
    verification.reviewed_by,
  ].map(sql).join(',')});`);
  for (const evidence of verification.online_evidence) {
    statements.push(`INSERT OR REPLACE INTO online_evidence(verification_id,role,publisher,source_type,source_title,source_url,published_at,retrieved_at,version_match,fact_summary,content_sha256) VALUES(${[
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
statements.push(`INSERT OR REPLACE INTO site_meta(key,value) VALUES('document_classification_schema_version', '1');`);
await writeFile(join(outputDir.pathname, '000-core.sql'), `${statements.join('\n')}\n`);

let paragraphStatements = [];
let chunkIndex = 1;
let totalParagraphs = 0;
async function flush() {
  if (paragraphStatements.length === 0) return;
  const content = [...paragraphStatements, ''].join('\n');
  await writeFile(join(outputDir.pathname, `${String(chunkIndex).padStart(3, '0')}-paragraphs.sql`), content);
  chunkIndex += 1;
  paragraphStatements = [];
}

for (const record of catalog.documents) {
  const textUrl = new URL(`.cache/text/${record.id}.txt`, projectRoot);
  try { await access(textUrl); } catch { continue; }
  const raw = await readFile(textUrl, 'utf8');
  const pages = raw.split('\f');
  const documentCitationAllowed = citationAllowedFor(record);
  const textQualityStatus = textQualityFor(record);
  let ordinal = 0;
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    for (const candidate of pages[pageIndex].split(/\n\s*\n/)) {
      const body = normalizeBlock(candidate);
      if (!useful(body)) continue;
      ordinal += 1;
      totalParagraphs += 1;
      const locator = `第${pageIndex + 1}页·段${ordinal}`;
      paragraphStatements.push(`INSERT INTO paragraphs(document_id,ordinal,page_number,heading,body,source_locator,body_sha256,text_quality_status,ocr_quality_score,citation_allowed) VALUES(${[
        record.id, ordinal, pageIndex + 1, null, body, locator, stableHash(body), textQualityStatus, null, documentCitationAllowed,
      ].map(sql).join(',')}) ON CONFLICT(document_id,ordinal) DO UPDATE SET page_number=excluded.page_number,heading=excluded.heading,body=excluded.body,source_locator=excluded.source_locator,body_sha256=excluded.body_sha256,text_quality_status=excluded.text_quality_status,ocr_quality_score=excluded.ocr_quality_score,citation_allowed=excluded.citation_allowed;`);
      if (paragraphStatements.length >= 250) await flush();
    }
  }
}
await flush();
await writeFile(join(outputDir.pathname, 'manifest.json'), `${JSON.stringify({
  generated_at: new Date().toISOString(), documents: catalog.documents.length, paragraphs: totalParagraphs, sql_chunks: chunkIndex,
}, null, 2)}\n`);
console.log(`Built ${totalParagraphs} paragraphs across ${chunkIndex} SQL chunks.`);
