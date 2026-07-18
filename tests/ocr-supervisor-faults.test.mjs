import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildVisionWitnessSidecar,
  classifyPaddleExitOne,
  conceptCandidateCompatible,
  discardVisionOutputs,
  prepareAuditBackfillWitness,
  readFreshVisionOutput,
  retryReconcileBusyReasons,
  selectAuditBackfillPages,
  selectPrimaryRecoveryPages,
  visionInvocationArgs,
} from '../scripts/ocr-supervisor.mjs';
import {
  classifyHealth,
  continuousDrainDecision,
  missingCompletedWitnessPages,
  nextPageRetry,
  ocrExecutionPolicy,
  paddleLogIndicatesRuntimeFailure,
  paddleRuntimeFailure,
  pageRetryKey,
  retryBlocksPage,
  selectPendingPages,
  visionWitnessPlan,
  visionWitnessProfileSha,
  witnessRecordValid,
} from '../scripts/lib/ocr-supervisor-state.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const visionProvenance = {
  schema_version: 1,
  framework: 'Apple Vision',
  request_api: 'VNRecognizeTextRequest',
  framework_distribution: 'macOS bundled',
  execution_binary: '/usr/bin/swift',
  swift_version: 'Swift version 6.0',
  script_path: 'scripts/vision-ocr-batch.swift',
  script_sha256: 'd'.repeat(64),
  renderer: {
    name: 'MuPDF mutool 1.28.0',
    binary: '/opt/homebrew/bin/mutool',
    sha256: 'e'.repeat(64),
  },
  os: {
    product_name: 'macOS',
    product_version: '15.5',
    build_version: '24F74',
    platform: 'darwin',
    architecture: 'arm64',
    kernel_type: 'Darwin',
    kernel_release: '24.5.0',
    kernel_version: 'Darwin Kernel Version 24.5.0',
  },
};

function witnessProfileExpected(profile) {
  return {
    witnessProfile: profile,
    witnessProfileSha: visionWitnessProfileSha(profile),
    allowLegacyDefault: profile.profile_id === 'apple-vision-default-v1',
  };
}

async function primaryFixture(t) {
  const primaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ocr-primary-recovery-'));
  t.after(() => rm(primaryRoot, { recursive: true, force: true }));
  const pageRoot = path.join(primaryRoot, 'doc', 'pages', '0001');
  await mkdir(pageRoot, { recursive: true });
  const content = '# Original OCR\n';
  const result = '{"text":"Original OCR"}\n';
  await Promise.all([
    writeFile(path.join(pageRoot, 'content.md'), content),
    writeFile(path.join(pageRoot, 'result.json'), result),
  ]);
  return {
    primaryRoot,
    pageRoot,
    document: { id: 'doc', page_count: 1 },
    state: {
      completed_pages: [1],
      pages: {
        1: {
          content_markdown_sha256: sha256(content),
          result_json_sha256: sha256(result),
        },
      },
    },
  };
}

