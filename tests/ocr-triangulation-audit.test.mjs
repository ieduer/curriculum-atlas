import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildOcrTriangulationAudit,
  validateOcrPageFurnitureActivation,
  writeOcrTriangulationAudit,
} from '../scripts/build-ocr-triangulation-audit.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const SOURCE_BYTES = Buffer.from('%PDF-1.7\nfixture source PDF bytes');
const SOURCE_SHA = sha256(SOURCE_BYTES);

async function fixture({ withDecision = false, decisionPatch = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ocr-triangulation-'));
  const documentId = 'doc-a';
  const sourcePdfPath = path.join(root, 'source.pdf');
  const primaryRoot = path.join(root, 'primary');
  const witnessRoot = path.join(root, 'witness');
  const visionRoot = path.join(witnessRoot, documentId, 'vision');
  const imageRoot = path.join(witnessRoot, documentId, 'images');
  await mkdir(path.join(primaryRoot, '0001'), { recursive: true });
  await mkdir(path.join(primaryRoot, '0002'), { recursive: true });
  await mkdir(visionRoot, { recursive: true });
  await mkdir(imageRoot, { recursive: true });
  await writeFile(sourcePdfPath, SOURCE_BYTES);

  const primary = '# 第一章\n正文甲42\n';
  const witnessText = '第一章\n正文乙42\n1';
  const image = Buffer.from('page-image-1');
  const image2 = Buffer.from('page-image-2');
  const imageSha = sha256(image);
  const image2Sha = sha256(image2);
  await writeFile(path.join(primaryRoot, '0001', 'content.md'), primary);
  await writeFile(path.join(primaryRoot, '0002', 'content.md'), '# 第二章\n正文丙\n');
  await writeFile(path.join(imageRoot, 'page-001.png'), image);
  await writeFile(path.join(imageRoot, 'page-002.png'), image2);
  const sidecar = {
    schema_version: 3,
    file: 'page-001.png',
    document_id: documentId,
    physical_pdf_page: 1,
    source_pdf_sha256: SOURCE_SHA,
    rendered_image_sha256: imageSha,
    lines: [
      { text: '第一章', confidence: 1 },
      { text: '正文乙42', confidence: 1 },
      { text: '1', confidence: 1 },
    ],
    critical_fields: [
      { primary: '第一章', witness: '第一章' },
      { primary: '42', witness: '42' },
    ],
  };
  const sidecarRaw = `${JSON.stringify(sidecar, null, 2)}\n`;
  const sidecarPath = path.join(visionRoot, 'page-001.json');
  await writeFile(sidecarPath, sidecarRaw);
  const sidecar2 = {
    ...sidecar,
    file: 'page-002.png',
    physical_pdf_page: 2,
    rendered_image_sha256: image2Sha,
    lines: [
      { text: '第二章', confidence: 1 },
      { text: '正文丙', confidence: 1 },
      { text: '2', confidence: 1 },
    ],
    critical_fields: [{ primary: '第二章', witness: '第二章' }],
  };
  const sidecar2Raw = `${JSON.stringify(sidecar2, null, 2)}\n`;
  await writeFile(path.join(visionRoot, 'page-002.json'), sidecar2Raw);
  const snapshotSha = sha256([
    `${documentId}/vision/page-001.json\0${sha256(sidecarRaw)}`,
    `${documentId}/vision/page-002.json\0${sha256(sidecar2Raw)}`,
  ].join('\n'));

  const approval = {
    schema_version: 1,
    artifact_profile: 'ocr-page-furniture-approval-ledger-v1',
    activation_status: 'approved_not_activated',
    policy: {
      raw_witness_mutation: 'forbidden',
      audit_filter_activation: 'requires_explicit_consumer_and_final_witness_snapshot_match',
      publication_effect: 'none',
    },
    documents: [{
      document_id: documentId,
      source_pdf_sha256: SOURCE_SHA,
      page_count: 2,
      sidecar_snapshot_sha256: snapshotSha,
      review_status: 'manually_approved_unactivated',
      header_rules: [],
      footer_rules: [{
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
            rendered_image_sha256: imageSha,
          },
          {
            physical_page: 2,
            printed_page: 2,
            rendered_image_sha256: image2Sha,
          },
        ],
      }],
    }],
  };
  const approvalRaw = `${JSON.stringify(approval, null, 2)}\n`;
  const approvalPath = path.join(root, 'approval.json');
  await writeFile(approvalPath, approvalRaw);
  const activation = {
    schema_version: 1,
    artifact_profile: 'ocr-page-furniture-activation-v1',
    activation_scope: 'audit_comparison_only',
    approval_ledger_sha256: sha256(approvalRaw),
    policy: {
      raw_witness_mutation: 'forbidden',
      raw_primary_mutation: 'forbidden',
      gate_relaxation: 'forbidden',
      publication_effect: 'none',
    },
    documents: [{
      document_id: documentId,
      source_pdf_sha256: SOURCE_SHA,
      sidecar_snapshot_sha256: snapshotSha,
      activated_rule_ids: ['doc-a-footer-1-2'],
      reviewed_by: 'fixture reviewer',
      reviewed_at: '2026-07-18T00:00:00Z',
    }],
  };
  const activationPath = path.join(root, 'activation.json');
  await writeFile(activationPath, `${JSON.stringify(activation, null, 2)}\n`);

  const acceptedText = '第一章\n正文甲42\n';
  await mkdir(path.join(root, 'online'), { recursive: true });
  const onlineText = '第一章\n正文甲42\n';
  await writeFile(path.join(root, 'online', 'official-doc-a.txt'), onlineText);
  const decisions = {
    schema_version: 1,
    artifact_profile: 'ocr-page-triangulation-decisions-v1',
    policy: {
      scan_is_primary: true,
      raw_ocr_mutation: 'forbidden',
      search_snippet_as_evidence: 'forbidden',
      whole_document_sampling_promotion: 'forbidden',
    },
    decisions: withDecision ? [{
      decision_id: 'decision-doc-a-p1',
      document_id: documentId,
      physical_page: 1,
      decision_scope: 'whole_page',
      source_pdf_sha256: SOURCE_SHA,
      rendered_image_sha256: imageSha,
      primary_ocr_sha256: sha256(primary),
      vision_text_sha256: sha256(witnessText),
      accepted_text: acceptedText,
      accepted_text_sha256: sha256(acceptedText),
      document_identity: {
        title: 'Doc A',
        issuing_body_or_author: 'Official publisher',
        year_or_publication_context: '2026',
        version_label: 'Exact edition',
        section_or_item_locator: '第一章',
      },
      edition_match_status: 'exact_document_exact_edition',
      verification_status: 'verified_exact',
      online_evidence: [{
        source_id: 'official-exact-doc-a',
        publisher: 'Official publisher',
        source_type: 'official_archive',
        authority_class: 'official',
        source_url: 'https://example.edu/doc-a',
        retrieved_at: '2026-07-18T00:00:00Z',
        version_match: 'exact_document_exact_edition',
        artifact_relation: 'independent_transcription',
        independent_for_decision: true,
        section_locator: '第一章',
        content_path: 'online/official-doc-a.txt',
        content_sha256: sha256(onlineText),
      }],
      human_review: {
        reviewed_by: 'fixture reviewer',
        reviewed_at: '2026-07-18T00:00:00Z',
        scan_checked: true,
        all_engine_conflicts_resolved: true,
        critical_fields_checked: true,
        table_cells_checked: false,
        resolution: 'Image and exact-edition text resolve 乙 to 甲.',
        uncertainty_note: null,
      },
      citation_allowed: true,
      ...decisionPatch,
    }] : [],
  };
  const decisionsPath = path.join(root, 'decisions.json');
  await writeFile(decisionsPath, `${JSON.stringify(decisions, null, 2)}\n`);

  return {
    root,
    documentId,
    primaryRoot,
    witnessRoot,
    sourcePdfPath,
    approvalPath,
    activationPath,
    decisionsPath,
    primary,
    witnessText,
    imageSha,
    outputPath: path.join(root, 'out', 'audit.json'),
  };
}

