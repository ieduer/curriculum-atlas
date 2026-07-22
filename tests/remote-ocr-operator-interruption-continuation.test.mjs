import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  IncompleteOcrDocumentError,
  validateOcrDocumentOutput,
} from '../scripts/run-remote-ocr-offload.mjs';
import {
  continueOperatorInterruptedAttempt,
  inspectA2ContinuationUnits,
  operatorContinuationPaths,
  reconcileOwnedContinuationExecution,
  recoverableTerminalAtomicReplace,
} from '../scripts/continue-remote-ocr-operator-interruption.mjs';
import {
  EXACT_A2_FORWARD_CONTINUATION_INCIDENT,
  validateA2ForwardContinuationProfile,
  validateA2InterruptedPartialSelectionState,
  validateOperatorContinuationEvidence,
  validateOperatorContinuationOutput,
} from '../scripts/lib/remote-ocr-operator-continuation.mjs';
import { acquireLifecycleLock } from '../scripts/repair-remote-ocr-preinference-interruption.mjs';
import { canonicalJson, copyTreeStrict, inspectTree } from '../scripts/lib/remote-ocr-local-snapshot.mjs';
import { validateA2ContinuationRuntimeManifest } from '../scripts/lib/remote-ocr-continuation-runtime-manifest.mjs';

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
const documentInterruptedAt = '2026-07-22T04:13:35.387Z';
const incidentInterruptedAt = '2026-07-22T04:13:35.390Z';
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

async function assertHashBoundPair(pathname) {
  const raw = await readFile(pathname);
  assert.equal(
    await readFile(`${pathname}.sha256`, 'utf8'),
    `${sha256(raw)}  ${path.basename(pathname)}\n`,
  );
}

function terminalTemporaryPath(planStateRaw, outputRoot, record) {
  const planStateSha256 = sha256(planStateRaw);
  const token = sha256(canonicalJson({
    schema_version: 1,
    terminal_plan_state_sha256: planStateSha256,
    output_path: record.output_path,
    after_sha256: record.after_sha256,
    after_bytes: record.after_bytes,
  }));
  return `${path.join(outputRoot, record.output_path)}.a2-terminal-${token}.tmp`;
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForPidExit(pid, timeoutMilliseconds = 3_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`PID ${pid} did not exit`);
}

async function readFirstJsonLine(stream) {
  let buffered = '';
  while (!buffered.includes('\n')) {
    const [chunk] = await once(stream, 'data');
    buffered += chunk.toString('utf8');
  }
  return JSON.parse(buffered.slice(0, buffered.indexOf('\n')));
}

