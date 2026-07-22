import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  continueOperatorInterruptedAttempt,
  operatorContinuationPaths,
} from '../scripts/continue-remote-ocr-operator-interruption.mjs';
import { canonicalJson, inspectTree } from '../scripts/lib/remote-ocr-local-snapshot.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const runnerPath = fileURLToPath(new URL('../scripts/run-remote-ocr-offload.mjs', import.meta.url));
const EXPECTED_UNCHANGED_RUNNER_SHA256 = '0fbf3d284f324f5faa710ca09342cdef88d24e6349b6e5d590ccca215065354d';
const documentId = 'legacy-compendium-english';
const seedId = '1'.repeat(64);
const runtimeFingerprintSha256 = '2'.repeat(64);
const grantSha256 = '3'.repeat(64);
const claimSha256 = '4'.repeat(64);
const workerInvocationId = 'cea41604c79f46cfa9483b46d64ad0fd';
const startedAt = '2026-07-22T04:12:00.000Z';
const interruptedAt = '2026-07-22T04:13:35.390Z';
const authorizedAt = '2026-07-22T04:20:00.000Z';
const continuedAt = '2026-07-22T04:21:00.000Z';

async function writeJsonSidecar(pathname, value) {
  const raw = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeFile(pathname, raw, { mode: 0o600 });
  await writeFile(
    `${pathname}.sha256`,
    `${sha256(raw)}  ${path.basename(pathname)}\n`,
    { mode: 0o600 },
  );
  return { raw, sha256: sha256(raw) };
}