test('applies only explicitly activated source-bound page furniture to comparison metrics', async () => {
  const value = await fixture();
  const report = await buildOcrTriangulationAudit({
    documentId: value.documentId,
    primaryRoot: value.primaryRoot,
    witnessRoot: value.witnessRoot,
    sourcePdfPath: value.sourcePdfPath,
    approvalLedgerPath: value.approvalPath,
    activationLedgerPath: value.activationPath,
    decisionsPath: value.decisionsPath,
    start: 1,
    end: 1,
  });
  assert.equal(report.schema_version, 2);
  assert.equal(report.pages[0].furniture.rule_id, 'doc-a-footer-1-2');
  assert.equal(report.pages[0].furniture.witness_footer_removed, true);
  assert.equal(report.pages[0].raw.witness_text_sha256, sha256(value.witnessText));
  assert.equal(report.pages[0].comparison.witness_numbers.includes('1'), false);
  assert.equal(report.pages[0].release.verification_status, 'unresolved_fail_closed');
  assert.equal(report.pages[0].release.citation_allowed, false);
});

test('committed activation stays byte-bound to the manually approved ledger', async () => {
  const root = new URL('../', import.meta.url);
  const approvalRaw = await readFile(new URL('data/ocr-page-furniture-approvals.json', root), 'utf8');
  const activation = JSON.parse(
    await readFile(new URL('data/ocr-page-furniture-activation.json', root), 'utf8'),
  );
  const rules = validateOcrPageFurnitureActivation(
    activation,
    approvalRaw,
    JSON.parse(approvalRaw),
  );
  assert.equal(rules.size, 8);
  assert.equal(
    [...rules.values()].reduce((total, rule) => total + rule.page_count, 0),
    99,
  );
});

