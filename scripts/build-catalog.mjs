import { mkdir, writeFile } from 'node:fs/promises';
import { sourceManifest } from './source-manifest.mjs';

const ids = new Set();
for (const record of sourceManifest) {
  if (ids.has(record.id)) throw new Error(`Duplicate source id: ${record.id}`);
  ids.add(record.id);
  if (!record.title || !record.source_url || !record.source_tier) {
    throw new Error(`Incomplete source record: ${record.id}`);
  }
}

function citationReady(record) {
  if (record.citation_allowed === true) return true;
  if (record.citation_allowed === false) return false;
  return ['html', 'catalog', 'pdf_in_zip'].includes(record.file_format) || record.id.startsWith('neea-2019-');
}

const catalog = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  source_policy: 'Primary official sources first; missing originals stay explicitly missing.',
  counts: {
    documents: sourceManifest.length,
    verified_online: sourceManifest.filter((item) => item.access_status === 'verified_online').length,
    local_verified_scan: sourceManifest.filter((item) => item.access_status === 'local_verified_scan').length,
    metadata_only: sourceManifest.filter((item) => item.access_status === 'metadata_only').length,
    citation_ready: sourceManifest.filter(citationReady).length,
    ocr_review_pending: sourceManifest.filter((item) => ['ocr_required', 'ocr_in_quality_review'].includes(item.text_quality_status)).length,
  },
  documents: sourceManifest,
};

await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(new URL('../data/catalog.json', import.meta.url), `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`Built ${catalog.counts.documents}-record catalog.`);
