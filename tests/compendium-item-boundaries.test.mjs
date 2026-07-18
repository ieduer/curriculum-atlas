import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildCompendiumBoundaryCandidates } from '../scripts/build-compendium-item-boundary-candidates.mjs';
import {
  verifyCompendiumHeadingEvidence,
  verifyCompendiumItemPageEvidence,
  verifyCompendiumTocEvidenceArtifacts,
} from '../scripts/compendium-item-publication.mjs';
import {
  compendiumPageSetSha256,
  validateCompendiumItemBoundaries,
} from '../scripts/validate-compendium-item-boundaries.mjs';
import { compendiumItemCitationEntitlementSha256 } from '../scripts/compendium-evidence-receipt.mjs';

const root = path.resolve(import.meta.dirname, '..');
const copy = (value) => structuredClone(value);
const digest = (value) => createHash('sha256').update(value).digest('hex');

const [boundaries, catalog, queue, onlineVerificationSamples] = await Promise.all([
  readFile(path.join(root, 'data/compendium-item-boundaries.json'), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'data/catalog.json'), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'data/ocr-queue.json'), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'data/online-verification-samples.json'), 'utf8').then(JSON.parse),
]);

function validate(value, overrides = {}) {
  return validateCompendiumItemBoundaries(value, {
    catalog,
    queue,
    onlineVerifications: onlineVerificationSamples,
    ...overrides,
  });
}

function reportText(report) {
  return report.errors.map((entry) => `${entry.code}: ${entry.detail}`).join('\n');
}

test('Chinese compendium TOC is a navigation-only 61-item candidate ledger', () => {
  const report = validate(boundaries);
  assert.equal(report.valid, true, reportText(report));
  assert.deepEqual(report.counts, {
    documents: 1,
    items: 61,
    display_allowed: 0,
    citation_allowed: 0,
    semantic_claim_allowed: 0,
  });
  const document = boundaries.documents[0];
  assert.equal(document.printed_to_physical_page_offset, 14);
  assert.deepEqual(document.toc_evidence.physical_pages.map((page) => page.page_number), [11, 12, 13]);
  assert.deepEqual(document.items[0], {
    ...document.items[0],
    title: '钦定蒙学堂章程(摘录)',
    printed_page_start: 3,
    candidate_physical_page_start: 17,
    candidate_physical_page_end: 17,
  });
  assert.equal(document.items.at(-1).candidate_physical_page_start, 562);
  assert.equal(document.items.at(-1).candidate_physical_page_end, 568);
  const attachments = document.items.filter((item) => item.item_kind === 'attachment');
  assert.equal(attachments.length, 2);
  for (const attachment of attachments) {
    const parent = document.items[attachment.sequence - 2];
    assert.equal(attachment.parent_item_id, parent.item_id);
    assert.equal(attachment.display_year, parent.display_year);
    assert.equal(attachment.section, parent.section);
  }
});

test('candidate boundaries fail closed under identity, range, or publication drift', async (t) => {
  const cases = [
    ['source hash', (value) => { value.documents[0].source_artifact_sha256 = '0'.repeat(64); }, /catalog_identity|queue_identity/],
    ['canonical title', (value) => { value.documents[0].items[0].title = '伪造标题'; }, /item_title_normalization/],
    ['TOC entry hash', (value) => { value.documents[0].items[0].raw_title = '伪造标题'; }, /item_title_normalization|item_toc_hash/],
    ['printed mapping', (value) => { value.documents[0].items[0].candidate_physical_page_start += 1; }, /item_start_mapping|item_candidate_end/],
    ['candidate end', (value) => { value.documents[0].items[0].candidate_physical_page_end += 1; }, /item_candidate_end/],
    ['attachment parent', (value) => { value.documents[0].items[24].parent_item_id = value.documents[0].items[0].item_id; }, /attachment_parent/],
    ['unverified heading evidence', (value) => { value.documents[0].items[0].body_heading.exact_text = '钦定蒙学堂章程（摘录）'; }, /heading_fail_closed/],
    ['unverified page release', (value) => { value.documents[0].items[0].page_evidence.page_publication_release_id = 'release-forged'; }, /page_evidence_fail_closed/],
    ['unstarted online review', (value) => { value.documents[0].items[0].online_verification.reviewer_id = 'forged'; }, /online_not_started/],
    ['candidate display', (value) => { value.documents[0].items[0].display_allowed = true; }, /display_gate/],
    ['candidate citation', (value) => { value.documents[0].items[0].citation_allowed = true; }, /citation_gate/],
    ['candidate semantics', (value) => { value.documents[0].items[0].semantic_claim_allowed = true; }, /semantic_gate/],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, () => {
      const value = copy(boundaries);
      mutate(value);
      const report = validate(value);
      assert.equal(report.valid, false);
      assert.match(reportText(report), expected);
    });
  }
});

