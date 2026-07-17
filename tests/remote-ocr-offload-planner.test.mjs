import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PINNED_REMOTE_OCR_RUNTIME,
  buildRemoteOcrOffloadManifest,
  writeRemoteOcrOffloadManifest,
} from '../scripts/plan-remote-ocr-offload.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function createFixture(t, specifications) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'curriculum-offload-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(path.join(root, 'data'), { recursive: true }),
    mkdir(path.join(root, '.cache/sources'), { recursive: true }),
    mkdir(path.join(root, '.cache/ocr-production'), { recursive: true }),
    mkdir(path.join(root, '.cache/ocr-supervisor'), { recursive: true }),
  ]);

  const documents = [];
  for (const specification of specifications) {
    const contents = Buffer.from(`source-${specification.id}`);
    const sourcePath = `.cache/sources/${specification.id}.pdf`;
    await writeFile(path.join(root, sourcePath), contents);
    documents.push({
      id: specification.id,
      title: specification.id,
      subject: '语文',
      priority: specification.priority ?? 2,
      source_sha256: sha256(contents),
      page_count: specification.pageCount ?? 3,
      local_cache_path: sourcePath,
    });
    if (Object.hasOwn(specification, 'state')) {
      const stateRoot = path.join(root, '.cache/ocr-production', specification.id);
      await mkdir(stateRoot, { recursive: true });
      const baselineState = {
        schema_version: 1,
        document_id: specification.id,
        source_sha256: sha256(contents),
        page_count: specification.pageCount ?? 3,
        completed_pages: [],
        failed_pages: {},
        pages: {},
      };
      const state = specification.state && typeof specification.state === 'object' && !Array.isArray(specification.state)
        ? { ...baselineState, ...specification.state }
        : specification.state;
      await writeFile(path.join(stateRoot, 'state.json'), JSON.stringify(state));
    }
    if (specification.artifact) {
      const stateRoot = path.join(root, '.cache/ocr-production', specification.id);
      await mkdir(stateRoot, { recursive: true });
      await writeFile(path.join(stateRoot, 'orphan.txt'), 'stale');
    }
  }
  await writeFile(path.join(root, 'data/ocr-queue.json'), JSON.stringify({ schema_version: 1, documents }));
  return { root, documents };
}

