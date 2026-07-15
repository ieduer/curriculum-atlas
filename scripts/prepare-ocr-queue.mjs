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
].map((document) => [document.id, document]));

const candidates = catalog.documents
  .filter((document) => ['ocr_required', 'ocr_in_quality_review'].includes(document.text_quality_status));
const blocked = candidates
  .filter((document) => !localById.get(document.id)?.local_cache_path)
  .map((document) => ({
    id: document.id,
    title: document.title,
    reason: 'no_verified_local_pdf',
    access_status: document.access_status,
    policy: 'metadata_only_fail_closed',
  }));
const documents = candidates
  .filter((document) => localById.get(document.id)?.local_cache_path)
  .map((document) => {
    const local = localById.get(document.id);
    return {
      id: document.id,
      title: document.title,
      subject: document.subject,
      source_tier: document.source_tier,
      source_sha256: document.checksum_sha256,
      page_count: document.page_count ?? local.page_count ?? null,
      local_cache_path: local.local_cache_path,
      input_quality_status: document.text_quality_status,
      priority: document.id.startsWith('legacy-compendium-') ? 1 : 2,
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
    priority_1_documents: documents.filter((document) => document.priority === 1).length,
    blocked_documents: blocked.length,
  },
  documents,
  blocked,
};

await writeFile(new URL('data/ocr-queue.json', projectRoot), `${JSON.stringify(queue, null, 2)}\n`);
console.log(JSON.stringify(queue.counts));