test('verified item gates require heading, every page, exact edition, and semantic review in order', () => {
  const value = copy(boundaries);
  const item = value.documents[0].items[0];
  const nextItem = value.documents[0].items[1];
  const heading = '钦定蒙学堂章程(摘录)';
  item.body_heading = {
    verification_status: 'image_primary_witness_verified',
    physical_page: 17,
    exact_text: heading,
    exact_text_sha256: digest(heading),
    source_image_sha256: '1'.repeat(64),
    primary_ocr_sha256: '2'.repeat(64),
    witness_sha256: '3'.repeat(64),
    reviewer_id: 'reviewer:fixture',
    reviewed_at: '2026-07-18T18:05:00Z',
  };
  item.page_evidence = {
    verification_status: 'all_pages_display_verified',
    page_publication_release_id: 'page-release-fixture',
    physical_page_start: 17,
    physical_page_end: 17,
    accepted_page_count: 1,
    page_set_sha256: '4'.repeat(64),
    item_citation_entitlement_sha256: null,
  };
  item.identity_status = 'verified_full_item';
  item.display_allowed = true;
  let report = validate(value);
  assert.equal(report.valid, false);
  assert.match(reportText(report), /full_identity|display_gate/);

  const nextHeading = '钦定小学堂章程(摘录)';
  nextItem.body_heading = {
    verification_status: 'image_primary_witness_verified',
    physical_page: 18,
    exact_text: nextHeading,
    exact_text_sha256: digest(nextHeading),
    source_image_sha256: '5'.repeat(64),
    primary_ocr_sha256: '6'.repeat(64),
    witness_sha256: '7'.repeat(64),
    reviewer_id: 'reviewer:fixture',
    reviewed_at: '2026-07-18T18:05:01Z',
  };
  nextItem.identity_status = 'body_boundary_verified';
  report = validate(value);
  assert.equal(report.valid, true, reportText(report));
  assert.equal(report.counts.display_allowed, 1);
  assert.equal(report.counts.citation_allowed, 0);

  item.page_evidence.verification_status = 'all_pages_citation_verified';
  item.online_verification = {
    verification_status: 'same_edition_exact_text_verified',
    version_relation: 'same_work_same_edition',
    source_ids: ['source:fixture'],
    comparison_scope: 'full_item_text',
    primary_item_text_sha256: '8'.repeat(64),
    online_text_sha256: '9'.repeat(64),
    reviewer_id: 'reviewer:fixture',
    reviewed_at: '2026-07-18T18:05:02Z',
    verification_note: 'Full item text compared against the same edition.',
    uncertainty_note: null,
  };
  item.citation_allowed = true;
  item.page_evidence.item_citation_entitlement_sha256 = compendiumItemCitationEntitlementSha256({
    itemId: item.item_id,
    parentDocumentId: value.documents[0].document_id,
    sourceArtifactSha256: value.documents[0].source_artifact_sha256,
    pageSetSha256: item.page_evidence.page_set_sha256,
    primaryItemTextSha256: item.online_verification.primary_item_text_sha256,
    onlineTextSha256: item.online_verification.online_text_sha256,
    onlineSourceIds: item.online_verification.source_ids,
  });
  report = validate(value, {
    onlineVerifications: {
      samples: [{
        id: 'source:fixture',
        document_id: value.documents[0].document_id,
        contained_document: item.raw_title,
        edition_match_status: 'exact_document_exact_edition',
        verification_status: 'verified_exact',
        primary_ocr_sha256: item.online_verification.primary_item_text_sha256,
        online_text_sha256: item.online_verification.online_text_sha256,
        citation_allowed: true,
      }],
    },
  });
  assert.equal(report.valid, true, reportText(report));
  assert.equal(report.counts.citation_allowed, 1);
  report = validate(value, {
    onlineVerifications: {
      samples: [{
        id: 'source:fixture',
        document_id: value.documents[0].document_id,
        contained_document: item.raw_title,
        edition_match_status: 'exact_document_exact_edition',
        verification_status: 'verified_exact',
        primary_ocr_sha256: item.online_verification.primary_item_text_sha256,
        online_text_sha256: '0'.repeat(64),
        citation_allowed: true,
      }],
    },
  });
  assert.equal(report.valid, false);
  assert.match(reportText(report), /online_source_binding/);

  item.semantic_review = {
    review_status: 'editor_reviewed',
    reviewer_id: 'reviewer:fixture',
    reviewed_at: '2026-07-18T18:06:00Z',
    review_note: 'Exact edition and full page range reviewed.',
  };
  item.semantic_claim_allowed = true;
  item.uncertainty_note = null;
  report = validate(value, {
    onlineVerifications: {
      samples: [{
        id: 'source:fixture',
        document_id: value.documents[0].document_id,
        contained_document: item.raw_title,
        edition_match_status: 'exact_document_exact_edition',
        verification_status: 'verified_exact',
        primary_ocr_sha256: item.online_verification.primary_item_text_sha256,
        online_text_sha256: item.online_verification.online_text_sha256,
        citation_allowed: true,
      }],
    },
  });
  assert.equal(report.valid, true, reportText(report));
  assert.equal(report.counts.semantic_claim_allowed, 1);
});

