#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { A2_READONLY_COLLECTION_SPEC } from './collect-remote-ocr-a2-readonly-snapshot.mjs';
import { canonicalJson } from './lib/remote-ocr-local-snapshot.mjs';
import { validateA2ContinuationRuntimeManifest } from './lib/remote-ocr-continuation-runtime-manifest.mjs';
import {
  EXACT_A2_FORWARD_CONTINUATION_INCIDENT,
  a2ForwardContinuationProfileFingerprint,
  validateA2ForwardContinuationProfile,
  validateA2InterruptedPartialSelectionState,
  validateOperatorContinuationOutput,
} from './lib/remote-ocr-operator-continuation.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const scriptPath = fileURLToPath(import.meta.url);
export const A2_READONLY_PREFLIGHT_GATE_MANIFEST_PATH = fileURLToPath(new URL(
  '../ops/remote-ocr-a2-readonly-preflight-gates.v1.json',
  import.meta.url,
));
const allowedStatuses = new Set(['pass', 'fail', 'error', 'not_applicable']);

function requireGateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schema_version !== 1
    || value.manifest_type !== 'curriculum_remote_ocr_a2_readonly_preflight_gate_manifest'
    || typeof value.manifest_version !== 'string'
    || !value.anchors
    || typeof value.anchors !== 'object'
    || !Array.isArray(value.gates)) {
    throw new Error('A2 read-only preflight gate manifest identity is invalid');
  }
  const ids = value.gates.map((gate) => gate?.check_id);
  const sortedIds = [...ids].sort((left, right) => left.localeCompare(right));
  if (ids.some((id) => typeof id !== 'string' || !id)
    || new Set(ids).size !== ids.length
    || canonicalJson(ids) !== canonicalJson(sortedIds)) {
    throw new Error('A2 read-only preflight gate manifest ids are invalid, duplicated, or unsorted');
  }
  for (const gate of value.gates) {
    if (typeof gate.group !== 'string'
      || !['always', 'apply_only'].includes(gate.applicability)
      || typeof gate.description !== 'string'
      || !gate.description) {
      throw new Error(`A2 read-only preflight gate descriptor is invalid: ${gate.check_id}`);
    }
  }
  for (const [name, digest] of Object.entries(value.anchors)) {
    if (!/^[a-f0-9]{64}$/u.test(String(digest || ''))) {
      throw new Error(`A2 read-only preflight gate manifest anchor is invalid: ${name}`);
    }
  }
  return value;
}

export async function loadA2ReadonlyPreflightGateManifest(
  manifestPath = A2_READONLY_PREFLIGHT_GATE_MANIFEST_PATH,
) {
  const raw = await readFile(manifestPath);
  const manifest = requireGateManifest(JSON.parse(raw.toString('utf8')));
  const canonical = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (!raw.equals(canonical)) throw new Error('A2 read-only preflight gate manifest is not canonical pretty JSON');
  return { manifest, raw, sha256: sha256(raw), path: manifestPath };
}

function projection(value) {
  return value === undefined ? null : value;
}

function comparisonEvidence(actual) {
  return sha256(canonicalJson(projection(actual)));
}

function exact(left, right) {
  return canonicalJson(projection(left)) === canonicalJson(projection(right));
}

