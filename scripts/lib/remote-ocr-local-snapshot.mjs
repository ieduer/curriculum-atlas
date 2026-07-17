import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const sha256Pattern = /^[a-f0-9]{64}$/;

export const LOCAL_REPROCESS_SNAPSHOT_MODE = 'replace_existing_local_document';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(pathname) {
  return sha256(await readFile(pathname));
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireSha256(value, label) {
  if (!sha256Pattern.test(String(value || ''))) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function normalizedPageNumbers(values, pageCount, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const pages = values.map((value) => Number(value));
  if (pages.some((page) => !Number.isSafeInteger(page) || page < 1 || page > pageCount)) {
    throw new Error(`${label} contains an invalid physical page`);
  }
  pages.sort((left, right) => left - right);
  if (new Set(pages).size !== pages.length) throw new Error(`${label} contains duplicate pages`);
  return pages;
}

function normalizedPageObjectKeys(value, pageCount, label) {
  requireObject(value, label);
  return normalizedPageNumbers(Object.keys(value), pageCount, `${label} keys`);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function requireRegularNonSymlink(pathname, label) {
  const info = await lstat(pathname).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing`);
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  return info;
}

async function inspectTree(root) {
  const rootInfo = await lstat(root).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`local OCR document tree is missing: ${root}`);
    throw error;
  });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`local OCR document tree must be a real directory: ${root}`);
  }
  const entries = [];
  let files = 0;
  let bytes = 0;

  async function walk(directory, relativeDirectory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    if (relativeDirectory && children.length === 0) entries.push(`D\0${relativeDirectory}\n`);
    for (const child of children) {
      const pathname = path.join(directory, child.name);
      const relative = relativeDirectory ? path.join(relativeDirectory, child.name) : child.name;
      const info = await lstat(pathname);
      if (info.isSymbolicLink()) throw new Error(`local OCR document tree contains a symbolic link: ${pathname}`);
      if (info.isDirectory()) {
        entries.push(`D\0${relative}\n`);
        await walk(pathname, relative);
        continue;
      }
      if (!info.isFile()) throw new Error(`local OCR document tree contains a non-regular file: ${pathname}`);
      const digest = await sha256File(pathname);
      entries.push(`F\0${relative}\0${info.size}\0${digest}\n`);
      files += 1;
      bytes += info.size;
    }
  }

  await walk(root, '');
  return {
    tree_sha256: sha256(entries.join('')),
    files,
    bytes,
  };
}

function retryLedgerSnapshot(documentId, documentRetries, pageRetries) {
  requireObject(documentRetries, 'document retry ledger');
  requireObject(pageRetries, 'page retry ledger');
  const documentPresent = Object.hasOwn(documentRetries, documentId);
  const documentValue = documentPresent ? documentRetries[documentId] : null;
  const pageEntries = Object.keys(pageRetries)
    .filter((key) => key.startsWith(`${documentId}:`))
    .sort()
    .map((key) => ({ key, value: pageRetries[key] }));
  return {
    document: {
      present: documentPresent,
      entry_sha256: documentPresent ? sha256(canonicalJson(documentValue)) : null,
    },
    pages: {
      count: pageEntries.length,
      keys: pageEntries.map((entry) => entry.key),
      entries_sha256: sha256(canonicalJson(pageEntries)),
    },
  };
}

function snapshotDigest(snapshotWithoutDigest) {
  return sha256(canonicalJson(snapshotWithoutDigest));
}

export async function captureLocalReprocessSnapshot({
  document,
  documentRoot,
  textPath,
  documentRetries,
  pageRetries,
}) {
  requireObject(document, 'document');
  const statePath = path.join(documentRoot, 'state.json');
  const stateInfo = await requireRegularNonSymlink(statePath, `${document.id} local state`);
  const stateRawBefore = await readFile(statePath);
  let state;
  try {
    state = JSON.parse(stateRawBefore.toString('utf8'));
  } catch (error) {
    throw new Error(`${document.id}: local state is not valid JSON: ${error.message}`);
  }
  requireObject(state, `${document.id} local state`);
  if (state.schema_version !== 1
    || state.document_id !== document.id
    || state.source_sha256 !== document.source_sha256
    || state.page_count !== document.page_count) {
    throw new Error(`${document.id}: local state identity differs from the queue document`);
  }

  const completedPages = normalizedPageNumbers(
    state.completed_pages,
    document.page_count,
    `${document.id} completed_pages`,
  );
  if (completedPages.length === 0) {
    throw new Error(`${document.id}: explicit whole-document reprocess requires at least one completed local page`);
  }
  const failedPages = normalizedPageObjectKeys(
    state.failed_pages,
    document.page_count,
    `${document.id} failed_pages`,
  );
  if (failedPages.some((page) => completedPages.includes(page))) {
    throw new Error(`${document.id}: a page cannot be both completed and failed`);
  }
  const statePageNumbers = normalizedPageObjectKeys(
    state.pages,
    document.page_count,
    `${document.id} pages`,
  );
  if (!sameJson(statePageNumbers, completedPages)) {
    throw new Error(`${document.id}: local state pages do not exactly equal completed_pages`);
  }

  const pagesRoot = path.join(documentRoot, 'pages');
  const pagesInfo = await lstat(pagesRoot).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`${document.id}: local pages directory is missing`);
    throw error;
  });
  if (!pagesInfo.isDirectory() || pagesInfo.isSymbolicLink()) {
    throw new Error(`${document.id}: local pages path must be a real directory`);
  }
  const physicalPages = (await readdir(pagesRoot, { withFileTypes: true }))
    .map((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^\d{4}$/u.test(entry.name)) {
        throw new Error(`${document.id}: local pages directory contains an invalid entry: ${entry.name}`);
      }
      return Number(entry.name);
    })
    .sort((left, right) => left - right);
  if (!sameJson(physicalPages, completedPages)) {
    throw new Error(`${document.id}: physical local page directories do not exactly equal completed_pages`);
  }

  for (const page of completedPages) {
    const pageRoot = path.join(pagesRoot, String(page).padStart(4, '0'));
    const statePage = requireObject(state.pages[String(page)], `${document.id} page ${page} state`);
    if (statePage.physical_pdf_page !== page
      || statePage.citation_eligible !== false
      || !sha256Pattern.test(String(statePage.rendered_image_sha256 || ''))
      || !sha256Pattern.test(String(statePage.result_json_sha256 || ''))
      || !sha256Pattern.test(String(statePage.content_markdown_sha256 || ''))) {
      throw new Error(`${document.id}: local page ${page} state identity or citation gate is invalid`);
    }
    const resultPath = path.join(pageRoot, 'result.json');
    const contentPath = path.join(pageRoot, 'content.md');
    await Promise.all([
      requireRegularNonSymlink(resultPath, `${document.id} page ${page} result.json`),
      requireRegularNonSymlink(contentPath, `${document.id} page ${page} content.md`),
    ]);
    const [resultSha256, contentSha256] = await Promise.all([
      sha256File(resultPath),
      sha256File(contentPath),
    ]);
    if (resultSha256 !== statePage.result_json_sha256
      || contentSha256 !== statePage.content_markdown_sha256) {
      throw new Error(`${document.id}: local page ${page} artifact hashes differ from state.json`);
    }
  }

  const documentTree = await inspectTree(documentRoot);
  const stateRawAfter = await readFile(statePath);
  if (!stateRawBefore.equals(stateRawAfter)) {
    throw new Error(`${document.id}: local state changed while its planning snapshot was captured`);
  }

  let text = { exists: false, bytes: 0, sha256: null };
  const textInfo = await lstat(textPath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (textInfo) {
    if (!textInfo.isFile() || textInfo.isSymbolicLink()) {
      throw new Error(`${document.id} local joined text must be a regular non-symlink file`);
    }
    text = {
      exists: true,
      bytes: textInfo.size,
      sha256: await sha256File(textPath),
    };
  }

  const snapshot = {
    schema_version: 2,
    mode: LOCAL_REPROCESS_SNAPSHOT_MODE,
    state_file_present: true,
    state: {
      schema_version: state.schema_version,
      page_count: state.page_count,
      bytes: stateInfo.size,
      sha256: sha256(stateRawBefore),
    },
    completion: {
      completed_pages: completedPages,
      failed_pages: failedPages,
      state_page_numbers: statePageNumbers,
    },
    document_tree: documentTree,
    retry_ledger: retryLedgerSnapshot(document.id, documentRetries, pageRetries),
    text,
  };
  return {
    ...snapshot,
    snapshot_sha256: snapshotDigest(snapshot),
  };
}

export function validateLocalReprocessSnapshot(document, snapshot) {
  requireObject(snapshot, `${document.id}.planning_snapshot`);
  if (snapshot.schema_version !== 2 || snapshot.mode !== LOCAL_REPROCESS_SNAPSHOT_MODE) {
    throw new Error(`${document.id}: planning snapshot is not an explicit local-document replacement snapshot`);
  }
  if (snapshot.state_file_present !== true) {
    throw new Error(`${document.id}: replacement snapshot must bind an existing state file`);
  }
  const state = requireObject(snapshot.state, `${document.id}.planning_snapshot.state`);
  if (state.schema_version !== 1 || state.page_count !== document.page_count
    || !Number.isSafeInteger(state.bytes) || state.bytes < 1) {
    throw new Error(`${document.id}: replacement snapshot state identity is invalid`);
  }
  requireSha256(state.sha256, `${document.id}.planning_snapshot.state.sha256`);

  const completion = requireObject(snapshot.completion, `${document.id}.planning_snapshot.completion`);
  const completedPages = normalizedPageNumbers(
    completion.completed_pages,
    document.page_count,
    `${document.id}.planning_snapshot completed_pages`,
  );
  if (completedPages.length === 0 || !sameJson(completedPages, completion.completed_pages)) {
    throw new Error(`${document.id}: replacement snapshot completed_pages must be non-empty, unique, and sorted`);
  }
  for (const [key, values] of [
    ['failed_pages', completion.failed_pages],
    ['state_page_numbers', completion.state_page_numbers],
  ]) {
    const normalized = normalizedPageNumbers(
      values,
      document.page_count,
      `${document.id}.planning_snapshot ${key}`,
    );
    if (!sameJson(normalized, values)) {
      throw new Error(`${document.id}: replacement snapshot ${key} must be unique and sorted`);
    }
  }
  if (!sameJson(completion.state_page_numbers, completion.completed_pages)) {
    throw new Error(`${document.id}: replacement snapshot state pages must equal completed pages`);
  }
  if (completion.failed_pages.some((page) => completion.completed_pages.includes(page))) {
    throw new Error(`${document.id}: replacement snapshot overlaps completed and failed pages`);
  }

  const documentTree = requireObject(snapshot.document_tree, `${document.id}.planning_snapshot.document_tree`);
  requireSha256(documentTree.tree_sha256, `${document.id}.planning_snapshot.document_tree.tree_sha256`);
  if (!Number.isSafeInteger(documentTree.files) || documentTree.files < 3
    || !Number.isSafeInteger(documentTree.bytes) || documentTree.bytes < state.bytes) {
    throw new Error(`${document.id}: replacement snapshot document tree counts are invalid`);
  }

  const retryLedger = requireObject(snapshot.retry_ledger, `${document.id}.planning_snapshot.retry_ledger`);
  const documentRetry = requireObject(retryLedger.document, `${document.id}.planning_snapshot.retry_ledger.document`);
  if (typeof documentRetry.present !== 'boolean'
    || (documentRetry.present
      ? !sha256Pattern.test(String(documentRetry.entry_sha256 || ''))
      : documentRetry.entry_sha256 !== null)) {
    throw new Error(`${document.id}: replacement snapshot document retry identity is invalid`);
  }
  const pageRetries = requireObject(retryLedger.pages, `${document.id}.planning_snapshot.retry_ledger.pages`);
  if (!Number.isSafeInteger(pageRetries.count) || pageRetries.count < 0
    || !Array.isArray(pageRetries.keys)
    || pageRetries.keys.length !== pageRetries.count
    || new Set(pageRetries.keys).size !== pageRetries.keys.length
    || !sameJson([...pageRetries.keys].sort(), pageRetries.keys)
    || pageRetries.keys.some((key) => typeof key !== 'string' || !key.startsWith(`${document.id}:`))) {
    throw new Error(`${document.id}: replacement snapshot page retry keys are invalid`);
  }
  requireSha256(pageRetries.entries_sha256, `${document.id}.planning_snapshot.retry_ledger.pages.entries_sha256`);

  const text = requireObject(snapshot.text, `${document.id}.planning_snapshot.text`);
  if (typeof text.exists !== 'boolean'
    || !Number.isSafeInteger(text.bytes)
    || text.bytes < 0
    || (text.exists
      ? !sha256Pattern.test(String(text.sha256 || ''))
      : text.sha256 !== null || text.bytes !== 0)) {
    throw new Error(`${document.id}: replacement snapshot text identity is invalid`);
  }
  requireSha256(snapshot.snapshot_sha256, `${document.id}.planning_snapshot.snapshot_sha256`);
  const { snapshot_sha256: declaredDigest, ...withoutDigest } = snapshot;
  if (declaredDigest !== snapshotDigest(withoutDigest)) {
    throw new Error(`${document.id}: replacement snapshot SHA-256 is invalid`);
  }
  return snapshot;
}
