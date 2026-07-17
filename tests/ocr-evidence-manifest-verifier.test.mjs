import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  parseOcrEvidenceManifestArgs,
  verifyOcrEvidenceManifest,
  writeOcrEvidenceManifestVerification,
} from '../scripts/verify-ocr-evidence-manifest.mjs';

const SOURCE_SHA = 'a'.repeat(64);
const SECOND_SOURCE_SHA = 'b'.repeat(64);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function key(page, width = 3) {
  return String(page).padStart(width, '0');
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ocr-evidence-manifest-'));
  return {
    root,
    manifestPath: path.join(root, 'manifest.json'),
    witnessRoot: path.join(root, 'witness'),
    outputPath: path.join(root, 'derived', 'verification.json'),
  };
}

async function writeManifest(value, documents) {
  const pageCount = documents.reduce((sum, document) => sum + document.page_count, 0);
  const manifest = {
    schema_version: 1,
    manifest_type: 'curriculum_remote_whole_document_ocr_offload_plan',
    counts: {
      selected_documents: documents.length,
      selected_pages: pageCount,
    },
    documents: documents.map((document) => ({
      id: document.id,
      source_sha256: document.source_sha256,
      page_count: document.page_count,
      required_page_range: {
        first: 1,
        last: document.page_count,
        count: document.page_count,
      },
      citation_allowed: false,
    })),
  };
  await writeFile(value.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function writePage(value, document, page, {
  lines = [`${document.id} page ${page}`],
  visionOverrides = {},
  auditOverrides = {},
  image = Buffer.from(`image:${document.id}:${page}`),
} = {}) {
  const documentRoot = path.join(value.witnessRoot, document.id);
  const visionRoot = path.join(documentRoot, 'vision');
  const imageRoot = path.join(documentRoot, 'images');
  const auditRoot = path.join(documentRoot, 'audits');
  const passRoot = path.join(documentRoot, 'vision-passes', 'zh-primary');
  await Promise.all([
    mkdir(visionRoot, { recursive: true }),
    mkdir(imageRoot, { recursive: true }),
    mkdir(auditRoot, { recursive: true }),
    mkdir(passRoot, { recursive: true }),
  ]);
  const stem = `page-${key(page)}`;
  const imageName = `${stem}.png`;
  const imagePath = path.join(imageRoot, imageName);
  await writeFile(imagePath, image);
  const lineRecords = lines.map((text) => ({ text, confidence: 0.99 }));
  const rawSidecar = {
    file: imageName,
    lines: lineRecords,
  };
  const rawSidecarBytes = Buffer.from(`${JSON.stringify(rawSidecar, null, 2)}\n`);
  const rawTextBytes = Buffer.from(`${lines.join('\n')}\n`);
  const rawSidecarRelative = `vision-passes/zh-primary/${stem}.json`;
  const rawTextRelative = `vision-passes/zh-primary/${stem}.txt`;
  await writeFile(path.join(documentRoot, rawSidecarRelative), rawSidecarBytes);
  await writeFile(path.join(documentRoot, rawTextRelative), rawTextBytes);
  const profile = {
    schema_version: 1,
    profile_id: 'apple-vision-default-v1',
    document_language: 'default',
    canonical_pass_id: 'zh-primary',
    passes: [
      {
        pass_id: 'zh-primary',
        role: 'canonical',
        languages: ['zh-Hans', 'en-US'],
      },
    ],
  };
  const vision = {
    schema_version: 3,
    file: imageName,
    lines: lineRecords,
    document_id: document.id,
    physical_pdf_page: page,
    source_pdf_sha256: document.source_sha256,
    rendered_image_sha256: sha256(image),
    rendered_image_bytes: image.length,
    citation_allowed: false,
    witness_profile: profile,
    witness_profile_sha256: sha256(JSON.stringify(profile)),
    line_source_pass_id: 'zh-primary',
    witness_passes: [
      {
        pass_id: 'zh-primary',
        role: 'canonical',
        languages: ['zh-Hans', 'en-US'],
        lines: lineRecords,
        raw_sidecar_file: rawSidecarRelative,
        raw_sidecar_sha256: sha256(rawSidecarBytes),
        raw_text_file: rawTextRelative,
        raw_text_sha256: sha256(rawTextBytes),
        attempt_count: 1,
        recovered_after_retry: false,
      },
    ],
    ...visionOverrides,
  };
  const visionPath = path.join(visionRoot, `${stem}.json`);
  await writeFile(visionPath, `${JSON.stringify(vision, null, 2)}\n`);
  await writeFile(path.join(visionRoot, `${stem}.txt`), `${lines.join('\n')}\n`);
  const witnessHash = sha256(lines.join('\n'));
  const gate = 'unresolved_fail_closed';
  const auditPage = {
    page,
    primary_path: `/primary/${document.id}/${key(page, 4)}/content.md`,
    witness_path: visionPath,
    primary_sha256: 'c'.repeat(64),
    witness_sha256: witnessHash,
    gate,
    ...auditOverrides.page,
  };
  const audit = {
    schema_version: 1,
    page_range: [page, page],
    summary: {
      pages: 1,
      automatic_witness_pass: 0,
      manual_image_review_required: 0,
      blank_page_visual_confirmation_required: 0,
      unresolved_fail_closed: 1,
    },
    pages: [auditPage],
    ...auditOverrides.report,
  };
  await writeFile(
    path.join(auditRoot, `audit-${key(page, 4)}-${key(page, 4)}.json`),
    `${JSON.stringify(audit, null, 2)}\n`,
  );
  return {
    documentRoot,
    visionPath,
    imagePath,
    auditPath: path.join(auditRoot, `audit-${key(page, 4)}-${key(page, 4)}.json`),
    rawSidecarPath: path.join(documentRoot, rawSidecarRelative),
  };
}

function issueCodes(document) {
  return new Set(document.issues.map((issue) => issue.code));
}

test('passes a complete deterministic manifest-scoped evidence snapshot', async () => {
  const value = await fixture();
  const documents = [
    { id: 'doc-a', source_sha256: SOURCE_SHA, page_count: 2 },
    { id: 'doc-b', source_sha256: SECOND_SOURCE_SHA, page_count: 1 },
  ];
  await writeManifest(value, documents);
  for (const document of documents) {
    for (let page = 1; page <= document.page_count; page += 1) {
      await writePage(value, document, page);
    }
  }
  const diagnosticRoot = path.join(value.witnessRoot, 'doc-a', 'diagnostic-sandbox-proof');
  await mkdir(diagnosticRoot, { recursive: true });
  await writeFile(
    path.join(diagnosticRoot, 'page-001.json'),
    `${JSON.stringify({ error: 'intentionally unscoped diagnostic' })}\n`,
  );

  const first = await verifyOcrEvidenceManifest({
    manifestPath: value.manifestPath,
    witnessRoot: value.witnessRoot,
  });
  const second = await verifyOcrEvidenceManifest({
    manifestPath: value.manifestPath,
    witnessRoot: value.witnessRoot,
  });
  assert.deepEqual(second, first);
  assert.equal(first.verdict, 'pass');
  assert.equal(first.policy.evidence_mutation, 'none');
  assert.equal(first.policy.raw_ocr_text_in_output, false);
  assert.equal(first.manifest.expected_documents, 2);
  assert.equal(first.manifest.expected_pages, 3);
  assert.deepEqual(first.summary.issue_counts, {});
  assert.equal(first.summary.verified_documents, 2);
  assert.equal(first.summary.verified_pages, 3);
  assert.match(first.summary.evidence_snapshot_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    first.documents.map((document) => [document.document_id, document.verdict, document.verified_pages]),
    [
      ['doc-a', 'pass', 2],
      ['doc-b', 'pass', 1],
    ],
  );

  await writeOcrEvidenceManifestVerification({
    manifestPath: value.manifestPath,
    witnessRoot: value.witnessRoot,
    outputPath: value.outputPath,
  });
  const firstOutput = await readFile(value.outputPath, 'utf8');
  await writeOcrEvidenceManifestVerification({
    manifestPath: value.manifestPath,
    witnessRoot: value.witnessRoot,
    outputPath: value.outputPath,
  });
  assert.equal(await readFile(value.outputPath, 'utf8'), firstOutput);
  assert.equal(firstOutput.includes('doc-a page'), false);
});

test('fails closed on missing, extra, duplicate and noncanonical page artifacts', async () => {
  const value = await fixture();
  const document = { id: 'doc-a', source_sha256: SOURCE_SHA, page_count: 2 };
  await writeManifest(value, [document]);
  await writePage(value, document, 1);
  const pageTwo = await writePage(value, document, 2);
  await rm(pageTwo.auditPath);
  await writeFile(
    path.join(pageTwo.documentRoot, 'vision', 'page-2.json'),
    await readFile(pageTwo.visionPath),
  );
  await writeFile(
    path.join(pageTwo.documentRoot, 'vision', 'page-003.json'),
    await readFile(pageTwo.visionPath),
  );
  await writeFile(
    path.join(pageTwo.documentRoot, 'vision', 'page-000.json'),
    await readFile(pageTwo.visionPath),
  );
  await writeFile(
    path.join(pageTwo.documentRoot, 'images', 'page-003.png'),
    'extra image',
  );
  await writeFile(
    path.join(pageTwo.documentRoot, 'audits', 'audit-0003-0003.json'),
    `${JSON.stringify({ schema_version: 1, pages: [] })}\n`,
  );

  const result = await verifyOcrEvidenceManifest({
    manifestPath: value.manifestPath,
    witnessRoot: value.witnessRoot,
  });
  const codes = issueCodes(result.documents[0]);
  assert.equal(result.verdict, 'fail');
  assert.equal(codes.has('MISSING_AUDIT_SIDECAR'), true);
  assert.equal(codes.has('DUPLICATE_VISION_SIDECAR'), true);
  assert.equal(codes.has('NONCANONICAL_VISION_JSON'), true);
  assert.equal(codes.has('EXTRA_VISION_PAGE'), true);
  assert.equal(codes.has('EXTRA_RENDERED_IMAGE_PAGE'), true);
  assert.equal(codes.has('EXTRA_AUDIT_PAGE'), true);
  assert.equal(
    result.documents[0].issues.find((issue) => issue.code === 'EXTRA_VISION_PAGE').count,
    2,
  );
  assert.deepEqual(
    result.documents[0].issues.find((issue) => issue.code === 'MISSING_AUDIT_SIDECAR').page_ranges,
    [[2, 2]],
  );
});

test('fails closed on Vision identity drift, rendered-image drift and stale audit hash', async () => {
  const value = await fixture();
  const document = { id: 'doc-a', source_sha256: SOURCE_SHA, page_count: 1 };
  await writeManifest(value, [document]);
  const page = await writePage(value, document, 1, {
    visionOverrides: {
      document_id: 'wrong-doc',
      physical_pdf_page: 2,
      source_pdf_sha256: SECOND_SOURCE_SHA,
    },
    auditOverrides: {
      page: {
        witness_sha256: 'd'.repeat(64),
      },
    },
  });
  await writeFile(page.imagePath, 'mutated image with different byte length');

  const result = await verifyOcrEvidenceManifest({
    manifestPath: value.manifestPath,
    witnessRoot: value.witnessRoot,
  });
  const codes = issueCodes(result.documents[0]);
  assert.equal(codes.has('VISION_DOCUMENT_ID_MISMATCH'), true);
  assert.equal(codes.has('VISION_PAGE_IDENTITY_MISMATCH'), true);
  assert.equal(codes.has('VISION_SOURCE_SHA_MISMATCH'), true);
  assert.equal(codes.has('RENDERED_IMAGE_SHA_MISMATCH'), true);
  assert.equal(codes.has('RENDERED_IMAGE_SIZE_MISMATCH'), true);
  assert.equal(codes.has('STALE_AUDIT_WITNESS_HASH'), true);
  assert.equal(result.summary.verified_pages, 0);
});

test('fails closed on invalid JSON plus scoped retry, error and unreferenced raw sidecars', async () => {
  const value = await fixture();
  const document = { id: 'doc-a', source_sha256: SOURCE_SHA, page_count: 1 };
  await writeManifest(value, [document]);
  const page = await writePage(value, document, 1);
  await writeFile(page.rawSidecarPath, '{"lines":');
  const errorRoot = path.join(page.documentRoot, 'vision', 'retries');
  await mkdir(errorRoot, { recursive: true });
  await writeFile(
    path.join(errorRoot, 'page-001.error.json'),
    `${JSON.stringify({ error: 'redacted test failure' })}\n`,
  );
  const passRoot = path.join(page.documentRoot, 'vision-passes', 'zh-primary');
  await writeFile(path.join(passRoot, 'page-999.json'), '{}\n');

  const result = await verifyOcrEvidenceManifest({
    manifestPath: value.manifestPath,
    witnessRoot: value.witnessRoot,
  });
  const codes = issueCodes(result.documents[0]);
  assert.equal(codes.has('INVALID_JSON'), true);
  assert.equal(codes.has('VISION_RAW_REFERENCE_STALE'), true);
  assert.equal(codes.has('VISION_RAW_SIDECAR_INVALID'), true);
  assert.equal(codes.has('RETRY_OR_ERROR_SIDECAR_PRESENT'), true);
  assert.equal(codes.has('ERROR_SIDECAR_PRESENT'), true);
  assert.equal(codes.has('UNREFERENCED_RAW_PASS_FILE'), true);
  assert.equal(codes.has('UNEXPECTED_JSON_SIDECAR'), true);
  assert.equal(JSON.stringify(result).includes('redacted test failure'), false);
});

test('rejects malformed manifest contracts before evidence traversal', async (t) => {
  await t.test('duplicate document id', async () => {
    const value = await fixture();
    await writeManifest(value, [
      { id: 'doc-a', source_sha256: SOURCE_SHA, page_count: 1 },
      { id: 'doc-a', source_sha256: SOURCE_SHA, page_count: 1 },
    ]);
    await assert.rejects(
      verifyOcrEvidenceManifest({
        manifestPath: value.manifestPath,
        witnessRoot: value.witnessRoot,
      }),
      /duplicate document id/,
    );
  });

  await t.test('selected page count drift', async () => {
    const value = await fixture();
    const document = { id: 'doc-a', source_sha256: SOURCE_SHA, page_count: 1 };
    await writeManifest(value, [document]);
    const manifest = JSON.parse(await readFile(value.manifestPath, 'utf8'));
    manifest.counts.selected_pages = 2;
    await writeFile(value.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      verifyOcrEvidenceManifest({
        manifestPath: value.manifestPath,
        witnessRoot: value.witnessRoot,
      }),
      /selected_pages must equal 1/,
    );
  });
});

test('requires a unique CLI contract and output outside evidence inputs', async () => {
  assert.deepEqual(
    parseOcrEvidenceManifestArgs([
      '--manifest', 'manifest.json',
      '--witness-root', 'witness',
      '--output', 'verification.json',
    ]),
    {
      manifestPath: 'manifest.json',
      witnessRoot: 'witness',
      outputPath: 'verification.json',
    },
  );
  assert.throws(
    () => parseOcrEvidenceManifestArgs([
      '--manifest', 'one.json',
      '--manifest', 'two.json',
      '--witness-root', 'witness',
      '--output', 'verification.json',
    ]),
    /duplicate argument/,
  );

  const value = await fixture();
  const document = { id: 'doc-a', source_sha256: SOURCE_SHA, page_count: 1 };
  await writeManifest(value, [document]);
  await writePage(value, document, 1);
  await assert.rejects(
    writeOcrEvidenceManifestVerification({
      manifestPath: value.manifestPath,
      witnessRoot: value.witnessRoot,
      outputPath: path.join(value.witnessRoot, 'verification.json'),
    }),
    /output must be outside/,
  );
  await assert.rejects(access(path.join(value.witnessRoot, 'verification.json')), /ENOENT/);
});
