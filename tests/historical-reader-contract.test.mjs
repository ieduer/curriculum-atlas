import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const [app, worker, styles, headers, builder, publisher, pre2001, century] = await Promise.all([
  readFile(new URL('public/app.js', root), 'utf8'),
  readFile(new URL('src/index.ts', root), 'utf8'),
  readFile(new URL('public/styles.css', root), 'utf8'),
  readFile(new URL('public/_headers', root), 'utf8'),
  readFile(new URL('scripts/build-historical-reader-package.mjs', root), 'utf8'),
  readFile(new URL('scripts/publish-historical-reader.mjs', root), 'utf8'),
  readFile(new URL('public/data/pre2001-subject-detail-observation-layer.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('public/data/century-observation-layer.json', root), 'utf8').then(JSON.parse),
]);

test('version compare and source search require an actual OCR document before reading page_count', () => {
  assert.match(app, /if \(ocrDocument && ocrDocument\.completed_pages === ocrDocument\.page_count\)/);
  assert.doesNotMatch(app, /ocrDocument\?\.completed_pages === ocrDocument\?\.page_count/);
});

test('the authenticated reader covers every deduplicated 1902-2000 archive identity', () => {
  const archiveIds = new Set(pre2001.items.map((item) => item.source_item_id || item.id));
  assert.equal(pre2001.items.length, 462);
  assert.equal(century.items.length, 134);
  assert.equal(archiveIds.size, 461);
  assert.match(builder, /items\.length === 461/);
  assert.match(worker, /pointer\.item_count !== 461/);
});

test('original scans remain private, bounded and explicitly non-citable', () => {
  assert.match(app, /登录后按本条页段查看/);
  assert.match(app, /查看原图与内容/);
  assert.match(app, /OCR 只辅助阅读，任何冲突以原图为准且不可引用/);
  assert.match(worker, /requireAuthenticated\(session\)/);
  assert.match(worker, /audience !== 'authenticated_bdfz_user'/);
  assert.match(worker, /public_redistribution_allowed !== false/);
  assert.match(builder, /scope: 'bounded_item_only'/);
  assert.match(builder, /original_image_format: 'source_pdf_page_fragment'/);
  assert.match(publisher, /historical-reader\/current\.json/);
  assert.match(publisher, /WRANGLER_MAX_ATTEMPTS = 5/);
  assert.match(publisher, /--resume-readback/);
  assert.match(publisher, /resuming at full readback/);
  assert.doesNotMatch(builder, /public\/data\/historical-reader/);
  assert.match(styles, /\.historical-reader-shell iframe/);
  assert.match(headers, /frame-src 'self' https:\/\/challenges\.cloudflare\.com/);
});
