#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  normalizeExactText,
} from './build-ocr-machine-verification.mjs';
import {
  sha256Text,
  validatePagePublicationManifest,
} from './page-publication-gate.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VERIFICATION_PATH = path.join(ROOT, 'data/ocr-machine-verification.json');
const QUEUE_PATH = path.join(ROOT, '.cache/ocr-review-queue-20260723.json');
const CATALOG_PATH = path.join(ROOT, 'data/catalog.json');
const SEMANTIC_POLICY_PATH = path.join(ROOT, 'data/semantic-publication-policy.json');
const MANIFEST_PATH = path.join(ROOT, 'data/page-publication-manifest.json');
const RECEIPT_PATH = path.join(ROOT, 'data/ocr-publication-receipt.json');
const PUBLIC_SUMMARY_PATH = path.join(ROOT, 'public/data/ocr-coverage-summary.json');
const TEXT_ROOT = path.join(ROOT, '.cache/text');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function assert(condition, message) {
  if (!condition) throw new Error(`OCR publication manifest: ${message}`);
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizeBlock(value) {
  return String(value || '')
    .replace(/\u0000/gu, '')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n+/gu, ' ')
    .replace(/\s+([，。；：！？、])/gu, '$1')
    .trim();
}

function useful(value) {
  if (value.length < 24 || value.length > 2200) return false;
  const meaningful = (value.match(/[\p{Script=Han}A-Za-z0-9]/gu) || []).length;
  return meaningful / value.length > 0.55 && !/^(目\s*录|contents?)$/iu.test(value);
}

async function readInputs() {
  const paths = [
    VERIFICATION_PATH,
    QUEUE_PATH,
    CATALOG_PATH,
    SEMANTIC_POLICY_PATH,
  ];
  const bytes = await Promise.all(paths.map((target) => readFile(target)));
  return {
    verificationRaw: bytes[0],
    queueRaw: bytes[1],
    catalogRaw: bytes[2],
    semanticPolicyRaw: bytes[3],
    verification: JSON.parse(bytes[0]),
    queue: JSON.parse(bytes[1]),
    catalog: JSON.parse(bytes[2]),
    semanticPolicy: JSON.parse(bytes[3]),
  };
}

function canonicalDocumentId(documentId, aliasById) {
  return aliasById.get(documentId)?.canonical_document_id || documentId;
}

