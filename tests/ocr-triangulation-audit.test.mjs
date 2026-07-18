import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildOcrTriangulationAudit,
  derivePdfPageImageSequence,
  validateOcrPageFurnitureActivation,
  writeOcrTriangulationAudit,
} from '../scripts/build-ocr-triangulation-audit.mjs';
import { validateOcrPageFurnitureApprovals } from '../scripts/validate-ocr-page-furniture-approvals.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function onePagePdf(label) {
  const escaped = label.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${escaped}) Tj\nET\n`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

const SOURCE_BYTES = onePagePdf('Source artifact');
const SOURCE_SHA = sha256(SOURCE_BYTES);
const ONLINE_ARTIFACT_BYTES = onePagePdf('Independent online artifact');
const ONLINE_ARTIFACT_SHA = sha256(ONLINE_ARTIFACT_BYTES);
const sequenceCache = new Map();

async function pageSequence(bytes, label) {
  const key = sha256(bytes);
  if (!sequenceCache.has(key)) {
    sequenceCache.set(key, derivePdfPageImageSequence(bytes, label));
  }
  return sequenceCache.get(key);
}

const sourceIdentitySha256 = (source) => sha256(JSON.stringify({
  source_id: source.source_id,
  publisher: source.publisher,
  source_type: source.source_type,
  authority_class: source.authority_class,
  authority_record_id: source.authority_record_id,
  allowed_hosts: source.allowed_hosts,
  allowed_url_prefixes: source.allowed_url_prefixes,
  document_binding: {
    document_id: source.document_binding.document_id,
    title: source.document_binding.title,
    issuing_body_or_author: source.document_binding.issuing_body_or_author,
    year_or_publication_context: source.document_binding.year_or_publication_context,
    version_label: source.document_binding.version_label,
    source_pdf_sha256: source.document_binding.source_pdf_sha256,
  },
  artifact_binding: {
    artifact_id: source.artifact_binding.artifact_id,
    media_type: source.artifact_binding.media_type,
    artifact_sha256: source.artifact_binding.artifact_sha256,
    exact_artifact_urls: source.artifact_binding.exact_artifact_urls,
  },
}));

const scopedBindingSha256 = (kind, id, decision) => sha256([
  kind,
  id,
  decision.document_id,
  String(decision.physical_page),
  decision.document_identity.section_or_item_locator,
  decision.accepted_text_sha256,
].join('\0'));

const pageTypeBindingSha256 = ({ primarySha, acceptedSha, imageSha, pageType, manifestSha = null }) => (
  sha256([primarySha, acceptedSha, imageSha, pageType, manifestSha || ''].join('\0'))
);

function tableCellManifest(sourceFormat, matrix) {
  const cells = matrix.flatMap((row, rowIndex) => row.map((text, columnIndex) => ({
    cell_id: `cell-${rowIndex + 1}-${columnIndex + 1}`,
    row: rowIndex + 1,
    column: columnIndex + 1,
    text,
    text_sha256: sha256(text),
  })));
  const manifest = {
    schema_version: 1,
    source_format: sourceFormat,
    row_count: matrix.length,
    column_count: matrix[0].length,
    cells,
  };
  manifest.manifest_sha256 = sha256(JSON.stringify(manifest));
  return manifest;
}

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
  const onlineArtifactPath = path.join(root, 'online', 'official-doc-a.pdf');
  await writeFile(onlineArtifactPath, ONLINE_ARTIFACT_BYTES);
  const registrySource = {
    source_id: 'official-exact-doc-a',
    publisher: 'Official publisher',
    source_type: 'official_archive',
    authority_class: 'official',
    authority_record_id: 'fixture-official-publisher',
    allowed_hosts: ['example.edu'],
    allowed_url_prefixes: ['https://example.edu/'],
    document_binding: {
      document_id: documentId,
      title: 'Doc A',
      issuing_body_or_author: 'Official publisher',
      year_or_publication_context: '2026',
      version_label: 'Exact edition',
      source_pdf_sha256: SOURCE_SHA,
    },
    artifact_binding: {
      artifact_id: 'official-doc-a-pdf',
      media_type: 'application/pdf',
      artifact_sha256: ONLINE_ARTIFACT_SHA,
      exact_artifact_urls: ['https://example.edu/doc-a'],
    },
  };
  registrySource.source_identity_sha256 = sourceIdentitySha256(registrySource);
  const onlineSourceRegistry = {
    schema_version: 1,
    artifact_profile: 'ocr-online-source-registry-v1',
    policy: {
      authority_declared_only_here: true,
      https_only: true,
      exact_hostname_match: true,
      document_version_artifact_binding_required: true,
      exact_artifact_url_required: true,
      page_image_recomputation_required: true,
    },
    sources: [registrySource],
  };
  const onlineSourceRegistryRaw = `${JSON.stringify(onlineSourceRegistry, null, 2)}\n`;
  const onlineSourceRegistryPath = path.join(root, 'online-source-registry.json');
  await writeFile(onlineSourceRegistryPath, onlineSourceRegistryRaw);
  let artifactReceiptReference = null;
  if (withDecision) {
    const [sourceSequence, onlineSequence] = await Promise.all([
      pageSequence(SOURCE_BYTES, 'fixture source PDF'),
      pageSequence(ONLINE_ARTIFACT_BYTES, 'fixture online PDF'),
    ]);
    const artifactReceipt = {
      schema_version: 1,
      artifact_profile: 'ocr-online-artifact-identity-receipt-v1',
      source_identity_sha256: registrySource.source_identity_sha256,
      artifact_id: registrySource.artifact_binding.artifact_id,
      source_pdf_sha256: SOURCE_SHA,
      evidence_snapshot_sha256: sha256(onlineText),
      online_artifact_path: 'online/official-doc-a.pdf',
      online_artifact_sha256: ONLINE_ARTIFACT_SHA,
      render_profile: sourceSequence.render_profile,
      source_page_image_sha256: sourceSequence.page_image_sha256,
      online_page_image_sha256: onlineSequence.page_image_sha256,
      source_page_asset_sequence_sha256: sourceSequence.sequence_sha256,
      source_page_asset_count: sourceSequence.page_count,
      online_page_asset_sequence_sha256: onlineSequence.sequence_sha256,
      online_page_asset_count: onlineSequence.page_count,
      identity_result: 'different_page_asset_sequence',
    };
    const artifactReceiptRaw = `${JSON.stringify(artifactReceipt, null, 2)}\n`;
    await writeFile(path.join(root, 'online', 'official-doc-a-artifact.json'), artifactReceiptRaw);
    artifactReceiptReference = {
      receipt_path: 'online/official-doc-a-artifact.json',
      receipt_sha256: sha256(artifactReceiptRaw),
    };
  }
  const decisions = {
    schema_version: 1,
    artifact_profile: 'ocr-page-triangulation-decisions-v1',
    policy: {
      scan_is_primary: true,
      raw_ocr_mutation: 'forbidden',
      search_snippet_as_evidence: 'forbidden',
      whole_document_sampling_promotion: 'forbidden',
      online_source_registry_sha256: sha256(onlineSourceRegistryRaw),
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
      page_type: 'prose',
      page_type_binding_sha256: pageTypeBindingSha256({
        primarySha: sha256(primary),
        acceptedSha: sha256(acceptedText),
        imageSha,
        pageType: 'prose',
      }),
      table_cell_manifest: null,
      embedded_item_id: null,
      embedded_item_binding_sha256: null,
      stable_fact_id: null,
      stable_fact_binding_sha256: null,
      stable_fact_span_id: null,
      stable_fact_span_binding_sha256: null,
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
        source_identity_sha256: registrySource.source_identity_sha256,
        source_url: 'https://example.edu/doc-a',
        retrieved_at: '2026-07-18T00:00:00Z',
        version_match: 'exact_document_exact_edition',
        artifact_relation: 'different_artifact_same_edition',
        independent_for_decision: true,
        section_locator: '第一章',
        content_path: 'online/official-doc-a.txt',
        content_sha256: sha256(onlineText),
        snapshot_identity: {
          scope: 'whole_page',
          locator_id: 'doc-a-page-1',
          text_sha256: sha256(onlineText),
        },
        accepted_text_relation: 'normalized_exact',
        conflict_resolution: null,
        artifact_identity_receipt: artifactReceiptReference,
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
    onlineSourceRegistryPath,
    onlineArtifactPath,
    primary,
    witnessText,
    imageSha,
    outputPath: path.join(root, 'out', 'audit.json'),
  };
}

async function mutateDecision(value, mutator) {
  const ledger = JSON.parse(await readFile(value.decisionsPath, 'utf8'));
  await mutator(ledger.decisions[0], ledger);
  await writeFile(value.decisionsPath, `${JSON.stringify(ledger, null, 2)}\n`);
  return ledger;
}

async function mutateArtifactReceipt(value, mutator) {
  const receiptPath = path.join(value.root, 'online', 'official-doc-a-artifact.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  await mutator(receipt);
  const raw = `${JSON.stringify(receipt, null, 2)}\n`;
  await writeFile(receiptPath, raw);
  await mutateDecision(value, (decision) => {
    decision.online_evidence[0].artifact_identity_receipt.receipt_sha256 = sha256(raw);
  });
  return receipt;
}

async function mutateOnlineSourceRegistry(value, mutator) {
  const registry = JSON.parse(await readFile(value.onlineSourceRegistryPath, 'utf8'));
  await mutator(registry.sources[0], registry);
  registry.sources[0].source_identity_sha256 = sourceIdentitySha256(registry.sources[0]);
  const raw = `${JSON.stringify(registry, null, 2)}\n`;
  await writeFile(value.onlineSourceRegistryPath, raw);
  await mutateDecision(value, (decision, ledger) => {
    ledger.policy.online_source_registry_sha256 = sha256(raw);
    decision.online_evidence[0].source_identity_sha256 = registry.sources[0].source_identity_sha256;
  });
  return registry.sources[0];
}

function auditOptions(value, overrides = {}) {
  return {
    documentId: value.documentId,
    primaryRoot: value.primaryRoot,
    witnessRoot: value.witnessRoot,
    sourcePdfPath: value.sourcePdfPath,
    approvalLedgerPath: value.approvalPath,
    activationLedgerPath: value.activationPath,
    decisionsPath: value.decisionsPath,
    onlineSourceRegistryPath: value.onlineSourceRegistryPath,
    start: 1,
    end: 1,
    ...overrides,
  };
}

async function bindAcceptedSnapshot(value, acceptedText, { pageType = 'prose', manifestSha = null } = {}) {
  await writeFile(path.join(value.primaryRoot, '0001', 'content.md'), acceptedText);
  await writeFile(path.join(value.root, 'online', 'official-doc-a.txt'), acceptedText);
  await mutateDecision(value, (decision) => {
    decision.primary_ocr_sha256 = sha256(acceptedText);
    decision.accepted_text = acceptedText;
    decision.accepted_text_sha256 = sha256(acceptedText);
    decision.page_type = pageType;
    decision.page_type_binding_sha256 = pageTypeBindingSha256({
      primarySha: sha256(acceptedText),
      acceptedSha: sha256(acceptedText),
      imageSha: value.imageSha,
      pageType,
      manifestSha,
    });
    decision.online_evidence[0].content_sha256 = sha256(acceptedText);
    decision.online_evidence[0].snapshot_identity.text_sha256 = sha256(acceptedText);
  });
  await mutateArtifactReceipt(value, (receipt) => {
    receipt.evidence_snapshot_sha256 = sha256(acceptedText);
  });
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
    onlineSourceRegistryPath: value.onlineSourceRegistryPath,
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
    onlineSourceRegistryPath: value.onlineSourceRegistryPath,
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
      stable_fact_id: 'fact-doc-a-author',
      stable_fact_span_id: 'span-doc-a-p1-author',
      edition_match_status: 'stable_fact_only',
      verification_status: 'verified_stable_fact_only',
      citation_allowed: false,
    },
  });
  await mutateDecision(value, (decision) => {
    decision.stable_fact_binding_sha256 = scopedBindingSha256(
      'stable_fact',
      decision.stable_fact_id,
      decision,
    );
    decision.stable_fact_span_binding_sha256 = scopedBindingSha256(
      'stable_fact_span',
      decision.stable_fact_span_id,
      decision,
    );
    decision.online_evidence[0].snapshot_identity.scope = 'stable_fact_excerpt';
    decision.online_evidence[0].snapshot_identity.locator_id = decision.stable_fact_span_id;
  });
  const report = await buildOcrTriangulationAudit({
    documentId: value.documentId,
    primaryRoot: value.primaryRoot,
    witnessRoot: value.witnessRoot,
    sourcePdfPath: value.sourcePdfPath,
    approvalLedgerPath: value.approvalPath,
    activationLedgerPath: value.activationPath,
    decisionsPath: value.decisionsPath,
    onlineSourceRegistryPath: value.onlineSourceRegistryPath,
    start: 1,
    end: 1,
  });
  assert.equal(report.pages[0].release.verification_status, 'unresolved_fail_closed');
  assert.equal(report.pages[0].release.citation_allowed, false);
  assert.equal(report.pages[0].scoped_decisions[0].verification_status, 'verified_stable_fact_only');
});

test('online authority is controlled by a separately hash-bound source registry', async (t) => {
  await t.test('registry is mandatory for online evidence', async () => {
    const value = await fixture({ withDecision: true });
    await assert.rejects(buildOcrTriangulationAudit(auditOptions(value, {
      onlineSourceRegistryPath: undefined,
    })), /online source registry.*required/i);
  });

  await t.test('decision evidence cannot self-declare authority', async () => {
    for (const [field, declaration] of [
      ['authority_class', 'official'],
      ['authority_record_id', 'self-declared-record'],
      ['allowed_url_prefixes', ['https://example.edu/']],
    ]) {
      const value = await fixture({ withDecision: true });
      await mutateDecision(value, (decision) => {
        decision.online_evidence[0][field] = declaration;
      });
      await assert.rejects(
        buildOcrTriangulationAudit(auditOptions(value)),
        /must not declare.*authority/i,
        field,
      );
    }
  });

  await t.test('registry bytes and source identity are both pinned', async () => {
    const value = await fixture({ withDecision: true });
    const registry = JSON.parse(await readFile(value.onlineSourceRegistryPath, 'utf8'));
    registry.sources[0].publisher = 'Drifted publisher';
    registry.sources[0].source_identity_sha256 = sourceIdentitySha256(registry.sources[0]);
    await writeFile(value.onlineSourceRegistryPath, `${JSON.stringify(registry, null, 2)}\n`);
    await assert.rejects(buildOcrTriangulationAudit(auditOptions(value)), /online source registry SHA-256 drifted/);
  });

  await t.test('URL hostname must be allowed by the registry source identity', async () => {
    const value = await fixture({ withDecision: true });
    await mutateDecision(value, (decision) => {
      decision.online_evidence[0].source_url = 'https://attacker.example/doc-a';
    });
    await assert.rejects(buildOcrTriangulationAudit(auditOptions(value)), /hostname is not allowed/);
  });

  await t.test('URL path must stay under a registry-bound source location', async () => {
    const value = await fixture({ withDecision: true });
    const registry = JSON.parse(await readFile(value.onlineSourceRegistryPath, 'utf8'));
    registry.sources[0].allowed_url_prefixes = ['https://example.edu/official/'];
    registry.sources[0].artifact_binding.exact_artifact_urls = [
      'https://example.edu/official/doc-a',
    ];
    registry.sources[0].source_identity_sha256 = sourceIdentitySha256(registry.sources[0]);
    const registryRaw = `${JSON.stringify(registry, null, 2)}\n`;
    await writeFile(value.onlineSourceRegistryPath, registryRaw);
    await mutateDecision(value, (decision, ledger) => {
      ledger.policy.online_source_registry_sha256 = sha256(registryRaw);
      decision.online_evidence[0].source_identity_sha256 = registry.sources[0].source_identity_sha256;
    });
    await assert.rejects(buildOcrTriangulationAudit(auditOptions(value)), /outside allowed registry source locations/);
  });
});

test('online snapshots must be distinct text evidence related to accepted text', async (t) => {
  await t.test('snapshot cannot alias primary OCR through a hard link', async () => {
    const value = await fixture({ withDecision: true });
    const snapshotPath = path.join(value.root, 'online', 'official-doc-a.txt');
    await unlink(snapshotPath);
    await link(path.join(value.primaryRoot, '0001', 'content.md'), snapshotPath);
    await mutateDecision(value, (decision) => {
      decision.accepted_text = value.primary;
      decision.accepted_text_sha256 = sha256(value.primary);
      decision.page_type_binding_sha256 = pageTypeBindingSha256({
        primarySha: sha256(value.primary),
        acceptedSha: sha256(value.primary),
        imageSha: value.imageSha,
        pageType: 'prose',
      });
      decision.online_evidence[0].content_sha256 = sha256(value.primary);
      decision.online_evidence[0].snapshot_identity.text_sha256 = sha256(value.primary);
    });
    await mutateArtifactReceipt(value, (receipt) => {
      receipt.evidence_snapshot_sha256 = sha256(value.primary);
    });
    await assert.rejects(
      buildOcrTriangulationAudit(auditOptions(value)),
      /online evidence snapshot.*aliases.*primary OCR/i,
    );
  });

  await t.test('source PDF bytes cannot masquerade as an online text snapshot', async () => {
    const value = await fixture({ withDecision: true });
    await writeFile(path.join(value.root, 'online', 'official-doc-a.txt'), SOURCE_BYTES);
    await mutateDecision(value, (decision) => {
      const evidence = decision.online_evidence[0];
      evidence.content_sha256 = SOURCE_SHA;
      evidence.snapshot_identity.text_sha256 = SOURCE_SHA;
    });
    await assert.rejects(buildOcrTriangulationAudit(auditOptions(value)), /online evidence snapshot.*source PDF/i);
  });

  await t.test('unrelated snapshot text is rejected', async () => {
    const value = await fixture({ withDecision: true });
    const unrelated = '完全无关的在线文本';
    await writeFile(path.join(value.root, 'online', 'official-doc-a.txt'), unrelated);
    await mutateDecision(value, (decision) => {
      const evidence = decision.online_evidence[0];
      evidence.content_sha256 = sha256(unrelated);
      evidence.snapshot_identity.text_sha256 = sha256(unrelated);
    });
    await assert.rejects(buildOcrTriangulationAudit(auditOptions(value)), /accepted-text relation drifted/);
  });

  await t.test('differences require a structured scan-bound conflict resolution', async () => {
    const value = await fixture({ withDecision: true });
    const differing = '第一章\n正文乙42\n';
    await writeFile(path.join(value.root, 'online', 'official-doc-a.txt'), differing);
    await mutateDecision(value, (decision) => {
      const evidence = decision.online_evidence[0];
      evidence.content_sha256 = sha256(differing);
      evidence.snapshot_identity.text_sha256 = sha256(differing);
      evidence.accepted_text_relation = 'structured_conflicts_resolved';
    });
    await assert.rejects(buildOcrTriangulationAudit(auditOptions(value)), /structured conflict_resolution is required/);
  });

  await t.test('snapshot must be valid UTF-8 text', async () => {
    const value = await fixture({ withDecision: true });
    const invalid = Buffer.from([0xff, 0xfe, 0xfd]);
    await writeFile(path.join(value.root, 'online', 'official-doc-a.txt'), invalid);
    await mutateDecision(value, (decision) => {
      const evidence = decision.online_evidence[0];
      evidence.content_sha256 = sha256(invalid);
      evidence.snapshot_identity.text_sha256 = 'a'.repeat(64);
    });
    await assert.rejects(buildOcrTriangulationAudit(auditOptions(value)), /not valid UTF-8 text/);
  });
});

test('exact-edition authority must bind the specific document, version, and artifact', async (t) => {
  await t.test('a decision cannot self-declare a future edition', async () => {
    const value = await fixture({ withDecision: true });
    await mutateDecision(value, (decision) => {
      decision.document_identity.year_or_publication_context = '2099';
      decision.document_identity.version_label = 'Future exact edition';
    });
    await assert.rejects(
      buildOcrTriangulationAudit(auditOptions(value)),
      /document identity.*controlled registry/i,
    );
  });

  await t.test('citation cannot treat a null artifact receipt as proof of inequality', async () => {
    const value = await fixture({ withDecision: true });
    await mutateDecision(value, (decision) => {
      decision.online_evidence[0].artifact_identity_receipt = null;
    });
    await assert.rejects(
      buildOcrTriangulationAudit(auditOptions(value)),
      /artifact identity receipt.*required/i,
    );
  });
});

test('repackaged same-artifact receipts can never claim independent evidence', async () => {
  const value = await fixture({ withDecision: true });
  const repackaged = Buffer.concat([SOURCE_BYTES, Buffer.from('\n% repackaged mirror\n')]);
  const repackagedSha = sha256(repackaged);
  await writeFile(value.onlineArtifactPath, repackaged);
  const source = await mutateOnlineSourceRegistry(value, (registrySource) => {
    registrySource.artifact_binding.artifact_sha256 = repackagedSha;
  });
  await mutateArtifactReceipt(value, (receipt) => {
    receipt.source_identity_sha256 = source.source_identity_sha256;
    receipt.online_artifact_sha256 = repackagedSha;
    receipt.source_page_image_sha256 = ['b'.repeat(64)];
    receipt.online_page_image_sha256 = ['c'.repeat(64)];
    receipt.source_page_asset_sequence_sha256 = 'b'.repeat(64);
    receipt.online_page_asset_sequence_sha256 = 'c'.repeat(64);
    receipt.source_page_asset_count = 1;
    receipt.online_page_asset_count = 1;
    receipt.identity_result = 'different_page_asset_sequence';
  });
  await assert.rejects(
    buildOcrTriangulationAudit(auditOptions(value)),
    /recomputed page-image sequence|same page-asset sequence cannot be independent/i,
  );
});

test('page-image derivation identifies container-only repackaging', async () => {
  const repackaged = Buffer.concat([SOURCE_BYTES, Buffer.from('\n% alternate container bytes\n')]);
  const [source, mirror, different] = await Promise.all([
    derivePdfPageImageSequence(SOURCE_BYTES, 'source fixture'),
    derivePdfPageImageSequence(repackaged, 'repackaged source fixture'),
    derivePdfPageImageSequence(ONLINE_ARTIFACT_BYTES, 'different fixture'),
  ]);
  assert.deepEqual(mirror.page_image_sha256, source.page_image_sha256);
  assert.notDeepEqual(different.page_image_sha256, source.page_image_sha256);
});

test('self-declared page-sequence aggregates do not prove a different artifact', async () => {
  const value = await fixture({ withDecision: true });
  await mutateArtifactReceipt(value, (receipt) => {
    receipt.source_page_image_sha256 = ['b'.repeat(64)];
    receipt.online_page_image_sha256 = ['c'.repeat(64)];
    receipt.source_page_asset_sequence_sha256 = 'b'.repeat(64);
    receipt.online_page_asset_sequence_sha256 = 'c'.repeat(64);
    receipt.source_page_asset_count = 1;
    receipt.online_page_asset_count = 1;
    receipt.identity_result = 'different_page_asset_sequence';
  });
  await assert.rejects(
    buildOcrTriangulationAudit(auditOptions(value)),
    /recomputed page-image sequence/i,
  );
});

test('item and stable-fact decisions require durable scoped identifiers', async (t) => {
  await t.test('embedded item', async () => {
    const value = await fixture({
      withDecision: true,
      decisionPatch: {
        decision_scope: 'embedded_item',
        verification_status: 'verified_stable_fact_only',
        citation_allowed: false,
      },
    });
    await assert.rejects(buildOcrTriangulationAudit(auditOptions(value)), /embedded_item_id is required/);
  });

  await t.test('stable fact and span', async () => {
    const value = await fixture({
      withDecision: true,
      decisionPatch: {
        decision_scope: 'stable_fact',
        edition_match_status: 'stable_fact_only',
        verification_status: 'verified_stable_fact_only',
        citation_allowed: false,
      },
    });
    await assert.rejects(buildOcrTriangulationAudit(auditOptions(value)), /stable_fact_id.*stable_fact_span_id.*required/);
  });

  await t.test('a formatted item ID without its exact binding is rejected', async () => {
    const value = await fixture({ withDecision: true });
    await mutateDecision(value, (decision) => {
      decision.decision_scope = 'embedded_item';
      decision.embedded_item_id = 'item-doc-a-p1-goal-1';
      decision.embedded_item_binding_sha256 = 'a'.repeat(64);
      decision.verification_status = 'verified_stable_fact_only';
      decision.citation_allowed = false;
      decision.online_evidence[0].snapshot_identity.scope = 'embedded_item';
      decision.online_evidence[0].snapshot_identity.locator_id = decision.embedded_item_id;
    });
    await assert.rejects(
      buildOcrTriangulationAudit(auditOptions(value)),
      /embedded-item scoped identity binding drifted/i,
    );
  });
});

test('HTML, Markdown, and flattened tables cannot bypass the cell manifest gate', async (t) => {
  for (const [label, tableText] of [
    ['HTML', '<table><tr><td>甲</td><td>乙</td></tr></table>'],
    ['Markdown', '| 甲 | 乙 |\n|---|---|\n| 1 | 2 |'],
    ['flattened', '甲  乙  丙\n1  2  3'],
    ['single-row Markdown', '| 甲 | 乙 |'],
    ['single-row two-column flattened', '甲  乙'],
    ['single-row flattened', '甲  乙  丙'],
  ]) {
    await t.test(label, async () => {
      const value = await fixture({ withDecision: true });
      await bindAcceptedSnapshot(value, tableText);
      await assert.rejects(buildOcrTriangulationAudit(auditOptions(value)), /declared prose but table structure was detected/);
    });
  }

  await t.test('declared table still requires a hash-bound cell manifest', async () => {
    const value = await fixture({ withDecision: true });
    const tableText = '<table><tr><td>甲</td><td>乙</td></tr></table>';
    await bindAcceptedSnapshot(value, tableText, { pageType: 'table' });
    await assert.rejects(buildOcrTriangulationAudit(auditOptions(value)), /table_cell_manifest is required/);
  });

  for (const [label, sourceFormat, tableText, matrix] of [
    ['HTML valid manifest', 'html', '<table><tr><td>甲</td><td>乙</td></tr></table>', [['甲', '乙']]],
    [
      'Markdown valid manifest',
      'markdown_pipe',
      '| 甲 | 乙 |\n|---|---|\n| 1 | 2 |',
      [['甲', '乙'], ['1', '2']],
    ],
    ['flattened valid manifest', 'flattened_text', '甲  乙  丙\n1  2  3', [['甲', '乙', '丙'], ['1', '2', '3']]],
    ['two-column flattened valid manifest', 'flattened_text', '甲  乙\n1  2', [['甲', '乙'], ['1', '2']]],
    ['HTML blank-cell manifest', 'html', '<table><tr><td>甲</td><td></td></tr></table>', [['甲', '']]],
    ['Markdown blank-cell manifest', 'markdown_pipe', '| 甲 | |', [['甲', '']]],
  ]) {
    await t.test(label, async () => {
      const value = await fixture({ withDecision: true });
      const manifest = tableCellManifest(sourceFormat, matrix);
      await bindAcceptedSnapshot(value, tableText, {
        pageType: 'table',
        manifestSha: manifest.manifest_sha256,
      });
      await mutateDecision(value, (decision) => {
        decision.table_cell_manifest = manifest;
        decision.human_review.table_cells_checked = true;
      });
      const report = await buildOcrTriangulationAudit(auditOptions(value));
      assert.equal(report.pages[0].release.citation_allowed, true);
    });
  }

  await t.test('cell manifest cannot omit or replace an accepted table cell', async () => {
    const value = await fixture({ withDecision: true });
    const tableText = '<table><tr><td>甲</td><td>乙</td></tr></table>';
    const manifest = tableCellManifest('html', [['甲', '丙']]);
    await bindAcceptedSnapshot(value, tableText, {
      pageType: 'table',
      manifestSha: manifest.manifest_sha256,
    });
    await mutateDecision(value, (decision) => {
      decision.table_cell_manifest = manifest;
      decision.human_review.table_cells_checked = true;
    });
    await assert.rejects(buildOcrTriangulationAudit(auditOptions(value)), /does not match the accepted table cell/);
  });

  await t.test('manual grid cannot collapse a four-cell Markdown table to one cell', async () => {
    const value = await fixture({ withDecision: true });
    const tableText = '| 甲 | 乙 |\n|---|---|\n| 1 | 2 |';
    const manifest = tableCellManifest('manual_grid', [['甲']]);
    await bindAcceptedSnapshot(value, tableText, {
      pageType: 'table',
      manifestSha: manifest.manifest_sha256,
    });
    await mutateDecision(value, (decision) => {
      decision.table_cell_manifest = manifest;
      decision.human_review.table_cells_checked = true;
    });
    await assert.rejects(
      buildOcrTriangulationAudit(auditOptions(value)),
      /manual_grid|complete.*table|source[_ ]format/i,
    );
  });

  await t.test('HTML spanning cells cannot masquerade as a complete one-cell grid', async () => {
    const value = await fixture({ withDecision: true });
    const tableText = '<table><tr><td colspan="4">甲</td></tr></table>';
    const manifest = tableCellManifest('html', [['甲']]);
    await bindAcceptedSnapshot(value, tableText, {
      pageType: 'table',
      manifestSha: manifest.manifest_sha256,
    });
    await mutateDecision(value, (decision) => {
      decision.table_cell_manifest = manifest;
      decision.human_review.table_cells_checked = true;
    });
    await assert.rejects(
      buildOcrTriangulationAudit(auditOptions(value)),
      /spanning cells require an expanded cell-level representation/i,
    );
  });
});

test('build API revalidates every protected input after all reads', async () => {
  const value = await fixture({ withDecision: true });
  const hugeSnapshot = `${'在线核对文本'.repeat(4_000_000)}\n第一章\n正文甲42\n`;
  await writeFile(path.join(value.root, 'online', 'official-doc-a.txt'), hugeSnapshot);
  await mutateDecision(value, (decision) => {
    const evidence = decision.online_evidence[0];
    evidence.content_sha256 = sha256(hugeSnapshot);
    evidence.snapshot_identity.text_sha256 = sha256(hugeSnapshot);
    evidence.accepted_text_relation = 'snapshot_contains_accepted_text';
  });
  await mutateArtifactReceipt(value, (receipt) => {
    receipt.evidence_snapshot_sha256 = sha256(hugeSnapshot);
  });
  const pending = buildOcrTriangulationAudit(auditOptions(value));
  await new Promise((resolve) => setTimeout(resolve, 25));
  await writeFile(value.sourcePdfPath, Buffer.concat([SOURCE_BYTES, Buffer.from('\n% replaced')]));
  await assert.rejects(pending, /protected input identity changed before return/i);
});

test('build API also retains full furniture-snapshot inputs outside the requested page range', async () => {
  const value = await fixture();
  const outsideRangeSidecar = path.join(
    value.witnessRoot,
    value.documentId,
    'vision',
    'page-002.json',
  );
  await assert.rejects(buildOcrTriangulationAudit({
    ...auditOptions(value),
    onBeforeFinalInputVerificationForTest: async () => {
      await writeFile(outsideRangeSidecar, '{"drifted":true}\n');
    },
  }), /protected input identity changed before return/i);
});

test('writer rechecks containment and every protected input immediately before rename', async (t) => {
  await t.test('real parent is checked again after prospective containment', async () => {
    const value = await fixture();
    const parent = path.dirname(value.outputPath);
    await assert.rejects(writeOcrTriangulationAudit({
      ...auditOptions(value),
      outputPath: value.outputPath,
      onAfterProspectiveOutputCheckForTest: async () => {
        await symlink(value.primaryRoot, parent);
      },
    }), /output must be outside primary and witness evidence roots/i);
  });

  await t.test('input replacement in the activation window is rejected', async () => {
    const value = await fixture();
    await assert.rejects(writeOcrTriangulationAudit({
      ...auditOptions(value),
      outputPath: value.outputPath,
      onBeforeOutputActivationForTest: async () => {
        await writeFile(value.sourcePdfPath, Buffer.concat([SOURCE_BYTES, Buffer.from('\n% changed')]));
      },
    }), /protected input identity changed before output activation/i);
  });
});

test('scoped IDs are document-bound and duplicate spans fail closed', async () => {
  const value = await fixture({ withDecision: true });
  await mutateDecision(value, (decision, ledger) => {
    Object.assign(decision, {
      decision_scope: 'stable_fact',
      stable_fact_id: 'fact-doc-a-author',
      stable_fact_span_id: 'span-doc-a-p1-author',
      edition_match_status: 'stable_fact_only',
      verification_status: 'verified_stable_fact_only',
      citation_allowed: false,
    });
    decision.stable_fact_binding_sha256 = scopedBindingSha256(
      'stable_fact',
      decision.stable_fact_id,
      decision,
    );
    decision.stable_fact_span_binding_sha256 = scopedBindingSha256(
      'stable_fact_span',
      decision.stable_fact_span_id,
      decision,
    );
    decision.online_evidence[0].snapshot_identity.scope = 'stable_fact_excerpt';
    decision.online_evidence[0].snapshot_identity.locator_id = decision.stable_fact_span_id;
    const duplicate = structuredClone(decision);
    duplicate.decision_id = 'decision-doc-a-p1-duplicate';
    ledger.decisions.push(duplicate);
  });
  await assert.rejects(
    buildOcrTriangulationAudit(auditOptions(value)),
    /duplicate stable_fact_span_id|scoped identity binding/i,
  );
});

test('scoped identity bindings permit only exact stable-fact semantic reuse', async (t) => {
  await t.test('a bound embedded item is accepted without promoting its page', async () => {
    const value = await fixture({ withDecision: true });
    await mutateDecision(value, (decision) => {
      decision.decision_scope = 'embedded_item';
      decision.embedded_item_id = 'item-doc-a-p1-goal-1';
      decision.embedded_item_binding_sha256 = scopedBindingSha256(
        'embedded_item',
        decision.embedded_item_id,
        decision,
      );
      decision.verification_status = 'verified_stable_fact_only';
      decision.citation_allowed = false;
      decision.online_evidence[0].snapshot_identity.scope = 'embedded_item';
      decision.online_evidence[0].snapshot_identity.locator_id = decision.embedded_item_id;
    });
    const report = await buildOcrTriangulationAudit(auditOptions(value));
    assert.equal(report.pages[0].release.citation_allowed, false);
    assert.equal(report.pages[0].scoped_decisions.length, 1);
  });

  await t.test('an embedded item ID cannot be reused within its document', async () => {
    const value = await fixture({ withDecision: true });
    await mutateDecision(value, (decision, ledger) => {
      decision.decision_scope = 'embedded_item';
      decision.embedded_item_id = 'item-doc-a-p1-goal-1';
      decision.embedded_item_binding_sha256 = scopedBindingSha256(
        'embedded_item',
        decision.embedded_item_id,
        decision,
      );
      decision.verification_status = 'verified_stable_fact_only';
      decision.citation_allowed = false;
      decision.online_evidence[0].snapshot_identity.scope = 'embedded_item';
      decision.online_evidence[0].snapshot_identity.locator_id = decision.embedded_item_id;
      const duplicate = structuredClone(decision);
      duplicate.decision_id = 'decision-doc-a-p1-duplicate-item';
      ledger.decisions.push(duplicate);
    });
    await assert.rejects(
      buildOcrTriangulationAudit(auditOptions(value)),
      /duplicate embedded_item_id within document/i,
    );
  });

  await t.test('the same fact ID may reuse an identical semantic binding with a unique span', async () => {
    const value = await fixture({ withDecision: true });
    await mutateDecision(value, (decision, ledger) => {
      Object.assign(decision, {
        decision_scope: 'stable_fact',
        stable_fact_id: 'fact-doc-a-author',
        stable_fact_span_id: 'span-doc-a-p1-author-a',
        edition_match_status: 'stable_fact_only',
        verification_status: 'verified_stable_fact_only',
        citation_allowed: false,
      });
      decision.stable_fact_binding_sha256 = scopedBindingSha256(
        'stable_fact',
        decision.stable_fact_id,
        decision,
      );
      decision.stable_fact_span_binding_sha256 = scopedBindingSha256(
        'stable_fact_span',
        decision.stable_fact_span_id,
        decision,
      );
      decision.online_evidence[0].snapshot_identity.scope = 'stable_fact_excerpt';
      decision.online_evidence[0].snapshot_identity.locator_id = decision.stable_fact_span_id;
      const duplicate = structuredClone(decision);
      duplicate.decision_id = 'decision-doc-a-p1-same-fact-second-span';
      duplicate.stable_fact_span_id = 'span-doc-a-p1-author-b';
      duplicate.stable_fact_span_binding_sha256 = scopedBindingSha256(
        'stable_fact_span',
        duplicate.stable_fact_span_id,
        duplicate,
      );
      duplicate.online_evidence[0].snapshot_identity.locator_id = duplicate.stable_fact_span_id;
      ledger.decisions.push(duplicate);
    });
    const report = await buildOcrTriangulationAudit(auditOptions(value));
    assert.equal(report.pages[0].scoped_decisions.length, 2);
  });

  await t.test('the same fact ID cannot identify a different locator', async () => {
    const value = await fixture({ withDecision: true });
    await mutateDecision(value, (decision, ledger) => {
      Object.assign(decision, {
        decision_scope: 'stable_fact',
        stable_fact_id: 'fact-doc-a-author',
        stable_fact_span_id: 'span-doc-a-p1-author-a',
        edition_match_status: 'stable_fact_only',
        verification_status: 'verified_stable_fact_only',
        citation_allowed: false,
      });
      decision.stable_fact_binding_sha256 = scopedBindingSha256(
        'stable_fact',
        decision.stable_fact_id,
        decision,
      );
      decision.stable_fact_span_binding_sha256 = scopedBindingSha256(
        'stable_fact_span',
        decision.stable_fact_span_id,
        decision,
      );
      decision.online_evidence[0].snapshot_identity.scope = 'stable_fact_excerpt';
      decision.online_evidence[0].snapshot_identity.locator_id = decision.stable_fact_span_id;
      const conflict = structuredClone(decision);
      conflict.decision_id = 'decision-doc-a-p1-conflicting-fact';
      conflict.stable_fact_span_id = 'span-doc-a-p1-author-b';
      conflict.document_identity.section_or_item_locator = '另一位置';
      conflict.online_evidence[0].section_locator = '另一位置';
      conflict.stable_fact_binding_sha256 = scopedBindingSha256(
        'stable_fact',
        conflict.stable_fact_id,
        conflict,
      );
      conflict.stable_fact_span_binding_sha256 = scopedBindingSha256(
        'stable_fact_span',
        conflict.stable_fact_span_id,
        conflict,
      );
      conflict.online_evidence[0].snapshot_identity.locator_id = conflict.stable_fact_span_id;
      ledger.decisions.push(conflict);
    });
    await assert.rejects(
      buildOcrTriangulationAudit(auditOptions(value)),
      /duplicate stable_fact_id has a different semantic identity/i,
    );
  });
});

test('legacy furniture validator rejects symlinked witness evidence', async () => {
  const value = await fixture();
  const approval = JSON.parse(await readFile(value.approvalPath, 'utf8'));
  const sidecar = path.join(value.witnessRoot, value.documentId, 'vision', 'page-001.json');
  const backup = path.join(value.root, 'page-001-backup.json');
  await writeFile(backup, await readFile(sidecar));
  await unlink(sidecar);
  await symlink(backup, sidecar);
  await assert.rejects(validateOcrPageFurnitureApprovals(approval, {
    witnessRoot: value.witnessRoot,
  }), /cannot be read safely|symbolic link/i);
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
      onlineSourceRegistryPath: value.onlineSourceRegistryPath,
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
      onlineSourceRegistryPath: value.onlineSourceRegistryPath,
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
      onlineSourceRegistryPath: value.onlineSourceRegistryPath,
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
      onlineSourceRegistryPath: value.onlineSourceRegistryPath,
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
      onlineSourceRegistryPath: value.onlineSourceRegistryPath,
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
      onlineSourceRegistryPath: value.onlineSourceRegistryPath,
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
      onlineSourceRegistryPath: value.onlineSourceRegistryPath,
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
      onlineSourceRegistryPath: value.onlineSourceRegistryPath,
      outputPath: value.decisionsPath,
      start: 1,
      end: 1,
    }), /output must not replace an input ledger/);
  });

  await t.test('output cannot replace the source PDF or controlled registry', async () => {
    for (const protectedPath of ['sourcePdfPath', 'onlineSourceRegistryPath']) {
      const value = await fixture();
      await assert.rejects(writeOcrTriangulationAudit({
        ...auditOptions(value),
        outputPath: value[protectedPath],
      }), /output must not replace a protected input/);
    }
  });

  await t.test('output cannot enter an online evidence snapshot directory', async () => {
    const value = await fixture({ withDecision: true });
    await assert.rejects(writeOcrTriangulationAudit({
      ...auditOptions(value),
      outputPath: path.join(value.root, 'online', 'audit.json'),
    }), /output.*online evidence.*directory/i);
  });

  await t.test('output hard-link alias to a protected input is rejected by identity', async () => {
    const value = await fixture();
    await mkdir(path.dirname(value.outputPath), { recursive: true });
    await link(value.sourcePdfPath, value.outputPath);
    await assert.rejects(writeOcrTriangulationAudit({
      ...auditOptions(value),
      outputPath: value.outputPath,
    }), /output.*device.*inode|output.*aliases.*protected/i);
  });

  await t.test('output cannot enter a protected root through a parent symlink alias', async () => {
    const value = await fixture();
    const alias = path.join(value.root, 'witness-alias');
    await symlink(value.witnessRoot, alias);
    await assert.rejects(writeOcrTriangulationAudit({
      ...auditOptions(value),
      outputPath: path.join(alias, 'audit.json'),
    }), /outside primary and witness evidence roots/);
  });
});