test('page-set digest binds the complete ordered range, release, and per-page evidence', () => {
  const pages = [17, 18].map((pageNumber) => ({
    document_id: 'legacy-compendium-chinese',
    page_number: pageNumber,
    source_artifact_sha256: 'a'.repeat(64),
    source_page_sha256: digest(`image-${pageNumber}`),
    final_text_sha256: digest(`text-${pageNumber}`),
    evidence_bundle_sha256: digest(`bundle-${pageNumber}`),
    stable_locator: `legacy-compendium-chinese:page:${pageNumber}`,
    display_allowed: true,
    citation_allowed: false,
  }));
  const options = {
    documentId: 'legacy-compendium-chinese',
    sourceArtifactSha256: 'a'.repeat(64),
    pagePublicationReleaseId: 'corpus-fixture',
    physicalPageStart: 17,
    physicalPageEnd: 18,
    pages,
  };
  const first = compendiumPageSetSha256(options);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(compendiumPageSetSha256(options), first);
  assert.notEqual(compendiumPageSetSha256({ ...options, pagePublicationReleaseId: 'corpus-next' }), first);
  assert.notEqual(compendiumPageSetSha256({
    ...options,
    pages: [{ ...pages[0], final_text_sha256: 'b'.repeat(64) }, pages[1]],
  }), first);
  assert.throws(() => compendiumPageSetSha256({ ...options, pages: pages.slice(0, 1) }), /contiguous and complete/);
});

test('heading publication binds the reviewed title to primary OCR, image witness, and accepted page', () => {
  const documentBoundary = {
    document_id: 'legacy-compendium-chinese',
    source_artifact_sha256: 'a'.repeat(64),
  };
  const primaryBytes = Buffer.from('# 钦定蒙学堂章程（摘录）\n\n正文\n');
  const sourceImageBytes = Buffer.from('fixture-png-bytes');
  const witnessBytes = Buffer.from(JSON.stringify({
    document_id: documentBoundary.document_id,
    physical_pdf_page: 17,
    source_pdf_sha256: documentBoundary.source_artifact_sha256,
    rendered_image_sha256: digest(sourceImageBytes),
    lines: [{ text: '钦定蒙学堂章程（摘录）', confidence: 1 }],
  }));
  const item = {
    item_id: 'embedded:legacy-compendium-chinese:item-001',
    title: '钦定蒙学堂章程(摘录)',
    body_heading: {
      verification_status: 'image_primary_witness_verified',
      physical_page: 17,
      exact_text: '钦定蒙学堂章程（摘录）',
      primary_ocr_sha256: digest(primaryBytes),
      source_image_sha256: digest(sourceImageBytes),
      witness_sha256: digest(witnessBytes),
    },
  };
  const acceptedPage = {
    document_id: documentBoundary.document_id,
    page_number: 17,
    source_artifact_sha256: documentBoundary.source_artifact_sha256,
    source_page_sha256: item.body_heading.source_image_sha256,
    final_text_sha256: item.body_heading.primary_ocr_sha256,
  };
  const result = verifyCompendiumHeadingEvidence({
    documentBoundary, item, primaryBytes, witnessBytes, sourceImageBytes, acceptedPage,
  });
  assert.equal(result.primary_ocr_sha256, digest(primaryBytes));
  assert.throws(() => verifyCompendiumHeadingEvidence({
    documentBoundary, item, primaryBytes: Buffer.from('# 伪造标题\n'), witnessBytes, sourceImageBytes, acceptedPage,
  }), /heading image\/primary\/witness evidence drifted/);
  assert.throws(() => verifyCompendiumHeadingEvidence({
    documentBoundary,
    item,
    primaryBytes,
    sourceImageBytes,
    witnessBytes: Buffer.from(JSON.stringify({ ...JSON.parse(witnessBytes), document_id: 'wrong-document' })),
    acceptedPage,
  }), /heading image\/primary\/witness evidence drifted/);
});

