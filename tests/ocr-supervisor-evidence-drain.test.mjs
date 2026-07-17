import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  evidenceDrainDecision,
  evidenceExecutionPolicy,
  inspectEvidenceScopePrimaryReadiness,
  selectEvidenceBatch,
  spawnLoggedProcess,
  validateEvidenceManifestScope,
} from '../scripts/ocr-supervisor.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0
      ? resolve()
      : reject(new Error(`child exited ${code ?? signal}`)));
  });
}

async function waitForChildSettled(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    child.once('error', resolve);
    child.once('exit', resolve);
  });
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('condition did not become true before timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function evidenceFixture(t, { completed = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ocr-evidence-drain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primaryRoot = path.join(root, 'primary');
  const witnessBaseRoot = path.join(root, 'witness');
  const document = {
    id: 'allowed-doc',
    page_count: 1,
    source_sha256: 'a'.repeat(64),
    subject: '语文',
  };
  const content = '# OCR text\n';
  const result = '{"text":"OCR text"}\n';
  const pageRoot = path.join(primaryRoot, document.id, 'pages', '0001');
  await mkdir(pageRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(pageRoot, 'content.md'), content),
    writeFile(path.join(pageRoot, 'result.json'), result),
    writeFile(path.join(primaryRoot, document.id, 'state.json'), `${JSON.stringify({
      completed_pages: completed ? [1] : [],
      failed_pages: {},
      pages: completed ? {
        1: {
          content_markdown_sha256: sha256(content),
          result_json_sha256: sha256(result),
        },
      } : {},
    })}\n`),
  ]);
  return {
    root,
    document,
    primaryRoot,
    witnessBaseRoot,
    pageRoot,
    content,
    result,
  };
}

async function writeWitness(fixture) {
  const image = Buffer.from('rendered page');
  const imageDir = path.join(fixture.witnessBaseRoot, fixture.document.id, 'images');
  const visionDir = path.join(fixture.witnessBaseRoot, fixture.document.id, 'vision');
  await Promise.all([mkdir(imageDir, { recursive: true }), mkdir(visionDir, { recursive: true })]);
  await Promise.all([
    writeFile(path.join(imageDir, 'page-001.png'), image),
    writeFile(path.join(visionDir, 'page-001.json'), `${JSON.stringify({
      schema_version: 2,
      file: 'page-001.png',
      lines: [{ text: 'OCR text', confidence: 0.99 }],
      document_id: fixture.document.id,
      physical_pdf_page: 1,
      source_pdf_sha256: fixture.document.source_sha256,
      rendered_image_sha256: sha256(image),
      engine: 'Apple Vision VNRecognizeTextRequest accurate zh-Hans+en-US',
      engine_configuration: {
        recognition_level: 'accurate',
        languages: ['zh-Hans', 'en-US'],
        language_correction: true,
        minimum_text_height: 0.008,
      },
      citation_allowed: false,
    })}\n`),
  ]);
}

async function writeAudit(fixture) {
  const auditDir = path.join(fixture.witnessBaseRoot, fixture.document.id, 'audits');
  await mkdir(auditDir, { recursive: true });
  await writeFile(path.join(auditDir, 'audit-0001-0001.json'), `${JSON.stringify({
    schema_version: 1,
    page_range: [1, 1],
    pages: [{
      page: 1,
      primary_sha256: sha256(fixture.content),
      witness_sha256: sha256('OCR text'),
      gate: 'manual_image_review_required',
    }],
  })}\n`);
}

test('evidence manifest scope is exact, non-citable, and cannot include an unknown or drifted document', () => {
  const queueDocuments = [
    { id: 'allowed-doc', page_count: 1, source_sha256: 'a'.repeat(64) },
    { id: 'outside-doc', page_count: 2, source_sha256: 'b'.repeat(64) },
  ];
  const manifest = {
    schema_version: 1,
    manifest_type: 'curriculum_remote_whole_document_ocr_offload_plan',
    counts: { selected_documents: 1 },
    documents: [{
      id: 'allowed-doc',
      page_count: 1,
      source_sha256: 'a'.repeat(64),
      citation_allowed: false,
    }],
  };
  assert.deepEqual(validateEvidenceManifestScope(manifest, queueDocuments), [queueDocuments[0]]);
  assert.throws(
    () => validateEvidenceManifestScope({
      ...manifest,
      documents: [{ ...manifest.documents[0], id: 'outside-manifest' }],
    }, queueDocuments),
    /document identity is invalid/,
  );
  assert.throws(
    () => validateEvidenceManifestScope({
      ...manifest,
      documents: [{ ...manifest.documents[0], citation_allowed: true }],
    }, queueDocuments),
    /document identity is invalid/,
  );
});