async function makeFixture(t, { pageCount = 2, selectionShape = 'explicit_full' } = {}) {
  if (!['explicit_full', 'legacy_absent'].includes(selectionShape)) {
    throw new Error(`unsupported fixture selection shape: ${selectionShape}`);
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'ocr-operator-continuation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputRoot = path.join(root, 'input');
  const outputRoot = path.join(root, 'output');
  const evidenceBaseRoot = path.join(root, 'a2-deploy-evidence');
  const incidentEvidenceRoot = path.join(evidenceBaseRoot, 'incident-operator-freeze');
  const rearmRepairId = 'a'.repeat(64);
  const rearmEvidenceRoot = path.join(evidenceBaseRoot, rearmRepairId);
  const lifecycleLock = path.join(root, '.a2-lifecycle.lock');
  const documentRoot = path.join(outputRoot, 'documents', documentId);
  const statusRoot = path.join(outputRoot, 'status');
  const logRoot = path.join(outputRoot, 'logs');
  await Promise.all([
    mkdir(path.join(inputRoot, 'pdfs'), { recursive: true, mode: 0o700 }),
    mkdir(path.join(documentRoot, 'pages', '0001'), { recursive: true, mode: 0o700 }),
    mkdir(statusRoot, { recursive: true, mode: 0o700 }),
    mkdir(logRoot, { recursive: true, mode: 0o700 }),
    mkdir(incidentEvidenceRoot, { recursive: true, mode: 0o700 }),
    mkdir(rearmEvidenceRoot, { recursive: true, mode: 0o700 }),
    mkdir(path.join(outputRoot, 'timeout-recovery-issuance'), { recursive: true, mode: 0o700 }),
    mkdir(path.join(outputRoot, 'seed-predecessor-evidence'), { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    chmod(outputRoot, 0o700),
    chmod(evidenceBaseRoot, 0o700),
    chmod(incidentEvidenceRoot, 0o700),
    chmod(rearmEvidenceRoot, 0o700),
  ]);
  await writeFile(lifecycleLock, '', { mode: 0o600 });
  const canonicalInputRoot = await realpath(inputRoot);
  const canonicalOutputRoot = await realpath(outputRoot);
  const canonicalIncidentEvidenceRoot = await realpath(incidentEvidenceRoot);
  const canonicalEvidenceBaseRoot = await realpath(evidenceBaseRoot);
  const canonicalRearmEvidenceRoot = await realpath(rearmEvidenceRoot);
  const canonicalRunRoot = await realpath(root);

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
    counts: { selected_documents: 1, selected_pages: pageCount, selected_source_bytes: source.byteLength },
    documents: [{
      id: documentId,
      source_path: 'pdfs/english.pdf',
      source_sha256: sha256(source),
      source_bytes: source.byteLength,
      page_count: pageCount,
      required_page_range: { first: 1, last: pageCount, count: pageCount },
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
    page_count: pageCount,
    configuration: {
      pipeline: 'PaddleOCR-VL',
      pipeline_version: 'v1.6',
      layout_model: 'PP-DocLayoutV3',
      recognizer: 'PaddleOCR-VL-1.6-0.9B official GGUF',
      recognizer_backend: 'llama-cpp-server',
      recognizer_server_url: 'http://127.0.0.1:8112/v1',
      dpi: 240,
      device: 'fixture-gpu',
      python: '3.11.0',
      paddlepaddle: '3.0.0',
      paddleocr: '3.0.0',
      paddlex: '3.0.0',
      vl_rec_max_concurrency: 1,
      server_parallel: 1,
      micro_batch: 16,
      use_queues: true,
    },
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
    ...(selectionShape === 'explicit_full' ? {
      selected_pages: Array.from({ length: pageCount }, (_unused, index) => index + 1),
      selected_pages_complete: false,
    } : {}),
  };
  const statePath = path.join(documentRoot, 'state.json');
  const stateRaw = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  await writeFile(statePath, stateRaw, { mode: 0o600 });

  const logPath = path.join(logRoot, `${documentId}.log`);
  const logRaw = Buffer.from('attempt 6 started\nSignalInfo: *** SIGTERM\n');
  await writeFile(logPath, logRaw, { mode: 0o600 });
  await writeFile(
    path.join(incidentEvidenceRoot, 'incident.json'),
    `${JSON.stringify({
      schema_version: 1,
      type: 'curriculum_a2_operator_verification_freeze_incident',
      cause: 'fixture operator freeze after observer error',
      worker_invocation_id: workerInvocationId,
      interrupted_at: incidentInterruptedAt,
      citation_allowed: false,
      forward_only: true,
      old_four_file_rollback_forbidden: true,
    })}\n`,
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
  const seedReceiptEvidence = await writeJsonSidecar(path.join(outputRoot, 'seed-receipt.json'), seedReceipt);
  const seedCommitEvidence = await writeJsonSidecar(path.join(outputRoot, 'seed-commit.json'), {
    schema_version: 1,
    seed_id: seedId,
    citation_allowed: false,
  });
  const seedJournalEvidence = await writeJsonSidecar(path.join(outputRoot, '.seed-journal.json'), {
    schema_version: 1,
    seed_id: seedId,
    phase: 'committed',
    citation_allowed: false,
  });
  const ledgerEvidence = await writeJsonSidecar(
    path.join(outputRoot, 'timeout-recovery-ledger-identity.json'),
    { schema_version: 1, seed_id: seedId, citation_allowed: false },
  );
  const issuanceName = `${'b'.repeat(64)}.issuance.json`;
  const issuanceEvidence = await writeJsonSidecar(
    path.join(outputRoot, 'timeout-recovery-issuance', issuanceName),
    { schema_version: 1, seed_id: seedId, grant_id: grantId, citation_allowed: false },
  );
  await writeFile(
    path.join(outputRoot, 'seed-predecessor-evidence', 'run-status.json'),
    '{"fixture":true}\n',
    { mode: 0o600 },
  );
  const rearmReservationRaw = Buffer.from(`${JSON.stringify({
    schema_version: 1,
    claim_type: 'curriculum_remote_ocr_preinference_rearm_evidence_reservation',
    repair_id: rearmRepairId,
    evidence_path: rearmEvidenceRoot,
    citation_allowed: false,
  }, null, 2)}\n`);
  const rearmAfterStatusRaw = Buffer.from('{"status":"interrupted"}\n');
  const rearmAfterStatusSidecarRaw = Buffer.from(
    `${sha256(rearmAfterStatusRaw)}  ${documentId}.json\n`,
  );
  const rearmAfterRunStatusRaw = Buffer.from('{"finished":false}\n');
  const rearmAfterRunStatusSidecarRaw = Buffer.from(
    `${sha256(rearmAfterRunStatusRaw)}  run-status.json\n`,
  );
  const rearmAfterRecords = [
    [`status/${documentId}.json`, rearmAfterStatusRaw],
    [`status/${documentId}.json.sha256`, rearmAfterStatusSidecarRaw],
    ['run-status.json', rearmAfterRunStatusRaw],
    ['run-status.json.sha256', rearmAfterRunStatusSidecarRaw],
  ];
  const rearmReceiptEvidence = await writeJsonSidecar(
    path.join(rearmEvidenceRoot, 'repair-receipt.json'),
    {
      schema_version: 1,
      receipt_type: 'curriculum_remote_ocr_preinference_interruption_rearm',
      status: 'prepared_atomic_apply_required',
      repair_id: rearmRepairId,
      transaction: rearmAfterRecords.map(([outputPath, raw]) => ({
        output_path: outputPath,
        after: { sha256: sha256(raw), bytes: raw.byteLength },
      })),
      after_run_status_sha256: sha256(rearmAfterRunStatusRaw),
      after_document_status_sha256: sha256(rearmAfterStatusRaw),
      publication_claim: { sha256: sha256(rearmReservationRaw), bytes: rearmReservationRaw.byteLength },
      citation_allowed: false,
    },
  );
  await writeFile(
    path.join(evidenceBaseRoot, `${rearmRepairId}.claim.json`),
    rearmReservationRaw,
    { mode: 0o600 },
  );

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
      python_runtime: {
        schema_version: 1,
        implementation: 'CPython',
        python_version: '3.11.0',
        packages: {
          paddlepaddle: '3.0.0',
          paddleocr: '3.0.0',
          paddlex: '3.0.0',
          pypdfium2: '4.0.0',
        },
      },
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
  const identityRaw = Buffer.from(`${JSON.stringify(identity, null, 2)}\n`);
  await writeFile(path.join(outputRoot, 'run-identity.json'), identityRaw, { mode: 0o600 });

  const status = {
    schema_version: 1,
    document_id: documentId,
    status: 'interrupted',
    attempt: 6,
    max_attempts: 6,
    page_count: pageCount,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    citation_allowed: false,
    interrupted_at: documentInterruptedAt,
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
    page_count: pageCount,
    started_at: startedAt,
    interrupted_at: documentInterruptedAt,
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
    updated_at: documentInterruptedAt,
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
  const predecessorTree = await inspectTree(path.join(outputRoot, 'seed-predecessor-evidence'));
  const rearmTree = await inspectTree(rearmEvidenceRoot);
  const [evidenceBaseInfo, incidentInfo, lifecycleInfo] = await Promise.all([
    stat(evidenceBaseRoot, { bigint: true }),
    stat(incidentEvidenceRoot, { bigint: true }),
    stat(lifecycleLock, { bigint: true }),
  ]);
  const profile = {
    ...EXACT_A2_FORWARD_CONTINUATION_INCIDENT,
    runRoot: canonicalRunRoot,
    outputRoot: canonicalOutputRoot,
    outputDevice: String(outputInfo.dev),
    outputInode: String(outputInfo.ino),
    lifecycleLock: path.join(canonicalRunRoot, '.a2-lifecycle.lock'),
    lifecycleLockInode: String(lifecycleInfo.ino),
    evidenceBaseRoot: canonicalEvidenceBaseRoot,
    evidenceBaseDevice: String(evidenceBaseInfo.dev),
    evidenceBaseInode: String(evidenceBaseInfo.ino),
    incidentEvidenceRoot: canonicalIncidentEvidenceRoot,
    incidentEvidenceDevice: String(incidentInfo.dev),
    incidentEvidenceInode: String(incidentInfo.ino),
    incidentEvidenceMode: '0700',
    incidentEvidenceUid: String(incidentInfo.uid),
    incidentEvidenceGid: String(incidentInfo.gid),
    incidentEvidenceTreeSha256: incidentTree.tree_sha256,
    runStatusSha256: runStatusEvidence.sha256,
    documentStatusSha256: statusEvidence.sha256,
    logSha256: sha256(logRaw),
    logBytes: logRaw.byteLength,
    stateSha256: sha256(stateRaw),
    documentTreeSha256: documentTree.tree_sha256,
    documentTreeFiles: documentTree.files,
    documentTreeBytes: documentTree.bytes,
    seedId,
    seedReceiptSha256: seedReceiptEvidence.sha256,
    seedReceiptBytes: seedReceiptEvidence.raw.byteLength,
    seedCommitSha256: seedCommitEvidence.sha256,
    seedCommitBytes: seedCommitEvidence.raw.byteLength,
    seedJournalSha256: seedJournalEvidence.sha256,
    seedJournalBytes: seedJournalEvidence.raw.byteLength,
    runIdentitySha256: sha256(identityRaw),
    runIdentityBytes: identityRaw.byteLength,
    ledgerIdentitySha256: ledgerEvidence.sha256,
    ledgerIdentityBytes: ledgerEvidence.raw.byteLength,
    timeoutGrantSha256: grantEvidence.sha256,
    timeoutGrantBytes: grantEvidence.raw.byteLength,
    timeoutConsumptionClaimSha256: claimEvidence.sha256,
    timeoutConsumptionClaimBytes: claimEvidence.raw.byteLength,
    timeoutIssuanceRelativePath: `timeout-recovery-issuance/${issuanceName}`,
    timeoutIssuanceSha256: issuanceEvidence.sha256,
    timeoutIssuanceBytes: issuanceEvidence.raw.byteLength,
    timeoutIssuanceSidecarSha256: sha256(await readFile(path.join(outputRoot, 'timeout-recovery-issuance', `${issuanceName}.sha256`))),
    timeoutIssuanceSidecarBytes: (await stat(path.join(outputRoot, 'timeout-recovery-issuance', `${issuanceName}.sha256`))).size,
    ledgerSidecarSha256: sha256(await readFile(path.join(outputRoot, 'timeout-recovery-ledger-identity.json.sha256'))),
    ledgerSidecarBytes: (await stat(path.join(outputRoot, 'timeout-recovery-ledger-identity.json.sha256'))).size,
    predecessorEvidenceTreeSha256: predecessorTree.tree_sha256,
    predecessorEvidenceTreeFiles: predecessorTree.files,
    predecessorEvidenceTreeBytes: predecessorTree.bytes,
    rearmRepairId,
    rearmEvidenceRoot: canonicalRearmEvidenceRoot,
    rearmReceiptSha256: rearmReceiptEvidence.sha256,
    rearmReceiptBytes: rearmReceiptEvidence.raw.byteLength,
    rearmReservationClaimSha256: sha256(rearmReservationRaw),
    rearmEvidenceTreeSha256: rearmTree.tree_sha256,
    rearmAfterStatusSha256: sha256(rearmAfterStatusRaw),
    rearmAfterStatusSidecarSha256: sha256(rearmAfterStatusSidecarRaw),
    rearmAfterRunStatusSha256: sha256(rearmAfterRunStatusRaw),
    rearmAfterRunStatusSidecarSha256: sha256(rearmAfterRunStatusSidecarRaw),
    workerUnit: 'fixture-worker.service',
    monitorUnit: 'fixture-monitor.service',
    monitorTimerUnit: 'fixture-monitor.timer',
    alertUnit: 'fixture-alert.service',
    llamaUnit: 'fixture-llama.service',
  };
  validateA2ForwardContinuationProfile(profile);
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
    llamaSystemdUnit: profile.llamaUnit,
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
    authorizedAt,
    continuedAt,
    apply: false,
  };
  return {
    root,
    outputRoot: canonicalOutputRoot,
    documentRoot,
    statePath,
    logPath,
    statusPath,
    runStatusPath,
    options,
    profile,
    evidenceBaseRoot: canonicalEvidenceBaseRoot,
    lifecycleLock: profile.lifecycleLock,
    state,
    identity,
  };
}

function unitGeneration(role, revision = 0) {
  const base = 100 + (revision * 10);
  return {
    StateChangeTimestampMonotonic: String(base + 1),
    ActiveEnterTimestampMonotonic: String(base + 2),
    ActiveExitTimestampMonotonic: String(base + 3),
    InactiveEnterTimestampMonotonic: String(base + 4),
    ...(role.endsWith('_timer') ? { LastTriggerUSecMonotonic: String(base + 5) } : {}),
  };
}

function dependencies(fixture, extra = {}) {
  const llamaState = extra.llamaState || {
    active: extra.initialLlamaActive === true,
    invocationId: extra.initialLlamaInvocationId
      || extra.llamaInvocationId
      || 'b'.repeat(32),
    mainPid: extra.initialLlamaMainPid || extra.llamaMainPid || '42',
    managerStartMarker: null,
    processStartMarker: extra.initialLlamaStartMarker || null,
  };
  const generationRevision = extra.unitGenerationRevision || (() => 0);
  const inactiveService = (role, invocationId = '0'.repeat(32), exitStatus = '0') => ({
    LoadState: 'loaded',
    ActiveState: 'inactive',
    SubState: 'dead',
    MainPID: '0',
    InvocationID: invocationId,
    ExecMainStatus: exitStatus,
    Generation: unitGeneration(role, generationRevision(role)),
  });
  return {
    incidentProfile: fixture.profile,
    acquireLifecycleLock: async (pathname) => {
      assert.equal(pathname, fixture.lifecycleLock);
      let released = false;
      const release = async () => { released = true; };
      release.assertHeld = () => assert.equal(released, false, 'lifecycle lock must still be held');
      return release;
    },
    inspectUnit: async (unit, role) => {
      if (role === 'monitor_timer') {
        return {
          LoadState: 'loaded',
          ActiveState: 'inactive',
          SubState: 'dead',
          InvocationID: '',
          Generation: unitGeneration(role, generationRevision(role)),
        };
      }
      if (role === 'worker') return inactiveService(role, workerInvocationId, '75');
      if (role === 'llama' && llamaState.active) {
        return {
          LoadState: 'loaded',
          ActiveState: 'active',
          SubState: 'running',
          MainPID: llamaState.mainPid,
          InvocationID: llamaState.invocationId,
          ExecMainStatus: '0',
          Generation: unitGeneration(role, generationRevision(role) + 1),
        };
      }
      assert.ok([fixture.profile.monitorUnit, fixture.profile.alertUnit, fixture.profile.llamaUnit].includes(unit));
      return inactiveService(role);
    },
    setLlamaStartMarker: async (_profile, marker) => {
      llamaState.managerStartMarker = marker;
    },
    clearLlamaStartMarker: async () => {
      llamaState.managerStartMarker = null;
    },
    verifyLlamaStartMarker: async (activeLlama, marker) => {
      assert.equal(activeLlama.InvocationID, llamaState.invocationId);
      assert.equal(activeLlama.MainPID, llamaState.mainPid);
      assert.equal(llamaState.processStartMarker, marker);
      return true;
    },
    startLlama: async () => {
      llamaState.invocationId = extra.startedLlamaInvocationId || extra.llamaInvocationId || 'b'.repeat(32);
      llamaState.mainPid = extra.startedLlamaMainPid || extra.llamaMainPid || '42';
      llamaState.processStartMarker = llamaState.managerStartMarker;
      llamaState.active = true;
    },
    stopLlama: async () => {
      extra.onStopLlama?.({
        llamaInvocationId: llamaState.invocationId,
        llamaMainPid: llamaState.mainPid,
      });
      llamaState.active = false;
    },
    verifyCommittedSeed: async () => ({ verified: true }),
    verifyActiveRuntime: async () => ({ verified: true }),
    pageCounter: () => fixture.state.page_count,
    validateDocumentOutput: async () => ({
      state_sha256: sha256(await readFile(fixture.statePath)),
      page_artifacts: [],
      page_artifacts_sha256: '7'.repeat(64),
    }),
    now: () => '2026-07-22T04:30:00.000Z',
    handleSignals: false,
    findOwnedOcrProcesses: async () => [],
    ...extra,
  };
}

async function finishFixtureDocument(fixture) {
  await writeFile(fixture.logPath, 'continued attempt 6\n', { flag: 'a' });
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
  completed.selected_pages = Array.from(
    { length: completed.page_count },
    (_unused, index) => index + 1,
  );
  completed.selected_pages_complete = true;
  await mkdir(path.join(fixture.documentRoot, 'pages/0002'), { mode: 0o700 });
  await writeFile(path.join(fixture.documentRoot, 'pages/0002/result.json'), '{}\n', { mode: 0o600 });
  await writeFile(path.join(fixture.documentRoot, 'pages/0002/content.md'), 'page 2\n', { mode: 0o600 });
  await writeFile(fixture.statePath, `${JSON.stringify(completed, null, 2)}\n`, { mode: 0o600 });
  return { code: 0, signal: null, monitorIncident: null };
}

async function writeFixturePage(fixture, pageNumber, { complete = false } = {}) {
  const resultRaw = Buffer.from(`${JSON.stringify({ page: pageNumber })}\n`);
  const contentRaw = Buffer.from(`page ${pageNumber}\n`);
  const pageRoot = path.join(
    fixture.documentRoot,
    'pages',
    String(pageNumber).padStart(4, '0'),
  );
  await mkdir(pageRoot, { mode: 0o700 });
  await Promise.all([
    writeFile(path.join(pageRoot, 'result.json'), resultRaw, { mode: 0o600 }),
    writeFile(path.join(pageRoot, 'content.md'), contentRaw, { mode: 0o600 }),
  ]);
  const state = JSON.parse(await readFile(fixture.statePath, 'utf8'));
  state.completed_pages = [...new Set([...state.completed_pages, pageNumber])]
    .sort((left, right) => left - right);
  state.pages[String(pageNumber)] = {
    status: 'ocr_complete_pending_audit',
    physical_pdf_page: pageNumber,
    rendered_image_sha256: String(pageNumber).repeat(64).slice(0, 64),
    result_json_sha256: sha256(resultRaw),
    content_markdown_sha256: sha256(contentRaw),
    citation_eligible: false,
  };
  if (complete) {
    state.selected_pages = Array.from(
      { length: state.page_count },
      (_unused, index) => index + 1,
    );
    state.selected_pages_complete = true;
  } else if (Object.hasOwn(state, 'selected_pages')
    || Object.hasOwn(state, 'selected_pages_complete')) {
    state.selected_pages_complete = false;
  }
  await writeFile(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await writeFile(fixture.logPath, `page ${pageNumber} durable\n`, { flag: 'a' });
}

async function writePartialPageThenSigkill(fixture) {
  const writer = spawn(process.execPath, ['-e', String.raw`
    const { createHash } = require('node:crypto');
    const { mkdir, readFile, writeFile } = require('node:fs/promises');
    const path = require('node:path');
    const sha256 = (value) => createHash('sha256').update(value).digest('hex');
    (async () => {
      const [documentRoot, statePath, logPath] = process.argv.slice(1);
      const page = 2;
      const resultRaw = Buffer.from(JSON.stringify({ page }) + '\n');
      const contentRaw = Buffer.from('page 2\n');
      const pageRoot = path.join(documentRoot, 'pages', '0002');
      await mkdir(pageRoot, { mode: 0o700 });
      await writeFile(path.join(pageRoot, 'result.json'), resultRaw, { mode: 0o600 });
      await writeFile(path.join(pageRoot, 'content.md'), contentRaw, { mode: 0o600 });
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      state.completed_pages = [1, 2];
      state.pages['2'] = {
        status: 'ocr_complete_pending_audit',
        physical_pdf_page: 2,
        rendered_image_sha256: '2'.repeat(64),
        result_json_sha256: sha256(resultRaw),
        content_markdown_sha256: sha256(contentRaw),
        citation_eligible: false,
      };
      if (Object.prototype.hasOwnProperty.call(state, 'selected_pages')
        || Object.prototype.hasOwnProperty.call(state, 'selected_pages_complete')) {
        state.selected_pages_complete = false;
      }
      await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
      await writeFile(logPath, 'page 2 durable\n', { flag: 'a' });
      process.stdout.write('partial-durable\n');
      setInterval(() => {}, 1000);
    })().catch((error) => { console.error(error); process.exit(2); });
  `, fixture.documentRoot, fixture.statePath, fixture.logPath], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const [marker] = await once(writer.stdout, 'data');
  assert.equal(marker.toString('utf8'), 'partial-durable\n');
  writer.kill('SIGKILL');
  const [code, signal] = await once(writer, 'exit');
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');
  return { code: null, signal: 'SIGKILL', monitorIncident: null };
}

async function establishPartialCheckpoint(t, fixture) {
  await assert.rejects(
    continueOperatorInterruptedAttempt(
      { ...fixture.options, apply: true },
      dependencies(fixture, {
        validateDocumentOutput: validateOcrDocumentOutput,
        invokeOcr: async () => {
          await writeFixturePage(fixture, 2, { complete: false });
          return { code: 0, signal: null, monitorIncident: null };
        },
        afterChildExit: async () => { throw new Error('simulated host SIGKILL after partial write'); },
      }),
    ),
    /simulated host SIGKILL after partial write/u,
  );
  await assert.rejects(
    continueOperatorInterruptedAttempt(
      { ...fixture.options, apply: true },
      dependencies(fixture, {
        validateDocumentOutput: validateOcrDocumentOutput,
        startedLlamaInvocationId: 'c'.repeat(32),
        startedLlamaMainPid: '43',
        afterLlamaStartBeforeExecutionState: async () => {
          throw new Error('stop after durable partial checkpoint');
        },
      }),
    ),
    /stop after durable partial checkpoint/u,
  );
  const paths = operatorContinuationPaths(fixture.evidenceBaseRoot, documentId, 6);
  const checkpointName = (await readdir(paths.states))
    .find((name) => /^\d{6}-partial_checkpoint_0001\.json$/u.test(name));
  assert.ok(checkpointName, 'restart must persist a hash-bound partial checkpoint');
  await assertHashBoundPair(path.join(paths.states, checkpointName));
  return { paths, checkpointName };
}

test('the immutable seeded runner remains byte-identical', async () => {
  assert.equal(sha256(await readFile(runnerPath)), EXPECTED_UNCHANGED_RUNNER_SHA256);
});

test('independent runtime manifest binds the actual continuation module closure without self-hashing', async () => {
  const runtime = await validateA2ContinuationRuntimeManifest();
  const files = runtime.manifest.files.map((descriptor) => descriptor.path);
  for (const required of [
    'scripts/continue-remote-ocr-operator-interruption.mjs',
    'scripts/lib/remote-ocr-operator-continuation.mjs',
    'scripts/run-remote-ocr-offload.mjs',
    'scripts/monitor-remote-ocr-single-shard.mjs',
  ]) assert.ok(files.includes(required), `runtime closure omits ${required}`);
  assert.equal(files.includes('data/remote-ocr-a2-continuation-runtime-manifest.json'), false);
  assert.equal(runtime.manifest.files.find(({ path: pathname }) => pathname === 'scripts/run-remote-ocr-offload.mjs').sha256, EXPECTED_UNCHANGED_RUNNER_SHA256);
});

test('exact operator interruption is a mutation-free dry run', async (t) => {
  const fixture = await makeFixture(t, { selectionShape: 'legacy_absent' });
  assert.equal(Object.hasOwn(fixture.state, 'selected_pages'), false);
  assert.equal(Object.hasOwn(fixture.state, 'selected_pages_complete'), false);
  const before = await inspectTree(fixture.outputRoot);
  const result = await continueOperatorInterruptedAttempt(fixture.options, dependencies(fixture, {
    verifyCommittedSeed: async () => assert.fail('dry run must remain persistence-free'),
    invokeOcr: async () => assert.fail('dry run must not invoke OCR'),
  }));
  const repeated = await continueOperatorInterruptedAttempt(fixture.options, dependencies(fixture, {
    verifyCommittedSeed: async () => assert.fail('dry run must remain persistence-free'),
    invokeOcr: async () => assert.fail('dry run must not invoke OCR'),
  }));
  assert.equal(result.status, 'ready');
  assert.equal(result.attempt, 6);
  assert.equal(result.citation_allowed, false);
  assert.deepEqual(repeated, result);
  assert.deepEqual(await inspectTree(fixture.outputRoot), before);
  await assert.rejects(stat(operatorContinuationPaths(fixture.evidenceBaseRoot, documentId, 6).root), { code: 'ENOENT' });
});

test('apply consumes one claim and completes the same attempt 6 without truncating prior evidence', async (t) => {
  const fixture = await makeFixture(t, { selectionShape: 'legacy_absent' });
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
    completed.selected_pages = Array.from(
      { length: completed.page_count },
      (_unused, index) => index + 1,
    );
    completed.selected_pages_complete = true;
    await mkdir(path.join(fixture.documentRoot, 'pages/0002'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(fixture.documentRoot, 'pages/0002/result.json'), '{}\n', { mode: 0o600 });
    await writeFile(path.join(fixture.documentRoot, 'pages/0002/content.md'), 'page 2\n', { mode: 0o600 });
    await writeFile(fixture.statePath, `${JSON.stringify(completed, null, 2)}\n`, { mode: 0o600 });
    return { code: 0, signal: null, monitorIncident: null };
  };
  const result = await continueOperatorInterruptedAttempt(
    { ...fixture.options, apply: true },
    dependencies(fixture, { invokeOcr }),
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
  const paths = operatorContinuationPaths(fixture.evidenceBaseRoot, documentId, 6);
  for (const pathname of [paths.receipt, paths.receiptSidecar, paths.claim, paths.claimSidecar, paths.interruptedRunStatus, paths.interruptedStatus, paths.interruptedState, paths.preContinuationLog]) {
    assert.equal((await stat(pathname)).mode & 0o777, 0o600);
  }
  const receipt = JSON.parse(await readFile(paths.receipt, 'utf8'));
  const claim = JSON.parse(await readFile(paths.claim, 'utf8'));
  const incident = JSON.parse(await readFile(
    path.join(fixture.profile.incidentEvidenceRoot, 'incident.json'),
    'utf8',
  ));
  assert.equal(receipt.document.interrupted_at, documentInterruptedAt);
  assert.equal(receipt.interrupted_snapshot.document_progress.interrupted_at, documentInterruptedAt);
  assert.equal(receipt.interrupted_snapshot.document_status.interrupted_at, documentInterruptedAt);
  assert.equal(receipt.authorization.interrupted_at, incidentInterruptedAt);
  assert.equal(incident.interrupted_at, incidentInterruptedAt);
  assert.equal(receipt.interrupted_snapshot.document_progress.attempts, 6);
  assert.equal(receipt.interrupted_snapshot.document_status.status, 'interrupted');
  assert.equal(receipt.authorization.runtime_manifest.path, 'runtime-manifest.json');
  assert.match(receipt.authorization.runtime_manifest.sha256, /^[a-f0-9]{64}$/u);
  assert.match(receipt.authorization.runtime_manifest.runtime_tree_sha256, /^[a-f0-9]{64}$/u);
  await assertHashBoundPair(path.join(paths.root, 'runtime-manifest.json'));
  assert.equal(claim.continuation_id, receipt.continuation_id);
  assert.equal(claim.attempt, 6);
  const verifiedEvidence = await validateOperatorContinuationEvidence(paths.root, fixture.profile);
  const verifiedOutput = await validateOperatorContinuationOutput(
    fixture.outputRoot,
    verifiedEvidence,
    fixture.profile,
  );
  assert.equal(verifiedEvidence.terminal.outcome, 'complete');
  assert.equal(verifiedOutput.status.status, 'complete');

  let reinvoked = false;
  const recovered = await continueOperatorInterruptedAttempt(
    { ...fixture.options, apply: true },
    dependencies(fixture, { invokeOcr: async () => { reinvoked = true; } }),
  );
  assert.equal(recovered.status, 'complete');
  assert.equal(recovered.recovered, true);
  assert.equal(reinvoked, false);
});

test('a complete child state survives a host crash before terminal plan without rerunning OCR', async (t) => {
  const fixture = await makeFixture(t);
  await assert.rejects(
    continueOperatorInterruptedAttempt(
      { ...fixture.options, apply: true },
      dependencies(fixture, {
        invokeOcr: async () => finishFixtureDocument(fixture),
        afterChildExit: async () => {
          throw new Error('simulated host crash after complete child state');
        },
      }),
    ),
    /simulated host crash after complete child state/u,
  );
  const completedState = JSON.parse(await readFile(fixture.statePath, 'utf8'));
  assert.deepEqual(completedState.selected_pages, [1, 2]);
  assert.equal(completedState.selected_pages_complete, true);

  const paths = operatorContinuationPaths(fixture.evidenceBaseRoot, documentId, 6);
  assert.equal(
    (await readdir(paths.states)).some((name) => name.endsWith('-terminal_plan.json')),
    false,
  );
  let reinvoked = false;
  const recovered = await continueOperatorInterruptedAttempt(
    { ...fixture.options, apply: true },
    dependencies(fixture, {
      startedLlamaInvocationId: 'c'.repeat(32),
      startedLlamaMainPid: '43',
      invokeOcr: async () => { reinvoked = true; },
    }),
  );
  assert.equal(recovered.status, 'complete');
  assert.equal(recovered.exitCode, 0);
  assert.equal(reinvoked, false);
  const evidence = await validateOperatorContinuationEvidence(paths.root, fixture.profile);
  assert.equal(evidence.terminal.outcome, 'complete');
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
        continueOperatorInterruptedAttempt({ ...fixture.options, apply: true }, dependencies(fixture)),
        pattern,
      );
      await assert.rejects(stat(operatorContinuationPaths(fixture.evidenceBaseRoot, documentId, 6).claim), { code: 'ENOENT' });
    });
  }
});

test('validator rejects an archive whose runtime manifest is rehashed but differs from the trusted local closure', async (t) => {
  const fixture = await makeFixture(t);
  await continueOperatorInterruptedAttempt(
    { ...fixture.options, apply: true },
    dependencies(fixture, { invokeOcr: async () => finishFixtureDocument(fixture) }),
  );
  const paths = operatorContinuationPaths(fixture.evidenceBaseRoot, documentId, 6);
  const runtimePath = path.join(paths.root, 'runtime-manifest.json');
  const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
  runtime.files[0].sha256 = '0'.repeat(64);
  await writeJsonSidecar(runtimePath, runtime);
  await assert.rejects(
    validateOperatorContinuationEvidence(paths.root, fixture.profile),
    /archived A2 continuation runtime manifest differs from the trusted receiver runtime/u,
  );
});

test('a resealed rearm receipt cannot replace the independently pinned after controls', async (t) => {
  const fixture = await makeFixture(t);
  const receiptPath = path.join(fixture.profile.rearmEvidenceRoot, 'repair-receipt.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  receipt.transaction[0].after.sha256 = 'f'.repeat(64);
  const resealed = await writeJsonSidecar(receiptPath, receipt);
  const rearmTree = await inspectTree(fixture.profile.rearmEvidenceRoot);
  const profile = {
    ...fixture.profile,
    rearmReceiptSha256: resealed.sha256,
    rearmReceiptBytes: resealed.raw.byteLength,
    rearmEvidenceTreeSha256: rearmTree.tree_sha256,
  };
  await assert.rejects(
    continueOperatorInterruptedAttempt(
      fixture.options,
      dependencies(fixture, { incidentProfile: profile }),
    ),
    /rearm transaction.*after SHA-256/u,
  );
  const paths = operatorContinuationPaths(fixture.evidenceBaseRoot, documentId, 6);
  await assert.rejects(stat(paths.root), { code: 'ENOENT' });
});

test('a shared-runtime failure after claim never rolls attempt 6 back to 5', async (t) => {
  const fixture = await makeFixture(t);
  const result = await continueOperatorInterruptedAttempt(
    { ...fixture.options, apply: true },
    dependencies(fixture, {
      invokeOcr: async () => ({ code: 1, signal: null, monitorIncident: null }),
      revalidateActiveRuntime: async () => { throw new Error('llama attestation drift'); },
    }),
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 2);
  const runStatus = JSON.parse(await readFile(fixture.runStatusPath, 'utf8'));
  assert.equal(runStatus.documents[documentId].status, 'failed');
  assert.equal(runStatus.documents[documentId].attempts, 6);
  assert.equal(runStatus.documents[documentId].failure_class, 'shared_runtime_configuration');
  const paths = operatorContinuationPaths(fixture.evidenceBaseRoot, documentId, 6);
  assert.equal((await stat(paths.claim)).isFile(), true);
});

test('caller proofs are rejected and claim pairs recover crash states', async (t) => {
  await t.test('caller cannot self-prove grant or InvocationID', async (subtest) => {
    const fixture = await makeFixture(subtest);
    await assert.rejects(
      continueOperatorInterruptedAttempt(
        { ...fixture.options, expectedGrantSha256: grantSha256 },
        dependencies(fixture),
      ),
      /frozen incident authority.*caller/u,
    );
    await assert.rejects(
      continueOperatorInterruptedAttempt(
        { ...fixture.options, workerInvocationId },
        dependencies(fixture),
      ),
      /frozen incident authority.*caller/u,
    );
  });
  await t.test('claim body without sidecar resumes', async (subtest) => {
    const fixture = await makeFixture(subtest);
    await assert.rejects(
      continueOperatorInterruptedAttempt(
        { ...fixture.options, apply: true },
        dependencies(fixture, { afterClaimBody: async () => { throw new Error('simulated claim crash'); } }),
      ),
      /simulated claim crash/u,
    );
    const paths = operatorContinuationPaths(fixture.evidenceBaseRoot, documentId, 6);
    assert.equal((await stat(paths.claim)).isFile(), true);
    await assert.rejects(stat(paths.claimSidecar), { code: 'ENOENT' });
    const result = await continueOperatorInterruptedAttempt(
      { ...fixture.options, apply: true },
      dependencies(fixture, { invokeOcr: async () => finishFixtureDocument(fixture) }),
    );
    assert.equal(result.status, 'complete');
    assert.equal((await stat(paths.claimSidecar)).isFile(), true);
  });
  await t.test('claim sidecar without body resumes', async (subtest) => {
    const fixture = await makeFixture(subtest);
    await assert.rejects(
      continueOperatorInterruptedAttempt(
        { ...fixture.options, apply: true },
        dependencies(fixture, { afterClaimBody: async () => { throw new Error('simulated claim crash'); } }),
      ),
      /simulated claim crash/u,
    );
    const paths = operatorContinuationPaths(fixture.evidenceBaseRoot, documentId, 6);
    const claimRaw = await readFile(paths.claim);
    await writeFile(paths.claimSidecar, `${sha256(claimRaw)}  claim.json\n`, { mode: 0o600 });
    await unlink(paths.claim);
    const result = await continueOperatorInterruptedAttempt(
      { ...fixture.options, apply: true },
      dependencies(fixture, { invokeOcr: async () => finishFixtureDocument(fixture) }),
    );
    assert.equal(result.status, 'complete');
    assert.equal((await stat(paths.claim)).isFile(), true);
  });
});

test('production incident profile pins the independently recovered read-only anchors without confusing evidence and monitor identities', () => {
  const profile = validateA2ForwardContinuationProfile(EXACT_A2_FORWARD_CONTINUATION_INCIDENT);
  const monitorDirectoryInode = '42336296';
  const ledgerIdentityFilename = 'timeout-recovery-ledger-identity.json';
  const ledgerIdentitySidecarFilename = `${ledgerIdentityFilename}.sha256`;
  const ledgerIdentitySidecar = Buffer.from(
    `${profile.ledgerIdentitySha256}  ${ledgerIdentityFilename}\n`,
  );
  assert.equal(
    profile.evidenceBaseRoot,
    '/home/suen/curriculum-ocr-offload/runs/20260716T1520Z-partial14-reprocess/a2-deploy-evidence/20260719T003812Z',
  );
  assert.equal(profile.evidenceBaseDevice, '66306');
  assert.equal(profile.evidenceBaseInode, '41854492');
  assert.notEqual(profile.evidenceBaseInode, monitorDirectoryInode);
  assert.equal(
    profile.stateSha256,
    'd16de657043c260136552cd8cf881791f42308169e2ecf55fe0cab5f155aa09d',
  );
  const productionLegacySelectionShape = {};
  assert.equal(Object.hasOwn(productionLegacySelectionShape, 'selected_pages'), false);
  assert.equal(Object.hasOwn(productionLegacySelectionShape, 'selected_pages_complete'), false);
  assert.equal(
    validateA2InterruptedPartialSelectionState(productionLegacySelectionShape, 649),
    'legacy_absent',
  );
  assert.equal(
    validateA2InterruptedPartialSelectionState({
      selected_pages: [1, 2, 3],
      selected_pages_complete: false,
    }, 3),
    'explicit_full',
  );
  for (const [label, selectionState] of [
    ['false completion without selected pages', { selected_pages_complete: false }],
    ['null completion without selected pages', { selected_pages_complete: null }],
    ['selected pages without completion', { selected_pages: [1, 2, 3] }],
    ['true completion', { selected_pages: [1, 2, 3], selected_pages_complete: true }],
    ['null completion', { selected_pages: [1, 2, 3], selected_pages_complete: null }],
    ['null selected pages', { selected_pages: null, selected_pages_complete: false }],
    ['false selected pages', { selected_pages: false, selected_pages_complete: false }],
    ['non-full selected pages', { selected_pages: [1, 2], selected_pages_complete: false }],
    ['duplicate selected pages', { selected_pages: [1, 2, 2], selected_pages_complete: false }],
    ['unsorted selected pages', { selected_pages: [1, 3, 2], selected_pages_complete: false }],
    ['out-of-range selected pages', { selected_pages: [1, 2, 4], selected_pages_complete: false }],
    ['extra selected pages', { selected_pages: [1, 2, 3, 4], selected_pages_complete: false }],
  ]) {
    assert.throws(
      () => validateA2InterruptedPartialSelectionState(selectionState, 3),
      /selected-page fields are not a valid partial attempt-6 shape/u,
      label,
    );
  }
  assert.equal(profile.schemaVersion, 2);
  assert.equal(profile.documentInterruptedAt, '2026-07-22T04:13:35.387Z');
  assert.equal(profile.incidentInterruptedAt, '2026-07-22T04:13:35.390Z');
  assert.equal(
    Date.parse(profile.incidentInterruptedAt) - Date.parse(profile.documentInterruptedAt),
    3,
  );
  assert.equal(Object.hasOwn(profile, 'interruptedAt'), false);
  assert.throws(
    () => validateA2ForwardContinuationProfile({
      ...profile,
      documentInterruptedAt: '2026-07-22T04:13:35.391Z',
    }),
    /document interruption is after the operator incident/u,
  );
  for (const [label, timestamps] of [
    ['equal timestamps', {
      documentInterruptedAt: '2026-07-22T04:13:35.390Z',
      incidentInterruptedAt: '2026-07-22T04:13:35.390Z',
    }],
    ['document timestamp shifted independently', {
      documentInterruptedAt: '2026-07-22T04:13:35.386Z',
      incidentInterruptedAt: '2026-07-22T04:13:35.390Z',
    }],
    ['incident timestamp shifted independently', {
      documentInterruptedAt: '2026-07-22T04:13:35.387Z',
      incidentInterruptedAt: '2026-07-22T04:13:35.391Z',
    }],
    ['both timestamps shifted while preserving 3 ms order', {
      documentInterruptedAt: '2026-07-22T04:13:35.388Z',
      incidentInterruptedAt: '2026-07-22T04:13:35.391Z',
    }],
  ]) {
    assert.throws(
      () => validateA2ForwardContinuationProfile({ ...profile, ...timestamps }),
      /timestamps are not the exact independently recovered 3 ms pair/u,
      label,
    );
  }
  assert.throws(
    () => validateA2ForwardContinuationProfile({ ...profile, interruptedAt: profile.incidentInterruptedAt }),
    /profile keys differ from the exact schema/u,
  );
  assert.equal(ledgerIdentitySidecarFilename, 'timeout-recovery-ledger-identity.json.sha256');
  assert.equal(
    profile.ledgerIdentitySha256,
    'df77305d01249d59323b76bafeb46cf1a09da30cd90a88602b238c5fa8d62c0c',
  );
  assert.equal(profile.ledgerIdentityBytes, 302);
  assert.equal(ledgerIdentitySidecar.byteLength, 104);
  assert.equal(profile.ledgerSidecarBytes, ledgerIdentitySidecar.byteLength);
  assert.equal(
    profile.ledgerSidecarSha256,
    '72d1609fc05f4b3361673eddedfa5b87505b756a9fe257e1debe04ec2e3f22cc',
  );
  assert.equal(sha256(ledgerIdentitySidecar), profile.ledgerSidecarSha256);
  assert.equal(
    profile.incidentEvidenceTreeSha256,
    'ecad58b65032556b52e274055bde314aa479f58ab19d54bd9c861b1681e5d2c6',
  );
  assert.equal(
    profile.rearmReceiptSha256,
    '05c7d6fae0551ba22527c3353e112fc1ec9bce083f2a627537c089ce76754706',
  );
  assert.equal(profile.rearmReceiptBytes, 7691);
  assert.equal(
    profile.rearmReservationClaimSha256,
    '91c7433f7169b369c3f980140a0ca8d32db7c83d88d34a15894af229b1ff610b',
  );
  assert.equal(
    profile.rearmEvidenceTreeSha256,
    'a758aa84cff692c952ce2d0eae8db5c136d1c35c440710981319f534508e86d6',
  );
});

test('continuation evidence is disjoint and monitor output-root allowlist is unchanged', async (t) => {
  const fixture = await makeFixture(t);
  const paths = operatorContinuationPaths(fixture.evidenceBaseRoot, documentId, 6);
  assert.equal(path.relative(fixture.outputRoot, paths.root).startsWith('..'), true);
  assert.equal(path.relative(fixture.evidenceBaseRoot, paths.root).startsWith('..'), false);
  const monitorPath = fileURLToPath(new URL('../scripts/monitor-remote-ocr-single-shard.mjs', import.meta.url));
  const source = await readFile(monitorPath, 'utf8');
  assert.doesNotMatch(source, /operator-forward-continuations|operator-continuations/u);
  assert.match(source, /'\.remote-ocr-orchestrator\.lock'/u);
});

test('child exit 2 preserves shared-runtime exit 2 semantics', async (t) => {
  const fixture = await makeFixture(t);
  let revalidated = false;
  const result = await continueOperatorInterruptedAttempt(
    { ...fixture.options, apply: true },
    dependencies(fixture, {
      invokeOcr: async () => ({ code: 2, signal: null, monitorIncident: null }),
      revalidateActiveRuntime: async () => { revalidated = true; },
    }),
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 2);
  assert.equal(revalidated, false);
  const runStatus = JSON.parse(await readFile(fixture.runStatusPath, 'utf8'));
  assert.equal(runStatus.documents[documentId].status, 'failed');
  assert.equal(runStatus.documents[documentId].failure_class, 'shared_runtime_configuration');
  assert.equal(runStatus.documents[documentId].attempts, 6);
});

test('a partially successful llama start is stopped and the five-unit gate still runs', async (t) => {
  const fixture = await makeFixture(t);
  const base = dependencies(fixture);
  let llamaActive = false;
  let stopCalls = 0;
  let inactiveLlamaObservations = 0;
  const inactive = (role, invocationId = '0'.repeat(32), exitStatus = '0') => ({
    LoadState: 'loaded',
    ActiveState: 'inactive',
    SubState: 'dead',
    MainPID: '0',
    InvocationID: invocationId,
    ExecMainStatus: exitStatus,
    Generation: unitGeneration(role),
  });
  await assert.rejects(
    continueOperatorInterruptedAttempt(
      { ...fixture.options, apply: true },
      {
        ...base,
        startLlama: async () => {
          llamaActive = true;
          throw new Error('injected start acknowledgement failure');
        },
        verifyLlamaStartMarker: async () => true,
        stopLlama: async () => {
          stopCalls += 1;
          llamaActive = false;
        },
        inspectUnit: async (_unit, role) => {
          if (role === 'monitor_timer') {
            return {
              LoadState: 'loaded',
              ActiveState: 'inactive',
              SubState: 'dead',
              InvocationID: '',
              Generation: unitGeneration(role),
            };
          }
          if (role === 'worker') return inactive(role, workerInvocationId, '75');
          if (role === 'llama' && llamaActive) {
            return {
              LoadState: 'loaded',
              ActiveState: 'active',
              SubState: 'running',
              MainPID: '42',
              InvocationID: 'b'.repeat(32),
              ExecMainStatus: '0',
              Generation: unitGeneration(role, 1),
            };
          }
          if (role === 'llama') inactiveLlamaObservations += 1;
          return inactive(role);
        },
      },
    ),
    /injected start acknowledgement failure/u,
  );
  assert.equal(stopCalls, 1);
  assert.equal(inactiveLlamaObservations, 2);
});

test('terminal plan recovery precedes ordinary seed verification at all 0-4 replacement crash points', async (t) => {
  for (let crashAfter = 0; crashAfter <= 4; crashAfter += 1) {
    await t.test(`crash after ${crashAfter} replacements`, async (subtest) => {
      const fixture = await makeFixture(subtest);
      const paths = operatorContinuationPaths(fixture.evidenceBaseRoot, documentId, 6);
      const verifyCommittedSeed = async () => {
        const terminalPlanName = (await readdir(paths.states).catch(() => []))
          .find((name) => /^\d{6}-terminal_plan\.json$/u.test(name));
        if (!terminalPlanName) return;
        const terminalPlan = JSON.parse(await readFile(path.join(paths.states, terminalPlanName), 'utf8'));
        for (const record of terminalPlan.transaction) {
          const raw = await readFile(path.join(fixture.outputRoot, record.output_path));
          assert.equal(sha256(raw), record.after_sha256, 'seed verification ran before terminal recovery');
          assert.equal(raw.byteLength, record.after_bytes, 'seed verification saw a partial terminal control');
        }
        await Promise.all([
          assertHashBoundPair(fixture.statusPath),
          assertHashBoundPair(fixture.runStatusPath),
        ]);
      };
      await assert.rejects(
        continueOperatorInterruptedAttempt(
          { ...fixture.options, apply: true },
          dependencies(fixture, {
            verifyCommittedSeed,
            invokeOcr: async () => finishFixtureDocument(fixture),
            ...(crashAfter === 0 ? {
              afterTerminalPlan: async () => { throw new Error('simulated terminal persistence crash'); },
            } : {
              afterTerminalReplacement: async (count) => {
                if (count === crashAfter) throw new Error('simulated terminal persistence crash');
              },
            }),
          }),
        ),
        /simulated terminal persistence crash/u,
      );
      let invoked = false;
      const recovered = await continueOperatorInterruptedAttempt(
        { ...fixture.options, apply: true },
        dependencies(fixture, {
          verifyCommittedSeed,
          invokeOcr: async () => { invoked = true; },
        }),
      );
      assert.equal(recovered.status, 'complete');
      assert.equal(recovered.exitCode, 0);
      assert.equal(recovered.recovered, true);
      assert.equal(invoked, false);
      const evidence = await validateOperatorContinuationEvidence(paths.root, fixture.profile);
      assert.equal(evidence.terminal.outcome, 'complete');
    });
  }
});

test('terminal recovery reuses only its deterministic exact-after temp and rejects third bytes', async (t) => {
  for (const exactAfter of [true, false]) {
    await t.test(exactAfter ? 'exact-after temp converges' : 'third bytes fail closed', async (subtest) => {
      const fixture = await makeFixture(subtest);
      const paths = operatorContinuationPaths(fixture.evidenceBaseRoot, documentId, 6);
      await assert.rejects(
        continueOperatorInterruptedAttempt(
          { ...fixture.options, apply: true },
          dependencies(fixture, {
            invokeOcr: async () => finishFixtureDocument(fixture),
            afterTerminalPlan: async () => { throw new Error('stop after durable terminal plan'); },
          }),
        ),
        /stop after durable terminal plan/u,
      );
      const planPath = path.join(paths.states, '000003-terminal_plan.json');
      const planRaw = await readFile(planPath);
      const plan = JSON.parse(planRaw);
      const first = plan.transaction[0];
      const temporary = terminalTemporaryPath(planRaw, fixture.outputRoot, first);
      const temporaryRaw = exactAfter
        ? Buffer.from(first.after_base64, 'base64')
        : Buffer.from('neither before nor after\n');
      await writeFile(temporary, temporaryRaw, { mode: 0o600 });

      const restarted = continueOperatorInterruptedAttempt(
        { ...fixture.options, apply: true },
        dependencies(fixture, { invokeOcr: async () => assert.fail('terminal recovery must not invoke OCR') }),
      );
      if (!exactAfter) {
        await assert.rejects(restarted, /deterministic terminal temp is neither exact after nor safely absent/u);
        return;
      }
      const result = await restarted;
      assert.equal(result.recovered, true);
      await assert.rejects(stat(temporary), { code: 'ENOENT' });
      assert.equal(sha256(await readFile(path.join(fixture.outputRoot, first.output_path))), first.after_sha256);
    });
  }
});

test('SIGKILL after deterministic terminal temp fsync recovers exact-after bytes on restart', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ocr-terminal-temp-kill-'));
  const root = await realpath(temporaryRoot);
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const pathname = path.join(root, 'status.json');
  const before = Buffer.from('before\n');
  const after = Buffer.from('after\n');
  await writeFile(pathname, before, { mode: 0o600 });
  const record = {
    output_path: 'status.json',
    before_sha256: sha256(before),
    before_bytes: before.byteLength,
    after_sha256: sha256(after),
    after_bytes: after.byteLength,
  };
  const planRaw = Buffer.from('immutable terminal plan bytes\n');
  const terminalPlanState = { sha256: sha256(planRaw) };
  const moduleUrl = new URL('../scripts/continue-remote-ocr-operator-interruption.mjs', import.meta.url).href;
  const childScript = String.raw`
    const { recoverableTerminalAtomicReplace } = await import(process.env.CONTINUATION_MODULE_URL);
    await recoverableTerminalAtomicReplace(
      process.env.ROOT,
      process.env.TARGET,
      Buffer.from(process.env.AFTER_BASE64, 'base64'),
      JSON.parse(process.env.RECORD_JSON),
      JSON.parse(process.env.PLAN_STATE_JSON),
      { afterTerminalTempSync: async () => {
        process.stdout.write('temp-synced\n');
        await new Promise(() => setInterval(() => {}, 1000));
      } },
    );
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
    env: {
      ...process.env,
      CONTINUATION_MODULE_URL: moduleUrl,
      ROOT: root,
      TARGET: pathname,
      AFTER_BASE64: after.toString('base64'),
      RECORD_JSON: JSON.stringify(record),
      PLAN_STATE_JSON: JSON.stringify(terminalPlanState),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => {
    if (pidIsAlive(child.pid)) child.kill('SIGKILL');
  });
  const [marker] = await once(child.stdout, 'data');
  assert.match(marker.toString('utf8'), /temp-synced/u);
  const temporary = terminalTemporaryPath(planRaw, root, record);
  const ownership = `${temporary}.owner.json`;
  assert.ok((await readFile(pathname)).equals(before));
  assert.ok((await readFile(temporary)).equals(after));
  assert.equal((await stat(ownership)).isFile(), true);
  child.kill('SIGKILL');
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');

  await recoverableTerminalAtomicReplace(
    root,
    pathname,
    after,
    record,
    terminalPlanState,
  );
  assert.ok((await readFile(pathname)).equals(after));
  await assert.rejects(stat(temporary), { code: 'ENOENT' });
  await assert.rejects(stat(ownership), { code: 'ENOENT' });
});

test('SIGKILL during a plan-owned terminal temp write recovers its exact partial prefix', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ocr-terminal-mid-write-kill-'));
  const root = await realpath(temporaryRoot);
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const pathname = path.join(root, 'status.json');
  const before = Buffer.from('before\n');
  const after = Buffer.alloc(256 * 1024, 0x61);
  await writeFile(pathname, before, { mode: 0o600 });
  const record = {
    output_path: 'status.json',
    before_sha256: sha256(before),
    before_bytes: before.byteLength,
    after_sha256: sha256(after),
    after_bytes: after.byteLength,
  };
  const planRaw = Buffer.from('immutable terminal mid-write plan bytes\n');
  const terminalPlanState = { sha256: sha256(planRaw) };
  const moduleUrl = new URL('../scripts/continue-remote-ocr-operator-interruption.mjs', import.meta.url).href;
  const childScript = String.raw`
    const { recoverableTerminalAtomicReplace } = await import(process.env.CONTINUATION_MODULE_URL);
    const after = Buffer.alloc(Number(process.env.AFTER_BYTES), 0x61);
    await recoverableTerminalAtomicReplace(
      process.env.ROOT,
      process.env.TARGET,
      after,
      JSON.parse(process.env.RECORD_JSON),
      JSON.parse(process.env.PLAN_STATE_JSON),
      {
        terminalWriteChunkBytes: 4096,
        afterTerminalTempChunk: async ({ written, total }) => {
          if (written < total) {
            process.stdout.write(JSON.stringify({ stage: 'partial-temp-durable', written, total }) + '\n');
            await new Promise(() => setInterval(() => {}, 1000));
          }
        },
      },
    );
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
    env: {
      ...process.env,
      CONTINUATION_MODULE_URL: moduleUrl,
      ROOT: root,
      TARGET: pathname,
      AFTER_BYTES: String(after.byteLength),
      RECORD_JSON: JSON.stringify(record),
      PLAN_STATE_JSON: JSON.stringify(terminalPlanState),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => {
    if (pidIsAlive(child.pid)) child.kill('SIGKILL');
  });
  const marker = await Promise.race([
    readFirstJsonLine(child.stdout),
    new Promise((_, reject) => setTimeout(() => reject(new Error('mid-write hook was not reached')), 2_000)),
  ]);
  assert.equal(marker.stage, 'partial-temp-durable');
  assert.ok(marker.written > 0 && marker.written < marker.total);
  const temporary = terminalTemporaryPath(planRaw, root, record);
  const ownership = `${temporary}.owner.json`;
  const partial = await readFile(temporary);
  assert.equal(partial.byteLength, marker.written);
  assert.ok(after.subarray(0, partial.byteLength).equals(partial));
  assert.equal((await stat(ownership)).isFile(), true);
  child.kill('SIGKILL');
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');

  await recoverableTerminalAtomicReplace(root, pathname, after, record, terminalPlanState);
  assert.ok((await readFile(pathname)).equals(after));
  await assert.rejects(stat(temporary), { code: 'ENOENT' });
  await assert.rejects(stat(ownership), { code: 'ENOENT' });
});

test('state journal body-only and sidecar-only crash states resume', async (t) => {
  for (const sidecarOnly of [false, true]) {
    await t.test(sidecarOnly ? 'sidecar only' : 'body only', async (subtest) => {
      const fixture = await makeFixture(subtest);
      await assert.rejects(
        continueOperatorInterruptedAttempt(
          { ...fixture.options, apply: true },
          dependencies(fixture, {
            afterJournalBody: async () => { throw new Error('simulated journal crash'); },
          }),
        ),
        /simulated journal crash/u,
      );
      const paths = operatorContinuationPaths(fixture.evidenceBaseRoot, documentId, 6);
      const statePath = path.join(paths.states, '000001-claimed.json');
      if (sidecarOnly) {
        const raw = await readFile(statePath);
        await writeFile(`${statePath}.sha256`, `${sha256(raw)}  000001-claimed.json\n`, { mode: 0o600 });
        await unlink(statePath);
      }
      const result = await continueOperatorInterruptedAttempt(
        { ...fixture.options, apply: true },
        dependencies(fixture, { invokeOcr: async () => finishFixtureDocument(fixture) }),
      );
      assert.equal(result.status, 'complete');
      assert.equal((await stat(statePath)).isFile(), true);
      assert.equal((await stat(`${statePath}.sha256`)).isFile(), true);
    });
  }
});

test('a durable llama start intent adopts the exact marked invocation after a pre-running crash', async (t) => {
  const fixture = await makeFixture(t);
  const llamaState = {
    active: false,
    invocationId: 'b'.repeat(32),
    mainPid: '42',
    managerStartMarker: null,
    processStartMarker: null,
  };
  const paths = operatorContinuationPaths(fixture.evidenceBaseRoot, documentId, 6);
  await assert.rejects(
    continueOperatorInterruptedAttempt(
      { ...fixture.options, apply: true },
      dependencies(fixture, {
        llamaState,
        startedLlamaInvocationId: 'd'.repeat(32),
        startedLlamaMainPid: '84',
        afterLlamaStartBeforeExecutionState: async () => {
          throw new Error('simulated SIGKILL after marked llama start');
        },
        stopLlama: async () => {
          throw new Error('simulated SIGKILL bypassed closeout');
        },
        invokeOcr: async () => assert.fail('pre-running crash must precede OCR spawn'),
      }),
    ),
    /simulated SIGKILL after marked llama start/u,
  );
  assert.equal(llamaState.active, true);
  assert.match(llamaState.processStartMarker, /^[a-f0-9]{64}$/u);
  const crashStates = (await readdir(paths.states))
    .filter((name) => name.endsWith('.json'))
    .sort();
  assert.deepEqual(crashStates, ['000001-claimed.json']);
  const claimed = JSON.parse(await readFile(path.join(paths.states, crashStates[0]), 'utf8'));
  assert.match(claimed.llama_start_nonce_seed, /^[a-f0-9]{64}$/u);

  const result = await continueOperatorInterruptedAttempt(
    { ...fixture.options, apply: true },
    dependencies(fixture, {
      llamaState,
      startLlama: async () => assert.fail('restart must adopt, not replace, the marked invocation'),
      invokeOcr: async () => finishFixtureDocument(fixture),
    }),
  );
  assert.equal(result.status, 'complete');
  const running = JSON.parse(await readFile(path.join(paths.states, '000002-running.json'), 'utf8'));
  assert.equal(running.llama_invocation_id, 'd'.repeat(32));
  assert.equal(running.llama_main_pid, '84');
  assert.equal(running.llama_start_nonce, llamaState.processStartMarker);
});

test('a pending llama start intent refuses a replacement marker without stopping it', async (t) => {
  const fixture = await makeFixture(t);
  const llamaState = {
    active: false,
    invocationId: 'b'.repeat(32),
    mainPid: '42',
    managerStartMarker: null,
    processStartMarker: null,
  };
  await assert.rejects(
    continueOperatorInterruptedAttempt(
      { ...fixture.options, apply: true },
      dependencies(fixture, {
        llamaState,
        afterLlamaStartBeforeExecutionState: async () => {
          throw new Error('simulated SIGKILL before running state');
        },
        stopLlama: async () => { throw new Error('simulated SIGKILL bypassed closeout'); },
      }),
    ),
    /simulated SIGKILL before running state/u,
  );
  llamaState.invocationId = 'e'.repeat(32);
  llamaState.mainPid = '85';
  llamaState.processStartMarker = 'f'.repeat(64);
  let stopped = false;
  await assert.rejects(
    continueOperatorInterruptedAttempt(
      { ...fixture.options, apply: true },
      dependencies(fixture, {
        llamaState,
        stopLlama: async () => { stopped = true; },
        invokeOcr: async () => assert.fail('foreign active llama must block OCR'),
      }),
    ),
    /active llama start marker is not owned by the pending continuation intent/u,
  );
  assert.equal(stopped, false);
  assert.equal(llamaState.active, true);
});

test('a restarted process seals a running crash tail and appends a verifiable resume_running invocation', async (t) => {
  for (const completeRunningPair of [false, true]) {
    await t.test(completeRunningPair ? 'complete running pair' : 'body-only running pair', async (subtest) => {
      const fixture = await makeFixture(subtest);
      const paths = operatorContinuationPaths(fixture.evidenceBaseRoot, documentId, 6);
      await assert.rejects(
        continueOperatorInterruptedAttempt(
          { ...fixture.options, apply: true },
          dependencies(fixture, {
            llamaInvocationId: 'b'.repeat(32),
            llamaMainPid: '42',
            afterJournalBody: async (pathname) => {
              if (pathname.endsWith('-running.json')) throw new Error('simulated running journal crash');
            },
            invokeOcr: async () => assert.fail('running journal crash must precede OCR'),
          }),
        ),
        /simulated running journal crash/u,
      );
      const runningPath = path.join(paths.states, '000002-running.json');
      if (completeRunningPair) {
        const raw = await readFile(runningPath);
        await writeFile(
          `${runningPath}.sha256`,
          `${sha256(raw)}  ${path.basename(runningPath)}\n`,
          { mode: 0o600 },
        );
      }
      const crashedRunning = JSON.parse(await readFile(runningPath, 'utf8'));
      await assert.rejects(
        continueOperatorInterruptedAttempt(
          { ...fixture.options, apply: true },
          dependencies(fixture, {
            llamaInvocationId: 'b'.repeat(32),
            llamaMainPid: '43',
            validateDocumentOutput: async (_document, _root, _runtime, validationOptions = {}) => {
              if (validationOptions.requireComplete !== false) {
                throw new IncompleteOcrDocumentError(documentId, [2], []);
              }
              return { state_sha256: '6'.repeat(64), page_artifacts: [], page_artifacts_sha256: '7'.repeat(64) };
            },
          }),
        ),
        /resumed llama invocation must differ/u,
      );
      const validateDocumentOutput = async (_document, _root, _runtime, validationOptions = {}) => {
        const state = JSON.parse(await readFile(fixture.statePath, 'utf8'));
        if (!state.selected_pages_complete && validationOptions.requireComplete !== false) {
          throw new IncompleteOcrDocumentError(documentId, [2], []);
        }
        return {
          state_sha256: sha256(await readFile(fixture.statePath)),
          page_artifacts: [],
          page_artifacts_sha256: '7'.repeat(64),
        };
      };
      let priorOwnerAlive = true;
      const stoppedLlamaInvocations = [];
      const result = await continueOperatorInterruptedAttempt(
        { ...fixture.options, apply: true },
        dependencies(fixture, {
          initialLlamaActive: true,
          initialLlamaInvocationId: 'b'.repeat(32),
          initialLlamaMainPid: '42',
          initialLlamaStartMarker: crashedRunning.llama_start_nonce,
          startedLlamaInvocationId: 'c'.repeat(32),
          startedLlamaMainPid: '44',
          findOwnedOcrProcesses: async () => priorOwnerAlive
            ? [{ pid: 9876, uid: typeof process.getuid === 'function' ? process.getuid() : 0 }]
            : [],
          terminateOwnedOcrProcess: async (owned) => {
            assert.equal(owned.pid, 9876);
            priorOwnerAlive = false;
          },
          onStopLlama: ({ llamaInvocationId, llamaMainPid }) => {
            stoppedLlamaInvocations.push([llamaInvocationId, llamaMainPid]);
          },
          validateDocumentOutput,
          invokeOcr: async () => finishFixtureDocument(fixture),
        }),
      );
      assert.equal(result.status, 'complete');
      assert.equal(priorOwnerAlive, false);
      assert.deepEqual(stoppedLlamaInvocations, [
        ['b'.repeat(32), '42'],
        ['c'.repeat(32), '44'],
      ]);
      await assertHashBoundPair(runningPath);
      const stateNames = (await readdir(paths.states))
        .filter((name) => name.endsWith('.json'))
        .sort();
      assert.deepEqual(stateNames.map((name) => name.replace(/^\d{6}-|\.json$/gu, '')), [
        'claimed',
        'running',
        'partial_checkpoint_0001',
        'resume_running_0001',
        'terminal_plan',
        'terminal',
      ]);
      const running = JSON.parse(await readFile(runningPath, 'utf8'));
      const resumed = JSON.parse(await readFile(
        path.join(paths.states, '000004-resume_running_0001.json'),
        'utf8',
      ));
      assert.equal(resumed.resumed_from_state_sha256, sha256(await readFile(runningPath)));
      assert.equal(running.llama_invocation_id, 'b'.repeat(32));
      assert.equal(resumed.llama_invocation_id, 'c'.repeat(32));
      assert.match(running.spawn_nonce, /^[a-f0-9]{64}$/u);
      assert.match(resumed.spawn_nonce, /^[a-f0-9]{64}$/u);
      assert.notEqual(resumed.spawn_nonce, running.spawn_nonce);
      assert.equal(resumed.ocr_command_sha256, running.ocr_command_sha256);
      const evidence = await validateOperatorContinuationEvidence(paths.root, fixture.profile);
      assert.equal(evidence.states.length, 6);
    });
  }
});

test('a valid partial page, state, and log survive SIGKILL through a durable execution checkpoint', async (t) => {
  const fixture = await makeFixture(t, { pageCount: 3, selectionShape: 'legacy_absent' });
  const interrupted = await continueOperatorInterruptedAttempt(
    { ...fixture.options, apply: true },
    dependencies(fixture, {
      validateDocumentOutput: validateOcrDocumentOutput,
      invokeOcr: async () => writePartialPageThenSigkill(fixture),
    }),
  );
  assert.equal(interrupted.status, 'resumable');
  assert.equal(interrupted.exitCode, 75);
  assert.equal(interrupted.signal, 'SIGKILL');
  const partialState = JSON.parse(await readFile(fixture.statePath, 'utf8'));
  assert.deepEqual(partialState.completed_pages, [1, 2]);
  assert.equal(Object.hasOwn(partialState, 'selected_pages'), false);
  assert.equal(Object.hasOwn(partialState, 'selected_pages_complete'), false);

  const paths = operatorContinuationPaths(fixture.evidenceBaseRoot, documentId, 6);
  const interruptedNames = (await readdir(paths.states))
    .filter((name) => name.endsWith('.json'))
    .sort();
  assert.deepEqual(interruptedNames.map((name) => name.replace(/^\d{6}-|\.json$/gu, '')), [
    'claimed',
    'running',
    'partial_checkpoint_0001',
  ]);
  await assert.rejects(stat(path.join(paths.states, '000004-terminal_plan.json')), { code: 'ENOENT' });

  const result = await continueOperatorInterruptedAttempt(
    { ...fixture.options, apply: true },
    dependencies(fixture, {
      validateDocumentOutput: validateOcrDocumentOutput,
      startedLlamaInvocationId: 'c'.repeat(32),
      startedLlamaMainPid: '43',
      invokeOcr: async () => {
        await writeFixturePage(fixture, 3, { complete: true });
        return { code: 0, signal: null, monitorIncident: null };
      },
    }),
  );
  assert.equal(result.status, 'complete');
  const names = (await readdir(paths.states))
    .filter((name) => name.endsWith('.json'))
    .sort();
  assert.deepEqual(names.map((name) => name.replace(/^\d{6}-|\.json$/gu, '')), [
    'claimed',
    'running',
    'partial_checkpoint_0001',
    'resume_running_0001',
    'terminal_plan',
    'terminal',
  ]);
  const checkpoint = JSON.parse(await readFile(path.join(paths.states, names[2]), 'utf8'));
  assert.equal(checkpoint.execution_state_sha256, sha256(await readFile(path.join(paths.states, names[1]))));
  assert.equal(checkpoint.baseline.document_tree_sha256, fixture.profile.documentTreeSha256);
  assert.equal(checkpoint.state.sha256, sha256(Buffer.from(checkpoint.state.base64, 'base64')));
  assert.equal(checkpoint.append_only_log.prefix_sha256, fixture.profile.logSha256);
  assert.equal(checkpoint.append_only_log.prefix_bytes, fixture.profile.logBytes);
  assert.ok(checkpoint.document_tree.entries.some((entry) => entry.includes('\0pages/0002/result.json\0')));
  assert.ok(checkpoint.directories.some((identity) => identity.path === 'pages/0002'));
  const evidence = await validateOperatorContinuationEvidence(paths.root, fixture.profile);
  const output = await validateOperatorContinuationOutput(fixture.outputRoot, evidence, fixture.profile);
  assert.equal(evidence.partialCheckpoints.length, 1);
  assert.equal(output.status.status, 'complete');
});

test('SIGKILL is resumable only for a typed incomplete document with strict valid partial output', async (t) => {
  for (const [label, validateDocumentOutput, invokeOcr] of [
    [
      'no new durable page',
      validateOcrDocumentOutput,
      async () => ({ code: null, signal: 'SIGKILL', monitorIncident: null }),
    ],
    [
      'generic incomplete-looking error',
      async () => { throw new Error('partial output is incomplete'); },
      writePartialPageThenSigkill,
    ],
    [
      'typed incomplete followed by corrupt partial validation',
      async (_document, _root, _runtime, validationOptions = {}) => {
        if (validationOptions.requireComplete !== false) {
          throw new IncompleteOcrDocumentError(documentId, [2], []);
        }
        throw new Error('partial state artifact hash mismatch');
      },
      writePartialPageThenSigkill,
    ],
    [
      'non-SIGKILL signal with otherwise valid partial output',
      validateOcrDocumentOutput,
      async (fixture) => {
        await writeFixturePage(fixture, 2, { complete: false });
        return { code: null, signal: 'SIGTERM', monitorIncident: null };
      },
    ],
  ]) {
    await t.test(label, async (subtest) => {
      const fixture = await makeFixture(subtest, { pageCount: 3 });
      const result = await continueOperatorInterruptedAttempt(
        { ...fixture.options, apply: true },
        dependencies(fixture, {
          validateDocumentOutput,
          invokeOcr: async () => invokeOcr(fixture),
        }),
      );
      assert.equal(result.status, 'quarantined');
      assert.equal(result.exitCode, 12);
      const paths = operatorContinuationPaths(fixture.evidenceBaseRoot, documentId, 6);
      const names = (await readdir(paths.states))
        .filter((name) => name.endsWith('.json'))
        .sort();
      assert.equal(names.some((name) => name.includes('partial_checkpoint')), false);
      assert.equal(names.some((name) => name.includes('terminal_plan')), true);
      assert.equal(names.some((name) => name.endsWith('-terminal.json')), true);
    });
  }
});

test('first spawn rejects a same-bytes state inode replacement after claim', async (t) => {
  const fixture = await makeFixture(t);
  let replaced = false;
  await assert.rejects(
    continueOperatorInterruptedAttempt(
      { ...fixture.options, apply: true },
      dependencies(fixture, {
        afterJournalBody: async (pathname) => {
          if (replaced || !pathname.endsWith('-running.json')) return;
          const replacement = `${fixture.statePath}.replacement`;
          await writeFile(replacement, await readFile(fixture.statePath), { mode: 0o600 });
          await rename(replacement, fixture.statePath);
          replaced = true;
        },
        invokeOcr: async () => assert.fail('state inode replacement must block the first OCR spawn'),
      }),
    ),
    /frozen state.*provenance|state.*inode/u,
  );
  assert.equal(replaced, true);
});

test('restart resumes only a typed incomplete document with a successful strict partial validation', async (t) => {
  for (const [label, validateDocumentOutput, pattern] of [
    [
      'generic incomplete-looking error',
      async () => { throw new Error('partial output is incomplete'); },
      /partial output is incomplete/u,
    ],
    [
      'typed incomplete followed by corrupt partial state',
      async (_document, _root, _runtime, validationOptions = {}) => {
        if (validationOptions.requireComplete !== false) {
          throw new IncompleteOcrDocumentError(documentId, [2], []);
        }
        throw new Error('partial state artifact hash mismatch');
      },
      /partial state artifact hash mismatch/u,
    ],
  ]) {
    await t.test(label, async (subtest) => {
      const fixture = await makeFixture(subtest);
      await assert.rejects(
        continueOperatorInterruptedAttempt(
          { ...fixture.options, apply: true },
          dependencies(fixture, {
            afterChildExit: async () => { throw new Error('simulated host SIGKILL'); },
            invokeOcr: async () => ({ code: 0, signal: null, monitorIncident: null }),
          }),
        ),
        /simulated host SIGKILL/u,
      );
      const paths = operatorContinuationPaths(fixture.evidenceBaseRoot, documentId, 6);
      await assert.rejects(
        continueOperatorInterruptedAttempt(
          { ...fixture.options, apply: true },
          dependencies(fixture, {
            validateDocumentOutput,
            startedLlamaInvocationId: 'c'.repeat(32),
            startedLlamaMainPid: '43',
            invokeOcr: async () => assert.fail('untyped or corrupt partial output must block respawn'),
          }),
        ),
        pattern,
      );
      assert.equal(
        (await readdir(paths.states)).some((name) => name.includes('partial_checkpoint')),
        false,
      );
    });
  }
});

test('partial checkpoint rejects artifact, state, log, prefix, and directory identity tamper before respawn', async (t) => {
  const cases = [
    ['page artifact replacement', async (fixture) => {
      await writeFile(path.join(fixture.documentRoot, 'pages/0002/content.md'), 'tampered page 2\n', { mode: 0o600 });
    }, /checkpoint.*document|changed.*checkpoint|page artifact/u],
    ['state truncation', async (fixture) => {
      await writeFile(fixture.statePath, '{\n', { mode: 0o600 });
    }, /checkpoint.*(?:state|document)|state.*checkpoint/u],
    ['state inode replacement', async (fixture) => {
      const replacement = `${fixture.statePath}.replacement`;
      await writeFile(replacement, await readFile(fixture.statePath), { mode: 0o600 });
      await rename(replacement, fixture.statePath);
    }, /checkpoint.*state|state.*identity/u],
    ['log truncation', async (fixture) => {
      await writeFile(fixture.logPath, 'short\n', { mode: 0o600 });
    }, /checkpoint.*log|log.*(?:truncated|prefix|identity)/u],
    ['log inode replacement', async (fixture) => {
      const replacement = `${fixture.logPath}.replacement`;
      await writeFile(replacement, await readFile(fixture.logPath), { mode: 0o600 });
      await rename(replacement, fixture.logPath);
    }, /checkpoint.*log|log.*identity/u],
    ['log prefix tamper', async (fixture) => {
      const raw = await readFile(fixture.logPath);
      raw[0] = raw[0] === 0x61 ? 0x62 : 0x61;
      await writeFile(fixture.logPath, raw, { mode: 0o600 });
    }, /checkpoint.*log|log.*prefix/u],
    ['directory inode replacement', async (fixture) => {
      const pageRoot = path.join(fixture.documentRoot, 'pages/0002');
      const moved = path.join(fixture.documentRoot, 'pages/0002-old');
      const resultRaw = await readFile(path.join(pageRoot, 'result.json'));
      const contentRaw = await readFile(path.join(pageRoot, 'content.md'));
      await rename(pageRoot, moved);
      await mkdir(pageRoot, { mode: 0o700 });
      await writeFile(path.join(pageRoot, 'result.json'), resultRaw, { mode: 0o600 });
      await writeFile(path.join(pageRoot, 'content.md'), contentRaw, { mode: 0o600 });
      await rm(moved, { recursive: true, force: true });
    }, /directory identity|checkpoint.*director/u],
  ];
  for (const [label, mutate, pattern] of cases) {
    await t.test(label, async (subtest) => {
      const fixture = await makeFixture(subtest, { pageCount: 3 });
      await establishPartialCheckpoint(subtest, fixture);
      await mutate(fixture);
      await assert.rejects(
        continueOperatorInterruptedAttempt(
          { ...fixture.options, apply: true },
          dependencies(fixture, {
            validateDocumentOutput: validateOcrDocumentOutput,
            startedLlamaInvocationId: 'd'.repeat(32),
            startedLlamaMainPid: '44',
            invokeOcr: async () => assert.fail('checkpoint tamper must block OCR respawn'),
          }),
        ),
        pattern,
      );
    });
  }
});

test('SIGKILLed continuation host leaves only its hash-bound OCR and exact llama eligible for recovery', async (t) => {
  const spawnNonce = 'd'.repeat(64);
  const commandSha256 = 'e'.repeat(64);
  const llamaInvocationId = 'f'.repeat(32);
  const sleeper = 'setInterval(() => {}, 1000)';
  const unrelated = spawn(process.execPath, ['-e', sleeper], { stdio: 'ignore' });
  const ownerScript = String.raw`
    const { spawn } = require('node:child_process');
    const sleeper = 'setInterval(() => {}, 1000)';
    const ocr = spawn(process.execPath, ['-e', sleeper], {
      env: {
        ...process.env,
        CURRICULUM_A2_CONTINUATION_SPAWN_NONCE: process.env.OWNER_NONCE,
        CURRICULUM_A2_CONTINUATION_COMMAND_SHA256: process.env.OWNER_COMMAND_SHA256,
      },
      stdio: 'ignore',
    });
    const llama = spawn(process.execPath, ['-e', sleeper], { stdio: 'ignore' });
    process.stdout.write(JSON.stringify({ ocrPid: ocr.pid, llamaPid: llama.pid }) + '\n');
    setInterval(() => {}, 1000);
  `;
  const owner = spawn(process.execPath, ['-e', ownerScript], {
    env: {
      ...process.env,
      OWNER_NONCE: spawnNonce,
      OWNER_COMMAND_SHA256: commandSha256,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const owned = await readFirstJsonLine(owner.stdout);
  const cleanupPids = new Set([unrelated.pid, owner.pid, owned.ocrPid, owned.llamaPid]);
  t.after(async () => {
    for (const pid of cleanupPids) {
      if (pidIsAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  });
  assert.equal(pidIsAlive(owned.ocrPid), true);
  assert.equal(pidIsAlive(owned.llamaPid), true);
  owner.kill('SIGKILL');
  const [ownerCode, ownerSignal] = await once(owner, 'exit');
  assert.equal(ownerCode, null);
  assert.equal(ownerSignal, 'SIGKILL');

  const profile = {
    llamaUnit: 'fixture-llama.service',
  };
  const executionState = {
    value: {
      spawn_nonce: spawnNonce,
      ocr_command_sha256: commandSha256,
      llama_start_nonce: 'a'.repeat(64),
      llama_invocation_id: llamaInvocationId,
      llama_main_pid: String(owned.llamaPid),
    },
  };
  const inspectUnit = async () => pidIsAlive(owned.llamaPid) ? {
    LoadState: 'loaded',
    ActiveState: 'active',
    SubState: 'running',
    MainPID: String(owned.llamaPid),
    InvocationID: llamaInvocationId,
    ExecMainStatus: '0',
    Generation: unitGeneration('llama', 1),
  } : {
    LoadState: 'loaded',
    ActiveState: 'inactive',
    SubState: 'dead',
    MainPID: '0',
    InvocationID: llamaInvocationId,
    ExecMainStatus: '0',
    Generation: unitGeneration('llama', 2),
  };
  const recovered = await reconcileOwnedContinuationExecution(profile, executionState, {
    inspectUnit,
    findOwnedOcrProcesses: async (state) => {
      assert.equal(state.value.spawn_nonce, spawnNonce);
      assert.equal(state.value.ocr_command_sha256, commandSha256);
      return pidIsAlive(owned.ocrPid)
        ? [{
            pid: owned.ocrPid,
            uid: typeof process.getuid === 'function' ? process.getuid() : 0,
            starttime: 'fixture-owned-starttime',
          }]
        : [];
    },
    revalidateOwnedOcrProcess: async (identity) => pidIsAlive(identity.pid) ? identity : null,
    verifyLlamaStartMarker: async () => true,
    stopLlama: async () => {
      assert.equal(pidIsAlive(owned.llamaPid), true);
      process.kill(owned.llamaPid, 'SIGTERM');
      await waitForPidExit(owned.llamaPid);
    },
    ownedProcessGraceMilliseconds: 250,
  });
  assert.equal(recovered.terminated_ocr_pid, owned.ocrPid);
  assert.equal(recovered.stopped_llama, true);
  assert.equal(pidIsAlive(owned.ocrPid), false);
  assert.equal(pidIsAlive(owned.llamaPid), false);
  assert.equal(pidIsAlive(unrelated.pid), true, 'unrelated process must not be signalled');
});

test('orphan recovery refuses a different live llama identity before signalling any process', async () => {
  let processSignalled = false;
  let llamaStopped = false;
  await assert.rejects(
    reconcileOwnedContinuationExecution(
      { llamaUnit: 'fixture-llama.service' },
      {
        value: {
          spawn_nonce: '1'.repeat(64),
          ocr_command_sha256: '2'.repeat(64),
          llama_start_nonce: '5'.repeat(64),
          llama_invocation_id: '3'.repeat(32),
          llama_main_pid: '123',
        },
      },
      {
        findOwnedOcrProcesses: async () => [{
          pid: 456,
          uid: typeof process.getuid === 'function' ? process.getuid() : 0,
        }],
        inspectUnit: async () => ({
          LoadState: 'loaded',
          ActiveState: 'active',
          SubState: 'running',
          MainPID: '999',
          InvocationID: '4'.repeat(32),
          ExecMainStatus: '0',
          Generation: unitGeneration('llama', 1),
        }),
        terminateOwnedOcrProcess: async () => { processSignalled = true; },
        stopLlama: async () => { llamaStopped = true; },
      },
    ),
    /active llama unit is not owned/u,
  );
  assert.equal(processSignalled, false);
  assert.equal(llamaStopped, false);
});

test('orphan recovery revalidates OCR starttime and ownership markers immediately before signalling', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => {
    if (pidIsAlive(child.pid)) child.kill('SIGKILL');
  });
  let scans = 0;
  let signals = 0;
  await assert.rejects(
    reconcileOwnedContinuationExecution(
      { llamaUnit: 'fixture-llama.service' },
      {
        value: {
          spawn_nonce: '1'.repeat(64),
          ocr_command_sha256: '2'.repeat(64),
          llama_start_nonce: '5'.repeat(64),
          llama_invocation_id: '3'.repeat(32),
          llama_main_pid: '123',
        },
      },
      {
        findOwnedOcrProcesses: async () => scans++ === 0 ? [{
          pid: child.pid,
          uid: typeof process.getuid === 'function' ? process.getuid() : 0,
          starttime: '100',
        }] : [],
        revalidateOwnedOcrProcess: async () => ({
          pid: child.pid,
          uid: typeof process.getuid === 'function' ? process.getuid() : 0,
          starttime: '101',
        }),
        signalOwnedOcrProcess: () => { signals += 1; },
        inspectUnit: async () => ({
          LoadState: 'loaded',
          ActiveState: 'inactive',
          SubState: 'dead',
          MainPID: '0',
          InvocationID: '',
          ExecMainStatus: '0',
          Generation: unitGeneration('llama', 1),
        }),
      },
    ),
    /owned OCR process identity changed immediately before signal/u,
  );
  assert.equal(signals, 0);
  assert.equal(pidIsAlive(child.pid), true, 'replacement PID must survive fail-closed recovery');
});

test('orphan recovery re-inspects llama InvocationID and MainPID immediately before stop', async () => {
  const expectedInvocation = '3'.repeat(32);
  const replacementInvocation = '4'.repeat(32);
  let phase = 'expected';
  let stopped = false;
  let markerChecks = 0;
  const active = (invocationId, mainPid, revision) => ({
    LoadState: 'loaded',
    ActiveState: 'active',
    SubState: 'running',
    MainPID: mainPid,
    InvocationID: invocationId,
    ExecMainStatus: '0',
    Generation: unitGeneration('llama', revision),
  });
  await assert.rejects(
    reconcileOwnedContinuationExecution(
      { llamaUnit: 'fixture-llama.service' },
      {
        value: {
          spawn_nonce: '1'.repeat(64),
          ocr_command_sha256: '2'.repeat(64),
          llama_start_nonce: '5'.repeat(64),
          llama_invocation_id: expectedInvocation,
          llama_main_pid: '123',
        },
      },
      {
        findOwnedOcrProcesses: async () => [],
        inspectUnit: async () => phase === 'expected'
          ? active(expectedInvocation, '123', 1)
          : active(replacementInvocation, '456', 2),
        verifyLlamaStartMarker: async () => {
          markerChecks += 1;
          phase = 'replacement';
          return true;
        },
        stopLlama: async () => { stopped = true; },
      },
    ),
    /llama invocation changed immediately before stop/u,
  );
  assert.equal(stopped, false);
  assert.equal(phase, 'replacement');
  assert.equal(markerChecks, 1);
});

test('real Linux proc ownership discovery terminates only the exact marked OCR process', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const spawnNonce = '5'.repeat(64);
  const commandSha256 = '6'.repeat(64);
  const owned = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: {
      ...process.env,
      CURRICULUM_A2_CONTINUATION_SPAWN_NONCE: spawnNonce,
      CURRICULUM_A2_CONTINUATION_COMMAND_SHA256: commandSha256,
    },
    stdio: 'ignore',
  });
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => {
    for (const pid of [owned.pid, unrelated.pid]) if (pidIsAlive(pid)) process.kill(pid, 'SIGKILL');
  });
  const ownedExit = once(owned, 'exit');
  const result = await reconcileOwnedContinuationExecution(
    { llamaUnit: 'fixture-llama.service' },
    {
      value: {
        spawn_nonce: spawnNonce,
        ocr_command_sha256: commandSha256,
        llama_start_nonce: '8'.repeat(64),
        llama_invocation_id: '7'.repeat(32),
        llama_main_pid: '123',
      },
    },
    {
      inspectUnit: async () => ({
        LoadState: 'loaded',
        ActiveState: 'inactive',
        SubState: 'dead',
        MainPID: '0',
        InvocationID: '',
        ExecMainStatus: '0',
        Generation: unitGeneration('llama', 1),
      }),
      ownedProcessGraceMilliseconds: 250,
    },
  );
  const [code, signal] = await ownedExit;
  assert.equal(code, null);
  assert.equal(signal, 'SIGTERM');
  assert.deepEqual(result.terminated_ocr_pids, [owned.pid]);
  assert.equal(pidIsAlive(unrelated.pid), true);
});

test('lifecycle pathname replacement during OCR aborts before any terminal control transition', async (t) => {
  const fixture = await makeFixture(t);
  const originalInode = (await stat(fixture.lifecycleLock, { bigint: true })).ino;
  await assert.rejects(
    continueOperatorInterruptedAttempt(
      { ...fixture.options, apply: true },
      dependencies(fixture, {
        invokeOcr: async () => {
          await unlink(fixture.lifecycleLock);
          await writeFile(fixture.lifecycleLock, '', { mode: 0o600 });
          assert.notEqual((await stat(fixture.lifecycleLock, { bigint: true })).ino, originalInode);
          return finishFixtureDocument(fixture);
        },
      }),
    ),
    /lifecycle lock pathname\/inode differs/u,
  );
  const status = JSON.parse(await readFile(fixture.statusPath, 'utf8'));
  assert.equal(status.status, 'interrupted');
  const paths = operatorContinuationPaths(fixture.evidenceBaseRoot, documentId, 6);
  assert.equal(
    (await readdir(paths.states)).some((name) => name.includes('terminal_plan')),
    false,
  );
});

test('a transient monitor generation change is detected even after the unit returns inactive', async (t) => {
  const fixture = await makeFixture(t);
  let monitorRevision = 0;
  await assert.rejects(
    continueOperatorInterruptedAttempt(
      { ...fixture.options, apply: true },
      dependencies(fixture, {
        unitGenerationRevision: (role) => (role === 'monitor' ? monitorRevision : 0),
        invokeOcr: async () => {
          monitorRevision = 1;
          return finishFixtureDocument(fixture);
        },
      }),
    ),
    /InvocationID or generation fence changed/u,
  );
  const status = JSON.parse(await readFile(fixture.statusPath, 'utf8'));
  assert.equal(status.status, 'interrupted');
  const paths = operatorContinuationPaths(fixture.evidenceBaseRoot, documentId, 6);
  assert.equal(
    (await readdir(paths.states)).some((name) => name.includes('terminal_plan')),
    false,
  );
});

test('forward-only validator quarantines invalid new paths and log inode replacement', async (t) => {
  const attacks = [
    ['existing page mutation', async (fixture) => {
      await writeFile(path.join(fixture.documentRoot, 'pages/0001/unexpected.txt'), 'bad\n', { mode: 0o600 });
    }],
    ['hidden staging path', async (fixture) => {
      await mkdir(path.join(fixture.documentRoot, 'pages/0002'), { mode: 0o700 });
      await writeFile(path.join(fixture.documentRoot, 'pages/0002/.staging'), 'bad\n', { mode: 0o600 });
    }],
    ['out of range page', async (fixture) => {
      await mkdir(path.join(fixture.documentRoot, 'pages/0003'), { mode: 0o700 });
      await writeFile(path.join(fixture.documentRoot, 'pages/0003/result.json'), '{}\n', { mode: 0o600 });
    }],
    ['log inode replacement', async (fixture) => {
      const prefix = await readFile(fixture.logPath);
      await unlink(fixture.logPath);
      await writeFile(fixture.logPath, Buffer.concat([prefix, Buffer.from('replacement\n')]), { mode: 0o600 });
    }],
  ];
  for (const [label, attack] of attacks) {
    await t.test(label, async (subtest) => {
      const fixture = await makeFixture(subtest);
      const result = await continueOperatorInterruptedAttempt(
        { ...fixture.options, apply: true },
        dependencies(fixture, {
          invokeOcr: async () => {
            await attack(fixture);
            return { code: 0, signal: null, monitorIncident: null };
          },
        }),
      );
      assert.equal(result.status, 'quarantined');
      assert.equal(result.exitCode, 12);
    });
  }
});

test('five-unit gate rejects a live monitor and exact worker InvocationID drift', async (t) => {
  const fixture = await makeFixture(t);
  const base = dependencies(fixture);
  await assert.rejects(
    inspectA2ContinuationUnits(fixture.profile, {
      inspectUnit: async (unit, role) => {
        const state = await base.inspectUnit(unit, role);
        return role === 'monitor' ? { ...state, ActiveState: 'active', SubState: 'running', MainPID: '99' } : state;
      },
    }),
    /not quiescent/u,
  );
  await assert.rejects(
    inspectA2ContinuationUnits(fixture.profile, {
      inspectUnit: async (unit, role) => {
        const state = await base.inspectUnit(unit, role);
        return role === 'worker' ? { ...state, InvocationID: 'c'.repeat(32) } : state;
      },
    }),
    /InvocationID/u,
  );
});

test('receiver-grade evidence validation rejects missing, tampered, and replaced claim evidence', async (t) => {
  const mutations = [
    ['missing claim', async (paths) => unlink(paths.claim)],
    ['tampered claim sidecar', async (paths) => writeFile(
      paths.claimSidecar,
      `${'0'.repeat(64)}  claim.json\n`,
      { mode: 0o600 },
    )],
    ['coherently tampered interrupted status archive', async (paths) => {
      const status = JSON.parse(await readFile(paths.interruptedStatus, 'utf8'));
      status.interrupted_at = '2026-07-22T04:13:35.391Z';
      await writeJsonSidecar(paths.interruptedStatus, status);
    }],
    ['coherently tampered document inventory', async (paths) => {
      const inventory = JSON.parse(await readFile(paths.documentInventory, 'utf8'));
      inventory.log.inode = String(BigInt(inventory.log.inode) + 1n);
      await writeJsonSidecar(paths.documentInventory, inventory);
    }],
    ['replaced evidence directory inode', async (paths, fixture) => {
      const original = `${paths.root}.original`;
      await rename(paths.root, original);
      await copyTreeStrict(original, paths.root);
      assert.notEqual((await stat(paths.root)).ino, (await stat(original)).ino);
      void fixture;
    }],
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, async (subtest) => {
      const fixture = await makeFixture(subtest);
      await continueOperatorInterruptedAttempt(
        { ...fixture.options, apply: true },
        dependencies(fixture, { invokeOcr: async () => finishFixtureDocument(fixture) }),
      );
      const paths = operatorContinuationPaths(fixture.evidenceBaseRoot, documentId, 6);
      await mutate(paths, fixture);
      await assert.rejects(
        validateOperatorContinuationEvidence(paths.root, fixture.profile),
        /missing|sidecar|evidence root|claim|receipt|snapshot|inventory/u,
      );
    });
  }
});

test('receiver-grade output validation retains every pre-continuation directory inode', async (t) => {
  const fixture = await makeFixture(t);
  await continueOperatorInterruptedAttempt(
    { ...fixture.options, apply: true },
    dependencies(fixture, { invokeOcr: async () => finishFixtureDocument(fixture) }),
  );
  const paths = operatorContinuationPaths(fixture.evidenceBaseRoot, documentId, 6);
  const evidence = await validateOperatorContinuationEvidence(paths.root, fixture.profile);
  const pageRoot = path.join(fixture.documentRoot, 'pages', '0001');
  const original = `${pageRoot}.original`;
  await rename(pageRoot, original);
  await copyTreeStrict(original, pageRoot);
  await assert.rejects(
    validateOperatorContinuationOutput(fixture.outputRoot, evidence, fixture.profile),
    /directory identity changed/u,
  );
});

test('real inherited-fd lifecycle flock excludes a second holder on Linux', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'a2-continuation-flock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, '.a2-lifecycle.lock');
  await writeFile(lockPath, '', { mode: 0o600 });
  const first = await acquireLifecycleLock(lockPath);
  await assert.rejects(acquireLifecycleLock(lockPath), /flock is held or unavailable/u);
  await first();
  const second = await acquireLifecycleLock(lockPath);
  await second();
});

test('real inherited-fd lifecycle lock detects pathname replacement on Linux', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'a2-continuation-lock-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, '.a2-lifecycle.lock');
  await writeFile(lockPath, '', { mode: 0o600 });
  const originalInode = String((await stat(lockPath, { bigint: true })).ino);
  const held = await acquireLifecycleLock(lockPath);
  await held.verifyIdentity({ inode: originalInode });
  await unlink(lockPath);
  await writeFile(lockPath, '', { mode: 0o600 });
  await assert.rejects(
    held.verifyIdentity({ inode: originalInode }),
    /descriptor and pathname identity diverged/u,
  );
  await held();
  const replacement = await acquireLifecycleLock(lockPath);
  await replacement();
});
