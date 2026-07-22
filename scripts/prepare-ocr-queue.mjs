import { readFile, writeFile } from 'node:fs/promises';

const projectRoot = new URL('../', import.meta.url);
const [catalog, supplemental, compendia] = await Promise.all([
  readFile(new URL('data/catalog.json', projectRoot), 'utf8').then(JSON.parse),
  readFile(new URL('data/supplemental-sources.json', projectRoot), 'utf8').then(JSON.parse),
  readFile(new URL('data/local-compendia.json', projectRoot), 'utf8').then(JSON.parse),
]);

const localById = new Map([
  ...supplemental.documents,
  ...compendia.documents,
  ...catalog.documents,
].map((document) => [document.id, document]));

const candidates = catalog.documents
  .filter((document) => ['ocr_required', 'ocr_in_quality_review'].includes(document.text_quality_status));
function blockReason(document) {
  const local = localById.get(document.id);
  if (!local?.local_cache_path) return 'no_verified_local_pdf';
  if (!Number.isInteger(local.page_count) || local.page_count < 1) return 'no_verified_page_count';
  if (!/^[a-f0-9]{64}$/i.test(String(local.checksum_sha256 || ''))) return 'no_verified_checksum';
  return null;
}

const blocked = candidates
  .filter((document) => blockReason(document))
  .map((document) => ({
    id: document.id,
    title: document.title,
    reason: blockReason(document),
    access_status: document.access_status,
    policy: 'metadata_only_fail_closed',
  }));
const documents = candidates
  .filter((document) => !blockReason(document))
  .map((document) => {
    const local = localById.get(document.id);
    return {
      id: document.id,
      title: document.title,
      subject: document.subject,
      source_tier: document.source_tier,
      source_sha256: document.checksum_sha256 ?? local.checksum_sha256,
      page_count: document.page_count ?? local.page_count ?? null,
      local_cache_path: local.local_cache_path,
      input_quality_status: document.text_quality_status,
      priority: ['moe-2011-01', 'moe-2022-03'].includes(document.id)
        ? 0
        : document.id.startsWith('legacy-compendium-') ? 1 : 2,
      policy: 'PaddleOCR-VL structured primary; Apple Vision independent audit; PP-StructureV3 adjudication; fail closed before citation.',
    };
  })
  .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));

const queue = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  counts: {
    documents: documents.length,
    pages: documents.reduce((sum, document) => sum + (document.page_count || 0), 0),
    priority_0_documents: documents.filter((document) => document.priority === 0).length,
    priority_1_documents: documents.filter((document) => document.priority === 1).length,
    blocked_documents: blocked.length,
  },
  documents,
  blocked,
};

await writeFile(new URL('data/ocr-queue.json', projectRoot), `${JSON.stringify(queue, null, 2)}\n`);
console.log(JSON.stringify(queue.counts));
