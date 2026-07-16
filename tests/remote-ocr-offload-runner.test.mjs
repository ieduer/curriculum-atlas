import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  preflightDocument,
  fingerprintPaddlexLayoutModelCache,
  invokeOcrChild,
  probePythonOcrRuntime,
  runRemoteOcrOffload,
  terminateOwnedChild,
  validateLlamaSystemdUnitName,
  validateOcrDocumentOutput,
  validateRemoteOcrManifest,
  verifyLlamaServerAttestation,
  verifyPinnedRuntime,
} from '../scripts/run-remote-ocr-offload.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
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
  production_command_contract: {
    values: { '--host': '127.0.0.1', '--port': '8112', '--parallel': '2' },
    flags: ['--mmproj-offload'],
  },
  health_url: 'http://127.0.0.1:8112/health',
  health_status_code: 200,
  health_status: 'ok',
  health_body_sha256: '0'.repeat(64),
});
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

async function createCompletedOutput(outputRoot, document, { citationEligible = false } = {}) {
  const documentRoot = path.join(outputRoot, 'documents', document.id);
  const pages = {};
  for (let pageNumber = 1; pageNumber <= document.page_count; pageNumber += 1) {
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
      recognizer_server_url: workerConfiguration.llama_url,
      dpi: runtime.render_dpi,
      device: runtimeDevice,
      python: pythonRuntime.python_version,
      paddlepaddle: pythonRuntime.packages.paddlepaddle,
      paddleocr: pythonRuntime.packages.paddleocr,
      paddlex: pythonRuntime.packages.paddlex,
      vl_rec_max_concurrency: workerConfiguration.vl_rec_max_concurrency,
      server_parallel: workerConfiguration.server_parallel,
      micro_batch: workerConfiguration.micro_batch,
      use_queues: workerConfiguration.use_queues,
    },
    completed_pages: selectedPages,
    failed_pages: {},
    pages,
    selected_pages: selectedPages,
    selected_pages_complete: true,
  }, null, 2)}\n`);
  return documentRoot;
}

async function createPartialOutput(outputRoot, document) {
  const documentRoot = await createCompletedOutput(outputRoot, document);
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
  const resolvedServerBinary = await realpath(serverBinary);

  const serverArguments = [
    resolvedServerBinary,
    '--model', model,
    '--mmproj', mmproj,
    '--host', '127.0.0.1',
    '--port', '8112',
    '--parallel', '4',
    '--temp', '0',
    '--ctx-size', '32768',
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
  wrongModelArguments[wrongModelArguments.indexOf(model)] = mmproj;
  await assert.rejects(
    verifyLlamaServerAttestation(runtime, options, {
      ...dependencies,
      readProcCmdline: async () => Buffer.from(`${wrongModelArguments.join('\0')}\0`),
    }),
    /model argument does not resolve to the pinned model/,
  );
  const wrongParallelArguments = [...serverArguments];
  wrongParallelArguments[wrongParallelArguments.indexOf('4')] = '3';
  await assert.rejects(
    verifyLlamaServerAttestation(runtime, options, {
      ...dependencies,
      readProcCmdline: async () => Buffer.from(`${wrongParallelArguments.join('\0')}\0`),
    }),
    /--parallel must equal 4, received 3/,
  );
  const missingMetricsArguments = serverArguments.filter((argument) => argument !== '--metrics');
  await assert.rejects(
    verifyLlamaServerAttestation(runtime, options, {
      ...dependencies,
      readProcCmdline: async () => Buffer.from(`${missingMetricsArguments.join('\0')}\0`),
    }),
    /must set --metrics exactly once/,
  );
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
      startup_timeout_seconds: 0.2,
      idle_timeout_seconds: 0.15,
      wall_timeout_seconds: 0.2,
      terminate_grace_seconds: 0.05,
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
  const invokeOcr = async (_command, arguments_) => {
    const documentId = arguments_[1];
    order.push(documentId);
    assert.ok(!arguments_.includes('--force-reprocess'));
    if (documentId === retryDocument.id) {
      retryInvocations += 1;
      if (retryInvocations === 1) {
        ({ completedPageHash: preservedPageHash } = await createPartialOutput(outputRoot, retryDocument));
        return {
          code: null,
          signal: 'SIGKILL',
          monitorIncident: {
            type: 'idle_timeout',
            elapsed_seconds: 301,
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