async function makeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ocr-operator-continuation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputRoot = path.join(root, 'input');
  const outputRoot = path.join(root, 'output');
  const incidentEvidenceRoot = path.join(root, 'incident-evidence');
  const documentRoot = path.join(outputRoot, 'documents', documentId);
  const statusRoot = path.join(outputRoot, 'status');
  const logRoot = path.join(outputRoot, 'logs');
  await Promise.all([
    mkdir(path.join(inputRoot, 'pdfs'), { recursive: true, mode: 0o700 }),
    mkdir(path.join(documentRoot, 'pages', '0001'), { recursive: true, mode: 0o700 }),
    mkdir(statusRoot, { recursive: true, mode: 0o700 }),
    mkdir(logRoot, { recursive: true, mode: 0o700 }),
    mkdir(incidentEvidenceRoot, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    chmod(outputRoot, 0o700),
    chmod(incidentEvidenceRoot, 0o700),
  ]);
  const canonicalInputRoot = await realpath(inputRoot);
  const canonicalOutputRoot = await realpath(outputRoot);
  const canonicalIncidentEvidenceRoot = await realpath(incidentEvidenceRoot);

  const source = Buffer.from('fixture PDF bytes');
  const sourcePath = path.join(inputRoot, 'pdfs', 'english.pdf');
  await writeFile(sourcePath, source, { mode: 0o600 });
  const ocrScript = path.join(root, 'ocr.py');
  await writeFile(ocrScript, '# fixture\n', { mode: 0o700 });
  await chmod(ocrScript, 0o700);
  const manifest = {
    schema_version: 1,
    manifest_type: 'curriculum_remote_whole_document_ocr_offload_plan',
    runtime: {
      pipeline: 'PaddleOCR-VL',
      pipeline_version: 'v1.6',
      model_sha256: 'a'.repeat(64),
      mmproj_sha256: 'b'.repeat(64),
      llama_commit: 'c'.repeat(40),
      render_dpi: 240,
    },
    quality_policy: {
      stage: 'remote_primary_ocr_staging_only',
      whole_document_atomic: true,
      citation_allowed: false,
      remote_results_require_local_witness_and_exact_audit_before_publication: true,
    },
    import_hard_gates: {
      decision: 'reject_entire_document_if_any_gate_fails',
      remote_document_revalidation: {
        citation_allowed_must_equal: false,
        every_page_requires_valid_lowercase_sha256: [
          'result_json_sha256',
          'content_markdown_sha256',
          'rendered_image_sha256',
        ],
      },
    },
    counts: { selected_documents: 1, selected_pages: 2, selected_source_bytes: source.byteLength },
    documents: [{
      id: documentId,
      source_path: 'pdfs/english.pdf',
      source_sha256: sha256(source),
      source_bytes: source.byteLength,
      page_count: 2,
      required_page_range: { first: 1, last: 2, count: 2 },
      planning_snapshot: {
        state_file_present: false,
        local_completed_pages: 0,
        local_failed_pages: 0,
        local_retry_conflicts: 0,
        local_production_artifact_conflicts: 0,
      },
      citation_allowed: false,
    }],
  };
  const manifestPath = path.join(root, 'manifest.json');
  const manifestRaw = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(manifestPath, manifestRaw, { mode: 0o600 });

  const pageResult = Buffer.from('{"page":1}\n');
  const pageContent = Buffer.from('page 1\n');
  await Promise.all([
    writeFile(path.join(documentRoot, 'pages/0001/result.json'), pageResult, { mode: 0o600 }),
    writeFile(path.join(documentRoot, 'pages/0001/content.md'), pageContent, { mode: 0o600 }),
  ]);
  const state = {
    schema_version: 1,
    document_id: documentId,
    source_sha256: sha256(source),
    page_count: 2,
    completed_pages: [1],
    failed_pages: {},
    pages: {
      1: {
        status: 'ocr_complete_pending_audit',
        physical_pdf_page: 1,
        rendered_image_sha256: '5'.repeat(64),
        result_json_sha256: sha256(pageResult),
        content_markdown_sha256: sha256(pageContent),
        citation_eligible: false,
      },
    },
    selected_pages: [1, 2],
    selected_pages_complete: false,
  };
  const statePath = path.join(documentRoot, 'state.json');
  const stateRaw = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  await writeFile(statePath, stateRaw, { mode: 0o600 });

  const logPath = path.join(logRoot, `${documentId}.log`);
  const logRaw = Buffer.from('attempt 6 started\nSignalInfo: *** SIGTERM\n');
  await writeFile(logPath, logRaw, { mode: 0o600 });
  await writeFile(
    path.join(incidentEvidenceRoot, 'operator-incident.json'),
    `${JSON.stringify({ worker_invocation_id: workerInvocationId, interrupted_at: interruptedAt })}\n`,
    { mode: 0o600 },
  );

  const grantId = sha256('grant-id');
  const grant = {
    schema_version: 1,
    grant_type: 'curriculum_remote_ocr_timeout_recovery_grant',
    mode: 'one_additional_attempt_per_document',
    grant_id: grantId,
    policy: {
      required_status: 'quarantined',
      required_inherited_attempts: 5,
      granted_attempt: 6,
      additional_attempts_per_document: 1,
      automatic_attempt_7: false,
      scope: 'all_timeout_quarantined_documents',
    },
    documents: [{
      document_id: documentId,
      inherited_attempts: 5,
      granted_attempt: 6,
      first_missing_page: 2,
    }],
    citation_allowed: false,
  };
  const grantEvidence = await writeJsonSidecar(
    path.join(outputRoot, 'timeout-recovery-grant.json'),
    grant,
  );
  const outputInfo = await stat(outputRoot, { bigint: true });
  const consumptionClaim = {
    schema_version: 1,
    claim_type: 'curriculum_remote_ocr_timeout_recovery_consumption_claim',
    claim_mode: 'atomic_single_claim',
    grant_id: grantId,
    grant_raw_sha256: grantEvidence.sha256,
    granted_documents: [{ document_id: documentId, inherited_attempts: 5, granted_attempt: 6 }],
    successor: {
      seed_id: seedId,
      output_root: canonicalOutputRoot,
      output_device: String(outputInfo.dev),
      output_inode: String(outputInfo.ino),
    },
    citation_allowed: false,
  };
  const claimEvidence = await writeJsonSidecar(
    path.join(outputRoot, 'timeout-recovery-consumption-claim.json'),
    consumptionClaim,
  );
  const seedReceipt = {
    schema_version: 1,
    receipt_type: 'curriculum_remote_ocr_hash_bound_output_seed',
    seed_id: seedId,
    documents: [{
      document_id: documentId,
      predecessor_status_sha256: 'd'.repeat(64),
      predecessor_configuration_sha256: 'e'.repeat(64),
      timeout_recovery: {
        grant_id: grantId,
        grant_raw_sha256: grantEvidence.sha256,
        granted_attempt: 6,
        first_missing_page: 2,
      },
    }],
    citation_allowed: false,
  };
  await writeJsonSidecar(path.join(outputRoot, 'seed-receipt.json'), seedReceipt);

  const identity = {
    schema_version: 1,
    manifest_sha256: sha256(manifestRaw),
    runtime: manifest.runtime,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    runner_script_sha256: EXPECTED_UNCHANGED_RUNNER_SHA256,
    ocr_script_sha256: sha256(await readFile(ocrScript)),
    input_root: canonicalInputRoot,
    worker_configuration: {
      llama_url: 'http://127.0.0.1:8112/v1',
      vl_rec_max_concurrency: 1,
      server_parallel: 1,
      micro_batch: 16,
      use_queues: true,
      runtime_device: 'fixture-gpu',
      paddlex_cache_home: path.join(outputRoot, 'paddlex-cache'),
    },
    document_recovery: {
      max_attempts: 5,
      backoff_seconds: [2, 10, 30, 60],
      terminal_status: 'quarantined',
      terminal_exit_code: 12,
      child_monitoring: {
        startup_timeout_seconds: 180,
        idle_timeout_seconds: 1200,
        wall_floor_seconds: 1200,
        wall_seconds_per_page: 25,
        terminate_grace_seconds: 15,
        poll_interval_seconds: 5,
      },
    },
    seed_lineage: {
      schema_version: 1,
      mode: 'hash_bound_output_seed',
      seed_id: seedId,
      predecessor_run_identity_sha256: 'f'.repeat(64),
      timeout_recovery_grant_id: grantId,
      timeout_recovery_grant_sha256: grantEvidence.sha256,
      timeout_recovery_claim_sha256: claimEvidence.sha256,
      timeout_recovery_documents: [documentId],
      citation_allowed: false,
    },
    whole_document_atomic: true,
    citation_allowed: false,
  };
  await writeFile(
    path.join(outputRoot, 'run-identity.json'),
    `${JSON.stringify(identity, null, 2)}\n`,
    { mode: 0o600 },
  );

  const status = {
    schema_version: 1,
    document_id: documentId,
    status: 'interrupted',
    attempt: 6,
    max_attempts: 6,
    page_count: 2,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    citation_allowed: false,
    interrupted_at: interruptedAt,
    seed_lineage: {
      schema_version: 1,
      seed_id: seedId,
      inherited_attempts: 5,
      timeout_recovery_grant_id: grantId,
      timeout_recovery_grant_sha256: grantEvidence.sha256,
      granted_attempt: 6,
      citation_allowed: false,
    },
  };
  const statusPath = path.join(statusRoot, `${documentId}.json`);
  const statusEvidence = await writeJsonSidecar(statusPath, status);
  const progress = {
    status: 'interrupted',
    attempts: 6,
    page_count: 2,
    started_at: startedAt,
    interrupted_at: interruptedAt,
    signal: 'SIGTERM',
    status_json_sha256: statusEvidence.sha256,
    predecessor_status: 'quarantined',
    inherited_attempts: 5,
    seed_id: seedId,
    attempt_ceiling: 6,
    timeout_recovery_grant_id: grantId,
    timeout_recovery_grant_sha256: grantEvidence.sha256,
    timeout_recovery_first_missing_page: 2,
  };
  const runStatus = {
    schema_version: 1,
    manifest_sha256: sha256(manifestRaw),
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    document_recovery: identity.document_recovery,
    citation_allowed: false,
    started_at: '2026-07-22T03:00:00.000Z',
    updated_at: interruptedAt,
    documents: { [documentId]: progress },
    counts: { total: 1, complete: 0, failed: 0, interrupted: 1, pending: 0, running: 0, retry_wait: 0, quarantined: 0 },
    finished: false,
    settled: false,
    seed_lineage: identity.seed_lineage,
  };
  const runStatusPath = path.join(outputRoot, 'run-status.json');
  const runStatusEvidence = await writeJsonSidecar(runStatusPath, runStatus);

  const documentTree = await inspectTree(documentRoot);
  const incidentTree = await inspectTree(incidentEvidenceRoot);
  const options = {
    manifest: manifestPath,
    inputRoot: canonicalInputRoot,
    outputRoot: canonicalOutputRoot,
    python: process.execPath,
    ocrScript,
    model: '/unused/model',
    mmproj: '/unused/mmproj',
    llamaRepo: '/unused/llama',
    llamaServerBin: '/unused/llama-server',
    llamaSystemdUnit: 'curriculum-ocr-llama.service',
    llamaUrl: 'http://127.0.0.1:8112/v1',
    runtimeDevice: 'fixture-gpu',
    paddlexCacheHome: path.join(outputRoot, 'paddlex-cache'),
    vlRecMaxConcurrency: 1,
    serverParallel: 1,
    microBatch: 16,
    useQueues: true,
    childStartupTimeoutSeconds: 180,
    childIdleTimeoutSeconds: 1200,
    childWallFloorSeconds: 1200,
    childWallSecondsPerPage: 25,
    childTerminateGraceSeconds: 15,
    childPollIntervalSeconds: 5,
    documentId,
    attempt: 6,
    workerInvocationId,
    operatorInterruptedAt: interruptedAt,
    authorizedAt,
    continuedAt,
    incidentEvidenceRoot: canonicalIncidentEvidenceRoot,
    expectedRunStatusSha256: runStatusEvidence.sha256,
    expectedStatusSha256: statusEvidence.sha256,
    expectedLogSha256: sha256(logRaw),
    expectedLogBytes: logRaw.byteLength,
    expectedStateSha256: sha256(stateRaw),
    expectedDocumentTreeSha256: documentTree.tree_sha256,
    expectedDocumentTreeFiles: documentTree.files,
    expectedDocumentTreeBytes: documentTree.bytes,
    expectedIncidentTreeSha256: incidentTree.tree_sha256,
    expectedGrantSha256: grantEvidence.sha256,
    expectedConsumptionClaimSha256: claimEvidence.sha256,
    expectedRunnerScriptSha256: EXPECTED_UNCHANGED_RUNNER_SHA256,
    apply: false,
  };
  options.expectedOutputDevice = String(outputInfo.dev);
  options.expectedOutputInode = String(outputInfo.ino);
  return {
    root,
    outputRoot: canonicalOutputRoot,
    documentRoot,
    statePath,
    logPath,
    statusPath,
    runStatusPath,
    options,
    state,
    identity,
  };
}

