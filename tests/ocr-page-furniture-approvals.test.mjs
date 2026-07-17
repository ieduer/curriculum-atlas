import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  parseOcrPageFurnitureApprovalArgs,
  validateOcrPageFurnitureApprovals,
} from '../scripts/validate-ocr-page-furniture-approvals.mjs';

const SOURCE_SHA = 'a'.repeat(64);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ocr-page-furniture-approval-'));
  const witnessRoot = path.join(root, 'witness');
  const documentId = 'doc-a';
  const visionRoot = path.join(witnessRoot, documentId, 'vision');
  const imageRoot = path.join(witnessRoot, documentId, 'images');
  await mkdir(visionRoot, { recursive: true });
  await mkdir(imageRoot, { recursive: true });
  const pageRecords = [];
  const imageHashes = new Map();
  for (let page = 1; page <= 4; page += 1) {
    const key = String(page).padStart(3, '0');
    const image = Buffer.from(`image-${page}`);
    const imageSha = sha256(image);
    imageHashes.set(page, imageSha);
    await writeFile(path.join(imageRoot, `page-${key}.png`), image);
    const printedPage = page <= 2 ? page : page + 7;
    const sidecar = {
      schema_version: 3,
      file: `page-${key}.png`,
      document_id: documentId,
      physical_pdf_page: page,
      source_pdf_sha256: SOURCE_SHA,
      rendered_image_sha256: imageSha,
      lines: [
        { text: 'Body', confidence: 1 },
        { text: String(printedPage), confidence: 1 }
      ]
    };
    const raw = `${JSON.stringify(sidecar, null, 2)}\n`;
    await writeFile(path.join(visionRoot, `page-${key}.json`), raw);
    pageRecords.push(`${documentId}/vision/page-${key}.json\0${sha256(raw)}`);
  }
  const ledger = {
    schema_version: 1,
    artifact_profile: 'ocr-page-furniture-approval-ledger-v1',
    activation_status: 'approved_not_activated',
    policy: {
      raw_witness_mutation: 'forbidden',
      audit_filter_activation: 'requires_explicit_consumer_and_final_witness_snapshot_match',
      publication_effect: 'none'
    },
    documents: [
      {
        document_id: documentId,
        source_pdf_sha256: SOURCE_SHA,
        page_count: 4,
        sidecar_snapshot_sha256: sha256(pageRecords.join('\n')),
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
                rendered_image_sha256: imageHashes.get(1)
              },
              {
                physical_page: 2,
                printed_page: 2,
                rendered_image_sha256: imageHashes.get(2)
              }
            ]
          },
          {
            rule_id: 'doc-a-footer-3-4',
            candidate_type: 'printed_page_number_footer',
            start_page: 3,
            end_page: 4,
            page_count: 2,
            physical_to_printed_offset: 7,
            printed_page_start: 10,
            printed_page_end: 11,
            observed_last_line_must_equal_printed_page: true,
            removal_scope: 'audit_comparison_only',
            review_method: 'manual_source_image_stratified',
            approval_status: 'approved_not_activated',
            eligible_for_audit_filter: true,
            activated: false,
            examples: [
              {
                physical_page: 3,
                printed_page: 10,
                rendered_image_sha256: imageHashes.get(3)
              },
              {
                physical_page: 4,
                printed_page: 11,
                rendered_image_sha256: imageHashes.get(4)
              }
            ]
          }
        ]
      }
    ]
  };
  return { ledger, witnessRoot, visionRoot };
}

test('validates an exact-source, exact-snapshot, image-bound unactivated approval ledger', async () => {
  const value = await fixture();
  assert.deepEqual(
    await validateOcrPageFurnitureApprovals(value.ledger, {
      witnessRoot: value.witnessRoot
    }),
    {
      schema_version: 1,
      activation_status: 'approved_not_activated',
      documents: 1,
      footer_rules: 2,
      approved_footer_pages: 4,
      header_rules: 0,
      witness_bound: true
    }
  );
});

test('fails closed when witness bytes drift after approval', async () => {
  const value = await fixture();
  const target = path.join(value.visionRoot, 'page-003.json');
  const sidecar = JSON.parse(await readFile(target, 'utf8'));
  sidecar.lines.at(-1).text = '999';
  await writeFile(target, `${JSON.stringify(sidecar, null, 2)}\n`);
  await assert.rejects(
    validateOcrPageFurnitureApprovals(value.ledger, {
      witnessRoot: value.witnessRoot
    }),
    /sidecar snapshot drifted/
  );
});

test('fails closed on activation, header rules, overlap, or weak image sampling', async (t) => {
  await t.test('activation', async () => {
    const value = await fixture();
    value.ledger.activation_status = 'active';
    await assert.rejects(
      validateOcrPageFurnitureApprovals(value.ledger),
      /must remain approved_not_activated/
    );
  });

  await t.test('header rules', async () => {
    const value = await fixture();
    value.ledger.documents[0].header_rules.push({ text: 'Running header' });
    await assert.rejects(
      validateOcrPageFurnitureApprovals(value.ledger),
      /header_rules must remain empty/
    );
  });

  await t.test('overlap', async () => {
    const value = await fixture();
    value.ledger.documents[0].footer_rules[1].start_page = 2;
    await assert.rejects(
      validateOcrPageFurnitureApprovals(value.ledger),
      /overlaps or is not sorted/
    );
  });

  await t.test('weak sampling', async () => {
    const value = await fixture();
    value.ledger.documents[0].footer_rules[0].examples.pop();
    await assert.rejects(
      validateOcrPageFurnitureApprovals(value.ledger),
      /requires at least 2 stratified image examples/
    );
  });
});

test('CLI requires a ledger and accepts an optional witness root', () => {
  assert.deepEqual(
    parseOcrPageFurnitureApprovalArgs([
      '--ledger',
      'data/ledger.json',
      '--witness-root',
      '.cache/witness'
    ]),
    {
      ledgerPath: 'data/ledger.json',
      witnessRoot: '.cache/witness'
    }
  );
  assert.throws(
    () => parseOcrPageFurnitureApprovalArgs([]),
    /--ledger is required/
  );
});
