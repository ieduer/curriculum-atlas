import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  chmod,
  cp,
  link,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  preflightDocument,
  fingerprintPaddlexLayoutModelCache,
  invokeOcrChild,
  probePythonPackageRuntime,
  probePythonOcrRuntime,
  runRemoteOcrOffload,
  terminateOwnedChild,
  validateLlamaSystemdUnitName,
  validateOcrDocumentOutput,
  validateRemoteOcrManifest,
  verifyLlamaServerAttestation,
  verifyPinnedRuntime,
} from '../scripts/run-remote-ocr-offload.mjs';
import {
  receiveRemoteOcrOffload,
  validateP4ToP1SeedDelta,
} from '../scripts/receive-remote-ocr-offload.mjs';
import {
  inspectPredecessorB1,
  inspectSuccessorB2,
  validateP4ToP1MonitorDelta,
} from '../scripts/monitor-remote-ocr-single-shard.mjs';
import { prepareTimeoutRecoveryGrant } from '../scripts/prepare-timeout-recovery-grant.mjs';
import { provisionTimeoutRecoveryAuthority } from '../scripts/provision-timeout-recovery-authority.mjs';
import {
  canonicalJson,
  captureLocalReprocessSnapshot,
  inspectTree,
} from '../scripts/lib/remote-ocr-local-snapshot.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const legacyB1OcrScriptSha256 = 'b4ea873026fb4d2da2efb921ddac3974a48db703143ff53aff3ebeae48d9b048';
const seedAwareOcrScriptSha256 = '3176d267c681b2764d4ff81f7e7b6748c174ee62854a11a2529ccfb355a364f3';
const auditedCommonInferenceSuffixSha256 = '4edade704624f0bac5bcd76eeb113a07452a57040e4fd949609d319f49c2b4ca';
const seedAwareTransition = 'p4_to_p1_seed_aware_ocr_v2';
const runtime = Object.freeze({
  pipeline: 'PaddleOCR-VL',
  pipeline_version: 'v1.6',
  model_sha256: 'a'.repeat(64),
  mmproj_sha256: 'b'.repeat(64),
  llama_commit: 'c'.repeat(40),
  render_dpi: 240,
});
const runtimeDevice = 'cpu+NVIDIA RTX 3060 Laptop GPU CUDA llama.cpp';
const pythonRuntime = Object.freeze({
  schema_version: 1,
  implementation: 'CPython',
  python_version: '3.13.5',
  packages: {
    paddlepaddle: '3.3.1',
    paddleocr: '3.7.0',
    paddlex: '3.7.2',
    pypdfium2: '5.12.0',
  },
});
const paddlexLayoutModelCache = Object.freeze({
  schema_version: 1,
  model_name: 'PP-DocLayoutV3',
  relative_root: 'official_models',
  file_count: 17,
  total_bytes: 132_005_144,
  tree_sha256: '9'.repeat(64),
});
const llamaSystemdUnit = 'curriculum-ocr-llama.service';
const llamaServerBin = '/unused/llama-server';
function productionCommandContract(parallel) {
  return {
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
  };
}

function productionArgv(binary, model, mmproj, parallel) {
  return [
    binary,
    '-m', model,
    '--mmproj', mmproj,
    '--host', '127.0.0.1',
    '--port', '8112',
    '--temp', '0',
    '--ctx-size', '32768',
    '--parallel', String(parallel),
    '--n-gpu-layers', 'all',
    '--mmproj-offload',
    '--flash-attn', 'auto',
    '--cache-type-k', 'f16',
    '--cache-type-v', 'f16',
    '--batch-size', '2048',
    '--ubatch-size', '512',
    '--cont-batching',
    '--fit', 'off',
    '--timeout', '3600',
    '--threads', '8',
    '--threads-batch', '16',
    '--no-webui',
    '--metrics',
  ];
}

const llamaServerAttestation = Object.freeze({
  schema_version: 1,
  systemd_unit: llamaSystemdUnit,
  active_state: 'active',
  sub_state: 'running',
  binary_path: llamaServerBin,
  binary_sha256: 'd'.repeat(64),
  version_sha256: 'e'.repeat(64),
  llama_commit_prefix: runtime.llama_commit.slice(0, 8),
  proc_cmdline_sha256: 'f'.repeat(64),
  model_path: '/unused/model',
  model_sha256: runtime.model_sha256,
  mmproj_path: '/unused/mmproj',
  mmproj_sha256: runtime.mmproj_sha256,
  host: '127.0.0.1',
  port: 8112,
  parallel: 2,
  production_command_contract: productionCommandContract(2),
  health_url: 'http://127.0.0.1:8112/health',
  health_status_code: 200,
  health_status: 'ok',
  health_body_sha256: '0'.repeat(64),
});

function llamaAttestationForParallel(parallel) {
  const argv = productionArgv(
    llamaServerBin,
    '/unused/model',
    '/unused/mmproj',
    parallel,
  );
  return {
    ...llamaServerAttestation,
    proc_cmdline_sha256: sha256(Buffer.from(`${argv.join('\0')}\0`)),
    parallel,
    production_command_contract: productionCommandContract(parallel),
  };
}
const healthySharedRuntimeRevalidation = async () => ({
  runtime,
  llamaServerAttestation,
  pythonRuntime,
  paddlexLayoutModelCache,
});
const workerConfiguration = Object.freeze({
  llama_url: 'http://127.0.0.1:8112/v1',
  vl_rec_max_concurrency: 2,
  server_parallel: 2,
  micro_batch: 4,
  use_queues: true,
  runtime_device: runtimeDevice,
  paddlex_cache_home: '/unused/paddlex-cache',
  python_runtime: pythonRuntime,
  paddlex_layout_model_cache_sha256: paddlexLayoutModelCache.tree_sha256,
});

function manifestFor(documents) {
  return {
    schema_version: 1,
    manifest_type: 'curriculum_remote_whole_document_ocr_offload_plan',
    quality_policy: {
      stage: 'remote_primary_ocr_staging_only',
      whole_document_atomic: true,
      citation_allowed: false,
      remote_results_require_local_witness_and_exact_audit_before_publication: true,
    },
    runtime: { ...runtime },
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
    counts: {
      selected_documents: documents.length,
      selected_pages: documents.reduce((sum, document) => sum + document.page_count, 0),
      selected_source_bytes: documents.reduce((sum, document) => sum + document.source_bytes, 0),
    },
    documents,
  };
}