async function buildPublication() {
  const inputs = await readInputs();
  const {
    verification,
    queue,
    catalog,
    semanticPolicy,
  } = inputs;
  assert(verification.artifact_profile === 'curriculum-ocr-machine-verification-v2',
    'machine verification v2 is required');
  assert(verification.release_gate.machine_adjudication_complete === true,
    'machine adjudication is incomplete');
  assert(verification.counts.machine_adjudication_pending_pages === 0,
    'machine adjudication still has pending pages');
  const queueByLocator = new Map(queue.queue.map((page) => [page.stable_locator, page]));
  const catalogById = new Map(catalog.documents.map((document) => [document.id, document]));
  const aliasById = new Map(semanticPolicy.document_aliases
    .map((alias) => [alias.alias_document_id, alias]));
  const groups = new Map();

  for (const receipt of verification.verified_pages) {
    const canonicalId = canonicalDocumentId(receipt.document_id, aliasById);
    const key = `${canonicalId}:page:${receipt.physical_pdf_page}`;
    const group = groups.get(key) || {
      canonical_document_id: canonicalId,
      physical_pdf_page: receipt.physical_pdf_page,
      receipts: [],
    };
    group.receipts.push(receipt);
    groups.set(key, group);
  }
  assert([...groups.values()].reduce((sum, group) => sum + group.receipts.length, 0)
    === verification.counts.machine_verified_exact_pages,
  'exact receipt grouping lost a source receipt');

  const materializedPages = [];
  for (const group of [...groups.values()].sort((left, right) =>
    left.canonical_document_id.localeCompare(right.canonical_document_id, 'en')
    || left.physical_pdf_page - right.physical_pdf_page)) {
    const canonicalLocator = `${group.canonical_document_id}:page:${group.physical_pdf_page}`;
    const representativeReceipt = group.receipts
      .find((receipt) => receipt.stable_locator === canonicalLocator)
      || group.receipts[0];
    const representativeQueuePage = queueByLocator.get(representativeReceipt.stable_locator);
    assert(representativeQueuePage, `${representativeReceipt.stable_locator} is absent from review queue`);
    const finalTextRaw = await readFile(representativeQueuePage.primary.paths[0]);
    assert(sha256(finalTextRaw) === representativeReceipt.primary_text_sha256,
      `${representativeReceipt.stable_locator} primary text hash drift`);
    assert(sha256(normalizeExactText(finalTextRaw.toString('utf8')))
      === representativeReceipt.normalized_primary_text_sha256,
    `${representativeReceipt.stable_locator} normalized text hash drift`);

    for (const receipt of group.receipts) {
      assert(receipt.status === 'machine_verified_exact'
        && receipt.publication_manifest_eligible === true,
      `${receipt.stable_locator} is not exact-publication eligible`);
      assert(receipt.source_pdf_sha256 === representativeReceipt.source_pdf_sha256,
        `${receipt.stable_locator} duplicate source hash drift`);
      assert(receipt.rendered_image_sha256 === representativeReceipt.rendered_image_sha256,
        `${receipt.stable_locator} duplicate rendered page hash drift`);
      assert(receipt.normalized_primary_text_sha256
        === representativeReceipt.normalized_primary_text_sha256,
      `${receipt.stable_locator} duplicate normalized text drift`);
      const queuePage = queueByLocator.get(receipt.stable_locator);
      assert(queuePage, `${receipt.stable_locator} is absent from review queue`);
      const witness = JSON.parse(await readFile(queuePage.witness.paths[0], 'utf8'));
      const imagePath = path.join(
        path.dirname(path.dirname(queuePage.witness.paths[0])),
        'images',
        witness.file,
      );
      const imageRaw = await readFile(imagePath);
      assert(sha256(imageRaw) === receipt.rendered_image_sha256,
        `${receipt.stable_locator} rendered page hash drift`);
    }

    const document = catalogById.get(group.canonical_document_id);
    assert(document, `${group.canonical_document_id} is absent from catalog`);
    assert(document.checksum_sha256 === representativeReceipt.source_pdf_sha256,
      `${group.canonical_document_id} catalog source hash drift`);
    assert(group.physical_pdf_page <= document.page_count,
      `${canonicalLocator} exceeds catalog page_count`);
    const sourceReceiptSha256s = group.receipts
      .map((receipt) => receipt.receipt_sha256)
      .sort((left, right) => left.localeCompare(right, 'en'));
    const finalTextSha256 = sha256Text(finalTextRaw.toString('utf8'));
    const evidenceBundleSha256 = sha256(JSON.stringify({
      source_receipt_sha256s: sourceReceiptSha256s,
      source_artifact_sha256: document.checksum_sha256,
      physical_pdf_page: group.physical_pdf_page,
      rendered_image_sha256: representativeReceipt.rendered_image_sha256,
      final_text_sha256: finalTextSha256,
    }));
    materializedPages.push({
      document,
      final_text: finalTextRaw.toString('utf8'),
      page: {
        page_number: group.physical_pdf_page,
        source_page_sha256: representativeReceipt.rendered_image_sha256,
        final_text_sha256: finalTextSha256,
        evidence_bundle_sha256: evidenceBundleSha256,
        source_receipt_sha256s: sourceReceiptSha256s,
        stable_locator: canonicalLocator,
        review_status: 'accepted',
        display_allowed: true,
        citation_allowed: true,
      },
      source_locators: group.receipts
        .map((receipt) => receipt.stable_locator)
        .sort((left, right) => left.localeCompare(right, 'en')),
      paragraph_candidates: finalTextRaw.toString('utf8')
        .split(/\n\s*\n/gu)
        .map(normalizeBlock)
        .filter(useful).length,
    });
  }

  const pagesByDocument = Map.groupBy(materializedPages, (item) => item.document.id);
  const manifest = validatePagePublicationManifest({
    schema_version: 1,
    policy: 'fail_closed_page_publication_v1',
    documents: [...pagesByDocument.entries()]
      .map(([documentId, pages]) => ({
        document_id: documentId,
        source_artifact_sha256: pages[0].document.checksum_sha256,
        acceptance_status: 'accepted_page_manifest',
        reviewed_by: verification.machine_reviewer,
        reviewed_at: verification.decided_at,
        pages: pages.map((item) => item.page)
          .sort((left, right) => left.page_number - right.page_number),
      }))
      .sort((left, right) => left.document_id.localeCompare(right.document_id, 'en')),
  });

  const manifestText = stableJson(manifest);
  const textAssets = [];
  for (const [documentId, pages] of pagesByDocument) {
    const document = pages[0].document;
    const rawPages = Array.from({ length: document.page_count }, () => '');
    for (const item of pages) rawPages[item.page.page_number - 1] = item.final_text;
    const raw = rawPages.join('\f');
    textAssets.push({
      document_id: documentId,
      page_count: rawPages.length,
      accepted_pages: pages.length,
      sha256: sha256Text(raw),
      bytes: Buffer.byteLength(raw, 'utf8'),
      content: raw,
    });
  }
  textAssets.sort((left, right) => left.document_id.localeCompare(right.document_id, 'en'));

  const receipt = {
    schema_version: 1,
    artifact_profile: 'curriculum-ocr-publication-receipt-v1',
    policy_id: verification.policy_id,
    decided_at: verification.decided_at,
    machine_reviewer: verification.machine_reviewer,
    assertion_boundary: 'Only exact dual-witness pages are materialized. One exact duplicate source receipt is folded into its canonical page without losing its receipt hash. Every other OCR page remains absent from the manifest and therefore fail closed.',
    source_bindings: {
      machine_verification_sha256: sha256(inputs.verificationRaw),
      review_queue_sha256: sha256(inputs.queueRaw),
      catalog_sha256: sha256(inputs.catalogRaw),
      semantic_publication_policy_sha256: sha256(inputs.semanticPolicyRaw),
      page_publication_manifest_sha256: sha256(manifestText),
    },
    counts: {
      source_exact_receipts: verification.counts.machine_verified_exact_pages,
      materialized_unique_pages: materializedPages.length,
      deduplicated_alias_receipts: verification.counts.machine_verified_exact_pages
        - materializedPages.length,
      manifest_documents: manifest.documents.length,
      display_allowed_pages: materializedPages.length,
      citation_allowed_pages: materializedPages.length,
      paragraph_candidates: materializedPages
        .reduce((sum, item) => sum + item.paragraph_candidates, 0),
      generated_text_assets: textAssets.length,
      unresolved_manifest_pages: 0,
    },
    release_gate: {
      source_receipts_exhaustive: true,
      sparse_manifest_fail_closed: true,
      exact_duplicate_materialized_once: true,
      production_citation_ready_pages: materializedPages.length,
      semantic_claim_allowed: false,
      deployment_allowed: true,
    },
    pages: materializedPages.map((item) => ({
      stable_locator: item.page.stable_locator,
      source_receipt_locators: item.source_locators,
      source_receipt_sha256s: item.page.source_receipt_sha256s,
      source_artifact_sha256: item.document.checksum_sha256,
      source_page_sha256: item.page.source_page_sha256,
      final_text_sha256: item.page.final_text_sha256,
      evidence_bundle_sha256: item.page.evidence_bundle_sha256,
      paragraph_candidates: item.paragraph_candidates,
    })),
    text_assets: textAssets.map(({ content, ...asset }) => asset),
  };
  return {
    manifest,
    manifestText,
    receipt,
    receiptText: stableJson(receipt),
    textAssets,
  };
}