test('evidence scheduler stays inside scope and advances only witness then audit for completed valid pages', async (t) => {
  const fixture = await evidenceFixture(t);
  let selected = await selectEvidenceBatch([fixture.document], {
    primaryRoot: fixture.primaryRoot,
    witnessBaseRoot: fixture.witnessBaseRoot,
  });
  assert.equal(selected.mode, 'witness_backfill');
  assert.equal(selected.document.id, 'allowed-doc');
  assert.deepEqual(selected.pages, [1]);

  await writeWitness(fixture);
  selected = await selectEvidenceBatch([fixture.document], {
    primaryRoot: fixture.primaryRoot,
    witnessBaseRoot: fixture.witnessBaseRoot,
  });
  assert.equal(selected.mode, 'audit_backfill');
  assert.deepEqual(selected.pages, [1]);

  await writeAudit(fixture);
  selected = await selectEvidenceBatch([fixture.document], {
    primaryRoot: fixture.primaryRoot,
    witnessBaseRoot: fixture.witnessBaseRoot,
  });
  assert.equal(selected, null);
});

test('evidence scheduler blocks rather than entering new OCR, primary recovery, or a delayed evidence retry', async (t) => {
  const incomplete = await evidenceFixture(t, { completed: false });
  assert.equal((await inspectEvidenceScopePrimaryReadiness([incomplete.document], {
    primaryRoot: incomplete.primaryRoot,
  })).mode, 'new_ocr');

  const corrupt = await evidenceFixture(t);
  await writeFile(path.join(corrupt.pageRoot, 'content.md'), '# drifted\n');
  assert.equal((await selectEvidenceBatch([corrupt.document], {
    primaryRoot: corrupt.primaryRoot,
    witnessBaseRoot: corrupt.witnessBaseRoot,
  })).mode, 'primary_recovery');

  const blocked = await evidenceFixture(t);
  const pageRetryRecords = {
    'allowed-doc:1:vision': {
      attempts: 1,
      quarantined: false,
      next_retry_at: '2999-01-01T00:00:00.000Z',
    },
  };
  assert.equal((await selectEvidenceBatch([blocked.document], {
    primaryRoot: blocked.primaryRoot,
    witnessBaseRoot: blocked.witnessBaseRoot,
    pageRetryRecords,
  })).mode, 'evidence_blocked');
  assert.equal((await selectEvidenceBatch([blocked.document], {
    primaryRoot: blocked.primaryRoot,
    witnessBaseRoot: blocked.witnessBaseRoot,
    pageRetryRecords,
    retryOverride: true,
    limit: 1,
  })).mode, 'witness_backfill');
});

test('evidence execution policy cannot launch Paddle, llama, or derived builds', () => {
  assert.deepEqual(evidenceExecutionPolicy('witness_backfill'), {
    renderVision: true,
    runPrimaryOcr: false,
    buildDerivedArtifacts: false,
  });
  assert.deepEqual(evidenceExecutionPolicy('audit_backfill'), {
    renderVision: false,
    runPrimaryOcr: false,
    buildDerivedArtifacts: false,
  });
  for (const mode of ['primary_recovery', 'new_ocr', 'full_recovery', 'witness_recovery']) {
    assert.throws(() => evidenceExecutionPolicy(mode), /refuses OCR mode/);
  }
});

test('evidence drain completion, interruption, disk, unsafe work, and systematic Vision failures are fail-closed', () => {
  assert.equal(evidenceDrainDecision({ selection: null }).action, 'complete');
  assert.deepEqual(evidenceDrainDecision({ interrupted: true }), {
    action: 'stop',
    status: 'interrupted',
    code: 'RUN_INTERRUPTED',
    exitCode: 130,
  });
  assert.equal(evidenceDrainDecision({
    selection: { mode: 'witness_backfill', pages: [1] },
    freeGiB: 49.9,
  }).code, 'EVIDENCE_DISK_WARNING');
  assert.equal(evidenceDrainDecision({
    selection: { mode: 'new_ocr', pages: [2] },
  }).code, 'EVIDENCE_PRIMARY_WORK_REQUIRED');
  const systematic = evidenceDrainDecision({
    selection: { mode: 'witness_backfill', pages: [1, 2] },
    pageFailures: [
      { page: 1, stage: 'vision' },
      { page: 2, stage: 'vision' },
    ],
  });
  assert.equal(systematic.action, 'stop');
  assert.equal(systematic.code, 'EVIDENCE_VISION_BATCH_FAILED');
  assert.equal(systematic.systematic_vision_failure, true);
});