function documentFor(id, sourcePath, contents, pageCount = 2) {
  return {
    id,
    source_path: sourcePath,
    source_sha256: sha256(contents),
    source_bytes: Buffer.byteLength(contents),
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
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'remote-ocr-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputRoot = path.join(root, 'input');
  const outputRoot = path.join(root, 'output');
  await mkdir(path.join(inputRoot, 'pdfs'), { recursive: true });
  const ocrScript = path.join(root, 'fake-ocr.py');
  await writeFile(ocrScript, '# fake OCR entrypoint\n');
  return { root, inputRoot, outputRoot, ocrScript };
}

function offloadOptions({ manifestPath, inputRoot, outputRoot, ocrScript, python = process.execPath, paddlexCacheHome }) {
  return {
    manifest: manifestPath,
    inputRoot,
    outputRoot,
    python,
    ocrScript,
    model: '/unused/model',
    mmproj: '/unused/mmproj',
    llamaRepo: '/unused/llama',
    llamaServerBin,
    llamaSystemdUnit,
    llamaUrl: workerConfiguration.llama_url,
    runtimeDevice,
    vlRecMaxConcurrency: 2,
    serverParallel: 2,
    microBatch: 4,
    useQueues: true,
    ...(paddlexCacheHome ? { paddlexCacheHome } : {}),
  };
}

async function createCompletedOutput(
  outputRoot,
  document,
  {
    citationEligible = false,
    worker = workerConfiguration,
    completedPageCount = document.page_count,
  } = {},
) {
  const documentRoot = path.join(outputRoot, 'documents', document.id);
  const pages = {};
  for (let pageNumber = 1; pageNumber <= completedPageCount; pageNumber += 1) {
    const pageRoot = path.join(documentRoot, 'pages', String(pageNumber).padStart(4, '0'));
    await mkdir(pageRoot, { recursive: true });
    const result = `${JSON.stringify({ page: pageNumber })}\n`;
    const markdown = `page ${pageNumber}\n`;
    await writeFile(path.join(pageRoot, 'result.json'), result);
    await writeFile(path.join(pageRoot, 'content.md'), markdown);
    pages[String(pageNumber)] = {
      status: 'ocr_complete_pending_audit',
      physical_pdf_page: pageNumber,
      rendered_image_sha256: String(pageNumber).padStart(64, '0'),
      result_json_sha256: sha256(result),
      content_markdown_sha256: sha256(markdown),
      citation_eligible: citationEligible,
    };
  }
  const selectedPages = Array.from({ length: document.page_count }, (_, index) => index + 1);
  const completedPages = Array.from({ length: completedPageCount }, (_, index) => index + 1);
  await writeFile(path.join(documentRoot, 'state.json'), `${JSON.stringify({
    schema_version: 1,
    document_id: document.id,
    source_sha256: document.source_sha256,
    page_count: document.page_count,
    configuration: {
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
    },
    completed_pages: completedPages,
    failed_pages: {},
    pages,
    selected_pages: selectedPages,
    selected_pages_complete: completedPageCount === document.page_count,
  }, null, 2)}\n`);
  return documentRoot;
}

async function createPartialOutput(outputRoot, document, { worker = workerConfiguration } = {}) {
  const documentRoot = await createCompletedOutput(outputRoot, document, { worker });
  const statePath = path.join(documentRoot, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.completed_pages = [1];
  state.failed_pages = { 2: { error: 'transient page failure' } };
  state.pages = { 1: state.pages['1'] };
  state.selected_pages_complete = false;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await rm(path.join(documentRoot, 'pages/0002'), { recursive: true, force: true });
  return {
    documentRoot,
    completedPageHash: sha256(await readFile(path.join(documentRoot, 'pages/0001/content.md'))),
  };
}

function nativePaddleResult(pageNumber) {
  return `${JSON.stringify({
    input_path: `/tmp/page-${String(pageNumber).padStart(4, '0')}.png`,
    page_index: null,
    page_count: null,
    width: 1600,
    height: 2200,
    model_settings: {
      use_doc_preprocessor: false,
      use_layout_detection: true,
    },
    parsing_res_list: [],
    layout_det_res: {
      input_path: null,
      page_index: null,
      boxes: [],
    },
  }, null, 2)}\n`;
}

async function addReceiverNativePageArtifacts(documentRoot, completedPages) {
  const statePath = path.join(documentRoot, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  for (let offset = 0; offset < completedPages.length; offset += 64) {
    await Promise.all(completedPages.slice(offset, offset + 64).map(async (pageNumber) => {
      const pageName = String(pageNumber).padStart(4, '0');
      const pageRoot = path.join(documentRoot, 'pages', pageName);
      const markdown = await readFile(path.join(pageRoot, 'content.md'));
      const result = nativePaddleResult(pageNumber);
      const markdownRoot = path.join(pageRoot, 'markdown');
      await mkdir(markdownRoot, { recursive: true });
      await Promise.all([
        writeFile(path.join(pageRoot, 'result.json'), result),
        writeFile(path.join(markdownRoot, `page-${pageName}.md`), markdown),
      ]);
      state.pages[String(pageNumber)].result_json_sha256 = sha256(result);
    }));
  }
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function completeSeededOutput(outputRoot, document) {
  const documentRoot = path.join(outputRoot, 'documents', document.id);
  const statePath = path.join(documentRoot, 'state.json');
  const [identity, receipt] = await Promise.all([
    readFile(path.join(outputRoot, 'run-identity.json'), 'utf8').then(JSON.parse),
    readFile(path.join(outputRoot, 'seed-receipt.json'), 'utf8').then(JSON.parse),
  ]);
  const receiptDocument = receipt.documents.find((item) => item.document_id === document.id);
  let state;
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const worker = identity.worker_configuration;
    state = {
      schema_version: 1,
      document_id: document.id,
      source_sha256: document.source_sha256,
      page_count: document.page_count,
      configuration: {
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
      },
      configuration_scope: 'active_writer_with_hash_bound_seed_exceptions',
      seed_lineage: {
        schema_version: 1,
        mode: 'hash_bound_output_seed',
        seed_id: receipt.seed_id,
        predecessor_run_identity_sha256: receipt.predecessor.run_identity_sha256,
        predecessor_configuration_sha256: receiptDocument.predecessor_configuration_sha256,
        inherited_completed_pages: [],
        citation_allowed: false,
      },
      completed_pages: [],
      failed_pages: {},
      pages: {},
      selected_pages: Array.from({ length: document.page_count }, (_, index) => index + 1),
      selected_pages_complete: false,
    };
  }
  const missingPages = [];
  for (let pageNumber = 1; pageNumber <= document.page_count; pageNumber += 1) {
    if (state.pages[String(pageNumber)]) continue;
    const result = nativePaddleResult(pageNumber);
    const markdown = `page ${pageNumber}\n`;
    state.pages[String(pageNumber)] = {
      status: 'ocr_complete_pending_audit',
      physical_pdf_page: pageNumber,
      rendered_image_sha256: String(pageNumber).padStart(64, '0'),
      result_json_sha256: sha256(result),
      content_markdown_sha256: sha256(markdown),
      citation_eligible: false,
    };
    missingPages.push({ pageNumber, result, markdown });
  }
  for (let offset = 0; offset < missingPages.length; offset += 64) {
    await Promise.all(missingPages.slice(offset, offset + 64).map(async ({
      pageNumber,
      result,
      markdown,
    }) => {
      const pageRoot = path.join(
        documentRoot,
        'pages',
        String(pageNumber).padStart(4, '0'),
      );
      const pageName = String(pageNumber).padStart(4, '0');
      const markdownRoot = path.join(pageRoot, 'markdown');
      await mkdir(markdownRoot, { recursive: true });
      await Promise.all([
        writeFile(path.join(pageRoot, 'result.json'), result),
        writeFile(path.join(pageRoot, 'content.md'), markdown),
        writeFile(path.join(markdownRoot, `page-${pageName}.md`), markdown),
      ]);
    }));
  }
  state.completed_pages = Array.from({ length: document.page_count }, (_, index) => index + 1);
  state.failed_pages = {};
  state.selected_pages = [...state.completed_pages];
  state.selected_pages_complete = true;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function writeJsonSidecar(pathname, value) {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(pathname, contents, { mode: 0o600 });
  await writeFile(
    `${pathname}.sha256`,
    `${sha256(contents)}  ${path.basename(pathname)}\n`,
    { mode: 0o600 },
  );
  return sha256(contents);
}

async function resealCommittedSeedReceipt(outputRoot, mutateReceipt) {
  const receiptPath = path.join(outputRoot, 'seed-receipt.json');
  const identityPath = path.join(outputRoot, 'run-identity.json');
  const markerPath = path.join(outputRoot, 'seed-commit.json');
  const [receipt, identity, marker] = await Promise.all([
    readFile(receiptPath, 'utf8').then(JSON.parse),
    readFile(identityPath, 'utf8').then(JSON.parse),
    readFile(markerPath, 'utf8').then(JSON.parse),
  ]);
  mutateReceipt(receipt);
  const receiptRaw = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  const receiptSha256 = sha256(receiptRaw);
  const receiptSidecarRaw = Buffer.from(`${receiptSha256}  seed-receipt.json\n`);
  identity.seed_lineage.seed_receipt_sha256 = receiptSha256;
  const identityRaw = Buffer.from(`${JSON.stringify(identity, null, 2)}\n`);
  marker.seed_receipt_sha256 = receiptSha256;
  marker.run_identity_sha256 = sha256(identityRaw);
  const replacements = new Map([
    ['seed-receipt.json', receiptRaw],
    ['seed-receipt.json.sha256', receiptSidecarRaw],
    ['run-identity.json', identityRaw],
  ]);
  for (const item of marker.installed_items) {
    const raw = replacements.get(item.name);
    if (raw) item.fingerprint = { sha256: sha256(raw), bytes: raw.byteLength };
  }
  marker.installed_items_sha256 = sha256(canonicalJson(marker.installed_items));
  await Promise.all([
    writeFile(receiptPath, receiptRaw, { mode: 0o600 }),
    writeFile(`${receiptPath}.sha256`, receiptSidecarRaw, { mode: 0o600 }),
    writeFile(identityPath, identityRaw, { mode: 0o600 }),
  ]);
  await writeJsonSidecar(markerPath, marker);
}

function recoveryPolicy(idleTimeoutSeconds) {
  return {
    max_attempts: 5,
    backoff_seconds: [2, 10, 30, 60],
    terminal_status: 'quarantined',
    terminal_exit_code: 12,
    child_monitoring: {
      startup_timeout_seconds: 180,
      idle_timeout_seconds: idleTimeoutSeconds,
      wall_floor_seconds: 1200,
      wall_seconds_per_page: 25,
      terminate_grace_seconds: 15,
      poll_interval_seconds: 5,
    },
  };
}

async function createTimeoutRecoveryLedger(ledgerRoot, predecessorInputRoot) {
  await mkdir(ledgerRoot, { recursive: true, mode: 0o700 });
  await chmod(ledgerRoot, 0o700);
  const ledgerInfo = await stat(ledgerRoot, { bigint: true });
  const resolvedInputRoot = await realpath(predecessorInputRoot);
  const resolvedLedgerRoot = await realpath(ledgerRoot);
  const nonceBasis = {
    schema_version: 1,
    authority_type: 'curriculum_remote_ocr_timeout_recovery_consumption_ledger',
    predecessor_input_root: resolvedInputRoot,
    ledger_root: resolvedLedgerRoot,
    ledger_device: String(ledgerInfo.dev),
    ledger_inode: String(ledgerInfo.ino),
    owner_uid: String(ledgerInfo.uid),
    owner_gid: String(ledgerInfo.gid),
    citation_allowed: false,
  };
  const identityBasis = {
    schema_version: 1,
    ledger_type: 'curriculum_remote_ocr_timeout_recovery_consumption_ledger',
    ledger_nonce: sha256(canonicalJson(nonceBasis)),
    citation_allowed: false,
  };
  const identity = {
    schema_version: identityBasis.schema_version,
    ledger_type: identityBasis.ledger_type,
    ledger_nonce: identityBasis.ledger_nonce,
    ledger_id: sha256(canonicalJson(identityBasis)),
    citation_allowed: false,
  };
  await writeJsonSidecar(path.join(ledgerRoot, 'ledger-identity.json'), identity);
  return identity;
}

async function createTimeoutRecoveryPredecessor({
  inputRoot,
  predecessorRoot,
  manifestPath,
  specifications,
  attestation,
  receiverNativeArtifacts = false,
  ocrScriptSha256 = '8'.repeat(64),
  materializePaddlexCache = false,
}) {
  const ledgerRoot = path.join(path.dirname(await realpath(inputRoot)), 'timeout-recovery-authority-v1');
  const ledgerIdentity = await createTimeoutRecoveryLedger(ledgerRoot, inputRoot);
  const [ledgerAuthorityRoot, ledgerInfo] = await Promise.all([
    realpath(ledgerRoot),
    stat(ledgerRoot, { bigint: true }),
  ]);
  await mkdir(path.join(predecessorRoot, 'documents'), { recursive: true });
  await mkdir(path.join(predecessorRoot, 'status'), { recursive: true });
  await mkdir(path.join(predecessorRoot, 'logs'), { recursive: true });
  const documents = [];
  for (const [id, pageCount] of specifications) {
    const source = `source:${id}`;
    const sourcePath = `pdfs/${id}.pdf`;
    await writeFile(path.join(inputRoot, sourcePath), source);
    documents.push(documentFor(id, sourcePath, source, pageCount));
  }
  const manifestContents = `${JSON.stringify(manifestFor(documents), null, 2)}\n`;
  await writeFile(manifestPath, manifestContents);
  const manifestSha256 = sha256(manifestContents);
  let fixturePaddlexLayoutModelCache = paddlexLayoutModelCache;
  if (materializePaddlexCache) {
    const modelRoot = path.join(
      predecessorRoot,
      'paddlex-cache/official_models/PP-DocLayoutV3',
    );
    await mkdir(modelRoot, { recursive: true });
    await Promise.all([
      writeFile(path.join(modelRoot, 'inference.json'), '{"fixture":true}\n'),
      writeFile(path.join(modelRoot, 'inference.pdiparams'), 'fixture-parameters\n'),
      writeFile(path.join(modelRoot, 'inference.yml'), 'fixture: true\n'),
    ]);
    fixturePaddlexLayoutModelCache = await fingerprintPaddlexLayoutModelCache(
      path.join(predecessorRoot, 'paddlex-cache'),
    );
  }
  const attestationSha256 = sha256(`${JSON.stringify(attestation)}\n`);
  const runtimeFingerprint = {
    ...runtime,
    runtime_device: runtimeDevice,
    llama_server_attestation_sha256: attestationSha256,
    python_runtime: pythonRuntime,
    paddlex_layout_model_cache: fixturePaddlexLayoutModelCache,
  };
  const runtimeFingerprintSha256 = sha256(`${JSON.stringify(runtimeFingerprint)}\n`);
  const predecessorWorker = {
    llama_url: workerConfiguration.llama_url,
    vl_rec_max_concurrency: 4,
    server_parallel: 4,
    micro_batch: 16,
    use_queues: true,
    runtime_device: runtimeDevice,
    paddlex_cache_home: path.join(predecessorRoot, 'paddlex-cache'),
    python_runtime: pythonRuntime,
    paddlex_layout_model_cache_sha256: fixturePaddlexLayoutModelCache.tree_sha256,
  };
  const predecessorRecovery = recoveryPolicy(300);
  const progressById = {};
  const grantDocuments = [];
  const incidentEvidence = [];
  for (const [id, pageCount, completedPageCount, status, attempts] of specifications) {
    const document = documents.find((item) => item.id === id);
    if (status === 'pending') {
      progressById[id] = { status, attempts, page_count: pageCount };
      continue;
    }
    const documentRoot = await createCompletedOutput(predecessorRoot, document, {
      worker: predecessorWorker,
      completedPageCount,
    });
    if (receiverNativeArtifacts) {
      await addReceiverNativePageArtifacts(
        documentRoot,
        Array.from({ length: completedPageCount }, (_, index) => index + 1),
      );
    }
    const statePath = path.join(documentRoot, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.failed_pages = {};
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const artifacts = await validateOcrDocumentOutput(document, documentRoot, runtime, {
      requireComplete: status === 'complete',
      workerConfiguration: predecessorWorker,
    });
    let statusRecord;
    if (status === 'complete') {
      statusRecord = {
        schema_version: 1,
        document_id: id,
        status,
        source_sha256: document.source_sha256,
        page_count: pageCount,
        runtime_fingerprint_sha256: runtimeFingerprintSha256,
        citation_allowed: false,
        whole_document_atomic: true,
        artifacts,
        verified_at: '2026-07-17T04:10:00.000Z',
      };
      progressById[id] = {
        status,
        attempts,
        page_count: pageCount,
        started_at: '2026-07-16T15:00:00.000Z',
        completed_at: statusRecord.verified_at,
        verified_at: statusRecord.verified_at,
      };
    } else if (status === 'retry_wait') {
      const failedAt = '2026-07-17T03:50:00.000Z';
      const retryDelaySeconds = recoveryPolicy(300).backoff_seconds[Math.max(0, attempts - 1)];
      const nextRetryAt = new Date(Date.parse(failedAt) + retryDelaySeconds * 1_000).toISOString();
      const error = `transient OCR failure on attempt ${attempts}`;
      statusRecord = {
        schema_version: 1,
        document_id: id,
        status,
        attempt: attempts,
        max_attempts: 5,
        retry_delay_seconds: retryDelaySeconds,
        next_retry_at: nextRetryAt,
        page_count: pageCount,
        runtime_fingerprint_sha256: runtimeFingerprintSha256,
        citation_allowed: false,
        error,
        failed_at: failedAt,
      };
      progressById[id] = {
        status,
        attempts,
        page_count: pageCount,
        next_retry_at: nextRetryAt,
        failed_at: failedAt,
        error,
      };
    } else if (status === 'interrupted') {
      statusRecord = {
        schema_version: 1,
        document_id: id,
        status,
        attempt: attempts,
        max_attempts: 5,
        citation_allowed: false,
        interrupted_at: '2026-07-17T04:05:00.000Z',
      };
      progressById[id] = {
        status,
        attempts,
        page_count: pageCount,
        interrupted_at: statusRecord.interrupted_at,
        signal: 'SIGTERM',
      };
    } else {
      assert.equal(status, 'quarantined', `unsupported timeout predecessor fixture status: ${status}`);
      const quarantinedAt = `2026-07-17T04:${String(grantDocuments.length).padStart(2, '0')}:00.000Z`;
      const error = `OCR child idle_timeout after ${305 + grantDocuments.length}s; terminated with SIGTERM`;
      statusRecord = {
        schema_version: 1,
        document_id: id,
        status: 'quarantined',
        attempt: 5,
        max_attempts: 5,
        page_count: pageCount,
        runtime_fingerprint_sha256: runtimeFingerprintSha256,
        citation_allowed: false,
        quarantine_reason: 'attempt_budget_exhausted',
        error,
        quarantined_at: quarantinedAt,
      };
      progressById[id] = {
        status: 'quarantined',
        attempts: 5,
        page_count: pageCount,
        started_at: '2026-07-17T03:00:00.000Z',
        failed_at: '2026-07-17T03:50:00.000Z',
        quarantined_at: quarantinedAt,
        quarantine_reason: 'attempt_budget_exhausted',
        error,
      };
    }
    const statusSha256 = await writeJsonSidecar(
      path.join(predecessorRoot, 'status', `${id}.json`),
      statusRecord,
    );
    progressById[id].status_json_sha256 = statusSha256;
    if (status === 'quarantined') {
      const logContents = Array.from(
        { length: 5 },
        (_, index) => `SignalInfo: *** SIGTERM attempt ${index + 1} for ${id}\n`,
      ).join('');
      const logPath = path.join(predecessorRoot, 'logs', `${id}.log`);
      await writeFile(logPath, logContents, { mode: 0o600 });
      const elapsedSeconds = Number(/after (\d+)s/u.exec(statusRecord.error)[1]);
      const detectedAtMilliseconds = Date.parse(statusRecord.quarantined_at);
      const incident = {
        schema_version: 1,
        incident_type: 'curriculum_remote_ocr_child_timeout_incident',
        evidence_origin: 'legacy_status_log_derivation_v1',
        document_id: id,
        attempt: 5,
        timeout_type: 'idle_timeout',
        child_started_at: new Date(detectedAtMilliseconds - elapsedSeconds * 1_000).toISOString(),
        detected_at: statusRecord.quarantined_at,
        recorded_at: statusRecord.quarantined_at,
        elapsed_seconds: elapsedSeconds,
        idle_seconds: elapsedSeconds,
        termination_signals: ['SIGTERM'],
        monitoring_policy: {
          ...predecessorRecovery.child_monitoring,
          wall_timeout_seconds: Math.max(
            predecessorRecovery.child_monitoring.wall_floor_seconds,
            predecessorRecovery.child_monitoring.wall_seconds_per_page * pageCount,
          ),
        },
        runtime_fingerprint_sha256: runtimeFingerprintSha256,
        log: {
          path: `logs/${id}.log`,
          bytes: Buffer.byteLength(logContents),
          sha256: sha256(logContents),
        },
        citation_allowed: false,
      };
      const incidentPath = path.join(
        predecessorRoot,
        'timeout-incidents',
        id,
        'attempt-0005.json',
      );
      await mkdir(path.dirname(incidentPath), { recursive: true, mode: 0o700 });
      await chmod(path.join(predecessorRoot, 'timeout-incidents'), 0o700);
      await chmod(path.dirname(incidentPath), 0o700);
      const incidentRawSha256 = await writeJsonSidecar(incidentPath, incident);
      incidentEvidence.push({
        document_id: id,
        attempt: 5,
        timeout_type: 'idle_timeout',
        raw_sha256: incidentRawSha256,
        sidecar_sha256: sha256(await readFile(`${incidentPath}.sha256`)),
        log_sha256: sha256(logContents),
      });
      grantDocuments.push({
        document_id: id,
        predecessor_status_sha256: statusSha256,
        predecessor_state_sha256: sha256(await readFile(statePath)),
        inherited_attempts: 5,
        granted_attempt: 6,
        first_missing_page: completedPageCount + 1,
        completed_pages_sha256: sha256(canonicalJson(state.completed_pages)),
        failed_pages_sha256: sha256(canonicalJson(state.failed_pages)),
        quarantine_reason: 'attempt_budget_exhausted',
        error_sha256: sha256(statusRecord.error),
        classification: 'child_idle_timeout_only',
        timeout_log: {
          path: `logs/${id}.log`,
          bytes: Buffer.byteLength(logContents),
          sha256: sha256(logContents),
        },
      });
    }
  }
  const predecessorIdentity = {
    schema_version: 1,
    manifest_sha256: manifestSha256,
    runtime,
    runtime_fingerprint: runtimeFingerprint,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    llama_server_attestation: attestation,
    llama_server_attestation_sha256: attestationSha256,
    runner_script_sha256: 'b08c3f7aa3da6e44dd9fffeecaf20b2a020df4d604c9b957399abaf886d15a55',
    ocr_script_sha256: ocrScriptSha256,
    input_root: await realpath(inputRoot),
    python_invocation_path: process.execPath,
    python_resolved_target: await realpath(process.execPath),
    worker_configuration: predecessorWorker,
    document_recovery: predecessorRecovery,
    whole_document_atomic: true,
    citation_allowed: false,
  };
  const identityContents = `${JSON.stringify(predecessorIdentity, null, 2)}\n`;
  await writeFile(path.join(predecessorRoot, 'run-identity.json'), identityContents);
  const counts = {
    total: specifications.length,
    complete: specifications.filter((specification) => specification[3] === 'complete').length,
    failed: 0,
    interrupted: specifications.filter((specification) => specification[3] === 'interrupted').length,
    pending: specifications.filter((specification) => specification[3] === 'pending').length,
    running: 0,
    retry_wait: specifications.filter((specification) => specification[3] === 'retry_wait').length,
    quarantined: grantDocuments.length,
  };
  const predecessorRunStatus = {
    schema_version: 1,
    manifest_sha256: manifestSha256,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    document_recovery: predecessorRecovery,
    citation_allowed: false,
    started_at: '2026-07-16T15:00:00.000Z',
    documents: progressById,
    counts,
    finished: counts.complete === counts.total,
    settled: counts.complete + counts.quarantined === counts.total,
  };
  const runStatusSha256 = await writeJsonSidecar(
    path.join(predecessorRoot, 'run-status.json'),
    predecessorRunStatus,
  );
  const grantBasis = {
    schema_version: 1,
    grant_type: 'curriculum_remote_ocr_timeout_recovery_grant',
    mode: 'one_additional_attempt_per_document',
    predecessor: {
      manifest_sha256: manifestSha256,
      run_identity_sha256: sha256(identityContents),
      run_status_sha256: runStatusSha256,
    },
    policy: {
      required_status: 'quarantined',
      required_inherited_attempts: 5,
      granted_attempt: 6,
      additional_attempts_per_document: 1,
      automatic_attempt_7: false,
      scope: 'all_timeout_quarantined_documents',
    },
    consumption: {
      ledger_id: ledgerIdentity.ledger_id,
      ledger_root: ledgerAuthorityRoot,
      ledger_device: String(ledgerInfo.dev),
      ledger_inode: String(ledgerInfo.ino),
      claim_mode: 'atomic_single_claim',
    },
    documents: grantDocuments,
    citation_allowed: false,
  };
  const grant = {
    schema_version: grantBasis.schema_version,
    grant_type: grantBasis.grant_type,
    mode: grantBasis.mode,
    grant_id: sha256(canonicalJson(grantBasis)),
    predecessor: grantBasis.predecessor,
    policy: grantBasis.policy,
    consumption: grantBasis.consumption,
    documents: grantBasis.documents,
    citation_allowed: false,
  };
  const predecessorClaimKey = sha256(canonicalJson({
    schema_version: 1,
    claim_key_type: 'curriculum_remote_ocr_timeout_recovery_predecessor_claim_key',
    predecessor: grant.predecessor,
    policy: grant.policy,
    documents: grant.documents,
    citation_allowed: false,
  }));
  const issuance = {
    schema_version: 1,
    claim_type: 'curriculum_remote_ocr_timeout_recovery_issuance_claim',
    claim_key: predecessorClaimKey,
    ledger_id: ledgerIdentity.ledger_id,
    predecessor: structuredClone(grant.predecessor),
    grant_id: grant.grant_id,
    grant_raw_sha256: sha256(`${JSON.stringify(grant, null, 2)}\n`),
    incident_evidence: incidentEvidence,
    citation_allowed: false,
  };
  await writeJsonSidecar(
    path.join(ledgerRoot, `${predecessorClaimKey}.issuance.json`),
    issuance,
  );
  return {
    documents,
    grant,
    manifestSha256,
    predecessorWorker,
    ledgerRoot,
    ledgerIdentity,
    issuance,
    paddlexLayoutModelCache: fixturePaddlexLayoutModelCache,
  };
}

async function writeTimeoutRecoveryGrant(predecessorRoot, grant) {
  return writeJsonSidecar(
    path.join(predecessorRoot, 'timeout-recovery-grant.json'),
    grant,
  );
}

test('manifest validation requires whole untouched documents and citation fail-closed gates', () => {
  const contents = 'source';
  const document = documentFor('doc-a', 'pdfs/a.pdf', contents);
  const manifest = manifestFor([document]);
  assert.equal(validateRemoteOcrManifest(manifest), manifest);

  const citationEnabled = structuredClone(manifest);
  citationEnabled.documents[0].citation_allowed = true;
  assert.throws(() => validateRemoteOcrManifest(citationEnabled), /citation_allowed must equal false/);

  const partial = structuredClone(manifest);
  partial.documents[0].required_page_range.last = 1;
  assert.throws(() => validateRemoteOcrManifest(partial), /not the whole document/);

  const touched = structuredClone(manifest);
  touched.documents[0].planning_snapshot.local_completed_pages = 1;
  assert.throws(() => validateRemoteOcrManifest(touched), /local_completed_pages must equal 0/);

  const wrongDpi = structuredClone(manifest);
  wrongDpi.runtime.render_dpi = 300;
  assert.throws(() => validateRemoteOcrManifest(wrongDpi), /render_dpi must equal 240/);
});

test('manifest validation accepts only hash-valid explicit local replacement snapshots', async (t) => {
  const { root } = await fixture(t);
  const contents = 'source';
  const document = documentFor('doc-reprocess', 'pdfs/reprocess.pdf', contents, 2);
  const documentRoot = path.join(root, 'local-production', document.id);
  const textPath = path.join(root, 'local-text', `${document.id}.txt`);
  await mkdir(path.join(documentRoot, 'pages/0001'), { recursive: true });
  await mkdir(path.dirname(textPath), { recursive: true });
  const result = '{"local":true}\n';
  const content = 'local partial\n';
  await writeFile(path.join(documentRoot, 'pages/0001/result.json'), result);
  await writeFile(path.join(documentRoot, 'pages/0001/content.md'), content);
  await writeFile(path.join(documentRoot, 'state.json'), `${JSON.stringify({
    schema_version: 1,
    document_id: document.id,
    source_sha256: document.source_sha256,
    page_count: document.page_count,
    completed_pages: [1],
    failed_pages: {},
    pages: {
      1: {
        status: 'ocr_complete_pending_audit',
        physical_pdf_page: 1,
        rendered_image_sha256: sha256('rendered'),
        result_json_sha256: sha256(result),
        content_markdown_sha256: sha256(content),
        citation_eligible: false,
      },
    },
  }, null, 2)}\n`);
  await writeFile(textPath, 'joined local text\n');
  document.planning_snapshot = await captureLocalReprocessSnapshot({
    document,
    documentRoot,
    textPath,
    documentRetries: {},
    pageRetries: {
      'doc-reprocess:2:paddle': { attempts: 1 },
    },
  });
  const manifest = manifestFor([document]);
  assert.equal(validateRemoteOcrManifest(manifest), manifest);
  const tampered = structuredClone(manifest);
  tampered.documents[0].planning_snapshot.text.bytes += 1;
  assert.throws(
    () => validateRemoteOcrManifest(tampered),
    /replacement snapshot SHA-256 is invalid/,
  );
});

test('document preflight enforces source containment, bytes, SHA-256, and page count', async (t) => {
  const { root, inputRoot } = await fixture(t);
  const contents = 'verified source';
  await writeFile(path.join(inputRoot, 'pdfs/a.pdf'), contents);
  const document = documentFor('doc-a', 'pdfs/a.pdf', contents, 7);
  const verified = await preflightDocument(document, {
    inputRoot,
    python: '/unused/python',
    pageCounter: () => 7,
  });
  assert.equal(verified.sourceSha256, document.source_sha256);
  assert.equal(verified.pageCount, 7);

  await writeFile(path.join(inputRoot, 'pdfs/a.pdf'), 'tampered');
  await assert.rejects(
    preflightDocument(document, { inputRoot, python: '/unused/python', pageCounter: () => 7 }),
    /source byte count differs|source SHA-256 differs/,
  );

  const outside = path.join(root, 'outside.pdf');
  await writeFile(outside, contents);
  await symlink(outside, path.join(inputRoot, 'pdfs/link.pdf'));
  const linked = documentFor('doc-link', 'pdfs/link.pdf', contents, 7);
  await assert.rejects(
    preflightDocument(linked, { inputRoot, python: '/unused/python', pageCounter: () => 7 }),
    /source symlink escapes input root/,
  );
});

test('runtime verification hashes the actual model files and reads the exact llama.cpp commit', async (t) => {
  const { root } = await fixture(t);
  const model = path.join(root, 'model.gguf');
  const mmproj = path.join(root, 'mmproj.gguf');
  const llamaRepo = path.join(root, 'llama.cpp');
  await writeFile(model, 'model');
  await writeFile(mmproj, 'mmproj');
  await mkdir(llamaRepo);
  for (const arguments_ of [
    ['init', llamaRepo],
    ['-C', llamaRepo, 'config', 'user.email', 'ocr-test@example.invalid'],
    ['-C', llamaRepo, 'config', 'user.name', 'OCR Test'],
  ]) {
    assert.equal(spawnSync('git', arguments_).status, 0);
  }
  await writeFile(path.join(llamaRepo, 'README.md'), 'fixture\n');
  assert.equal(spawnSync('git', ['-C', llamaRepo, 'add', 'README.md']).status, 0);
  assert.equal(spawnSync('git', ['-C', llamaRepo, 'commit', '-m', 'fixture']).status, 0);
  const commit = spawnSync('git', ['-C', llamaRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const expected = {
    ...runtime,
    model_sha256: sha256('model'),
    mmproj_sha256: sha256('mmproj'),
    llama_commit: commit,
  };
  assert.deepEqual(await verifyPinnedRuntime(expected, { model, mmproj, llamaRepo }), expected);
  await assert.rejects(
    verifyPinnedRuntime({ ...expected, model_sha256: '0'.repeat(64) }, { model, mmproj, llamaRepo }),
    /runtime fingerprint mismatch/,
  );
});

test('Python OCR runtime probe initializes PaddleOCR-VL and pins Python plus all package versions', () => {
  let invocation;
  const result = probePythonOcrRuntime('/venv/bin/python', {
    llamaUrl: workerConfiguration.llama_url,
    vlRecMaxConcurrency: workerConfiguration.vl_rec_max_concurrency,
    paddlexCacheHome: '/isolated/paddlex',
  }, {
    runCommand: (command, arguments_, options) => {
      invocation = { command, arguments_, options };
      return {
        status: 0,
        stdout: `Paddle initialization log\nREMOTE_OCR_RUNTIME_JSON=${JSON.stringify(pythonRuntime)}\n`,
        stderr: '',
      };
    },
  });
  assert.deepEqual(result, pythonRuntime);
  assert.equal(invocation.command, '/venv/bin/python');
  assert.match(invocation.arguments_[1], /from paddleocr import PaddleOCRVL/);
  assert.match(invocation.arguments_[1], /import pypdfium2/);
  assert.match(invocation.arguments_[1], /PaddleOCRVL\(/);
  assert.equal(invocation.arguments_[2], workerConfiguration.llama_url);
  assert.equal(invocation.options.env.PADDLE_PDX_CACHE_HOME, '/isolated/paddlex');

  assert.throws(
    () => probePythonOcrRuntime('/venv/bin/python', {
      llamaUrl: workerConfiguration.llama_url,
      vlRecMaxConcurrency: 1,
      paddlexCacheHome: '/isolated/paddlex',
    }, {
      runCommand: () => ({
        status: 0,
        stdout: `REMOTE_OCR_RUNTIME_JSON=${JSON.stringify({
          ...pythonRuntime,
          packages: { ...pythonRuntime.packages, pypdfium2: '' },
        })}\n`,
        stderr: '',
      }),
    }),
    /pypdfium2 has no version/,
  );
});

test('seed-only Python package probe is lightweight and never initializes PaddleOCR-VL', () => {
  let invocation;
  const result = probePythonPackageRuntime('/venv/bin/python', {
    paddlexCacheHome: '/isolated/paddlex',
  }, {
    runCommand: (command, arguments_, options) => {
      invocation = { command, arguments_, options };
      return {
        status: 0,
        stdout: `REMOTE_OCR_RUNTIME_JSON=${JSON.stringify(pythonRuntime)}\n`,
        stderr: '',
      };
    },
  });
  assert.deepEqual(result, pythonRuntime);
  assert.equal(invocation.command, '/venv/bin/python');
  assert.doesNotMatch(invocation.arguments_[1], /PaddleOCRVL|from paddleocr|import paddle|import paddlex/u);
  assert.match(invocation.arguments_[1], /importlib\.metadata/u);
  assert.equal(invocation.arguments_.length, 2);
  assert.equal(invocation.options.env.PADDLE_PDX_CACHE_HOME, '/isolated/paddlex');
  assert.equal(invocation.options.timeout, 60_000);
});

test('PaddleX layout cache fingerprint covers stable official model files and excludes locks or AppleDouble noise', async (t) => {
  const { root } = await fixture(t);
  const cacheRoot = path.join(root, 'paddlex');
  const modelRoot = path.join(cacheRoot, 'official_models/PP-DocLayoutV3');
  await mkdir(modelRoot, { recursive: true });
  await writeFile(path.join(modelRoot, 'inference.json'), 'json');
  await writeFile(path.join(modelRoot, 'inference.pdiparams'), 'weights');
  await writeFile(path.join(modelRoot, 'inference.yml'), 'yaml');
  await writeFile(path.join(modelRoot, 'README.md'), 'stable documentation');
  await writeFile(path.join(modelRoot, '._inference.json'), 'AppleDouble');
  await writeFile(path.join(modelRoot, '.cache'), 'cache noise');
  await mkdir(path.join(cacheRoot, 'official_models/locks'), { recursive: true });
  await writeFile(path.join(cacheRoot, 'official_models/locks/download.lock'), 'lock noise');

  const first = await fingerprintPaddlexLayoutModelCache(cacheRoot);
  assert.equal(first.model_name, 'PP-DocLayoutV3');
  assert.equal(first.relative_root, 'official_models');
  assert.equal(first.file_count, 4);
  await writeFile(path.join(modelRoot, '._inference.json'), 'changed AppleDouble');
  await writeFile(path.join(modelRoot, '.cache'), 'changed cache noise');
  assert.deepEqual(await fingerprintPaddlexLayoutModelCache(cacheRoot), first);
  await writeFile(path.join(modelRoot, 'inference.yml'), 'changed stable model metadata');
  assert.notEqual((await fingerprintPaddlexLayoutModelCache(cacheRoot)).tree_sha256, first.tree_sha256);
});

test('llama-server attestation binds the active systemd MainPID to the pinned binary, models, flags, and health', async (t) => {
  const { root } = await fixture(t);
  const llamaRepo = path.join(root, 'llama.cpp');
  const serverBinary = path.join(llamaRepo, 'build/bin/llama-server');
  const model = path.join(root, 'model.gguf');
  const mmproj = path.join(root, 'mmproj.gguf');
  await mkdir(path.dirname(serverBinary), { recursive: true });
  await writeFile(serverBinary, 'pinned llama server binary');
  await chmod(serverBinary, 0o755);
  await writeFile(model, 'model');
  await writeFile(mmproj, 'mmproj');
  const [resolvedServerBinary, resolvedModel, resolvedMmproj] = await Promise.all([
    realpath(serverBinary),
    realpath(model),
    realpath(mmproj),
  ]);

  const serverArguments = productionArgv(
    resolvedServerBinary,
    resolvedModel,
    resolvedMmproj,
    4,
  );
  const cmdline = Buffer.from(`${serverArguments.join('\0')}\0`);
  let currentMainPid = 4242;
  const runCommand = (command, arguments_) => {
    if (command === 'systemctl') {
      assert.deepEqual(arguments_, [
        '--user',
        'show',
        llamaSystemdUnit,
        '--property=ActiveState',
        '--property=SubState',
        '--property=MainPID',
      ]);
      return {
        status: 0,
        stdout: `SubState=running\nMainPID=${currentMainPid}\nActiveState=active\n`,
        stderr: '',
      };
    }
    assert.equal(command, resolvedServerBinary);
    assert.deepEqual(arguments_, ['--version']);
    return {
      status: 0,
      stdout: `version: 10015 (${runtime.llama_commit.slice(0, 8)})\n`,
      stderr: '',
    };
  };
  const options = {
    llamaRepo,
    llamaServerBin: serverBinary,
    llamaSystemdUnit,
    llamaUrl: 'http://127.0.0.1:8112/v1',
    model,
    mmproj,
    serverParallel: 4,
  };
  const dependencies = {
    runCommand,
    resolveProcExe: async (pid) => {
      assert.equal(pid, currentMainPid);
      return resolvedServerBinary;
    },
    readProcCmdline: async (pid) => {
      assert.equal(pid, currentMainPid);
      return cmdline;
    },
    healthProbe: async (healthUrl) => {
      assert.equal(healthUrl, 'http://127.0.0.1:8112/health');
      return {
        statusCode: 200,
        status: 'ok',
        bodySha256: sha256('{"status":"ok"}'),
      };
    },
  };

  const attestation = await verifyLlamaServerAttestation(runtime, options, dependencies);
  assert.equal(attestation.systemd_unit, llamaSystemdUnit);
  assert.equal(Object.hasOwn(attestation, 'main_pid'), false);
  assert.equal(attestation.binary_path, resolvedServerBinary);
  assert.equal(attestation.binary_sha256, sha256('pinned llama server binary'));
  assert.equal(attestation.proc_cmdline_sha256, sha256(cmdline));
  assert.equal(attestation.parallel, 4);
  assert.equal(attestation.health_status, 'ok');
  currentMainPid = 4343;
  assert.deepEqual(
    await verifyLlamaServerAttestation(runtime, options, dependencies),
    attestation,
    'a systemd restart with the same binary, models, command, and health must keep an identical immutable attestation',
  );
  const p1Arguments = productionArgv(
    resolvedServerBinary,
    resolvedModel,
    resolvedMmproj,
    1,
  );
  const p1Cmdline = Buffer.from(`${p1Arguments.join('\0')}\0`);
  const p1Attestation = await verifyLlamaServerAttestation(runtime, {
    ...options,
    serverParallel: 1,
  }, {
    ...dependencies,
    readProcCmdline: async () => p1Cmdline,
  });
  assert.equal(p1Attestation.parallel, 1);
  assert.equal(p1Attestation.proc_cmdline_sha256, sha256(p1Cmdline));
  assert.deepEqual(p1Attestation.production_command_contract, productionCommandContract(1));
  assert.equal(validateLlamaSystemdUnitName(llamaSystemdUnit), llamaSystemdUnit);
  assert.throws(
    () => validateLlamaSystemdUnitName('../../unsafe.service'),
    /safe explicit \.service unit name/,
  );
  await assert.rejects(
    verifyLlamaServerAttestation(runtime, options, {
      ...dependencies,
      resolveProcExe: async () => model,
    }),
    /MainPID executable mismatch/,
  );
  const wrongModelArguments = [...serverArguments];
  wrongModelArguments[wrongModelArguments.indexOf(resolvedModel)] = resolvedMmproj;
  await assert.rejects(
    verifyLlamaServerAttestation(runtime, options, {
      ...dependencies,
      readProcCmdline: async () => Buffer.from(`${wrongModelArguments.join('\0')}\0`),
    }),
    /exact ordered production command vector/,
  );
  const wrongParallelArguments = [...serverArguments];
  wrongParallelArguments[wrongParallelArguments.indexOf('4')] = '3';
  await assert.rejects(
    verifyLlamaServerAttestation(runtime, options, {
      ...dependencies,
      readProcCmdline: async () => Buffer.from(`${wrongParallelArguments.join('\0')}\0`),
    }),
    /exact ordered production command vector/,
  );
  const missingMetricsArguments = serverArguments.filter((argument) => argument !== '--metrics');
  await assert.rejects(
    verifyLlamaServerAttestation(runtime, options, {
      ...dependencies,
      readProcCmdline: async () => Buffer.from(`${missingMetricsArguments.join('\0')}\0`),
    }),
    /exact ordered production command vector/,
  );
  for (const invalidArguments of [
    [...serverArguments.slice(0, 1), '--model', ...serverArguments.slice(2)],
    [...serverArguments, '--verbose'],
    [serverArguments[0], ...serverArguments.slice(3, 5), ...serverArguments.slice(1, 3), ...serverArguments.slice(5)],
  ]) {
    await assert.rejects(
      verifyLlamaServerAttestation(runtime, options, {
        ...dependencies,
        readProcCmdline: async () => Buffer.from(`${invalidArguments.join('\0')}\0`),
      }),
      /exact ordered production command vector/,
    );
  }
});

test('complete output validation recalculates artifact hashes and rejects citation or tampering', async (t) => {
  const { outputRoot } = await fixture(t);
  const document = documentFor('doc-a', 'pdfs/a.pdf', 'source');
  const documentRoot = await createCompletedOutput(outputRoot, document);
  const artifacts = await validateOcrDocumentOutput(document, documentRoot, runtime, { workerConfiguration });
  assert.equal(artifacts.page_artifacts.length, 2);
  assert.match(artifacts.state_sha256, /^[a-f0-9]{64}$/);
  assert.ok(artifacts.page_artifacts.every((page) => page.citation_eligible === false));

  const statePath = path.join(documentRoot, 'state.json');
  const originalState = JSON.parse(await readFile(statePath, 'utf8'));
  for (const [key, value] of [
    ['recognizer_server_url', 'http://127.0.0.1:9999/v1'],
    ['vl_rec_max_concurrency', 3],
    ['server_parallel', 3],
    ['micro_batch', 8],
    ['use_queues', false],
    ['device', 'cpu+different runtime'],
  ]) {
    const tamperedState = structuredClone(originalState);
    tamperedState.configuration[key] = value;
    await writeFile(statePath, `${JSON.stringify(tamperedState)}\n`);
    await assert.rejects(
      validateOcrDocumentOutput(document, documentRoot, runtime, { workerConfiguration }),
      new RegExp(`OCR worker configuration mismatch for ${key}`),
    );
  }
  await writeFile(statePath, `${JSON.stringify(originalState, null, 2)}\n`);

  await writeFile(path.join(documentRoot, 'pages/0001/content.md'), 'tampered\n');
  await assert.rejects(
    validateOcrDocumentOutput(document, documentRoot, runtime, { workerConfiguration }),
    /artifact hash mismatch/,
  );

  const unsafeRoot = await createCompletedOutput(outputRoot, { ...document, id: 'doc-b' }, { citationEligible: true });
  await assert.rejects(
    validateOcrDocumentOutput({ ...document, id: 'doc-b' }, unsafeRoot, runtime, { workerConfiguration }),
    /not citation-fail-closed/,
  );
});

test('runner processes only manifest documents, resumes completed work, and pins restart identity', async (t) => {
  const { root, inputRoot, outputRoot, ocrScript } = await fixture(t);
  const venvPython = path.join(root, 'venv/bin/python');
  await mkdir(path.dirname(venvPython), { recursive: true });
  await symlink(process.execPath, venvPython);
  const source = 'manifest source';
  const rogueSource = 'not listed';
  await writeFile(path.join(inputRoot, 'pdfs/a.pdf'), source);
  await writeFile(path.join(inputRoot, 'pdfs/rogue.pdf'), rogueSource);
  const document = documentFor('doc-a', 'pdfs/a.pdf', source);
  const manifest = manifestFor([document]);
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  let invocations = 0;
  const invokeOcr = async (command, arguments_) => {
    invocations += 1;
    assert.equal(command, venvPython, 'OCR must invoke the lexical venv interpreter path, not its resolved target');
    assert.equal(arguments_[1], 'doc-a');
    assert.ok(!arguments_.includes('--pages'));
    assert.ok(!arguments_.includes('--limit'));
    assert.equal(arguments_[arguments_.indexOf('--runtime-device') + 1], runtimeDevice);
    await createCompletedOutput(outputRoot, document);
    return { code: 0, signal: null };
  };
  const options = {
    manifest: manifestPath,
    inputRoot,
    outputRoot,
    python: venvPython,
    ocrScript,
    model: '/unused/model',
    mmproj: '/unused/mmproj',
    llamaRepo: '/unused/llama',
    llamaServerBin,
    llamaSystemdUnit,
    llamaUrl: 'http://127.0.0.1:8112/v1',
    runtimeDevice,
    vlRecMaxConcurrency: 2,
    serverParallel: 2,
    microBatch: 4,
    useQueues: true,
  };
  const dependencies = {
    invokeOcr,
    pageCounter: (python) => {
      assert.equal(python, venvPython, 'page probe must invoke the lexical venv interpreter path');
      return 2;
    },
    runtime,
    llamaServerAttestation,
    pythonRuntime,
    paddlexLayoutModelCache,
    handleSignals: false,
  };
  const first = await runRemoteOcrOffload(options, dependencies);
  assert.equal(first.exitCode, 0);
  assert.equal(first.runStatus.documents['doc-a'].status, 'complete');
  assert.equal(invocations, 1);
  const identity = JSON.parse(await readFile(path.join(outputRoot, 'run-identity.json'), 'utf8'));
  assert.equal(identity.python_invocation_path, venvPython);
  assert.equal(identity.python_resolved_target, await realpath(process.execPath));
  assert.equal(
    identity.runner_script_sha256,
    sha256(await readFile(new URL('../scripts/run-remote-ocr-offload.mjs', import.meta.url))),
  );
  await assert.rejects(readFile(path.join(outputRoot, 'documents/rogue/state.json')), /ENOENT/);

  const second = await runRemoteOcrOffload(options, dependencies);
  assert.equal(second.exitCode, 0);
  assert.equal(invocations, 1, 'completed document must be hash-verified and skipped after restart');
  assert.match(await readFile(path.join(outputRoot, 'status/doc-a.json.sha256'), 'utf8'), /^[a-f0-9]{64}  doc-a\.json\n$/);
  assert.match(await readFile(path.join(outputRoot, 'run-status.json.sha256'), 'utf8'), /^[a-f0-9]{64}  run-status\.json\n$/);

  const validRunStatus = await readFile(path.join(outputRoot, 'run-status.json'), 'utf8');
  await writeFile(path.join(outputRoot, 'run-status.json'), '{broken');
  await assert.rejects(runRemoteOcrOffload(options, dependencies), /run status SHA-256 sidecar mismatch/);
  await writeFile(path.join(outputRoot, 'run-status.json'), validRunStatus);
  assert.equal((await runRemoteOcrOffload(options, dependencies)).exitCode, 0, 'fail-closed restart must release its task lock');
  assert.equal(invocations, 1);
  const validRunStatusSidecar = await readFile(path.join(outputRoot, 'run-status.json.sha256'), 'utf8');
  await writeFile(path.join(outputRoot, 'run-status.json.sha256'), `${'0'.repeat(64)}  run-status.json\n`);
  await assert.rejects(runRemoteOcrOffload(options, dependencies), /run status SHA-256 sidecar mismatch/);
  await writeFile(path.join(outputRoot, 'run-status.json.sha256'), validRunStatusSidecar);

  await assert.rejects(
    runRemoteOcrOffload({ ...options, serverParallel: 3 }, dependencies),
    /run identity differs/,
  );
  await assert.rejects(
    runRemoteOcrOffload(options, {
      ...dependencies,
      llamaServerAttestation: { ...llamaServerAttestation, proc_cmdline_sha256: '1'.repeat(64) },
    }),
    /run identity differs/,
  );
  await assert.rejects(
    runRemoteOcrOffload(options, {
      ...dependencies,
      pythonRuntime: { ...pythonRuntime, python_version: '3.13.6' },
    }),
    /run identity differs/,
  );
  await assert.rejects(
    runRemoteOcrOffload(options, {
      ...dependencies,
      paddlexLayoutModelCache: { ...paddlexLayoutModelCache, tree_sha256: '8'.repeat(64) },
    }),
    /run identity differs/,
  );
  await assert.rejects(
    runRemoteOcrOffload(options, {
      ...dependencies,
      runnerScriptSha256: '7'.repeat(64),
    }),
    /run identity differs/,
  );
});

test('hash-bound seed dry-run, commit, crash resume, attempt floor, and page provenance are fail-closed', async (t) => {
  const { root, inputRoot, ocrScript } = await fixture(t);
  const predecessorRoot = path.join(root, 'predecessor');
  const outputRoot = path.join(root, 'successor');
  const dryRunRoot = path.join(root, 'dry-run-successor');
  const resumedRoot = path.join(root, 'resumed-successor');
  await mkdir(predecessorRoot, { recursive: true });
  const source = 'seeded source';
  await writeFile(path.join(inputRoot, 'pdfs/a.pdf'), source);
  const document = documentFor('doc-seeded', 'pdfs/a.pdf', source, 2);
  const manifest = manifestFor([document]);
  const manifestPath = path.join(root, 'manifest.json');
  const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestPath, manifestContents);
  const manifestSha256 = sha256(manifestContents);
  const attestation = {
    ...llamaServerAttestation,
    parallel: 4,
    production_command_contract: {
      values: { '--host': '127.0.0.1', '--port': '8112', '--parallel': '4' },
      flags: ['--mmproj-offload'],
    },
  };
  const attestationSha256 = sha256(`${JSON.stringify(attestation)}\n`);
  const runtimeFingerprint = {
    ...runtime,
    runtime_device: runtimeDevice,
    llama_server_attestation_sha256: attestationSha256,
    python_runtime: pythonRuntime,
    paddlex_layout_model_cache: paddlexLayoutModelCache,
  };
  const runtimeFingerprintSha256 = sha256(`${JSON.stringify(runtimeFingerprint)}\n`);
  const predecessorWorker = {
    llama_url: workerConfiguration.llama_url,
    vl_rec_max_concurrency: 4,
    server_parallel: 4,
    micro_batch: 16,
    use_queues: true,
    runtime_device: runtimeDevice,
    paddlex_cache_home: path.join(predecessorRoot, 'paddlex-cache'),
    python_runtime: pythonRuntime,
    paddlex_layout_model_cache_sha256: paddlexLayoutModelCache.tree_sha256,
  };
  const predecessorRecovery = recoveryPolicy(300);
  const { documentRoot } = await createPartialOutput(predecessorRoot, document, { worker: predecessorWorker });
  const predecessorStatePath = path.join(documentRoot, 'state.json');
  const predecessorState = JSON.parse(await readFile(predecessorStatePath, 'utf8'));
  predecessorState.failed_pages = {};
  await writeFile(predecessorStatePath, `${JSON.stringify(predecessorState, null, 2)}\n`);
  const predecessorStatus = {
    schema_version: 1,
    document_id: document.id,
    status: 'retry_wait',
    attempt: 2,
    max_attempts: 5,
    retry_delay_seconds: 10,
    next_retry_at: '2026-07-16T00:00:10.000Z',
    page_count: document.page_count,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    citation_allowed: false,
    error: 'interrupted after inherited page',
    failed_at: '2026-07-16T00:00:00.000Z',
  };
  await mkdir(path.join(predecessorRoot, 'status'), { recursive: true });
  const predecessorStatusSha256 = await writeJsonSidecar(
    path.join(predecessorRoot, 'status', `${document.id}.json`),
    predecessorStatus,
  );
  const predecessorIdentity = {
    schema_version: 1,
    manifest_sha256: manifestSha256,
    runtime,
    runtime_fingerprint: runtimeFingerprint,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    llama_server_attestation: attestation,
    llama_server_attestation_sha256: attestationSha256,
    runner_script_sha256: 'b08c3f7aa3da6e44dd9fffeecaf20b2a020df4d604c9b957399abaf886d15a55',
    ocr_script_sha256: '8'.repeat(64),
    input_root: await realpath(inputRoot),
    python_invocation_path: process.execPath,
    python_resolved_target: await realpath(process.execPath),
    worker_configuration: predecessorWorker,
    document_recovery: predecessorRecovery,
    whole_document_atomic: true,
    citation_allowed: false,
  };
  await writeFile(
    path.join(predecessorRoot, 'run-identity.json'),
    `${JSON.stringify(predecessorIdentity, null, 2)}\n`,
  );
  const predecessorRunStatus = {
    schema_version: 1,
    manifest_sha256: manifestSha256,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    document_recovery: predecessorRecovery,
    citation_allowed: false,
    started_at: '2026-07-16T00:00:00.000Z',
    documents: {
      [document.id]: {
        status: 'retry_wait',
        attempts: 2,
        page_count: 2,
        next_retry_at: '2026-07-16T00:00:10.000Z',
        failed_at: '2026-07-16T00:00:00.000Z',
        error: 'interrupted after inherited page',
        status_json_sha256: predecessorStatusSha256,
      },
    },
    counts: {
      total: 1,
      complete: 0,
      failed: 0,
      interrupted: 0,
      pending: 0,
      running: 0,
      retry_wait: 1,
      quarantined: 0,
    },
    finished: false,
    settled: false,
  };
  await writeJsonSidecar(path.join(predecessorRoot, 'run-status.json'), predecessorRunStatus);
  const predecessorPageBefore = await stat(path.join(documentRoot, 'pages/0001/content.md'));
  const predecessorStateBefore = await readFile(predecessorStatePath);

  const optionsFor = (successorRoot, extra = {}) => ({
    manifest: manifestPath,
    inputRoot,
    outputRoot: successorRoot,
    python: process.execPath,
    ocrScript,
    model: '/unused/model',
    mmproj: '/unused/mmproj',
    llamaRepo: '/unused/llama',
    llamaServerBin,
    llamaSystemdUnit,
    llamaUrl: workerConfiguration.llama_url,
    runtimeDevice,
    vlRecMaxConcurrency: 1,
    serverParallel: 4,
    microBatch: 16,
    useQueues: true,
    childIdleTimeoutSeconds: 1200,
    seedFromOutputRoot: predecessorRoot,
    seedOnly: true,
    ...extra,
  });
  const dependencies = {
    pageCounter: () => 2,
    runtime,
    llamaServerAttestation: attestation,
    pythonRuntime,
    paddlexLayoutModelCache,
    handleSignals: false,
  };

  const dryRun = await runRemoteOcrOffload(
    optionsFor(dryRunRoot, { seedDryRun: true }),
    dependencies,
  );
  assert.equal(dryRun.seedDryRun, true);
  assert.equal(dryRun.seedReceipt.counts.inherited_pages, 1);
  await assert.rejects(readFile(path.join(dryRunRoot, 'seed-receipt.json')), /ENOENT/);
  await assert.rejects(readFile(path.join(dryRunRoot, 'seed-commit.json')), /ENOENT/);

  const seeded = await runRemoteOcrOffload(optionsFor(outputRoot), dependencies);
  assert.equal(seeded.seedOnly, true);
  assert.equal(seeded.runStatus.documents[document.id].attempts, 2);
  assert.equal(seeded.runStatus.documents[document.id].inherited_attempts, 2);
  assert.equal(seeded.runStatus.documents[document.id].predecessor_status, 'retry_wait');
  const state = JSON.parse(await readFile(path.join(outputRoot, 'documents', document.id, 'state.json'), 'utf8'));
  assert.equal(state.schema_version, 1);
  assert.equal(state.configuration.vl_rec_max_concurrency, 1);
  assert.equal(state.configuration.server_parallel, 4);
  assert.equal(state.configuration.micro_batch, 16);
  assert.equal(state.configuration_scope, 'active_writer_with_hash_bound_seed_exceptions');
  assert.deepEqual(state.seed_lineage.inherited_completed_pages, [1]);
  assert.equal(state.pages['1'].seed_provenance.seed_id, seeded.seedReceipt.seed_id);
  assert.equal(await readFile(predecessorStatePath).then((value) => value.equals(predecessorStateBefore)), true);
  const successorPage = await stat(path.join(outputRoot, 'documents', document.id, 'pages/0001/content.md'));
  assert.notEqual(successorPage.ino, predecessorPageBefore.ino, 'seeded page must be copied, never hard-linked');
  assert.match(await readFile(path.join(outputRoot, 'seed-receipt.json.sha256'), 'utf8'), /^[a-f0-9]{64}  seed-receipt\.json\n$/);
  assert.match(await readFile(path.join(outputRoot, 'seed-commit.json.sha256'), 'utf8'), /^[a-f0-9]{64}  seed-commit\.json\n$/);
  const seededEvidenceRoot = path.join(outputRoot, 'seed-predecessor-evidence');
  const seededEvidenceBefore = await inspectTree(seededEvidenceRoot);
  const markerReentry = await runRemoteOcrOffload(optionsFor(outputRoot), dependencies);
  assert.equal(markerReentry.seedReceiptSha256, seeded.seedReceiptSha256);
  assert.deepEqual(await inspectTree(seededEvidenceRoot), seededEvidenceBefore);
  const rawEvidencePath = path.join(seededEvidenceRoot, 'run-status.json');
  const rawEvidenceBefore = await readFile(rawEvidencePath);
  await writeFile(rawEvidencePath, Buffer.concat([rawEvidenceBefore, Buffer.from('tamper\n')]));
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(outputRoot), dependencies),
    /committed seed item seed-predecessor-evidence differs from the exact prepared receipt/,
  );
  await writeFile(rawEvidencePath, rawEvidenceBefore);
  assert.deepEqual(await inspectTree(seededEvidenceRoot), seededEvidenceBefore);

  let interrupted = false;
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(resumedRoot), {
      ...dependencies,
      beforeSeedInstallItem: async (_name, index) => {
        if (!interrupted && index === 3) {
          interrupted = true;
          throw new Error('synthetic seed install interruption');
        }
      },
    }),
    /synthetic seed install interruption/,
  );
  await assert.rejects(readFile(path.join(resumedRoot, 'seed-commit.json')), /ENOENT/);
  assert.match(await readFile(path.join(resumedRoot, '.seed-journal.json.sha256'), 'utf8'), /^[a-f0-9]{64}/);
  const interruptedJournal = JSON.parse(await readFile(path.join(resumedRoot, '.seed-journal.json'), 'utf8'));
  const journalEvidence = interruptedJournal.items.find(
    (item) => item.name === 'seed-predecessor-evidence',
  );
  assert.deepEqual(journalEvidence.fingerprint, seededEvidenceBefore);
  assert.deepEqual(
    await inspectTree(path.join(resumedRoot, 'seed-predecessor-evidence')),
    seededEvidenceBefore,
  );
  const resumed = await runRemoteOcrOffload(optionsFor(resumedRoot), dependencies);
  assert.equal(resumed.seedOnly, true);
  assert.equal(resumed.seedReceiptSha256, interruptedJournal.seed_receipt_sha256);
  assert.deepEqual(
    await inspectTree(path.join(resumedRoot, 'seed-predecessor-evidence')),
    seededEvidenceBefore,
  );

  const tamperedRunStatusPath = path.join(outputRoot, 'run-status.json');
  const tamperedRunStatus = JSON.parse(await readFile(tamperedRunStatusPath, 'utf8'));
  const loweredAttemptFloor = structuredClone(tamperedRunStatus);
  loweredAttemptFloor.documents[document.id].attempts = 1;
  loweredAttemptFloor.documents[document.id].inherited_attempts = 1;
  await writeJsonSidecar(tamperedRunStatusPath, loweredAttemptFloor);
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(outputRoot), dependencies),
    /attempt floor/,
  );
  const changedPredecessorStatus = structuredClone(tamperedRunStatus);
  changedPredecessorStatus.documents[document.id].predecessor_status = 'interrupted';
  await writeJsonSidecar(tamperedRunStatusPath, changedPredecessorStatus);
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(outputRoot), dependencies),
    /predecessor status/,
  );
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(path.join(root, 'bad-delta')), {
      ...dependencies,
      llamaServerAttestation: { ...attestation, proc_cmdline_sha256: '6'.repeat(64) },
    }),
    /runtime.*differs|attestation differs/,
  );
  const nestedSuccessor = path.join(predecessorRoot, 'nested-successor');
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(nestedSuccessor), dependencies),
    /disjoint and non-nested/,
  );
  await assert.rejects(stat(nestedSuccessor), /ENOENT/);
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(root), dependencies),
    /disjoint and non-nested/,
  );

  const cacheEscapeTarget = path.join(root, 'cache-escape-target');
  const cacheEscapeSuccessor = path.join(root, 'cache-escape-successor');
  await mkdir(cacheEscapeTarget);
  await mkdir(cacheEscapeSuccessor);
  await symlink(cacheEscapeTarget, path.join(cacheEscapeSuccessor, 'paddlex-cache'));
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(cacheEscapeSuccessor, {
      paddlexCacheHome: path.join(cacheEscapeSuccessor, 'paddlex-cache'),
    }), dependencies),
    /paddlex-cache-home must stay inside|PaddleX cache root must be a real directory|symbolic-link ancestor/,
  );

  const markerPath = path.join(resumedRoot, 'seed-commit.json');
  const realMarkerPath = path.join(resumedRoot, 'seed-commit-real.json');
  await rename(markerPath, realMarkerPath);
  await symlink(realMarkerPath, markerPath);
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(resumedRoot), dependencies),
    /seed commit marker must be a regular non-symlink file/,
  );

  const predecessorDocumentsRoot = path.join(predecessorRoot, 'documents');
  const escapedDocumentsRoot = path.join(root, 'escaped-predecessor-documents');
  await rename(predecessorDocumentsRoot, escapedDocumentsRoot);
  await symlink(escapedDocumentsRoot, predecessorDocumentsRoot);
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(path.join(root, 'documents-symlink-reject')), dependencies),
    /seed predecessor documents root must be a real directory/,
  );
  await rm(predecessorDocumentsRoot);
  await rename(escapedDocumentsRoot, predecessorDocumentsRoot);

  const predecessorStatusPath = path.join(predecessorRoot, 'status', `${document.id}.json`);
  const escapedStatusPath = path.join(root, 'escaped-predecessor-status.json');
  await rename(predecessorStatusPath, escapedStatusPath);
  await symlink(escapedStatusPath, predecessorStatusPath);
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(path.join(root, 'status-symlink-reject')), dependencies),
    /predecessor status must be a regular non-symlink file/,
  );
});

