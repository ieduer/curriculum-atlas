import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  continueOperatorInterruptedAttempt,
  inspectA2ContinuationUnits,
  operatorContinuationPaths,
} from '../scripts/continue-remote-ocr-operator-interruption.mjs';
import {
  EXACT_A2_FORWARD_CONTINUATION_INCIDENT,
  validateA2ForwardContinuationProfile,
  validateOperatorContinuationEvidence,
  validateOperatorContinuationOutput,
} from '../scripts/lib/remote-ocr-operator-continuation.mjs';
import { acquireLifecycleLock } from '../scripts/repair-remote-ocr-preinference-interruption.mjs';
import { canonicalJson, copyTreeStrict, inspectTree } from '../scripts/lib/remote-ocr-local-snapshot.mjs';

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

function dependencies(fixture, extra = {}) {
  let llamaActive = false;
  const inactiveService = (invocationId = '0'.repeat(32), exitStatus = '0') => ({
    LoadState: 'loaded',
    ActiveState: 'inactive',
    SubState: 'dead',
    MainPID: '0',
    InvocationID: invocationId,
    ExecMainStatus: exitStatus,
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
        return { LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead', InvocationID: '' };
      }
      if (role === 'worker') return inactiveService(workerInvocationId, '75');
      if (role === 'llama' && llamaActive) {
        return {
          LoadState: 'loaded',
          ActiveState: 'active',
          SubState: 'running',
          MainPID: '42',
          InvocationID: 'b'.repeat(32),
          ExecMainStatus: '0',
        };
      }
      assert.ok([fixture.profile.monitorUnit, fixture.profile.alertUnit, fixture.profile.llamaUnit].includes(unit));
      return inactiveService();
    },
    startLlama: async () => { llamaActive = true; },
    stopLlama: async () => { llamaActive = false; },
    verifyCommittedSeed: async () => ({ verified: true }),
    verifyActiveRuntime: async () => ({ verified: true }),
    pageCounter: () => 2,
    validateDocumentOutput: async () => ({
      state_sha256: sha256(await readFile(fixture.statePath)),
      page_artifacts: [],
      page_artifacts_sha256: '7'.repeat(64),
    }),
    now: () => '2026-07-22T04:30:00.000Z',
    handleSignals: false,
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
  completed.selected_pages_complete = true;
  await mkdir(path.join(fixture.documentRoot, 'pages/0002'), { mode: 0o700 });
  await writeFile(path.join(fixture.documentRoot, 'pages/0002/result.json'), '{}\n', { mode: 0o600 });
  await writeFile(path.join(fixture.documentRoot, 'pages/0002/content.md'), 'page 2\n', { mode: 0o600 });
  await writeFile(fixture.statePath, `${JSON.stringify(completed, null, 2)}\n`, { mode: 0o600 });
  return { code: 0, signal: null, monitorIncident: null };
}

test('the immutable seeded runner remains byte-identical', async () => {
  assert.equal(sha256(await readFile(runnerPath)), EXPECTED_UNCHANGED_RUNNER_SHA256);
});

test('exact operator interruption is a mutation-free dry run', async (t) => {
  const fixture = await makeFixture(t);
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
  assert.equal(receipt.interrupted_snapshot.document_progress.attempts, 6);
  assert.equal(receipt.interrupted_snapshot.document_status.status, 'interrupted');
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

test('production incident profile remains explicitly fail-closed before lock acquisition', async () => {
  let lockAttempted = false;
  await assert.rejects(
    continueOperatorInterruptedAttempt({}, {
      acquireLifecycleLock: async () => {
        lockAttempted = true;
        assert.fail('incomplete frozen profile must fail before lifecycle flock');
      },
    }),
    /profile is incomplete.*incidentEvidenceTreeSha256.*rearmReceiptSha256/u,
  );
  assert.equal(lockAttempted, false);
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
  const inactive = (invocationId = '0'.repeat(32), exitStatus = '0') => ({
    LoadState: 'loaded',
    ActiveState: 'inactive',
    SubState: 'dead',
    MainPID: '0',
    InvocationID: invocationId,
    ExecMainStatus: exitStatus,
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
        stopLlama: async () => {
          stopCalls += 1;
          llamaActive = false;
        },
        inspectUnit: async (_unit, role) => {
          if (role === 'monitor_timer') {
            return { LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead', InvocationID: '' };
          }
          if (role === 'worker') return inactive(workerInvocationId, '75');
          if (role === 'llama' && llamaActive) {
            return {
              LoadState: 'loaded',
              ActiveState: 'active',
              SubState: 'running',
              MainPID: '42',
              InvocationID: 'b'.repeat(32),
              ExecMainStatus: '0',
            };
          }
          if (role === 'llama') inactiveLlamaObservations += 1;
          return inactive();
        },
      },
    ),
    /injected start acknowledgement failure/u,
  );
  assert.equal(stopCalls, 1);
  assert.equal(inactiveLlamaObservations, 2);
});

test('terminal transaction resumes after a crash between the four replacements', async (t) => {
  const fixture = await makeFixture(t);
  await assert.rejects(
    continueOperatorInterruptedAttempt(
      { ...fixture.options, apply: true },
      dependencies(fixture, {
        invokeOcr: async () => finishFixtureDocument(fixture),
        afterTerminalReplacement: async (count) => {
          if (count === 1) throw new Error('simulated terminal persistence crash');
        },
      }),
    ),
    /simulated terminal persistence crash/u,
  );
  let invoked = false;
  const recovered = await continueOperatorInterruptedAttempt(
    { ...fixture.options, apply: true },
    dependencies(fixture, { invokeOcr: async () => { invoked = true; } }),
  );
  assert.equal(recovered.status, 'complete');
  assert.equal(recovered.exitCode, 0);
  assert.equal(recovered.recovered, true);
  assert.equal(invoked, false);
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