function dependencies(extra = {}) {
  return {
    verifyCommittedSeed: async () => ({ verified: true }),
    verifyActiveRuntime: async () => ({ verified: true }),
    pageCounter: () => 2,
    validateDocumentOutput: async () => ({
      state_sha256: '6'.repeat(64),
      page_artifacts: [],
      page_artifacts_sha256: '7'.repeat(64),
    }),
    now: () => '2026-07-22T04:30:00.000Z',
    handleSignals: false,
    ...extra,
  };
}

test('the immutable seeded runner remains byte-identical', async () => {
  assert.equal(sha256(await readFile(runnerPath)), EXPECTED_UNCHANGED_RUNNER_SHA256);
});

test('exact operator interruption is a mutation-free dry run', async (t) => {
  const fixture = await makeFixture(t);
  const before = await inspectTree(fixture.outputRoot);
  const result = await continueOperatorInterruptedAttempt(fixture.options, dependencies({
    verifyCommittedSeed: async () => assert.fail('dry run must remain persistence-free'),
    invokeOcr: async () => assert.fail('dry run must not invoke OCR'),
  }));
  const repeated = await continueOperatorInterruptedAttempt(fixture.options, dependencies({
    verifyCommittedSeed: async () => assert.fail('dry run must remain persistence-free'),
    invokeOcr: async () => assert.fail('dry run must not invoke OCR'),
  }));
  assert.equal(result.status, 'ready');
  assert.equal(result.attempt, 6);
  assert.equal(result.citation_allowed, false);
  assert.deepEqual(repeated, result);
  assert.deepEqual(await inspectTree(fixture.outputRoot), before);
  await assert.rejects(stat(operatorContinuationPaths(fixture.outputRoot, documentId, 6).root), { code: 'ENOENT' });
});