test('exact schema-v2 p4-to-p1 seeds preserve OCR identity and pass receiver and monitor delta validators', async (t) => {
  const { root, inputRoot, ocrScript } = await fixture(t);
  const predecessorAttestation = llamaAttestationForParallel(4);
  const successorAttestation = llamaAttestationForParallel(1);
  const ocrScriptSha256 = sha256(await readFile(ocrScript));
  const runnerScriptSha256 = 'e'.repeat(64);
  const seeds = [];

  for (const label of ['a', 'b']) {
    const predecessorRoot = path.join(root, `${label}-p4`);
    const successorRoot = path.join(root, `${label}-p1`);
    const manifestPath = path.join(inputRoot, `${label}-p4-p1.json`);
    const documentId = `doc-${label}-p4-p1`;
    await createTimeoutRecoveryPredecessor({
      inputRoot,
      predecessorRoot,
      manifestPath,
      specifications: [[documentId, 1, 1, 'complete', 1]],
      attestation: predecessorAttestation,
      receiverNativeArtifacts: true,
      ocrScriptSha256,
    });
    const options = {
      manifest: manifestPath,
      inputRoot,
      outputRoot: successorRoot,
      python: process.execPath,
      ocrScript,
      model: '/unused/model',
      mmproj: '/unused/mmproj',
      llamaRepo: '/unused/llama',
      llamaServerBin,
      llamaSystemdUnit,
      llamaUrl: workerConfiguration.llama_url,
      runtimeDevice,
      vlRecMaxConcurrency: 1,
      serverParallel: 1,
      microBatch: 16,
      useQueues: true,
      childIdleTimeoutSeconds: 1200,
      seedFromOutputRoot: predecessorRoot,
      seedOnly: true,
    };
    const seedDependencies = {
      pageCounter: () => 1,
      runtime,
      llamaServerAttestation: successorAttestation,
      pythonRuntime,
      paddlexLayoutModelCache,
      runnerScriptSha256,
      nowMilliseconds: () => Date.parse('2026-07-18T06:00:00.000Z'),
      handleSignals: false,
    };
    const result = await runRemoteOcrOffload(options, seedDependencies);
    const [predecessorIdentity, successorIdentity] = await Promise.all([
      readFile(path.join(predecessorRoot, 'run-identity.json'), 'utf8').then(JSON.parse),
      readFile(path.join(successorRoot, 'run-identity.json'), 'utf8').then(JSON.parse),
    ]);
    assert.equal(predecessorIdentity.ocr_script_sha256, ocrScriptSha256);
    assert.equal(successorIdentity.ocr_script_sha256, ocrScriptSha256);
    assert.equal(result.seedReceipt.allowed_configuration_delta.schema_version, 2);
    assert.equal(result.seedReceipt.allowed_configuration_delta.transition, 'p4_to_p1_v1');
    assert.equal(Object.hasOwn(result.seedReceipt, 'timeout_recovery_issuance'), false);
    await assert.rejects(
      stat(path.join(successorRoot, 'timeout-recovery-issuance')),
      { code: 'ENOENT' },
    );
    assert.equal(
      validateP4ToP1SeedDelta(result.seedReceipt, predecessorIdentity, successorIdentity),
      'p4_to_p1_v1',
    );
    assert.equal(
      validateP4ToP1MonitorDelta(result.seedReceipt, predecessorIdentity, successorIdentity),
      'p4_to_p1_v1',
    );
    await rm(predecessorRoot, { recursive: true });
    const resumed = await runRemoteOcrOffload(options, seedDependencies);
    assert.equal(resumed.seedReceipt.seed_id, result.seedReceipt.seed_id);
    seeds.push({ result, successorIdentity });
  }

  assert.equal(
    seeds[0].successorIdentity.runtime_fingerprint_sha256,
    seeds[1].successorIdentity.runtime_fingerprint_sha256,
  );
  assert.deepEqual(
    seeds[0].successorIdentity.runtime_fingerprint,
    seeds[1].successorIdentity.runtime_fingerprint,
  );
  assert.equal(
    seeds[0].result.seedReceipt.successor.runtime_fingerprint_sha256,
    seeds[1].result.seedReceipt.successor.runtime_fingerprint_sha256,
  );
});

