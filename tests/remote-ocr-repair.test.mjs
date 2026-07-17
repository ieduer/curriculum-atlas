import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyRemoteOcrRepair,
  validateRepairManifest,
} from '../scripts/apply-remote-ocr-repair.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const scriptPath = path.resolve('scripts/apply-remote-ocr-repair.mjs');

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function exists(pathname) {
  try {
    await lstat(pathname);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeWithSidecar(pathname, value) {
  const raw = typeof value === 'string' ? value : jsonText(value);
  await writeFile(pathname, raw);
  await writeFile(`${pathname}.sha256`, `${sha256(raw)}  ${path.basename(pathname)}\n`);
  return raw;
}

async function fixture(t, { failure = 'RuntimeError: llama PEG-native 500 parser rejected output' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'remote-ocr-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputRoot = path.join(root, 'shard');
  const evidenceRoot = path.join(root, 'evidence');
  const documentId = 'doc-russian';
  const documentRoot = path.join(outputRoot, 'documents', documentId);
  const existingPageRoot = path.join(documentRoot, 'pages', '0001');
  await Promise.all([
    mkdir(path.join(existingPageRoot, 'markdown'), { recursive: true }),
    mkdir(evidenceRoot, { recursive: true }),
  ]);

  const existingResult = '{"page":1}\n';
  const existingContent = 'existing page\n';
  await Promise.all([
    writeFile(path.join(existingPageRoot, 'result.json'), existingResult),
    writeFile(path.join(existingPageRoot, 'content.md'), existingContent),
    writeFile(path.join(existingPageRoot, 'markdown/page-0001.md'), existingContent),
  ]);

  const sourceSha256 = 'a'.repeat(64);
  const renderedImage = Buffer.from('fresh 240dpi rendered page two');
  const onlineEvidence = Buffer.from('same-edition official online comparison');
  const imagePath = path.join(evidenceRoot, 'page-0002.png');
  const onlinePath = path.join(evidenceRoot, 'online-check.txt');
  await Promise.all([
    writeFile(imagePath, renderedImage),
    writeFile(onlinePath, onlineEvidence),
  ]);

  const state = {
    schema_version: 1,
    document_id: documentId,
    source_path: '/verified/source.pdf',
    source_sha256: sourceSha256,
    page_count: 2,
    started_at: '2026-07-16T00:00:00Z',
    configuration: {
      pipeline: 'PaddleOCR-VL',
      pipeline_version: 'v1.6',
      layout_model: 'PP-DocLayoutV3',
      recognizer: 'PaddleOCR-VL-1.6-0.9B official GGUF',
      custom_preserved_field: 'must survive repair',
    },
    completed_pages: [1],
    failed_pages: {
      2: {
        error: failure,
        recorded_at: '2026-07-16T01:00:00Z',
      },
    },
    pages: {
      1: {
        status: 'ocr_complete_pending_audit',
        physical_pdf_page: 1,
        rendered_image_sha256: '1'.repeat(64),
        result_json_sha256: sha256(existingResult),
        content_markdown_sha256: sha256(existingContent),
        citation_eligible: false,
        preserved_page_field: true,
      },
    },
    selected_pages: [1, 2],
    selected_pages_complete: false,
  };
  const statePath = path.join(documentRoot, 'state.json');
  await writeFile(statePath, jsonText(state));

  const finalText = 'уважать【未】 — 尊敬\nулыбаться/улыбнуться — 微笑\n';
  const manifest = {
    schema_version: 1,
    manifest_type: 'curriculum_remote_ocr_page_repair',
    repair_id: 'repair-six-pages-20260716',
    method: 'human_image_and_same_edition_online_adjudication',
    citation_allowed: false,
    documents: [{
      document_id: documentId,
      source_sha256: sourceSha256,
      page_count: 2,
      citation_allowed: false,
      pages: [{
        physical_pdf_page: 2,
        citation_eligible: false,
        rendered_image_sha256: sha256(renderedImage),
        final_text: finalText,
        final_text_sha256: sha256(finalText),
        evidence: [
          {
            kind: 'rendered_page_image',
            path: 'page-0002.png',
            sha256: sha256(renderedImage),
          },
          {
            kind: 'same_edition_online_text',
            path: 'online-check.txt',
            sha256: sha256(onlineEvidence),
          },
        ],
      }],
    }],
  };
  const manifestPath = path.join(evidenceRoot, 'repair-manifest.json');
  await writeWithSidecar(manifestPath, manifest);
  return {
    root,
    outputRoot,
    evidenceRoot,
    documentId,
    documentRoot,
    state,
    statePath,
    finalText,
    manifest,
    manifestPath,
    imagePath,
    onlinePath,
  };
}

test('manifest validation fail-closes schema, citation, duplicate pages, final text, and rendered evidence binding', () => {
  const finalText = 'verified text';
  const imageSha = 'b'.repeat(64);
  const manifest = {
    schema_version: 1,
    manifest_type: 'curriculum_remote_ocr_page_repair',
    repair_id: 'repair-1',
    method: 'manual_adjudication',
    citation_allowed: false,
    documents: [{
      document_id: 'doc-1',
      source_sha256: 'a'.repeat(64),
      page_count: 3,
      citation_allowed: false,
      pages: [{
        physical_pdf_page: 2,
        citation_eligible: false,
        rendered_image_sha256: imageSha,
        final_text: finalText,
        final_text_sha256: sha256(finalText),
        evidence: [{ kind: 'rendered_page_image', path: 'page.png', sha256: imageSha }],
      }],
    }],
  };
  assert.equal(validateRepairManifest(manifest), manifest);

  const wrongType = structuredClone(manifest);
  wrongType.manifest_type = 'remote_ocr_repair';
  assert.throws(() => validateRepairManifest(wrongType), /manifest_type/);

  const citationEnabled = structuredClone(manifest);
  citationEnabled.documents[0].pages[0].citation_eligible = true;
  assert.throws(() => validateRepairManifest(citationEnabled), /citation_eligible must equal false/);

  const duplicate = structuredClone(manifest);
  duplicate.documents[0].pages.push(structuredClone(duplicate.documents[0].pages[0]));
  assert.throws(() => validateRepairManifest(duplicate), /duplicate page/);

  const textDrift = structuredClone(manifest);
  textDrift.documents[0].pages[0].final_text = 'drifted';
  assert.throws(() => validateRepairManifest(textDrift), /final_text_sha256 mismatch/);

  const unboundImage = structuredClone(manifest);
  unboundImage.documents[0].pages[0].evidence[0].sha256 = 'c'.repeat(64);
  assert.throws(() => validateRepairManifest(unboundImage), /must bind rendered_image_sha256/);
});

test('default CLI mode is a non-writing dry-run with deterministic artifact checksums', async (t) => {
  const value = await fixture(t);
  const result = spawnSync(process.execPath, [
    scriptPath,
    '--manifest', value.manifestPath,
    '--output-root', value.outputRoot,
  ], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.mode, 'dry-run');
  assert.equal(summary.status, 'ready');
  assert.equal(summary.citation_allowed, false);
  assert.equal(summary.documents[0].pages[0].content_markdown_sha256, sha256(value.finalText));
  assert.equal(await exists(path.join(value.documentRoot, 'pages/0002')), false);
  assert.equal(await exists(path.join(value.outputRoot, 'repair-receipts')), false);
  assert.equal(await readFile(value.statePath, 'utf8'), jsonText(value.state));
});

test('apply stages and atomically installs explicit repair artifacts, state metadata, receipt, and idempotent verification', async (t) => {
  const value = await fixture(t);
  const timestamp = '2026-07-16T12:34:56.000Z';
  const first = await applyRemoteOcrRepair({
    manifest: value.manifestPath,
    outputRoot: value.outputRoot,
    apply: true,
    now: () => timestamp,
  });
  assert.equal(first.mode, 'apply');
  assert.equal(first.status, 'applied');
  assert.equal(first.citation_allowed, false);

  const pageRoot = path.join(value.documentRoot, 'pages/0002');
  const [resultRaw, content, mirroredMarkdown, stateRaw] = await Promise.all([
    readFile(path.join(pageRoot, 'result.json'), 'utf8'),
    readFile(path.join(pageRoot, 'content.md'), 'utf8'),
    readFile(path.join(pageRoot, 'markdown/page-0002.md'), 'utf8'),
    readFile(value.statePath, 'utf8'),
  ]);
  const result = JSON.parse(resultRaw);
  const state = JSON.parse(stateRaw);
  assert.equal(content, value.finalText);
  assert.equal(mirroredMarkdown, value.finalText);
  assert.equal(result.result_type, 'curriculum_remote_ocr_page_repair');
  assert.equal(result.citation_eligible, false);
  assert.equal(result.repair_provenance.method, value.manifest.method);
  assert.equal(result.repair_provenance.base_failure.error, value.state.failed_pages['2'].error);
  assert.equal('pipeline' in result, false, 'repair result must not claim Paddle provenance');

  assert.deepEqual(state.completed_pages, [1, 2]);
  assert.deepEqual(state.failed_pages, {});
  assert.equal(state.selected_pages_complete, true);
  assert.equal(state.updated_at, timestamp);
  assert.equal(state.finished_selected_pages_at, timestamp);
  assert.equal(state.configuration.custom_preserved_field, 'must survive repair');
  assert.equal(state.pages['1'].preserved_page_field, true);
  assert.equal(state.pages['2'].citation_eligible, false);
  assert.equal(state.pages['2'].repair_provenance.repair_id, value.manifest.repair_id);
  assert.equal(state.pages['2'].repair_provenance.citation_eligible, false);
  assert.equal(state.pages['2'].result_json_sha256, sha256(resultRaw));
  assert.equal(state.pages['2'].content_markdown_sha256, sha256(content));

  const receiptPath = path.join(value.outputRoot, 'repair-receipts', `${value.manifest.repair_id}.json`);
  const receiptRaw = await readFile(receiptPath, 'utf8');
  const receipt = JSON.parse(receiptRaw);
  assert.equal(receipt.receipt_type, 'curriculum_remote_ocr_page_repair_receipt');
  assert.equal(receipt.repair_manifest_sha256, sha256(await readFile(value.manifestPath)));
  assert.equal(receipt.documents[0].state_after_sha256, sha256(stateRaw));
  assert.equal(
    await readFile(`${receiptPath}.sha256`, 'utf8'),
    `${sha256(receiptRaw)}  ${path.basename(receiptPath)}\n`,
  );

  const beforeRepeat = {
    state: stateRaw,
    result: resultRaw,
    receipt: receiptRaw,
  };
  const repeated = await applyRemoteOcrRepair({
    manifest: value.manifestPath,
    outputRoot: value.outputRoot,
    apply: true,
    now: () => '2099-01-01T00:00:00.000Z',
  });
  assert.equal(repeated.status, 'verified_idempotent');
  assert.equal(await readFile(value.statePath, 'utf8'), beforeRepeat.state);
  assert.equal(await readFile(path.join(pageRoot, 'result.json'), 'utf8'), beforeRepeat.result);
  assert.equal(await readFile(receiptPath, 'utf8'), beforeRepeat.receipt);
  assert.equal(await exists(path.join(value.outputRoot, '.remote-ocr-repair.lock')), false);
  assert.deepEqual(
    (await readdir(value.outputRoot)).filter((name) => name.startsWith('.remote-ocr-repair-staging-')),
    [],
  );
});

test('preflight rejects manifest sidecar drift, evidence drift, source identity drift, and non-PEG failures without writing', async (t) => {
  await t.test('manifest sidecar drift', async (inner) => {
    const value = await fixture(inner);
    await writeFile(`${value.manifestPath}.sha256`, `${'0'.repeat(64)}  ${path.basename(value.manifestPath)}\n`);
    await assert.rejects(
      applyRemoteOcrRepair({ manifest: value.manifestPath, outputRoot: value.outputRoot }),
      /manifest SHA-256 sidecar mismatch/,
    );
    assert.equal(await exists(path.join(value.documentRoot, 'pages/0002')), false);
  });

  await t.test('evidence drift', async (inner) => {
    const value = await fixture(inner);
    await writeFile(value.onlinePath, 'tampered evidence');
    await assert.rejects(
      applyRemoteOcrRepair({ manifest: value.manifestPath, outputRoot: value.outputRoot }),
      /evidence hash mismatch/,
    );
  });

  await t.test('source identity drift', async (inner) => {
    const value = await fixture(inner);
    const state = JSON.parse(await readFile(value.statePath, 'utf8'));
    state.source_sha256 = 'f'.repeat(64);
    await writeFile(value.statePath, jsonText(state));
    await assert.rejects(
      applyRemoteOcrRepair({ manifest: value.manifestPath, outputRoot: value.outputRoot }),
      /state source SHA-256 mismatch/,
    );
  });

  await t.test('non-PEG failure', async (inner) => {
    const value = await fixture(inner, { failure: 'RuntimeError: ordinary OCR timeout 500' });
    await assert.rejects(
      applyRemoteOcrRepair({ manifest: value.manifestPath, outputRoot: value.outputRoot }),
      /neither an untouched PEG-native 500 failure/,
    );
  });
});

test('conflicts fail closed when the failed page is completed, has metadata, has a directory, or leaves other failures', async (t) => {
  await t.test('completed conflict', async (inner) => {
    const value = await fixture(inner);
    const state = JSON.parse(await readFile(value.statePath, 'utf8'));
    state.completed_pages.push(2);
    delete state.failed_pages['2'];
    state.pages['2'] = {
      status: 'ocr_complete_pending_audit',
      physical_pdf_page: 2,
      rendered_image_sha256: '2'.repeat(64),
      result_json_sha256: '3'.repeat(64),
      content_markdown_sha256: '4'.repeat(64),
      citation_eligible: false,
    };
    await writeFile(value.statePath, jsonText(state));
    await assert.rejects(
      applyRemoteOcrRepair({ manifest: value.manifestPath, outputRoot: value.outputRoot }),
      /neither an untouched PEG-native 500 failure/,
    );
  });

  await t.test('page directory conflict', async (inner) => {
    const value = await fixture(inner);
    await mkdir(path.join(value.documentRoot, 'pages/0002'));
    await assert.rejects(
      applyRemoteOcrRepair({ manifest: value.manifestPath, outputRoot: value.outputRoot }),
      /neither an untouched PEG-native 500 failure/,
    );
  });

  await t.test('uncovered failed page', async (inner) => {
    const value = await fixture(inner);
    const state = JSON.parse(await readFile(value.statePath, 'utf8'));
    state.page_count = 3;
    state.selected_pages = [1, 2, 3];
    state.failed_pages['3'] = { error: 'RuntimeError: llama PEG-native 500 parser rejected output' };
    value.manifest.documents[0].page_count = 3;
    await writeFile(value.statePath, jsonText(state));
    await writeWithSidecar(value.manifestPath, value.manifest);
    await assert.rejects(
      applyRemoteOcrRepair({ manifest: value.manifestPath, outputRoot: value.outputRoot }),
      /manifest must cover every failed page/,
    );
  });

  await t.test('pages-root symlink escape', async (inner) => {
    const value = await fixture(inner);
    const outside = path.join(value.root, 'outside-pages');
    await rm(path.join(value.documentRoot, 'pages'), { recursive: true });
    await mkdir(outside);
    await symlink(outside, path.join(value.documentRoot, 'pages'));
    await assert.rejects(
      applyRemoteOcrRepair({ manifest: value.manifestPath, outputRoot: value.outputRoot }),
      /pages root must not traverse a symlink/,
    );
    assert.deepEqual(await readdir(outside), []);
  });
});

test('an applied repair without its receipt or with a drifted receipt fails closed', async (t) => {
  const value = await fixture(t);
  await applyRemoteOcrRepair({
    manifest: value.manifestPath,
    outputRoot: value.outputRoot,
    apply: true,
    now: () => '2026-07-16T12:34:56.000Z',
  });
  const receiptPath = path.join(value.outputRoot, 'repair-receipts', `${value.manifest.repair_id}.json`);
  const validReceipt = await readFile(receiptPath, 'utf8');
  await Promise.all([
    rm(receiptPath),
    rm(`${receiptPath}.sha256`),
  ]);
  await assert.rejects(
    applyRemoteOcrRepair({ manifest: value.manifestPath, outputRoot: value.outputRoot }),
    /already present without a valid receipt/,
  );

  await writeFile(receiptPath, validReceipt);
  await writeFile(`${receiptPath}.sha256`, `${'0'.repeat(64)}  ${path.basename(receiptPath)}\n`);
  await assert.rejects(
    applyRemoteOcrRepair({ manifest: value.manifestPath, outputRoot: value.outputRoot }),
    /receipt SHA-256 sidecar mismatch/,
  );

  const driftedReceipt = JSON.parse(validReceipt);
  driftedReceipt.documents[0].pages[0].result_json_sha256 = 'f'.repeat(64);
  await writeWithSidecar(receiptPath, driftedReceipt);
  await assert.rejects(
    applyRemoteOcrRepair({ manifest: value.manifestPath, outputRoot: value.outputRoot }),
    /receipt artifact checksum mismatch/,
  );
});