test('a whole-page exact-edition human decision may close only its hash-bound page', async () => {
  const value = await fixture({ withDecision: true });
  const report = await buildOcrTriangulationAudit({
    documentId: value.documentId,
    primaryRoot: value.primaryRoot,
    witnessRoot: value.witnessRoot,
    sourcePdfPath: value.sourcePdfPath,
    approvalLedgerPath: value.approvalPath,
    activationLedgerPath: value.activationPath,
    decisionsPath: value.decisionsPath,
    start: 1,
    end: 1,
  });
  assert.deepEqual(report.summary, {
    pages: 1,
    automatic_witness_pass: 0,
    manual_image_review_required: 0,
    blank_page_visual_confirmation_required: 0,
    unresolved_fail_closed: 1,
    verified_exact_human_triangulation: 1,
    citation_allowed: 1,
  });
  assert.equal(report.pages[0].release.verification_status, 'verified_exact');
  assert.equal(report.pages[0].release.release_gate, 'verified_exact_human_triangulation');
  assert.equal(report.pages[0].release.citation_allowed, true);
  assert.equal(report.pages[0].release.accepted_text_sha256, sha256('第一章\n正文甲42\n'));
  assert.equal(report.pages[0].raw.primary_ocr_sha256, sha256(value.primary));
});

test('stable-fact or different-edition evidence never promotes a whole page', async () => {
  const value = await fixture({
    withDecision: true,
    decisionPatch: {
      decision_scope: 'stable_fact',
      edition_match_status: 'stable_fact_only',
      verification_status: 'verified_stable_fact_only',
      citation_allowed: false,
    },
  });
  const report = await buildOcrTriangulationAudit({
    documentId: value.documentId,
    primaryRoot: value.primaryRoot,
    witnessRoot: value.witnessRoot,
    sourcePdfPath: value.sourcePdfPath,
    approvalLedgerPath: value.approvalPath,
    activationLedgerPath: value.activationPath,
    decisionsPath: value.decisionsPath,
    start: 1,
    end: 1,
  });
  assert.equal(report.pages[0].release.verification_status, 'unresolved_fail_closed');
  assert.equal(report.pages[0].release.citation_allowed, false);
  assert.equal(report.pages[0].scoped_decisions[0].verification_status, 'verified_stable_fact_only');
});