test('schema-v3 seed revalidates the active seed-aware writer before committing any successor state', async (t) => {
  const { root, inputRoot } = await fixture(t);
  const predecessorRoot = path.join(root, 'seed-aware-drift-p4');
  const successorRoot = path.join(root, 'seed-aware-drift-p1');
  const manifestPath = path.join(inputRoot, 'seed-aware-drift.json');
  const sourceWriter = fileURLToPath(new URL('../scripts/ocr-pdf-paddle.py', import.meta.url));
  const ocrScript = path.join(root, 'seed-aware-ocr.py');
  await writeFile(ocrScript, await readFile(sourceWriter));
  assert.equal(sha256(await readFile(ocrScript)), seedAwareOcrScriptSha256);
  const predecessorAttestation = llamaAttestationForParallel(4);
  const successorAttestation = llamaAttestationForParallel(1);
  const { paddlexLayoutModelCache: fixtureCache } = await createTimeoutRecoveryPredecessor({
    inputRoot,
    predecessorRoot,
    manifestPath,
    specifications: [['doc-seed-aware-drift', 1, 1, 'complete', 1]],
    attestation: predecessorAttestation,
    receiverNativeArtifacts: true,
    ocrScriptSha256: legacyB1OcrScriptSha256,
    materializePaddlexCache: true,
  });
  const dependencies = {
    pageCounter: () => 1,
    runtime,
    llamaServerAttestation: successorAttestation,
    paddlexLayoutModelCache: fixtureCache,
    runnerScriptSha256: 'e'.repeat(64),
    handleSignals: false,
  };
  const optionsFor = (candidateRoot, candidateOcrScript = ocrScript) => ({
    manifest: manifestPath,
    inputRoot,
    outputRoot: candidateRoot,
    python: process.execPath,
    ocrScript: candidateOcrScript,
    model: '/unused/model',
    mmproj: '/unused/mmproj',
    llamaRepo: '/unused/llama',
    llamaServerBin,
    llamaSystemdUnit,
    llamaUrl: workerConfiguration.llama_url,
    runtimeDevice,
    vlRecMaxConcurrency: 1,
    serverParallel: 1,
    microBatch: 16,
    useQueues: true,
    childIdleTimeoutSeconds: 1200,
    seedFromOutputRoot: predecessorRoot,
    seedOnly: true,
  });
  const unsupportedOcrScript = path.join(root, 'unsupported-ocr.py');
  await writeFile(unsupportedOcrScript, '# unsupported OCR writer\n');
  const unsupportedRoot = path.join(root, 'unsupported-ocr-successor');
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(unsupportedRoot, unsupportedOcrScript), {
      ...dependencies,
      pythonRuntime,
    }),
    /not the exact audited B1-to-seed-aware transition/,
  );
  for (const forbidden of ['seed-commit.json', 'seed-receipt.json', 'run-identity.json', 'run-status.json']) {
    await assert.rejects(stat(path.join(unsupportedRoot, forbidden)), { code: 'ENOENT' });
  }
  Object.defineProperty(dependencies, 'pythonRuntime', {
    configurable: false,
    enumerable: true,
    get() {
      writeFileSync(ocrScript, '# drifted after initial writer hash\n');
      return pythonRuntime;
    },
  });
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(successorRoot), dependencies),
    /OCR script SHA-256 drifted/,
  );
  for (const forbidden of ['seed-commit.json', 'seed-receipt.json', 'run-identity.json', 'run-status.json']) {
    await assert.rejects(stat(path.join(successorRoot, forbidden)), { code: 'ENOENT' });
  }
});

test('schema-v2 timeout seed verifies and archives canonical issuance plus structured incident before one claim', async (t) => {
  const { root, inputRoot, ocrScript } = await fixture(t);
  const predecessorRoot = path.join(root, 'timeout-p4');
  const manifestPath = path.join(inputRoot, 'timeout-p4-p1.json');
  const predecessorAttestation = llamaAttestationForParallel(4);
  const successorAttestation = llamaAttestationForParallel(1);
  const ocrScriptSha256 = sha256(await readFile(ocrScript));
  const {
    documents,
    grant,
    ledgerRoot,
    issuance,
  } = await createTimeoutRecoveryPredecessor({
    inputRoot,
    predecessorRoot,
    manifestPath,
    specifications: [['doc-timeout-p4-p1', 2, 1, 'quarantined', 5]],
    attestation: predecessorAttestation,
    receiverNativeArtifacts: true,
    ocrScriptSha256,
  });
  await writeTimeoutRecoveryGrant(predecessorRoot, grant);
  const issuancePath = path.join(ledgerRoot, `${issuance.claim_key}.issuance.json`);
  const optionsFor = (outputRoot, extra = {}) => ({
    manifest: manifestPath,
    inputRoot,
    outputRoot,
    python: process.execPath,
    ocrScript,
    model: '/unused/model',
    mmproj: '/unused/mmproj',
    llamaRepo: '/unused/llama',
    llamaServerBin,
    llamaSystemdUnit,
    llamaUrl: workerConfiguration.llama_url,
    runtimeDevice,
    vlRecMaxConcurrency: 1,
    serverParallel: 1,
    microBatch: 16,
    useQueues: true,
    childIdleTimeoutSeconds: 1200,
    seedFromOutputRoot: predecessorRoot,
    timeoutRecoveryLedger: ledgerRoot,
    seedOnly: true,
    ...extra,
  });
  const dependencies = {
    pageCounter: () => documents[0].page_count,
    runtime,
    llamaServerAttestation: successorAttestation,
    pythonRuntime,
    paddlexLayoutModelCache,
    runnerScriptSha256: 'e'.repeat(64),
    nowMilliseconds: () => Date.parse('2026-07-18T06:00:00.000Z'),
    handleSignals: false,
  };

  const rejectedRoot = path.join(root, 'missing-issuance-p1');
  const [issuanceRaw, issuanceSealRaw] = await Promise.all([
    readFile(issuancePath),
    readFile(`${issuancePath}.sha256`),
  ]);
  await Promise.all([rm(issuancePath), rm(`${issuancePath}.sha256`)]);
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(rejectedRoot), dependencies),
    /timeout recovery issuance claim is missing/u,
  );
  for (const forbidden of [
    'run-identity.json',
    'seed-receipt.json',
    'timeout-recovery-grant.json',
  ]) {
    await assert.rejects(stat(path.join(rejectedRoot, forbidden)), { code: 'ENOENT' });
  }
  await writeFile(issuancePath, issuanceRaw, { mode: 0o600 });
  await writeFile(`${issuancePath}.sha256`, issuanceSealRaw, { mode: 0o600 });

  const tamperedIssuance = { ...issuance, grant_raw_sha256: 'f'.repeat(64) };
  await writeJsonSidecar(issuancePath, tamperedIssuance);
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(path.join(root, 'tampered-issuance-p1')), dependencies),
    /issuance claim differs from the exact predecessor, grant, and incident evidence/u,
  );
  await writeFile(issuancePath, issuanceRaw, { mode: 0o600 });
  await writeFile(`${issuancePath}.sha256`, issuanceSealRaw, { mode: 0o600 });

  const predecessorBeforeDryRun = await inspectTree(predecessorRoot);
  const authorityBeforeDryRun = await inspectTree(ledgerRoot);
  const dryRunRoot = path.join(root, 'timeout-p1-dry-run');
  const dryRun = await runRemoteOcrOffload(
    optionsFor(dryRunRoot, { seedDryRun: true }),
    dependencies,
  );
  assert.equal(dryRun.seedDryRun, true);
  assert.deepEqual(await inspectTree(predecessorRoot), predecessorBeforeDryRun);
  assert.deepEqual(await inspectTree(ledgerRoot), authorityBeforeDryRun);
  assert.equal(
    (await readdir(dryRunRoot)).some((entry) => entry.startsWith('.seed-stage-')),
    false,
  );

  const successorCandidates = [
    path.join(root, 'timeout-p1-left'),
    path.join(root, 'timeout-p1-right'),
  ];
  const concurrentSeeds = await Promise.allSettled(
    successorCandidates.map((candidate) => runRemoteOcrOffload(optionsFor(candidate), dependencies)),
  );
  assert.equal(concurrentSeeds.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(concurrentSeeds.filter((result) => result.status === 'rejected').length, 1);
  assert.match(
    concurrentSeeds.find((result) => result.status === 'rejected').reason.message,
    /already consumed by a different successor/u,
  );
  const winnerIndex = concurrentSeeds.findIndex((result) => result.status === 'fulfilled');
  const successorRoot = successorCandidates[winnerIndex];
  const seeded = concurrentSeeds[winnerIndex].value;
  const predecessorIdentity = JSON.parse(await readFile(
    path.join(predecessorRoot, 'run-identity.json'),
    'utf8',
  ));
  const successorIdentity = JSON.parse(await readFile(
    path.join(successorRoot, 'run-identity.json'),
    'utf8',
  ));
  assert.equal(
    validateP4ToP1SeedDelta(seeded.seedReceipt, predecessorIdentity, successorIdentity),
    'p4_to_p1_v1',
  );
  assert.equal(
    validateP4ToP1MonitorDelta(seeded.seedReceipt, predecessorIdentity, successorIdentity),
    'p4_to_p1_v1',
  );
  assert.equal(seeded.seedReceipt.timeout_recovery_issuance.claim_key, issuance.claim_key);
  const incidentSummary = seeded.seedReceipt.documents[0].timeout_recovery.predecessor_incident;
  assert.equal(incidentSummary.document_id, 'doc-timeout-p4-p1');
  assert.equal(incidentSummary.attempt, 5);
  assert.equal(incidentSummary.timeout_type, 'idle_timeout');
  assert.equal(incidentSummary.log_sha256, grant.documents[0].timeout_log.sha256);
  assert.deepEqual(
    await readFile(path.join(successorRoot, seeded.seedReceipt.timeout_recovery_issuance.path)),
    issuanceRaw,
  );
  const archivedIncidentPath = path.join(successorRoot, incidentSummary.path);
  assert.equal(sha256(await readFile(archivedIncidentPath)), incidentSummary.raw_sha256);
  assert.equal(
    sha256(await readFile(`${archivedIncidentPath}.sha256`)),
    incidentSummary.sidecar_sha256,
  );
  const inventory = JSON.parse(await readFile(
    path.join(successorRoot, 'seed-predecessor-evidence/inventory.json'),
    'utf8',
  ));
  assert.equal(inventory.documents[0].timeout_incident.raw.sha256, incidentSummary.raw_sha256);
  const claimFiles = (await readdir(ledgerRoot)).filter((entry) => entry.endsWith('.claim.json'));
  assert.equal(claimFiles.length, 1);
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(path.join(root, 'timeout-p1-replay')), dependencies),
    /already consumed by a different successor/u,
  );

  const committedReceiptPath = path.join(successorRoot, 'seed-receipt.json');
  const committedReceiptRaw = await readFile(committedReceiptPath);
  await writeFile(committedReceiptPath, '{', { mode: 0o600 });
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(successorRoot), dependencies),
    /committed seed receipt is not valid JSON/u,
  );
  await writeFile(committedReceiptPath, committedReceiptRaw, { mode: 0o600 });

  await rm(ledgerRoot, { recursive: true });
  await rm(predecessorRoot, { recursive: true });
  const resumed = await runRemoteOcrOffload(optionsFor(successorRoot), dependencies);
  assert.equal(resumed.seedOnly, true);
  assert.equal(resumed.seedReceipt.seed_id, seeded.seedReceipt.seed_id);
  assert.equal(resumed.seedReceipt.timeout_recovery_issuance.claim_key, issuance.claim_key);

  const copiedSuccessorRoot = path.join(root, 'timeout-p1-copy');
  await cp(successorRoot, copiedSuccessorRoot, { recursive: true, preserveTimestamps: true });
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(copiedSuccessorRoot), dependencies),
    /active successor field worker_configuration|different successor root or inode/u,
  );
});

