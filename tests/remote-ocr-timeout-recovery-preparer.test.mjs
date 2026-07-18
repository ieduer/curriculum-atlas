import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cp,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildTimeoutRecoveryAuthorityIdentity,
  canonicalTimeoutRecoveryAuthorityRoot,
  prepareTimeoutRecoveryGrant,
} from '../scripts/prepare-timeout-recovery-grant.mjs';
import { validateOcrDocumentOutput } from '../scripts/run-remote-ocr-offload.mjs';
import { canonicalJson } from '../scripts/lib/remote-ocr-local-snapshot.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const legacyRunnerSha256 = 'b08c3f7aa3da6e44dd9fffeecaf20b2a020df4d604c9b957399abaf886d15a55';
const runtimeDevice = 'test CUDA recognizer with CPU layout';
const runtime = Object.freeze({
  pipeline: 'PaddleOCR-VL',
  pipeline_version: 'v1.6',
  model_sha256: 'a'.repeat(64),
  mmproj_sha256: 'b'.repeat(64),
  llama_commit: 'c'.repeat(40),
  render_dpi: 240,
});
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

function documentFor(id, sourcePath, contents, pageCount) {
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

function recoveryPolicy() {
  return {
    max_attempts: 5,
    backoff_seconds: [2, 10, 30, 60],
    terminal_status: 'quarantined',
    terminal_exit_code: 12,
    child_monitoring: {
      startup_timeout_seconds: 180,
      idle_timeout_seconds: 300,
      wall_floor_seconds: 1200,
      wall_seconds_per_page: 25,
      terminate_grace_seconds: 15,
      poll_interval_seconds: 5,
    },
  };
}

function workerConfiguration(predecessorRoot) {
  return {
    llama_url: 'http://127.0.0.1:8112/v1',
    vl_rec_max_concurrency: 4,
    server_parallel: 4,
    micro_batch: 16,
    use_queues: true,
    runtime_device: runtimeDevice,
    paddlex_cache_home: path.join(predecessorRoot, 'paddlex-cache'),
    python_runtime: pythonRuntime,
    paddlex_layout_model_cache_sha256: '9'.repeat(64),
  };
}

function productionAttestation() {
  return {
    schema_version: 1,
    systemd_unit: 'curriculum-ocr-llama.service',
    active_state: 'active',
    sub_state: 'running',
    binary_path: '/fixture/llama-server',
    binary_sha256: 'd'.repeat(64),
    version_sha256: 'e'.repeat(64),
    llama_commit_prefix: runtime.llama_commit.slice(0, 8),
    proc_cmdline_sha256: 'f'.repeat(64),
    model_path: '/fixture/model.gguf',
    model_sha256: runtime.model_sha256,
    mmproj_path: '/fixture/mmproj.gguf',
    mmproj_sha256: runtime.mmproj_sha256,
    host: '127.0.0.1',
    port: 8112,
    parallel: 4,
    production_command_contract: {
      values: {
        '--host': '127.0.0.1',
        '--port': '8112',
        '--parallel': '4',
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
    health_body_sha256: '0'.repeat(64),
  };
}

async function writeJsonWithHashSeal(pathname, value, mode = 0o600) {
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(pathname, raw, { mode });
  await writeFile(`${pathname}.sha256`, `${sha256(raw)}  ${path.basename(pathname)}\n`, { mode });
  return sha256(raw);
}

async function createDocumentTree(predecessorRoot, document, completedPageCount, worker) {
  const documentRoot = path.join(predecessorRoot, 'documents', document.id);
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
      citation_eligible: false,
    };
  }
  const state = {
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
    completed_pages: Array.from({ length: completedPageCount }, (_, index) => index + 1),
    failed_pages: {},
    pages,
    selected_pages: Array.from({ length: document.page_count }, (_, index) => index + 1),
    selected_pages_complete: completedPageCount === document.page_count,
  };
  await writeFile(path.join(documentRoot, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  return { documentRoot, state };
}

async function createPredecessorFixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'timeout-recovery-preparer-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputRoot = path.join(root, 'input');
  const predecessorRoot = path.join(root, 'a-r1');
  const ledgerRoot = canonicalTimeoutRecoveryAuthorityRoot(inputRoot);
  const manifestPath = path.join(root, 'manifest.json');
  await Promise.all([
    mkdir(path.join(inputRoot, 'pdfs'), { recursive: true }),
    mkdir(path.join(predecessorRoot, 'documents'), { recursive: true }),
    mkdir(path.join(predecessorRoot, 'status'), { recursive: true }),
    mkdir(path.join(predecessorRoot, 'logs'), { recursive: true }),
    mkdir(ledgerRoot, { recursive: true, mode: 0o700 }),
  ]);
  const specifications = [
    { id: 'complete-doc', pageCount: 2, completed: 2, status: 'complete' },
    { id: 'timeout-doc', pageCount: 3, completed: 1, status: 'quarantined' },
  ];
  const documents = [];
  for (const specification of specifications) {
    const contents = `source:${specification.id}`;
    const sourcePath = `pdfs/${specification.id}.pdf`;
    await writeFile(path.join(inputRoot, sourcePath), contents);
    documents.push(documentFor(specification.id, sourcePath, contents, specification.pageCount));
  }
  const manifest = manifestFor(documents);
  const manifestRaw = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestPath, manifestRaw, { mode: 0o600 });
  const manifestSha256 = sha256(manifestRaw);
  const worker = workerConfiguration(predecessorRoot);
  const llamaAttestation = productionAttestation();
  const llamaAttestationSha256 = sha256(`${JSON.stringify(llamaAttestation)}\n`);
  const runtimeFingerprint = {
    ...runtime,
    runtime_device: runtimeDevice,
    llama_server_attestation_sha256: llamaAttestationSha256,
    python_runtime: pythonRuntime,
    paddlex_layout_model_cache: {
      schema_version: 1,
      model_name: 'PP-DocLayoutV3',
      relative_root: 'official_models',
      file_count: 17,
      total_bytes: 132_005_144,
      tree_sha256: '9'.repeat(64),
    },
  };
  const runtimeFingerprintSha256 = sha256(`${JSON.stringify(runtimeFingerprint)}\n`);
  const progress = {};
  for (const specification of specifications) {
    const document = documents.find((value) => value.id === specification.id);
    const { documentRoot } = await createDocumentTree(
      predecessorRoot,
      document,
      specification.completed,
      worker,
    );
    const artifacts = await validateOcrDocumentOutput(document, documentRoot, runtime, {
      requireComplete: specification.status === 'complete',
      workerConfiguration: worker,
    });
    let status;
    if (specification.status === 'complete') {
      status = {
        schema_version: 1,
        document_id: specification.id,
        status: 'complete',
        source_sha256: document.source_sha256,
        page_count: specification.pageCount,
        runtime_fingerprint_sha256: runtimeFingerprintSha256,
        citation_allowed: false,
        whole_document_atomic: true,
        artifacts,
        verified_at: '2026-07-18T05:00:00.000Z',
      };
      progress[specification.id] = {
        status: 'complete',
        attempts: 1,
        page_count: specification.pageCount,
        started_at: '2026-07-18T04:00:00.000Z',
        completed_at: status.verified_at,
        verified_at: status.verified_at,
      };
    } else {
      const error = 'OCR child idle_timeout after 305s; terminated with SIGTERM';
      status = {
        schema_version: 1,
        document_id: specification.id,
        status: 'quarantined',
        attempt: 5,
        max_attempts: 5,
        page_count: specification.pageCount,
        runtime_fingerprint_sha256: runtimeFingerprintSha256,
        citation_allowed: false,
        quarantine_reason: 'attempt_budget_exhausted',
        error,
        quarantined_at: '2026-07-18T05:10:00.000Z',
      };
      progress[specification.id] = {
        status: 'quarantined',
        attempts: 5,
        page_count: specification.pageCount,
        started_at: '2026-07-18T04:30:00.000Z',
        failed_at: '2026-07-18T05:09:00.000Z',
        quarantined_at: status.quarantined_at,
        quarantine_reason: status.quarantine_reason,
        error,
      };
      await writeFile(
        path.join(predecessorRoot, 'logs', `${specification.id}.log`),
        Array.from(
          { length: 5 },
          (_, index) => `SignalInfo: *** SIGTERM attempt ${index + 1} for ${specification.id}\n`,
        ).join(''),
        { mode: 0o600 },
      );
    }
    const statusSha256 = await writeJsonWithHashSeal(
      path.join(predecessorRoot, 'status', `${specification.id}.json`),
      status,
    );
    progress[specification.id].status_json_sha256 = statusSha256;
  }
  const identity = {
    schema_version: 1,
    manifest_sha256: manifestSha256,
    runtime,
    runtime_fingerprint: runtimeFingerprint,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    llama_server_attestation: llamaAttestation,
    llama_server_attestation_sha256: llamaAttestationSha256,
    runner_script_sha256: legacyRunnerSha256,
    ocr_script_sha256: '8'.repeat(64),
    input_root: await realpath(inputRoot),
    python_invocation_path: process.execPath,
    python_resolved_target: await realpath(process.execPath),
    worker_configuration: worker,
    document_recovery: recoveryPolicy(),
    whole_document_atomic: true,
    citation_allowed: false,
  };
  await writeFile(
    path.join(predecessorRoot, 'run-identity.json'),
    `${JSON.stringify(identity, null, 2)}\n`,
    { mode: 0o600 },
  );
  const runStatus = {
    schema_version: 1,
    manifest_sha256: manifestSha256,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    document_recovery: recoveryPolicy(),
    citation_allowed: false,
    started_at: '2026-07-18T04:00:00.000Z',
    documents: progress,
    counts: {
      total: 2,
      complete: 1,
      failed: 0,
      interrupted: 0,
      pending: 0,
      running: 0,
      retry_wait: 0,
      quarantined: 1,
    },
    finished: false,
    settled: true,
  };
  await writeJsonWithHashSeal(path.join(predecessorRoot, 'run-status.json'), runStatus);
  const ledgerInfo = await stat(ledgerRoot, { bigint: true });
  const ledgerIdentity = buildTimeoutRecoveryAuthorityIdentity({
    ledgerRoot,
    predecessorInputRoot: await realpath(inputRoot),
    ledgerDevice: ledgerInfo.dev,
    ledgerInode: ledgerInfo.ino,
    ownerUid: ledgerInfo.uid,
    ownerGid: ledgerInfo.gid,
  });
  await writeJsonWithHashSeal(path.join(ledgerRoot, 'ledger-identity.json'), ledgerIdentity);
  return {
    root,
    inputRoot,
    predecessorRoot,
    ledgerRoot,
    manifestPath,
    timeoutLogPath: path.join(predecessorRoot, 'logs/timeout-doc.log'),
    grantPath: path.join(predecessorRoot, 'timeout-recovery-grant.json'),
  };
}

function optionsFor(fixture, overrides = {}) {
  return {
    manifest: fixture.manifestPath,
    predecessorRoot: fixture.predecessorRoot,
    ledgerRoot: fixture.ledgerRoot,
    ...overrides,
  };
}

async function mode(pathname) {
  return (await lstat(pathname)).mode & 0o777;
}

async function fingerprintFiles(paths) {
  return Promise.all(paths.map(async (pathname) => {
    const info = await stat(pathname, { bigint: true });
    return {
      pathname,
      ino: String(info.ino),
      size: String(info.size),
      mtimeNs: String(info.mtimeNs),
      sha256: sha256(await readFile(pathname)),
    };
  }));
}

test('default preview derives document evidence without mutating predecessor or ledger', async (t) => {
  const fixture = await createPredecessorFixture(t);
  const before = await fingerprintFiles([
    path.join(fixture.predecessorRoot, 'run-identity.json'),
    path.join(fixture.predecessorRoot, 'run-status.json'),
    fixture.timeoutLogPath,
    path.join(fixture.ledgerRoot, 'ledger-identity.json'),
    path.join(fixture.ledgerRoot, 'ledger-identity.json.sha256'),
  ]);
  const result = await prepareTimeoutRecoveryGrant(optionsFor(fixture));
  assert.equal(result.mode, 'preview');
  assert.equal(result.status, 'ready_to_apply');
  assert.equal(result.ledger.present, true);
  assert.equal(result.ledger.identity_present, true);
  assert.equal(result.grant.present, false);
  assert.equal(result.grant.documents.length, 1);
  assert.equal(result.grant.documents[0].document_id, 'timeout-doc');
  assert.equal(result.grant.documents[0].first_missing_page, 2);
  assert.equal(result.grant.incidents.length, 1);
  assert.equal(result.grant.incidents[0].present, false);
  await assert.rejects(lstat(fixture.grantPath), { code: 'ENOENT' });
  assert.deepEqual(await fingerprintFiles(before.map(({ pathname }) => pathname)), before);
});

test('apply preserves the deterministic pre-existing authority and durably installs all exact hash-sealed evidence', async (t) => {
  const fixture = await createPredecessorFixture(t);
  const identityPath = path.join(fixture.ledgerRoot, 'ledger-identity.json');
  const identityBefore = await fingerprintFiles([identityPath, `${identityPath}.sha256`]);
  const result = await prepareTimeoutRecoveryGrant(optionsFor(fixture, { apply: true }));
  assert.equal(result.status, 'applied');
  assert.equal(await mode(fixture.ledgerRoot), 0o700);
  assert.deepEqual(await fingerprintFiles([identityPath, `${identityPath}.sha256`]), identityBefore);
  const incidentPath = result.grant.incidents[0].path;
  const issuancePath = result.grant.issuance.path;
  const files = [
    identityPath,
    `${identityPath}.sha256`,
    incidentPath,
    `${incidentPath}.sha256`,
    issuancePath,
    `${issuancePath}.sha256`,
    fixture.grantPath,
    `${fixture.grantPath}.sha256`,
  ];
  for (const pathname of files) assert.equal(await mode(pathname), 0o600);
  const identity = JSON.parse(await readFile(identityPath, 'utf8'));
  assert.equal(identity.ledger_id, result.ledger.ledger_id);
  assert.match(identity.ledger_nonce, /^[a-f0-9]{64}$/u);
  const grantRaw = await readFile(fixture.grantPath);
  const grant = JSON.parse(grantRaw);
  assert.equal(grant.grant_id, result.grant.grant_id);
  assert.equal(grant.consumption.ledger_root, await realpath(fixture.ledgerRoot));
  assert.match(grant.consumption.ledger_device, /^\d+$/u);
  assert.match(grant.consumption.ledger_inode, /^\d+$/u);
  assert.equal(grant.documents.length, 1);
  assert.equal(grant.documents[0].document_id, 'timeout-doc');
  assert.equal(grant.documents[0].first_missing_page, 2);
  assert.equal(grant.documents[0].timeout_log.sha256, sha256(await readFile(fixture.timeoutLogPath)));
  assert.equal(
    await readFile(`${fixture.grantPath}.sha256`, 'utf8'),
    `${sha256(grantRaw)}  timeout-recovery-grant.json\n`,
  );
  const grantBasis = structuredClone(grant);
  delete grantBasis.grant_id;
  assert.equal(grant.grant_id, sha256(canonicalJson(grantBasis)));
  const incident = JSON.parse(await readFile(incidentPath, 'utf8'));
  assert.equal(incident.incident_type, 'curriculum_remote_ocr_child_timeout_incident');
  assert.equal(incident.evidence_origin, 'legacy_status_log_derivation_v1');
  assert.equal(incident.document_id, 'timeout-doc');
  assert.equal(incident.attempt, 5);
  assert.equal(incident.timeout_type, 'idle_timeout');
  assert.deepEqual(incident.termination_signals, ['SIGTERM']);
  assert.equal(incident.log.sha256, sha256(await readFile(fixture.timeoutLogPath)));
  assert.equal(incident.citation_allowed, false);
  const issuance = JSON.parse(await readFile(issuancePath, 'utf8'));
  assert.equal(issuance.claim_key, result.grant.issuance.claim_key);
  assert.equal(issuance.grant_id, grant.grant_id);
  assert.equal(issuance.incident_evidence[0].raw_sha256, sha256(await readFile(incidentPath)));
});

test('exact rerun is idempotent; mutable evidence sidecars may be repaired but the authority identity never is', async (t) => {
  const fixture = await createPredecessorFixture(t);
  const firstResult = await prepareTimeoutRecoveryGrant(optionsFor(fixture, { apply: true }));
  const identityPath = path.join(fixture.ledgerRoot, 'ledger-identity.json');
  const incidentPath = firstResult.grant.incidents[0].path;
  const issuancePath = firstResult.grant.issuance.path;
  const files = [
    identityPath,
    `${identityPath}.sha256`,
    incidentPath,
    `${incidentPath}.sha256`,
    issuancePath,
    `${issuancePath}.sha256`,
    fixture.grantPath,
    `${fixture.grantPath}.sha256`,
  ];
  const first = await fingerprintFiles(files);
  const idempotent = await prepareTimeoutRecoveryGrant(optionsFor(fixture, { apply: true }));
  assert.equal(idempotent.status, 'verified_idempotent');
  assert.deepEqual(await fingerprintFiles(files), first);

  await Promise.all([
    unlink(`${incidentPath}.sha256`),
    unlink(`${issuancePath}.sha256`),
    unlink(`${fixture.grantPath}.sha256`),
  ]);
  const rawBeforeRepair = await fingerprintFiles([identityPath, incidentPath, issuancePath, fixture.grantPath]);
  const repairPreview = await prepareTimeoutRecoveryGrant(optionsFor(fixture));
  assert.equal(repairPreview.status, 'ready_to_apply');
  assert.deepEqual(repairPreview.planned_writes.sort(), [
    `${incidentPath}.sha256`,
    `${issuancePath}.sha256`,
    `${fixture.grantPath}.sha256`,
  ].sort());
  const repaired = await prepareTimeoutRecoveryGrant(optionsFor(fixture, { apply: true }));
  assert.equal(repaired.status, 'applied');
  assert.deepEqual(
    await fingerprintFiles([identityPath, incidentPath, issuancePath, fixture.grantPath]),
    rawBeforeRepair,
  );
  assert.equal(await mode(`${incidentPath}.sha256`), 0o600);
  assert.equal(await mode(`${issuancePath}.sha256`), 0o600);
  assert.equal(await mode(`${fixture.grantPath}.sha256`), 0o600);

  await unlink(`${identityPath}.sha256`);
  await assert.rejects(
    prepareTimeoutRecoveryGrant(optionsFor(fixture, { apply: true })),
    /pre-existing hash-sealed canonical authority identity/u,
  );
  await assert.rejects(lstat(`${identityPath}.sha256`), { code: 'ENOENT' });
});

test('a missing hash seal is repaired only when the surviving raw grant is exact', async (t) => {
  const fixture = await createPredecessorFixture(t);
  await prepareTimeoutRecoveryGrant(optionsFor(fixture, { apply: true }));
  await unlink(`${fixture.grantPath}.sha256`);
  const changed = JSON.parse(await readFile(fixture.grantPath, 'utf8'));
  changed.documents[0].first_missing_page += 1;
  await writeFile(fixture.grantPath, `${JSON.stringify(changed, null, 2)}\n`);
  await assert.rejects(
    prepareTimeoutRecoveryGrant(optionsFor(fixture, { apply: true })),
    /differs from the directly inspected predecessor evidence/u,
  );
  await assert.rejects(lstat(`${fixture.grantPath}.sha256`), { code: 'ENOENT' });
});

test('preparation rejects evidence drift before the grant write', async (t) => {
  const fixture = await createPredecessorFixture(t);
  let mutated = false;
  await assert.rejects(
    prepareTimeoutRecoveryGrant(
      optionsFor(fixture, { apply: true }),
      {
        publicationHooks: {
          async afterTempSync({ pathname }) {
            if (!mutated && pathname.includes('/timeout-incidents/')) {
              mutated = true;
              await writeFile(fixture.timeoutLogPath, 'drifted timeout log\n', { mode: 0o600 });
            }
          },
        },
      },
    ),
    /drifted during preparation|log changed|log identity differs/u,
  );
  await assert.rejects(lstat(fixture.grantPath), { code: 'ENOENT' });
});

test('preparation rejects missing or symlinked logs and symlinked or nested authority roots', async (t) => {
  await t.test('missing log', async (subtest) => {
    const fixture = await createPredecessorFixture(subtest);
    await rm(fixture.timeoutLogPath);
    await assert.rejects(
      prepareTimeoutRecoveryGrant(optionsFor(fixture)),
      /timeout recovery log is missing/u,
    );
  });
  await t.test('symlinked log', async (subtest) => {
    const fixture = await createPredecessorFixture(subtest);
    const target = path.join(fixture.root, 'log-target');
    await writeFile(target, 'target\n', { mode: 0o600 });
    await rm(fixture.timeoutLogPath);
    await symlink(target, fixture.timeoutLogPath);
    await assert.rejects(
      prepareTimeoutRecoveryGrant(optionsFor(fixture)),
      /regular non-symlink file/u,
    );
  });
  await t.test('nested ledger', async (subtest) => {
    const fixture = await createPredecessorFixture(subtest);
    await assert.rejects(
      prepareTimeoutRecoveryGrant(optionsFor(fixture, {
        ledgerRoot: path.join(fixture.predecessorRoot, 'nested-ledger'),
      })),
      /single canonical authority root/u,
    );
  });
  await t.test('symlinked ledger', async (subtest) => {
    const fixture = await createPredecessorFixture(subtest);
    const target = path.join(fixture.root, 'real-ledger');
    await mkdir(target, { mode: 0o700 });
    await rm(fixture.ledgerRoot, { recursive: true });
    await symlink(target, fixture.ledgerRoot);
    await assert.rejects(
      prepareTimeoutRecoveryGrant(optionsFor(fixture)),
      /must not contain a symlink/u,
    );
  });
  await t.test('missing canonical authority', async (subtest) => {
    const fixture = await createPredecessorFixture(subtest);
    await rm(fixture.ledgerRoot, { recursive: true });
    await assert.rejects(
      prepareTimeoutRecoveryGrant(optionsFor(fixture)),
      /must be provisioned before grant preparation/u,
    );
  });
  await t.test('symlinked predecessor', async (subtest) => {
    const fixture = await createPredecessorFixture(subtest);
    const alias = path.join(fixture.root, 'a-r1-alias');
    await symlink(fixture.predecessorRoot, alias);
    await assert.rejects(
      prepareTimeoutRecoveryGrant(optionsFor(fixture, { predecessorRoot: alias })),
      /seed predecessor output root must be a real directory/u,
    );
  });
});

test('preparation rejects validly resealed grant drift and orphan sidecars', async (t) => {
  await t.test('grant drift', async (subtest) => {
    const fixture = await createPredecessorFixture(subtest);
    await prepareTimeoutRecoveryGrant(optionsFor(fixture, { apply: true }));
    const grant = JSON.parse(await readFile(fixture.grantPath, 'utf8'));
    grant.documents[0].timeout_log.sha256 = 'f'.repeat(64);
    const driftRaw = `${JSON.stringify(grant, null, 2)}\n`;
    await writeFile(fixture.grantPath, driftRaw);
    await writeFile(
      `${fixture.grantPath}.sha256`,
      `${sha256(driftRaw)}  timeout-recovery-grant.json\n`,
    );
    await assert.rejects(
      prepareTimeoutRecoveryGrant(optionsFor(fixture)),
      /differs from the directly inspected predecessor evidence/u,
    );
  });
  await t.test('orphan identity seal', async (subtest) => {
    const fixture = await createPredecessorFixture(subtest);
    await unlink(path.join(fixture.ledgerRoot, 'ledger-identity.json'));
    await assert.rejects(
      prepareTimeoutRecoveryGrant(optionsFor(fixture)),
      /orphan SHA-256 hash seal/u,
    );
  });
  await t.test('orphan grant seal', async (subtest) => {
    const fixture = await createPredecessorFixture(subtest);
    await writeFile(
      `${fixture.grantPath}.sha256`,
      `${'0'.repeat(64)}  timeout-recovery-grant.json\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      prepareTimeoutRecoveryGrant(optionsFor(fixture)),
      /orphan SHA-256 hash seal/u,
    );
  });
});

test('two concurrent apply calls converge through exclusive creation without semantic drift', async (t) => {
  const fixture = await createPredecessorFixture(t);
  const [left, right] = await Promise.all([
    prepareTimeoutRecoveryGrant(optionsFor(fixture, { apply: true })),
    prepareTimeoutRecoveryGrant(optionsFor(fixture, { apply: true })),
  ]);
  assert.equal(left.grant.grant_id, right.grant.grant_id);
  assert.equal(left.ledger.ledger_id, right.ledger.ledger_id);
  const identityPath = path.join(fixture.ledgerRoot, 'ledger-identity.json');
  const grantRaw = await readFile(fixture.grantPath);
  assert.equal(
    await readFile(`${fixture.grantPath}.sha256`, 'utf8'),
    `${sha256(grantRaw)}  timeout-recovery-grant.json\n`,
  );
  assert.equal(await mode(identityPath), 0o600);
  assert.equal(await mode(fixture.grantPath), 0o600);
  const issuance = (await readdir(fixture.ledgerRoot)).filter((entry) => entry.endsWith('.issuance.json'));
  assert.equal(issuance.length, 1);
});

test('exact p4 predecessor validation completes before any recovery evidence write', async (t) => {
  const fixture = await createPredecessorFixture(t);
  const identityPath = path.join(fixture.predecessorRoot, 'run-identity.json');
  const identity = JSON.parse(await readFile(identityPath, 'utf8'));
  identity.worker_configuration.server_parallel = 3;
  await writeFile(identityPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(
    prepareTimeoutRecoveryGrant(optionsFor(fixture, { apply: true })),
    /OCR worker configuration mismatch for server_parallel|exact p4\/vl4\/micro16\/queues worker/u,
  );
  await assert.rejects(lstat(fixture.grantPath), { code: 'ENOENT' });
  await assert.rejects(
    lstat(path.join(fixture.predecessorRoot, 'timeout-incidents')),
    { code: 'ENOENT' },
  );
  assert.deepEqual(
    (await readdir(fixture.ledgerRoot)).sort(),
    ['ledger-identity.json', 'ledger-identity.json.sha256'],
  );
});

test('authority identity, timeout log, and existing grant reject hard-linked inodes', async (t) => {
  await t.test('authority identity nlink', async (subtest) => {
    const fixture = await createPredecessorFixture(subtest);
    await link(
      path.join(fixture.ledgerRoot, 'ledger-identity.json'),
      path.join(fixture.root, 'identity-hardlink.json'),
    );
    await assert.rejects(
      prepareTimeoutRecoveryGrant(optionsFor(fixture)),
      /single-link (?:regular )?file owned by the current uid\/gid/u,
    );
  });
  await t.test('timeout log nlink', async (subtest) => {
    const fixture = await createPredecessorFixture(subtest);
    await link(fixture.timeoutLogPath, path.join(fixture.root, 'timeout-log-hardlink.log'));
    await assert.rejects(
      prepareTimeoutRecoveryGrant(optionsFor(fixture)),
      /single-link (?:regular )?file owned by the current uid\/gid/u,
    );
  });
  await t.test('grant nlink', async (subtest) => {
    const fixture = await createPredecessorFixture(subtest);
    await prepareTimeoutRecoveryGrant(optionsFor(fixture, { apply: true }));
    await link(fixture.grantPath, path.join(fixture.root, 'grant-hardlink.json'));
    await assert.rejects(
      prepareTimeoutRecoveryGrant(optionsFor(fixture)),
      /single-link file owned by the current uid\/gid/u,
    );
  });
});

test('a validly sealed but arbitrary authority identity is rejected', async (t) => {
  const fixture = await createPredecessorFixture(t);
  const identityPath = path.join(fixture.ledgerRoot, 'ledger-identity.json');
  const identity = JSON.parse(await readFile(identityPath, 'utf8'));
  identity.ledger_nonce = '7'.repeat(64);
  identity.ledger_id = sha256(canonicalJson({
    schema_version: identity.schema_version,
    ledger_type: identity.ledger_type,
    ledger_nonce: identity.ledger_nonce,
    citation_allowed: false,
  }));
  await writeJsonWithHashSeal(identityPath, identity);
  await assert.rejects(
    prepareTimeoutRecoveryGrant(optionsFor(fixture, { apply: true })),
    /not the deterministic canonical authority/u,
  );
  await assert.rejects(lstat(fixture.grantPath), { code: 'ENOENT' });
});

test('copied predecessor roots converge on one deterministic issuance claim', async (t) => {
  const fixture = await createPredecessorFixture(t);
  const copyRoot = path.join(fixture.root, 'a-r1-copy');
  await cp(fixture.predecessorRoot, copyRoot, { recursive: true, preserveTimestamps: true });
  const [original, copied] = await Promise.all([
    prepareTimeoutRecoveryGrant(optionsFor(fixture, { apply: true })),
    prepareTimeoutRecoveryGrant({
      manifest: fixture.manifestPath,
      predecessorRoot: copyRoot,
      ledgerRoot: fixture.ledgerRoot,
      apply: true,
    }),
  ]);
  assert.equal(original.grant.grant_id, copied.grant.grant_id);
  assert.equal(original.grant.issuance.claim_key, copied.grant.issuance.claim_key);
  assert.deepEqual(
    await readFile(fixture.grantPath),
    await readFile(path.join(copyRoot, 'timeout-recovery-grant.json')),
  );
  const issuance = (await readdir(fixture.ledgerRoot)).filter((entry) => entry.endsWith('.issuance.json'));
  assert.equal(issuance.length, 1);
});

test('crash recovery never exposes partial final bytes and cleans only stale publication temps', async (t) => {
  await t.test('crash after temp fsync leaves no final and next apply recovers', async (subtest) => {
    const fixture = await createPredecessorFixture(subtest);
    let crashed = false;
    await assert.rejects(
      prepareTimeoutRecoveryGrant(
        optionsFor(fixture, { apply: true }),
        {
          publicationHooks: {
            afterTempSync({ pathname }) {
              if (!crashed && pathname.includes('/timeout-incidents/')) {
                crashed = true;
                const error = new Error('simulated crash after temp fsync');
                error.simulateProcessCrash = true;
                throw error;
              }
            },
          },
        },
      ),
      /simulated crash after temp fsync/u,
    );
    const incidentDirectory = path.join(fixture.predecessorRoot, 'timeout-incidents/timeout-doc');
    await assert.rejects(
      lstat(path.join(incidentDirectory, 'attempt-0005.json')),
      { code: 'ENOENT' },
    );
    assert.equal(
      (await readdir(incidentDirectory)).filter((entry) => entry.endsWith('.tmp')).length,
      1,
    );
    const recovered = await prepareTimeoutRecoveryGrant(optionsFor(fixture, { apply: true }));
    assert.equal(recovered.status, 'applied');
    assert.equal(
      (await readdir(incidentDirectory)).filter((entry) => entry.endsWith('.tmp')).length,
      0,
    );
    JSON.parse(await readFile(path.join(incidentDirectory, 'attempt-0005.json'), 'utf8'));
  });

  await t.test('crash after no-replace link leaves one complete final and next apply seals it', async (subtest) => {
    const fixture = await createPredecessorFixture(subtest);
    let crashed = false;
    await assert.rejects(
      prepareTimeoutRecoveryGrant(
        optionsFor(fixture, { apply: true }),
        {
          publicationHooks: {
            afterLink({ pathname }) {
              if (!crashed && pathname.includes('/timeout-incidents/')) {
                crashed = true;
                const error = new Error('simulated crash after hardlink publication');
                error.simulateProcessCrash = true;
                throw error;
              }
            },
          },
        },
      ),
      /simulated crash after hardlink publication/u,
    );
    const incidentPath = path.join(
      fixture.predecessorRoot,
      'timeout-incidents/timeout-doc/attempt-0005.json',
    );
    const incidentRaw = await readFile(incidentPath);
    JSON.parse(incidentRaw);
    await assert.rejects(lstat(`${incidentPath}.sha256`), { code: 'ENOENT' });
    const recovered = await prepareTimeoutRecoveryGrant(optionsFor(fixture, { apply: true }));
    assert.equal(recovered.status, 'applied');
    assert.equal(
      await readFile(`${incidentPath}.sha256`, 'utf8'),
      `${sha256(incidentRaw)}  attempt-0005.json\n`,
    );
  });
});

test('structured timeout incident and legacy signal evidence are tamper-evident', async (t) => {
  await t.test('legacy derivation requires one Paddle SIGTERM row per attempt', async (subtest) => {
    const fixture = await createPredecessorFixture(subtest);
    await writeFile(
      fixture.timeoutLogPath,
      Array.from({ length: 4 }, (_, index) => `SignalInfo: *** SIGTERM attempt ${index + 1}\n`).join(''),
      { mode: 0o600 },
    );
    await assert.rejects(
      prepareTimeoutRecoveryGrant(optionsFor(fixture, { apply: true })),
      /requires exactly 5 Paddle SIGTERM signal rows/u,
    );
  });
  await t.test('resealed incident cannot change its signal or log binding', async (subtest) => {
    const fixture = await createPredecessorFixture(subtest);
    const applied = await prepareTimeoutRecoveryGrant(optionsFor(fixture, { apply: true }));
    const incidentPath = applied.grant.incidents[0].path;
    const incident = JSON.parse(await readFile(incidentPath, 'utf8'));
    incident.termination_signals = ['SIGTERM', 'SIGKILL'];
    await writeJsonWithHashSeal(incidentPath, incident);
    await assert.rejects(
      prepareTimeoutRecoveryGrant(optionsFor(fixture)),
      /not the exact runner-emitted idle-timeout incident/u,
    );
  });
});

test('logical authority recreation changes inode identity and fails closed', async (t) => {
  const fixture = await createPredecessorFixture(t);
  const identityPath = path.join(fixture.ledgerRoot, 'ledger-identity.json');
  const identityRaw = await readFile(identityPath);
  const identitySealRaw = await readFile(`${identityPath}.sha256`);
  await rm(fixture.ledgerRoot, { recursive: true });
  await mkdir(fixture.ledgerRoot, { mode: 0o700 });
  await writeFile(identityPath, identityRaw, { mode: 0o600 });
  await writeFile(`${identityPath}.sha256`, identitySealRaw, { mode: 0o600 });
  await assert.rejects(
    prepareTimeoutRecoveryGrant(optionsFor(fixture, { apply: true })),
    /not the deterministic canonical authority/u,
  );
  await assert.rejects(lstat(fixture.grantPath), { code: 'ENOENT' });
});