test('full-item publication binds every ordered page to the current corpus release and online comparison', () => {
  const documentBoundary = {
    document_id: 'legacy-compendium-chinese',
    source_artifact_sha256: 'a'.repeat(64),
  };
  const releaseId = `page-gate-${'c'.repeat(24)}`;
  const rawPages = ['第一页\n', '第二页\n'];
  const boundPages = [17, 18].map((pageNumber, index) => ({
    document_id: documentBoundary.document_id,
    page_number: pageNumber,
    source_artifact_sha256: documentBoundary.source_artifact_sha256,
    source_page_sha256: digest(`image-${pageNumber}`),
    final_text_sha256: digest(rawPages[index]),
    evidence_bundle_sha256: digest(`bundle-${pageNumber}`),
    stable_locator: `${documentBoundary.document_id}:page:${pageNumber}`,
    display_allowed: true,
    citation_allowed: false,
  }));
  const item = {
    item_id: 'embedded:legacy-compendium-chinese:item-001',
    candidate_physical_page_start: 17,
    candidate_physical_page_end: 18,
    page_evidence: {
      verification_status: 'all_pages_display_verified',
      page_publication_release_id: releaseId,
      physical_page_start: 17,
      physical_page_end: 18,
      accepted_page_count: 2,
      item_citation_entitlement_sha256: null,
      page_set_sha256: compendiumPageSetSha256({
        documentId: documentBoundary.document_id,
        sourceArtifactSha256: documentBoundary.source_artifact_sha256,
        pagePublicationReleaseId: releaseId,
        physicalPageStart: 17,
        physicalPageEnd: 18,
        pages: boundPages,
      }),
    },
    online_verification: { verification_status: 'not_started', primary_item_text_sha256: null },
  };
  const result = verifyCompendiumItemPageEvidence({
    documentBoundary, item, boundPages, rawPages, currentPagePublicationReleaseId: releaseId,
  });
  assert.equal(result.full_item_raw_text_sha256, digest(rawPages.join('\f')));
  assert.throws(() => verifyCompendiumItemPageEvidence({
    documentBoundary, item, boundPages, rawPages, currentPagePublicationReleaseId: `page-gate-${'d'.repeat(24)}`,
  }), /page evidence is stale/);
  const citationItem = copy(item);
  citationItem.page_evidence.verification_status = 'all_pages_citation_verified';
  citationItem.online_verification = {
    verification_status: 'same_edition_exact_text_verified',
    primary_item_text_sha256: digest(rawPages.join('\f')),
    online_text_sha256: digest('same-edition-online-text'),
    source_ids: ['source:fixture'],
  };
  citationItem.page_evidence.item_citation_entitlement_sha256 = compendiumItemCitationEntitlementSha256({
    itemId: citationItem.item_id,
    parentDocumentId: documentBoundary.document_id,
    sourceArtifactSha256: documentBoundary.source_artifact_sha256,
    pageSetSha256: citationItem.page_evidence.page_set_sha256,
    primaryItemTextSha256: citationItem.online_verification.primary_item_text_sha256,
    onlineTextSha256: citationItem.online_verification.online_text_sha256,
    onlineSourceIds: citationItem.online_verification.source_ids,
  });
  const citationResult = verifyCompendiumItemPageEvidence({
    documentBoundary, item: citationItem, boundPages, rawPages, currentPagePublicationReleaseId: releaseId,
  });
  assert.match(citationResult.item_citation_entitlement_sha256, /^[a-f0-9]{64}$/);
  const staleOnlineItem = copy(item);
  staleOnlineItem.online_verification = {
    verification_status: 'same_edition_exact_text_verified',
    primary_item_text_sha256: 'e'.repeat(64),
  };
  assert.throws(() => verifyCompendiumItemPageEvidence({
    documentBoundary, item: staleOnlineItem, boundPages, rawPages, currentPagePublicationReleaseId: releaseId,
  }), /online comparison is bound to stale primary text/);
});