test('fails closed on approval, image, decision, or output identity drift', async (t) => {
  await t.test('source PDF bytes', async () => {
    const value = await fixture();
    await writeFile(value.sourcePdfPath, '%PDF-1.7\ndrifted source PDF bytes');
    await assert.rejects(buildOcrTriangulationAudit({
      documentId: value.documentId,
      primaryRoot: value.primaryRoot,
      witnessRoot: value.witnessRoot,
      sourcePdfPath: value.sourcePdfPath,
      approvalLedgerPath: value.approvalPath,
      activationLedgerPath: value.activationPath,
      decisionsPath: value.decisionsPath,
      start: 1,
      end: 1,
    }), /source PDF bytes drifted/);
  });

  await t.test('approval bytes', async () => {
    const value = await fixture();
    const activation = JSON.parse(await readFile(value.activationPath, 'utf8'));
    activation.approval_ledger_sha256 = 'f'.repeat(64);
    await writeFile(value.activationPath, `${JSON.stringify(activation, null, 2)}\n`);
    await assert.rejects(buildOcrTriangulationAudit({
      documentId: value.documentId,
      primaryRoot: value.primaryRoot,
    witnessRoot: value.witnessRoot,
    sourcePdfPath: value.sourcePdfPath,
    approvalLedgerPath: value.approvalPath,
      activationLedgerPath: value.activationPath,
      decisionsPath: value.decisionsPath,
      start: 1,
      end: 1,
    }), /approval ledger SHA-256 drifted/);
  });

  await t.test('decision witness binding', async () => {
    const value = await fixture({ withDecision: true });
    const decisions = JSON.parse(await readFile(value.decisionsPath, 'utf8'));
    decisions.decisions[0].vision_text_sha256 = 'f'.repeat(64);
    await writeFile(value.decisionsPath, `${JSON.stringify(decisions, null, 2)}\n`);
    await assert.rejects(buildOcrTriangulationAudit({
      documentId: value.documentId,
      primaryRoot: value.primaryRoot,
    witnessRoot: value.witnessRoot,
    sourcePdfPath: value.sourcePdfPath,
    approvalLedgerPath: value.approvalPath,
      activationLedgerPath: value.activationPath,
      decisionsPath: value.decisionsPath,
      start: 1,
      end: 1,
    }), /vision text SHA-256 drifted/);
  });

  await t.test('online evidence snapshot binding', async () => {
    const value = await fixture({ withDecision: true });
    await writeFile(path.join(value.root, 'online', 'official-doc-a.txt'), 'drifted online text');
    await assert.rejects(buildOcrTriangulationAudit({
      documentId: value.documentId,
      primaryRoot: value.primaryRoot,
    witnessRoot: value.witnessRoot,
    sourcePdfPath: value.sourcePdfPath,
    approvalLedgerPath: value.approvalPath,
      activationLedgerPath: value.activationPath,
      decisionsPath: value.decisionsPath,
      start: 1,
      end: 1,
    }), /online evidence content SHA-256 drifted/);
  });

  await t.test('same-artifact online mirror independence', async () => {
    const value = await fixture({ withDecision: true });
    const decisions = JSON.parse(await readFile(value.decisionsPath, 'utf8'));
    decisions.decisions[0].online_evidence[0].artifact_relation = 'same_artifact_mirror';
    decisions.decisions[0].online_evidence[0].independent_for_decision = false;
    await writeFile(value.decisionsPath, `${JSON.stringify(decisions, null, 2)}\n`);
    await assert.rejects(buildOcrTriangulationAudit({
      documentId: value.documentId,
      primaryRoot: value.primaryRoot,
    witnessRoot: value.witnessRoot,
    sourcePdfPath: value.sourcePdfPath,
    approvalLedgerPath: value.approvalPath,
      activationLedgerPath: value.activationPath,
      decisionsPath: value.decisionsPath,
      start: 1,
      end: 1,
    }), /independent exact-edition online transcription/);
  });

  await t.test('citation entitlement requirements', async () => {
    const value = await fixture({
      withDecision: true,
      decisionPatch: {
        human_review: {
          reviewed_by: 'fixture reviewer',
          reviewed_at: '2026-07-18T00:00:00Z',
          scan_checked: false,
          all_engine_conflicts_resolved: true,
          critical_fields_checked: true,
          table_cells_checked: false,
          resolution: 'Not actually checked.',
          uncertainty_note: null,
        },
      },
    });
    await assert.rejects(buildOcrTriangulationAudit({
      documentId: value.documentId,
      primaryRoot: value.primaryRoot,
    witnessRoot: value.witnessRoot,
    sourcePdfPath: value.sourcePdfPath,
    approvalLedgerPath: value.approvalPath,
      activationLedgerPath: value.activationPath,
      decisionsPath: value.decisionsPath,
      start: 1,
      end: 1,
    }), /citation decision requires scan_checked=true/);
  });

  await t.test('output inside evidence roots', async () => {
    const value = await fixture();
    await assert.rejects(writeOcrTriangulationAudit({
      documentId: value.documentId,
      primaryRoot: value.primaryRoot,
    witnessRoot: value.witnessRoot,
    sourcePdfPath: value.sourcePdfPath,
    approvalLedgerPath: value.approvalPath,
      activationLedgerPath: value.activationPath,
      decisionsPath: value.decisionsPath,
      outputPath: path.join(value.witnessRoot, 'audit.json'),
      start: 1,
      end: 1,
    }), /output must be outside/);
  });

  await t.test('output replacing its decision ledger', async () => {
    const value = await fixture();
    await assert.rejects(writeOcrTriangulationAudit({
      documentId: value.documentId,
      primaryRoot: value.primaryRoot,
    witnessRoot: value.witnessRoot,
    sourcePdfPath: value.sourcePdfPath,
    approvalLedgerPath: value.approvalPath,
      activationLedgerPath: value.activationPath,
      decisionsPath: value.decisionsPath,
      outputPath: value.decisionsPath,
      start: 1,
      end: 1,
    }), /output must not replace an input ledger/);
  });
});