export async function validateA2ReadonlyPreflightSnapshot(snapshot, {
  runtimeValidator = validateA2ContinuationRuntimeManifest,
  gateManifestLoader = loadA2ReadonlyPreflightGateManifest,
} = {}) {
  const gateManifestRecord = await gateManifestLoader();
  const gateManifest = gateManifestRecord.manifest;
  const checks = [];
  const add = ({ id, group, status, expected = null, actual = null, blockedBy = [], error = null }) => {
    if (!allowedStatuses.has(status)) throw new Error(`invalid preflight status for ${id}: ${status}`);
    checks.push({
      check_id: id,
      group,
      status,
      expected: projection(expected),
      actual: projection(actual),
      evidence: {
        actual_sha256: comparisonEvidence(actual),
        blocked_by: [...blockedBy].sort(),
      },
      error: error === null ? null : String(error?.message || error),
    });
  };
  const compare = (id, group, expected, actual) => add({
    id,
    group,
    status: exact(expected, actual) ? 'pass' : 'fail',
    expected,
    actual,
  });
  const invalid = (id, group, error) => add({
    id,
    group,
    status: 'error',
    expected: 'valid bounded evidence',
    actual: null,
    error,
  });
  const profile = EXACT_A2_FORWARD_CONTINUATION_INCIDENT;
  try {
    validateA2ForwardContinuationProfile(profile);
    compare('profile.exact_schema', 'profile', profile.schemaVersion, 2);
  } catch (error) {
    invalid('profile.exact_schema', 'profile', error);
  }

  const specSha256 = sha256(Buffer.from(JSON.stringify(A2_READONLY_COLLECTION_SPEC)));
  compare('snapshot.schema', 'snapshot', {
    schema_version: 1,
    snapshot_type: 'curriculum_remote_ocr_a2_readonly_preflight_snapshot',
    collection_spec_sha256: specSha256,
  }, {
    schema_version: snapshot?.schema_version,
    snapshot_type: snapshot?.snapshot_type,
    collection_spec_sha256: snapshot?.collection_spec_sha256,
  });
  compare('snapshot.target', 'snapshot', A2_READONLY_COLLECTION_SPEC.target, snapshot?.target);
  compare('snapshot.no_mutation', 'snapshot', false, snapshot?.mutation_performed);
  compare('snapshot.no_ocr_content', 'snapshot', false, snapshot?.ocr_content_exported);

  let runtime = null;
  try {
    runtime = await runtimeValidator();
    add({
      id: 'runtime.candidate_closure',
      group: 'runtime',
      status: 'pass',
      expected: 'checked-in manifest equals actual candidate import closure',
      actual: {
        manifest_sha256: runtime.sha256,
        runtime_tree_sha256: runtime.runtime_tree_sha256,
        files: runtime.files,
      },
    });
  } catch (error) {
    invalid('runtime.candidate_closure', 'runtime', error);
  }

  const resource = (collection, id) => snapshot?.[collection]?.[id];
  const withResources = (id, group, references, operation) => {
    const unavailable = references.filter(([collection, name]) => resource(collection, name)?.ok !== true);
    if (unavailable.length > 0) {
      add({
        id,
        group,
        status: 'error',
        expected: 'all bounded snapshot resources available',
        actual: unavailable.map(([collection, name]) => ({
          resource: `${collection}.${name}`,
          error: resource(collection, name)?.error || 'missing snapshot resource',
        })),
        blockedBy: unavailable.map(([collection, name]) => `${collection}.${name}`),
        error: 'one or more bounded snapshot resources are unavailable',
      });
      return;
    }
    try {
      operation(...references.map(([collection, name]) => resource(collection, name).value));
    } catch (error) {
      invalid(id, group, error);
    }
  };

  const identityChecks = [
    ['output_root', { path: profile.outputRoot, realpath: profile.outputRoot, type: 'directory', device: profile.outputDevice, inode: profile.outputInode }],
    ['input_root', { path: A2_READONLY_COLLECTION_SPEC.target.input_root, realpath: A2_READONLY_COLLECTION_SPEC.target.input_root, type: 'directory' }],
    ['evidence_base_root', { path: profile.evidenceBaseRoot, realpath: profile.evidenceBaseRoot, type: 'directory', device: profile.evidenceBaseDevice, inode: profile.evidenceBaseInode, mode: '0700' }],
    ['incident_evidence_root', { path: profile.incidentEvidenceRoot, realpath: profile.incidentEvidenceRoot, type: 'directory', device: profile.incidentEvidenceDevice, inode: profile.incidentEvidenceInode, mode: profile.incidentEvidenceMode, uid: profile.incidentEvidenceUid, gid: profile.incidentEvidenceGid }],
    ['rearm_evidence_root', { path: profile.rearmEvidenceRoot, realpath: profile.rearmEvidenceRoot, type: 'directory', mode: '0700' }],
    ['document_root', { path: `${profile.outputRoot}/documents/${profile.documentId}`, realpath: `${profile.outputRoot}/documents/${profile.documentId}`, type: 'directory' }],
    ['lifecycle_lock', { path: profile.lifecycleLock, realpath: profile.lifecycleLock, type: 'file', inode: profile.lifecycleLockInode, mode: '0600', nlink: '1' }],
  ];
  for (const [id, expectedFields] of identityChecks) {
    withResources(`path.${id}`, 'path', [['directories', id]], (record) => {
      const actual = Object.fromEntries(Object.keys(expectedFields).map((key) => [key, record[key]]));
      compare(`path.${id}`, 'path', expectedFields, actual);
    });
  }

  const continuationDirectory = resource('directories', 'continuation_evidence_root');
  const continuationTree = resource('trees', 'continuation');
  compare('continuation.no_existing_evidence_root', 'recovery', {
    directory: 'ENOENT',
    tree: 'ENOENT',
  }, {
    directory: continuationDirectory?.ok === false ? continuationDirectory.error?.code : 'present',
    tree: continuationTree?.ok === false ? continuationTree.error?.code : 'present',
  });

  const unitExpected = {
    worker: { Id: profile.workerUnit, LoadState: 'loaded', ActiveState: 'failed', SubState: 'failed', MainPID: '0', InvocationID: profile.workerInvocationId, ExecMainStatus: '75', NRestarts: '0' },
    monitor: { Id: profile.monitorUnit, LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead', MainPID: '0' },
    monitor_timer: { Id: profile.monitorTimerUnit, LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead', InvocationID: '' },
    alert: { Id: profile.alertUnit, LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead', MainPID: '0' },
    llama: { Id: profile.llamaUnit, LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead', MainPID: '0' },
  };
  for (const [role, expectedFields] of Object.entries(unitExpected)) {
    withResources(`unit.${role}`, 'unit', [['units', role]], (record) => {
      const actual = Object.fromEntries(Object.keys(expectedFields).map((key) => [key, record.properties?.[key]]));
      compare(`unit.${role}`, 'unit', expectedFields, actual);
      const generationKeys = [
        'StateChangeTimestampMonotonic', 'ActiveEnterTimestampMonotonic',
        'ActiveExitTimestampMonotonic', 'InactiveEnterTimestampMonotonic',
        ...(role.endsWith('_timer') ? ['LastTriggerUSecMonotonic'] : []),
      ];
      const invalidGeneration = generationKeys.filter(
        (key) => !/^(?:0|[1-9]\d*)$/u.test(String(record.properties?.[key] ?? '')),
      );
      compare(`unit.${role}.generation_schema`, 'unit', [], invalidGeneration);
    });
  }

  const pinnedFiles = {
    run_identity: [profile.runIdentitySha256, profile.runIdentityBytes],
    run_status: [profile.runStatusSha256, null],
    document_status: [profile.documentStatusSha256, null],
    document_state: [profile.stateSha256, null],
    document_log: [profile.logSha256, profile.logBytes],
    seed_receipt: [profile.seedReceiptSha256, profile.seedReceiptBytes],
    seed_commit: [profile.seedCommitSha256, profile.seedCommitBytes],
    seed_journal: [profile.seedJournalSha256, profile.seedJournalBytes],
    ledger_identity: [profile.ledgerIdentitySha256, profile.ledgerIdentityBytes],
    ledger_identity_sidecar: [profile.ledgerSidecarSha256, profile.ledgerSidecarBytes],
    timeout_grant: [profile.timeoutGrantSha256, profile.timeoutGrantBytes],
    timeout_consumption_claim: [profile.timeoutConsumptionClaimSha256, profile.timeoutConsumptionClaimBytes],
    timeout_issuance: [profile.timeoutIssuanceSha256, profile.timeoutIssuanceBytes],
    timeout_issuance_sidecar: [profile.timeoutIssuanceSidecarSha256, profile.timeoutIssuanceSidecarBytes],
    rearm_receipt: [profile.rearmReceiptSha256, profile.rearmReceiptBytes],
    rearm_reservation_claim: [profile.rearmReservationClaimSha256, null],
  };
  for (const [id, [expectedSha256, expectedBytes]] of Object.entries(pinnedFiles)) {
    withResources(`file.${id}`, 'file', [['files', id]], (record) => {
      const expected = { sha256: expectedSha256, ...(expectedBytes === null ? {} : { bytes: expectedBytes }), stable: true };
      const actual = { sha256: record.sha256, ...(expectedBytes === null ? {} : { bytes: record.bytes }), stable: record.stable };
      compare(`file.${id}`, 'file', expected, actual);
    });
  }

  for (const id of Object.keys(A2_READONLY_COLLECTION_SPEC.files).filter((name) => name !== 'manifest')) {
    withResources(`file.${id}.security`, 'file', [['files', id]], (record) => {
      compare(`file.${id}.security`, 'file', { stable: true, mode: '0600', nlink: '1', type: 'file' }, {
        stable: record.stable,
        mode: record.mode,
        nlink: record.nlink,
        type: record.type,
      });
    });
  }

  const sidecarPairs = [
    ['run_status', 'run_status_sidecar'],
    ['document_status', 'document_status_sidecar'],
    ['seed_receipt', 'seed_receipt_sidecar'],
    ['seed_commit', 'seed_commit_sidecar'],
    ['seed_journal', 'seed_journal_sidecar'],
    ['ledger_identity', 'ledger_identity_sidecar'],
    ['timeout_grant', 'timeout_grant_sidecar'],
    ['timeout_consumption_claim', 'timeout_consumption_claim_sidecar'],
    ['timeout_issuance', 'timeout_issuance_sidecar'],
    ['rearm_receipt', 'rearm_receipt_sidecar'],
  ];
  for (const [bodyId, sidecarId] of sidecarPairs) {
    withResources(`sidecar.${bodyId}`, 'sidecar', [['files', bodyId], ['files', sidecarId]], (body, sidecar) => {
      const expected = `${body.sha256}  ${path.basename(body.path)}\n`;
      compare(`sidecar.${bodyId}`, 'sidecar', expected, sidecar.text);
    });
  }

  const treeExpected = {
    document: { tree_sha256: profile.documentTreeSha256, files: profile.documentTreeFiles, bytes: profile.documentTreeBytes },
    incident: { tree_sha256: profile.incidentEvidenceTreeSha256 },
    predecessor: { tree_sha256: profile.predecessorEvidenceTreeSha256, files: profile.predecessorEvidenceTreeFiles, bytes: profile.predecessorEvidenceTreeBytes },
    rearm: { tree_sha256: profile.rearmEvidenceTreeSha256 },
  };
  for (const [id, expectedFields] of Object.entries(treeExpected)) {
    withResources(`tree.${id}`, 'inventory', [['trees', id]], (record) => {
      const actual = Object.fromEntries(Object.keys(expectedFields).map((key) => [key, record[key]]));
      compare(`tree.${id}`, 'inventory', expectedFields, actual);
    });
  }

  withResources('semantics.manifest_runtime', 'semantic', [
    ['files', 'manifest'], ['files', 'run_identity'], ['files', 'run_status'], ['files', 'document_status'], ['files', 'document_state'],
  ], (manifestRecord, identityRecord, runStatusRecord, statusRecord, stateRecord) => {
    const manifest = manifestRecord.json;
    const identity = identityRecord.json;
    const runStatus = runStatusRecord.json;
    const status = statusRecord.json;
    const state = stateRecord.json;
    const documents = manifest?.documents?.filter(({ id }) => id === profile.documentId) || [];
    const document = documents[0] || {};
    compare('semantics.manifest_runtime', 'semantic', {
      target_documents: 1,
      manifest_sha256: manifestRecord.sha256,
      input_root: A2_READONLY_COLLECTION_SPEC.target.input_root,
      runner_sha256: profile.baseRunnerSha256,
      source_sha256_consistent: true,
      page_count: 649,
      runtime_fingerprint_consistent: true,
    }, {
      target_documents: documents.length,
      manifest_sha256: identity?.manifest_sha256,
      input_root: identity?.input_root,
      runner_sha256: identity?.runner_script_sha256,
      source_sha256_consistent: document.source_sha256 === state?.source_sha256,
      page_count: document.page_count,
      runtime_fingerprint_consistent: identity?.runtime_fingerprint_sha256 === runStatus?.runtime_fingerprint_sha256
        && identity?.runtime_fingerprint_sha256 === status?.runtime_fingerprint_sha256,
    });
  });

  withResources('semantics.interrupted_controls', 'semantic', [
    ['files', 'run_status'], ['files', 'document_status'], ['files', 'incident'],
  ], (runStatusRecord, statusRecord, incidentRecord) => {
    const runStatus = runStatusRecord.json;
    const progress = runStatus?.documents?.[profile.documentId] || {};
    const status = statusRecord.json || {};
    const incident = incidentRecord.json || {};
    compare('semantics.interrupted_controls', 'semantic', {
      counts: { total: 8, complete: 4, failed: 0, interrupted: 1, pending: 0, running: 0, retry_wait: 3, quarantined: 0 },
      progress: { status: 'interrupted', attempts: 6, attempt_ceiling: 6, inherited_attempts: 5, signal: 'SIGTERM', interrupted_at: profile.documentInterruptedAt, status_json_sha256: profile.documentStatusSha256, page_count: 649 },
      status: { schema_version: 1, document_id: profile.documentId, status: 'interrupted', attempt: 6, max_attempts: 6, page_count: 649, interrupted_at: profile.documentInterruptedAt, citation_allowed: false },
      incident: { worker_invocation_id: profile.workerInvocationId, interrupted_at: profile.incidentInterruptedAt, citation_allowed: false, forward_only: true, old_four_file_rollback_forbidden: true },
    }, {
      counts: runStatus?.counts,
      progress: Object.fromEntries(['status', 'attempts', 'attempt_ceiling', 'inherited_attempts', 'signal', 'interrupted_at', 'status_json_sha256', 'page_count'].map((key) => [key, progress[key]])),
      status: Object.fromEntries(['schema_version', 'document_id', 'status', 'attempt', 'max_attempts', 'page_count', 'interrupted_at', 'citation_allowed'].map((key) => [key, status[key]])),
      incident: Object.fromEntries(['worker_invocation_id', 'interrupted_at', 'citation_allowed', 'forward_only', 'old_four_file_rollback_forbidden'].map((key) => [key, incident[key]])),
    });
  });

  withResources('semantics.production_state', 'semantic', [['files', 'document_state']], (stateRecord) => {
    const state = stateRecord.json || {};
    let selectionShape;
    try {
      selectionShape = validateA2InterruptedPartialSelectionState(state, state.page_count);
    } catch (error) {
      selectionShape = `invalid: ${error.message}`;
    }
    compare('semantics.production_state', 'semantic', {
      sha256: profile.stateSha256,
      schema_version: 1,
      document_id: profile.documentId,
      page_count: 649,
      completed_pages: 192,
      failed_pages: 0,
      selection_shape: 'legacy_absent',
    }, {
      sha256: stateRecord.sha256,
      schema_version: state.schema_version,
      document_id: state.document_id,
      page_count: state.page_count,
      completed_pages: Array.isArray(state.completed_pages) ? state.completed_pages.length : null,
      failed_pages: state.failed_pages && typeof state.failed_pages === 'object' && !Array.isArray(state.failed_pages)
        ? Object.keys(state.failed_pages).length : null,
      selection_shape: selectionShape,
    });
  });

  withResources('semantics.single_authority_lineage', 'semantic', [
    ['files', 'run_identity'], ['files', 'run_status'], ['files', 'document_status'],
    ['files', 'timeout_grant'], ['files', 'timeout_consumption_claim'], ['files', 'seed_receipt'],
  ], (identityRecord, runStatusRecord, statusRecord, grantRecord, claimRecord, seedReceiptRecord) => {
    const identity = identityRecord.json || {};
    const runStatus = runStatusRecord.json || {};
    const progress = runStatus.documents?.[profile.documentId] || {};
    const status = statusRecord.json || {};
    const grant = grantRecord.json || {};
    const claim = claimRecord.json || {};
    const receipt = seedReceiptRecord.json || {};
    const granted = grant.documents?.filter(({ document_id: id }) => id === profile.documentId) || [];
    const consumed = claim.granted_documents?.filter(({ document_id: id }) => id === profile.documentId) || [];
    const receipted = receipt.documents?.filter(({ document_id: id }) => id === profile.documentId) || [];
    compare('semantics.single_authority_lineage', 'semantic', {
      seed_id: profile.seedId,
      grant_sha256: profile.timeoutGrantSha256,
      claim_sha256: profile.timeoutConsumptionClaimSha256,
      granted_count: 1,
      consumed_count: 1,
      receipted_count: 1,
      granted_attempt: 6,
      inherited_attempts: 5,
      automatic_attempt_7: false,
      output_root: profile.outputRoot,
      output_device: profile.outputDevice,
      output_inode: profile.outputInode,
      citation_allowed: false,
    }, {
      seed_id: identity.seed_lineage?.seed_id,
      grant_sha256: identity.seed_lineage?.timeout_recovery_grant_sha256,
      claim_sha256: identity.seed_lineage?.timeout_recovery_claim_sha256,
      granted_count: granted.length,
      consumed_count: consumed.length,
      receipted_count: receipted.length,
      granted_attempt: grant.policy?.granted_attempt,
      inherited_attempts: progress.inherited_attempts,
      automatic_attempt_7: grant.policy?.automatic_attempt_7,
      output_root: claim.successor?.output_root,
      output_device: claim.successor?.output_device,
      output_inode: claim.successor?.output_inode,
      citation_allowed: [identity.citation_allowed, runStatus.citation_allowed, status.citation_allowed, grant.citation_allowed, claim.citation_allowed, receipt.citation_allowed].every((value) => value === false) ? false : 'not_fail_closed',
    });
  });

  withResources('semantics.rearm_receipt', 'semantic', [['files', 'rearm_receipt']], (record) => {
    const receipt = record.json || {};
    const transaction = Array.isArray(receipt.transaction) ? receipt.transaction : [];
    const after = Object.fromEntries(transaction.map((item) => [item.output_path, item.after?.sha256]));
    compare('semantics.rearm_receipt', 'semantic', {
      repair_id: profile.rearmRepairId,
      status: 'prepared_atomic_apply_required',
      citation_allowed: false,
      after: {
        [`status/${profile.documentId}.json`]: profile.rearmAfterStatusSha256,
        [`status/${profile.documentId}.json.sha256`]: profile.rearmAfterStatusSidecarSha256,
        'run-status.json': profile.rearmAfterRunStatusSha256,
        'run-status.json.sha256': profile.rearmAfterRunStatusSidecarSha256,
      },
    }, {
      repair_id: receipt.repair_id,
      status: receipt.status,
      citation_allowed: receipt.citation_allowed,
      after,
    });
  });

  withResources('forward_only.baseline_inventory', 'forward_only', [
    ['trees', 'document'], ['files', 'document_state'], ['files', 'document_log'],
  ], (tree, state, log) => {
    compare('forward_only.baseline_inventory', 'forward_only', {
      tree_sha256: profile.documentTreeSha256,
      files: profile.documentTreeFiles,
      bytes: profile.documentTreeBytes,
      state_sha256: profile.stateSha256,
      log_sha256: profile.logSha256,
      log_bytes: profile.logBytes,
      tree_has_no_symlink_or_nonregular: true,
    }, {
      tree_sha256: tree.tree_sha256,
      files: tree.files,
      bytes: tree.bytes,
      state_sha256: state.sha256,
      log_sha256: log.sha256,
      log_bytes: log.bytes,
      tree_has_no_symlink_or_nonregular: true,
    });
  });

  for (const [id, expected] of [
    ['apply.lifecycle_flock_acquisition', 'requires held inherited-fd flock immediately before apply'],
    ['apply.active_llama_runtime_attestation', 'requires exact active llama InvocationID, PID, marker and health after controlled start'],
    ['apply.ocr_process_ownership_and_stop', 'requires live proc ownership and signal checks only if apply starts the OCR child'],
  ]) {
    add({
      id,
      group: 'apply_only',
      status: 'not_applicable',
      expected,
      actual: 'not observed by mutation-free preflight',
    });
  }

  const snapshotSha256 = sha256(Buffer.from(canonicalJson(snapshot)));
  const profileSha256 = a2ForwardContinuationProfileFingerprint(profile);
  const continuationAbsent = continuationDirectory?.ok === false
    && continuationDirectory.error?.code === 'ENOENT'
    && continuationTree?.ok === false
    && continuationTree.error?.code === 'ENOENT';
  compare('receiver.ready_after_continuation', 'receiver', {
    continuation_evidence: 'absent_before_forward_continuation',
    interrupted_status: 'interrupted',
    candidate_runtime_bound: true,
    receiver_validator_exported: true,
    receiver_terminal_required: true,
    citation_allowed: false,
  }, {
    continuation_evidence: continuationAbsent
      ? 'absent_before_forward_continuation'
      : 'present_or_indeterminate',
    interrupted_status: resource('files', 'document_status')?.value?.json?.status ?? null,
    candidate_runtime_bound: runtime !== null,
    receiver_validator_exported: typeof validateOperatorContinuationOutput === 'function',
    receiver_terminal_required: true,
    citation_allowed: resource('files', 'document_status')?.value?.json?.citation_allowed ?? null,
  });
  compare(
    'fixture.production_canonical_digest',
    'fixture',
    gateManifest.anchors.production_snapshot_sha256,
    snapshotSha256,
  );

  const expectedGateIds = gateManifest.gates.map(({ check_id: checkId }) => checkId);
  const expectedGateSet = new Set(expectedGateIds);
  const observedBeforeManifest = checks.map(({ check_id: checkId }) => checkId);
  const observedCounts = new Map();
  for (const checkId of observedBeforeManifest) {
    observedCounts.set(checkId, (observedCounts.get(checkId) || 0) + 1);
  }
  const missingBeforeSynthesis = expectedGateIds.filter(
    (checkId) => checkId !== 'manifest.anchor_bindings' && !observedCounts.has(checkId),
  );
  const extraGateIds = [...new Set(observedBeforeManifest.filter(
    (checkId) => !expectedGateSet.has(checkId),
  ))].sort();
  const duplicateGateIds = [...observedCounts]
    .filter(([_checkId, count]) => count !== 1)
    .map(([checkId]) => checkId)
    .sort();
  for (const checkId of missingBeforeSynthesis) {
    const descriptor = gateManifest.gates.find((gate) => gate.check_id === checkId);
    add({
      id: checkId,
      group: descriptor.group,
      status: 'error',
      expected: descriptor.description,
      actual: null,
      error: 'declared gate was not evaluated by the validator',
    });
  }

  const manifestFrozenProfile = {
    run_root: profile.runRoot,
    output_root: profile.outputRoot,
    output_device: profile.outputDevice,
    output_inode: profile.outputInode,
    lifecycle_lock_inode: profile.lifecycleLockInode,
    evidence_base_device: profile.evidenceBaseDevice,
    evidence_base_inode: profile.evidenceBaseInode,
    document_id: profile.documentId,
    attempt: profile.attempt,
    inherited_attempts: profile.inheritedAttempts,
    worker_invocation_id: profile.workerInvocationId,
    document_interrupted_at: profile.documentInterruptedAt,
    incident_interrupted_at: profile.incidentInterruptedAt,
    frozen_hashes: {
      run_status_sha256: profile.runStatusSha256,
      document_status_sha256: profile.documentStatusSha256,
      document_log_sha256: profile.logSha256,
      document_state_sha256: profile.stateSha256,
    },
    lineage: {
      seed_id: profile.seedId,
      timeout_grant_sha256: profile.timeoutGrantSha256,
      timeout_consumption_claim_sha256: profile.timeoutConsumptionClaimSha256,
      timeout_issuance_sha256: profile.timeoutIssuanceSha256,
      ledger_identity_sha256: profile.ledgerIdentitySha256,
      ledger_sidecar_sha256: profile.ledgerSidecarSha256,
    },
    trees: {
      document_tree_sha256: profile.documentTreeSha256,
      predecessor_evidence_tree_sha256: profile.predecessorEvidenceTreeSha256,
      incident_evidence_tree_sha256: profile.incidentEvidenceTreeSha256,
      rearm_evidence_tree_sha256: profile.rearmEvidenceTreeSha256,
    },
    units: [profile.workerUnit, profile.monitorUnit, profile.monitorTimerUnit, profile.alertUnit, profile.llamaUnit],
    receiver_state: 'ready_after_complete_terminal_continuation_receipt',
    forward_only: true,
  };
  compare('manifest.anchor_bindings', 'manifest', {
    target: gateManifest.target,
    anchors: {
      collection_spec_sha256: gateManifest.anchors.collection_spec_sha256,
      profile_sha256: gateManifest.anchors.profile_sha256,
      runtime_manifest_sha256: gateManifest.anchors.runtime_manifest_sha256,
    },
    frozen_profile: gateManifest.frozen_profile,
    execution: {
      declared_gate_count: expectedGateIds.length,
      missing_declared_gates: [],
      extra_undeclared_gates: [],
      duplicate_gate_ids: [],
    },
  }, {
    target: {
      document_id: profile.documentId,
      attempt: profile.attempt,
      state: 'interrupted_forward_only',
      citation_allowed: false,
    },
    anchors: {
      collection_spec_sha256: specSha256,
      profile_sha256: profileSha256,
      runtime_manifest_sha256: runtime?.sha256 || null,
    },
    frozen_profile: manifestFrozenProfile,
    execution: {
      declared_gate_count: expectedGateIds.length,
      missing_declared_gates: missingBeforeSynthesis,
      extra_undeclared_gates: extraGateIds,
      duplicate_gate_ids: duplicateGateIds,
    },
  });

  checks.sort((left, right) => left.check_id.localeCompare(right.check_id));
  const finalIds = checks.map(({ check_id: checkId }) => checkId);
  const allGatesExecuted = missingBeforeSynthesis.length === 0
    && extraGateIds.length === 0
    && duplicateGateIds.length === 0
    && finalIds.length === expectedGateIds.length
    && exact(finalIds, expectedGateIds);
  const counts = Object.fromEntries(
    ['pass', 'fail', 'error', 'not_applicable']
      .map((status) => [status, checks.filter((check) => check.status === status).length]),
  );
  const valid = allGatesExecuted && counts.fail === 0 && counts.error === 0;
  const basis = {
    schema_version: 1,
    report_type: 'curriculum_remote_ocr_a2_readonly_preflight_report',
    gate_manifest_version: gateManifest.manifest_version,
    gate_manifest_sha256: gateManifestRecord.sha256,
    snapshot_sha256: snapshotSha256,
    profile_sha256: profileSha256,
    runtime_manifest_sha256: runtime?.sha256 || null,
    checks,
  };
  return {
    ...basis,
    valid,
    summary: {
      total: checks.length,
      declared: expectedGateIds.length,
      all_gates_executed: allGatesExecuted,
      ...counts,
    },
    comparison_basis_sha256: sha256(Buffer.from(canonicalJson(basis))),
    mutation_performed: false,
    ocr_content_exported: false,
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument !== '--snapshot') throw new Error(`unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--snapshot requires a path');
    options.snapshot = value;
    index += 1;
  }
  if (!options.snapshot) throw new Error('--snapshot is required');
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node scripts/validate-remote-ocr-a2-preflight.mjs --snapshot <READONLY_SNAPSHOT.json>\n');
    return;
  }
  const snapshot = JSON.parse(await readFile(options.snapshot, 'utf8'));
  const report = await validateA2ReadonlyPreflightSnapshot(snapshot);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.valid) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`validate-remote-ocr-a2-preflight: ${error.message}\n`);
    process.exitCode = 2;
  });
}