async function auditFixture(t, { audit = 'valid' } = {}) {
  const fixture = await primaryFixture(t);
  fixture.document.source_sha256 = 'a'.repeat(64);
  const witnessBaseRoot = await mkdtemp(path.join(os.tmpdir(), 'ocr-audit-backfill-'));
  t.after(() => rm(witnessBaseRoot, { recursive: true, force: true }));
  const imageDir = path.join(witnessBaseRoot, 'doc', 'images');
  const visionDir = path.join(witnessBaseRoot, 'doc', 'vision');
  const auditDir = path.join(witnessBaseRoot, 'doc', 'audits');
  await Promise.all([
    mkdir(imageDir, { recursive: true }),
    mkdir(visionDir, { recursive: true }),
    mkdir(auditDir, { recursive: true }),
  ]);
  const image = Buffer.from('rendered-page-1');
  const witnessText = 'Original OCR';
  const imagePath = path.join(imageDir, 'page-001.png');
  const witnessPath = path.join(visionDir, 'page-001.json');
  await Promise.all([
    writeFile(imagePath, image),
    writeFile(witnessPath, `${JSON.stringify({
      schema_version: 2,
      file: 'page-001.png',
      lines: [{ text: witnessText, confidence: 0.99 }],
      document_id: 'doc',
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
  const auditPath = path.join(auditDir, 'audit-0001-0001.json');
  if (audit !== 'missing') {
    const primarySha = audit === 'stale' ? 'b'.repeat(64) : fixture.state.pages[1].content_markdown_sha256;
    const witnessSha = audit === 'stale-witness' ? 'c'.repeat(64) : sha256(witnessText);
    await writeFile(auditPath, `${JSON.stringify({
      schema_version: 1,
      page_range: [1, 1],
      pages: [{
        page: 1,
        primary_sha256: primarySha,
        witness_sha256: witnessSha,
        gate: 'manual_image_review_required',
      }],
    })}\n`);
  }
  return { ...fixture, witnessBaseRoot, imagePath, witnessPath, auditPath };
}

test('one failed page does not block later eligible pages', () => {
  const now = Date.parse('2026-07-15T08:00:00Z');
  const pageRetries = {
    [pageRetryKey('doc', 1, 'vision')]: {
      attempts: 1,
      next_retry_at: '2026-07-15T08:10:00Z',
      quarantined: false,
    },
  };
  assert.deepEqual(selectPendingPages({
    pageCount: 6,
    completedPages: [],
    failedPages: {},
    pageRetries,
    documentId: 'doc',
    limit: 3,
    now,
  }), [2, 3, 4]);
});

test('page retry escalates independently and quarantines only that page-stage key', () => {
  const now = Date.parse('2026-07-15T08:00:00Z');
  let record;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    record = nextPageRetry(record, { stage: 'vision', code: 'VN:1', name: 'VisionError', message: 'transient' }, { now: now + attempt * 60_000 });
  }
  assert.equal(record.attempts, 5);
  assert.equal(record.quarantined, true);
  assert.equal(record.next_retry_at, null);
  assert.equal(retryBlocksPage({ [pageRetryKey('doc', 1, 'vision')]: record }, 'doc', 1, now), true);
  assert.equal(retryBlocksPage({ [pageRetryKey('doc', 1, 'vision')]: record }, 'doc', 2, now), false);
});

test('a failed Paddle process is a runtime incident and never consumes a page retry', () => {
  const now = Date.parse('2026-07-16T01:00:00Z');
  const runtime = paddleRuntimeFailure({ signal: 'SIGKILL', message: 'paddle_ocr exited SIGKILL' }, { now });
  assert.deepEqual(runtime, {
    code: 'PADDLE_RUNTIME_UNAVAILABLE',
    scope: 'runtime',
    cause_code: 'SIGKILL',
    retry_at: '2026-07-16T01:05:00.000Z',
    message: 'paddle_ocr exited SIGKILL',
  });
  assert.equal(runtime.code === 'PADDLE_PAGE_FAILED', false);
  assert.equal(paddleLogIndicatesRuntimeFailure('ImportError: dlopen(/tmp/math.so): library load denied by system policy'), true);
  assert.equal(paddleLogIndicatesRuntimeFailure("NameError: name 'libpaddle' is not defined"), true);
  assert.equal(paddleLogIndicatesRuntimeFailure('PaddlePageError: model output did not match peg-native format'), false);
});

test('Paddle exit one is runtime without page state progress but preserves structured page failures', () => {
  const noProgress = classifyPaddleExitOne({
    exitCode: 1,
    logText: 'ModuleNotFoundError: No module named paddleocr',
    pages: [1],
    beforeState: {},
    afterState: {},
  });
  assert.equal(noProgress.runtimeFailure, true);
  assert.equal(noProgress.pageProgressObserved, false);
  assert.deepEqual(noProgress.newlyCompletedPages, []);
  assert.deepEqual(noProgress.structuredFailurePages, []);

  const completedPage = {
    physical_pdf_page: 1,
    content_markdown_sha256: 'a'.repeat(64),
    result_json_sha256: 'b'.repeat(64),
  };
  const transitionOnly = classifyPaddleExitOne({
    exitCode: 1,
    pages: [1],
    beforeState: { completed_pages: [1], pages: { 1: completedPage } },
    afterState: { completed_pages: [], pages: {} },
  });
  assert.equal(transitionOnly.runtimeFailure, true);
  assert.equal(transitionOnly.pageProgressObserved, false);
  assert.deepEqual(transitionOnly.newlyCompletedPages, []);

  const validCompletion = classifyPaddleExitOne({
    exitCode: 1,
    pages: [1],
    beforeState: { completed_pages: [], pages: {} },
    afterState: { completed_pages: [1], pages: { 1: completedPage } },
  });
  assert.equal(validCompletion.runtimeFailure, false);
  assert.equal(validCompletion.pageProgressObserved, true);
  assert.deepEqual(validCompletion.newlyCompletedPages, [1]);

  const invalidCompletion = classifyPaddleExitOne({
    exitCode: 1,
    pages: [1],
    beforeState: { completed_pages: [], pages: {} },
    afterState: { completed_pages: [1], pages: { 1: { physical_pdf_page: 1 } } },
  });
  assert.equal(invalidCompletion.runtimeFailure, true);
  assert.equal(invalidCompletion.pageProgressObserved, false);
  assert.deepEqual(invalidCompletion.newlyCompletedPages, []);

  const pageFailure = classifyPaddleExitOne({
    exitCode: 1,
    pages: [1, 2],
    beforeState: { failed_pages: {} },
    afterState: { failed_pages: { 1: { error: 'model output did not match peg-native format' } } },
  });
  assert.equal(pageFailure.runtimeFailure, false);
  assert.equal(pageFailure.pageProgressObserved, true);
  assert.deepEqual(pageFailure.structuredFailurePages, [1]);

  const mixedRuntime = classifyPaddleExitOne({
    exitCode: 1,
    logText: 'ImportError: dlopen(/tmp/math.so): library load denied by system policy',
    pages: [1],
    beforeState: {},
    afterState: { failed_pages: { 1: { error: 'real page error' } } },
  });
  assert.equal(mixedRuntime.runtimeFailure, true);
  assert.deepEqual(mixedRuntime.structuredFailurePages, [1]);
});

test('retry reconciliation refuses external batch, drain, and watchdog child ownership', () => {
  assert.deepEqual(retryReconcileBusyReasons({ runtime: { lock_active: true, lock_owner: { pid: 20 } } }, 10), ['batch_owner_active']);
  assert.deepEqual(retryReconcileBusyReasons({ runtime: { drain_active: true } }, 10), ['drain_owner_active']);
  assert.deepEqual(retryReconcileBusyReasons({ runtime: { watchdog_child_active: true } }, 10), ['watchdog_child_active']);
  assert.deepEqual(retryReconcileBusyReasons({
    runtime: { lock_active: true, lock_owner: { pid: 10 }, drain_active: false, watchdog_child_active: false },
  }, 10), []);
});

test('witness sidecar is rejected when document, page, PDF, image, or file identity drifts', () => {
  const record = {
    file: 'page-001.png',
    lines: [],
    document_id: 'doc',
    physical_pdf_page: 1,
    source_pdf_sha256: 'a'.repeat(64),
    rendered_image_sha256: 'b'.repeat(64),
    engine: 'Apple Vision',
    citation_allowed: false,
  };
  const expected = { file: 'page-001.png', documentId: 'doc', page: 1, pdfSha: 'a'.repeat(64), imageSha: 'b'.repeat(64) };
  assert.equal(witnessRecordValid(record, expected), true);
  assert.equal(witnessRecordValid({ ...record, physical_pdf_page: 2 }, expected), false);
  assert.equal(witnessRecordValid({ ...record, source_pdf_sha256: 'other' }, expected), false);
  assert.equal(witnessRecordValid({ ...record, rendered_image_sha256: 'other' }, expected), false);
  assert.equal(witnessRecordValid({ ...record, rendered_image_sha256: null }, {}), false);
  assert.equal(witnessRecordValid({ ...record, error: 'nilError' }, expected), false);
});

test('Vision language routing keeps Chinese as canonical and adds a Russian supplemental pass only for Russian documents', () => {
  const defaultProfile = visionWitnessPlan({ subject: '语文' });
  assert.deepEqual(defaultProfile.passes, [
    { pass_id: 'zh-primary', role: 'canonical', languages: ['zh-Hans', 'en-US'] },
  ]);
  assert.equal(defaultProfile.canonical_pass_id, 'zh-primary');

  const russianProfile = visionWitnessPlan({ subject: '俄语' });
  assert.deepEqual(russianProfile.passes, [
    { pass_id: 'zh-primary', role: 'canonical', languages: ['zh-Hans', 'en-US'] },
    { pass_id: 'ru-supplement', role: 'supplemental', languages: ['ru-RU', 'zh-Hans', 'en-US'] },
  ]);
  assert.equal(russianProfile.canonical_pass_id, 'zh-primary');
  assert.notEqual(visionWitnessProfileSha(defaultProfile), visionWitnessProfileSha(russianProfile));
});

test('legacy default-language witnesses remain readable but cannot impersonate a signed profile or satisfy Russian evidence', () => {
  const legacy = {
    schema_version: 2,
    file: 'page-001.png',
    lines: [{ text: '旧见证', confidence: 0.9 }],
    document_id: 'doc',
    physical_pdf_page: 1,
    source_pdf_sha256: 'a'.repeat(64),
    rendered_image_sha256: 'b'.repeat(64),
    engine: 'Apple Vision VNRecognizeTextRequest accurate zh-Hans+en-US',
    engine_configuration: {
      recognition_level: 'accurate',
      languages: ['zh-Hans', 'en-US'],
      language_correction: true,
      minimum_text_height: 0.008,
    },
    citation_allowed: false,
  };
  assert.equal(witnessRecordValid(legacy, witnessProfileExpected(visionWitnessPlan({ subject: '语文' }))), true);
  assert.equal(witnessRecordValid(legacy, witnessProfileExpected(visionWitnessPlan({ subject: '俄语' }))), false);
  assert.equal(witnessRecordValid({
    ...legacy,
    engine_provenance: visionProvenance,
  }, witnessProfileExpected(visionWitnessPlan({ subject: '语文' }))), false);
  assert.equal(witnessRecordValid({
    ...legacy,
    engine_configuration: { ...legacy.engine_configuration, languages: ['ru-RU', 'zh-Hans', 'en-US'] },
  }, witnessProfileExpected(visionWitnessPlan({ subject: '语文' }))), false);
});

test('Russian witness sidecar binds both language passes and provenance while retaining Chinese canonical lines', () => {
  const document = { id: 'ru-doc', subject: '俄语' };
  const profile = visionWitnessPlan(document);
  const sidecar = buildVisionWitnessSidecar({
    document,
    page: 7,
    pdfSha: 'a'.repeat(64),
    imageSha: 'b'.repeat(64),
    imageInfo: { size: 4096, mtimeMs: 1234 },
    profile,
    passResults: [
      {
        pass_id: 'zh-primary',
        record: { file: 'page-007.png', lines: [{ text: '中华人民共和国教育部', confidence: 0.99 }] },
        raw_sidecar_file: 'vision-passes/zh-primary/page-007.json',
        raw_sidecar_sha256: '1'.repeat(64),
        raw_text_file: 'vision-passes/zh-primary/page-007.txt',
        raw_text_sha256: '2'.repeat(64),
        attempt_count: 1,
      },
      {
        pass_id: 'ru-supplement',
        record: { file: 'page-007.png', lines: [{ text: 'Русский язык', confidence: 0.98 }] },
        raw_sidecar_file: 'vision-passes/ru-supplement/page-007.json',
        raw_sidecar_sha256: '3'.repeat(64),
        raw_text_file: 'vision-passes/ru-supplement/page-007.txt',
        raw_text_sha256: '4'.repeat(64),
        attempt_count: 2,
      },
    ],
    provenance: visionProvenance,
    generatedAt: '2026-07-16T00:00:00.000Z',
  });
  const expected = {
    file: 'page-007.png',
    documentId: 'ru-doc',
    page: 7,
    pdfSha: 'a'.repeat(64),
    imageSha: 'b'.repeat(64),
    ...witnessProfileExpected(profile),
  };

  assert.equal(sidecar.schema_version, 3);
  assert.equal(sidecar.line_source_pass_id, 'zh-primary');
  assert.equal(sidecar.lines[0].text, '中华人民共和国教育部');
  assert.equal(sidecar.witness_passes[1].lines[0].text, 'Русский язык');
  assert.deepEqual(sidecar.engine_configuration.language_passes, profile.passes);
  assert.equal(sidecar.engine_provenance.os.product_version, '15.5');
  assert.equal(witnessRecordValid(sidecar, expected), true);

  const replacedCanonical = structuredClone(sidecar);
  replacedCanonical.lines = replacedCanonical.witness_passes[1].lines;
  assert.equal(witnessRecordValid(replacedCanonical, expected), false);

  const tamperedLanguage = structuredClone(sidecar);
  tamperedLanguage.witness_passes[1].languages = ['zh-Hans', 'ru-RU', 'en-US'];
  assert.equal(witnessRecordValid(tamperedLanguage, expected), false);

  const missingProvenance = structuredClone(sidecar);
  delete missingProvenance.engine_provenance.os.build_version;
  assert.equal(witnessRecordValid(missingProvenance, expected), false);

  const mislabelledEngine = structuredClone(sidecar);
  mislabelledEngine.engine = 'Paddle OCR';
  assert.equal(witnessRecordValid(mislabelledEngine, expected), false);

  const missingSupplement = structuredClone(sidecar);
  missingSupplement.witness_passes = missingSupplement.witness_passes.slice(0, 1);
  assert.equal(witnessRecordValid(missingSupplement, expected), false);
});

test('Russian witness assembly fails closed when any required pass is absent', () => {
  const document = { id: 'ru-doc', subject: '俄语' };
  assert.throws(() => buildVisionWitnessSidecar({
    document,
    page: 1,
    pdfSha: 'a'.repeat(64),
    imageSha: 'b'.repeat(64),
    imageInfo: { size: 1, mtimeMs: 1 },
    profile: visionWitnessPlan(document),
    passResults: [{
      pass_id: 'zh-primary',
      record: { file: 'page-001.png', lines: [] },
      raw_sidecar_file: 'vision-passes/zh-primary/page-001.json',
      raw_sidecar_sha256: '1'.repeat(64),
      raw_text_file: 'vision-passes/zh-primary/page-001.txt',
      raw_text_sha256: '2'.repeat(64),
      attempt_count: 1,
    }],
    provenance: visionProvenance,
  }), (error) => error.code === 'VISION_REQUIRED_PASS_MISSING' && error.pass_id === 'ru-supplement');
});

test('Vision invocation receives explicit language parameters and PNG paths, never primary OCR text artifacts', () => {
  assert.deepEqual(visionInvocationArgs({
    scriptPath: '/repo/scripts/vision-ocr-batch.swift',
    outputDir: '/tmp/vision-passes/ru-supplement',
    languages: ['ru-RU', 'zh-Hans', 'en-US'],
    imagePaths: ['/tmp/images/page-001.png'],
  }), [
    '/repo/scripts/vision-ocr-batch.swift',
    '--output-dir',
    '/tmp/vision-passes/ru-supplement',
    '--languages',
    'ru-RU,zh-Hans,en-US',
    '/tmp/images/page-001.png',
  ]);
  assert.throws(() => visionInvocationArgs({
    outputDir: '/tmp/vision',
    languages: ['zh-Hans', 'en-US'],
    imagePaths: ['/tmp/primary/pages/0001/content.md'],
  }), { code: 'VISION_INVOCATION_INVALID' });
});

test('an invalid old Vision sidecar cannot survive failed batch and page retries', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ocr-stale-vision-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sidecarPath = path.join(directory, 'page-001.json');
  const textPath = path.join(directory, 'page-001.txt');
  await Promise.all([
    writeFile(sidecarPath, `${JSON.stringify({ file: 'page-001.png', lines: [{ text: 'stale OCR', confidence: 0.99 }] })}\n`),
    writeFile(textPath, 'stale OCR\n'),
  ]);

  assert.equal(await readFreshVisionOutput(sidecarPath, {
    notBeforeMs: Date.now() + 5000,
    file: 'page-001.png',
    documentId: 'doc',
    page: 1,
    pdfSha: 'a'.repeat(64),
    imageSha: 'b'.repeat(64),
  }), null, 'a pre-run sidecar must fail the freshness gate');

  await discardVisionOutputs(sidecarPath);
  // Simulate the initial batch and every page retry failing without producing
  // new output: stale JSON/TXT must remain absent and unpublishable.
  assert.equal(await readFreshVisionOutput(sidecarPath, {
    notBeforeMs: Date.now(),
    file: 'page-001.png',
  }), null);
  await assert.rejects(readFile(sidecarPath), { code: 'ENOENT' });
  await assert.rejects(readFile(textPath), { code: 'ENOENT' });
});

test('missing completed witness pages are a set difference, not a count subtraction', () => {
  assert.deepEqual(missingCompletedWitnessPages([1, 3, 4], [2, 3, 4]), [1]);
});

test('continuous drain completes only with healthy full evidence parity', () => {
  const complete = {
    health: { exit_code: 0 },
    scheduler_state: 'queue_complete',
    queue: { completed_pages: 10, pending_pages: 0, failed_pages: 0 },
    evidence: {
      witness_pages: 10,
      audited_pages: 10,
      witness_error_sidecars: 0,
      witness_missing_for_completed: 0,
      stale_audit_pages: 0,
    },
    disk: { free_gib: 60, warning: false },
  };
  assert.equal(continuousDrainDecision(complete).action, 'complete');
  assert.equal(continuousDrainDecision({
    ...complete,
    evidence: { ...complete.evidence, audited_pages: 9 },
  }).code, 'DRAIN_INCOMPLETE_EVIDENCE');
  assert.equal(continuousDrainDecision({
    ...complete,
    health: { exit_code: 10 },
  }).code, 'DRAIN_HEALTH_STOP');
});

test('continuous drain stops at the disk warning boundary before another batch', () => {
  const status = {
    health: { exit_code: 0 },
    scheduler_state: 'ready',
    queue: { completed_pages: 10, pending_pages: 5, failed_pages: 0 },
    evidence: {
      witness_pages: 10,
      audited_pages: 10,
      witness_error_sidecars: 0,
      witness_missing_for_completed: 0,
      stale_audit_pages: 0,
    },
    disk: { free_gib: 49.9, warning: true },
  };
  assert.equal(continuousDrainDecision(status).code, 'DRAIN_DISK_WARNING');
  assert.equal(continuousDrainDecision({ ...status, disk: { free_gib: 60, warning: false } }).action, 'continue');
});

test('a quarantined page stays fail-closed without stopping other eligible pages', () => {
  const status = {
    health: { exit_code: 2, reasons: ['PAGE_QUARANTINED'] },
    scheduler_state: 'ready',
    queue: { completed_pages: 10, pending_pages: 5, failed_pages: 1 },
    evidence: {
      witness_pages: 11,
      audited_pages: 10,
      witness_error_sidecars: 0,
      witness_missing_for_completed: 0,
      stale_audit_pages: 0,
    },
    disk: { free_gib: 60, warning: false },
  };
  assert.equal(continuousDrainDecision(status).action, 'continue');
  assert.equal(continuousDrainDecision({ ...status, health: { exit_code: 2, reasons: ['DOCUMENT_QUARANTINED'] } }).action, 'stop');
  assert.equal(continuousDrainDecision({ ...status, scheduler_state: 'blocked' }).action, 'stop');
});

test('watchdog keeps polling a drain it spawned instead of waiting blindly for exit', async () => {
  const source = await readFile(new URL('../scripts/ocr-watchdog.mjs', import.meta.url), 'utf8');
  assert.match(source, /llama_parallel: 3,/);
  assert.match(source, /vl_rec_max_concurrency: 3,/);
  assert.match(source, /while \(!result\) \{/);
  assert.match(source, /sleep\(settings\.poll_seconds \* 1000\)/);
  assert.match(source, /terminateVerifiedStalledOwner\(owners, settings\)/);
  assert.match(source, /async function terminateTaskOwnedChild\(child, exitPromise\)/);
  assert.match(source, /child\.kill\('SIGTERM'\);[\s\S]*sleep\(5000\)[\s\S]*child\.kill\('SIGKILL'\);[\s\S]*return exitPromise;/);
  assert.match(source, /catch \(error\) \{[\s\S]*await terminateTaskOwnedChild\(child, exitPromise\)[\s\S]*throw error;/);
  assert.match(source, /processIdentity\(observation\.owner\.pid, 'drain'\)/);
  assert.match(source, /let child = null;/);
  assert.match(source, /resumablePageQuarantine/);
  assert.match(source, /runtimeRun\?\.error_code === 'PADDLE_RUNTIME_UNAVAILABLE'/);
  assert.match(source, /writeState\('runtime_backoff'/);
  const watchdogSpawn = source.indexOf('child = spawn(process.execPath');
  const watchdogExitPromise = source.indexOf('exitPromise = new Promise', watchdogSpawn);
  const watchdogFirstAwait = source.indexOf('await writeState(`starting_', watchdogSpawn);
  assert.ok(watchdogSpawn >= 0 && watchdogExitPromise > watchdogSpawn && watchdogExitPromise < watchdogFirstAwait,
    'watchdog must register child lifecycle listeners before the first post-spawn await');
  const supervisor = await readFile(new URL('../scripts/ocr-supervisor.mjs', import.meta.url), 'utf8');
  assert.match(supervisor, /runtime_policy_source:/);
  assert.match(supervisor, /watchdogOwnsDrain \? \{/);
  assert.match(supervisor, /source: 'watchdog_control'/);
  assert.match(supervisor, /CAPTURE_TIMEOUT/);
  assert.match(supervisor, /heartbeat: \(\) => updateRun\(run\)/);
  assert.match(supervisor, /startupTimeoutMs: 180000/);
  assert.match(supervisor, /idleTimeoutMs: 300000/);
  assert.match(supervisor, /PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True',[\s\S]*PYTHONUNBUFFERED: '1'/);
  assert.match(supervisor, /child\.kill\('SIGKILL'\)/);
  assert.match(supervisor, /MuPDF mutool 1\.28\.0/);
  assert.match(supervisor, /witnessRecordValid\(existing/);
  assert.match(supervisor, /stage: 'vision_render'/);
  assert.match(supervisor, /visionBatchLimits = Object\.freeze\(\{[\s\S]*startupTimeoutMs:[\s\S]*idleTimeoutMs:[\s\S]*wallTimeoutMs:/);
  assert.match(supervisor, /visionPageRetryLimits = Object\.freeze\(\{[\s\S]*startupTimeoutMs:[\s\S]*idleTimeoutMs:[\s\S]*wallTimeoutMs:/);
  assert.match(supervisor, /executionFailures\.set\(page, error\);/);
  assert.match(supervisor, /await discardVisionOutputs\(sidecarPath\);/);
  assert.match(supervisor, /readFreshVisionOutput\(sidecarPath,[\s\S]*notBeforeMs: outputNotBefore\.get\(page\)/);
  assert.match(supervisor, /VISION_IMAGE_CHANGED_DURING_RUN/);
  assert.match(supervisor, /independent_apple_vision_page_retry[\s\S]*visionPageRetryLimits[\s\S]*catch \(error\)[\s\S]*executionFailures\.set\(page, error\)/);
  assert.match(supervisor, /if \(paddleExecutionError && !structuredPaddleFailures\.has\(page\)\) continue;/);
  assert.match(supervisor, /PADDLE_RUNTIME_NO_PAGE_PROGRESS/);
  assert.match(supervisor, /paddleRuntimeFailure\(paddleExecutionError\)/);
  assert.match(supervisor, /paddleLogIndicatesRuntimeFailure\(paddleLog\)/);
  assert.match(supervisor, /reconcile-runtime-retries/);
  assert.match(supervisor, /retryReconcileBusyReasons\(guardedStatus, process\.pid\)/);
  assert.match(supervisor, /await acquireLock\(reconciliationLockId\)/);
  assert.match(supervisor, /await releaseLock\(reconciliationLockId\)/);
  const runLoggedStart = supervisor.indexOf('async function runLogged');
  const runLoggedSpawn = supervisor.indexOf('const child = spawn(executable, args', runLoggedStart);
  const runLoggedExitPromise = supervisor.indexOf('const exitPromise = new Promise', runLoggedSpawn);
  const runLoggedFirstAwait = supervisor.indexOf('await updateRun(run)', runLoggedSpawn);
  assert.ok(runLoggedSpawn >= 0 && runLoggedExitPromise > runLoggedSpawn && runLoggedExitPromise < runLoggedFirstAwait,
    'runLogged must register child lifecycle listeners before the first post-spawn await');
});

test('completed page with drifted content.md is selected for primary recovery', async (t) => {
  const fixture = await primaryFixture(t);
  assert.deepEqual(await selectPrimaryRecoveryPages(fixture.document, fixture.state, { primaryRoot: fixture.primaryRoot }), []);
  await writeFile(path.join(fixture.pageRoot, 'content.md'), '# Corrupted OCR\n');
  assert.deepEqual(await selectPrimaryRecoveryPages(fixture.document, fixture.state, { primaryRoot: fixture.primaryRoot }), [1]);
});

test('completed page with drifted result.json is selected for primary recovery', async (t) => {
  const fixture = await primaryFixture(t);
  assert.deepEqual(await selectPrimaryRecoveryPages(fixture.document, fixture.state, { primaryRoot: fixture.primaryRoot }), []);
  await writeFile(path.join(fixture.pageRoot, 'result.json'), '{"text":"Corrupted OCR"}\n');
  assert.deepEqual(await selectPrimaryRecoveryPages(fixture.document, fixture.state, { primaryRoot: fixture.primaryRoot }), [1]);
});

test('audit backfill selects only completed pages with valid primary and Vision inputs but missing or stale exact audits', async (t) => {
  const current = await auditFixture(t);
  assert.deepEqual(await selectAuditBackfillPages(current.document, current.state, {
    primaryRoot: current.primaryRoot,
    witnessBaseRoot: current.witnessBaseRoot,
  }), []);

  const missing = await auditFixture(t, { audit: 'missing' });
  assert.deepEqual(await selectAuditBackfillPages(missing.document, missing.state, {
    primaryRoot: missing.primaryRoot,
    witnessBaseRoot: missing.witnessBaseRoot,
  }), [1]);

  const stale = await auditFixture(t, { audit: 'stale' });
  assert.deepEqual(await selectAuditBackfillPages(stale.document, stale.state, {
    primaryRoot: stale.primaryRoot,
    witnessBaseRoot: stale.witnessBaseRoot,
  }), [1]);

  const staleWitness = await auditFixture(t, { audit: 'stale-witness' });
  assert.deepEqual(await selectAuditBackfillPages(staleWitness.document, staleWitness.state, {
    primaryRoot: staleWitness.primaryRoot,
    witnessBaseRoot: staleWitness.witnessBaseRoot,
  }), [1]);
});

test('current audit fast path avoids deep primary rehash while primary recovery keeps the integrity gate', async (t) => {
  const fixture = await auditFixture(t);
  await rm(path.join(fixture.pageRoot, 'result.json'));
  assert.deepEqual(await selectAuditBackfillPages(fixture.document, fixture.state, {
    primaryRoot: fixture.primaryRoot,
    witnessBaseRoot: fixture.witnessBaseRoot,
  }), []);
  assert.deepEqual(await selectPrimaryRecoveryPages(fixture.document, fixture.state, {
    primaryRoot: fixture.primaryRoot,
  }), [1]);
});

test('audit backfill never substitutes for primary or Vision recovery', async (t) => {
  const primaryDrift = await auditFixture(t, { audit: 'missing' });
  await writeFile(path.join(primaryDrift.pageRoot, 'content.md'), '# Corrupted OCR\n');
  assert.deepEqual(await selectAuditBackfillPages(primaryDrift.document, primaryDrift.state, {
    primaryRoot: primaryDrift.primaryRoot,
    witnessBaseRoot: primaryDrift.witnessBaseRoot,
  }), []);

  const witnessDrift = await auditFixture(t, { audit: 'missing' });
  await writeFile(witnessDrift.witnessPath, `${JSON.stringify({ error: 'Vision failed' })}\n`);
  assert.deepEqual(await selectAuditBackfillPages(witnessDrift.document, witnessDrift.state, {
    primaryRoot: witnessDrift.primaryRoot,
    witnessBaseRoot: witnessDrift.witnessBaseRoot,
  }), []);

  const imageDrift = await auditFixture(t, { audit: 'missing' });
  await writeFile(imageDrift.imagePath, 'different rendered image');
  assert.deepEqual(await selectAuditBackfillPages(imageDrift.document, imageDrift.state, {
    primaryRoot: imageDrift.primaryRoot,
    witnessBaseRoot: imageDrift.witnessBaseRoot,
  }), []);
});

test('audit backfill execution reuses validated inputs and disables Vision and primary OCR stages', async (t) => {
  const fixture = await auditFixture(t, { audit: 'missing' });
  assert.deepEqual(ocrExecutionPolicy('audit_backfill'), { renderVision: false, runPrimaryOcr: false });
  assert.deepEqual(ocrExecutionPolicy('new_ocr'), { renderVision: true, runPrimaryOcr: true });
  const prepared = await prepareAuditBackfillWitness(fixture.document, [1], fixture.state, {
    primaryRoot: fixture.primaryRoot,
    witnessBaseRoot: fixture.witnessBaseRoot,
  });
  assert.deepEqual(prepared.successPages, [1]);
  assert.deepEqual(prepared.failures, []);
  assert.equal(prepared.visionDir, path.join(fixture.witnessBaseRoot, 'doc', 'vision'));
});

test('audit backfill input drift remains a page-scoped audit retry', async (t) => {
  const fixture = await auditFixture(t, { audit: 'missing' });
  await writeFile(path.join(fixture.pageRoot, 'content.md'), '# Corrupted OCR\n');
  const prepared = await prepareAuditBackfillWitness(fixture.document, [1], fixture.state, {
    primaryRoot: fixture.primaryRoot,
    witnessBaseRoot: fixture.witnessBaseRoot,
  });
  assert.equal(prepared.failures[0].stage, 'audit');
  assert.equal(prepared.failures[0].code, 'AUDIT_BACKFILL_PRIMARY_STALE');
  const retry = nextPageRetry(null, prepared.failures[0], { now: Date.parse('2026-07-15T08:00:00Z') });
  assert.equal(pageRetryKey('doc', 1, prepared.failures[0].stage), 'doc:1:audit');
  assert.equal(retry.quarantined, false);
  assert.equal(retry.attempts, 1);
});

test('health exit code contract distinguishes active, degraded, failed, stalled, and blocked', () => {
  const base = { lockActive: false, stalled: false, diskHardStop: false, witnessErrors: 0, currentRun: { status: 'completed' }, documentRetries: {}, pageRetries: {} };
  assert.deepEqual(classifyHealth(base).overall, 'healthy');
  assert.equal(classifyHealth({ ...base, lockActive: true, currentRun: { status: 'running' } }).exit_code, 75);
  assert.equal(classifyHealth({ ...base, lockActive: true, witnessErrors: 1, currentRun: { status: 'running' } }).exit_code, 75);
  assert.equal(classifyHealth({ ...base, lockActive: true, diskHardStop: true, currentRun: { status: 'running' } }).exit_code, 12);
  assert.equal(classifyHealth({ ...base, pageRetries: { x: { next_retry_at: '2026-07-16T00:00:00Z' } } }).exit_code, 2);
  assert.equal(classifyHealth({ ...base, witnessErrors: 1 }).exit_code, 10);
  assert.equal(classifyHealth({ ...base, lockActive: true, stalled: true }).exit_code, 11);
  assert.equal(classifyHealth({ ...base, pageRetries: { x: { quarantined: true } } }).exit_code, 12);
  assert.equal(classifyHealth({ ...base, pageRetries: { x: { quarantined: true } }, hasEligibleWork: true }).exit_code, 2);
  assert.equal(classifyHealth({ ...base, currentRun: { status: 'failed', error_code: 'MODEL_CHECKSUM_MISMATCH' } }).exit_code, 12);
});

test('concept candidate gate requires current fingerprints and matching academic provenance', () => {
  const revision = 'a'.repeat(64);
  const academicSha = 'b'.repeat(64);
  const inputFingerprints = {
    catalog_sha256: '1'.repeat(64),
    queue_sha256: '2'.repeat(64),
    concept_model_sha256: '3'.repeat(64),
    lexicon_sha256: '4'.repeat(64),
    ontology_sha256: '7'.repeat(64),
    builder_sha256: '5'.repeat(64),
    graph_sharder_sha256: '8'.repeat(64),
    concept_publication_gate_sha256: '9'.repeat(64),
    page_publication_gate_sha256: 'a'.repeat(64),
    semantic_publication_policy_sha256: 'b'.repeat(64),
    semantic_publication_gate_sha256: 'c'.repeat(64),
    compendium_item_boundaries_sha256: 'd'.repeat(64),
    compendium_item_boundary_gate_sha256: 'e'.repeat(64),
    compendium_item_publication_gate_sha256: 'f'.repeat(64),
    online_verification_samples_sha256: '0'.repeat(64),
    corpus_manifest_gate_sha256: 'a'.repeat(64),
    validator_sha256: '6'.repeat(64),
  };
  const shardAssets = [{
    id: 'episode_detail:fixture:1',
    kind: 'episode_detail',
    path: '/data/graph-shards/details/fixture.json',
    bytes: 123,
    sha256: 'f'.repeat(64),
    counts: { episodes: 1, evidence: 1 },
    build_revision: revision,
    filters: { facet: '语文', era: '2022-present', chunk_index: 1 },
  }];
  const shardDescriptorsSha256 = createHash('sha256').update(JSON.stringify(shardAssets)).digest('hex');
  const graph = {
    schema_version: 1,
    academic_schema_version: 2,
    artifact_profile: 'curriculum-concept-evolution-core-index-v1',
    transport_profile: 'immutable-content-addressed-graph-shards-v1',
    academic_schema: 'curriculum-concept-evolution-academic-v2',
    model_kind: 'curriculum_concept_academic_model_v2',
    build_revision: revision,
    input_fingerprints: inputFingerprints,
    academic_model_ref: { path: '/data/concept-evolution-academic.json', build_revision: revision, sha256: academicSha },
    shard_manifest: {
      transport_profile: 'immutable-content-addressed-graph-shards-v1',
      build_revision: revision,
      max_shard_bytes: 512 * 1024,
      assets: shardAssets,
    },
  };
  const quality = {
    schema_version: 1,
    passed: true,
    academic_schema_version: 2,
    artifact_profile: 'curriculum-concept-evolution-quality-v1',
    academic_schema: graph.academic_schema,
    model_kind: graph.model_kind,
    build_revision: revision,
    input_fingerprints: inputFingerprints,
    academic_sha256: academicSha,
    graph_transport: {
      profile: 'immutable-content-addressed-graph-shards-v1',
      max_shard_bytes: 512 * 1024,
      shard_count: shardAssets.length,
    },
  };
  const manifest = {
    schema_version: 3,
    academic_schema_version: 2,
    artifact_profile: graph.artifact_profile,
    academic_schema: graph.academic_schema,
    model_kind: graph.model_kind,
    build_revision: revision,
    input_fingerprints: inputFingerprints,
    academic_model_ref: graph.academic_model_ref,
    transport_profile: graph.transport_profile,
    graph_shard_max_bytes: 512 * 1024,
    graph_shard_count: shardAssets.length,
    graph_shard_descriptors_sha256: shardDescriptorsSha256,
  };
  const compatible = (overrides = {}) => conceptCandidateCompatible({
    graph: overrides.graph || graph,
    quality: overrides.quality || quality,
    manifest: overrides.manifest || manifest,
    currentFingerprints: overrides.currentFingerprints || inputFingerprints,
  });

  assert.equal(compatible(), true);
  assert.equal(compatible({ quality: { ...quality, passed: false } }), false);
  assert.equal(compatible({ quality: { ...quality, artifact_profile: undefined } }), false);
  assert.equal(compatible({ manifest: { ...manifest, schema_version: 2 } }), false);
  assert.equal(compatible({ manifest: { ...manifest, build_revision: 'c'.repeat(64) } }), false);
  assert.equal(compatible({ graph: { ...graph, academic_model_ref: null } }), false);
  assert.equal(compatible({ graph: { ...graph, academic_schema: 'legacy' } }), false);
  assert.equal(compatible({ graph: { ...graph, shard_manifest: { ...graph.shard_manifest, max_shard_bytes: 1 } } }), false);
  assert.equal(compatible({ manifest: { ...manifest, graph_shard_descriptors_sha256: '0'.repeat(64) } }), false);
  assert.equal(compatible({ currentFingerprints: { ...inputFingerprints, queue_sha256: 'd'.repeat(64) } }), false);
  assert.equal(compatible({ quality: { ...quality, input_fingerprints: { ...inputFingerprints, validator_sha256: 'e'.repeat(64) } } }), false);
});
