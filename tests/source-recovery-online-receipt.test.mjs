import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  collectExpectedSourceRecoveryArtifacts,
  refreshSourceRecoveryOnlineReceipt,
  validateSourceRecoveryOnlineReceipt,
} from '../scripts/source-recovery-online-receipt.mjs';

const root = new URL('../', import.meta.url);
const [proofs, receipt] = await Promise.all([
  readFile(new URL('data/source-recovery-proofs.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('data/source-recovery-online-receipt.json', root), 'utf8').then(JSON.parse),
]);

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function rehash(value) {
  const { receipt_sha256: _old, ...body } = value;
  value.receipt_sha256 = createHash('sha256').update(stableStringify(body)).digest('hex');
  return value;
}

test('tracked online receipt binds every official page and exact artifact and is fresh', async () => {
  const report = await validateSourceRecoveryOnlineReceipt({
    root,
    requireFresh: true,
    requireLocal: true,
    now: new Date('2026-07-22T08:00:00.000Z'),
  });
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.deepEqual(report.counts, {
    publication_pages: 6,
    artifacts: 23,
    html_href_verified_pages: 4,
    waf_interstitial_pages: 2,
  });
});

test('online refresh uses an injectable fetch and verifies page hrefs plus artifact bytes', async () => {
  const expected = collectExpectedSourceRecoveryArtifacts(proofs);
  const byUrl = new Map(expected.map((artifact) => [artifact.request_url, artifact]));
  const byPage = new Map();
  for (const artifact of expected) {
    const records = byPage.get(artifact.publication_page_url) || [];
    records.push(artifact);
    byPage.set(artifact.publication_page_url, records);
  }
  const fetchImpl = async (url) => {
    if (byPage.has(url)) {
      const html = byPage.get(url).map((artifact) => `<a href="${artifact.request_url}">source</a>`).join('');
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    const artifact = byUrl.get(url);
    assert.ok(artifact, url);
    const bytes = await readFile(new URL(artifact.local_path, root));
    return new Response(bytes, {
      status: 200,
      headers: { 'content-type': artifact.allowed_media_types[0] },
    });
  };
  const refreshed = await refreshSourceRecoveryOnlineReceipt({
    root,
    proofs,
    fetchImpl,
    checkedAt: '2026-07-22T08:00:00.000Z',
  });
  assert.equal(refreshed.artifacts.length, 23);
  assert.equal(refreshed.publication_pages.every((page) => page.page_status === 'html_href_verified'), true);
  const report = await validateSourceRecoveryOnlineReceipt({
    root,
    receipt: refreshed,
    proofs,
    requireFresh: true,
    now: new Date('2026-07-22T08:01:00.000Z'),
  });
  assert.equal(report.ok, true, JSON.stringify(report.errors));
});

test('placeholder, old 404, missing href, and stale receipt attacks fail closed', async () => {
  for (const mutation of [
    (value) => {
      const artifact = value.artifacts[0];
      artifact.request_url = 'https://example.invalid/old-source.pdf';
      artifact.expected_href_url = artifact.request_url;
      artifact.final_url = artifact.request_url;
    },
    (value) => {
      value.publication_pages[0].status = 404;
    },
    (value) => {
      const page = value.publication_pages.find((entry) => entry.page_status === 'html_href_verified');
      page.verified_artifact_urls = [];
    },
    (value) => {
      value.checked_at = '2026-07-01T00:00:00.000Z';
    },
  ]) {
    const attacked = rehash(structuredClone(receipt));
    mutation(attacked);
    rehash(attacked);
    const report = await validateSourceRecoveryOnlineReceipt({
      root,
      receipt: attacked,
      proofs,
      requireFresh: true,
      now: new Date('2026-07-22T08:00:00.000Z'),
    });
    assert.equal(report.ok, false);
  }
});