test('real B-r1 six-state 1259-page seed is runner-to-receiver compatible and predecessor-immutable', async (t) => {
  const { root, inputRoot, ocrScript } = await fixture(t);
  const predecessorRoot = path.join(root, 'b-r1');
  const successorRoot = path.join(root, 'b-r2');
  await mkdir(path.join(predecessorRoot, 'documents'), { recursive: true });
  await mkdir(path.join(predecessorRoot, 'status'), { recursive: true });
  const modelRoot = path.join(
    predecessorRoot,
    'paddlex-cache/official_models/PP-DocLayoutV3',
  );
  await mkdir(modelRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(modelRoot, 'inference.json'), '{"fixture":true}\n'),
    writeFile(path.join(modelRoot, 'inference.pdiparams'), 'fixture-parameters\n'),
    writeFile(path.join(modelRoot, 'inference.yml'), 'fixture: true\n'),
  ]);
  const fixturePaddlexLayoutModelCache = await fingerprintPaddlexLayoutModelCache(
    path.join(predecessorRoot, 'paddlex-cache'),
  );
  const specifications = [
    ['legacy-compendium-arts-labor', 491, 491, 'complete', 1],
    ['legacy-compendium-chemistry', 458, 384, 'retry_wait', 2],
    ['legacy-compendium-chinese', 568, 32, 'retry_wait', 1],
    ['legacy-compendium-history', 765, 352, 'interrupted', 1],
    ['legacy-compendium-physics', 477, 0, 'pending', 0],
    ['legacy-compendium-plans', 423, 0, 'pending', 0],
  ];
  const documents = [];
  for (const [id, pageCount] of specifications) {
    const source = `source:${id}`;
    const sourcePath = `pdfs/${id}.pdf`;
    await writeFile(path.join(inputRoot, sourcePath), source);
    documents.push(documentFor(id, sourcePath, source, pageCount));
  }
  const manifestPath = path.join(inputRoot, 'b-shard.json');
  const manifestContents = `${JSON.stringify(manifestFor(documents), null, 2)}\n`;
  await writeFile(manifestPath, manifestContents);
  const manifestSha256 = sha256(manifestContents);
  const attestation = {
    ...llamaServerAttestation,
    parallel: 4,
    production_command_contract: {
      values: { '--host': '127.0.0.1', '--port': '8112', '--parallel': '4' },
      flags: ['--mmproj-offload'],
    },
  };
  const attestationSha256 = sha256(`${JSON.stringify(attestation)}\n`);
  const runtimeFingerprint = {
    ...runtime,
    runtime_device: runtimeDevice,
    llama_server_attestation_sha256: attestationSha256,
    python_runtime: pythonRuntime,
    paddlex_layout_model_cache: fixturePaddlexLayoutModelCache,
  };
  const runtimeFingerprintSha256 = sha256(`${JSON.stringify(runtimeFingerprint)}\n`);
  const predecessorWorker = {
    llama_url: workerConfiguration.llama_url,
    vl_rec_max_concurrency: 4,
    server_parallel: 4,
    micro_batch: 16,
    use_queues: true,
    runtime_device: runtimeDevice,
    paddlex_cache_home: path.join(predecessorRoot, 'paddlex-cache'),
    python_runtime: pythonRuntime,
    paddlex_layout_model_cache_sha256: fixturePaddlexLayoutModelCache.tree_sha256,
  };
  const predecessorRecovery = recoveryPolicy(300);
  const progressById = {};
  const statusHashes = new Map();
  for (const [id, pageCount, completedPageCount, status, attempts] of specifications) {
    const document = documents.find((item) => item.id === id);
    if (status === 'pending') {
      progressById[id] = { status, attempts, page_count: pageCount };
      continue;
    }
    const documentRoot = await createCompletedOutput(predecessorRoot, document, {
      worker: predecessorWorker,
      completedPageCount,
    });
    await addReceiverNativePageArtifacts(
      documentRoot,
      Array.from({ length: completedPageCount }, (_, index) => index + 1),
    );
    const artifacts = await validateOcrDocumentOutput(document, documentRoot, runtime, {
      requireComplete: status === 'complete',
      workerConfiguration: predecessorWorker,
    });
    let statusRecord;
    if (status === 'complete') {
      statusRecord = {
        schema_version: 1,
        document_id: id,
        status,
        source_sha256: document.source_sha256,
        page_count: pageCount,
        runtime_fingerprint_sha256: runtimeFingerprintSha256,
        citation_allowed: false,
        whole_document_atomic: true,
        artifacts,
        verified_at: '2026-07-17T00:00:00.000Z',
      };
      progressById[id] = {
        status,
        attempts,
        page_count: pageCount,
        verified_at: statusRecord.verified_at,
      };
    } else if (status === 'interrupted') {
      statusRecord = {
        schema_version: 1,
        document_id: id,
        status,
        attempt: attempts,
        max_attempts: 5,
        citation_allowed: false,
        interrupted_at: '2026-07-17T00:01:00.000Z',
      };
      progressById[id] = {
        status,
        attempts,
        page_count: pageCount,
        interrupted_at: statusRecord.interrupted_at,
        signal: 'SIGTERM',
      };
    } else {
      statusRecord = {
        schema_version: 1,
        document_id: id,
        status,
        attempt: attempts,
        max_attempts: 5,
        retry_delay_seconds: attempts === 1 ? 2 : 10,
        next_retry_at: '2026-07-17T00:02:00.000Z',
        page_count: pageCount,
        runtime_fingerprint_sha256: runtimeFingerprintSha256,
        citation_allowed: false,
        error: 'bounded synthetic retry',
        failed_at: '2026-07-17T00:01:30.000Z',
      };
      progressById[id] = {
        status,
        attempts,
        page_count: pageCount,
        next_retry_at: statusRecord.next_retry_at,
        error: statusRecord.error,
        failed_at: statusRecord.failed_at,
      };
    }
    statusHashes.set(
      id,
      await writeJsonSidecar(path.join(predecessorRoot, 'status', `${id}.json`), statusRecord),
    );
    progressById[id].status_json_sha256 = statusHashes.get(id);
  }
  const predecessorIdentity = {
    schema_version: 1,
    manifest_sha256: manifestSha256,
    runtime,
    runtime_fingerprint: runtimeFingerprint,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    llama_server_attestation: attestation,
    llama_server_attestation_sha256: attestationSha256,
    runner_script_sha256: 'b08c3f7aa3da6e44dd9fffeecaf20b2a020df4d604c9b957399abaf886d15a55',
    ocr_script_sha256: 'b4ea873026fb4d2da2efb921ddac3974a48db703143ff53aff3ebeae48d9b048',
    input_root: await realpath(inputRoot),
    python_invocation_path: process.execPath,
    python_resolved_target: await realpath(process.execPath),
    worker_configuration: predecessorWorker,
    document_recovery: predecessorRecovery,
    whole_document_atomic: true,
    citation_allowed: false,
  };
  await writeFile(
    path.join(predecessorRoot, 'run-identity.json'),
    `${JSON.stringify(predecessorIdentity, null, 2)}\n`,
  );
  const predecessorRunStatus = {
    schema_version: 1,
    manifest_sha256: manifestSha256,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    document_recovery: predecessorRecovery,
    citation_allowed: false,
    started_at: '2026-07-17T00:00:00.000Z',
    documents: progressById,
    counts: {
      total: 6,
      complete: 1,
      failed: 0,
      interrupted: 1,
      pending: 2,
      running: 0,
      retry_wait: 2,
      quarantined: 0,
    },
    finished: false,
    settled: false,
  };
  await writeJsonSidecar(path.join(predecessorRoot, 'run-status.json'), predecessorRunStatus);
  const predecessorBefore = await inspectTree(predecessorRoot);
  const artsBefore = await stat(path.join(
    predecessorRoot,
    'documents/legacy-compendium-arts-labor/pages/0001/content.md',
  ));
  const options = {
    manifest: manifestPath,
    inputRoot,
    outputRoot: successorRoot,
    python: process.execPath,
    ocrScript,
    model: '/unused/model',
    mmproj: '/unused/mmproj',
    llamaRepo: '/unused/llama',
    llamaServerBin,
    llamaSystemdUnit,
    llamaUrl: workerConfiguration.llama_url,
    runtimeDevice,
    vlRecMaxConcurrency: 1,
    serverParallel: 4,
    microBatch: 16,
    useQueues: true,
    childIdleTimeoutSeconds: 1200,
    seedFromOutputRoot: predecessorRoot,
    seedOnly: true,
  };
  const seeded = await runRemoteOcrOffload(options, {
    pageCounter: (_python, sourcePath) => documents.find(
      (document) => path.basename(document.source_path) === path.basename(sourcePath),
    ).page_count,
    runtime,
    llamaServerAttestation: attestation,
    pythonRuntime,
    paddlexLayoutModelCache: fixturePaddlexLayoutModelCache,
    runnerScriptSha256: 'e'.repeat(64),
    handleSignals: false,
  });
  await rm(path.join(successorRoot, 'paddlex-cache'), { recursive: true, force: true });
  await cp(
    path.join(predecessorRoot, 'paddlex-cache'),
    path.join(successorRoot, 'paddlex-cache'),
    { recursive: true },
  );
  assert.equal(seeded.seedOnly, true);
  assert.equal(seeded.seedReceipt.counts.documents, 6);
  assert.equal(seeded.seedReceipt.counts.inherited_pages, 1_259);
  assert.deepEqual(
    seeded.seedReceipt.documents.map((document) => [
      document.document_id,
      document.predecessor_status,
      document.predecessor_status_format,
      document.inherited_attempts,
      document.completed_pages.length,
    ]),
    [
      ['legacy-compendium-arts-labor', 'complete', 'legacy_b1_complete_reverified', 1, 491],
      ['legacy-compendium-chemistry', 'retry_wait', 'complete_identity_v1', 2, 384],
      ['legacy-compendium-chinese', 'retry_wait', 'complete_identity_v1', 1, 32],
      ['legacy-compendium-history', 'interrupted', 'legacy_b1_interrupted', 1, 352],
      ['legacy-compendium-physics', 'pending', 'pending_no_status', 0, 0],
      ['legacy-compendium-plans', 'pending', 'pending_no_status', 0, 0],
    ],
  );
  const predecessorEvidenceRoot = path.join(successorRoot, 'seed-predecessor-evidence');
  const predecessorEvidenceInventory = JSON.parse(await readFile(
    path.join(predecessorEvidenceRoot, 'inventory.json'),
    'utf8',
  ));
  assert.equal(predecessorEvidenceInventory.files.length, 15);
  assert.equal((await inspectTree(predecessorEvidenceRoot)).files, 16);
  assert.deepEqual(
    predecessorEvidenceInventory.documents.map((document) => [
      document.document_id,
      document.state.present,
      document.status.present,
    ]),
    specifications.map(([id, _pages, _completed, status]) => [
      id,
      status !== 'pending',
      status !== 'pending',
    ]),
  );
  for (const id of ['legacy-compendium-physics', 'legacy-compendium-plans']) {
    assert.equal(await stat(path.join(predecessorEvidenceRoot, 'documents', id)).then(
      () => true,
      (error) => error?.code === 'ENOENT' ? false : Promise.reject(error),
    ), false);
    assert.equal(await stat(path.join(predecessorEvidenceRoot, 'status', `${id}.json`)).then(
      () => true,
      (error) => error?.code === 'ENOENT' ? false : Promise.reject(error),
    ), false);
  }
  assert.deepEqual(await inspectTree(predecessorRoot), predecessorBefore);
  const artsAfter = await stat(path.join(
    successorRoot,
    'documents/legacy-compendium-arts-labor/pages/0001/content.md',
  ));
  assert.notEqual(artsAfter.ino, artsBefore.ino, 'runner-to-receiver fixture must not hard-link B-r1 pages');
  await assert.rejects(
    receiveRemoteOcrOffload({
      manifest: manifestPath,
      shards: [{ manifestPath, root: successorRoot }],
      projectRoot: inputRoot,
      productionRoot: path.join(inputRoot, 'local-production'),
      textRoot: path.join(inputRoot, 'local-text'),
      supervisorRoot: path.join(inputRoot, 'local-supervisor'),
      receiptRoot: path.join(inputRoot, 'receipts'),
      python: process.execPath,
    }, {
      pageCounter: () => assert.fail('unsettled seeded shard must fail before local source preflight'),
    }),
    /run status is not settled/,
  );
  let completedInvocations = 0;
  const completed = await runRemoteOcrOffload({ ...options, seedOnly: false }, {
    invokeOcr: async (_python, commandArguments) => {
      const document = documents.find((item) => item.id === commandArguments[1]);
      assert.ok(document, `unexpected OCR document ${commandArguments[1]}`);
      await completeSeededOutput(successorRoot, document);
      completedInvocations += 1;
      return { code: 0, signal: null };
    },
    pageCounter: (_python, sourcePath) => documents.find(
      (document) => path.basename(document.source_path) === path.basename(sourcePath),
    ).page_count,
    runtime,
    llamaServerAttestation: attestation,
    pythonRuntime,
    paddlexLayoutModelCache: fixturePaddlexLayoutModelCache,
    runnerScriptSha256: 'e'.repeat(64),
    nowMilliseconds: () => Date.parse('2026-07-18T00:00:00.000Z'),
    handleSignals: false,
  });
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.runStatus.finished, true);
  assert.equal(completedInvocations, 5);
  const received = await receiveRemoteOcrOffload({
    manifest: manifestPath,
    shards: [{ manifestPath, root: successorRoot }],
    projectRoot: inputRoot,
    productionRoot: path.join(inputRoot, 'local-production'),
    textRoot: path.join(inputRoot, 'local-text'),
    supervisorRoot: path.join(inputRoot, 'local-supervisor'),
    receiptRoot: path.join(inputRoot, 'receipts'),
    python: process.execPath,
  }, {
    pageCounter: (_python, sourcePath) => documents.find(
      (document) => path.basename(document.source_path) === path.basename(sourcePath),
    ).page_count,
  });
  assert.equal(received.status, 'dry_run_validated');
  assert.equal(received.counts.documents, 6);
  assert.equal(received.counts.pages, 3_182);
  assert.equal(received.source_shards[0].seed_id, seeded.seedReceipt.seed_id);
  assert.deepEqual(await inspectTree(predecessorRoot), predecessorBefore);
});

test('real B-r1 six-state 1259-page parallel1 schema-v3 seed resumes with immutable B1 provenance', async (t) => {
  const { root, inputRoot } = await fixture(t);
  const predecessorRoot = path.join(root, 'b-r1-schema-v3');
  const successorRoot = path.join(root, 'b-r2-schema-v3');
  const manifestPath = path.join(inputRoot, 'b-shard-schema-v3.json');
  const ocrScript = fileURLToPath(new URL('../scripts/ocr-pdf-paddle.py', import.meta.url));
  assert.equal(sha256(await readFile(ocrScript)), seedAwareOcrScriptSha256);
  const specifications = [
    ['legacy-compendium-arts-labor', 491, 491, 'complete', 1],
    ['legacy-compendium-chemistry', 458, 384, 'retry_wait', 2],
    ['legacy-compendium-chinese', 568, 32, 'retry_wait', 1],
    ['legacy-compendium-history', 765, 352, 'interrupted', 1],
    ['legacy-compendium-physics', 477, 0, 'pending', 0],
    ['legacy-compendium-plans', 423, 0, 'pending', 0],
  ];
  const predecessorAttestation = llamaAttestationForParallel(4);
  const successorAttestation = llamaAttestationForParallel(1);
  const {
    documents,
    paddlexLayoutModelCache: fixturePaddlexLayoutModelCache,
  } = await createTimeoutRecoveryPredecessor({
    inputRoot,
    predecessorRoot,
    manifestPath,
    specifications,
    attestation: predecessorAttestation,
    receiverNativeArtifacts: true,
    ocrScriptSha256: legacyB1OcrScriptSha256,
    materializePaddlexCache: true,
  });
  const predecessorBefore = await inspectTree(predecessorRoot);
  const options = {
    manifest: manifestPath,
    inputRoot,
    outputRoot: successorRoot,
    python: process.execPath,
    ocrScript,
    model: '/unused/model',
    mmproj: '/unused/mmproj',
    llamaRepo: '/unused/llama',
    llamaServerBin,
    llamaSystemdUnit,
    llamaUrl: workerConfiguration.llama_url,
    runtimeDevice,
    vlRecMaxConcurrency: 1,
    serverParallel: 1,
    microBatch: 16,
    useQueues: true,
    childIdleTimeoutSeconds: 1200,
    seedFromOutputRoot: predecessorRoot,
    seedOnly: true,
  };
  const dependencies = {
    pageCounter: (_python, sourcePath) => documents.find(
      (document) => path.basename(document.source_path) === path.basename(sourcePath),
    ).page_count,
    runtime,
    llamaServerAttestation: successorAttestation,
    pythonRuntime,
    paddlexLayoutModelCache: fixturePaddlexLayoutModelCache,
    runnerScriptSha256: 'e'.repeat(64),
    nowMilliseconds: () => Date.parse('2026-07-18T06:00:00.000Z'),
    handleSignals: false,
  };

  const seeded = await runRemoteOcrOffload(options, dependencies);
  const expectedOcrTransition = {
    schema_version: 1,
    transition: 'b1_legacy_to_seed_aware_v1',
    predecessor_sha256: legacyB1OcrScriptSha256,
    successor_sha256: seedAwareOcrScriptSha256,
    audited_common_inference_suffix_sha256: auditedCommonInferenceSuffixSha256,
  };
  assert.equal(seeded.seedOnly, true);
  assert.equal(seeded.seedReceipt.allowed_configuration_delta.schema_version, 3);
  assert.equal(seeded.seedReceipt.allowed_configuration_delta.transition, seedAwareTransition);
  assert.deepEqual(
    seeded.seedReceipt.allowed_configuration_delta.ocr_script_transition,
    expectedOcrTransition,
  );
  assert.equal(seeded.seedReceipt.counts.documents, 6);
  assert.equal(seeded.seedReceipt.counts.inherited_pages, 1_259);
  assert.deepEqual(
    seeded.seedReceipt.documents.map((document) => [
      document.document_id,
      document.predecessor_status,
      document.predecessor_status_format,
      document.inherited_attempts,
      document.completed_pages.length,
    ]),
    [
      ['legacy-compendium-arts-labor', 'complete', 'legacy_b1_complete_reverified', 1, 491],
      ['legacy-compendium-chemistry', 'retry_wait', 'complete_identity_v1', 2, 384],
      ['legacy-compendium-chinese', 'retry_wait', 'complete_identity_v1', 1, 32],
      ['legacy-compendium-history', 'interrupted', 'legacy_b1_interrupted', 1, 352],
      ['legacy-compendium-physics', 'pending', 'pending_no_status', 0, 0],
      ['legacy-compendium-plans', 'pending', 'pending_no_status', 0, 0],
    ],
  );
  const [predecessorIdentity, successorIdentity] = await Promise.all([
    readFile(path.join(predecessorRoot, 'run-identity.json'), 'utf8').then(JSON.parse),
    readFile(path.join(successorRoot, 'run-identity.json'), 'utf8').then(JSON.parse),
  ]);
  assert.equal(predecessorIdentity.ocr_script_sha256, legacyB1OcrScriptSha256);
  assert.equal(successorIdentity.ocr_script_sha256, seedAwareOcrScriptSha256);
  assert.equal(
    validateP4ToP1SeedDelta(seeded.seedReceipt, predecessorIdentity, successorIdentity),
    seedAwareTransition,
  );
  assert.equal(
    validateP4ToP1MonitorDelta(seeded.seedReceipt, predecessorIdentity, successorIdentity),
    seedAwareTransition,
  );
  assert.deepEqual(await inspectTree(predecessorRoot), predecessorBefore);

  const resumed = await runRemoteOcrOffload(options, dependencies);
  assert.equal(resumed.seedOnly, true);
  assert.equal(resumed.seedReceipt.seed_id, seeded.seedReceipt.seed_id);
  assert.equal(resumed.seedReceiptSha256, seeded.seedReceiptSha256);
  assert.equal(resumed.seedReceipt.counts.inherited_pages, 1_259);
  assert.deepEqual(
    resumed.seedReceipt.allowed_configuration_delta.ocr_script_transition,
    expectedOcrTransition,
  );
  assert.equal(resumed.seedReceipt.predecessor.ocr_script_sha256, legacyB1OcrScriptSha256);
  assert.equal(resumed.seedReceipt.successor.ocr_script_sha256, seedAwareOcrScriptSha256);
  assert.deepEqual(await inspectTree(predecessorRoot), predecessorBefore);
});

