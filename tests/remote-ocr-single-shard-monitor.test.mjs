import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  canonicalJson,
  classifySingleShardSnapshot,
  collectSingleShardResources,
  inspectPredecessorB1,
  inspectSuccessorB2,
  inspectTreeStrict,
  parseInactiveSystemdShow,
  parseSingleShardMonitorArgs,
  privacySafeSingleShardEvent,
  validateP4ToP1MonitorDelta,
  writeSingleShardMonitorOutputs,
} from '../scripts/monitor-remote-ocr-single-shard.mjs';
import { fingerprintPaddlexLayoutModelCache } from '../scripts/run-remote-ocr-offload.mjs';
import { parseSystemdShow } from '../scripts/monitor-remote-ocr-reprocess.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const hash = (character) => character.repeat(64);
const legacyB1RunnerScriptSha256 = 'b08c3f7aa3da6e44dd9fffeecaf20b2a020df4d604c9b957399abaf886d15a55';

function systemdShow(overrides = {}) {
  const fields = {
    LoadState: 'masked',
    ActiveState: 'inactive',
    SubState: 'dead',
    NRestarts: '0',
    ExecMainStatus: '0',
    MainPID: '0',
    Result: 'success',
    ...overrides,
  };
  return `${Object.entries(fields).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

test('inactive probes accept only exact safe masked state while active probes remain loaded-only', () => {
  assert.deepEqual(parseInactiveSystemdShow(systemdShow()), {
    active_state: 'inactive',
    sub_state: 'dead',
    n_restarts: 0,
    exec_main_status: 0,
    main_pid: 0,
    result: 'success',
  });
  assert.deepEqual(parseInactiveSystemdShow(systemdShow({ LoadState: 'loaded' })), {
    active_state: 'inactive',
    sub_state: 'dead',
    n_restarts: 0,
    exec_main_status: 0,
    main_pid: 0,
    result: 'success',
  });
  assert.throws(() => parseSystemdShow(systemdShow()), /not loaded/);
  for (const mutation of [
    { ActiveState: 'active', SubState: 'running', MainPID: '12' },
    { MainPID: '12' },
    { NRestarts: '1' },
    { NRestarts: 'not-a-number' },
    { ExecMainStatus: '1' },
    { Result: 'failed' },
  ]) assert.throws(() => parseInactiveSystemdShow(systemdShow(mutation)), /masked systemd|numeric status/);
  assert.throws(
    () => parseInactiveSystemdShow(`${systemdShow()}MainPID=0\n`),
    /repeats MainPID/,
  );
  assert.throws(
    () => parseInactiveSystemdShow(`${systemdShow()}Unexpected=value\n`),
    /field set is not exact/,
  );
  assert.throws(
    () => parseInactiveSystemdShow(systemdShow().replace('Result=success\n', '')),
    /field set is not exact/,
  );
});

async function writeJson(pathname, value) {
  const raw = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await mkdir(path.dirname(pathname), { recursive: true });
  await writeFile(pathname, raw);
  return { raw, bytes: raw.byteLength, sha256: sha256(raw) };
}

async function writeSidecar(pathname, digest) {
  const raw = Buffer.from(`${digest}  ${path.basename(pathname)}\n`);
  await writeFile(`${pathname}.sha256`, raw);
  return { raw, bytes: raw.byteLength, sha256: sha256(raw) };
}

async function writeHashBoundJson(pathname, value) {
  const body = await writeJson(pathname, value);
  const sidecar = await writeSidecar(pathname, body.sha256);
  return { ...body, sidecar };
}

async function copyExact(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

function workerConfiguration(concurrency, cacheRoot, cacheTreeSha256, serverParallel = 4) {
  return {
    llama_url: 'http://127.0.0.1:8112',
    vl_rec_max_concurrency: concurrency,
    server_parallel: serverParallel,
    micro_batch: 16,
    use_queues: true,
    runtime_device: 'gpu:0',
    paddlex_cache_home: cacheRoot,
    python_runtime: {
      python_version: '3.13.12',
      packages: {
        paddlepaddle: '3.3.1',
        paddleocr: '3.7.0',
        paddlex: '3.7.2',
        pypdfium2: '5.12.0',
      },
    },
    paddlex_layout_model_cache_sha256: cacheTreeSha256,
  };
}

function llamaAttestation(runtime, parallel, procCharacter) {
  return {
    schema_version: 1,
    systemd_unit: 'curriculum-ocr-llama.service',
    active_state: 'active',
    sub_state: 'running',
    binary_path: '/fixture/llama-server',
    binary_sha256: hash('5'),
    version_sha256: hash('6'),
    llama_commit_prefix: runtime.llama_commit.slice(0, 8),
    proc_cmdline_sha256: hash(procCharacter),
    model_path: '/fixture/model.gguf',
    model_sha256: runtime.model_sha256,
    mmproj_path: '/fixture/mmproj.gguf',
    mmproj_sha256: runtime.mmproj_sha256,
    host: '127.0.0.1',
    port: 8112,
    parallel,
    production_command_contract: {
      values: {
        '--host': '127.0.0.1',
        '--port': '8112',
        '--parallel': String(parallel),
        '--temp': '0',
        '--ctx-size': '32768',
        '--n-gpu-layers': 'all',
        '--flash-attn': 'auto',
        '--cache-type-k': 'f16',
        '--cache-type-v': 'f16',
        '--batch-size': '2048',
        '--ubatch-size': '512',
        '--fit': 'off',
        '--timeout': '3600',
        '--threads': '8',
        '--threads-batch': '16',
      },
      flags: ['--mmproj-offload', '--cont-batching', '--no-webui', '--metrics'],
    },
    health_url: 'http://127.0.0.1:8112/health',
    health_status_code: 200,
    health_status: 'ok',
    health_body_sha256: hash('7'),
  };
}

async function createPaddlexCache(cacheRoot) {
  const modelRoot = path.join(cacheRoot, 'official_models/PP-DocLayoutV3');
  await mkdir(modelRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(modelRoot, 'inference.json'), '{"model":"PP-DocLayoutV3"}\n'),
    writeFile(path.join(modelRoot, 'inference.pdiparams'), Buffer.from([0x50, 0x44, 0x58, 0x01])),
    writeFile(path.join(modelRoot, 'inference.yml'), 'Global:\n  model_name: PP-DocLayoutV3\n'),
  ]);
  return fingerprintPaddlexLayoutModelCache(cacheRoot);
}

function documentRecovery(idleSeconds) {
  return {
    max_attempts: 5,
    retry_delays_seconds: [2, 10, 30, 60],
    child_monitoring: {
      startup_timeout_seconds: 180,
      idle_timeout_seconds: idleSeconds,
      wall_floor_seconds: 1200,
      wall_seconds_per_page: 25,
      terminate_grace_seconds: 15,
      poll_interval_seconds: 5,
    },
  };
}

function stateConfiguration(runtime, worker) {
  return {
    pipeline: runtime.pipeline,
    pipeline_version: runtime.pipeline_version,
    layout_model: 'PP-DocLayoutV3',
    recognizer: 'PaddleOCR-VL-1.6-0.9B official GGUF',
    recognizer_backend: 'llama-cpp-server',
    recognizer_server_url: worker.llama_url,
    dpi: runtime.render_dpi,
    device: worker.runtime_device,
    python: worker.python_runtime.python_version,
    paddlepaddle: worker.python_runtime.packages.paddlepaddle,
    paddleocr: worker.python_runtime.packages.paddleocr,
    paddlex: worker.python_runtime.packages.paddlex,
    vl_rec_max_concurrency: worker.vl_rec_max_concurrency,
    server_parallel: worker.server_parallel,
    micro_batch: worker.micro_batch,
    use_queues: worker.use_queues,
  };
}

async function pageArtifacts(root, content = 'page one\n') {
  await mkdir(root, { recursive: true });
  const result = Buffer.from('{"ok":true}\n');
  const markdown = Buffer.from(content);
  await writeFile(path.join(root, 'result.json'), result);
  await writeFile(path.join(root, 'content.md'), markdown);
  return {
    status: 'ocr_complete_pending_audit',
    physical_pdf_page: 1,
    rendered_image_sha256: hash('8'),
    elapsed_seconds: 1.25,
    result_json_sha256: sha256(result),
    content_markdown_sha256: sha256(markdown),
    citation_eligible: false,
  };
}

async function createPredecessor(root, { legacyInterrupted = false } = {}) {
  const b1 = path.join(root, 'output/b1');
  const documentRoot = path.join(b1, 'documents/doc-one');
  const pageRoot = path.join(documentRoot, 'pages/0001');
  await mkdir(path.join(b1, 'status'), { recursive: true });
  await mkdir(path.join(b1, 'logs'), { recursive: true });
  const runtime = {
    pipeline: 'PaddleOCRVL',
    pipeline_version: 'v1.6',
    render_dpi: 240,
    model_sha256: hash('1'),
    mmproj_sha256: hash('2'),
    llama_commit: '3'.repeat(40),
  };
  const cacheHome = path.join(await realpath(b1), 'paddlex-cache');
  const cacheFingerprint = await createPaddlexCache(cacheHome);
  const worker = workerConfiguration(4, cacheHome, cacheFingerprint.tree_sha256);
  const attestation = llamaAttestation(runtime, 4, '8');
  const attestationSha256 = sha256(`${JSON.stringify(attestation)}\n`);
  const runtimeFingerprint = {
    ...runtime,
    runtime_device: worker.runtime_device,
    llama_server_attestation_sha256: attestationSha256,
    python_runtime: worker.python_runtime,
    paddlex_layout_model_cache: cacheFingerprint,
  };
  const runtimeFingerprintSha256 = sha256(`${JSON.stringify(runtimeFingerprint)}\n`);
  const recovery = documentRecovery(300);
  const page = await pageArtifacts(pageRoot);
  const state = {
    schema_version: 1,
    document_id: 'doc-one',
    source_path: '/input/doc-one.pdf',
    source_sha256: hash('3'),
    page_count: 2,
    configuration: stateConfiguration(runtime, worker),
    completed_pages: [1],
    failed_pages: {},
    pages: { 1: page },
    selected_pages: [1, 2],
    selected_pages_complete: false,
  };
  await writeJson(path.join(documentRoot, 'state.json'), state);
  const status = legacyInterrupted ? {
    schema_version: 1,
    document_id: 'doc-one',
    status: 'interrupted',
    attempt: 1,
    max_attempts: 5,
    interrupted_at: '2026-07-17T00:00:00.000Z',
    citation_allowed: false,
  } : {
    schema_version: 1,
    document_id: 'doc-one',
    status: 'retry_wait',
    attempt: 1,
    max_attempts: 5,
    error: 'bounded transient failure',
    failed_at: '2026-07-17T00:00:00.000Z',
    next_retry_at: '2026-07-17T00:00:02.000Z',
    retry_delay_seconds: 2,
    page_count: 2,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    citation_allowed: false,
  };
  const statusWritten = await writeHashBoundJson(path.join(b1, 'status/doc-one.json'), status);
  const runStatus = {
    schema_version: 1,
    manifest_sha256: hash('4'),
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    document_recovery: recovery,
    citation_allowed: false,
    counts: {
      total: 1,
      complete: 0,
      failed: 0,
      interrupted: legacyInterrupted ? 1 : 0,
      pending: 0,
      running: 0,
      retry_wait: legacyInterrupted ? 0 : 1,
      quarantined: 0,
    },
    finished: false,
    settled: false,
    documents: {
      'doc-one': legacyInterrupted ? {
        status: 'interrupted',
        attempts: 1,
        page_count: 2,
        interrupted_at: status.interrupted_at,
        status_json_sha256: statusWritten.sha256,
      } : {
        status: 'retry_wait',
        attempts: 1,
        page_count: 2,
        error: status.error,
        failed_at: status.failed_at,
        next_retry_at: status.next_retry_at,
        status_json_sha256: statusWritten.sha256,
      },
    },
  };
  await writeHashBoundJson(path.join(b1, 'run-status.json'), runStatus);
  const identity = {
    schema_version: 1,
    manifest_sha256: runStatus.manifest_sha256,
    runtime,
    runtime_fingerprint: runtimeFingerprint,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    llama_server_attestation: attestation,
    llama_server_attestation_sha256: attestationSha256,
    runner_script_sha256: legacyB1RunnerScriptSha256,
    ocr_script_sha256: hash('9'),
    input_root: '/input',
    python_invocation_path: '/venv/bin/python',
    python_resolved_target: '/usr/bin/python3.13',
    worker_configuration: worker,
    document_recovery: recovery,
    whole_document_atomic: true,
    citation_allowed: false,
  };
  await writeJson(path.join(b1, 'run-identity.json'), identity);
  return { b1, identity, runStatus, runtime, worker, recovery, cacheFingerprint };
}

async function createPredecessorEvidence(b2, predecessor) {
  const evidence = path.join(b2, 'seed-predecessor-evidence');
  const files = [
    ['run-identity.json', 'run-identity.json'],
    ['run-status.json', 'run-status.json'],
    ['run-status.json.sha256', 'run-status.json.sha256'],
    ['documents/doc-one/state.json', 'documents/doc-one/state.json'],
    ['status/doc-one.json', 'status/doc-one.json'],
    ['status/doc-one.json.sha256', 'status/doc-one.json.sha256'],
  ];
  for (const [source, destination] of files) {
    await copyExact(path.join(predecessor.root, source), path.join(evidence, destination));
  }
  const inventoryFiles = [];
  for (const [, relative] of files.sort((left, right) => left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0)) {
    const raw = await readFile(path.join(evidence, relative));
    inventoryFiles.push({ path: relative, bytes: raw.byteLength, sha256: sha256(raw) });
  }
  const document = predecessor.documents[0];
  const state = inventoryFiles.find((item) => item.path === 'documents/doc-one/state.json');
  const status = inventoryFiles.find((item) => item.path === 'status/doc-one.json');
  const sidecar = inventoryFiles.find((item) => item.path === 'status/doc-one.json.sha256');
  const inventory = {
    schema_version: 1,
    evidence_type: 'curriculum_remote_ocr_seed_predecessor_controls',
    manifest_sha256: predecessor.identity.manifest_sha256,
    runner_script_sha256: predecessor.identity.runner_script_sha256,
    files: inventoryFiles,
    documents: [{
      document_id: 'doc-one',
      predecessor_status: document.predecessor_status,
      state: { present: true, ...state },
      status: {
        present: true,
        path: status.path,
        bytes: status.bytes,
        sha256: status.sha256,
        sidecar,
      },
    }],
    citation_allowed: false,
  };
  const inventoryWritten = await writeJson(path.join(evidence, 'inventory.json'), inventory);
  const tree = await inspectTreeStrict(evidence);
  return {
    schema_version: 1,
    directory: 'seed-predecessor-evidence',
    inventory_sha256: inventoryWritten.sha256,
    tree_sha256: tree.tree_sha256,
    files: tree.files,
    bytes: tree.bytes,
  };
}

async function createFixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ocr-single-shard-monitor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await createPredecessor(root, options);
  const predecessor = await inspectPredecessorB1(source.b1);
  const b2 = path.join(root, 'output/b2');
  await mkdir(path.join(b2, 'documents/doc-one/pages/0001'), { recursive: true });
  await mkdir(path.join(b2, 'status'), { recursive: true });
  await mkdir(path.join(b2, 'logs'), { recursive: true });
  const successorCacheHome = path.join(await realpath(b2), 'paddlex-cache');
  const successorCacheFingerprint = await createPaddlexCache(successorCacheHome);
  assert.deepEqual(successorCacheFingerprint, source.cacheFingerprint);
  await copyExact(
    path.join(source.b1, 'documents/doc-one/pages/0001/result.json'),
    path.join(b2, 'documents/doc-one/pages/0001/result.json'),
  );
  await copyExact(
    path.join(source.b1, 'documents/doc-one/pages/0001/content.md'),
    path.join(b2, 'documents/doc-one/pages/0001/content.md'),
  );
  const controlEvidence = await createPredecessorEvidence(b2, predecessor);
  const p4ToP1 = options.p4ToP1 === true;
  const successorWorker = workerConfiguration(
    1,
    successorCacheHome,
    successorCacheFingerprint.tree_sha256,
    p4ToP1 ? 1 : 4,
  );
  const successorRecovery = documentRecovery(1200);
  const successorRunnerScriptSha256 = hash('a');
  const successorAttestation = p4ToP1
    ? llamaAttestation(predecessor.identity.runtime, 1, '9')
    : predecessor.identity.llama_server_attestation;
  const successorAttestationSha256 = sha256(`${JSON.stringify(successorAttestation)}\n`);
  const successorRuntimeFingerprint = p4ToP1 ? {
    ...predecessor.identity.runtime_fingerprint,
    llama_server_attestation_sha256: successorAttestationSha256,
  } : predecessor.identity.runtime_fingerprint;
  const successorRuntimeFingerprintSha256 = sha256(
    `${JSON.stringify(successorRuntimeFingerprint)}\n`,
  );
  const predecessorContract = {
    manifest_sha256: predecessor.identity.manifest_sha256,
    run_identity_sha256: predecessor.anchors.identity_sha256,
    run_status_sha256: predecessor.anchors.run_status_sha256,
    run_status_sidecar_sha256: predecessor.run_status_record.sidecar_sha256,
    runtime: predecessor.identity.runtime,
    runtime_fingerprint: predecessor.identity.runtime_fingerprint,
    runtime_fingerprint_sha256: predecessor.identity.runtime_fingerprint_sha256,
    runner_script_sha256: predecessor.identity.runner_script_sha256,
    ocr_script_sha256: predecessor.identity.ocr_script_sha256,
    worker_configuration: predecessor.identity.worker_configuration,
    worker_configuration_sha256: sha256(canonicalJson(predecessor.identity.worker_configuration)),
    document_recovery: predecessor.identity.document_recovery,
    document_recovery_sha256: sha256(canonicalJson(predecessor.identity.document_recovery)),
    snapshot_sha256: predecessor.snapshot_sha256,
    completed_pages: predecessor.completed_pages,
    failed_pages: 0,
    quarantined_documents: 0,
    page_artifacts_sha256: predecessor.page_artifacts_sha256,
    control_evidence: controlEvidence,
  };
  const successorContract = {
    runtime: predecessor.identity.runtime,
    runtime_fingerprint: successorRuntimeFingerprint,
    runtime_fingerprint_sha256: successorRuntimeFingerprintSha256,
    worker_configuration: successorWorker,
    worker_configuration_sha256: sha256(canonicalJson(successorWorker)),
    document_recovery: successorRecovery,
    document_recovery_sha256: sha256(canonicalJson(successorRecovery)),
    runner_script_sha256: successorRunnerScriptSha256,
    ocr_script_sha256: predecessor.identity.ocr_script_sha256,
    citation_allowed: false,
  };
  const allowedConfigurationDelta = p4ToP1 ? {
    schema_version: 2,
    transition: 'p4_to_p1_v1',
    vl_rec_max_concurrency: { predecessor: 4, successor: 1 },
    server_parallel: { predecessor: 4, successor: 1 },
    paddlex_cache_home: {
      predecessor: source.worker.paddlex_cache_home,
      successor: successorWorker.paddlex_cache_home,
      tree_sha256: successorCacheFingerprint.tree_sha256,
    },
    child_idle_timeout_seconds: { predecessor: 300, successor: 1200 },
    llama_server_attestation: {
      predecessor_sha256: predecessor.identity.llama_server_attestation_sha256,
      successor_sha256: successorAttestationSha256,
      proc_cmdline_sha256: {
        predecessor: predecessor.identity.llama_server_attestation.proc_cmdline_sha256,
        successor: successorAttestation.proc_cmdline_sha256,
      },
      parallel: { predecessor: 4, successor: 1 },
      production_command_parallel: { predecessor: '4', successor: '1' },
    },
    runtime_fingerprint: {
      predecessor_sha256: predecessor.identity.runtime_fingerprint_sha256,
      successor_sha256: successorRuntimeFingerprintSha256,
    },
  } : {
    schema_version: 1,
    vl_rec_max_concurrency: { predecessor: 4, successor: 1 },
    paddlex_cache_home: {
      predecessor: source.worker.paddlex_cache_home,
      successor: successorWorker.paddlex_cache_home,
      tree_sha256: successorCacheFingerprint.tree_sha256,
    },
    child_idle_timeout_seconds: { predecessor: 300, successor: 1200 },
  };
  const seedBasis = {
    schema_version: 1,
    mode: 'hash_bound_output_seed',
    manifest_sha256: predecessor.identity.manifest_sha256,
    predecessor: predecessorContract,
    successor_contract: successorContract,
    allowed_configuration_delta: allowedConfigurationDelta,
    documents: predecessor.documents,
    citation_allowed: false,
  };
  const seedId = sha256(canonicalJson(seedBasis));
  const predecessorState = JSON.parse(await readFile(
    path.join(source.b1, 'documents/doc-one/state.json'),
    'utf8',
  ));
  const successorState = {
    ...predecessorState,
    configuration: stateConfiguration(predecessor.identity.runtime, successorWorker),
    configuration_scope: 'active_writer_with_hash_bound_seed_exceptions',
    seed_lineage: {
      schema_version: 1,
      mode: 'hash_bound_output_seed',
      seed_id: seedId,
      predecessor_run_identity_sha256: predecessor.anchors.identity_sha256,
      predecessor_configuration_sha256: predecessor.documents[0].predecessor_configuration_sha256,
      inherited_completed_pages: [1],
      citation_allowed: false,
    },
    pages: {
      1: {
        ...predecessorState.pages['1'],
        seed_provenance: {
          seed_id: seedId,
          predecessor_run_identity_sha256: predecessor.anchors.identity_sha256,
          predecessor_configuration_sha256: predecessor.documents[0].predecessor_configuration_sha256,
        },
      },
    },
  };
  const successorStateWritten = await writeJson(path.join(b2, 'documents/doc-one/state.json'), successorState);
  const predecessorStatus = JSON.parse(await readFile(path.join(source.b1, 'status/doc-one.json'), 'utf8'));
  const successorStatus = {
    ...predecessorStatus,
    runtime_fingerprint_sha256: successorRuntimeFingerprintSha256,
    seed_lineage: {
      schema_version: 1,
      seed_id: seedId,
      predecessor_status_sha256: predecessor.documents[0].predecessor_status_sha256,
      inherited_attempts: 1,
      citation_allowed: false,
    },
  };
  const successorStatusWritten = await writeHashBoundJson(path.join(b2, 'status/doc-one.json'), successorStatus);
  const successorRunStatus = structuredClone(predecessor.run_status);
  successorRunStatus.runtime_fingerprint_sha256 = successorRuntimeFingerprintSha256;
  successorRunStatus.document_recovery = successorRecovery;
  successorRunStatus.seed_lineage = {
    schema_version: 1,
    mode: 'hash_bound_output_seed',
    seed_id: seedId,
    predecessor_run_identity_sha256: predecessor.anchors.identity_sha256,
    predecessor_run_status_sha256: predecessor.anchors.run_status_sha256,
    citation_allowed: false,
  };
  Object.assign(successorRunStatus.documents['doc-one'], {
    predecessor_status: predecessor.run_status.documents['doc-one'].status,
    inherited_attempts: 1,
    seed_id: seedId,
    status_json_sha256: successorStatusWritten.sha256,
  });
  const successorRunStatusWritten = await writeHashBoundJson(path.join(b2, 'run-status.json'), successorRunStatus);
  const successorDocumentTree = await inspectTreeStrict(path.join(b2, 'documents/doc-one'));
  const receiptDocument = {
    ...predecessor.documents[0],
    successor_document_tree: {
      tree_sha256: successorDocumentTree.tree_sha256,
      files: successorDocumentTree.files,
      bytes: successorDocumentTree.bytes,
    },
    successor_state_sha256: successorStateWritten.sha256,
    successor_status_sha256: successorStatusWritten.sha256,
  };
  const receipt = {
    schema_version: 1,
    receipt_type: 'curriculum_remote_ocr_hash_bound_output_seed',
    status: 'prepared_commit_marker_required',
    seed_id: seedId,
    seed_basis_sha256: seedId,
    manifest_sha256: predecessor.identity.manifest_sha256,
    predecessor: predecessorContract,
    successor: {
      ...successorContract,
      initial_run_status_sha256: successorRunStatusWritten.sha256,
    },
    allowed_configuration_delta: allowedConfigurationDelta,
    counts: {
      documents: 1,
      inherited_documents: 1,
      inherited_pages: 1,
      failed_pages: 0,
      quarantined_documents: 0,
    },
    documents: [receiptDocument],
    citation_allowed: false,
  };
  const receiptWritten = await writeHashBoundJson(path.join(b2, 'seed-receipt.json'), receipt);
  const identity = {
    ...predecessor.identity,
    runner_script_sha256: successorRunnerScriptSha256,
    runtime_fingerprint: successorRuntimeFingerprint,
    runtime_fingerprint_sha256: successorRuntimeFingerprintSha256,
    llama_server_attestation: successorAttestation,
    llama_server_attestation_sha256: successorAttestationSha256,
    worker_configuration: successorWorker,
    document_recovery: successorRecovery,
    seed_lineage: {
      schema_version: 1,
      mode: 'hash_bound_output_seed',
      seed_id: seedId,
      seed_receipt_sha256: receiptWritten.sha256,
      predecessor_run_identity_sha256: predecessor.anchors.identity_sha256,
      predecessor_run_status_sha256: predecessor.anchors.run_status_sha256,
      predecessor_snapshot_sha256: predecessor.snapshot_sha256,
      inherited_pages: 1,
      citation_allowed: false,
    },
  };
  const identityWritten = await writeJson(path.join(b2, 'run-identity.json'), identity);
  const specifications = [
    { name: 'documents', type: 'directory' },
    { name: 'status', type: 'directory' },
    { name: 'seed-predecessor-evidence', type: 'directory' },
    { name: 'seed-receipt.json', type: 'file' },
    { name: 'seed-receipt.json.sha256', type: 'file' },
    { name: 'run-identity.json', type: 'file' },
    { name: 'run-status.json', type: 'file' },
    { name: 'run-status.json.sha256', type: 'file' },
  ];
  const installedItems = [];
  for (const specification of specifications) {
    const pathname = path.join(b2, specification.name);
    if (specification.type === 'directory') {
      const tree = await inspectTreeStrict(pathname);
      installedItems.push({
        ...specification,
        fingerprint: { tree_sha256: tree.tree_sha256, files: tree.files, bytes: tree.bytes },
      });
    } else {
      const raw = await readFile(pathname);
      installedItems.push({ ...specification, fingerprint: { sha256: sha256(raw), bytes: raw.byteLength } });
    }
  }
  const control = {
    schema_version: 1,
    seed_id: seedId,
    seed_receipt_sha256: receiptWritten.sha256,
    run_identity_sha256: identityWritten.sha256,
    initial_run_status_sha256: successorRunStatusWritten.sha256,
    citation_allowed: false,
  };
  await writeHashBoundJson(path.join(b2, '.seed-journal.json'), {
    ...control,
    journal_type: 'curriculum_remote_ocr_hash_bound_seed_install',
    items: installedItems,
  });
  await writeHashBoundJson(path.join(b2, 'seed-commit.json'), {
    ...control,
    marker_type: 'curriculum_remote_ocr_hash_bound_seed_commit',
    installed_items: installedItems,
    installed_items_sha256: sha256(canonicalJson(installedItems)),
  });
  return {
    root,
    b1: source.b1,
    b2,
    predecessor,
    seedId,
    cacheFingerprint: successorCacheFingerprint,
    receipt,
    identity,
  };
}

async function normalizeFixtureRecovery(fixture, {
  rawStatus = 'interrupted',
  attempt = 1,
  recordedAt = '2026-07-17T00:00:00.000Z',
  declaredStatus = 'retry_wait',
  legacy = false,
  priorInterruptedAt = null,
  priorFailedAt = null,
} = {}) {
  const statusPath = path.join(fixture.b2, 'status/doc-one.json');
  const identity = JSON.parse(await readFile(path.join(fixture.b2, 'run-identity.json'), 'utf8'));
  const timestampField = {
    running: 'started_at',
    failed: 'failed_at',
    interrupted: 'interrupted_at',
  }[rawStatus];
  let status;
  if (legacy) {
    status = JSON.parse(await readFile(statusPath, 'utf8'));
  } else {
    status = {
      schema_version: 1,
      document_id: 'doc-one',
      status: rawStatus,
      attempt,
      max_attempts: 5,
      page_count: 2,
      runtime_fingerprint_sha256: identity.runtime_fingerprint_sha256,
      citation_allowed: false,
      [timestampField]: recordedAt,
      ...(rawStatus === 'failed' ? { error: 'recoverable OCR failure' } : {}),
    };
  }
  const statusWritten = await writeHashBoundJson(statusPath, status);
  const runStatusPath = path.join(fixture.b2, 'run-status.json');
  const runStatus = JSON.parse(await readFile(runStatusPath, 'utf8'));
  const progress = runStatus.documents['doc-one'];
  for (const key of ['started_at', 'failed_at', 'interrupted_at', 'failure_class', 'error', 'signal']) {
    delete progress[key];
  }
  progress.status = 'retry_wait';
  progress.attempts = attempt;
  if (priorInterruptedAt) progress.interrupted_at = priorInterruptedAt;
  if (priorFailedAt) progress.failed_at = priorFailedAt;
  progress[timestampField] = status[timestampField];
  if (rawStatus === 'failed') progress.error = status.error;
  const recoveryRecordedAt = progress.interrupted_at || progress.failed_at || progress.started_at;
  progress.next_retry_at = new Date(
    Date.parse(recoveryRecordedAt) + [2_000, 10_000, 30_000, 60_000][attempt - 1],
  ).toISOString();
  progress.status_json_sha256 = statusWritten.sha256;
  runStatus.counts = {
    total: 1,
    complete: 0,
    failed: declaredStatus === 'failed' ? 1 : 0,
    interrupted: declaredStatus === 'interrupted' ? 1 : 0,
    pending: declaredStatus === 'pending' ? 1 : 0,
    running: declaredStatus === 'running' ? 1 : 0,
    retry_wait: declaredStatus === 'retry_wait' ? 1 : 0,
    quarantined: declaredStatus === 'quarantined' ? 1 : 0,
  };
  runStatus.finished = false;
  runStatus.settled = false;
  await writeHashBoundJson(runStatusPath, runStatus);
  return { status, statusWritten, runStatus };
}

async function completeFixture(fixture) {
  const statePath = path.join(fixture.b2, 'documents/doc-one/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const secondPage = await pageArtifacts(
    path.join(fixture.b2, 'documents/doc-one/pages/0002'),
    'page two\n',
  );
  secondPage.physical_pdf_page = 2;
  state.completed_pages = [1, 2];
  state.pages['2'] = secondPage;
  state.selected_pages_complete = true;
  const stateWritten = await writeJson(statePath, state);
  const pageArtifacts_ = [1, 2].map((page) => ({
    page_number: page,
    rendered_image_sha256: state.pages[String(page)].rendered_image_sha256,
    result_json_sha256: state.pages[String(page)].result_json_sha256,
    content_markdown_sha256: state.pages[String(page)].content_markdown_sha256,
    citation_eligible: false,
  }));
  const identity = JSON.parse(await readFile(path.join(fixture.b2, 'run-identity.json'), 'utf8'));
  const status = {
    schema_version: 1,
    document_id: 'doc-one',
    status: 'complete',
    attempt: 2,
    max_attempts: 5,
    source_sha256: state.source_sha256,
    page_count: 2,
    runtime_fingerprint_sha256: identity.runtime_fingerprint_sha256,
    citation_allowed: false,
    whole_document_atomic: true,
    artifacts: {
      state_sha256: stateWritten.sha256,
      page_artifacts_sha256: sha256(`${JSON.stringify(pageArtifacts_)}\n`),
      page_artifacts: pageArtifacts_,
    },
    verified_at: '2026-07-17T00:10:00.000Z',
  };
  const statusWritten = await writeHashBoundJson(path.join(fixture.b2, 'status/doc-one.json'), status);
  const runStatusPath = path.join(fixture.b2, 'run-status.json');
  const runStatus = JSON.parse(await readFile(runStatusPath, 'utf8'));
  Object.assign(runStatus.documents['doc-one'], {
    status: 'complete',
    attempts: 2,
    verified_at: status.verified_at,
    status_json_sha256: statusWritten.sha256,
  });
  delete runStatus.documents['doc-one'].error;
  delete runStatus.documents['doc-one'].failed_at;
  delete runStatus.documents['doc-one'].next_retry_at;
  runStatus.counts = {
    total: 1,
    complete: 1,
    failed: 0,
    interrupted: 0,
    pending: 0,
    running: 0,
    retry_wait: 0,
    quarantined: 0,
  };
  runStatus.finished = true;
  runStatus.settled = true;
  await writeHashBoundJson(runStatusPath, runStatus);
}

function service(overrides = {}) {
  return {
    active_state: 'active',
    sub_state: 'running',
    n_restarts: 0,
    exec_main_status: 0,
    main_pid: 123,
    result: 'success',
    ...overrides,
  };
}

function baseSnapshot(overrides = {}) {
  const snapshot = {
    thresholds: { stall_seconds: 1500, disk_min_gib: 50, memory_min_gib: 2, gpu_max_c: 85 },
    collection_errors: [],
    predecessor: { read_ok: true, anchors_match: true, documents: 1, completed_pages: 1 },
    successor: {
      read_ok: true,
      complete: false,
      expected_pages: 2,
      completed_pages: 1,
      failed_pages: 0,
      progress_age_seconds: 30,
      inconsistent_completion: false,
      declared_counts_match: true,
      status_counts: {
        total: 1,
        complete: 0,
        failed: 0,
        interrupted: 0,
        pending: 0,
        running: 1,
        retry_wait: 0,
        quarantined: 0,
      },
    },
    services: {
      worker: service(),
      old_workers: {
        a: service({ active_state: 'inactive', sub_state: 'dead', main_pid: 0 }),
        b: service({ active_state: 'inactive', sub_state: 'dead', main_pid: 0 }),
      },
      llama: { systemd: service(), health: { healthy: true, http_status: 200 } },
    },
    resources: {
      disk: { available_gib: 200 },
      memory: { available_gib: 8 },
      gpu: { max_temperature_c: 70, max_utilization_percent: 90 },
    },
    ...overrides,
  };
  return snapshot;
}

test('CLI fixes B2 to one disjoint successor and requires all five B1 anchors', () => {
  const arguments_ = [
    '--run-root', '/run',
    '--predecessor-output', 'output/b1',
    '--successor-output', 'output/b2',
    '--output-dir', '/run/monitor-b2',
    '--worker-unit', 'curriculum-ocr-b2.service',
    '--old-worker-unit', 'a=curriculum-ocr-old@a.service',
    '--old-worker-unit', 'b=curriculum-ocr-old@b.service',
    '--inactive-worker-unit', 'b-r2=curriculum-ocr-reprocess-b-r2.service',
    '--b1-identity-sha256', hash('1'),
    '--b1-run-status-sha256', hash('2'),
    '--b1-state-hashset-sha256', hash('3'),
    '--b1-status-hashset-sha256', hash('4'),
    '--b1-artifact-hashset-sha256', hash('5'),
  ];
  const parsed = parseSingleShardMonitorArgs(arguments_);
  assert.equal(parsed.thresholds.stall_seconds, 1500);
  assert.equal(parsed.thresholds.memory_min_gib, 2);
  assert.equal(parsed.predecessorAnchors.artifact_hashset_sha256, hash('5'));
  assert.equal(
    parsed.inactiveWorkerUnits.get('b-r2'),
    'curriculum-ocr-reprocess-b-r2.service',
  );
  assert.throws(
    () => parseSingleShardMonitorArgs(arguments_.filter((value, index) => index < arguments_.length - 2)),
    /artifact_hashset_sha256/,
  );
  const nested = [...arguments_];
  nested[nested.indexOf('/run/monitor-b2')] = '/run/output/b2/monitor';
  assert.throws(() => parseSingleShardMonitorArgs(nested), /disjoint/);
  assert.throws(
    () => parseSingleShardMonitorArgs([
      ...arguments_,
      '--inactive-worker-unit', 'b-r2=curriculum-ocr-other.service',
    ]),
    /duplicate inactive worker label/,
  );
  const duplicateUnit = [...arguments_];
  duplicateUnit[duplicateUnit.indexOf('b-r2=curriculum-ocr-reprocess-b-r2.service')]
    = 'b-r2=curriculum-ocr-b2.service';
  assert.throws(() => parseSingleShardMonitorArgs(duplicateUnit), /must be distinct/);
});

test('healthy running is 10 and a complete shard permits inactive B2 and llama services', () => {
  assert.deepEqual(classifySingleShardSnapshot(baseSnapshot()), {
    state: 'healthy_running', exit_code: 10, issues: [],
  });
  const completed = baseSnapshot({
    successor: {
      ...baseSnapshot().successor,
      complete: true,
      expected_pages: 2,
      completed_pages: 2,
      progress_age_seconds: 5000,
      status_counts: {
        total: 1,
        complete: 1,
        failed: 0,
        interrupted: 0,
        pending: 0,
        running: 0,
        retry_wait: 0,
        quarantined: 0,
      },
    },
    services: {
      ...baseSnapshot().services,
      worker: service({ active_state: 'inactive', sub_state: 'dead', main_pid: 0 }),
      llama: {
        systemd: service({ active_state: 'inactive', sub_state: 'dead', main_pid: 0 }),
        health: { healthy: false, http_status: null },
      },
    },
  });
  assert.deepEqual(classifySingleShardSnapshot(completed), {
    state: 'completed', exit_code: 0, issues: [],
  });
});

test('p1 requires active services while running and stopped services after completion', () => {
  const running = baseSnapshot({
    successor: {
      ...baseSnapshot().successor,
      configuration_transition: 'p4_to_p1_v1',
    },
    services: {
      ...baseSnapshot().services,
      inactive_workers: {
        'b-r2': service({ active_state: 'inactive', sub_state: 'dead', main_pid: 0 }),
      },
    },
  });
  assert.deepEqual(classifySingleShardSnapshot(running), {
    state: 'healthy_running', exit_code: 10, issues: [],
  });

  const complete = {
    ...running,
    successor: {
      ...running.successor,
      complete: true,
      expected_pages: 2,
      completed_pages: 2,
      status_counts: {
        total: 1,
        complete: 1,
        failed: 0,
        interrupted: 0,
        pending: 0,
        running: 0,
        retry_wait: 0,
        quarantined: 0,
      },
    },
  };
  const activeAfterCompletion = classifySingleShardSnapshot(complete);
  assert.deepEqual(
    activeAfterCompletion.issues.map(({ code }) => code),
    ['B2_WORKER_ACTIVE_AFTER_P1_COMPLETION', 'LLAMA_ACTIVE_AFTER_P1_COMPLETION'],
  );
  const stopped = structuredClone(complete);
  stopped.services.worker = service({ active_state: 'inactive', sub_state: 'dead', main_pid: 0 });
  stopped.services.llama = {
    systemd: service({ active_state: 'inactive', sub_state: 'dead', main_pid: 0 }),
    health: { healthy: false, http_status: null },
  };
  assert.deepEqual(classifySingleShardSnapshot(stopped), {
    state: 'completed', exit_code: 0, issues: [],
  });

  const unclean = structuredClone(stopped);
  unclean.services.worker.exec_main_status = 12;
  unclean.services.worker.result = 'exit-code';
  assert.deepEqual(
    classifySingleShardSnapshot(unclean).issues.map(({ code }) => code),
    ['B2_WORKER_UNCLEAN_AFTER_P1_COMPLETION'],
  );

  stopped.services.inactive_workers['b-r2'] = service();
  assert.ok(classifySingleShardSnapshot(stopped).issues.some(
    ({ code }) => code === 'INACTIVE_WORKER_B_R2_ACTIVE',
  ));
});

test('an interrupted seed backlog is recoverable only while the B2 worker is strictly running', () => {
  const interrupted = {
    ...baseSnapshot().successor,
    progress_age_seconds: 30,
    status_counts: {
      total: 1,
      complete: 0,
      failed: 0,
      interrupted: 1,
      pending: 0,
      running: 0,
      retry_wait: 0,
      quarantined: 0,
    },
  };
  assert.deepEqual(classifySingleShardSnapshot(baseSnapshot({ successor: interrupted })), {
    state: 'healthy_running', exit_code: 10, issues: [],
  });

  const staleWhileRunning = classifySingleShardSnapshot(baseSnapshot({
    successor: { ...interrupted, progress_age_seconds: 1501 },
  }));
  assert.equal(staleWhileRunning.exit_code, 12);
  assert.deepEqual(staleWhileRunning.issues.map(({ code }) => code), ['B2_NO_PROGRESS']);

  const stoppedSeed = classifySingleShardSnapshot(baseSnapshot({
    successor: { ...interrupted, progress_age_seconds: 5000 },
    services: {
      ...baseSnapshot().services,
      worker: service({ active_state: 'inactive', sub_state: 'dead', main_pid: 0 }),
    },
  }));
  assert.equal(stoppedSeed.exit_code, 12);
  assert.ok(stoppedSeed.issues.some(({ code }) => code === 'B2_WORKER_NOT_ACTIVE'));
  assert.ok(stoppedSeed.issues.some(({ code }) => code === 'B2_INTERRUPTED'));
  assert.ok(!stoppedSeed.issues.some(({ code }) => code === 'B2_NO_PROGRESS'));
});

test('derived B2 counts tolerate coherent declared lag only during strict active execution', () => {
  const activeLag = {
    ...baseSnapshot().successor,
    declared_counts_match: false,
    progress_age_seconds: 30,
    status_counts: {
      total: 2,
      complete: 0,
      failed: 0,
      interrupted: 1,
      pending: 0,
      running: 1,
      retry_wait: 0,
      quarantined: 0,
    },
  };
  assert.deepEqual(classifySingleShardSnapshot(baseSnapshot({ successor: activeLag })), {
    state: 'healthy_running', exit_code: 10, issues: [],
  });

  const activeStall = classifySingleShardSnapshot(baseSnapshot({
    successor: { ...activeLag, progress_age_seconds: 1501 },
  }));
  assert.equal(activeStall.exit_code, 12);
  assert.deepEqual(activeStall.issues.map(({ code }) => code), ['B2_NO_PROGRESS']);

  const inactiveLag = classifySingleShardSnapshot(baseSnapshot({
    successor: activeLag,
    services: {
      ...baseSnapshot().services,
      worker: service({ active_state: 'inactive', sub_state: 'dead', main_pid: 0 }),
    },
  }));
  assert.equal(inactiveLag.exit_code, 12);
  assert.ok(inactiveLag.issues.some(({ code }) => code === 'B2_RUN_COUNTS_DRIFT'));
  assert.ok(inactiveLag.issues.some(({ code }) => code === 'B2_WORKER_NOT_ACTIVE'));

  const completeLag = classifySingleShardSnapshot(baseSnapshot({
    successor: {
      ...activeLag,
      complete: true,
      expected_pages: 2,
      completed_pages: 2,
      status_counts: {
        total: 2,
        complete: 2,
        failed: 0,
        interrupted: 0,
        pending: 0,
        running: 0,
        retry_wait: 0,
        quarantined: 0,
      },
    },
  }));
  assert.equal(completeLag.exit_code, 12);
  assert.deepEqual(completeLag.issues.map(({ code }) => code), ['B2_RUN_COUNTS_DRIFT']);
});

test('worker, llama, quarantine, B1 hash drift, stall, old workers, and resources are critical', () => {
  const cases = [
    ['worker down', { services: { ...baseSnapshot().services, worker: service({ active_state: 'inactive', sub_state: 'dead', main_pid: 0 }) } }, 'B2_WORKER_NOT_ACTIVE'],
    ['llama down', { services: { ...baseSnapshot().services, llama: { systemd: service({ active_state: 'inactive', sub_state: 'dead', main_pid: 0 }), health: { healthy: false } } } }, 'LLAMA_NOT_ACTIVE'],
    ['quarantine', { successor: { ...baseSnapshot().successor, status_counts: { ...baseSnapshot().successor.status_counts, running: 0, quarantined: 1 } } }, 'B2_QUARANTINED'],
    ['hash drift', { predecessor: { ...baseSnapshot().predecessor, anchors_match: false } }, 'B1_HASH_DRIFT'],
    ['stall', { successor: { ...baseSnapshot().successor, progress_age_seconds: 1501 } }, 'B2_NO_PROGRESS'],
    ['old worker active', { services: { ...baseSnapshot().services, old_workers: { ...baseSnapshot().services.old_workers, a: service() } } }, 'OLD_WORKER_A_ACTIVE'],
    ['inactive worker active', { services: { ...baseSnapshot().services, inactive_workers: { 'b-r2': service() } } }, 'INACTIVE_WORKER_B_R2_ACTIVE'],
    ['disk', { resources: { ...baseSnapshot().resources, disk: { available_gib: 49.999 } } }, 'DISK_BELOW_MINIMUM'],
    ['memory', { resources: { ...baseSnapshot().resources, memory: { available_gib: 1.999 } } }, 'MEMORY_BELOW_MINIMUM'],
    ['gpu', { resources: { ...baseSnapshot().resources, gpu: { max_temperature_c: 85.001 } } }, 'GPU_OVER_TEMPERATURE'],
  ];
  for (const [name, overrides, code] of cases) {
    const result = classifySingleShardSnapshot(baseSnapshot(overrides));
    assert.equal(result.exit_code, 12, name);
    assert.ok(result.issues.some((value) => value.code === code), name);
  }
});

test('real B1 and B2 fixture validates receipt, marker, identity, counts, attempts, pages, and sidecars', async (t) => {
  const fixture = await createFixture(t);
  const predecessor = await inspectPredecessorB1(fixture.b1);
  assert.deepEqual(predecessor.anchors, fixture.predecessor.anchors);
  assert.deepEqual(predecessor.paddlex_layout_model_cache, fixture.cacheFingerprint);
  assert.equal((await lstat(path.join(fixture.b1, 'paddlex-cache'))).isDirectory(), true);
  const successor = await inspectSuccessorB2(fixture.b2, predecessor);
  assert.equal(successor.read_ok, true);
  assert.deepEqual(successor.paddlex_layout_model_cache, fixture.cacheFingerprint);
  assert.equal((await lstat(path.join(fixture.b2, 'paddlex-cache'))).isDirectory(), true);
  assert.equal(successor.complete, false);
  assert.equal(successor.completed_pages, 1);
  assert.equal(successor.expected_pages, 2);
  assert.equal(successor.failed_pages, 0);
  assert.equal(successor.status_counts.retry_wait, 1);
  assert.equal(successor.declared_counts_match, true);

  await completeFixture(fixture);
  const completed = await inspectSuccessorB2(fixture.b2, predecessor);
  assert.equal(completed.complete, true);
  assert.equal(completed.completed_pages, 2);
  assert.equal(completed.status_counts.complete, 1);
  assert.equal(completed.declared_counts_match, true);
});

test('real p4-to-p1 receipt recomputes both identities and exposes the transition', async (t) => {
  const fixture = await createFixture(t, { p4ToP1: true });
  assert.equal(
    validateP4ToP1MonitorDelta(fixture.receipt, fixture.predecessor.identity, fixture.identity),
    'p4_to_p1_v1',
  );
  const successor = await inspectSuccessorB2(fixture.b2, fixture.predecessor);
  assert.equal(successor.configuration_transition, 'p4_to_p1_v1');
  assert.equal(successor.status_counts.retry_wait, 1);
  assert.equal(successor.complete, false);
});

test('p4-to-p1 validator rejects coherently rebound forbidden deltas and declaration tampering', async (t) => {
  const fixture = await createFixture(t, { p4ToP1: true });
  const rebind = (receipt, identity) => {
    identity.llama_server_attestation_sha256 = sha256(
      `${JSON.stringify(identity.llama_server_attestation)}\n`,
    );
    identity.runtime_fingerprint.llama_server_attestation_sha256
      = identity.llama_server_attestation_sha256;
    identity.runtime_fingerprint_sha256 = sha256(
      `${JSON.stringify(identity.runtime_fingerprint)}\n`,
    );
    Object.assign(receipt.successor, {
      runtime: structuredClone(identity.runtime),
      runtime_fingerprint: structuredClone(identity.runtime_fingerprint),
      runtime_fingerprint_sha256: identity.runtime_fingerprint_sha256,
      worker_configuration: structuredClone(identity.worker_configuration),
      worker_configuration_sha256: sha256(canonicalJson(identity.worker_configuration)),
      document_recovery: structuredClone(identity.document_recovery),
      document_recovery_sha256: sha256(canonicalJson(identity.document_recovery)),
      runner_script_sha256: identity.runner_script_sha256,
      ocr_script_sha256: identity.ocr_script_sha256,
    });
    Object.assign(receipt.allowed_configuration_delta.llama_server_attestation, {
      successor_sha256: identity.llama_server_attestation_sha256,
      proc_cmdline_sha256: {
        ...receipt.allowed_configuration_delta.llama_server_attestation.proc_cmdline_sha256,
        successor: identity.llama_server_attestation.proc_cmdline_sha256,
      },
    });
    receipt.allowed_configuration_delta.runtime_fingerprint.successor_sha256
      = identity.runtime_fingerprint_sha256;
  };
  const cases = [
    ['runtime model', (receipt, identity) => {
      identity.runtime.model_sha256 = hash('b');
      identity.runtime_fingerprint.model_sha256 = hash('b');
      identity.llama_server_attestation.model_sha256 = hash('b');
    }, /forbidden model|runtime controls/],
    ['systemd unit', (_receipt, identity) => {
      identity.llama_server_attestation.systemd_unit = 'other.service';
    }, /unit, host, port, or parallelism/],
    ['production temp', (_receipt, identity) => {
      identity.llama_server_attestation.production_command_contract.values['--temp'] = '0.1';
    }, /forbidden production command value/],
    ['production flags', (_receipt, identity) => {
      identity.llama_server_attestation.production_command_contract.flags = ['--metrics'];
    }, /production command flags/],
    ['llama URL', (_receipt, identity) => {
      identity.worker_configuration.llama_url = 'http://127.0.0.1:8113';
    }, /must retain http:\/\/127\.0\.0\.1:8112|forbidden worker/],
    ['micro batch', (_receipt, identity) => {
      identity.worker_configuration.micro_batch = 8;
    }, /exact concurrency delta/],
    ['cache tree', (_receipt, identity) => {
      identity.worker_configuration.paddlex_layout_model_cache_sha256 = hash('c');
    }, /forbidden worker field|identical cache tree/],
    ['recovery policy', (_receipt, identity) => {
      identity.document_recovery.child_monitoring.wall_floor_seconds = 1300;
    }, /forbidden document recovery field/],
    ['runtime fingerprint field', (_receipt, identity) => {
      identity.runtime_fingerprint.extra = true;
    }, /field set differs/],
    ['OCR script', (_receipt, identity) => {
      identity.ocr_script_sha256 = hash('0');
    }, /OCR identity/],
    ['proc command did not change', (_receipt, identity) => {
      identity.llama_server_attestation.proc_cmdline_sha256
        = fixture.predecessor.identity.llama_server_attestation.proc_cmdline_sha256;
    }, /proc cmdline SHA-256 did not change/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const receipt = structuredClone(fixture.receipt);
    const identity = structuredClone(fixture.identity);
    mutate(receipt, identity);
    rebind(receipt, identity);
    assert.throws(
      () => validateP4ToP1MonitorDelta(receipt, fixture.predecessor.identity, identity),
      pattern,
      name,
    );
  }
  const declaration = structuredClone(fixture.receipt);
  declaration.allowed_configuration_delta.transition = 'p1_to_p1';
  assert.throws(
    () => validateP4ToP1MonitorDelta(
      declaration,
      fixture.predecessor.identity,
      fixture.identity,
    ),
    /transition declaration/,
  );
});

test('B2 derives live counts and validates exact runner recovery normalization', async (t) => {
  await t.test('legacy seeded interrupted status normalizes to retry_wait with stale declared counts', async (t) => {
    const fixture = await createFixture(t, { legacyInterrupted: true });
    await normalizeFixtureRecovery(fixture, {
      rawStatus: 'interrupted',
      attempt: 1,
      declaredStatus: 'interrupted',
      legacy: true,
    });
    const successor = await inspectSuccessorB2(fixture.b2, fixture.predecessor);
    assert.equal(successor.status_counts.retry_wait, 1);
    assert.equal(successor.status_counts.interrupted, 0);
    assert.equal(successor.declared_counts_match, false);
  });

  for (const [rawStatus, attempt] of [['running', 2], ['failed', 4], ['interrupted', 3]]) {
    await t.test(`full successor ${rawStatus} status normalizes with audited attempt backoff`, async (t) => {
      const fixture = await createFixture(t);
      await normalizeFixtureRecovery(fixture, {
        rawStatus,
        attempt,
        declaredStatus: rawStatus,
        ...(rawStatus === 'running'
          ? { priorInterruptedAt: '2026-07-16T23:59:00.000Z' }
          : {}),
      });
      const successor = await inspectSuccessorB2(fixture.b2, fixture.predecessor);
      assert.equal(successor.status_counts.retry_wait, 1);
      assert.equal(successor.status_counts[rawStatus], 0);
      assert.equal(successor.declared_counts_match, false);
    });
  }

  await t.test('mutated normalized backoff is rejected', async (t) => {
    const fixture = await createFixture(t);
    await normalizeFixtureRecovery(fixture, { rawStatus: 'interrupted', attempt: 3 });
    const runStatusPath = path.join(fixture.b2, 'run-status.json');
    const runStatus = JSON.parse(await readFile(runStatusPath, 'utf8'));
    runStatus.documents['doc-one'].next_retry_at = '2026-07-17T00:00:31.000Z';
    await writeHashBoundJson(runStatusPath, runStatus);
    await assert.rejects(
      inspectSuccessorB2(fixture.b2, fixture.predecessor),
      /normalized recovery backoff/,
    );
  });

  await t.test('mutated normalized raw status is rejected', async (t) => {
    const fixture = await createFixture(t);
    await normalizeFixtureRecovery(fixture, { rawStatus: 'interrupted', attempt: 3 });
    const statusPath = path.join(fixture.b2, 'status/doc-one.json');
    const status = JSON.parse(await readFile(statusPath, 'utf8'));
    status.status = 'quarantined';
    const statusWritten = await writeHashBoundJson(statusPath, status);
    const runStatusPath = path.join(fixture.b2, 'run-status.json');
    const runStatus = JSON.parse(await readFile(runStatusPath, 'utf8'));
    runStatus.documents['doc-one'].status_json_sha256 = statusWritten.sha256;
    await writeHashBoundJson(runStatusPath, runStatus);
    await assert.rejects(
      inspectSuccessorB2(fixture.b2, fixture.predecessor),
      /document status differs/,
    );
  });

  await t.test('mutated normalized status hash is rejected', async (t) => {
    const fixture = await createFixture(t);
    await normalizeFixtureRecovery(fixture, { rawStatus: 'interrupted', attempt: 3 });
    const runStatusPath = path.join(fixture.b2, 'run-status.json');
    const runStatus = JSON.parse(await readFile(runStatusPath, 'utf8'));
    runStatus.documents['doc-one'].status_json_sha256 = hash('f');
    await writeHashBoundJson(runStatusPath, runStatus);
    await assert.rejects(
      inspectSuccessorB2(fixture.b2, fixture.predecessor),
      /normalized recovery attempt or status hash/,
    );
  });

  await t.test('completed derived counts expose coherent declared drift but flags remain strict', async (t) => {
    const fixture = await createFixture(t);
    await completeFixture(fixture);
    const runStatusPath = path.join(fixture.b2, 'run-status.json');
    const runStatus = JSON.parse(await readFile(runStatusPath, 'utf8'));
    runStatus.counts = {
      total: 1,
      complete: 0,
      failed: 0,
      interrupted: 0,
      pending: 0,
      running: 0,
      retry_wait: 1,
      quarantined: 0,
    };
    await writeHashBoundJson(runStatusPath, runStatus);
    const successor = await inspectSuccessorB2(fixture.b2, fixture.predecessor);
    assert.equal(successor.complete, true);
    assert.equal(successor.status_counts.complete, 1);
    assert.equal(successor.declared_counts_match, false);

    runStatus.finished = false;
    await writeHashBoundJson(runStatusPath, runStatus);
    await assert.rejects(
      inspectSuccessorB2(fixture.b2, fixture.predecessor),
      /finished flag is inconsistent/,
    );
  });
});

test('sidecar, root, and PaddleX cache drift are rejected', async (t) => {
  await t.test('B1 declared count drift remains strict', async (t) => {
    const fixture = await createFixture(t);
    const runStatusPath = path.join(fixture.b1, 'run-status.json');
    const runStatus = JSON.parse(await readFile(runStatusPath, 'utf8'));
    runStatus.counts.interrupted = 1;
    runStatus.counts.retry_wait = 0;
    await writeHashBoundJson(runStatusPath, runStatus);
    await assert.rejects(inspectPredecessorB1(fixture.b1), /counts differ from document statuses/);
  });
  await t.test('sidecar mismatch', async (t) => {
    const fixture = await createFixture(t);
    await writeFile(path.join(fixture.b2, 'run-status.json'), '{"tampered":true}\n');
    await assert.rejects(inspectSuccessorB2(fixture.b2, fixture.predecessor), /sidecar mismatch/);
  });
  await t.test('extra entry', async (t) => {
    const fixture = await createFixture(t);
    await writeFile(path.join(fixture.b2, 'unexpected.txt'), 'no\n');
    await assert.rejects(inspectSuccessorB2(fixture.b2, fixture.predecessor), /unexpected entries/);
  });
  await t.test('symlink entry', async (t) => {
    const fixture = await createFixture(t);
    await symlink('run-status.json', path.join(fixture.b2, 'unexpected-link'));
    await assert.rejects(inspectSuccessorB2(fixture.b2, fixture.predecessor), /unexpected entries|symbolic link/);
  });
  await t.test('B1 cache path differs from its own output root', async (t) => {
    const fixture = await createFixture(t);
    const identityPath = path.join(fixture.b1, 'run-identity.json');
    const identity = JSON.parse(await readFile(identityPath, 'utf8'));
    identity.worker_configuration.paddlex_cache_home = path.join(fixture.root, 'foreign-cache');
    await writeJson(identityPath, identity);
    await assert.rejects(
      inspectPredecessorB1(fixture.b1),
      /paddlex_cache_home must be canonical and contained/,
    );
  });
  await t.test('B2 audited cache tree differs from its declared identity', async (t) => {
    const fixture = await createFixture(t);
    await writeFile(
      path.join(fixture.b2, 'paddlex-cache/official_models/PP-DocLayoutV3/inference.yml'),
      'Global:\n  model_name: drifted\n',
    );
    await assert.rejects(
      inspectSuccessorB2(fixture.b2, fixture.predecessor),
      /cache tree hash differs from its worker identity/,
    );
  });
  await t.test('B2 top-level cache is a symbolic link', async (t) => {
    const fixture = await createFixture(t);
    const successorCache = path.join(fixture.b2, 'paddlex-cache');
    await rm(successorCache, { recursive: true });
    await symlink(path.join(fixture.b1, 'paddlex-cache'), successorCache, 'dir');
    await assert.rejects(
      inspectSuccessorB2(fixture.b2, fixture.predecessor),
      /symbolic link|must be a real directory/,
    );
  });
});

test('resource probe is bounded to disk, MemAvailable, and GPU telemetry', async () => {
  const result = await collectSingleShardResources('/run', {
    filesystemStat: async () => ({ bavail: 60n, bsize: BigInt(1024 ** 3) }),
    read: async () => 'MemAvailable:       3145728 kB\n',
    runExecFile: async () => ({ stdout: '84, 100, 2600, 6144\n' }),
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.resources.disk.available_gib, 60);
  assert.equal(result.resources.memory.available_gib, 3);
  assert.equal(result.resources.gpu.max_temperature_c, 84);
});

test('monitor output mutates only its specified directory and stays privacy-safe', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ocr-single-shard-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const protectedPath = path.join(root, 'protected.json');
  await writeFile(protectedPath, 'unchanged\n');
  const output = path.join(root, 'monitor');
  const snapshot = {
    ...baseSnapshot(),
    run_id: 'b2-run',
    observed_at: '2026-07-17T00:00:00.000Z',
  };
  snapshot.successor.secret_document_id = 'must-not-appear';
  snapshot.successor.secret_path = '/home/suen/private';
  const health = classifySingleShardSnapshot(snapshot);
  await writeSingleShardMonitorOutputs(output, snapshot, health);
  await writeSingleShardMonitorOutputs(output, snapshot, health);
  assert.equal(await readFile(protectedPath, 'utf8'), 'unchanged\n');
  assert.deepEqual((await readdir(output)).sort(), ['events.jsonl', 'latest.json']);
  const raw = `${await readFile(path.join(output, 'latest.json'), 'utf8')}${await readFile(path.join(output, 'events.jsonl'), 'utf8')}`;
  assert.equal(raw.includes('must-not-appear'), false);
  assert.equal(raw.includes('/home/suen'), false);
  assert.equal(JSON.stringify(privacySafeSingleShardEvent(snapshot, health)).includes('secret_document_id'), false);
  assert.equal((await lstat(output)).isSymbolicLink(), false);
});
