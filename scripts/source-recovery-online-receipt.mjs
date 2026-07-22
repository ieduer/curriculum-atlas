#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_RECEIPT_PATH = 'data/source-recovery-online-receipt.json';
const PROOF_PATH = 'data/source-recovery-proofs.json';
const SCHEMA_PATH = './source-recovery-online-receipt.schema.json';
const POLICY = 'official_publication_link_artifact_receipt_v1';
const CHECKER = 'scripts/source-recovery-online-receipt.mjs';
const MAX_AGE_SECONDS = 72 * 60 * 60;
const SHA256 = /^[0-9a-f]{64}$/;
const ALLOWED_OFFICIAL_HOSTS = new Set(['www.moe.gov.cn', 'www.ictr.edu.cn']);
const ICTR_WAF_PAGE_PREFIX = 'https://www.ictr.edu.cn/download_center/';
const ICTR_WAF_STATUSES = new Set([400, 403, 412]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value, required) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === required.length
    && required.every((key) => Object.hasOwn(value, key));
}

function normalizeMediaType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function safeProjectPath(root, relativePath) {
  const absolute = resolve(root, String(relativePath || ''));
  const relation = relative(root, absolute);
  if (relation === '..' || relation.startsWith('../') || relation.startsWith('..\\')) {
    throw new Error(`path escapes project root: ${relativePath}`);
  }
  return absolute;
}

function officialUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      && ALLOWED_OFFICIAL_HOSTS.has(url.hostname)
      && !url.hostname.endsWith('.invalid')
      && !url.hostname.startsWith('example.');
  } catch {
    return false;
  }
}

function equivalentOfficialUrl(left, right) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return officialUrl(a.href) && officialUrl(b.href)
      && a.hostname === b.hostname
      && decodeURIComponent(a.pathname) === decodeURIComponent(b.pathname)
      && a.search === b.search;
  } catch {
    return false;
  }
}

