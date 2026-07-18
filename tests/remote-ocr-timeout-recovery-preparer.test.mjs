import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
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
import { prepareTimeoutRecoveryGrant } from '../scripts/prepare-timeout-recovery-grant.mjs';
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
    vl_rec_max_concurrency: 2,
    server_parallel: 2,
    micro_batch: 4,
    use_queues: true,
    runtime_device: runtimeDevice,
    paddlex_cache_home: path.join(predecessorRoot, 'paddlex-cache'),
    python_runtime: pythonRuntime,
    paddlex_layout_model_cache_sha256: '9'.repeat(64),
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
  const ledgerRoot = path.join(root, 'ledger-authority');
  const manifestPath = path.join(root, 'manifest.json');
  await Promise.all([
    mkdir(path.join(inputRoot, 'pdfs'), { recursive: true }),
    mkdir(path.join(predecessorRoot, 'documents'), { recursive: true }),
    mkdir(path.join(predecessorRoot, 'status'), { recursive: true }),
    mkdir(path.join(predecessorRoot, 'logs'), { recursive: true }),
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
  const llamaAttestation = { schema_version: 1, test_owner: 'fixture' };
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
        `bounded timeout log for ${specification.id}\n`,
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
  ]);
  const result = await prepareTimeoutRecoveryGrant(optionsFor(fixture));
  assert.equal(result.mode, 'preview');
  assert.equal(result.status, 'ready_to_apply');
  assert.equal(result.ledger.present, false);
  assert.equal(result.grant.present, false);
  assert.deepEqual(result.grant.documents, [{ document_id: 'timeout-doc', first_missing_page: 2 }]);
  await assert.rejects(lstat(fixture.ledgerRoot), { code: 'ENOENT' });
  await assert.rejects(lstat(fixture.grantPath), { code: 'ENOENT' });
  assert.deepEqual(await fingerprintFiles(before.map(({ pathname }) => pathname)), before);
});

test('apply uses a 32-byte nonce and durably installs exact 0700/0600 hash-sealed files', async (t) => {
  const fixture = await createPredecessorFixture(t);
  let nonceLength = null;
  const result = await prepareTimeoutRecoveryGrant(
    optionsFor(fixture, { apply: true }),
    {
      randomBytes(length) {
        nonceLength = length;
        return Buffer.alloc(length, 0xab);
      },
    },
  );
  assert.equal(nonceLength, 32);
  assert.equal(result.status, 'applied');
  assert.equal(await mode(fixture.ledgerRoot), 0o700);
  const identityPath = path.join(fixture.ledgerRoot, 'ledger-identity.json');
  const files = [
    identityPath,
    `${identityPath}.sha256`,
    fixture.grantPath,
    `${fixture.grantPath}.sha256`,
  ];
  for (const pathname of files) assert.equal(await mode(pathname), 0o600);
  const identity = JSON.parse(await readFile(identityPath, 'utf8'));
  assert.equal(identity.ledger_nonce, 'ab'.repeat(32));
  assert.equal(identity.ledger_id, result.ledger.ledger_id);
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
});

test('exact rerun is idempotent and partial hash-seal repair never rewrites raw files', async (t) => {
  const fixture = await createPredecessorFixture(t);
  await prepareTimeoutRecoveryGrant(
    optionsFor(fixture, { apply: true }),
    { randomBytes: (length) => Buffer.alloc(length, 0x11) },
  );
  const identityPath = path.join(fixture.ledgerRoot, 'ledger-identity.json');
  const files = [identityPath, `${identityPath}.sha256`, fixture.grantPath, `${fixture.grantPath}.sha256`];
  const first = await fingerprintFiles(files);
  const idempotent = await prepareTimeoutRecoveryGrant(
    optionsFor(fixture, { apply: true }),
    { randomBytes: () => { throw new Error('nonce must not be regenerated'); } },
  );
  assert.equal(idempotent.status, 'verified_idempotent');
  assert.deepEqual(await fingerprintFiles(files), first);

  await Promise.all([unlink(`${identityPath}.sha256`), unlink(`${fixture.grantPath}.sha256`)]);
  const rawBeforeRepair = await fingerprintFiles([identityPath, fixture.grantPath]);
  const repairPreview = await prepareTimeoutRecoveryGrant(optionsFor(fixture));
  assert.equal(repairPreview.status, 'ready_to_apply');
  assert.deepEqual(repairPreview.planned_writes.sort(), [
    `${identityPath}.sha256`,
    `${fixture.grantPath}.sha256`,
  ].sort());
  const repaired = await prepareTimeoutRecoveryGrant(
    optionsFor(fixture, { apply: true }),
    { randomBytes: () => { throw new Error('nonce must not be regenerated'); } },
  );
  assert.equal(repaired.status, 'applied');
  assert.deepEqual(await fingerprintFiles([identityPath, fixture.grantPath]), rawBeforeRepair);
  assert.equal(await mode(`${identityPath}.sha256`), 0o600);
  assert.equal(await mode(`${fixture.grantPath}.sha256`), 0o600);
});

test('a missing hash seal is repaired only when the surviving raw grant is exact', async (t) => {
  const fixture = await createPredecessorFixture(t);
  await prepareTimeoutRecoveryGrant(
    optionsFor(fixture, { apply: true }),
    { randomBytes: (length) => Buffer.alloc(length, 0x22) },
  );
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
  await assert.rejects(
    prepareTimeoutRecoveryGrant(
      optionsFor(fixture, { apply: true }),
      {
        randomBytes(length) {
          writeFileSync(fixture.timeoutLogPath, 'drifted timeout log\n');
          return Buffer.alloc(length, 0x33);
        },
      },
    ),
    /drifted during preparation/u,
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
      /must be disjoint from predecessor root/u,
    );
  });
  await t.test('symlinked ledger', async (subtest) => {
    const fixture = await createPredecessorFixture(subtest);
    const target = path.join(fixture.root, 'real-ledger');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, fixture.ledgerRoot);
    await assert.rejects(
      prepareTimeoutRecoveryGrant(optionsFor(fixture)),
      /must not contain a symlink/u,
    );
  });
  await t.test('missing ledger parent', async (subtest) => {
    const fixture = await createPredecessorFixture(subtest);
    await assert.rejects(
      prepareTimeoutRecoveryGrant(optionsFor(fixture, {
        ledgerRoot: path.join(fixture.root, 'missing-parent/ledger'),
      })),
      /parent must be an existing real directory/u,
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
    await prepareTimeoutRecoveryGrant(
      optionsFor(fixture, { apply: true }),
      { randomBytes: (length) => Buffer.alloc(length, 0x44) },
    );
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
    await mkdir(fixture.ledgerRoot, { mode: 0o700 });
    await writeFile(
      path.join(fixture.ledgerRoot, 'ledger-identity.json.sha256'),
      `${'0'.repeat(64)}  ledger-identity.json\n`,
      { mode: 0o600 },
    );
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
    prepareTimeoutRecoveryGrant(
      optionsFor(fixture, { apply: true }),
      { randomBytes: (length) => Buffer.alloc(length, 0x55) },
    ),
    prepareTimeoutRecoveryGrant(
      optionsFor(fixture, { apply: true }),
      { randomBytes: (length) => Buffer.alloc(length, 0x66) },
    ),
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
});
