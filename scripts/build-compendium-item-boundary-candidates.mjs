#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compendiumStableItemId,
  compendiumTocEntryReceiptSha256,
  compendiumTocPageReceiptSha256,
} from './compendium-evidence-receipt.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseArgs(argv) {
  const options = { tocPages: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`invalid argument near ${key || '<end>'}`);
    }
    if (key === '--toc-page') options.tocPages.push(Number(value));
    else if (key === '--document-id') options.documentId = value;
    else if (key === '--source-sha256') options.sourceSha256 = value;
    else if (key === '--page-count') options.pageCount = Number(value);
    else if (key === '--physical-offset') options.physicalOffset = Number(value);
    else if (key === '--ocr-root') options.ocrRoot = value;
    else if (key === '--witness-root') options.witnessRoot = value;
    else if (key === '--output') options.output = value;
    else if (key === '--reviewer-id') options.reviewerId = value;
    else if (key === '--reviewed-at') options.reviewedAt = value;
    else throw new Error(`unexpected argument: ${key}`);
    index += 1;
  }
  if (!/^[a-z0-9][a-z0-9-]+$/.test(options.documentId || '')) throw new Error('--document-id is invalid');
  if (!/^[a-f0-9]{64}$/.test(options.sourceSha256 || '')) throw new Error('--source-sha256 is invalid');
  if (!Number.isSafeInteger(options.pageCount) || options.pageCount < 1) throw new Error('--page-count is invalid');
  if (!Number.isSafeInteger(options.physicalOffset)) throw new Error('--physical-offset is invalid');
  if (!options.ocrRoot || !options.witnessRoot || !options.output) throw new Error('--ocr-root, --witness-root and --output are required');
  if (!options.reviewerId || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(options.reviewedAt || '')) {
    throw new Error('--reviewer-id and canonical --reviewed-at are required');
  }
  options.tocPages = [...new Set(options.tocPages)].sort((left, right) => left - right);
  if (options.tocPages.length === 0) throw new Error('at least one --toc-page is required');
  return options;
}