async function updatePublicSummary(receipt) {
  const summary = JSON.parse(await readFile(PUBLIC_SUMMARY_PATH, 'utf8'));
  summary.coverage.citation_ready_pages = receipt.counts.citation_allowed_pages;
  summary.machine_verification.production_citation_ready_pages
    = receipt.counts.citation_allowed_pages;
  summary.publication = {
    artifact_profile: receipt.artifact_profile,
    source_exact_receipts: receipt.counts.source_exact_receipts,
    materialized_unique_pages: receipt.counts.materialized_unique_pages,
    deduplicated_alias_receipts: receipt.counts.deduplicated_alias_receipts,
    manifest_documents: receipt.counts.manifest_documents,
    citation_allowed_pages: receipt.counts.citation_allowed_pages,
    paragraph_candidates: receipt.counts.paragraph_candidates,
  };
  summary.release_gate.citation_allowed = receipt.counts.citation_allowed_pages > 0;
  await writeFile(PUBLIC_SUMMARY_PATH, stableJson(summary));
}

export async function buildOcrPublication({ check = false } = {}) {
  const output = await buildPublication();
  if (check) {
    const [manifestRaw, receiptRaw] = await Promise.all([
      readFile(MANIFEST_PATH, 'utf8'),
      readFile(RECEIPT_PATH, 'utf8'),
    ]);
    assert(manifestRaw === output.manifestText, 'checked-in page publication manifest is stale');
    assert(receiptRaw === output.receiptText, 'checked-in OCR publication receipt is stale');
    for (const asset of output.textAssets) {
      const raw = await readFile(path.join(TEXT_ROOT, `${asset.document_id}.txt`));
      assert(sha256Text(raw.toString('utf8')) === asset.sha256,
        `${asset.document_id} generated text asset is stale`);
    }
    return output.receipt;
  }

  await mkdir(TEXT_ROOT, { recursive: true });
  await Promise.all([
    writeFile(MANIFEST_PATH, output.manifestText),
    writeFile(RECEIPT_PATH, output.receiptText),
    ...output.textAssets.map((asset) =>
      writeFile(path.join(TEXT_ROOT, `${asset.document_id}.txt`), asset.content)),
  ]);
  await updatePublicSummary(output.receipt);
  return output.receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const check = process.argv.includes('--check');
  const receipt = await buildOcrPublication({ check });
  process.stdout.write(`${JSON.stringify(receipt.counts)}\n`);
}
