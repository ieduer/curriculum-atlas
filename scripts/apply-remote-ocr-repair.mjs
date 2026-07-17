#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const expectedManifestType = 'curriculum_remote_ocr_page_repair';
const expectedReceiptType = 'curriculum_remote_ocr_page_repair_receipt';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(pathname) {
  const contents = await readFile(pathname);
  return sha256(contents);
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function requireIdentifier(value, label) {
  if (typeof value !== 'string' || !identifierPattern.test(value) || value.includes('..')) {
    throw new Error(`${label} must be a safe identifier`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !sha256Pattern.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requireFalse(value, label) {
  if (value !== false) throw new Error(`${label} must equal false`);
  return value;
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sortedUniqueIntegers(value, pageCount, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const numbers = value.map((item) => {
    if (!Number.isSafeInteger(item) || item < 1 || item > pageCount) {
      throw new Error(`${label} contains an invalid page number`);
    }
    return item;
  });
  const sorted = [...new Set(numbers)].sort((left, right) => left - right);
  if (sorted.length !== numbers.length || JSON.stringify(numbers) !== JSON.stringify(sorted)) {
    throw new Error(`${label} must contain unique ascending page numbers`);
  }
  return sorted;
}

function expectedPages(pageCount) {
  return Array.from({ length: pageCount }, (_, index) => index + 1);
}

function safeRelativeEvidencePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const normalized = path.normalize(value);
  if (normalized === '.' || normalized.startsWith(`..${path.sep}`) || normalized === '..') {
    throw new Error(`${label} escapes the manifest directory`);
  }
  return normalized;
}

export function validateRepairManifest(value) {
  const manifest = requireObject(value, 'repair manifest');
  if (manifest.schema_version !== 1) throw new Error('repair manifest schema_version must equal 1');
  if (manifest.manifest_type !== expectedManifestType) {
    throw new Error(`repair manifest manifest_type must equal ${expectedManifestType}`);
  }
  requireIdentifier(manifest.repair_id, 'repair manifest repair_id');
  if (typeof manifest.method !== 'string' || manifest.method.trim().length === 0 || manifest.method.length > 128) {
    throw new Error('repair manifest method must be a non-empty string no longer than 128 characters');
  }
  requireFalse(manifest.citation_allowed, 'repair manifest citation_allowed');
  if (!Array.isArray(manifest.documents) || manifest.documents.length === 0) {
    throw new Error('repair manifest documents must be a non-empty array');
  }

  const documentIds = new Set();
  const pageIdentities = new Set();
  for (const [documentIndex, documentValue] of manifest.documents.entries()) {
    const document = requireObject(documentValue, `repair manifest documents[${documentIndex}]`);
    const documentId = requireIdentifier(document.document_id, `repair manifest documents[${documentIndex}].document_id`);
    if (documentIds.has(documentId)) throw new Error(`repair manifest contains duplicate document ${documentId}`);
    documentIds.add(documentId);
    requireSha256(document.source_sha256, `${documentId}.source_sha256`);
    const pageCount = requirePositiveInteger(document.page_count, `${documentId}.page_count`);
    requireFalse(document.citation_allowed, `${documentId}.citation_allowed`);
    if (!Array.isArray(document.pages) || document.pages.length === 0) {
      throw new Error(`${documentId}.pages must be a non-empty array`);
    }

    for (const [pageIndex, pageValue] of document.pages.entries()) {
      const page = requireObject(pageValue, `${documentId}.pages[${pageIndex}]`);
      const pageNumber = requirePositiveInteger(page.physical_pdf_page, `${documentId}.pages[${pageIndex}].physical_pdf_page`);
      if (pageNumber > pageCount) throw new Error(`${documentId} page ${pageNumber} exceeds page_count`);
      const identity = `${documentId}:${pageNumber}`;
      if (pageIdentities.has(identity)) throw new Error(`repair manifest contains duplicate page ${identity}`);
      pageIdentities.add(identity);
      requireFalse(page.citation_eligible, `${documentId} page ${pageNumber} citation_eligible`);
      requireSha256(page.rendered_image_sha256, `${documentId} page ${pageNumber} rendered_image_sha256`);
      if (typeof page.final_text !== 'string' || page.final_text.trim().length === 0 || page.final_text.includes('\0')) {
        throw new Error(`${documentId} page ${pageNumber} final_text must be non-empty text without NUL bytes`);
      }
      requireSha256(page.final_text_sha256, `${documentId} page ${pageNumber} final_text_sha256`);
      if (sha256(page.final_text) !== page.final_text_sha256) {
        throw new Error(`${documentId} page ${pageNumber} final_text_sha256 mismatch`);
      }
      if (!Array.isArray(page.evidence) || page.evidence.length === 0) {
        throw new Error(`${documentId} page ${pageNumber} evidence must be a non-empty array`);
      }
      const evidencePaths = new Set();
      let renderedImageBound = false;
      for (const [evidenceIndex, evidenceValue] of page.evidence.entries()) {
        const evidence = requireObject(evidenceValue, `${documentId} page ${pageNumber} evidence[${evidenceIndex}]`);
        if (typeof evidence.kind !== 'string' || evidence.kind.trim().length === 0 || evidence.kind.length > 64) {
          throw new Error(`${documentId} page ${pageNumber} evidence[${evidenceIndex}].kind must be a non-empty string`);
        }
        const evidencePath = safeRelativeEvidencePath(
          evidence.path,
          `${documentId} page ${pageNumber} evidence[${evidenceIndex}].path`,
        );
        if (evidencePaths.has(evidencePath)) throw new Error(`${documentId} page ${pageNumber} has duplicate evidence path ${evidencePath}`);
        evidencePaths.add(evidencePath);
        requireSha256(evidence.sha256, `${documentId} page ${pageNumber} evidence[${evidenceIndex}].sha256`);
        if (evidence.kind === 'rendered_page_image' && evidence.sha256 === page.rendered_image_sha256) {
          renderedImageBound = true;
        }
      }
      if (!renderedImageBound) {
        throw new Error(`${documentId} page ${pageNumber} evidence must bind rendered_image_sha256 with kind rendered_page_image`);
      }
    }
  }
  return manifest;
}

async function readJson(pathname, label) {
  let raw;
  try {
    raw = await readFile(pathname, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing`);
    throw error;
  }
  try {
    return { raw, value: JSON.parse(raw) };
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function requireRegularFile(pathname, label) {
  let info;
  try {
    info = await lstat(pathname);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing`);
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return info;
}

async function pathKind(pathname) {
  try {
    const info = await lstat(pathname);
    if (info.isDirectory()) return 'directory';
    if (info.isFile()) return 'file';
    if (info.isSymbolicLink()) return 'symlink';
    return 'other';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function verifySha256Sidecar(pathname, label) {
  const sidecarPath = `${pathname}.sha256`;
  await requireRegularFile(sidecarPath, `${label} SHA-256 sidecar`);
  const sidecar = await readFile(sidecarPath, 'utf8');
  const match = /^([a-f0-9]{64})  ([^\r\n]+)\n$/u.exec(sidecar);
  if (!match || match[2] !== path.basename(pathname)) {
    throw new Error(`${label} SHA-256 sidecar has an invalid format`);
  }
  const actual = await sha256File(pathname);
  if (match[1] !== actual) throw new Error(`${label} SHA-256 sidecar mismatch`);
  return actual;
}

function validateState(stateValue, document) {
  const state = requireObject(stateValue, `${document.document_id} OCR state`);
  if (state.schema_version !== 1) throw new Error(`${document.document_id}: OCR state schema_version must equal 1`);
  if (state.document_id !== document.document_id) throw new Error(`${document.document_id}: OCR state document id mismatch`);
  if (state.source_sha256 !== document.source_sha256) throw new Error(`${document.document_id}: OCR state source SHA-256 mismatch`);
  if (state.page_count !== document.page_count) throw new Error(`${document.document_id}: OCR state page count mismatch`);
  requireObject(state.configuration, `${document.document_id}.configuration`);
  const completedPages = sortedUniqueIntegers(state.completed_pages, document.page_count, `${document.document_id}.completed_pages`);
  const selectedPages = sortedUniqueIntegers(state.selected_pages, document.page_count, `${document.document_id}.selected_pages`);
  if (JSON.stringify(selectedPages) !== JSON.stringify(expectedPages(document.page_count))) {
    throw new Error(`${document.document_id}: repair requires a whole-document selected page set`);
  }
  const failedPages = requireObject(state.failed_pages, `${document.document_id}.failed_pages`);
  const pages = requireObject(state.pages, `${document.document_id}.pages`);
  const pageKeys = Object.keys(pages).sort((left, right) => Number(left) - Number(right));
  if (JSON.stringify(pageKeys) !== JSON.stringify(completedPages.map(String))) {
    throw new Error(`${document.document_id}: OCR page metadata set differs from completed_pages`);
  }
  for (const pageNumber of completedPages) {
    const page = requireObject(pages[String(pageNumber)], `${document.document_id} page ${pageNumber} metadata`);
    requireFalse(page.citation_eligible, `${document.document_id} page ${pageNumber} citation_eligible`);
  }
  return { state, completedPages, selectedPages, failedPages, pages };
}

function baseFailureValid(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.error !== 'string') return false;
  return /PEG-native/iu.test(value.error) && /(?:^|\D)500(?:\D|$)/u.test(value.error);
}

function repairProvenance(manifest, manifestSha256, baseFailure) {
  return {
    schema_version: 1,
    repair_manifest_sha256: manifestSha256,
    repair_id: manifest.repair_id,
    method: manifest.method,
    base_failure: baseFailure,
    citation_eligible: false,
  };
}

function pageArtifacts(manifest, manifestSha256, document, page, baseFailure) {
  const provenance = repairProvenance(manifest, manifestSha256, baseFailure);
  const result = {
    schema_version: 1,
    result_type: 'curriculum_remote_ocr_page_repair',
    document_id: document.document_id,
    physical_pdf_page: page.physical_pdf_page,
    text: page.final_text,
    final_text_sha256: page.final_text_sha256,
    citation_eligible: false,
    repair_provenance: provenance,
  };
  const resultText = jsonText(result);
  return {
    provenance,
    resultText,
    markdownText: page.final_text,
    resultJsonSha256: sha256(resultText),
    contentMarkdownSha256: sha256(page.final_text),
  };
}

async function verifyEvidence(manifestDirectory, document, page) {
  for (const evidence of page.evidence) {
    const pathname = path.resolve(manifestDirectory, path.normalize(evidence.path));
    if (!isWithin(manifestDirectory, pathname)) {
      throw new Error(`${document.document_id} page ${page.physical_pdf_page} evidence escapes the manifest directory`);
    }
    await requireRegularFile(pathname, `${document.document_id} page ${page.physical_pdf_page} evidence ${evidence.path}`);
    const resolved = await realpath(pathname);
    if (!isWithin(manifestDirectory, resolved) || resolved !== pathname) {
      throw new Error(`${document.document_id} page ${page.physical_pdf_page} evidence must not traverse a symlink`);
    }
    if (await sha256File(pathname) !== evidence.sha256) {
      throw new Error(`${document.document_id} page ${page.physical_pdf_page} evidence hash mismatch for ${evidence.path}`);
    }
  }
}

async function verifyAppliedPage({ documentRoot, manifest, manifestSha256, document, page, statePage }) {
  const pageNumber = page.physical_pdf_page;
  const pageRoot = path.join(documentRoot, 'pages', String(pageNumber).padStart(4, '0'));
  if (await pathKind(pageRoot) !== 'directory') throw new Error(`${document.document_id} page ${pageNumber} repaired page directory is missing`);
  const expectedProvenance = statePage?.repair_provenance;
  if (!expectedProvenance || JSON.stringify(expectedProvenance) !== JSON.stringify(
    repairProvenance(manifest, manifestSha256, expectedProvenance.base_failure),
  )) {
    throw new Error(`${document.document_id} page ${pageNumber} repair provenance conflicts with the manifest`);
  }
  if (!baseFailureValid(expectedProvenance.base_failure)) {
    throw new Error(`${document.document_id} page ${pageNumber} repaired base failure is not PEG-native 500`);
  }
  const artifacts = pageArtifacts(manifest, manifestSha256, document, page, expectedProvenance.base_failure);
  const resultPath = path.join(pageRoot, 'result.json');
  const contentPath = path.join(pageRoot, 'content.md');
  const markdownPath = path.join(pageRoot, 'markdown', `page-${String(pageNumber).padStart(4, '0')}.md`);
  for (const [pathname, label] of [[resultPath, 'result.json'], [contentPath, 'content.md'], [markdownPath, 'page Markdown']]) {
    await requireRegularFile(pathname, `${document.document_id} page ${pageNumber} ${label}`);
  }
  const [resultText, contentText, markdownText] = await Promise.all([
    readFile(resultPath, 'utf8'),
    readFile(contentPath, 'utf8'),
    readFile(markdownPath, 'utf8'),
  ]);
  if (resultText !== artifacts.resultText || contentText !== page.final_text || markdownText !== page.final_text) {
    throw new Error(`${document.document_id} page ${pageNumber} repaired artifacts conflict with the manifest`);
  }
  if (
    statePage.status !== 'ocr_complete_pending_audit'
    || statePage.physical_pdf_page !== pageNumber
    || statePage.rendered_image_sha256 !== page.rendered_image_sha256
    || statePage.result_json_sha256 !== artifacts.resultJsonSha256
    || statePage.content_markdown_sha256 !== artifacts.contentMarkdownSha256
    || statePage.citation_eligible !== false
  ) {
    throw new Error(`${document.document_id} page ${pageNumber} repaired state metadata conflicts with the manifest`);
  }
  return artifacts;
}

function verifyReceiptAgainstPlan(receipt, manifest, manifestSha256, documents) {
  if (
    receipt.schema_version !== 1
    || receipt.receipt_type !== expectedReceiptType
    || receipt.repair_id !== manifest.repair_id
    || receipt.repair_manifest_sha256 !== manifestSha256
    || receipt.method !== manifest.method
    || receipt.citation_allowed !== false
    || receipt.status !== 'applied'
    || typeof receipt.applied_at !== 'string'
    || !Number.isFinite(Date.parse(receipt.applied_at))
    || !Array.isArray(receipt.documents)
    || receipt.documents.length !== documents.length
  ) {
    throw new Error('repair receipt identity conflicts with the manifest');
  }
  const receiptDocumentIds = receipt.documents.map((entry) => entry?.document_id);
  if (new Set(receiptDocumentIds).size !== receiptDocumentIds.length) {
    throw new Error('repair receipt contains duplicate document records');
  }
  for (const documentPlan of documents) {
    const receiptDocument = receipt.documents.find((entry) => entry.document_id === documentPlan.document.document_id);
    if (
      !receiptDocument
      || receiptDocument.source_sha256 !== documentPlan.document.source_sha256
      || receiptDocument.page_count !== documentPlan.document.page_count
      || !sha256Pattern.test(String(receiptDocument.state_before_sha256 || ''))
      || receiptDocument.state_after_sha256 !== documentPlan.stateBeforeSha256
      || !Array.isArray(receiptDocument.pages)
      || receiptDocument.pages.length !== documentPlan.pages.length
    ) {
      throw new Error(`${documentPlan.document.document_id}: repair receipt state or document identity mismatch`);
    }
    const receiptPageNumbers = receiptDocument.pages.map((entry) => entry?.physical_pdf_page);
    if (new Set(receiptPageNumbers).size !== receiptPageNumbers.length) {
      throw new Error(`${documentPlan.document.document_id}: repair receipt contains duplicate pages`);
    }
    for (const pagePlan of documentPlan.pages) {
      const page = pagePlan.page;
      const receiptPage = receiptDocument.pages.find((entry) => entry.physical_pdf_page === page.physical_pdf_page);
      if (
        !receiptPage
        || receiptPage.rendered_image_sha256 !== page.rendered_image_sha256
        || receiptPage.final_text_sha256 !== page.final_text_sha256
        || receiptPage.result_json_sha256 !== pagePlan.artifacts.resultJsonSha256
        || receiptPage.content_markdown_sha256 !== pagePlan.artifacts.contentMarkdownSha256
        || receiptPage.citation_eligible !== false
      ) {
        throw new Error(`${documentPlan.document.document_id} page ${page.physical_pdf_page}: repair receipt artifact checksum mismatch`);
      }
    }
  }
}

async function preflight({ manifestPath, outputRoot }) {
  await requireRegularFile(manifestPath, 'repair manifest');
  const manifestResolved = await realpath(manifestPath);
  const manifestRaw = await readFile(manifestResolved);
  const manifestSha256 = await verifySha256Sidecar(manifestPath, 'repair manifest');
  let manifestValue;
  try {
    manifestValue = JSON.parse(manifestRaw.toString('utf8'));
  } catch (error) {
    throw new Error(`repair manifest is not valid JSON: ${error.message}`);
  }
  const manifest = validateRepairManifest(manifestValue);
  const outputRootKind = await pathKind(outputRoot);
  if (outputRootKind !== 'directory') throw new Error('--output-root must be an existing directory');
  const outputRootResolved = await realpath(outputRoot);
  outputRoot = outputRootResolved;
  const manifestDirectory = path.dirname(manifestResolved);

  const receiptPath = path.join(outputRoot, 'repair-receipts', `${manifest.repair_id}.json`);
  const receiptDirectory = path.dirname(receiptPath);
  const receiptDirectoryKind = await pathKind(receiptDirectory);
  if (!['missing', 'directory'].includes(receiptDirectoryKind)) {
    throw new Error(`repair receipt directory path is occupied by a ${receiptDirectoryKind}`);
  }
  if (receiptDirectoryKind === 'directory') {
    const receiptDirectoryResolved = await realpath(receiptDirectory);
    if (receiptDirectoryResolved !== receiptDirectory || !isWithin(outputRoot, receiptDirectoryResolved)) {
      throw new Error('repair receipt directory must not traverse a symlink');
    }
  }
  const receiptKind = await pathKind(receiptPath);
  if (!['missing', 'file'].includes(receiptKind)) throw new Error(`repair receipt path is occupied by a ${receiptKind}`);
  if (receiptKind === 'file') {
    await requireRegularFile(receiptPath, 'repair receipt');
    await verifySha256Sidecar(receiptPath, 'repair receipt');
  } else if (await pathKind(`${receiptPath}.sha256`) !== 'missing') {
    throw new Error('repair receipt sidecar exists without its receipt');
  }

  const documents = [];
  let pendingPages = 0;
  let appliedPages = 0;
  for (const document of manifest.documents) {
    const documentRoot = path.join(outputRoot, 'documents', document.document_id);
    if (!isWithin(outputRoot, documentRoot) || await pathKind(documentRoot) !== 'directory') {
      throw new Error(`${document.document_id}: OCR document root is missing`);
    }
    const documentRootResolved = await realpath(documentRoot);
    if (documentRootResolved !== documentRoot || !isWithin(outputRoot, documentRootResolved)) {
      throw new Error(`${document.document_id}: OCR document root must not traverse a symlink`);
    }
    const pagesRoot = path.join(documentRoot, 'pages');
    const pagesRootKind = await pathKind(pagesRoot);
    if (pagesRootKind === 'symlink') {
      throw new Error(`${document.document_id}: OCR pages root must not traverse a symlink`);
    }
    if (pagesRootKind !== 'directory') {
      throw new Error(`${document.document_id}: OCR pages root is missing`);
    }
    const pagesRootResolved = await realpath(pagesRoot);
    if (pagesRootResolved !== pagesRoot || !isWithin(documentRoot, pagesRootResolved)) {
      throw new Error(`${document.document_id}: OCR pages root must not traverse a symlink`);
    }
    const statePath = path.join(documentRoot, 'state.json');
    await requireRegularFile(statePath, `${document.document_id} OCR state`);
    const { raw: stateRaw, value: stateValue } = await readJson(statePath, `${document.document_id} OCR state`);
    const validated = validateState(stateValue, document);
    const manifestPageNumbers = document.pages.map((page) => page.physical_pdf_page).sort((left, right) => left - right);
    const failedPageNumbers = Object.keys(validated.failedPages).map(Number).sort((left, right) => left - right);
    const documentPages = [];

    for (const page of document.pages) {
      await verifyEvidence(manifestDirectory, document, page);
      const pageNumber = page.physical_pdf_page;
      const pageKey = String(pageNumber);
      const pageRoot = path.join(documentRoot, 'pages', String(pageNumber).padStart(4, '0'));
      const pageRootKind = await pathKind(pageRoot);
      const completed = validated.completedPages.includes(pageNumber);
      const failure = validated.failedPages[pageKey];
      const statePage = validated.pages[pageKey];

      if (!completed && failure && baseFailureValid(failure) && !statePage && pageRootKind === 'missing') {
        const artifacts = pageArtifacts(manifest, manifestSha256, document, page, failure);
        documentPages.push({ status: 'pending', page, failure, artifacts, pageRoot });
        pendingPages += 1;
        continue;
      }
      if (completed && !failure && statePage && pageRootKind === 'directory') {
        const artifacts = await verifyAppliedPage({ documentRoot, manifest, manifestSha256, document, page, statePage });
        documentPages.push({ status: 'applied', page, failure: statePage.repair_provenance.base_failure, artifacts, pageRoot });
        appliedPages += 1;
        continue;
      }
      throw new Error(`${document.document_id} page ${pageNumber} is neither an untouched PEG-native 500 failure nor an identical applied repair`);
    }

    const statuses = new Set(documentPages.map((page) => page.status));
    if (statuses.size !== 1) throw new Error(`${document.document_id}: mixed pending and applied repair pages are not allowed`);
    if (statuses.has('pending') && JSON.stringify(failedPageNumbers) !== JSON.stringify(manifestPageNumbers)) {
      throw new Error(`${document.document_id}: manifest must cover every failed page before selected_pages_complete can be set`);
    }
    if (statuses.has('pending') && validated.state.selected_pages_complete !== false) {
      throw new Error(`${document.document_id}: failed pages coexist with selected_pages_complete=true`);
    }
    if (statuses.has('pending')) {
      const prospectiveCompleted = [...new Set([...validated.completedPages, ...manifestPageNumbers])]
        .sort((left, right) => left - right);
      if (JSON.stringify(prospectiveCompleted) !== JSON.stringify(validated.selectedPages)) {
        throw new Error(`${document.document_id}: repair would leave selected pages incomplete`);
      }
    }
    if (statuses.has('applied') && Object.keys(validated.failedPages).length !== 0) {
      throw new Error(`${document.document_id}: applied repair coexists with unresolved failed pages`);
    }
    if (
      statuses.has('applied')
      && (
        validated.state.selected_pages_complete !== true
        || JSON.stringify(validated.completedPages) !== JSON.stringify(validated.selectedPages)
      )
    ) {
      throw new Error(`${document.document_id}: applied repair does not complete the selected page set`);
    }
    documents.push({
      document,
      documentRoot,
      statePath,
      stateRaw,
      stateBeforeSha256: sha256(stateRaw),
      validated,
      pages: documentPages,
    });
  }

  if (pendingPages > 0 && appliedPages > 0) throw new Error('repair manifest is partially applied; refusing a mixed transaction');
  const mode = pendingPages > 0 ? 'pending' : 'applied';
  let receipt = null;
  if (receiptKind === 'file') {
    const receiptRead = await readJson(receiptPath, 'repair receipt');
    receipt = requireObject(receiptRead.value, 'repair receipt');
    if (mode !== 'applied') throw new Error('repair receipt exists but the repair is not fully applied');
    verifyReceiptAgainstPlan(receipt, manifest, manifestSha256, documents);
  } else if (mode === 'applied') {
    throw new Error('repair is already present without a valid receipt; refusing to infer transaction completion');
  }

  return {
    manifest,
    manifestSha256,
    manifestPath: manifestResolved,
    outputRoot,
    receiptPath,
    receipt,
    mode,
    documents,
  };
}

function buildUpdatedState(documentPlan, timestamp) {
  const state = structuredClone(documentPlan.validated.state);
  for (const pagePlan of documentPlan.pages) {
    const page = pagePlan.page;
    const pageNumber = page.physical_pdf_page;
    const pageKey = String(pageNumber);
    state.pages[pageKey] = {
      status: 'ocr_complete_pending_audit',
      physical_pdf_page: pageNumber,
      rendered_image_sha256: page.rendered_image_sha256,
      result_json_sha256: pagePlan.artifacts.resultJsonSha256,
      content_markdown_sha256: pagePlan.artifacts.contentMarkdownSha256,
      citation_eligible: false,
      repair_provenance: pagePlan.artifacts.provenance,
    };
    state.completed_pages = [...new Set([...state.completed_pages, pageNumber])].sort((left, right) => left - right);
    delete state.failed_pages[pageKey];
  }
  state.pages = Object.fromEntries(Object.entries(state.pages).sort((left, right) => Number(left[0]) - Number(right[0])));
  state.selected_pages_complete = (
    JSON.stringify(state.completed_pages) === JSON.stringify(state.selected_pages)
    && Object.keys(state.failed_pages).length === 0
  );
  if (!state.selected_pages_complete) {
    throw new Error(`${documentPlan.document.document_id}: repair would not complete the selected page set`);
  }
  state.updated_at = timestamp;
  state.finished_selected_pages_at = timestamp;
  return state;
}

function receiptFor(plan, timestamp, stateUpdates, status = 'applied') {
  return {
    schema_version: 1,
    receipt_type: expectedReceiptType,
    repair_id: plan.manifest.repair_id,
    repair_manifest_sha256: plan.manifestSha256,
    method: plan.manifest.method,
    citation_allowed: false,
    status,
    applied_at: timestamp,
    documents: plan.documents.map((documentPlan) => {
      const stateUpdate = stateUpdates.get(documentPlan.document.document_id);
      return {
        document_id: documentPlan.document.document_id,
        source_sha256: documentPlan.document.source_sha256,
        page_count: documentPlan.document.page_count,
        state_before_sha256: documentPlan.stateBeforeSha256,
        state_after_sha256: stateUpdate.stateAfterSha256,
        pages: documentPlan.pages.map((pagePlan) => ({
          physical_pdf_page: pagePlan.page.physical_pdf_page,
          rendered_image_sha256: pagePlan.page.rendered_image_sha256,
          final_text_sha256: pagePlan.page.final_text_sha256,
          result_json_sha256: pagePlan.artifacts.resultJsonSha256,
          content_markdown_sha256: pagePlan.artifacts.contentMarkdownSha256,
          citation_eligible: false,
        })),
      };
    }),
  };
}

async function atomicWrite(pathname, contents, mode = 0o600) {
  const temporary = path.join(path.dirname(pathname), `.${path.basename(pathname)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, pathname);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function acquireLock(outputRoot) {
  const lockPath = path.join(outputRoot, '.remote-ocr-repair.lock');
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('another remote OCR repair transaction owns the output root');
    throw error;
  }
  await handle.writeFile(`${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`);
  await handle.sync();
  await handle.close();
  return async () => rm(lockPath, { force: true });
}

async function stageTransaction(plan, timestamp) {
  const stagingRoot = path.join(plan.outputRoot, `.remote-ocr-repair-staging-${plan.manifest.repair_id}-${randomUUID()}`);
  await mkdir(stagingRoot, { recursive: false, mode: 0o700 });
  const stateUpdates = new Map();
  try {
    for (const documentPlan of plan.documents) {
      const stagedDocumentRoot = path.join(stagingRoot, 'documents', documentPlan.document.document_id);
      for (const pagePlan of documentPlan.pages) {
        const pageNumber = pagePlan.page.physical_pdf_page;
        const stagedPageRoot = path.join(stagedDocumentRoot, 'pages', String(pageNumber).padStart(4, '0'));
        await mkdir(path.join(stagedPageRoot, 'markdown'), { recursive: true, mode: 0o700 });
        await Promise.all([
          writeFile(path.join(stagedPageRoot, 'result.json'), pagePlan.artifacts.resultText, { mode: 0o600 }),
          writeFile(path.join(stagedPageRoot, 'content.md'), pagePlan.artifacts.markdownText, { mode: 0o600 }),
          writeFile(
            path.join(stagedPageRoot, 'markdown', `page-${String(pageNumber).padStart(4, '0')}.md`),
            pagePlan.artifacts.markdownText,
            { mode: 0o600 },
          ),
        ]);
        const [resultHash, contentHash] = await Promise.all([
          sha256File(path.join(stagedPageRoot, 'result.json')),
          sha256File(path.join(stagedPageRoot, 'content.md')),
        ]);
        if (resultHash !== pagePlan.artifacts.resultJsonSha256 || contentHash !== pagePlan.artifacts.contentMarkdownSha256) {
          throw new Error(`${documentPlan.document.document_id} page ${pageNumber}: staged artifact checksum mismatch`);
        }
      }
      const updatedState = buildUpdatedState(documentPlan, timestamp);
      const stateText = jsonText(updatedState);
      const stagedStatePath = path.join(stagedDocumentRoot, 'state.json');
      await mkdir(path.dirname(stagedStatePath), { recursive: true, mode: 0o700 });
      await writeFile(stagedStatePath, stateText, { mode: 0o600 });
      stateUpdates.set(documentPlan.document.document_id, {
        stateText,
        stateAfterSha256: sha256(stateText),
        stagedStatePath,
      });
    }
    const receipt = receiptFor(plan, timestamp, stateUpdates);
    const receiptText = jsonText(receipt);
    const stagedReceiptPath = path.join(stagingRoot, 'receipt.json');
    await writeFile(stagedReceiptPath, receiptText, { mode: 0o600 });
    return { stagingRoot, stateUpdates, receipt, receiptText, stagedReceiptPath };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

async function installTransaction(plan, staged) {
  const installedPages = [];
  const installedStates = [];
  let receiptInstalled = false;
  try {
    for (const documentPlan of plan.documents) {
      if (sha256(await readFile(documentPlan.statePath, 'utf8')) !== documentPlan.stateBeforeSha256) {
        throw new Error(`${documentPlan.document.document_id}: OCR state changed after preflight`);
      }
      for (const pagePlan of documentPlan.pages) {
        if (await pathKind(pagePlan.pageRoot) !== 'missing') {
          throw new Error(`${documentPlan.document.document_id} page ${pagePlan.page.physical_pdf_page}: target page directory appeared after preflight`);
        }
      }
    }

    for (const documentPlan of plan.documents) {
      for (const pagePlan of documentPlan.pages) {
        const pageNumber = pagePlan.page.physical_pdf_page;
        const stagedPageRoot = path.join(
          staged.stagingRoot,
          'documents',
          documentPlan.document.document_id,
          'pages',
          String(pageNumber).padStart(4, '0'),
        );
        await rename(stagedPageRoot, pagePlan.pageRoot);
        installedPages.push(pagePlan.pageRoot);
      }
    }

    for (const documentPlan of plan.documents) {
      if (sha256(await readFile(documentPlan.statePath, 'utf8')) !== documentPlan.stateBeforeSha256) {
        throw new Error(`${documentPlan.document.document_id}: OCR state changed during repair installation`);
      }
      const update = staged.stateUpdates.get(documentPlan.document.document_id);
      await rename(update.stagedStatePath, documentPlan.statePath);
      installedStates.push(documentPlan);
    }

    const receiptDirectory = path.dirname(plan.receiptPath);
    const receiptDirectoryKind = await pathKind(receiptDirectory);
    if (receiptDirectoryKind === 'missing') await mkdir(receiptDirectory, { mode: 0o700 });
    else if (receiptDirectoryKind !== 'directory') throw new Error('repair receipt directory path is occupied');
    if (await pathKind(plan.receiptPath) !== 'missing' || await pathKind(`${plan.receiptPath}.sha256`) !== 'missing') {
      throw new Error('repair receipt appeared during installation');
    }
    await rename(staged.stagedReceiptPath, plan.receiptPath);
    receiptInstalled = true;
    const receiptSha256 = await sha256File(plan.receiptPath);
    await atomicWrite(`${plan.receiptPath}.sha256`, `${receiptSha256}  ${path.basename(plan.receiptPath)}\n`);
    return { receiptSha256 };
  } catch (error) {
    const rollbackErrors = [];
    if (receiptInstalled) {
      try {
        await Promise.all([
          rm(plan.receiptPath, { force: true }),
          rm(`${plan.receiptPath}.sha256`, { force: true }),
        ]);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const documentPlan of installedStates.reverse()) {
      try {
        await atomicWrite(documentPlan.statePath, documentPlan.stateRaw);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const pageRoot of installedPages.reverse()) {
      try {
        await rm(pageRoot, { recursive: true, force: true });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], `remote OCR repair failed and rollback was incomplete: ${error.message}`);
    }
    throw error;
  } finally {
    await rm(staged.stagingRoot, { recursive: true, force: true });
  }
}

function planSummary(plan, { applied, receiptSha256 = null } = {}) {
  return {
    schema_version: 1,
    operation: 'remote_ocr_page_repair',
    mode: applied ? 'apply' : 'dry-run',
    status: plan.mode === 'applied' ? 'verified_idempotent' : applied ? 'applied' : 'ready',
    repair_id: plan.manifest.repair_id,
    repair_manifest_sha256: plan.manifestSha256,
    citation_allowed: false,
    receipt_path: plan.mode === 'applied' || applied ? plan.receiptPath : null,
    receipt_sha256: plan.receipt ? sha256(jsonText(plan.receipt)) : receiptSha256,
    documents: plan.documents.map((documentPlan) => ({
      document_id: documentPlan.document.document_id,
      source_sha256: documentPlan.document.source_sha256,
      page_count: documentPlan.document.page_count,
      pages: documentPlan.pages.map((pagePlan) => ({
        physical_pdf_page: pagePlan.page.physical_pdf_page,
        rendered_image_sha256: pagePlan.page.rendered_image_sha256,
        final_text_sha256: pagePlan.page.final_text_sha256,
        result_json_sha256: pagePlan.artifacts.resultJsonSha256,
        content_markdown_sha256: pagePlan.artifacts.contentMarkdownSha256,
        citation_eligible: false,
      })),
    })),
  };
}

export async function applyRemoteOcrRepair({ manifest: manifestOption, outputRoot: outputRootOption, apply = false, now } = {}) {
  if (typeof manifestOption !== 'string' || manifestOption.length === 0) throw new Error('--manifest is required');
  if (typeof outputRootOption !== 'string' || outputRootOption.length === 0) throw new Error('--output-root is required');
  const manifestPath = path.resolve(manifestOption);
  const outputRoot = path.resolve(outputRootOption);

  if (!apply) {
    const plan = await preflight({ manifestPath, outputRoot });
    return planSummary(plan, { applied: false });
  }

  const releaseLock = await acquireLock(outputRoot);
  try {
    const plan = await preflight({ manifestPath, outputRoot });
    if (plan.mode === 'applied') return planSummary(plan, { applied: true });
    const timestamp = typeof now === 'function' ? now() : new Date().toISOString();
    if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) {
      throw new Error('repair timestamp must be an ISO-compatible date string');
    }
    const staged = await stageTransaction(plan, timestamp);
    const installed = await installTransaction(plan, staged);
    const verified = await preflight({ manifestPath, outputRoot });
    if (verified.mode !== 'applied') throw new Error('post-apply verification did not observe a complete repair');
    return {
      ...planSummary(verified, { applied: true, receiptSha256: installed.receiptSha256 }),
      status: 'applied',
    };
  } finally {
    await releaseLock();
  }
}

function usage() {
  return `Usage: node scripts/apply-remote-ocr-repair.mjs --manifest <repair-manifest.json> --output-root <shard-root> [--apply]\n\nDefaults to dry-run. --apply is the only mode that writes to the output root.\n`;
}

function parseArguments(argv) {
  const options = { apply: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--manifest' || argument === '--output-root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      options[argument === '--manifest' ? 'manifest' : 'outputRoot'] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const result = await applyRemoteOcrRepair(options);
  process.stdout.write(jsonText(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`remote OCR repair refused: ${error.message}\n`);
    process.exitCode = 1;
  });
}