test('exact A-r1 timeout grant recovers attempt 6 and joins no-grant B-r2 as an exact 6364-page union', async (t) => {
  const { root, inputRoot } = await fixture(t);
  const ocrScript = fileURLToPath(new URL('../scripts/ocr-pdf-paddle.py', import.meta.url));
  const canonicalRoot = await realpath(root);
  const predecessorRoot = path.join(canonicalRoot, 'a-r1');
  const successorRoot = path.join(canonicalRoot, 'a-r2');
  const specifications = [
    ['moe-2011-01', 83, 83, 'complete', 1],
    ['moe-2022-03', 109, 109, 'complete', 1],
    ['legacy-compendium-biology', 462, 462, 'complete', 1],
    ['legacy-compendium-english', 649, 192, 'quarantined', 5],
    ['legacy-compendium-general-primary', 242, 242, 'complete', 5],
    ['legacy-compendium-geography', 518, 48, 'quarantined', 5],
    ['legacy-compendium-mathematics', 697, 336, 'quarantined', 5],
    ['legacy-compendium-politics', 422, 96, 'quarantined', 5],
  ];
  const manifestPath = path.join(inputRoot, 'a-shard.json');
  const predecessorAttestation = llamaAttestationForParallel(4);
  const successorAttestation = llamaAttestationForParallel(1);
  const ocrScriptSha256 = sha256(await readFile(ocrScript));
  assert.equal(ocrScriptSha256, seedAwareOcrScriptSha256);
  const {
    documents,
    grant,
    ledgerRoot,
    ledgerIdentity,
    paddlexLayoutModelCache: fixturePaddlexLayoutModelCache,
  } = await createTimeoutRecoveryPredecessor({
    inputRoot,
    predecessorRoot,
    manifestPath,
    specifications,
    attestation: predecessorAttestation,
    receiverNativeArtifacts: true,
    ocrScriptSha256: legacyB1OcrScriptSha256,
    materializePaddlexCache: true,
  });
  const provisioned = await provisionTimeoutRecoveryAuthority({
    inputRoot: await realpath(inputRoot),
    apply: true,
  });
  assert.equal(provisioned.authority_root, ledgerRoot);
  const optionsFor = (outputRoot, extra = {}) => ({
    manifest: manifestPath,
    inputRoot,
    outputRoot,
    python: process.execPath,
    ocrScript,
    model: '/unused/model',
    mmproj: '/unused/mmproj',
    llamaRepo: '/unused/llama',
    llamaServerBin,
    llamaSystemdUnit,
    llamaUrl: workerConfiguration.llama_url,
    runtimeDevice,
    vlRecMaxConcurrency: 1,
    serverParallel: 1,
    microBatch: 16,
    useQueues: true,
    childIdleTimeoutSeconds: 1200,
    seedFromOutputRoot: predecessorRoot,
    timeoutRecoveryLedger: ledgerRoot,
    seedOnly: true,
    ...extra,
  });
  const dependencies = {
    pageCounter: (_python, sourcePath) => documents.find(
      (document) => path.basename(document.source_path) === path.basename(sourcePath),
    ).page_count,
    runtime,
    llamaServerAttestation: successorAttestation,
    pythonRuntime,
    paddlexLayoutModelCache: fixturePaddlexLayoutModelCache,
    runnerScriptSha256: 'e'.repeat(64),
    nowMilliseconds: () => Date.parse('2026-07-18T06:00:00.000Z'),
    handleSignals: false,
  };
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(path.join(root, 'no-grant'), {
      timeoutRecoveryLedger: undefined,
    }), dependencies),
    /requires timeout-recovery-grant\.json/,
  );
  const preparedGrant = await prepareTimeoutRecoveryGrant({
    manifest: await realpath(manifestPath),
    predecessorRoot: await realpath(predecessorRoot),
    ledgerRoot: await realpath(ledgerRoot),
    apply: true,
  });
  assert.equal(preparedGrant.grant.grant_id, grant.grant_id);
  assert.equal(preparedGrant.grant.raw_sha256, sha256(await readFile(
    path.join(predecessorRoot, 'timeout-recovery-grant.json'),
  )));
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(path.join(root, 'missing-ledger'), {
      timeoutRecoveryLedger: undefined,
    }), dependencies),
    /requires --timeout-recovery-ledger/,
  );
  const wrongLedgerRoot = path.join(root, 'wrong-timeout-recovery-ledger');
  await createTimeoutRecoveryLedger(wrongLedgerRoot, inputRoot);
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(path.join(root, 'wrong-ledger'), {
      timeoutRecoveryLedger: wrongLedgerRoot,
    }), dependencies),
    /single canonical authority root|bound to a different consumption ledger/,
  );
  const clonedLedgerRoot = path.join(root, 'cloned-timeout-recovery-ledger');
  await mkdir(clonedLedgerRoot, { recursive: true });
  await writeJsonSidecar(
    path.join(clonedLedgerRoot, 'ledger-identity.json'),
    ledgerIdentity,
  );
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(path.join(root, 'cloned-ledger'), {
      timeoutRecoveryLedger: clonedLedgerRoot,
    }), dependencies),
    /single canonical authority root|bound to a different ledger authority/,
  );
  const predecessorBefore = await inspectTree(predecessorRoot);
  const seeded = await runRemoteOcrOffload(optionsFor(successorRoot), dependencies);
  await rm(path.join(successorRoot, 'paddlex-cache'), { recursive: true, force: true });
  await cp(
    path.join(predecessorRoot, 'paddlex-cache'),
    path.join(successorRoot, 'paddlex-cache'),
    { recursive: true },
  );
  assert.equal(seeded.seedOnly, true);
  assert.deepEqual(seeded.seedReceipt.allowed_configuration_delta.ocr_script_transition, {
    schema_version: 1,
    transition: 'b1_legacy_to_seed_aware_v1',
    predecessor_sha256: legacyB1OcrScriptSha256,
    successor_sha256: seedAwareOcrScriptSha256,
    audited_common_inference_suffix_sha256: auditedCommonInferenceSuffixSha256,
  });
  assert.equal(seeded.seedReceipt.allowed_configuration_delta.schema_version, 3);
  assert.equal(seeded.seedReceipt.allowed_configuration_delta.transition, seedAwareTransition);
  assert.equal(seeded.seedReceipt.counts.inherited_pages, 1_568);
  assert.equal(seeded.seedReceipt.counts.predecessor_complete_documents, 4);
  assert.equal(seeded.seedReceipt.counts.predecessor_quarantined_documents, 4);
  assert.equal(seeded.seedReceipt.counts.recovery_granted_documents, 4);
  assert.equal(seeded.seedReceipt.timeout_recovery_grant.grant_id, grant.grant_id);
  assert.equal(seeded.seedReceipt.timeout_recovery_consumption.ledger_id, ledgerIdentity.ledger_id);
  assert.match(seeded.seedReceipt.timeout_recovery_consumption.claim_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    seeded.seedReceipt.timeout_recovery_grant.documents.map(
      (document) => [document.document_id, document.first_missing_page],
    ),
    [
      ['legacy-compendium-english', 193],
      ['legacy-compendium-geography', 49],
      ['legacy-compendium-mathematics', 337],
      ['legacy-compendium-politics', 97],
    ],
  );
  const recoveryDocuments = seeded.seedReceipt.documents.filter((document) => document.timeout_recovery);
  assert.equal(recoveryDocuments.length, 4);
  for (const receiptDocument of recoveryDocuments) {
    const progress = seeded.runStatus.documents[receiptDocument.document_id];
    assert.equal(progress.status, 'retry_wait');
    assert.equal(progress.attempts, 5);
    assert.equal(progress.inherited_attempts, 5);
    assert.equal(progress.attempt_ceiling, 6);
    assert.equal(progress.timeout_recovery_grant_id, grant.grant_id);
    assert.equal(
      receiptDocument.timeout_recovery.predecessor_log.path,
      `seed-predecessor-evidence/logs/${receiptDocument.document_id}.log`,
    );
  }
  const marker = JSON.parse(await readFile(path.join(successorRoot, 'seed-commit.json'), 'utf8'));
  assert.deepEqual(marker.installed_items.map((item) => item.name), [
    'documents',
    'status',
    'seed-predecessor-evidence',
    'seed-receipt.json',
    'seed-receipt.json.sha256',
    'timeout-recovery-grant.json',
    'timeout-recovery-grant.json.sha256',
    'timeout-recovery-issuance',
    'timeout-recovery-ledger-identity.json',
    'timeout-recovery-ledger-identity.json.sha256',
    'timeout-recovery-consumption-claim.json',
    'timeout-recovery-consumption-claim.json.sha256',
    'run-identity.json',
    'run-status.json',
    'run-status.json.sha256',
  ]);
  assert.equal(
    await readFile(path.join(successorRoot, 'timeout-recovery-grant.json'), 'utf8'),
    await readFile(path.join(predecessorRoot, 'timeout-recovery-grant.json'), 'utf8'),
  );
  const evidenceInventory = JSON.parse(await readFile(
    path.join(successorRoot, 'seed-predecessor-evidence/inventory.json'),
    'utf8',
  ));
  assert.equal(evidenceInventory.documents.filter((document) => document.timeout_log).length, 4);
  assert.equal(evidenceInventory.documents.filter((document) => document.timeout_incident).length, 4);
  const monitoredPredecessor = await inspectPredecessorB1(predecessorRoot);
  const authorityNegativeProductionRoot = path.join(inputRoot, 'authority-negative-production');
  const authorityNegativeReceiptRoot = path.join(inputRoot, 'authority-negative-receipts');
  const authorityReceiveOptions = {
    manifest: manifestPath,
    shards: [{ manifestPath, root: successorRoot }],
    projectRoot: inputRoot,
    productionRoot: authorityNegativeProductionRoot,
    textRoot: path.join(inputRoot, 'authority-negative-text'),
    supervisorRoot: path.join(inputRoot, 'authority-negative-supervisor'),
    receiptRoot: authorityNegativeReceiptRoot,
    python: process.execPath,
  };
  const authorityReceiveDependencies = {
    pageCounter: (_python, sourcePath) => documents.find(
      (document) => path.basename(document.source_path) === path.basename(sourcePath),
    ).page_count,
  };
  const archivedIssuancePath = path.join(
    successorRoot,
    seeded.seedReceipt.timeout_recovery_issuance.path,
  );
  const archivedIssuanceSidecarPath = `${archivedIssuancePath}.sha256`;
  const [archivedIssuanceRaw, archivedIssuanceSidecarRaw] = await Promise.all([
    readFile(archivedIssuancePath),
    readFile(archivedIssuanceSidecarPath),
  ]);
  const issuanceValue = JSON.parse(archivedIssuanceRaw);
  const reorderedIssuance = Object.fromEntries(Object.entries(issuanceValue).reverse());
  const noncanonicalIssuanceRaw = Buffer.from(`${JSON.stringify(reorderedIssuance, null, 2)}\n`);
  await writeFile(archivedIssuancePath, noncanonicalIssuanceRaw, { mode: 0o600 });
  await writeFile(
    archivedIssuanceSidecarPath,
    `${sha256(noncanonicalIssuanceRaw)}  ${path.basename(archivedIssuancePath)}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    receiveRemoteOcrOffload(authorityReceiveOptions, authorityReceiveDependencies),
    /timeout recovery issuance claim field order is not canonical/u,
  );
  await assert.rejects(
    inspectSuccessorB2(successorRoot, monitoredPredecessor),
    /timeout recovery issuance claim field order is not canonical/u,
  );
  await writeFile(archivedIssuancePath, archivedIssuanceRaw, { mode: 0o600 });
  await writeFile(archivedIssuanceSidecarPath, archivedIssuanceSidecarRaw, { mode: 0o600 });

  const archivedGrantPath = path.join(successorRoot, 'timeout-recovery-grant.json');
  const externalGrantHardlink = path.join(root, 'external-timeout-recovery-grant-hardlink.json');
  await link(archivedGrantPath, externalGrantHardlink);
  await assert.rejects(
    receiveRemoteOcrOffload(authorityReceiveOptions, authorityReceiveDependencies),
    /timeout recovery grant must be a current-UID\/GID mode-0600 single-link file/u,
  );
  await rm(externalGrantHardlink);
  assert.equal(await stat(authorityNegativeProductionRoot).then(
    () => true,
    (error) => error?.code === 'ENOENT' ? false : Promise.reject(error),
  ), false);
  assert.equal(await stat(authorityNegativeReceiptRoot).then(
    () => true,
    (error) => error?.code === 'ENOENT' ? false : Promise.reject(error),
  ), false);
  const monitoredSeed = await inspectSuccessorB2(successorRoot, monitoredPredecessor);
  assert.equal(monitoredSeed.configuration_transition, seedAwareTransition);
  assert.equal(monitoredSeed.complete, false);
  const claimFilename = (await readdir(ledgerRoot)).find((entry) => entry.endsWith('.claim.json'));
  assert.ok(claimFilename);
  const claimPath = path.join(ledgerRoot, claimFilename);
  const claim = JSON.parse(await readFile(claimPath, 'utf8'));
  assert.equal(claim.grant_raw_sha256, seeded.seedReceipt.timeout_recovery_grant.raw_sha256);
  assert.equal(claim.successor.seed_id, seeded.seedReceipt.seed_id);
  assert.equal(claim.successor.output_root, await realpath(successorRoot));
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(path.join(root, 'a-r2-replay')), {
      ...dependencies,
      invokeOcr: async () => assert.fail('a consumed grant must fail before OCR invocation'),
    }),
    /already consumed by a different successor/,
  );

  const invocationCounts = new Map();
  const completed = await runRemoteOcrOffload(optionsFor(successorRoot, { seedOnly: false }), {
    ...dependencies,
    invokeOcr: async (_python, commandArguments) => {
      const document = documents.find((item) => item.id === commandArguments[1]);
      assert.ok(recoveryDocuments.some((item) => item.document_id === document.id));
      assert.equal(commandArguments[commandArguments.indexOf('--seed-id') + 1], seeded.seedReceipt.seed_id);
      invocationCounts.set(document.id, (invocationCounts.get(document.id) || 0) + 1);
      await completeSeededOutput(successorRoot, document);
      return { code: 0, signal: null };
    },
  });
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.runStatus.finished, true);
  assert.deepEqual([...invocationCounts.values()], [1, 1, 1, 1]);
  for (const receiptDocument of recoveryDocuments) {
    const progress = completed.runStatus.documents[receiptDocument.document_id];
    assert.equal(progress.status, 'complete');
    assert.equal(progress.attempts, 6);
    const status = JSON.parse(await readFile(
      path.join(successorRoot, 'status', `${receiptDocument.document_id}.json`),
      'utf8',
    ));
    assert.equal(status.attempt, 6);
    assert.equal(status.max_attempts, 6);
    assert.equal(status.seed_lineage.granted_attempt, 6);
    assert.equal(status.seed_lineage.timeout_recovery_grant_id, grant.grant_id);
  }
  const restart = await runRemoteOcrOffload(optionsFor(successorRoot, { seedOnly: false }), {
    ...dependencies,
    invokeOcr: async () => assert.fail('successful granted attempt 6 must not run again'),
  });
  assert.equal(restart.exitCode, 0);
  const received = await receiveRemoteOcrOffload({
    manifest: manifestPath,
    shards: [{ manifestPath, root: successorRoot }],
    projectRoot: inputRoot,
    productionRoot: path.join(inputRoot, 'local-production'),
    textRoot: path.join(inputRoot, 'local-text'),
    supervisorRoot: path.join(inputRoot, 'local-supervisor'),
    receiptRoot: path.join(inputRoot, 'receipts'),
    python: process.execPath,
    apply: true,
  }, {
    pageCounter: (_python, sourcePath) => documents.find(
      (document) => path.basename(document.source_path) === path.basename(sourcePath),
    ).page_count,
  });
  assert.equal(received.status, 'applied');
  assert.equal(received.counts.documents, 8);
  assert.equal(received.counts.pages, 3_182);
  assert.equal(
    received.source_shards[0].timeout_recovery_grant_sha256,
    seeded.seedReceipt.timeout_recovery_grant.raw_sha256,
  );
  const monitoredComplete = await inspectSuccessorB2(successorRoot, monitoredPredecessor);
  assert.equal(monitoredComplete.complete, true);
  const tamperedDocumentId = recoveryDocuments[0].document_id;
  const tamperedStatusPath = path.join(successorRoot, 'status', `${tamperedDocumentId}.json`);
  const tamperedRunStatusPath = path.join(successorRoot, 'run-status.json');
  const assertMonitorRejectsCompleteTamper = async ({ mutateStatus, mutateProgress, pattern }) => {
    const originalFiles = await Promise.all([
      tamperedStatusPath,
      `${tamperedStatusPath}.sha256`,
      tamperedRunStatusPath,
      `${tamperedRunStatusPath}.sha256`,
    ].map((pathname) => readFile(pathname)));
    try {
      const status = JSON.parse(originalFiles[0]);
      const runStatus = JSON.parse(originalFiles[2]);
      mutateStatus(status);
      const statusSha256 = await writeJsonSidecar(tamperedStatusPath, status);
      mutateProgress(runStatus.documents[tamperedDocumentId], runStatus);
      runStatus.documents[tamperedDocumentId].status_json_sha256 = statusSha256;
      await writeJsonSidecar(tamperedRunStatusPath, runStatus);
      await assert.rejects(inspectSuccessorB2(successorRoot, monitoredPredecessor), pattern);
    } finally {
      await Promise.all([
        tamperedStatusPath,
        `${tamperedStatusPath}.sha256`,
        tamperedRunStatusPath,
        `${tamperedRunStatusPath}.sha256`,
      ].map((pathname, index) => writeFile(pathname, originalFiles[index], { mode: 0o600 })));
    }
  };
  await t.test('monitor rejects a resealed granted completion downgraded to attempt 5', async () => {
    await assertMonitorRejectsCompleteTamper({
      mutateStatus: (status) => { status.attempt = 5; },
      mutateProgress: (progress) => { progress.attempts = 5; },
      pattern: /timeout recovery completion did not consume granted attempt 6/u,
    });
  });
  await t.test('monitor rejects a resealed granted completion with missing status lineage', async () => {
    await assertMonitorRejectsCompleteTamper({
      mutateStatus: (status) => { delete status.seed_lineage; },
      mutateProgress: () => {},
      pattern: /timeout recovery document status seed lineage must be an object/u,
    });
  });
  await t.test('monitor rejects a resealed granted completion downgraded to retry_wait', async () => {
    await assertMonitorRejectsCompleteTamper({
      mutateStatus: (status) => {
        status.status = 'retry_wait';
        status.attempt = 5;
      },
      mutateProgress: (progress, runStatus) => {
        progress.status = 'retry_wait';
        progress.attempts = 5;
        runStatus.counts.complete -= 1;
        runStatus.counts.retry_wait += 1;
        runStatus.finished = false;
        runStatus.settled = false;
      },
      pattern: /timeout recovery completed artifacts were downgraded/u,
    });
  });
  await chmod(archivedGrantPath, 0o644);
  await assert.rejects(
    inspectSuccessorB2(successorRoot, monitoredPredecessor),
    /timeout recovery grant must be a current-UID\/GID mode-0600 single-link file/u,
  );
  await chmod(archivedGrantPath, 0o600);
  const appliedReceipt = JSON.parse(await readFile(received.receipt_path, 'utf8'));
  const archivedRecovery = appliedReceipt.source_evidence.shards[0].seed_lineage.timeout_recovery;
  assert.equal(await stat(archivedRecovery.issuance.path).then((info) => info.isFile()), true);
  assert.equal(await stat(archivedRecovery.issuance_sidecar.path).then((info) => info.isFile()), true);
  const archivedControls = appliedReceipt.source_evidence.shards[0].seed_lineage.predecessor_controls.path;
  assert.equal(
    await stat(path.join(
      archivedControls,
      'timeout-incidents/legacy-compendium-english/attempt-0005.json',
    )).then((info) => info.isFile()),
    true,
  );
  const repeatedReceive = await receiveRemoteOcrOffload({
    manifest: manifestPath,
    shards: [{ manifestPath, root: successorRoot }],
    projectRoot: inputRoot,
    productionRoot: path.join(inputRoot, 'local-production'),
    textRoot: path.join(inputRoot, 'local-text'),
    supervisorRoot: path.join(inputRoot, 'local-supervisor'),
    receiptRoot: path.join(inputRoot, 'receipts'),
    python: process.execPath,
    apply: true,
  }, {
    pageCounter: (_python, sourcePath) => documents.find(
      (document) => path.basename(document.source_path) === path.basename(sourcePath),
    ).page_count,
  });
  assert.equal(repeatedReceive.status, 'verified_idempotent');
  assert.equal(repeatedReceive.receipt_path, received.receipt_path);
  const archivedTimeoutLog = path.join(
    archivedControls,
    'logs/legacy-compendium-english.log',
  );
  await chmod(archivedTimeoutLog, 0o644);
  await assert.rejects(
    receiveRemoteOcrOffload({
      manifest: manifestPath,
      shards: [{ manifestPath, root: successorRoot }],
      projectRoot: inputRoot,
      productionRoot: path.join(inputRoot, 'local-production'),
      textRoot: path.join(inputRoot, 'local-text'),
      supervisorRoot: path.join(inputRoot, 'local-supervisor'),
      receiptRoot: path.join(inputRoot, 'receipts'),
      python: process.execPath,
      apply: true,
    }, {
      pageCounter: (_python, sourcePath) => documents.find(
        (document) => path.basename(document.source_path) === path.basename(sourcePath),
      ).page_count,
    }),
    /archived timeout recovery log must be a current-UID\/GID mode-0600 single-link file/u,
  );
  await chmod(archivedTimeoutLog, 0o600);

  const bPredecessorRoot = path.join(canonicalRoot, 'b-r1-union');
  const bSuccessorRoot = path.join(canonicalRoot, 'b-r2-union');
  const bManifestPath = path.join(inputRoot, 'b-union-shard.json');
  const bSpecifications = [
    ['legacy-compendium-arts-labor', 491, 491, 'complete', 1],
    ['legacy-compendium-chemistry', 458, 458, 'complete', 2],
    ['legacy-compendium-chinese', 568, 568, 'complete', 1],
    ['legacy-compendium-history', 765, 765, 'complete', 1],
    ['legacy-compendium-physics', 477, 477, 'complete', 1],
    ['legacy-compendium-plans', 423, 423, 'complete', 1],
  ];
  const {
    documents: bDocuments,
    paddlexLayoutModelCache: bFixturePaddlexLayoutModelCache,
  } = await createTimeoutRecoveryPredecessor({
    inputRoot,
    predecessorRoot: bPredecessorRoot,
    manifestPath: bManifestPath,
    specifications: bSpecifications,
    attestation: predecessorAttestation,
    receiverNativeArtifacts: true,
    ocrScriptSha256: legacyB1OcrScriptSha256,
    materializePaddlexCache: true,
  });
  const bSeeded = await runRemoteOcrOffload({
    ...optionsFor(bSuccessorRoot),
    manifest: bManifestPath,
    seedFromOutputRoot: bPredecessorRoot,
    timeoutRecoveryLedger: undefined,
  }, {
    ...dependencies,
    paddlexLayoutModelCache: bFixturePaddlexLayoutModelCache,
    pageCounter: (_python, sourcePath) => bDocuments.find(
      (document) => path.basename(document.source_path) === path.basename(sourcePath),
    ).page_count,
  });
  await rm(path.join(bSuccessorRoot, 'paddlex-cache'), { recursive: true, force: true });
  await cp(
    path.join(bPredecessorRoot, 'paddlex-cache'),
    path.join(bSuccessorRoot, 'paddlex-cache'),
    { recursive: true },
  );
  assert.equal(bSeeded.seedReceipt.counts.inherited_pages, 3_182);
  assert.equal(bSeeded.seedReceipt.timeout_recovery_grant, undefined);
  assert.equal(bSeeded.seedReceipt.allowed_configuration_delta.schema_version, 3);
  assert.equal(bSeeded.seedReceipt.allowed_configuration_delta.transition, seedAwareTransition);
  const monitoredBPredecessor = await inspectPredecessorB1(bPredecessorRoot);
  const monitoredB = await inspectSuccessorB2(bSuccessorRoot, monitoredBPredecessor);
  assert.equal(monitoredB.configuration_transition, seedAwareTransition);
  assert.equal(monitoredB.complete, true);
  const unionManifestPath = path.join(inputRoot, 'a-b-r2-union.json');
  await writeFile(
    unionManifestPath,
    `${JSON.stringify(manifestFor([...documents, ...bDocuments]), null, 2)}\n`,
  );
  const union = await receiveRemoteOcrOffload({
    manifest: unionManifestPath,
    shards: [
      { manifestPath, root: successorRoot },
      { manifestPath: bManifestPath, root: bSuccessorRoot },
    ],
    projectRoot: inputRoot,
    productionRoot: path.join(inputRoot, 'union-local-production'),
    textRoot: path.join(inputRoot, 'union-local-text'),
    supervisorRoot: path.join(inputRoot, 'union-local-supervisor'),
    receiptRoot: path.join(inputRoot, 'union-receipts'),
    python: process.execPath,
  }, {
    pageCounter: (_python, sourcePath) => [...documents, ...bDocuments].find(
      (document) => path.basename(document.source_path) === path.basename(sourcePath),
    ).page_count,
  });
  assert.equal(union.status, 'dry_run_validated');
  assert.equal(union.counts.documents, 14);
  assert.equal(union.counts.pages, 6364);
  assert.equal(union.source_shards.filter((shard) => shard.timeout_recovery_grant_sha256).length, 1);
  assert.equal(union.documents.filter((document) => document.timeout_recovery).length, 4);
  assert.deepEqual(await inspectTree(predecessorRoot), predecessorBefore);
});

test('timeout grant rejects drift and a failed granted attempt 6 is quarantined without attempt 7', async (t) => {
  const { root, inputRoot, ocrScript } = await fixture(t);
  const predecessorRoot = path.join(root, 'a-r1-small');
  const successorRoot = path.join(root, 'a-r2-small');
  const manifestPath = path.join(inputRoot, 'a-small.json');
  const specifications = [
    ['doc-timeout-fails', 2, 1, 'quarantined', 5],
    ['doc-timeout-recovers', 2, 1, 'quarantined', 5],
  ];
  const attestation = {
    ...llamaServerAttestation,
    parallel: 4,
    production_command_contract: {
      values: { '--host': '127.0.0.1', '--port': '8112', '--parallel': '4' },
      flags: ['--mmproj-offload'],
    },
  };
  const { documents, grant, ledgerRoot } = await createTimeoutRecoveryPredecessor({
    inputRoot,
    predecessorRoot,
    manifestPath,
    specifications,
    attestation,
  });
  const optionsFor = (outputRoot, extra = {}) => ({
    manifest: manifestPath,
    inputRoot,
    outputRoot,
    python: process.execPath,
    ocrScript,
    model: '/unused/model',
    mmproj: '/unused/mmproj',
    llamaRepo: '/unused/llama',
    llamaServerBin,
    llamaSystemdUnit,
    llamaUrl: workerConfiguration.llama_url,
    runtimeDevice,
    vlRecMaxConcurrency: 1,
    serverParallel: 4,
    microBatch: 16,
    useQueues: true,
    childIdleTimeoutSeconds: 1200,
    seedFromOutputRoot: predecessorRoot,
    timeoutRecoveryLedger: ledgerRoot,
    seedOnly: true,
    ...extra,
  });
  const dependencies = {
    pageCounter: () => 2,
    runtime,
    llamaServerAttestation: attestation,
    pythonRuntime,
    paddlexLayoutModelCache,
    runnerScriptSha256: 'e'.repeat(64),
    nowMilliseconds: () => Date.parse('2026-07-18T06:00:00.000Z'),
    handleSignals: false,
  };
  const driftedGrant = structuredClone(grant);
  driftedGrant.documents[0].first_missing_page = 1;
  const driftedBasis = structuredClone(driftedGrant);
  delete driftedBasis.grant_id;
  driftedGrant.grant_id = sha256(canonicalJson(driftedBasis));
  await writeTimeoutRecoveryGrant(predecessorRoot, driftedGrant);
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(path.join(root, 'frontier-drift')), dependencies),
    /grant document identity mismatch/,
  );
  await writeTimeoutRecoveryGrant(predecessorRoot, grant);
  const timeoutLogPath = path.join(predecessorRoot, 'logs/doc-timeout-fails.log');
  const originalTimeoutLog = await readFile(timeoutLogPath);
  await writeFile(timeoutLogPath, Buffer.concat([originalTimeoutLog, Buffer.from('drift\n')]));
  await assert.rejects(
    runRemoteOcrOffload(optionsFor(path.join(root, 'log-drift')), dependencies),
    /timeout recovery log identity mismatch|timeout incident log identity differs/u,
  );
  await writeFile(timeoutLogPath, originalTimeoutLog);
  await runRemoteOcrOffload(optionsFor(successorRoot), dependencies);

  const invocations = [];
  const first = await runRemoteOcrOffload(optionsFor(successorRoot, { seedOnly: false }), {
    ...dependencies,
    invokeOcr: async (_python, commandArguments) => {
      const id = commandArguments[1];
      invocations.push(id);
      if (id === 'doc-timeout-recovers') {
        await completeSeededOutput(successorRoot, documents.find((document) => document.id === id));
      }
      return { code: 0, signal: null };
    },
  });
  assert.equal(first.exitCode, 12);
  assert.deepEqual(invocations, ['doc-timeout-fails', 'doc-timeout-recovers']);
  assert.equal(first.runStatus.documents['doc-timeout-fails'].status, 'quarantined');
  assert.equal(first.runStatus.documents['doc-timeout-fails'].attempts, 6);
  assert.equal(first.runStatus.documents['doc-timeout-recovers'].status, 'complete');
  assert.equal(first.runStatus.documents['doc-timeout-recovers'].attempts, 6);
  const retry = await runRemoteOcrOffload(optionsFor(successorRoot, { seedOnly: false }), {
    ...dependencies,
    invokeOcr: async () => assert.fail('attempt 7 must never be invoked'),
  });
  assert.equal(retry.exitCode, 12);
  assert.equal(retry.runStatus.documents['doc-timeout-fails'].attempts, 6);
});

test('output-root owner lock blocks a concurrent runner before identity or cache initialization', async (t) => {
  const { root, inputRoot, outputRoot, ocrScript } = await fixture(t);
  const source = 'lock ownership source';
  await writeFile(path.join(inputRoot, 'pdfs/lock.pdf'), source);
  const document = documentFor('doc-lock', 'pdfs/lock.pdf', source);
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifestFor([document]), null, 2)}\n`);
  const options = offloadOptions({ manifestPath, inputRoot, outputRoot, ocrScript });
  let announceFirstChild;
  const firstChildStarted = new Promise((resolve) => { announceFirstChild = resolve; });
  let releaseFirstChild;
  const holdFirstChild = new Promise((resolve) => { releaseFirstChild = resolve; });
  const firstRun = runRemoteOcrOffload(options, {
    invokeOcr: async () => {
      announceFirstChild();
      await holdFirstChild;
      await createCompletedOutput(outputRoot, document);
      return { code: 0, signal: null };
    },
    pageCounter: () => 2,
    runtime,
    llamaServerAttestation,
    pythonRuntime,
    paddlexLayoutModelCache,
    handleSignals: false,
  });
  await firstChildStarted;

  const forbiddenCache = path.join(outputRoot, 'concurrent-cache');
  let identityProbeReads = 0;
  const concurrentDependencies = {
    invokeOcr: async () => assert.fail('the concurrent runner must not invoke OCR'),
    pageCounter: () => assert.fail('the concurrent runner must not preflight a document'),
    handleSignals: false,
  };
  for (const [key, value] of Object.entries({
    runtime,
    llamaServerAttestation,
    pythonRuntime,
    paddlexLayoutModelCache,
  })) {
    Object.defineProperty(concurrentDependencies, key, {
      enumerable: true,
      get() {
        identityProbeReads += 1;
        return value;
      },
    });
  }
  try {
    await assert.rejects(
      runRemoteOcrOffload({ ...options, paddlexCacheHome: forbiddenCache }, concurrentDependencies),
      /orchestrator is already running/,
    );
    assert.equal(identityProbeReads, 0, 'the losing runner must not begin identity probes');
    await assert.rejects(stat(forbiddenCache), /ENOENT/, 'the losing runner must not initialize its PaddleX cache');
  } finally {
    releaseFirstChild();
  }
  assert.equal((await firstRun).exitCode, 0);
});