async function installLocalProgress(root, document, {
  completedPages,
  failedPages = {},
  pageRetries = {},
  text = null,
}) {
  const documentRoot = path.join(root, '.cache/ocr-production', document.id);
  await mkdir(path.join(documentRoot, 'pages'), { recursive: true });
  const pages = {};
  for (const page of completedPages) {
    const pageRoot = path.join(documentRoot, 'pages', String(page).padStart(4, '0'));
    await mkdir(pageRoot, { recursive: true });
    const result = `${JSON.stringify({ page })}\n`;
    const content = `local page ${page}\n`;
    await writeFile(path.join(pageRoot, 'result.json'), result);
    await writeFile(path.join(pageRoot, 'content.md'), content);
    pages[String(page)] = {
      status: 'ocr_complete_pending_audit',
      physical_pdf_page: page,
      rendered_image_sha256: sha256(`rendered:${document.id}:${page}`),
      result_json_sha256: sha256(result),
      content_markdown_sha256: sha256(content),
      citation_eligible: false,
    };
  }
  await writeFile(path.join(documentRoot, 'state.json'), `${JSON.stringify({
    schema_version: 1,
    document_id: document.id,
    source_sha256: document.source_sha256,
    page_count: document.page_count,
    completed_pages: completedPages,
    failed_pages: failedPages,
    pages,
  }, null, 2)}\n`);
  await writeFile(path.join(documentRoot, 'audit-local.json'), '{"status":"manual_review"}\n');
  await writeFile(
    path.join(root, '.cache/ocr-supervisor/watchdog-control.json'),
    '{"mode":"hold"}\n',
  );
  const retryPath = path.join(root, '.cache/ocr-supervisor/page-retries.json');
  let existingPageRetries = {};
  try {
    existingPageRetries = JSON.parse(await readFile(retryPath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await writeFile(retryPath, JSON.stringify({ ...existingPageRetries, ...pageRetries }));
  if (text !== null) {
    await mkdir(path.join(root, '.cache/text'), { recursive: true });
    await writeFile(path.join(root, '.cache/text', `${document.id}.txt`), text);
  }
}

test('planner selects only wholly untouched documents and reports every conflict', async (t) => {
  const { root, documents } = await createFixture(t, [
    { id: 'eligible', pageCount: 7 },
    { id: 'completed', state: { completed_pages: [1], pages: { 1: { status: 'complete' } } } },
    { id: 'failed', state: { failed_pages: { 1: { error: 'bad page' } } } },
    { id: 'document-retry' },
    { id: 'page-retry' },
    { id: 'artifact', artifact: true },
  ]);
  await writeFile(path.join(root, '.cache/ocr-supervisor/retries.json'), JSON.stringify({ 'document-retry': { attempts: 1 } }));
  await writeFile(path.join(root, '.cache/ocr-supervisor/page-retries.json'), JSON.stringify({ 'page-retry:2:paddle': { attempts: 1 } }));

  const manifest = await buildRemoteOcrOffloadManifest({
    projectRoot: root,
    generatedAt: '2026-07-16T00:00:00.000Z',
  });

  assert.equal(manifest.generated_at, '2026-07-16T00:00:00.000Z');
  assert.equal(manifest.quality_policy.citation_allowed, false);
  assert.equal(manifest.quality_policy.whole_document_atomic, true);
  assert.deepEqual(manifest.documents.map((document) => document.id), ['eligible']);
  assert.equal(manifest.counts.queue_documents, documents.length);
  assert.equal(manifest.counts.eligible_documents, 1);
  assert.equal(manifest.counts.eligible_pages, 7);
  assert.equal(manifest.documents[0].source_sha256, documents[0].source_sha256);
  assert.equal(manifest.documents[0].source_bytes, Buffer.byteLength('source-eligible'));
  assert.deepEqual(manifest.documents[0].planning_snapshot, {
    state_file_present: false,
    local_completed_pages: 0,
    local_failed_pages: 0,
    local_retry_conflicts: 0,
    local_production_artifact_conflicts: 0,
  });
  const excluded = new Map(manifest.excluded_documents.map((document) => [document.id, document.reasons]));
  assert.ok(excluded.get('completed').includes('LOCAL_COMPLETED_PAGES_NONZERO'));
  assert.ok(excluded.get('failed').includes('LOCAL_FAILED_PAGES_NONZERO'));
  assert.deepEqual(excluded.get('document-retry'), ['DOCUMENT_RETRY_CONFLICT']);
  assert.deepEqual(excluded.get('page-retry'), ['PAGE_RETRY_CONFLICT']);
  assert.deepEqual(excluded.get('artifact'), ['LOCAL_PRODUCTION_ARTIFACT_CONFLICT']);
});

test('manifest pins the audited runtime and explicit document-level import hard gates', async (t) => {
  const { root } = await createFixture(t, [{ id: 'a', pageCount: 2 }, { id: 'b', pageCount: 5 }]);
  const manifest = await buildRemoteOcrOffloadManifest({ projectRoot: root, limitDocuments: 1 });

  assert.deepEqual(manifest.runtime, PINNED_REMOTE_OCR_RUNTIME);
  assert.deepEqual(manifest.runtime, {
    pipeline: 'PaddleOCR-VL',
    pipeline_version: 'v1.6',
    model_sha256: 'f3ae46ec885050acf4b3d31944431e1fd90d50664fb09126af4a3c050ba14ee8',
    mmproj_sha256: '204d757d7610d9b3faab10d506d69e5b244e32bf765e2bab2d0167e65e0a058a',
    llama_commit: '12127defda4f41b7679cb2477a4b0d65ee6a0c8f',
    render_dpi: 240,
  });
  assert.equal(manifest.counts.eligible_documents, 2);
  assert.equal(manifest.counts.eligible_pages, 7);
  assert.equal(manifest.counts.selected_documents, 1);
  assert.equal(manifest.counts.selected_pages, 2);
  assert.deepEqual(manifest.documents.map((document) => document.id), ['a']);
  assert.equal(manifest.import_hard_gates.decision, 'reject_entire_document_if_any_gate_fails');
  assert.deepEqual(
    manifest.import_hard_gates.remote_document_revalidation.every_page_requires_valid_lowercase_sha256,
    ['result_json_sha256', 'content_markdown_sha256', 'rendered_image_sha256'],
  );
  assert.equal(manifest.import_hard_gates.local_revalidation_after_planning.completed_pages_must_equal, 0);
  assert.equal(manifest.import_hard_gates.local_revalidation_after_planning.source_sha256_must_equal_planned_value, true);
});

test('planner requires exact per-document opt-in and snapshots existing local trees, text, and retry ledgers', async (t) => {
  const { root, documents } = await createFixture(t, [
    { id: 'partial', pageCount: 3 },
    { id: 'complete-local', pageCount: 2 },
    { id: 'untouched', pageCount: 4 },
  ]);
  await installLocalProgress(root, documents[0], {
    completedPages: [1],
    failedPages: { 2: { error: 'content failure' } },
    pageRetries: {
      'partial:2:paddle': {
        attempts: 5,
        quarantined: true,
      },
    },
    text: 'local partial text\n',
  });
  await installLocalProgress(root, documents[1], {
    completedPages: [1, 2],
    text: 'local complete text\n',
  });

  const manifest = await buildRemoteOcrOffloadManifest({
    projectRoot: root,
    reprocessDocuments: ['partial', 'complete-local'],
    generatedAt: '2026-07-16T00:00:00.000Z',
  });
  assert.equal(manifest.planning_mode, 'explicit_existing_local_document_reprocess_read_only');
  assert.deepEqual(manifest.documents.map((document) => document.id), ['partial', 'complete-local']);
  assert.equal(manifest.counts.explicitly_reprocessed_documents, 2);
  assert.equal(manifest.counts.explicitly_reprocessed_local_completed_pages, 3);
  assert.equal(
    manifest.import_hard_gates.local_revalidation_after_planning.original_document_tree_must_not_be_deleted,
    true,
  );
  const partial = manifest.documents[0].planning_snapshot;
  assert.equal(partial.mode, 'replace_existing_local_document');
  assert.deepEqual(partial.completion.completed_pages, [1]);
  assert.deepEqual(partial.completion.failed_pages, [2]);
  assert.deepEqual(partial.retry_ledger.pages.keys, ['partial:2:paddle']);
  assert.equal(partial.text.exists, true);
  assert.match(partial.document_tree.tree_sha256, /^[a-f0-9]{64}$/);
  assert.match(partial.snapshot_sha256, /^[a-f0-9]{64}$/);
  const excluded = new Map(manifest.excluded_documents.map((document) => [document.id, document.reasons]));
  assert.deepEqual(excluded.get('untouched'), ['NOT_EXPLICITLY_SELECTED_FOR_REPROCESS']);

  await assert.rejects(
    buildRemoteOcrOffloadManifest({
      projectRoot: root,
      reprocessDocuments: ['partial', 'partial'],
    }),
    /duplicate reprocess document id/,
  );
  await assert.rejects(
    buildRemoteOcrOffloadManifest({
      projectRoot: root,
      reprocessDocuments: ['missing'],
    }),
    /absent from the OCR queue/,
  );
  await assert.rejects(
    buildRemoteOcrOffloadManifest({
      projectRoot: root,
      reprocessDocuments: ['partial'],
      limitDocuments: 1,
    }),
    /cannot be combined/,
  );
});

test('planner fails closed when a candidate source no longer matches the queue checksum', async (t) => {
  const { root } = await createFixture(t, [{ id: 'changed' }]);
  await writeFile(path.join(root, '.cache/sources/changed.pdf'), 'changed-after-queue');
  await assert.rejects(
    buildRemoteOcrOffloadManifest({ projectRoot: root }),
    /changed: source SHA-256 differs from data\/ocr-queue\.json/,
  );
});

test('present null, non-object, malformed, or unsupported OCR state is recorded as a conflict', async (t) => {
  const { root } = await createFixture(t, [
    { id: 'missing-state' },
    { id: 'null-state', state: null },
    { id: 'array-state', state: [] },
    { id: 'unsupported-schema', state: { schema_version: 2 } },
    { id: 'malformed-state', state: {} },
  ]);
  await writeFile(path.join(root, '.cache/ocr-production/malformed-state/state.json'), '{');

  const manifest = await buildRemoteOcrOffloadManifest({ projectRoot: root });
  assert.deepEqual(manifest.documents.map((document) => document.id), ['missing-state']);
  const excluded = new Map(manifest.excluded_documents.map((document) => [document.id, document.reasons]));
  assert.deepEqual(excluded.get('null-state'), ['STATE_SCHEMA_INVALID']);
  assert.deepEqual(excluded.get('array-state'), ['STATE_SCHEMA_INVALID']);
  assert.ok(excluded.get('unsupported-schema').includes('STATE_SCHEMA_VERSION_INVALID'));
  assert.deepEqual(excluded.get('malformed-state'), ['STATE_JSON_INVALID']);
});

test('planner rejects queue document ids outside the runner safe-id contract', async (t) => {
  const { root } = await createFixture(t, [{ id: 'eligible' }]);
  const queuePath = path.join(root, 'data/ocr-queue.json');
  const queue = JSON.parse(await readFile(queuePath, 'utf8'));
  for (const unsafeId of ['../escape', '.', '..', 'unsafe/id', 'unsafe id']) {
    queue.documents[0].id = unsafeId;
    await writeFile(queuePath, JSON.stringify(queue));
    await assert.rejects(
      buildRemoteOcrOffloadManifest({ projectRoot: root }),
      /unsafe queue document id/,
    );
  }
});

test('planner rejects source and OCR-state parent symlink escapes', async (t) => {
  const sourceFixture = await createFixture(t, [{ id: 'source-link' }]);
  const externalSourceRoot = await mkdtemp(path.join(os.tmpdir(), 'curriculum-offload-external-source-'));
  t.after(() => rm(externalSourceRoot, { recursive: true, force: true }));
  const externalSource = path.join(externalSourceRoot, 'source-link.pdf');
  await writeFile(externalSource, 'source-source-link');
  await rm(path.join(sourceFixture.root, '.cache/sources/source-link.pdf'));
  await symlink(externalSource, path.join(sourceFixture.root, '.cache/sources/source-link.pdf'));
  await assert.rejects(
    buildRemoteOcrOffloadManifest({ projectRoot: sourceFixture.root }),
    /source PDF unavailable.*escapes the project root through a symlink/,
  );

  const stateFixture = await createFixture(t, [{ id: 'state-link' }]);
  const externalStateRoot = await mkdtemp(path.join(os.tmpdir(), 'curriculum-offload-external-state-'));
  t.after(() => rm(externalStateRoot, { recursive: true, force: true }));
  await symlink(externalStateRoot, path.join(stateFixture.root, '.cache/ocr-production/state-link'));
  await assert.rejects(
    buildRemoteOcrOffloadManifest({ projectRoot: stateFixture.root }),
    /OCR production root escapes the project root through a symlink/,
  );
});

test('planner rejects supervisor and queue aliases outside their expected project paths', async (t) => {
  const supervisorFixture = await createFixture(t, [{ id: 'eligible' }]);
  await symlink(
    path.join(supervisorFixture.root, 'data/ocr-queue.json'),
    path.join(supervisorFixture.root, '.cache/ocr-supervisor/retries.json'),
  );
  await assert.rejects(
    buildRemoteOcrOffloadManifest({ projectRoot: supervisorFixture.root }),
    /ocr-supervisor\/retries\.json escapes its expected cache root through a symlink/,
  );

  const queueFixture = await createFixture(t, [{ id: 'eligible' }]);
  const externalDataRoot = await mkdtemp(path.join(os.tmpdir(), 'curriculum-offload-external-data-'));
  t.after(() => rm(externalDataRoot, { recursive: true, force: true }));
  await writeFile(
    path.join(externalDataRoot, 'ocr-queue.json'),
    await readFile(path.join(queueFixture.root, 'data/ocr-queue.json')),
  );
  await rm(path.join(queueFixture.root, 'data'), { recursive: true });
  await symlink(externalDataRoot, path.join(queueFixture.root, 'data'));
  await assert.rejects(
    buildRemoteOcrOffloadManifest({ projectRoot: queueFixture.root }),
    /data(?:\/ocr-queue\.json)? escapes the project root through a symlink/,
  );
});

test('explicit output is atomic and cannot target OCR state or the queue', async (t) => {
  const { root } = await createFixture(t, [{ id: 'eligible' }]);
  const manifest = await buildRemoteOcrOffloadManifest({ projectRoot: root });
  const output = path.join(root, '.cache/remote-ocr-offload/manifest.json');
  assert.equal(await writeRemoteOcrOffloadManifest(output, manifest, { projectRoot: root }), output);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), manifest);

  await assert.rejects(
    writeRemoteOcrOffloadManifest(path.join(root, '.cache/ocr-production/manifest.json'), manifest, { projectRoot: root }),
    /Refusing to write a planning manifest inside OCR production/,
  );
  await assert.rejects(
    writeRemoteOcrOffloadManifest(path.join(root, 'data/ocr-queue.json'), manifest, { projectRoot: root }),
    /Refusing to overwrite data\/ocr-queue\.json/,
  );

  await symlink(path.join(root, 'data/ocr-queue.json'), path.join(root, '.cache/queue-alias.json'));
  await assert.rejects(
    writeRemoteOcrOffloadManifest(path.join(root, '.cache/queue-alias.json'), manifest, { projectRoot: root }),
    /Refusing to overwrite data\/ocr-queue\.json through an alias/,
  );

  await symlink(path.join(root, '.cache/ocr-production'), path.join(root, '.cache/protected-alias'));
  await assert.rejects(
    writeRemoteOcrOffloadManifest(path.join(root, '.cache/protected-alias/manifest.json'), manifest, { projectRoot: root }),
    /alias into protected OCR state/,
  );

  const externalOutputRoot = await mkdtemp(path.join(os.tmpdir(), 'curriculum-offload-external-output-'));
  t.after(() => rm(externalOutputRoot, { recursive: true, force: true }));
  await symlink(externalOutputRoot, path.join(root, '.cache/external-output'));
  await assert.rejects(
    writeRemoteOcrOffloadManifest(path.join(root, '.cache/external-output/manifest.json'), manifest, { projectRoot: root }),
    /manifest output escapes the project root through a symlink/,
  );
});