test('apply consumes one claim and completes the same attempt 6 without truncating prior evidence', async (t) => {
  const fixture = await makeFixture(t);
  const originalStartedAt = startedAt;
  const originalLog = await readFile(fixture.logPath);
  const timeoutGrantPath = path.join(fixture.outputRoot, 'timeout-recovery-grant.json');
  const timeoutClaimPath = path.join(fixture.outputRoot, 'timeout-recovery-consumption-claim.json');
  const [timeoutGrantBefore, timeoutClaimBefore] = await Promise.all([
    readFile(timeoutGrantPath),
    readFile(timeoutClaimPath),
  ]);
  const invokeOcr = async (_python, args, invocation) => {
    assert.equal(args[1], documentId);
    assert.ok(args.includes('--seed-id'));
    assert.equal(args[args.indexOf('--seed-id') + 1], seedId);
    assert.equal(await realpath(invocation.logPath), await realpath(fixture.logPath));
    await writeFile(fixture.logPath, Buffer.concat([originalLog, Buffer.from('continued attempt 6\n')]), { mode: 0o600 });
    const completed = structuredClone(fixture.state);
    completed.completed_pages = [1, 2];
    completed.pages['2'] = {
      status: 'ocr_complete_pending_audit',
      physical_pdf_page: 2,
      rendered_image_sha256: '8'.repeat(64),
      result_json_sha256: '9'.repeat(64),
      content_markdown_sha256: 'a'.repeat(64),
      citation_eligible: false,
    };
    completed.selected_pages_complete = true;
    await mkdir(path.join(fixture.documentRoot, 'pages/0002'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(fixture.documentRoot, 'pages/0002/result.json'), '{}\n', { mode: 0o600 });
    await writeFile(path.join(fixture.documentRoot, 'pages/0002/content.md'), 'page 2\n', { mode: 0o600 });
    await writeFile(fixture.statePath, `${JSON.stringify(completed, null, 2)}\n`, { mode: 0o600 });
    return { code: 0, signal: null, monitorIncident: null };
  };
  const result = await continueOperatorInterruptedAttempt(
    { ...fixture.options, apply: true },
    dependencies({ invokeOcr }),
  );
  assert.equal(result.status, 'complete');
  assert.equal(result.attempt, 6);
  const runStatus = JSON.parse(await readFile(fixture.runStatusPath, 'utf8'));
  const progress = runStatus.documents[documentId];
  assert.equal(progress.status, 'complete');
  assert.equal(progress.attempts, 6);
  assert.equal(progress.started_at, originalStartedAt);
  assert.equal(Object.hasOwn(progress, 'interrupted_at'), false);
  assert.equal(Object.hasOwn(progress, 'signal'), false);
  assert.ok((await readFile(fixture.logPath)).subarray(0, originalLog.length).equals(originalLog));
  assert.ok((await readFile(timeoutGrantPath)).equals(timeoutGrantBefore));
  assert.ok((await readFile(timeoutClaimPath)).equals(timeoutClaimBefore));
  const paths = operatorContinuationPaths(fixture.outputRoot, documentId, 6);
  for (const pathname of [paths.receipt, paths.receiptSidecar, paths.claim, paths.claimSidecar, paths.interruptedRunStatus, paths.interruptedStatus, paths.interruptedState, paths.preContinuationLog]) {
    assert.equal((await stat(pathname)).mode & 0o777, 0o600);
  }
  const receipt = JSON.parse(await readFile(paths.receipt, 'utf8'));
  const claim = JSON.parse(await readFile(paths.claim, 'utf8'));
  assert.equal(receipt.interrupted_snapshot.document_progress.attempts, 6);
  assert.equal(receipt.interrupted_snapshot.document_status.status, 'interrupted');
  assert.equal(claim.continuation_id, receipt.continuation_id);
  assert.equal(claim.attempt, 6);

  let reinvoked = false;
  await assert.rejects(
    continueOperatorInterruptedAttempt(
      { ...fixture.options, apply: true },
      dependencies({ invokeOcr: async () => { reinvoked = true; } }),
    ),
    /already consumed|no longer matches the authorized interrupted state/u,
  );
  assert.equal(reinvoked, false);
});

test('every expected incident anchor is fail-closed before claim publication', async (t) => {
  const mutations = [
    ['run status', async (fixture) => writeFile(fixture.runStatusPath, '{}\n', { mode: 0o600 }), /run status SHA-256/u],
    ['document status', async (fixture) => writeFile(fixture.statusPath, '{}\n', { mode: 0o600 }), /document status SHA-256/u],
    ['log growth', async (fixture) => writeFile(fixture.logPath, 'unexpected growth\n', { flag: 'a' }), /log (?:SHA-256|byte)/u],
    ['state drift', async (fixture) => writeFile(fixture.statePath, '{}\n', { mode: 0o600 }), /state SHA-256|document tree/u],
    ['tree drift', async (fixture) => writeFile(path.join(fixture.documentRoot, 'unexpected'), 'drift'), /document tree/u],
  ];
  for (const [label, mutate, pattern] of mutations) {
    await t.test(label, async (subtest) => {
      const fixture = await makeFixture(subtest);
      await mutate(fixture);
      await assert.rejects(
        continueOperatorInterruptedAttempt({ ...fixture.options, apply: true }, dependencies()),
        pattern,
      );
      await assert.rejects(stat(operatorContinuationPaths(fixture.outputRoot, documentId, 6).claim), { code: 'ENOENT' });
    });
  }
});

test('a shared-runtime failure after claim never rolls attempt 6 back to 5', async (t) => {
  const fixture = await makeFixture(t);
  await assert.rejects(
    continueOperatorInterruptedAttempt(
      { ...fixture.options, apply: true },
      dependencies({
        invokeOcr: async () => ({ code: 1, signal: null, monitorIncident: null }),
        revalidateActiveRuntime: async () => { throw new Error('llama attestation drift'); },
      }),
    ),
    /shared runtime revalidation failed.*llama attestation drift/u,
  );
  const runStatus = JSON.parse(await readFile(fixture.runStatusPath, 'utf8'));
  assert.equal(runStatus.documents[documentId].status, 'failed');
  assert.equal(runStatus.documents[documentId].attempts, 6);
  assert.equal(runStatus.documents[documentId].failure_class, 'shared_runtime_configuration');
  const paths = operatorContinuationPaths(fixture.outputRoot, documentId, 6);
  assert.equal((await stat(paths.claim)).isFile(), true);
});

test('wrong grant/claim binding and pre-existing claim artifacts are rejected', async (t) => {
  await t.test('grant digest', async (subtest) => {
    const fixture = await makeFixture(subtest);
    fixture.options.expectedGrantSha256 = grantSha256;
    await assert.rejects(
      continueOperatorInterruptedAttempt({ ...fixture.options, apply: true }, dependencies()),
      /timeout recovery grant SHA-256/u,
    );
  });
  await t.test('claim digest', async (subtest) => {
    const fixture = await makeFixture(subtest);
    fixture.options.expectedConsumptionClaimSha256 = claimSha256;
    await assert.rejects(
      continueOperatorInterruptedAttempt({ ...fixture.options, apply: true }, dependencies()),
      /consumption claim SHA-256/u,
    );
  });
  await t.test('orphan continuation claim sidecar', async (subtest) => {
    const fixture = await makeFixture(subtest);
    const paths = operatorContinuationPaths(fixture.outputRoot, documentId, 6);
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    await writeFile(paths.claimSidecar, `${'f'.repeat(64)}  claim.json\n`, { mode: 0o600 });
    await assert.rejects(
      continueOperatorInterruptedAttempt({ ...fixture.options, apply: true }, dependencies()),
      /orphan.*claim sidecar|continuation evidence directory/u,
    );
  });
});