function canonicalTitle(rawTitle) {
  return rawTitle.normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(/^附件([一二三四五六七八九十])\s+([（(])/u, '附件$1$2')
    .trim();
}

async function readTocPage(options, pageNumber) {
  const pageName = String(pageNumber).padStart(4, '0');
  const visionName = String(pageNumber).padStart(3, '0');
  const primaryPath = path.join(options.ocrRoot, options.documentId, 'pages', pageName, 'content.md');
  const visionPath = path.join(options.witnessRoot, options.documentId, 'vision', `page-${visionName}.json`);
  const imagePath = path.join(options.witnessRoot, options.documentId, 'images', `page-${visionName}.png`);
  const [primaryRaw, visionRaw, imageRaw] = await Promise.all([
    readFile(primaryPath), readFile(visionPath), readFile(imagePath),
  ]);
  const vision = JSON.parse(visionRaw.toString('utf8'));
  if (vision.document_id !== options.documentId
    || vision.physical_pdf_page !== pageNumber
    || vision.source_pdf_sha256 !== options.sourceSha256
    || !/^[a-f0-9]{64}$/.test(vision.rendered_image_sha256 || '')
    || sha256(imageRaw) !== vision.rendered_image_sha256) {
    throw new Error(`TOC page ${pageNumber} Vision provenance is invalid`);
  }
  const page = {
    page_number: pageNumber,
    primary_text_sha256: sha256(primaryRaw),
    source_image_sha256: vision.rendered_image_sha256,
    vision_witness_sha256: sha256(visionRaw),
    primary_text: primaryRaw.toString('utf8'),
  };
  page.evidence_bundle_sha256 = compendiumTocPageReceiptSha256({
    documentId: options.documentId,
    sourceArtifactSha256: options.sourceSha256,
    pageNumber,
    primaryTextSha256: page.primary_text_sha256,
    sourceImageSha256: page.source_image_sha256,
    visionWitnessSha256: page.vision_witness_sha256,
  });
  return page;
}

export async function buildCompendiumBoundaryCandidates(options) {
  const tocPages = await Promise.all(options.tocPages.map((page) => readTocPage(options, page)));
  let section = null;
  let lastYear = null;
  const parsed = [];
  for (const page of tocPages) {
    for (const rawLine of page.primary_text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (/^##\s*小学部分$/u.test(line)) section = '小学';
      if (/^##\s*中学部分$/u.test(line)) section = '中学';
      const match = /^(?:(\d{4})\s*年\s*)?(.+?)\s+\.{3,}\s*(\d+)\s*$/u.exec(line);
      if (!match || Number(match[3]) < 3) continue;
      if (!section) throw new Error(`TOC entry appears before a section: ${line}`);
      const explicitYear = match[1] ? Number(match[1]) : null;
      if (explicitYear !== null) lastYear = explicitYear;
      const rawTitle = match[2].trim();
      const attachment = /^附件/u.test(rawTitle);
      if (explicitYear === null && (!attachment || lastYear === null)) {
        throw new Error(`undated non-attachment TOC entry: ${line}`);
      }
      const printedStart = Number(match[3]);
      const physicalStart = printedStart + options.physicalOffset;
      if (physicalStart < 1 || physicalStart > options.pageCount) {
        throw new Error(`TOC entry maps outside the PDF: ${line}`);
      }
      const previous = parsed.at(-1);
      if (attachment && (!previous || previous.section !== section || previous.display_year !== lastYear)) {
        throw new Error(`attachment lacks an adjacent same-year parent: ${line}`);
      }
      const sequence = parsed.length + 1;
      const entryReceiptSha256 = compendiumTocEntryReceiptSha256({
        documentId: options.documentId,
        sourceArtifactSha256: options.sourceSha256,
        tocPageNumber: page.page_number,
        tocPageEvidenceBundleSha256: page.evidence_bundle_sha256,
        sourceLine: line,
        section,
        displayYear: lastYear,
        rawTitle,
        printedPageStart: printedStart,
      });
      const itemId = compendiumStableItemId({
        documentId: options.documentId,
        sourceArtifactSha256: options.sourceSha256,
        tocEntryReceiptSha256: entryReceiptSha256,
      });
      parsed.push({
        item_id: itemId,
        sequence,
        section,
        item_kind: attachment ? 'attachment' : 'curriculum_document',
        parent_item_id: attachment ? previous.item_id : null,
        raw_title: rawTitle,
        title: canonicalTitle(rawTitle),
        display_year: lastYear,
        year_basis: attachment ? 'parent_notice_year' : 'toc_explicit_year',
        toc_physical_page: page.page_number,
        printed_page_start: printedStart,
        candidate_physical_page_start: physicalStart,
        issuing_body: null,
        toc_entry_evidence: {
          source_line: line,
          source_line_sha256: sha256(line),
          toc_page_evidence_bundle_sha256: page.evidence_bundle_sha256,
          entry_receipt_sha256: entryReceiptSha256,
        },
      });
    }
  }
  for (let index = 0; index < parsed.length; index += 1) {
    const item = parsed[index];
    const next = parsed[index + 1];
    item.candidate_physical_page_end = next ? next.candidate_physical_page_start - 1 : options.pageCount;
    item.toc_entry_sha256 = item.toc_entry_evidence.entry_receipt_sha256;
    item.body_heading = {
      verification_status: 'not_verified',
      physical_page: null,
      exact_text: null,
      exact_text_sha256: null,
      source_image_sha256: null,
      primary_ocr_sha256: null,
      witness_sha256: null,
      reviewer_id: null,
      reviewed_at: null,
    };
    item.online_verification = {
      verification_status: 'not_started',
      version_relation: null,
      source_ids: [],
      comparison_scope: null,
      primary_item_text_sha256: null,
      online_text_sha256: null,
      reviewer_id: null,
      reviewed_at: null,
      verification_note: null,
      uncertainty_note: '同篇同版在线文本尚未建立。',
    };
    item.page_evidence = {
      verification_status: 'not_verified',
      page_publication_release_id: null,
      physical_page_start: null,
      physical_page_end: null,
      accepted_page_count: null,
      page_set_sha256: null,
      item_citation_entitlement_sha256: null,
    };
    item.semantic_review = {
      review_status: 'not_started',
      reviewer_id: null,
      reviewed_at: null,
      review_note: null,
    };
    item.identity_status = 'toc_navigation_candidate';
    item.display_allowed = false;
    item.citation_allowed = false;
    item.semantic_claim_allowed = false;
    item.uncertainty_note = '目录仅用于定位候选篇目；正文首标题、末页、同版在线文本与逐页证据尚未闭合。';
  }
  return {
    $schema: './compendium-item-boundaries.schema.json',
    schema_version: 2,
    policy: 'fail_closed_compendium_item_boundaries_v2',
    documents: [{
      document_id: options.documentId,
      source_artifact_sha256: options.sourceSha256,
      physical_page_count: options.pageCount,
      printed_to_physical_page_offset: options.physicalOffset,
      toc_evidence: {
        physical_pages: tocPages.map((page) => ({
          page_number: page.page_number,
          primary_text_sha256: page.primary_text_sha256,
          source_image_sha256: page.source_image_sha256,
          vision_witness_sha256: page.vision_witness_sha256,
          evidence_bundle_sha256: page.evidence_bundle_sha256,
        })),
        review_status: 'human_image_review_pass_navigation_only',
        reviewer_id: options.reviewerId,
        reviewed_at: options.reviewedAt,
        review_note: '逐页对照扫描图与主 OCR：篇名、显式年份及印刷起始页一致；目录证据仅可导航，不能替代正文或同版在线核对。',
      },
      items: parsed,
    }],
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const value = await buildCompendiumBoundaryCandidates(options);
  try {
    await writeFile(options.output, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error('output already exists; generate to a new review path and merge only after evidence comparison');
    }
    throw error;
  }
  process.stdout.write(`${options.output}: ${value.documents[0].items.length} candidates\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`build-compendium-item-boundary-candidates: ${error.message}\n`);
    process.exitCode = 2;
  });
}