test('TOC candidate builder parses sections, attachments, provenance, and next-item ends', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'compendium-boundaries-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const documentId = 'fixture-compendium';
  const sourceSha256 = 'a'.repeat(64);
  const ocrRoot = path.join(temporary, 'ocr');
  const witnessRoot = path.join(temporary, 'witness');
  await mkdir(path.join(ocrRoot, documentId, 'pages', '0001'), { recursive: true });
  await mkdir(path.join(witnessRoot, documentId, 'vision'), { recursive: true });
  await mkdir(path.join(witnessRoot, documentId, 'images'), { recursive: true });
  const toc = [
    '## 小学部分',
    '1902年 第一篇 ..... 3',
    '附件一（摘录）第一篇的调整意见 ..... 4',
    '## 中学部分',
    '1912 年 第二篇 ..... 5',
    '',
  ].join('\n');
  await writeFile(path.join(ocrRoot, documentId, 'pages', '0001', 'content.md'), toc);
  const imageBytes = Buffer.from('fixture-rendered-page');
  await writeFile(path.join(witnessRoot, documentId, 'images', 'page-001.png'), imageBytes);
  await writeFile(path.join(witnessRoot, documentId, 'vision', 'page-001.json'), JSON.stringify({
    document_id: documentId,
    physical_pdf_page: 1,
    source_pdf_sha256: sourceSha256,
    rendered_image_sha256: digest(imageBytes),
  }));
  const value = await buildCompendiumBoundaryCandidates({
    documentId,
    sourceSha256,
    pageCount: 20,
    physicalOffset: 2,
    tocPages: [1],
    ocrRoot,
    witnessRoot,
    reviewerId: 'reviewer:fixture',
    reviewedAt: '2026-07-18T00:00:00Z',
  });
  const items = value.documents[0].items;
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => [item.candidate_physical_page_start, item.candidate_physical_page_end]), [
    [5, 5], [6, 6], [7, 20],
  ]);
  assert.equal(items[1].parent_item_id, items[0].item_id);
  assert.equal(items[1].display_year, 1902);
  assert.equal(items[2].section, '中学');
  assert.equal(value.documents[0].toc_evidence.physical_pages[0].primary_text_sha256, digest(toc));
  assert.deepEqual(await verifyCompendiumTocEvidenceArtifacts({
    documentBoundary: value.documents[0],
    ocrRoot,
    witnessRoot,
  }), {
    document_id: documentId,
    verified_toc_pages: 1,
    verified_toc_entries: 3,
  });
  const primaryPath = path.join(ocrRoot, documentId, 'pages', '0001', 'content.md');
  await writeFile(primaryPath, toc.replace('第一篇', '伪造篇目'));
  await assert.rejects(() => verifyCompendiumTocEvidenceArtifacts({
    documentBoundary: value.documents[0],
    ocrRoot,
    witnessRoot,
  }), /TOC page 1 image\/primary\/Vision receipt drifted/);
  await writeFile(primaryPath, toc);

  const existingOutput = path.join(temporary, 'existing.json');
  await writeFile(existingOutput, 'sentinel\n');
  const cli = spawnSync(process.execPath, [
    path.join(root, 'scripts/build-compendium-item-boundary-candidates.mjs'),
    '--document-id', documentId,
    '--source-sha256', sourceSha256,
    '--page-count', '20',
    '--physical-offset', '2',
    '--toc-page', '1',
    '--ocr-root', ocrRoot,
    '--witness-root', witnessRoot,
    '--output', existingOutput,
    '--reviewer-id', 'reviewer:fixture',
    '--reviewed-at', '2026-07-18T00:00:00Z',
  ], { encoding: 'utf8' });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /output already exists/);
  assert.equal(await readFile(existingOutput, 'utf8'), 'sentinel\n');

  const visionPath = path.join(witnessRoot, documentId, 'vision', 'page-001.json');
  const invalidVision = JSON.parse(await readFile(visionPath, 'utf8'));
  invalidVision.source_pdf_sha256 = 'c'.repeat(64);
  await writeFile(visionPath, JSON.stringify(invalidVision));
  await assert.rejects(() => buildCompendiumBoundaryCandidates({
    documentId,
    sourceSha256,
    pageCount: 20,
    physicalOffset: 2,
    tocPages: [1],
    ocrRoot,
    witnessRoot,
    reviewerId: 'reviewer:fixture',
    reviewedAt: '2026-07-18T00:00:00Z',
  }), /Vision provenance is invalid/);
});
