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
  validateOcrPageFurnitureActivation,
  writeOcrTriangulationAudit,
} from '../scripts/build-ocr-triangulation-audit.mjs';
import { validateOcrPageFurnitureApprovals } from '../scripts/validate-ocr-page-furniture-approvals.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const SOURCE_BYTES = Buffer.from('%PDF-1.7\nfixture source PDF bytes');
const SOURCE_SHA = sha256(SOURCE_BYTES);

const sourceIdentitySha256 = (source) => sha256(JSON.stringify({
  source_id: source.source_id,
  publisher: source.publisher,
  source_type: source.source_type,
  authority_class: source.authority_class,
  authority_record_id: source.authority_record_id,
  allowed_hosts: source.allowed_hosts,
  allowed_url_prefixes: source.allowed_url_prefixes,
}));

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
  const registrySource = {
    source_id: 'official-exact-doc-a',
    publisher: 'Official publisher',
    source_type: 'official_archive',
    authority_class: 'official',
    authority_record_id: 'fixture-official-publisher',
    allowed_hosts: ['example.edu'],
    allowed_url_prefixes: ['https://example.edu/'],
  };
  registrySource.source_identity_sha256 = sourceIdentitySha256(registrySource);
  const onlineSourceRegistry = {
    schema_version: 1,
    artifact_profile: 'ocr-online-source-registry-v1',
    policy: {
      authority_declared_only_here: true,
      https_only: true,
      exact_hostname_match: true,
    },
    sources: [registrySource],
  };
  const onlineSourceRegistryRaw = `${JSON.stringify(onlineSourceRegistry, null, 2)}\n`;
  const onlineSourceRegistryPath = path.join(root, 'online-source-registry.json');
  await writeFile(onlineSourceRegistryPath, onlineSourceRegistryRaw);
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
      stable_fact_id: null,
      stable_fact_span_id: null,
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
        artifact_relation: 'independent_transcription',
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
        artifact_identity_receipt: null,
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

test('repackaged same-artifact receipts can never claim independent evidence', async () => {
  const value = await fixture({ withDecision: true });
  const receipt = {
    schema_version: 1,
    artifact_profile: 'ocr-online-artifact-identity-receipt-v1',
    source_pdf_sha256: SOURCE_SHA,
    evidence_snapshot_sha256: sha256('第一章\n正文甲42\n'),
    online_artifact_sha256: 'a'.repeat(64),
    source_page_asset_sequence_sha256: 'b'.repeat(64),
    source_page_asset_count: 2,
    online_page_asset_sequence_sha256: 'b'.repeat(64),
    online_page_asset_count: 2,
    identity_result: 'same_page_asset_sequence',
  };
  const receiptRaw = `${JSON.stringify(receipt, null, 2)}\n`;
  await writeFile(path.join(value.root, 'online', 'artifact-receipt.json'), receiptRaw);
  await mutateDecision(value, (decision) => {
    const evidence = decision.online_evidence[0];
    evidence.artifact_relation = 'different_artifact_same_edition';
    evidence.artifact_identity_receipt = {
      receipt_path: 'online/artifact-receipt.json',
      receipt_sha256: sha256(receiptRaw),
    };
  });
  await assert.rejects(buildOcrTriangulationAudit(auditOptions(value)), /same page-asset sequence cannot be independent/);
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
});

test('HTML, Markdown, and flattened tables cannot bypass the cell manifest gate', async (t) => {
  for (const [label, tableText] of [
    ['HTML', '<table><tr><td>甲</td><td>乙</td></tr></table>'],
    ['Markdown', '| 甲 | 乙 |\n|---|---|\n| 1 | 2 |'],
    ['flattened', '甲  乙  丙\n1  2  3'],
    ['single-row Markdown', '| 甲 | 乙 |'],
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