test('pre-spawn Python resolved-target drift exits fail-closed without consuming a document attempt', async (t) => {
  const { root, inputRoot, outputRoot, ocrScript } = await fixture(t);
  const python = path.join(root, 'venv/bin/python');
  await mkdir(path.dirname(python), { recursive: true });
  await symlink(process.execPath, python);
  const source = 'python target drift source';
  await writeFile(path.join(inputRoot, 'pdfs/python.pdf'), source);
  const document = documentFor('doc-python-drift', 'pdfs/python.pdf', source);
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifestFor([document]), null, 2)}\n`);
  let invocations = 0;
  await assert.rejects(
    runRemoteOcrOffload(offloadOptions({ manifestPath, inputRoot, outputRoot, ocrScript, python }), {
      invokeOcr: async () => {
        invocations += 1;
        return { code: 0, signal: null };
      },
      pageCounter: () => {
        unlinkSync(python);
        symlinkSync('/bin/sh', python);
        return 2;
      },
      runtime,
      llamaServerAttestation,
      pythonRuntime,
      paddlexLayoutModelCache,
      handleSignals: false,
    }),
    /OCR child spawn provenance validation failed: Python OCR resolved target drifted/,
  );
  assert.equal(invocations, 0);
  const runStatus = JSON.parse(await readFile(path.join(outputRoot, 'run-status.json'), 'utf8'));
  assert.equal(runStatus.documents[document.id].status, 'failed');
  assert.equal(runStatus.documents[document.id].failure_class, 'shared_runtime_configuration');
  assert.equal(runStatus.documents[document.id].attempts, 0);
  assert.equal(runStatus.documents[document.id].quarantine_reason, undefined);
});

test('post-child revalidation detects pinned model and mmproj drift without retry or quarantine', async (t) => {
  const { root, inputRoot, ocrScript } = await fixture(t);
  const source = 'pinned runtime drift source';
  await writeFile(path.join(inputRoot, 'pdfs/runtime.pdf'), source);
  const document = documentFor('doc-runtime-drift', 'pdfs/runtime.pdf', source);
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifestFor([document]), null, 2)}\n`);

  for (const field of ['model_sha256', 'mmproj_sha256']) {
    await t.test(field, async () => {
      const outputRoot = path.join(root, `output-${field}`);
      let invocations = 0;
      await assert.rejects(
        runRemoteOcrOffload(offloadOptions({ manifestPath, inputRoot, outputRoot, ocrScript }), {
          invokeOcr: async () => {
            invocations += 1;
            return { code: 1, signal: null };
          },
          pageCounter: () => 2,
          runtime,
          llamaServerAttestation,
          pythonRuntime,
          paddlexLayoutModelCache,
          revalidateSharedRuntime: async () => ({
            runtime: { ...runtime, [field]: '0'.repeat(64) },
            llamaServerAttestation,
            pythonRuntime,
            paddlexLayoutModelCache,
          }),
          handleSignals: false,
        }),
        /shared runtime revalidation failed.*pinned model, mmproj, or llama\.cpp runtime drifted/,
      );
      assert.equal(invocations, 1);
      const runStatus = JSON.parse(await readFile(path.join(outputRoot, 'run-status.json'), 'utf8'));
      assert.equal(runStatus.documents[document.id].status, 'failed');
      assert.equal(runStatus.documents[document.id].failure_class, 'shared_runtime_configuration');
      assert.equal(runStatus.documents[document.id].attempts, 0);
      assert.equal(runStatus.documents[document.id].quarantine_reason, undefined);
    });
  }
});

test('post-child revalidation detects OCR script drift and preserves the document retry budget', async (t) => {
  const { root, inputRoot, outputRoot, ocrScript } = await fixture(t);
  const source = 'OCR script drift source';
  await writeFile(path.join(inputRoot, 'pdfs/script.pdf'), source);
  const document = documentFor('doc-script-drift', 'pdfs/script.pdf', source);
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifestFor([document]), null, 2)}\n`);
  await assert.rejects(
    runRemoteOcrOffload(offloadOptions({ manifestPath, inputRoot, outputRoot, ocrScript }), {
      invokeOcr: async () => {
        writeFileSync(ocrScript, '# drifted OCR entrypoint\n');
        return { code: 1, signal: null };
      },
      pageCounter: () => 2,
      runtime,
      llamaServerAttestation,
      pythonRuntime,
      paddlexLayoutModelCache,
      revalidateSharedRuntime: healthySharedRuntimeRevalidation,
      handleSignals: false,
    }),
    /shared runtime revalidation failed.*OCR script SHA-256 drifted/,
  );
  const runStatus = JSON.parse(await readFile(path.join(outputRoot, 'run-status.json'), 'utf8'));
  assert.equal(runStatus.documents[document.id].failure_class, 'shared_runtime_configuration');
  assert.equal(runStatus.documents[document.id].attempts, 0);
  assert.equal(runStatus.documents[document.id].quarantine_reason, undefined);
});

test('seed-aware child receives exact seed arguments and post-child writer drift does not consume an inherited attempt', async (t) => {
  const { root, inputRoot } = await fixture(t);
  const predecessorRoot = path.join(root, 'seed-aware-child-p4');
  const successorRoot = path.join(root, 'seed-aware-child-p1');
  const manifestPath = path.join(inputRoot, 'seed-aware-child.json');
  const sourceWriter = fileURLToPath(new URL('../scripts/ocr-pdf-paddle.py', import.meta.url));
  const ocrScript = path.join(root, 'seed-aware-child-ocr.py');
  await writeFile(ocrScript, await readFile(sourceWriter));
  const predecessorAttestation = llamaAttestationForParallel(4);
  const successorAttestation = llamaAttestationForParallel(1);
  const { paddlexLayoutModelCache: fixtureCache } = await createTimeoutRecoveryPredecessor({
    inputRoot,
    predecessorRoot,
    manifestPath,
    specifications: [['doc-seed-aware-child', 2, 1, 'retry_wait', 1]],
    attestation: predecessorAttestation,
    receiverNativeArtifacts: true,
    ocrScriptSha256: legacyB1OcrScriptSha256,
    materializePaddlexCache: true,
  });
  const options = {
    manifest: manifestPath,
    inputRoot,
    outputRoot: successorRoot,
    python: process.execPath,
    ocrScript,
    model: '/unused/model',
    mmproj: '/unused/mmproj',
    llamaRepo: '/unused/llama',
    llamaServerBin,
    llamaSystemdUnit,
    llamaUrl: workerConfiguration.llama_url,
    runtimeDevice,
    vlRecMaxConcurrency: 1,
    serverParallel: 1,
    microBatch: 16,
    useQueues: true,
    childIdleTimeoutSeconds: 1200,
    seedFromOutputRoot: predecessorRoot,
  };
  let childInvocations = 0;
  await assert.rejects(
    runRemoteOcrOffload(options, {
      pageCounter: () => 2,
      runtime,
      llamaServerAttestation: successorAttestation,
      pythonRuntime,
      paddlexLayoutModelCache: fixtureCache,
      runnerScriptSha256: 'e'.repeat(64),
      invokeOcr: async (_python, commandArguments) => {
        childInvocations += 1;
        for (const flag of [
          '--seed-id',
          '--seed-predecessor-run-identity-sha256',
          '--seed-predecessor-configuration-sha256',
        ]) {
          const index = commandArguments.indexOf(flag);
          assert.notEqual(index, -1, flag);
          assert.match(commandArguments[index + 1], /^[a-f0-9]{64}$/u, flag);
        }
        writeFileSync(ocrScript, '# drifted after seeded child invocation\n');
        return { code: 1, signal: null };
      },
      revalidateSharedRuntime: healthySharedRuntimeRevalidation,
      handleSignals: false,
    }),
    /shared runtime revalidation failed.*OCR script SHA-256 drifted/,
  );
  assert.equal(childInvocations, 1);
  const runStatus = JSON.parse(await readFile(path.join(successorRoot, 'run-status.json'), 'utf8'));
  const progress = runStatus.documents['doc-seed-aware-child'];
  assert.equal(progress.failure_class, 'shared_runtime_configuration');
  assert.equal(progress.inherited_attempts, 1);
  assert.equal(progress.attempts, 1);
  assert.equal(progress.quarantine_reason, undefined);
  await writeFile(ocrScript, await readFile(sourceWriter));
  await resealCommittedSeedReceipt(successorRoot, (receipt) => {
    receipt.allowed_configuration_delta.schema_version = 2;
    receipt.allowed_configuration_delta.transition = 'p4_to_p1_v1';
    delete receipt.allowed_configuration_delta.ocr_script_transition;
  });
  await assert.rejects(
    runRemoteOcrOffload(options, {
      pageCounter: () => 2,
      runtime,
      llamaServerAttestation: successorAttestation,
      pythonRuntime,
      paddlexLayoutModelCache: fixtureCache,
      runnerScriptSha256: 'e'.repeat(64),
      invokeOcr: async () => assert.fail('resealed schema downgrade must fail before OCR'),
      revalidateSharedRuntime: healthySharedRuntimeRevalidation,
      handleSignals: false,
    }),
    /schema-v2 p4-to-p1 requires an identical OCR script identity|allowed configuration delta is not the exact audited transition/,
  );
});

test('external termination escalates an owned child from TERM to KILL after the configured grace', () => {
  const sent = [];
  let escalation;
  const child = {
    exitCode: null,
    signalCode: null,
    kill(signal) {
      sent.push(signal);
      return true;
    },
  };
  const termination = terminateOwnedChild(child, 15_000, {
    setTimeout: (callback, milliseconds) => {
      assert.equal(milliseconds, 15_000);
      escalation = callback;
      return { unref() {} };
    },
    clearTimeout: () => {},
  });
  assert.deepEqual(sent, ['SIGTERM']);
  escalation();
  assert.deepEqual(sent, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(termination.signals, sent);
});

test('default child invocation creates and appends the exact per-document log path', async (t) => {
  const { root, inputRoot, outputRoot, ocrScript } = await fixture(t);
  const source = 'log source';
  await writeFile(path.join(inputRoot, 'pdfs/log.pdf'), source);
  await writeFile(ocrScript, "process.stdout.write('log-contract-marker\\n'); process.exitCode = 1;\n");
  const document = documentFor('doc-log', 'pdfs/log.pdf', source);
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifestFor([document]), null, 2)}\n`);
  const options = {
    manifest: manifestPath,
    inputRoot,
    outputRoot,
    python: process.execPath,
    ocrScript,
    model: '/unused/model',
    mmproj: '/unused/mmproj',
    llamaRepo: '/unused/llama',
    llamaServerBin,
    llamaSystemdUnit,
    llamaUrl: workerConfiguration.llama_url,
    runtimeDevice,
    vlRecMaxConcurrency: 2,
    serverParallel: 2,
    microBatch: 4,
    useQueues: true,
  };
  let now = Date.parse('2026-07-16T00:00:00.000Z');
  const result = await runRemoteOcrOffload(options, {
    pageCounter: () => 2,
    runtime,
    llamaServerAttestation,
    pythonRuntime,
    paddlexLayoutModelCache,
    revalidateSharedRuntime: healthySharedRuntimeRevalidation,
    handleSignals: false,
    nowMilliseconds: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
  });

  assert.equal(result.exitCode, 12);
  const logPath = path.join(outputRoot, 'logs/doc-log.log');
  assert.equal((await stat(path.dirname(logPath))).isDirectory(), true);
  assert.equal((await stat(logPath)).isFile(), true);
  const logContents = await readFile(logPath, 'utf8');
  assert.equal((logContents.match(/log-contract-marker/g) || []).length, 5);
});

test('child progress monitor escalates an idle OCR process from TERM to KILL', async (t) => {
  const { outputRoot } = await fixture(t);
  const logPath = path.join(outputRoot, 'logs/idle.log');
  const documentRoot = path.join(outputRoot, 'documents/doc-idle');
  await mkdir(path.dirname(logPath), { recursive: true });
  await mkdir(documentRoot, { recursive: true });
  const child = [
    "process.on('SIGTERM', () => {});",
    "process.stdout.write('startup progress\\n');",
    'setInterval(() => {}, 1000);',
  ].join('');
  const result = await invokeOcrChild(process.execPath, ['-e', child], {
    env: process.env,
    logPath,
    documentRoot,
    monitoring: {
      startup_timeout_seconds: 1,
      idle_timeout_seconds: 0.08,
      wall_timeout_seconds: 5,
      terminate_grace_seconds: 0.05,
      poll_interval_seconds: 0.01,
    },
  });
  assert.equal(result.monitorIncident.type, 'idle_timeout');
  assert.deepEqual(result.monitorIncident.termination_signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.signal, 'SIGKILL');
  assert.match(await readFile(logPath, 'utf8'), /startup progress/);
});

