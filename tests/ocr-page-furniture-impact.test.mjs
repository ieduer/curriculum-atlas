import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildOcrPageFurnitureImpactPreview,
  stripExactTrailingPrintedPage,
  writeOcrPageFurnitureImpactPreview,
} from '../scripts/preview-ocr-page-furniture-impact.mjs';

const SOURCE_SHA = 'a'.repeat(64);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ocr-furniture-impact-'));
  const documentId = 'doc-a';
  const primaryRoot = path.join(root, 'primary');
  const witnessRoot = path.join(root, 'witness');
  const visionRoot = path.join(witnessRoot, documentId, 'vision');
  const imageRoot = path.join(witnessRoot, documentId, 'images');
  await mkdir(visionRoot, { recursive: true });
  await mkdir(imageRoot, { recursive: true });
  const primaryValues = new Map([
    [1, '# Alpha\n\n1\n'],
    [2, '# Beta 42\n'],
  ]);
  const snapshotEntries = [];
  const imageHashes = new Map();
  for (let page = 1; page <= 2; page += 1) {
    const primaryKey = String(page).padStart(4, '0');
    const witnessKey = String(page).padStart(3, '0');
    await mkdir(path.join(primaryRoot, primaryKey), { recursive: true });
    await writeFile(path.join(primaryRoot, primaryKey, 'content.md'), primaryValues.get(page));
    const image = Buffer.from(`image-${page}`);
    const imageSha = sha256(image);
    imageHashes.set(page, imageSha);
    await writeFile(path.join(imageRoot, `page-${witnessKey}.png`), image);
    const sidecar = {
      schema_version: 3,
      file: `page-${witnessKey}.png`,
      document_id: documentId,
      physical_pdf_page: page,
      source_pdf_sha256: SOURCE_SHA,
      rendered_image_sha256: imageSha,
      lines: [
        { text: page === 1 ? 'Alpha' : 'Beta 42', confidence: 1 },
        { text: String(page), confidence: 1 },
      ],
    };
    const raw = `${JSON.stringify(sidecar, null, 2)}\n`;
    await writeFile(path.join(visionRoot, `page-${witnessKey}.json`), raw);
    snapshotEntries.push(`${documentId}/vision/page-${witnessKey}.json\0${sha256(raw)}`);
  }
  const ledger = {
    schema_version: 1,
    artifact_profile: 'ocr-page-furniture-approval-ledger-v1',
    activation_status: 'approved_not_activated',
    policy: {
      raw_witness_mutation: 'forbidden',
      audit_filter_activation: 'requires_explicit_consumer_and_final_witness_snapshot_match',
      publication_effect: 'none',
    },
    documents: [
      {
        document_id: documentId,
        source_pdf_sha256: SOURCE_SHA,
        page_count: 2,
        sidecar_snapshot_sha256: sha256(snapshotEntries.join('\n')),
        review_status: 'manually_approved_unactivated',
        header_rules: [],
        footer_rules: [
          {
            rule_id: 'doc-a-footer-1-2',
            candidate_type: 'printed_page_number_footer',
            start_page: 1,
            end_page: 2,
            page_count: 2,
            physical_to_printed_offset: 0,
            printed_page_start: 1,
            printed_page_end: 2,
            observed_last_line_must_equal_printed_page: true,
            removal_scope: 'audit_comparison_only',
            review_method: 'manual_source_image_stratified',
            approval_status: 'approved_not_activated',
            eligible_for_audit_filter: true,
            activated: false,
            examples: [
              {
                physical_page: 1,
                printed_page: 1,
                rendered_image_sha256: imageHashes.get(1),
              },
              {
                physical_page: 2,
                printed_page: 2,
                rendered_image_sha256: imageHashes.get(2),
              },
            ],
          },
        ],
      },
    ],
  };
  const ledgerPath = path.join(root, 'ledger.json');
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  return {
    root,
    ledgerPath,
    documentId,
    primaryRoot,
    witnessRoot,
    outputPath: path.join(root, 'output', 'impact.json'),
  };
}

test('removes only an exact standalone trailing printed page', () => {
  assert.deepEqual(stripExactTrailingPrintedPage('Body\n12\n', 12), {
    value: 'Body\n',
    removed: true,
  });
  assert.deepEqual(stripExactTrailingPrintedPage('Body 12\n', 12), {
    value: 'Body 12\n',
    removed: false,
  });
  assert.deepEqual(stripExactTrailingPrintedPage('Body\n13\n', 12), {
    value: 'Body\n13\n',
    removed: false,
  });
});

test('previews numeric and agreement impact without opening gates', async () => {
  const value = await fixture();
  const report = await buildOcrPageFurnitureImpactPreview({
    ledgerPath: value.ledgerPath,
    documentId: value.documentId,
    primaryRoot: value.primaryRoot,
    witnessRoot: value.witnessRoot,
  });
  assert.equal(report.approval_activation_status, 'approved_not_activated');
  assert.equal(report.policy.audit_mutation, 'none');
  assert.equal(report.policy.gate_mutation, 'none');
  assert.deepEqual(report.summary, {
    approved_pages: 2,
    primary_footers_removed: 1,
    witness_footers_removed: 2,
    numeric_exact_before: 1,
    numeric_exact_after: 2,
    title_exact_before: 2,
    title_exact_after: 2,
    mean_character_agreement_before: 0.928571,
    mean_character_agreement_after: 1,
    character_agreement_improved_pages: 1,
  });
});

test('writes a deterministic preview outside evidence roots', async () => {
  const value = await fixture();
  await writeOcrPageFurnitureImpactPreview({
    ledgerPath: value.ledgerPath,
    documentId: value.documentId,
    primaryRoot: value.primaryRoot,
    witnessRoot: value.witnessRoot,
    outputPath: value.outputPath,
  });
  const first = await readFile(value.outputPath, 'utf8');
  await writeOcrPageFurnitureImpactPreview({
    ledgerPath: value.ledgerPath,
    documentId: value.documentId,
    primaryRoot: value.primaryRoot,
    witnessRoot: value.witnessRoot,
    outputPath: value.outputPath,
  });
  assert.equal(await readFile(value.outputPath, 'utf8'), first);
  await assert.rejects(
    writeOcrPageFurnitureImpactPreview({
      ledgerPath: value.ledgerPath,
      documentId: value.documentId,
      primaryRoot: value.primaryRoot,
      witnessRoot: value.witnessRoot,
      outputPath: path.join(value.witnessRoot, 'impact.json'),
    }),
    /output must be outside/,
  );
});