function decodeHtmlAttribute(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function htmlHrefs(html, baseUrl) {
  const hrefs = [];
  for (const match of String(html).matchAll(/\bhref\s*=\s*["']([^"']+)["']/giu)) {
    try {
      hrefs.push(new URL(decodeHtmlAttribute(match[1]), baseUrl).href);
    } catch {
      // Invalid, non-URL hrefs cannot prove an artifact link.
    }
  }
  return [...new Set(hrefs)].sort();
}

function expectedMediaTypes(path, declared = null) {
  const lower = String(path || '').toLowerCase();
  if (lower.endsWith('.pdf')) return ['application/pdf', 'application/octet-stream'];
  if (lower.endsWith('.rar')) {
    return ['application/octet-stream', 'application/vnd.rar', 'application/x-rar', 'application/x-rar-compressed'];
  }
  if (lower.endsWith('.docx')) {
    return [
      'application/octet-stream',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/zip',
    ];
  }
  if (lower.endsWith('.doc')) return ['application/msword', 'application/octet-stream'];
  return declared ? [normalizeMediaType(declared)] : [];
}

function hasExpectedMagic(bytes, path) {
  const lower = String(path || '').toLowerCase();
  if (lower.endsWith('.pdf')) return bytes.subarray(0, 5).equals(Buffer.from('%PDF-'));
  if (lower.endsWith('.rar')) return bytes.subarray(0, 7).equals(Buffer.from('526172211a0700', 'hex'));
  if (lower.endsWith('.docx')) return bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'));
  if (lower.endsWith('.doc')) return bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
  return false;
}

export function collectExpectedSourceRecoveryArtifacts(proofs) {
  const artifacts = [];
  for (const archive of proofs.official_archives || []) {
    artifacts.push({
      artifact_id: `archive:${archive.archive_id}`,
      document_id: null,
      role: 'official_archive',
      publication_page_url: archive.source_page_url,
      request_url: archive.source_url,
      local_path: archive.path,
      sha256: archive.sha256,
      bytes: archive.bytes,
      allowed_media_types: expectedMediaTypes(archive.path, archive.media_type),
    });
  }
  const scanContext = proofs.same_work_scan_variant_context || {};
  const canonicalScanIds = new Set(scanContext.canonical_document_ids || []);
  for (const tuple of proofs.official_same_work_scan_variants || []) {
    const [documentId, , filename, artifactSha256, bytes] = tuple;
    artifacts.push({
      artifact_id: `scan:${documentId}`,
      document_id: documentId,
      role: canonicalScanIds.has(documentId) ? 'canonical_ocr_input' : 'same_work_scan_witness',
      publication_page_url: scanContext.source_page_url,
      request_url: `${scanContext.source_url_prefix}${filename}`,
      local_path: `${scanContext.path_prefix}${filename}`,
      sha256: artifactSha256,
      bytes,
      allowed_media_types: expectedMediaTypes(filename),
    });
  }
  for (const attachment of proofs.native_attachments || []) {
    const records = [
      ['canonical', attachment.canonical],
      ...(attachment.variants || []).map((artifact) => [`variant:${artifact.sha256.slice(0, 12)}`, artifact]),
    ];
    for (const [kind, artifact] of records) {
      artifacts.push({
        artifact_id: `attachment:${attachment.document_id}:${kind}`,
        document_id: attachment.document_id,
        role: kind === 'canonical' ? 'canonical_native_attachment' : 'native_attachment_variant',
        publication_page_url: artifact.source_page_url,
        request_url: artifact.source_url,
        local_path: artifact.path,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        allowed_media_types: expectedMediaTypes(artifact.path, artifact.media_type),
      });
    }
  }
  return artifacts.sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
}

async function fetchRedirectChain(url, fetchImpl, { maxRedirects = 8 } = {}) {
  let current = url;
  const redirects = [];
  for (let attempt = 0; attempt <= maxRedirects; attempt += 1) {
    const response = await fetchImpl(current, {
      redirect: 'manual',
      headers: {
        accept: '*/*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
        'user-agent': 'curriculum-atlas-source-receipt/1.0',
      },
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, current).href;
      redirects.push({ url: current, status: response.status, location: next });
      current = next;
      continue;
    }
    return {
      redirects,
      final_url: current,
      status: response.status,
      content_type: normalizeMediaType(response.headers.get('content-type')),
      bytes: Buffer.from(await response.arrayBuffer()),
    };
  }
  throw new Error(`redirect limit exceeded for ${url}`);
}

export async function refreshSourceRecoveryOnlineReceipt({
  root = DEFAULT_ROOT,
  proofs = null,
  fetchImpl = globalThis.fetch,
  checkedAt = new Date().toISOString(),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('online receipt refresh requires fetch');
  const projectRoot = resolve(root instanceof URL ? fileURLToPath(root) : root);
  const proofBuffer = await readFile(resolve(projectRoot, PROOF_PATH));
  const proofData = proofs || JSON.parse(proofBuffer.toString('utf8'));
  const expectedArtifacts = collectExpectedSourceRecoveryArtifacts(proofData);
  const artifactsByPage = new Map();
  for (const artifact of expectedArtifacts) {
    if (!officialUrl(artifact.publication_page_url) || !officialUrl(artifact.request_url)) {
      throw new Error(`non-official or placeholder URL in ${artifact.artifact_id}`);
    }
    const records = artifactsByPage.get(artifact.publication_page_url) || [];
    records.push(artifact);
    artifactsByPage.set(artifact.publication_page_url, records);
  }

  const pageReceipts = [];
  const hrefByArtifact = new Map();
  for (const [pageUrl, pageArtifacts] of [...artifactsByPage].sort(([left], [right]) => left.localeCompare(right))) {
    const fetched = await fetchRedirectChain(pageUrl, fetchImpl);
    const hrefs = fetched.status === 200 && fetched.content_type === 'text/html'
      ? htmlHrefs(fetched.bytes.toString('utf8'), fetched.final_url)
      : [];
    const verified = [];
    for (const artifact of pageArtifacts) {
      const observed = hrefs.find((href) => equivalentOfficialUrl(href, artifact.request_url)) || null;
      hrefByArtifact.set(artifact.artifact_id, observed);
      if (observed) verified.push(artifact.request_url);
    }
    let pageStatus = 'invalid';
    if (fetched.status === 200 && fetched.content_type === 'text/html'
      && verified.length === pageArtifacts.length) pageStatus = 'html_href_verified';
    else if (pageUrl.startsWith(ICTR_WAF_PAGE_PREFIX)
      && ICTR_WAF_STATUSES.has(fetched.status)
      && fetched.content_type === 'text/html') pageStatus = 'official_waf_interstitial';
    if (pageStatus === 'invalid') {
      throw new Error(`publication page did not verify every expected href: ${pageUrl} status=${fetched.status}`);
    }
    pageReceipts.push({
      page_url: pageUrl,
      redirect_chain: fetched.redirects,
      final_url: fetched.final_url,
      status: fetched.status,
      content_type: fetched.content_type,
      bytes: fetched.bytes.length,
      sha256: sha256(fetched.bytes),
      page_status: pageStatus,
      verified_artifact_urls: verified.sort(),
    });
  }

  const artifactReceipts = [];
  for (const expected of expectedArtifacts) {
    const fetched = await fetchRedirectChain(expected.request_url, fetchImpl);
    const artifactSha256 = sha256(fetched.bytes);
    if (fetched.status !== 200 || fetched.bytes.length !== expected.bytes
      || artifactSha256 !== expected.sha256
      || !expected.allowed_media_types.includes(fetched.content_type)
      || !hasExpectedMagic(fetched.bytes, expected.local_path)
      || !equivalentOfficialUrl(fetched.final_url, expected.request_url)) {
      throw new Error(`online artifact identity mismatch: ${expected.artifact_id}`);
    }
    const observedHref = hrefByArtifact.get(expected.artifact_id) || null;
    artifactReceipts.push({
      artifact_id: expected.artifact_id,
      document_id: expected.document_id,
      role: expected.role,
      publication_page_url: expected.publication_page_url,
      expected_href_url: expected.request_url,
      observed_href_url: observedHref,
      href_status: observedHref ? 'verified_in_publication_html' : 'official_waf_interstitial_exact_artifact',
      request_url: expected.request_url,
      redirect_chain: fetched.redirects,
      final_url: fetched.final_url,
      status: fetched.status,
      content_type: fetched.content_type,
      bytes: fetched.bytes.length,
      sha256: artifactSha256,
    });
  }

  const body = {
    $schema: SCHEMA_PATH,
    schema_version: 1,
    policy: POLICY,
    checked_at: checkedAt,
    max_age_seconds: MAX_AGE_SECONDS,
    checker: CHECKER,
    source_proof: { path: PROOF_PATH, sha256: sha256(proofBuffer), bytes: proofBuffer.length },
    publication_pages: pageReceipts,
    artifacts: artifactReceipts,
  };
  return { ...body, receipt_sha256: sha256(stableStringify(body)) };
}

function issue(errors, code, detail) {
  errors.push({ code, detail });
}

function validateRedirectChain(chain, errors, label) {
  if (!Array.isArray(chain)) {
    issue(errors, 'redirect_chain', label);
    return;
  }
  for (const redirect of chain) {
    if (!exactKeys(redirect, ['url', 'status', 'location'])
      || !officialUrl(redirect.url) || !officialUrl(redirect.location)
      || !Number.isInteger(redirect.status) || redirect.status < 300 || redirect.status >= 400
      || redirect.status === 304) issue(errors, 'redirect_chain', label);
  }
}

export async function validateSourceRecoveryOnlineReceipt({
  root = DEFAULT_ROOT,
  receipt = null,
  proofs = null,
  requireFresh = false,
  requireLocal = false,
  now = new Date(),
} = {}) {
  const projectRoot = resolve(root instanceof URL ? fileURLToPath(root) : root);
  const [receiptData, proofBuffer] = await Promise.all([
    receipt || readFile(resolve(projectRoot, DEFAULT_RECEIPT_PATH), 'utf8').then(JSON.parse),
    readFile(resolve(projectRoot, PROOF_PATH)),
  ]);
  const proofData = proofs || JSON.parse(proofBuffer.toString('utf8'));
  const errors = [];
  if (!exactKeys(receiptData, [
    '$schema', 'schema_version', 'policy', 'checked_at', 'max_age_seconds', 'checker',
    'source_proof', 'publication_pages', 'artifacts', 'receipt_sha256',
  ]) || receiptData.$schema !== SCHEMA_PATH || receiptData.schema_version !== 1
    || receiptData.policy !== POLICY || receiptData.max_age_seconds !== MAX_AGE_SECONDS
    || receiptData.checker !== CHECKER) issue(errors, 'receipt_contract', 'root contract drifted');
  if (!exactKeys(receiptData.source_proof, ['path', 'sha256', 'bytes'])
    || receiptData.source_proof.path !== PROOF_PATH
    || receiptData.source_proof.sha256 !== sha256(proofBuffer)
    || receiptData.source_proof.bytes !== proofBuffer.length) {
    issue(errors, 'source_proof_binding', PROOF_PATH);
  }
  const { receipt_sha256: declaredReceiptSha256, ...receiptBody } = receiptData;
  if (!SHA256.test(declaredReceiptSha256 || '')
    || declaredReceiptSha256 !== sha256(stableStringify(receiptBody))) {
    issue(errors, 'receipt_sha256', 'receipt body hash mismatch');
  }
  const checkedAtMs = Date.parse(receiptData.checked_at || '');
  if (!Number.isFinite(checkedAtMs)) issue(errors, 'checked_at', 'invalid checked_at');
  if (requireFresh && Number.isFinite(checkedAtMs)) {
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
    if (!Number.isFinite(nowMs) || checkedAtMs > nowMs + 5 * 60 * 1000
      || nowMs - checkedAtMs > MAX_AGE_SECONDS * 1000) {
      issue(errors, 'receipt_stale', `checked_at=${receiptData.checked_at}`);
    }
  }

  const expectedArtifacts = collectExpectedSourceRecoveryArtifacts(proofData);
  const expectedById = new Map(expectedArtifacts.map((artifact) => [artifact.artifact_id, artifact]));
  const expectedPages = new Map();
  for (const artifact of expectedArtifacts) {
    const records = expectedPages.get(artifact.publication_page_url) || [];
    records.push(artifact);
    expectedPages.set(artifact.publication_page_url, records);
  }
  const pageByUrl = new Map();
  for (const page of receiptData.publication_pages || []) {
    if (!exactKeys(page, [
      'page_url', 'redirect_chain', 'final_url', 'status', 'content_type', 'bytes', 'sha256',
      'page_status', 'verified_artifact_urls',
    ]) || pageByUrl.has(page.page_url) || !officialUrl(page.page_url) || !officialUrl(page.final_url)
      || !Number.isInteger(page.status) || page.status === 404
      || !Number.isInteger(page.bytes) || page.bytes < 1 || !SHA256.test(page.sha256 || '')
      || page.content_type !== 'text/html') {
      issue(errors, 'publication_page_contract', page.page_url || '<missing>');
    }
    pageByUrl.set(page.page_url, page);
    validateRedirectChain(page.redirect_chain, errors, page.page_url);
    const expected = expectedPages.get(page.page_url) || [];
    const expectedUrls = expected.map((artifact) => artifact.request_url).sort();
    if (page.page_status === 'html_href_verified') {
      if (page.status !== 200
        || JSON.stringify(page.verified_artifact_urls) !== JSON.stringify(expectedUrls)) {
        issue(errors, 'publication_href_coverage', page.page_url);
      }
    } else if (page.page_status === 'official_waf_interstitial') {
      if (!page.page_url.startsWith(ICTR_WAF_PAGE_PREFIX)
        || !ICTR_WAF_STATUSES.has(page.status)
        || (page.verified_artifact_urls || []).length !== 0) {
        issue(errors, 'publication_waf_exception', page.page_url);
      }
    } else issue(errors, 'publication_page_status', page.page_url);
  }
  if (pageByUrl.size !== expectedPages.size
    || [...expectedPages.keys()].some((pageUrl) => !pageByUrl.has(pageUrl))) {
    issue(errors, 'publication_page_coverage', `expected ${expectedPages.size}, observed ${pageByUrl.size}`);
  }

  const receiptById = new Map();
  for (const artifact of receiptData.artifacts || []) {
    if (!exactKeys(artifact, [
      'artifact_id', 'document_id', 'role', 'publication_page_url', 'expected_href_url',
      'observed_href_url', 'href_status', 'request_url', 'redirect_chain', 'final_url',
      'status', 'content_type', 'bytes', 'sha256',
    ]) || receiptById.has(artifact.artifact_id)) {
      issue(errors, 'artifact_receipt_contract', artifact.artifact_id || '<missing>');
    }
    receiptById.set(artifact.artifact_id, artifact);
    validateRedirectChain(artifact.redirect_chain, errors, artifact.artifact_id);
    const expected = expectedById.get(artifact.artifact_id);
    const page = pageByUrl.get(artifact.publication_page_url);
    if (!expected || artifact.document_id !== expected.document_id || artifact.role !== expected.role
      || artifact.publication_page_url !== expected.publication_page_url
      || artifact.expected_href_url !== expected.request_url || artifact.request_url !== expected.request_url
      || artifact.status !== 200 || artifact.content_type === 'text/html'
      || !expected.allowed_media_types.includes(artifact.content_type)
      || artifact.bytes !== expected.bytes || artifact.sha256 !== expected.sha256
      || !equivalentOfficialUrl(artifact.final_url, expected.request_url)
      || artifact.status === 404) {
      issue(errors, 'artifact_exact_binding', artifact.artifact_id);
    }
    if (page?.page_status === 'html_href_verified') {
      if (artifact.href_status !== 'verified_in_publication_html'
        || !equivalentOfficialUrl(artifact.observed_href_url, expected?.request_url)) {
        issue(errors, 'artifact_href_binding', artifact.artifact_id);
      }
    } else if (page?.page_status === 'official_waf_interstitial') {
      if (artifact.href_status !== 'official_waf_interstitial_exact_artifact'
        || artifact.observed_href_url !== null) issue(errors, 'artifact_href_binding', artifact.artifact_id);
    }
    if (requireLocal && expected) {
      try {
        const localBytes = await readFile(safeProjectPath(projectRoot, expected.local_path));
        if (localBytes.length !== expected.bytes || sha256(localBytes) !== expected.sha256
          || !hasExpectedMagic(localBytes, expected.local_path)) {
          issue(errors, 'local_artifact_binding', artifact.artifact_id);
        }
      } catch (error) {
        issue(errors, 'local_artifact_binding', `${artifact.artifact_id}: ${error.message}`);
      }
    }
  }
  if (receiptById.size !== expectedById.size
    || [...expectedById.keys()].some((artifactId) => !receiptById.has(artifactId))) {
    issue(errors, 'artifact_receipt_coverage', `expected ${expectedById.size}, observed ${receiptById.size}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    counts: {
      publication_pages: expectedPages.size,
      artifacts: expectedArtifacts.length,
      html_href_verified_pages: [...pageByUrl.values()].filter((page) => page.page_status === 'html_href_verified').length,
      waf_interstitial_pages: [...pageByUrl.values()].filter((page) => page.page_status === 'official_waf_interstitial').length,
    },
  };
}

export async function assertSourceRecoveryOnlineReceiptFresh(options = {}) {
  const report = await validateSourceRecoveryOnlineReceipt({ ...options, requireFresh: true });
  if (!report.ok) {
    throw new Error(`source recovery online receipt is not fresh and exact: ${report.errors.map((error) => error.code).join(', ')}`);
  }
  return report;
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, refresh: false, fresh: false, requireLocal: false, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--refresh') options.refresh = true;
    else if (argument === '--fresh') options.fresh = true;
    else if (argument === '--require-local') options.requireLocal = true;
    else if (argument === '--root' || argument === '--output') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      if (argument === '--root') options.root = value;
      else options.output = value;
      index += 1;
    } else throw new Error(`unexpected argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.refresh) {
    const receipt = await refreshSourceRecoveryOnlineReceipt({ root: options.root });
    const output = `${JSON.stringify(receipt, null, 2)}\n`;
    if (options.output) {
      const projectRoot = resolve(options.root);
      const destination = safeProjectPath(projectRoot, options.output);
      await writeFile(destination, output, { mode: 0o600 });
    } else process.stdout.write(output);
    return;
  }
  const report = await validateSourceRecoveryOnlineReceipt({
    root: options.root,
    requireFresh: options.fresh,
    requireLocal: options.requireLocal,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`source-recovery-online-receipt: ${error.message}\n`);
    process.exitCode = 1;
  });
}