test('child progress monitor escalates a silent startup timeout from TERM to KILL', async (t) => {
  const { outputRoot } = await fixture(t);
  const logPath = path.join(outputRoot, 'logs/startup-timeout.log');
  const documentRoot = path.join(outputRoot, 'documents/doc-startup-timeout');
  await mkdir(path.dirname(logPath), { recursive: true });
  await mkdir(documentRoot, { recursive: true });
  const silentChild = [
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('');
  const result = await invokeOcrChild(process.execPath, ['-e', silentChild], {
    env: process.env,
    logPath,
    documentRoot,
    monitoring: {
      startup_timeout_seconds: 0.12,
      idle_timeout_seconds: 1,
      wall_timeout_seconds: 5,
      terminate_grace_seconds: 0.05,
      poll_interval_seconds: 0.01,
    },
  });
  assert.equal(result.monitorIncident.type, 'startup_timeout');
  assert.deepEqual(result.monitorIncident.termination_signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(await readFile(logPath, 'utf8'), '');
});

test('child progress monitor enforces wall timeout despite continuously advancing progress', async (t) => {
  const { outputRoot } = await fixture(t);
  const logPath = path.join(outputRoot, 'logs/wall-timeout.log');
  const documentRoot = path.join(outputRoot, 'documents/doc-wall-timeout');
  await mkdir(path.dirname(logPath), { recursive: true });
  await mkdir(documentRoot, { recursive: true });
  const progressingChild = [
    "process.on('SIGTERM', () => {});",
    "setInterval(() => process.stdout.write('progress\\n'), 10);",
  ].join('');
  const result = await invokeOcrChild(process.execPath, ['-e', progressingChild], {
    env: process.env,
    logPath,
    documentRoot,
    monitoring: {
      startup_timeout_seconds: 5,
      idle_timeout_seconds: 0.25,
      wall_timeout_seconds: 0.6,
      terminate_grace_seconds: 0.08,
      poll_interval_seconds: 0.01,
    },
  });
  assert.equal(result.monitorIncident.type, 'wall_timeout');
  assert.deepEqual(result.monitorIncident.termination_signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.signal, 'SIGKILL');
  assert.match(await readFile(logPath, 'utf8'), /progress/);
});

test('child progress monitor failure terminates the owned child before rejecting', async (t) => {
  const { outputRoot } = await fixture(t);
  const logPath = path.join(outputRoot, 'logs/monitor-error.log');
  const documentRoot = path.join(outputRoot, 'documents/doc-monitor-error');
  await mkdir(path.dirname(logPath), { recursive: true });
  await mkdir(documentRoot, { recursive: true });
  const childCode = [
    "const fs = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    "fs.symlinkSync('state.json', process.argv[1] + '/state.json');",
    "process.stdout.write('monitor error fixture ready\\n');",
    'setInterval(() => {}, 1000);',
  ].join('');
  let ownedChild;
  await assert.rejects(
    invokeOcrChild(process.execPath, ['-e', childCode, documentRoot], {
      env: process.env,
      logPath,
      documentRoot,
      monitoring: {
        startup_timeout_seconds: 1,
        idle_timeout_seconds: 1,
        wall_timeout_seconds: 5,
        terminate_grace_seconds: 0.05,
        poll_interval_seconds: 0.01,
      },
      onChild: (child) => { ownedChild = child; },
    }),
    /OCR child progress monitor failed/,
  );
  assert.equal(ownedChild.signalCode, 'SIGKILL');
});

test('shared PDF page-probe runtime failure aborts before any document is quarantined or invoked', async (t) => {
  const { root, inputRoot, outputRoot, ocrScript } = await fixture(t);
  const firstSource = 'first probe source';
  const secondSource = 'second probe source';
  await writeFile(path.join(inputRoot, 'pdfs/first.pdf'), firstSource);
  await writeFile(path.join(inputRoot, 'pdfs/second.pdf'), secondSource);
  const first = documentFor('doc-first', 'pdfs/first.pdf', firstSource);
  const second = documentFor('doc-second', 'pdfs/second.pdf', secondSource);
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifestFor([first, second]), null, 2)}\n`);
  let invocations = 0;
  const options = {
    manifest: manifestPath,
    inputRoot,
    outputRoot,
    python: process.execPath,
    ocrScript,
    model: '/unused/model',
    mmproj: '/unused/mmproj',
    llamaRepo: '/unused/llama',
    llamaServerBin,
    llamaSystemdUnit,
    llamaUrl: workerConfiguration.llama_url,
    runtimeDevice,
    vlRecMaxConcurrency: 2,
    serverParallel: 2,
    microBatch: 4,
    useQueues: true,
  };
  await assert.rejects(
    runRemoteOcrOffload(options, {
      invokeOcr: async () => {
        invocations += 1;
        return { code: 0, signal: null };
      },
      pageCounter: () => {
        throw new Error("ModuleNotFoundError: No module named 'pypdfium2'");
      },
      runtime,
      llamaServerAttestation,
      pythonRuntime,
      paddlexLayoutModelCache,
      revalidateSharedRuntime: healthySharedRuntimeRevalidation,
      handleSignals: false,
    }),
    /shared PDF page-count probe runtime failed.*pypdfium2/,
  );

  assert.equal(invocations, 0);
  const runStatus = JSON.parse(await readFile(path.join(outputRoot, 'run-status.json'), 'utf8'));
  assert.deepEqual(
    Object.fromEntries(Object.entries(runStatus.documents).map(([id, progress]) => [id, {
      status: progress.status,
      attempts: progress.attempts,
    }])),
    {
      'doc-first': { status: 'pending', attempts: 0 },
      'doc-second': { status: 'pending', attempts: 0 },
    },
  );
  await assert.rejects(readFile(path.join(outputRoot, 'status/doc-first.json')), /ENOENT/);
  await assert.rejects(readFile(path.join(outputRoot, 'status/doc-second.json')), /ENOENT/);
});

test('OCR child exit 2 aborts the shard as a shared runtime fault without quarantining documents', async (t) => {
  const { root, inputRoot, outputRoot, ocrScript } = await fixture(t);
  const firstSource = 'first source';
  const secondSource = 'second source';
  await writeFile(path.join(inputRoot, 'pdfs/first.pdf'), firstSource);
  await writeFile(path.join(inputRoot, 'pdfs/second.pdf'), secondSource);
  const first = documentFor('doc-first', 'pdfs/first.pdf', firstSource);
  const second = documentFor('doc-second', 'pdfs/second.pdf', secondSource);
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifestFor([first, second]), null, 2)}\n`);
  let invocations = 0;
  await assert.rejects(
    runRemoteOcrOffload({
      manifest: manifestPath,
      inputRoot,
      outputRoot,
      python: process.execPath,
      ocrScript,
      model: '/unused/model',
      mmproj: '/unused/mmproj',
      llamaRepo: '/unused/llama',
      llamaServerBin,
      llamaSystemdUnit,
      llamaUrl: workerConfiguration.llama_url,
      runtimeDevice,
      vlRecMaxConcurrency: 2,
      serverParallel: 2,
      microBatch: 4,
      useQueues: true,
    }, {
      invokeOcr: async () => {
        invocations += 1;
        return { code: 2, signal: null };
      },
      pageCounter: () => 2,
      runtime,
      llamaServerAttestation,
      pythonRuntime,
      paddlexLayoutModelCache,
      revalidateSharedRuntime: healthySharedRuntimeRevalidation,
      handleSignals: false,
    }),
    /shared runtime\/configuration fault/,
  );
  assert.equal(invocations, 1);
  const runStatus = JSON.parse(await readFile(path.join(outputRoot, 'run-status.json'), 'utf8'));
  assert.equal(runStatus.documents['doc-first'].status, 'failed');
  assert.equal(runStatus.documents['doc-first'].attempts, 0);
  assert.equal(runStatus.documents['doc-first'].failure_class, 'shared_runtime_configuration');
  assert.equal(runStatus.documents['doc-first'].quarantine_reason, undefined);
  assert.equal(runStatus.documents['doc-second'].status, 'pending');
  assert.equal(runStatus.documents['doc-second'].attempts, 0);
  assert.match(await readFile(path.join(outputRoot, 'run-status.json.sha256'), 'utf8'), /^[a-f0-9]{64}  run-status\.json\n$/);
});

test('repeated shared runtime failures across restarts never consume attempts or quarantine the document', async (t) => {
  const { root, inputRoot, outputRoot, ocrScript } = await fixture(t);
  const source = 'repeated shared runtime failure source';
  await writeFile(path.join(inputRoot, 'pdfs/repeated.pdf'), source);
  const document = documentFor('doc-repeated-shared-failure', 'pdfs/repeated.pdf', source);
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifestFor([document]), null, 2)}\n`);
  let invocations = 0;
  const options = offloadOptions({ manifestPath, inputRoot, outputRoot, ocrScript });
  const dependencies = {
    invokeOcr: async () => {
      invocations += 1;
      return { code: 2, signal: null };
    },
    pageCounter: () => 2,
    runtime,
    llamaServerAttestation,
    pythonRuntime,
    paddlexLayoutModelCache,
    revalidateSharedRuntime: healthySharedRuntimeRevalidation,
    handleSignals: false,
  };
  for (let restart = 0; restart < 6; restart += 1) {
    await assert.rejects(
      runRemoteOcrOffload(options, dependencies),
      /shared runtime\/configuration fault/,
    );
    const runStatus = JSON.parse(await readFile(path.join(outputRoot, 'run-status.json'), 'utf8'));
    assert.equal(runStatus.documents[document.id].status, 'failed');
    assert.equal(runStatus.documents[document.id].failure_class, 'shared_runtime_configuration');
    assert.equal(runStatus.documents[document.id].attempts, 0);
    assert.equal(runStatus.documents[document.id].quarantine_reason, undefined);
  }
  assert.equal(invocations, 6, 'shared faults must continue to exit fail-closed instead of exhausting content attempts');
});

test('child exit 1 aborts the shard when post-start shared runtime revalidation detects a llama outage', async (t) => {
  const { root, inputRoot, outputRoot, ocrScript } = await fixture(t);
  const firstSource = 'first runtime outage source';
  const secondSource = 'second untouched source';
  await writeFile(path.join(inputRoot, 'pdfs/first.pdf'), firstSource);
  await writeFile(path.join(inputRoot, 'pdfs/second.pdf'), secondSource);
  const first = documentFor('doc-first', 'pdfs/first.pdf', firstSource);
  const second = documentFor('doc-second', 'pdfs/second.pdf', secondSource);
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifestFor([first, second]), null, 2)}\n`);
  let invocations = 0;
  let revalidations = 0;
  await assert.rejects(
    runRemoteOcrOffload({
      manifest: manifestPath,
      inputRoot,
      outputRoot,
      python: process.execPath,
      ocrScript,
      model: '/unused/model',
      mmproj: '/unused/mmproj',
      llamaRepo: '/unused/llama',
      llamaServerBin,
      llamaSystemdUnit,
      llamaUrl: workerConfiguration.llama_url,
      runtimeDevice,
      vlRecMaxConcurrency: 2,
      serverParallel: 2,
      microBatch: 4,
      useQueues: true,
    }, {
      invokeOcr: async () => {
        invocations += 1;
        return { code: 1, signal: null };
      },
      pageCounter: () => 2,
      runtime,
      llamaServerAttestation,
      pythonRuntime,
      paddlexLayoutModelCache,
      revalidateSharedRuntime: async ({ expected }) => {
        revalidations += 1;
        assert.deepEqual(expected, {
          runtime,
          llamaServerAttestation,
          pythonRuntime,
          paddlexLayoutModelCache,
        });
        throw new Error('llama-server health probe is not ready after child start');
      },
      handleSignals: false,
    }),
    (error) => {
      assert.equal(error.name, 'SharedRuntimeConfigurationError');
      assert.match(error.message, /shared runtime revalidation failed.*llama-server health probe is not ready/);
      return true;
    },
  );
  assert.equal(invocations, 1);
  assert.equal(revalidations, 1);
  const runStatus = JSON.parse(await readFile(path.join(outputRoot, 'run-status.json'), 'utf8'));
  assert.equal(runStatus.documents['doc-first'].status, 'failed');
  assert.equal(runStatus.documents['doc-first'].attempts, 0);
  assert.equal(runStatus.documents['doc-first'].failure_class, 'shared_runtime_configuration');
  assert.equal(runStatus.documents['doc-first'].quarantine_reason, undefined);
  assert.equal(runStatus.documents['doc-second'].status, 'pending');
  assert.equal(runStatus.documents['doc-second'].attempts, 0);
  const documentStatus = JSON.parse(await readFile(path.join(outputRoot, 'status/doc-first.json'), 'utf8'));
  assert.equal(documentStatus.failure_class, 'shared_runtime_configuration');
  assert.equal(documentStatus.status, 'failed');
});

test('invokeOcr rejection aborts the shard when shared runtime revalidation detects a llama outage', async (t) => {
  const { root, inputRoot, outputRoot, ocrScript } = await fixture(t);
  const firstSource = 'first invocation outage source';
  const secondSource = 'second invocation untouched source';
  await writeFile(path.join(inputRoot, 'pdfs/first.pdf'), firstSource);
  await writeFile(path.join(inputRoot, 'pdfs/second.pdf'), secondSource);
  const first = documentFor('doc-first', 'pdfs/first.pdf', firstSource);
  const second = documentFor('doc-second', 'pdfs/second.pdf', secondSource);
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifestFor([first, second]), null, 2)}\n`);
  let invocations = 0;
  let revalidations = 0;
  await assert.rejects(
    runRemoteOcrOffload({
      manifest: manifestPath,
      inputRoot,
      outputRoot,
      python: process.execPath,
      ocrScript,
      model: '/unused/model',
      mmproj: '/unused/mmproj',
      llamaRepo: '/unused/llama',
      llamaServerBin,
      llamaSystemdUnit,
      llamaUrl: workerConfiguration.llama_url,
      runtimeDevice,
      vlRecMaxConcurrency: 2,
      serverParallel: 2,
      microBatch: 4,
      useQueues: true,
    }, {
      invokeOcr: async () => {
        invocations += 1;
        throw new Error('OCR invocation failed after child ownership');
      },
      pageCounter: () => 2,
      runtime,
      llamaServerAttestation,
      pythonRuntime,
      paddlexLayoutModelCache,
      revalidateSharedRuntime: async () => {
        revalidations += 1;
        throw new Error('llama-server health probe failed during invocation recovery');
      },
      handleSignals: false,
    }),
    (error) => {
      assert.equal(error.name, 'SharedRuntimeConfigurationError');
      assert.match(error.message, /shared runtime revalidation failed.*llama-server health probe failed/);
      return true;
    },
  );
  assert.equal(invocations, 1);
  assert.equal(revalidations, 1);
  const runStatusPath = path.join(outputRoot, 'run-status.json');
  const documentStatusPath = path.join(outputRoot, 'status/doc-first.json');
  const runStatus = JSON.parse(await readFile(runStatusPath, 'utf8'));
  assert.equal(runStatus.documents['doc-first'].status, 'failed');
  assert.equal(runStatus.documents['doc-first'].attempts, 0);
  assert.equal(runStatus.documents['doc-first'].failure_class, 'shared_runtime_configuration');
  assert.equal(runStatus.documents['doc-first'].quarantine_reason, undefined);
  assert.equal(runStatus.documents['doc-second'].status, 'pending');
  assert.equal(runStatus.documents['doc-second'].attempts, 0);
  const documentStatus = JSON.parse(await readFile(documentStatusPath, 'utf8'));
  assert.equal(documentStatus.failure_class, 'shared_runtime_configuration');
  assert.equal(documentStatus.status, 'failed');
  for (const pathname of [documentStatusPath, runStatusPath]) {
    assert.equal(
      await readFile(`${pathname}.sha256`, 'utf8'),
      `${sha256(await readFile(pathname))}  ${path.basename(pathname)}\n`,
    );
  }
});

test('transient recovery preserves completed pages and lets healthy documents run before backoff retries', async (t) => {
  const { root, inputRoot, outputRoot, ocrScript } = await fixture(t);
  const retrySource = 'retry source';
  const healthySource = 'healthy source';
  await writeFile(path.join(inputRoot, 'pdfs/retry.pdf'), retrySource);
  await writeFile(path.join(inputRoot, 'pdfs/healthy.pdf'), healthySource);
  const retryDocument = documentFor('doc-retry', 'pdfs/retry.pdf', retrySource);
  const healthyDocument = documentFor('doc-healthy', 'pdfs/healthy.pdf', healthySource);
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifestFor([retryDocument, healthyDocument]), null, 2)}\n`);
  const options = {
    manifest: manifestPath,
    inputRoot,
    outputRoot,
    python: process.execPath,
    ocrScript,
    model: '/unused/model',
    mmproj: '/unused/mmproj',
    llamaRepo: '/unused/llama',
    llamaServerBin,
    llamaSystemdUnit,
    llamaUrl: workerConfiguration.llama_url,
    runtimeDevice,
    vlRecMaxConcurrency: 2,
    serverParallel: 2,
    microBatch: 4,
    useQueues: true,
  };
  let now = Date.parse('2026-07-16T00:00:00.000Z');
  const sleeps = [];
  const order = [];
  let retryInvocations = 0;
  let preservedPageHash;
  const invokeOcr = async (_command, arguments_, invocationOptions) => {
    const documentId = arguments_[1];
    order.push(documentId);
    assert.ok(!arguments_.includes('--force-reprocess'));
    if (documentId === retryDocument.id) {
      retryInvocations += 1;
      if (retryInvocations === 1) {
        ({ completedPageHash: preservedPageHash } = await createPartialOutput(outputRoot, retryDocument));
        await writeFile(
          invocationOptions.logPath,
          'SignalInfo: *** SIGTERM\nSignalInfo: *** SIGKILL\n',
          { mode: 0o600 },
        );
        return {
          code: null,
          signal: 'SIGKILL',
          monitorIncident: {
            type: 'idle_timeout',
            elapsed_seconds: 301,
            idle_seconds: 301,
            detected_at: new Date().toISOString(),
            termination_signals: ['SIGTERM', 'SIGKILL'],
          },
        };
      }
      assert.equal(
        sha256(await readFile(path.join(outputRoot, 'documents/doc-retry/pages/0001/content.md'))),
        preservedPageHash,
        'a retry must retain the already completed page artifact',
      );
      await createCompletedOutput(outputRoot, retryDocument);
      return { code: 0, signal: null };
    }
    await createCompletedOutput(outputRoot, healthyDocument);
    return { code: 0, signal: null };
  };
  const result = await runRemoteOcrOffload(options, {
    invokeOcr,
    pageCounter: () => 2,
    runtime,
    llamaServerAttestation,
    pythonRuntime,
    paddlexLayoutModelCache,
    revalidateSharedRuntime: healthySharedRuntimeRevalidation,
    handleSignals: false,
    nowMilliseconds: () => now,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(order, ['doc-retry', 'doc-healthy', 'doc-retry']);
  assert.deepEqual(sleeps, [2_000]);
  assert.equal(result.runStatus.documents['doc-retry'].attempts, 2);
  assert.equal(result.runStatus.documents['doc-retry'].status, 'complete');
  assert.equal(result.runStatus.documents['doc-healthy'].status, 'complete');
});

test('persistent OCR failure quarantines after five attempts and restart does not hammer it', async (t) => {
  const { root, inputRoot, outputRoot, ocrScript } = await fixture(t);
  const source = 'persistent failure source';
  await writeFile(path.join(inputRoot, 'pdfs/failing.pdf'), source);
  const document = documentFor('doc-failing', 'pdfs/failing.pdf', source);
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifestFor([document]), null, 2)}\n`);
  const options = {
    manifest: manifestPath,
    inputRoot,
    outputRoot,
    python: process.execPath,
    ocrScript,
    model: '/unused/model',
    mmproj: '/unused/mmproj',
    llamaRepo: '/unused/llama',
    llamaServerBin,
    llamaSystemdUnit,
    llamaUrl: workerConfiguration.llama_url,
    runtimeDevice,
    vlRecMaxConcurrency: 2,
    serverParallel: 2,
    microBatch: 4,
    useQueues: true,
  };
  let now = Date.parse('2026-07-16T00:00:00.000Z');
  let invocations = 0;
  let preservedPageHash;
  const sleeps = [];
  const dependencies = {
    invokeOcr: async () => {
      invocations += 1;
      if (invocations === 1) {
        ({ completedPageHash: preservedPageHash } = await createPartialOutput(outputRoot, document));
      } else {
        assert.equal(
          sha256(await readFile(path.join(outputRoot, 'documents/doc-failing/pages/0001/content.md'))),
          preservedPageHash,
          'terminal retries must retain the successful page artifact',
        );
      }
      return { code: 0, signal: null };
    },
    pageCounter: () => 2,
    runtime,
    llamaServerAttestation,
    pythonRuntime,
    paddlexLayoutModelCache,
    handleSignals: false,
    nowMilliseconds: () => now,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  };
  const first = await runRemoteOcrOffload(options, dependencies);
  assert.equal(first.exitCode, 12);
  assert.equal(invocations, 5);
  assert.deepEqual(sleeps, [2_000, 10_000, 30_000, 60_000]);
  assert.equal(first.runStatus.documents['doc-failing'].status, 'quarantined');
  assert.equal(first.runStatus.documents['doc-failing'].attempts, 5);
  assert.equal(first.runStatus.counts.quarantined, 1);
  assert.equal(first.runStatus.finished, false);
  assert.equal(first.runStatus.settled, true);

  const sleepCount = sleeps.length;
  const second = await runRemoteOcrOffload(options, dependencies);
  assert.equal(second.exitCode, 12);
  assert.equal(invocations, 5, 'a quarantined document must not be invoked again after restart');
  assert.equal(sleeps.length, sleepCount, 'a quarantined document must not schedule another backoff');
  assert.equal(second.runStatus.documents['doc-failing'].status, 'quarantined');
});
