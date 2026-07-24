#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PACKAGE_ROOT = path.join(ROOT, '.cache/historical-reader-package');
const LOCAL_POINTER_PATH = path.join(PACKAGE_ROOT, 'current.json');
const ITEMS_PATH = path.join(ROOT, 'public/data/pre2001-subject-detail-observation-layer.json');
const CENTURY_PATH = path.join(ROOT, 'public/data/century-observation-layer.json');
const COMPENDIA_PATH = path.join(ROOT, 'data/local-compendia.json');
const PROFILE_ROOTS = {
  frozen_readback_20260718_b3_final: path.join(
    ROOT,
    '.cache/remote-ocr-offload/20260718-b3-final/readback/production-p1-mb16-shard-b-r3/documents',
  ),
  local_production_snapshot: path.join(ROOT, '.cache/ocr-production'),
  targeted_tesseract_20260723: path.join(ROOT, '.cache/pre2001-targeted-ocr'),
  candidate_hybrid_20260723: path.join(ROOT, '.cache/pre2001-candidate-hybrid-v15'),
};
const ITEM_PROFILE = 'curriculum-authenticated-bounded-reader-item-v1';
const MANIFEST_PROFILE = 'curriculum-authenticated-bounded-reader-manifest-v1';
const PREFIX = 'historical-reader';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  if (argv.length === 0) return { check: false };
  if (argv.length === 1 && argv[0] === '--check') return { check: true };
  throw new Error(`unknown arguments: ${argv.join(' ')}`);
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function mapLimit(values, limit, callback) {
  const output = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await callback(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return output;
}

function printedPageFor(item, physicalPage) {
  const segment = item.segments.find((candidate) =>
    physicalPage >= candidate.physical_page_start
    && physicalPage <= candidate.physical_page_end);
  if (!segment || !Number.isInteger(segment.printed_page_start)) return null;
  return segment.printed_page_start + physicalPage - segment.physical_page_start;
}

function archiveItems(pre2001, century) {
  const centuryById = new Map(century.items.map((item) => [item.id, item]));
  const grouped = new Map();
  for (const item of pre2001.items) {
    const viewerId = item.source_item_id || item.id;
    const existing = grouped.get(viewerId);
    if (existing) {
      requireValue(existing.parent_document_id === item.parent_document_id
        && existing.physical_page_start === item.physical_page_start
        && existing.physical_page_end === item.physical_page_end
        && existing.source_sha256 === item.source_sha256
        && existing.range_content_sha256 === item.range_content_sha256
        && existing.ocr_profile === item.ocr_profile,
      `shared archive identity has incompatible source range: ${viewerId}`);
      existing.visibility_facets = [...new Set([
        ...existing.visibility_facets,
        ...item.visibility_facets,
      ])].sort((left, right) => left.localeCompare(right, 'zh-CN'));
      existing.source_identity_ids.push(item.id);
      continue;
    }
    const centuryItem = item.source_item_id ? centuryById.get(item.source_item_id) : null;
    requireValue(!item.source_item_id || centuryItem, `century source item is missing: ${viewerId}`);
    grouped.set(viewerId, {
      id: viewerId,
      source_identity_ids: [item.id],
      parent_document_id: item.parent_document_id,
      parent_title: item.parent_title,
      title: centuryItem?.title || item.title,
      year: centuryItem?.year || item.year,
      stage: centuryItem?.stage || item.stage,
      document_type: centuryItem?.document_type || item.document_type,
      visibility_facets: [...item.visibility_facets],
      physical_page_start: item.physical_page_start,
      physical_page_end: item.physical_page_end,
      source_sha256: item.source_sha256,
      range_content_sha256: item.range_content_sha256,
      ocr_profile: item.ocr_profile,
      citation_allowed: false,
      semantic_claim_allowed: false,
      segments: centuryItem?.segments || [{
        stage: item.stage,
        role: 'primary_item',
        printed_page_start: item.printed_page_start,
        printed_page_end: item.printed_page_end,
        physical_page_start: item.physical_page_start,
        physical_page_end: item.physical_page_end,
      }],
    });
  }
  return [...grouped.values()].sort((left, right) =>
    left.year - right.year
    || left.parent_document_id.localeCompare(right.parent_document_id, 'en')
    || left.physical_page_start - right.physical_page_start
    || left.id.localeCompare(right.id, 'en'));
}

async function stateReader(document, profile) {
  const profileRoot = PROFILE_ROOTS[profile];
  requireValue(profileRoot, `unknown OCR profile: ${profile}`);
  const documentRoot = path.join(profileRoot, document.id);
  const stateBytes = await readFile(path.join(documentRoot, 'state.json'));
  const state = JSON.parse(stateBytes);
  requireValue(state.document_id === document.id, `OCR state id mismatch: ${document.id}`);
  requireValue(state.source_sha256 === document.checksum_sha256, `OCR source hash mismatch: ${document.id}`);
  requireValue(Number(state.page_count) === Number(document.page_count), `OCR page count mismatch: ${document.id}`);
  const completed = new Set((state.completed_pages || []).map(Number));
  const failed = new Set(Object.keys(state.failed_pages || {}).map(Number));
  const pageCache = new Map();

  async function page(number) {
    if (pageCache.has(number)) return pageCache.get(number);
    requireValue(completed.has(number) && !failed.has(number),
      `reader page is not complete: ${document.id} p.${number}`);
    const pageState = state.pages?.[String(number)];
    let bytes;
    let expected;
    if (state.profile === 'candidate_hybrid_20260723'
      && pageState?.origin === 'candidate_ocr_single_witness_v1') {
      const sidecarPath = path.join(
        ROOT,
        state.roots.candidate_ocr_single_witness_v1,
        `page-${String(number).padStart(4, '0')}.json`,
      );
      const sidecarBytes = await readFile(sidecarPath);
      requireValue(sha256(sidecarBytes) === pageState.sidecar_sha256,
        `candidate sidecar hash mismatch: ${document.id} p.${number}`);
      const sidecar = JSON.parse(sidecarBytes);
      requireValue(sidecar.document_id === document.id
        && Number(sidecar.physical_pdf_page) === number
        && sidecar.source_pdf_sha256 === document.checksum_sha256
        && sidecar.citation_allowed === false,
      `candidate sidecar identity mismatch: ${document.id} p.${number}`);
      bytes = Buffer.from(`${sidecar.lines.map((line) => line.text).join('\n')}\n`);
      expected = sha256(bytes);
    } else {
      const contentRoot = state.profile === 'candidate_hybrid_20260723'
        ? path.join(ROOT, state.roots.local_production_snapshot)
        : documentRoot;
      const contentPath = path.join(contentRoot, 'pages', String(number).padStart(4, '0'), 'content.md');
      bytes = await readFile(contentPath);
      expected = state.profile === 'candidate_hybrid_20260723'
        ? pageState?.content_sha256
        : pageState?.content_markdown_sha256;
    }
    requireValue(!expected || sha256(bytes) === expected,
      `OCR content hash mismatch: ${document.id} p.${number}`);
    const value = { physical_page: number, text: bytes.toString('utf8'), text_sha256: sha256(bytes) };
    pageCache.set(number, value);
    return value;
  }

  return { page };
}

async function packageInputs() {
  const [pre2001, century, compendia] = await Promise.all([
    readFile(ITEMS_PATH, 'utf8').then(JSON.parse),
    readFile(CENTURY_PATH, 'utf8').then(JSON.parse),
    readFile(COMPENDIA_PATH, 'utf8').then(JSON.parse),
  ]);
  requireValue(pre2001.schema_version === 1
    && pre2001.artifact_profile === 'curriculum-pre2001-subject-detail-observation-layer-v1'
    && pre2001.items.length === 462,
  'pre-2001 archive layer failed structural validation');
  requireValue(century.schema_version === 2 && century.items.length === 134,
    'century archive layer failed structural validation');
  const items = archiveItems(pre2001, century);
  requireValue(items.length === 461, `expected 461 archive identities, received ${items.length}`);
  return {
    items,
    documents: new Map(compendia.documents.map((document) => [document.id, document])),
  };
}

async function build() {
  const { items, documents } = await packageInputs();
  await mkdir(PACKAGE_ROOT, { recursive: true });
  const stagingRoot = path.join(PACKAGE_ROOT, `staging-${process.pid}`);
  const objectRoot = path.join(stagingRoot, 'objects');
  const pdfRoot = path.join(stagingRoot, 'pdf');
  await rm(stagingRoot, { recursive: true, force: true });
  await Promise.all([mkdir(objectRoot, { recursive: true }), mkdir(pdfRoot, { recursive: true })]);
  const stateCache = new Map();

  async function sourceFor(item) {
    const key = `${item.parent_document_id}|${item.ocr_profile}`;
    if (!stateCache.has(key)) {
      const document = documents.get(item.parent_document_id);
      requireValue(document, `unknown source document: ${item.parent_document_id}`);
      requireValue(document.checksum_sha256 === item.source_sha256,
        `source PDF hash drift: ${item.parent_document_id}`);
      stateCache.set(key, await stateReader(document, item.ocr_profile));
    }
    return stateCache.get(key);
  }

  const records = await mapLimit(items, 4, async (item) => {
    const document = documents.get(item.parent_document_id);
    const reader = await sourceFor(item);
    const pages = [];
    for (let physicalPage = item.physical_page_start; physicalPage <= item.physical_page_end; physicalPage += 1) {
      const page = await reader.page(physicalPage);
      pages.push({
        ordinal: pages.length + 1,
        physical_page: physicalPage,
        printed_page: printedPageFor(item, physicalPage),
        text: page.text,
        text_sha256: page.text_sha256,
      });
    }
    const rangeHash = sha256(pages.map((page) => `${page.physical_page}:${page.text_sha256}`).join('\n'));
    requireValue(rangeHash === item.range_content_sha256,
      `archive range content hash drift: ${item.id}`);
    const itemHash = sha256(item.id);
    const pdfPath = path.join(pdfRoot, `${itemHash}.pdf`);
    await execFileAsync('qpdf', [
      '--deterministic-id',
      '--empty',
      '--pages',
      path.join(ROOT, document.local_cache_path),
      `${item.physical_page_start}-${item.physical_page_end}`,
      '--',
      pdfPath,
    ], { maxBuffer: 4 * 1024 * 1024 });
    const pdfBytes = await readFile(pdfPath);
    const header = {
      schema_version: 1,
      artifact_profile: ITEM_PROFILE,
      item_id: item.id,
      source_identity_ids: item.source_identity_ids.sort((left, right) => left.localeCompare(right, 'en')),
      title: item.title,
      year: item.year,
      parent_document_id: item.parent_document_id,
      parent_title: item.parent_title,
      stage: item.stage,
      document_type: item.document_type,
      visibility_facets: item.visibility_facets,
      segments: item.segments,
      physical_page_start: item.physical_page_start,
      physical_page_end: item.physical_page_end,
      page_count: pages.length,
      source_pdf_sha256: item.source_sha256,
      range_content_sha256: rangeHash,
      pages,
      access_policy: {
        audience: 'authenticated_bdfz_user',
        scope: 'bounded_item_only',
        original_image_format: 'source_pdf_page_fragment',
        text_status: 'ocr_candidate_non_citation',
        citation_allowed: false,
        semantic_claim_allowed: false,
        public_redistribution_allowed: false,
      },
    };
    const headerBytes = Buffer.from(stableJson(header));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(headerBytes.byteLength);
    const packageBytes = Buffer.concat([prefix, headerBytes, pdfBytes]);
    const objectPath = path.join(objectRoot, `${itemHash}.bin`);
    await writeFile(objectPath, packageBytes, { mode: 0o600 });
    await rm(pdfPath, { force: true });
    return {
      item_id: item.id,
      item_hash: itemHash,
      object_key: null,
      sha256: sha256(packageBytes),
      bytes: packageBytes.byteLength,
      header_sha256: sha256(headerBytes),
      header_bytes: headerBytes.byteLength,
      pdf_sha256: sha256(pdfBytes),
      pdf_bytes: pdfBytes.byteLength,
      page_count: pages.length,
      source_pdf_sha256: item.source_sha256,
      physical_page_start: item.physical_page_start,
      physical_page_end: item.physical_page_end,
      local_path: path.relative(stagingRoot, objectPath),
    };
  });

  records.sort((left, right) => left.item_id.localeCompare(right.item_id, 'en'));
  const releaseSeed = stableJson(records.map(({ local_path, object_key, ...record }) => record));
  const releaseId = `release-${sha256(releaseSeed).slice(0, 32)}`;
  for (const record of records) {
    record.object_key = `${PREFIX}/releases/${releaseId}/items/${record.item_hash}.bin`;
  }
  const manifest = {
    schema_version: 1,
    artifact_profile: MANIFEST_PROFILE,
    release_id: releaseId,
    item_count: records.length,
    source_document_count: new Set(records.map((record) => record.source_pdf_sha256)).size,
    bounded_page_instances: records.reduce((sum, record) => sum + record.page_count, 0),
    access_policy: {
      audience: 'authenticated_bdfz_user',
      scope: 'bounded_item_only',
      public_redistribution_allowed: false,
      citation_allowed: false,
    },
    objects: records.map(({ local_path, ...record }) => record),
  };
  const manifestBytes = Buffer.from(stableJson(manifest));
  const manifestPath = path.join(stagingRoot, 'manifest.json');
  await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
  const pointer = {
    schema_version: 1,
    artifact_profile: 'curriculum-authenticated-bounded-reader-pointer-v1',
    release_id: releaseId,
    manifest_key: `${PREFIX}/releases/${releaseId}/manifest.json`,
    manifest_sha256: sha256(manifestBytes),
    manifest_bytes: manifestBytes.byteLength,
    item_count: records.length,
  };
  await writeFile(path.join(stagingRoot, 'pointer.json'), stableJson(pointer), { mode: 0o600 });
  await writeFile(path.join(stagingRoot, 'objects.json'), stableJson([
    ...records.map((record) => ({
      key: record.object_key,
      local_path: record.local_path,
      sha256: record.sha256,
      bytes: record.bytes,
      content_type: 'application/octet-stream',
    })),
    {
      key: pointer.manifest_key,
      local_path: 'manifest.json',
      sha256: pointer.manifest_sha256,
      bytes: pointer.manifest_bytes,
      content_type: 'application/json',
    },
  ]), { mode: 0o600 });
  const releaseRoot = path.join(PACKAGE_ROOT, releaseId);
  if (await exists(releaseRoot)) await rm(releaseRoot, { recursive: true, force: true });
  await rename(stagingRoot, releaseRoot);
  await writeFile(LOCAL_POINTER_PATH, stableJson({
    schema_version: 1,
    release_id: releaseId,
    release_root: path.relative(PACKAGE_ROOT, releaseRoot),
  }), { mode: 0o600 });
  process.stdout.write(`${stableJson({
    release_id: releaseId,
    items: records.length,
    bounded_page_instances: manifest.bounded_page_instances,
    package_bytes: records.reduce((sum, record) => sum + record.bytes, 0),
    manifest_sha256: pointer.manifest_sha256,
  })}`);
}

async function check() {
  const { items } = await packageInputs();
  const localPointer = JSON.parse(await readFile(LOCAL_POINTER_PATH, 'utf8'));
  const releaseRoot = path.join(PACKAGE_ROOT, localPointer.release_root);
  const [pointer, manifest, objects] = await Promise.all([
    readFile(path.join(releaseRoot, 'pointer.json'), 'utf8').then(JSON.parse),
    readFile(path.join(releaseRoot, 'manifest.json')),
    readFile(path.join(releaseRoot, 'objects.json'), 'utf8').then(JSON.parse),
  ]);
  requireValue(pointer.schema_version === 1
    && pointer.release_id === localPointer.release_id
    && pointer.manifest_sha256 === sha256(manifest)
    && pointer.manifest_bytes === manifest.byteLength
    && pointer.item_count === 461,
  'local historical reader pointer failed validation');
  const parsedManifest = JSON.parse(manifest);
  requireValue(parsedManifest.schema_version === 1
    && parsedManifest.artifact_profile === MANIFEST_PROFILE
    && parsedManifest.release_id === pointer.release_id
    && parsedManifest.item_count === items.length
    && parsedManifest.objects.length === items.length
    && objects.length === items.length + 1,
  'local historical reader manifest failed validation');
  const expectedIds = new Set(items.map((item) => item.id));
  const totalBytes = await mapLimit(objects, 8, async (object) => {
    const objectPath = path.join(releaseRoot, object.local_path);
    const info = await stat(objectPath);
    const bytes = await readFile(objectPath);
    requireValue(info.isFile()
      && info.size === object.bytes
      && sha256(bytes) === object.sha256,
    `historical reader object failed checksum: ${object.key}`);
    return info.size;
  });
  for (const record of parsedManifest.objects) {
    requireValue(expectedIds.delete(record.item_id), `unexpected or duplicate reader item: ${record.item_id}`);
    requireValue(record.page_count === record.physical_page_end - record.physical_page_start + 1,
      `reader page range is not contiguous: ${record.item_id}`);
  }
  requireValue(expectedIds.size === 0, `reader package omitted ${expectedIds.size} archive items`);
  process.stdout.write(`${stableJson({
    release_id: pointer.release_id,
    checks: 9,
    items: parsedManifest.item_count,
    bounded_page_instances: parsedManifest.bounded_page_instances,
    package_bytes: totalBytes.reduce((sum, value) => sum + value, 0),
  })}`);
}

const options = parseArgs(process.argv.slice(2));
await (options.check ? check() : build());