test('Apple Vision pipe mode buffers without live-child file writes and flushes only after exit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ocr-logged-child-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const pipeLogPath = path.join(root, 'pipe.log');
  const logEvents = [];
  const openLog = async (logPath, flags) => {
    logEvents.push(`open:${flags}`);
    const handle = await open(logPath, flags);
    return {
      fd: handle.fd,
      write: async (value) => {
        logEvents.push(`write:${value.length}`);
        return handle.write(value);
      },
      close: async () => {
        logEvents.push('close');
        return handle.close();
      },
    };
  };
  const piped = spawnLoggedProcess(process.execPath, [
    '-e',
    "process.stdout.write('vision-out\\n'); setTimeout(() => process.stderr.write('vision-err\\n'), 500)",
  ], {
    cwd: root,
    logPath: pipeLogPath,
    openLog,
    pipeOutput: true,
  });
  assert.ok(piped.child.stdout);
  assert.ok(piped.child.stderr);
  assert.deepEqual(logEvents, [], 'pipe child must be spawned before the log is opened');
  await waitUntil(() => piped.bufferedBytes() > 0);
  assert.equal(piped.child.exitCode, null);
  assert.deepEqual(logEvents, [], 'no real log FileHandle may exist while Vision is running');
  await assert.rejects(stat(pipeLogPath), { code: 'ENOENT' });
  await waitForChild(piped.child);
  assert.deepEqual(logEvents, [], 'child exit alone must not open the log before both streams and ordered flush');
  await assert.rejects(stat(pipeLogPath), { code: 'ENOENT' });
  await piped.flushOutput();
  assert.equal(logEvents[0], 'open:a');
  assert.match(logEvents[1], /^write:\d+$/);
  assert.equal(logEvents[2], 'close');
  assert.equal(logEvents.length, 3);
  const pipeText = await readFile(pipeLogPath, 'utf8');
  assert.match(pipeText, /vision-out/);
  assert.match(pipeText, /vision-err/);

  const fdLogPath = path.join(root, 'fd.log');
  const fdLog = await open(fdLogPath, 'a');
  const regular = spawnLoggedProcess(process.execPath, [
    '-e',
    "process.stdout.write('ordinary-out\\n'); setTimeout(() => process.stderr.write('ordinary-err\\n'), 500)",
  ], { cwd: root, logHandle: fdLog, pipeOutput: false });
  assert.equal(regular.child.stdout, null);
  assert.equal(regular.child.stderr, null);
  await waitUntil(async () => (await stat(fdLogPath)).size > 0);
  assert.equal(regular.child.exitCode, null, 'ordinary regular-fd logging remains live during child execution');
  await waitForChild(regular.child);
  await regular.flushOutput();
  await fdLog.close();
  const fdText = await readFile(fdLogPath, 'utf8');
  assert.match(fdText, /ordinary-out/);
  assert.match(fdText, /ordinary-err/);
});

test('Apple Vision post-exit capture enforces its byte limit and fails closed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ocr-logged-child-limit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'overflow.log');
  const limited = spawnLoggedProcess(process.execPath, [
    '-e',
    "process.stdout.write('x'.repeat(4096)); setTimeout(() => {}, 10000)",
  ], {
    cwd: root,
    logPath,
    pipeOutput: true,
    pipeBufferLimitBytes: 128,
  });
  await waitUntil(() => limited.captureError() !== null);
  await assert.rejects(stat(logPath), { code: 'ENOENT' });
  await waitForChildSettled(limited.child);
  await assert.rejects(
    limited.flushOutput(),
    (error) => error.code === 'CHILD_OUTPUT_BUFFER_LIMIT'
      && error.buffer_limit_bytes === 128,
  );
  const written = await readFile(logPath);
  assert.ok(written.length >= 128);
  assert.ok(written.length < 512);
  assert.match(written.toString('utf8'), /CHILD_OUTPUT_BUFFER_LIMIT/);
});

test('both Apple Vision batch and page retry calls opt into pipe logging while Paddle keeps regular-fd logging', async () => {
  const source = await readFile(new URL('../scripts/ocr-supervisor.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /independent_apple_vision_\$\{pass\.pass_id\.replaceAll\('-', '_'\)\}[\s\S]*visionBatchLimits[\s\S]*pipeOutput: true,[\s\S]*pipeBufferLimitBytes: visionPipeBufferLimitBytes/,
  );
  assert.match(
    source,
    /independent_apple_vision_page_retry_\$\{pass\.pass_id\.replaceAll\('-', '_'\)\}[\s\S]*visionPageRetryLimits[\s\S]*pipeOutput: true,[\s\S]*pipeBufferLimitBytes: visionPipeBufferLimitBytes/,
  );
  const paddleStart = source.indexOf("const paddleResult = await runLogged(pythonPath");
  const paddleEnd = source.indexOf('run.paddle_exit_code = paddleResult.code;', paddleStart);
  assert.ok(paddleStart >= 0 && paddleEnd > paddleStart);
  assert.doesNotMatch(source.slice(paddleStart, paddleEnd), /pipeOutput/);
  assert.match(source, /const log = pipeOutput \? null : await open\(logPath, 'a'\);[\s\S]*const child = spawn\(executable, args/);
  assert.match(source, /await outputEnded;[\s\S]*const lazyLog = await openLog\(logPath, 'a'\);[\s\S]*await lazyLog\.write[\s\S]*await lazyLog\.close/);
  assert.match(source, /once\(\{ preselected: selection, evidenceOnly: true \}\)/);
  assert.match(source, /if \(!evidenceOnly\) await collectStatus\(\)\.catch/);
});
