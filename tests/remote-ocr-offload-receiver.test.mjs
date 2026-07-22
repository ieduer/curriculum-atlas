import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
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
import {
  operatorContinuationReceiptDocument,
  parseReceiverArguments,
  receiveRemoteOcrOffload,
  validateP4ToP1SeedDelta,
} from '../scripts/receive-remote-ocr-offload.mjs';
import {
  continueOperatorInterruptedAttempt,
  operatorContinuationPaths,
} from '../scripts/continue-remote-ocr-operator-interruption.mjs';
import {
  EXACT_A2_FORWARD_CONTINUATION_INCIDENT,
  validateA2ForwardContinuationProfile,
} from '../scripts/lib/remote-ocr-operator-continuation.mjs';
import {
  fingerprintPaddlexLayoutModelCache,
} from '../scripts/run-remote-ocr-offload.mjs';
import {
  canonicalJson,
  captureLocalReprocessSnapshot,
  inspectTree,
  inspectTreeInventory,
} from '../scripts/lib/remote-ocr-local-snapshot.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const legacyB1OcrScriptSha256 = 'b4ea873026fb4d2da2efb921ddac3974a48db703143ff53aff3ebeae48d9b048';
const seedAwareOcrScriptSha256 = '3176d267c681b2764d4ff81f7e7b6748c174ee62854a11a2529ccfb355a364f3';
const auditedCommonInferenceSuffixSha256 = '4edade704624f0bac5bcd76eeb113a07452a57040e4fd949609d319f49c2b4ca';
const a2BaseRunnerSha256 = '0fbf3d284f324f5faa710ca09342cdef88d24e6349b6e5d590ccca215065354d';
const seedAwareTransition = 'p4_to_p1_seed_aware_ocr_v2';
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
  python_version: '3.13.12',
  packages: {
    paddlepaddle: '3.3.1',
    paddleocr: '3.7.0',
    paddlex: '3.7.2',
    pypdfium2: '5.12.0',
  },
});
const layoutCacheFiles = Object.freeze({
  'inference.json': '{"fixture":true}\n',
  'inference.pdiparams': 'fixture-parameters\n',
  'inference.yml': 'fixture: true\n',
});
const layoutCacheEntries = Object.entries(layoutCacheFiles).map(([name, contents]) => ({
  path: `PP-DocLayoutV3/${name}`,
  bytes: Buffer.byteLength(contents),
  sha256: sha256(contents),
})).sort((left, right) => left.path.localeCompare(right.path));
const layoutCache = Object.freeze({
  schema_version: 1,
  model_name: 'PP-DocLayoutV3',
  relative_root: 'official_models',
  file_count: layoutCacheEntries.length,
  total_bytes: layoutCacheEntries.reduce((sum, entry) => sum + entry.bytes, 0),
  tree_sha256: sha256(`${JSON.stringify(layoutCacheEntries)}\n`),
});

async function materializeLayoutCache(shardRoot) {
  const layoutModelRoot = path.join(
    shardRoot,
    'paddlex-cache/official_models/PP-DocLayoutV3',
  );
  await mkdir(layoutModelRoot, { recursive: true });
  await Promise.all(Object.entries(layoutCacheFiles).map(
    ([name, contents]) => writeFile(path.join(layoutModelRoot, name), contents),
  ));
  assert.deepEqual(
    await fingerprintPaddlexLayoutModelCache(path.join(shardRoot, 'paddlex-cache')),
    layoutCache,
  );
}
function llamaAttestation(parallel, procCharacter) {
  return {
    schema_version: 1,
    systemd_unit: 'curriculum-ocr-llama.service',
    active_state: 'active',
    sub_state: 'running',
    binary_path: '/fixture/llama-server',
    binary_sha256: '1'.repeat(64),
    version_sha256: '2'.repeat(64),
    llama_commit_prefix: runtime.llama_commit.slice(0, 8),
    proc_cmdline_sha256: procCharacter.repeat(64),
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
    health_body_sha256: '3'.repeat(64),
  };
}
const attestation = Object.freeze(llamaAttestation(4, '4'));
const attestationSha256 = sha256(`${JSON.stringify(attestation)}\n`);
const p1Attestation = Object.freeze(llamaAttestation(1, '5'));
const p1AttestationSha256 = sha256(`${JSON.stringify(p1Attestation)}\n`);
const runtimeDevice = 'cpu+NVIDIA RTX 3060 Laptop GPU CUDA llama.cpp';
const runtimeFingerprint = Object.freeze({
  ...runtime,
  runtime_device: runtimeDevice,
  llama_server_attestation_sha256: attestationSha256,
  python_runtime: pythonRuntime,
  paddlex_layout_model_cache: layoutCache,
});
const runtimeFingerprintSha256 = sha256(`${JSON.stringify(runtimeFingerprint)}\n`);
const p1RuntimeFingerprint = Object.freeze({
  ...runtimeFingerprint,
  llama_server_attestation_sha256: p1AttestationSha256,
});
const p1RuntimeFingerprintSha256 = sha256(`${JSON.stringify(p1RuntimeFingerprint)}\n`);
const workerConfiguration = Object.freeze({
  llama_url: 'http://127.0.0.1:8112/v1',
  vl_rec_max_concurrency: 4,
  server_parallel: 4,
  micro_batch: 16,
  use_queues: true,
  runtime_device: runtimeDevice,
  paddlex_cache_home: '/fixture/paddlex-cache',
  python_runtime: pythonRuntime,
  paddlex_layout_model_cache_sha256: layoutCache.tree_sha256,
});
const recovery = Object.freeze({
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
});

async function pathExists(pathname) {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(pathname, value) {
  await mkdir(path.dirname(pathname), { recursive: true });
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(pathname, raw);
  return { raw, sha256: sha256(raw) };
}

async function writeSidecar(pathname, digest) {
  await writeFile(`${pathname}.sha256`, `${digest}  ${path.basename(pathname)}\n`);
}

function prefixTreeEntry(entry, prefix) {
  const directory = /^D\0([^\n]+)\n$/u.exec(entry);
  if (directory) return `D\0${prefix}/${directory[1]}\n`;
  const file = /^F\0([^\0\n]+)\0(\d+)\0([a-f0-9]{64})\n$/u.exec(entry);
  assert.ok(file, 'fixture tree entry must be a directory or regular file');
  return `F\0${prefix}/${file[1]}\0${file[2]}\0${file[3]}\n`;
}

async function virtualPredecessorTrees(documentRoot, completedPages, stateRaw) {
  const pagesEntries = [];
  let pageFiles = 0;
  let pageBytes = 0;
  for (const page of completedPages) {
    const pageName = String(page).padStart(4, '0');
    const inventory = await inspectTreeInventory(path.join(documentRoot, 'pages', pageName));
    pagesEntries.push(`D\0${pageName}\n`);
    pagesEntries.push(...inventory.entries.map((entry) => prefixTreeEntry(entry, pageName)));
    pageFiles += inventory.files;
    pageBytes += inventory.bytes;
  }
  const pagesTree = {
    tree_sha256: sha256(pagesEntries.join('')),
    files: pageFiles,
    bytes: pageBytes,
  };
  const documentEntries = [
    'D\0pages\n',
    ...pagesEntries.map((entry) => prefixTreeEntry(entry, 'pages')),
    `F\0state.json\0${stateRaw.byteLength}\0${sha256(stateRaw)}\n`,
  ];
  return {
    pagesTree,
    documentTree: {
      tree_sha256: sha256(documentEntries.join('')),
      files: pageFiles + 1,
      bytes: pageBytes + stateRaw.byteLength,
    },
  };
}

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

function documentFor(id, sourcePath, source, pageCount) {
  return {
    id,
    title: id,
    subject: '语文',
    priority: 1,
    source_path: sourcePath,
    source_sha256: sha256(source),
    source_bytes: Buffer.byteLength(source),
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

function renderedSha256(documentId, page) {
  return sha256(`rendered:${documentId}:${page}`);
}

function nativeAsset(name, contents = Buffer.from('fixture Paddle JPEG bytes')) {
  const match = /^img_in_(header_image_box|image_box|footer_image_box|chart_box)_(\d+)_(\d+)_(\d+)_(\d+)\.jpg$/u.exec(name);
  assert.ok(match, `invalid fixture Paddle asset name: ${name}`);
  const labels = {
    header_image_box: 'header_image',
    image_box: 'image',
    footer_image_box: 'footer_image',
    chart_box: 'chart',
  };
  return {
    name,
    contents,
    blockLabel: labels[match[1]],
    bbox: match.slice(2).map(Number),
  };
}

function runIdentity(manifestSha256, shardRoot) {
  return {
    schema_version: 1,
    manifest_sha256: manifestSha256,
    runtime: { ...runtime },
    runtime_fingerprint: runtimeFingerprint,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    llama_server_attestation: attestation,
    llama_server_attestation_sha256: attestationSha256,
    runner_script_sha256: 'b08c3f7aa3da6e44dd9fffeecaf20b2a020df4d604c9b957399abaf886d15a55',
    ocr_script_sha256: 'f'.repeat(64),
    input_root: '/fixture/input',
    python_invocation_path: '/fixture/python',
    python_resolved_target: '/fixture/python3.13',
    worker_configuration: {
      ...workerConfiguration,
      paddlex_cache_home: path.join(shardRoot, 'paddlex-cache'),
    },
    document_recovery: recovery,
    whole_document_atomic: true,
    citation_allowed: false,
  };
}

async function createRepairManifest(shardRoot, repairPages, documents, pageTexts, { finalTextMismatch = false } = {}) {
  if (!repairPages.size) return null;
  const documentById = new Map(documents.map((document) => [document.id, document]));
  const evidenceRoot = path.join(path.dirname(shardRoot), `${path.basename(shardRoot)}-repair-evidence`);
  await mkdir(evidenceRoot, { recursive: true });
  const repairDocuments = new Map();
  const pageByKey = new Map();
  for (const key of [...repairPages].sort()) {
    const [documentId, pageRaw] = key.split(':');
    const page = Number(pageRaw);
    const document = documentById.get(documentId);
    const text = pageTexts.get(documentId)[page - 1];
    const renderedEvidence = `rendered:${documentId}:${page}`;
    const onlineEvidence = `same-edition-online:${documentId}:${page}`;
    const renderedPath = `${documentId}-page-${String(page).padStart(4, '0')}.png`;
    const onlinePath = `${documentId}-page-${String(page).padStart(4, '0')}-online.txt`;
    await Promise.all([
      writeFile(path.join(evidenceRoot, renderedPath), renderedEvidence),
      writeFile(path.join(evidenceRoot, onlinePath), onlineEvidence),
    ]);
    const manifestPage = {
      physical_pdf_page: page,
      citation_eligible: false,
      rendered_image_sha256: sha256(renderedEvidence),
      final_text: finalTextMismatch ? `${text}mismatch` : text,
      final_text_sha256: sha256(finalTextMismatch ? `${text}mismatch` : text),
      evidence: [
        {
          kind: 'rendered_page_image',
          path: renderedPath,
          sha256: sha256(renderedEvidence),
        },
        {
          kind: 'same_edition_online_text',
          path: onlinePath,
          sha256: sha256(onlineEvidence),
        },
      ],
    };
    if (!repairDocuments.has(documentId)) {
      repairDocuments.set(documentId, {
        document_id: documentId,
        source_sha256: document.source_sha256,
        page_count: document.page_count,
        citation_allowed: false,
        pages: [],
      });
    }
    repairDocuments.get(documentId).pages.push(manifestPage);
    pageByKey.set(key, manifestPage);
  }
  const pathname = path.join(evidenceRoot, 'repair-manifest.json');
  const manifest = {
    schema_version: 1,
    manifest_type: 'curriculum_remote_ocr_page_repair',
    repair_id: `repair-${path.basename(shardRoot)}`,
    method: 'human_image_and_same_edition_online_adjudication',
    citation_allowed: false,
    documents: [...repairDocuments.values()],
  };
  const written = await writeJson(pathname, {
    ...manifest,
  });
  await writeSidecar(pathname, written.sha256);
  return {
    evidenceRoot,
    manifest,
    manifestPath: pathname,
    manifestSha256: written.sha256,
    pageByKey,
  };
}

async function createShard({
  manifestPath,
  shardRoot,
  documents,
  pageTexts,
  statuses = {},
  repairPages = new Set(),
  repairCitationEligible = false,
  repairFinalTextMismatch = false,
  nativeAssets = new Map(),
  bindNativeAssets = true,
}) {
  const shardManifest = manifestFor(documents);
  const manifestWritten = await writeJson(manifestPath, shardManifest);
  await mkdir(shardRoot, { recursive: true });
  const canonicalShardRoot = await realpath(shardRoot);
  const repair = await createRepairManifest(
    shardRoot,
    repairPages,
    documents,
    pageTexts,
    { finalTextMismatch: repairFinalTextMismatch },
  );
  await writeJson(
    path.join(shardRoot, 'run-identity.json'),
    runIdentity(manifestWritten.sha256, canonicalShardRoot),
  );
  const runDocuments = {};
  const countByStatus = { complete: 0, quarantined: 0 };
  const repairReceiptDocuments = [];

  for (const document of documents) {
    const documentRoot = path.join(shardRoot, 'documents', document.id);
    const pages = {};
    const pageArtifacts = [];
    for (let page = 1; page <= document.page_count; page += 1) {
      const pageRoot = path.join(documentRoot, 'pages', String(page).padStart(4, '0'));
      await mkdir(pageRoot, { recursive: true });
      const content = pageTexts.get(document.id)[page - 1];
      const repaired = repairPages.has(`${document.id}:${page}`);
      const pageNativeAssets = nativeAssets.get(`${document.id}:${page}`) || [];
      let result;
      let provenance = null;
      if (repaired) {
        const manifestPage = repair.pageByKey.get(`${document.id}:${page}`);
        const artifactText = content;
        provenance = {
          schema_version: 1,
          repair_manifest_sha256: repair.manifestSha256,
          repair_id: repair.manifest.repair_id,
          method: repair.manifest.method,
          base_failure: {
            error: 'RuntimeError: llama PEG-native 500 parser rejected output',
            recorded_at: '2026-07-16T00:30:00.000Z',
          },
          citation_eligible: repairCitationEligible,
        };
        result = `${JSON.stringify({
          schema_version: 1,
          result_type: 'curriculum_remote_ocr_page_repair',
          document_id: document.id,
          physical_pdf_page: page,
          text: artifactText,
          final_text_sha256: sha256(artifactText),
          citation_eligible: false,
          repair_provenance: provenance,
        }, null, 2)}\n`;
        await mkdir(path.join(pageRoot, 'markdown'), { recursive: true });
        await writeFile(
          path.join(pageRoot, 'markdown', `page-${String(page).padStart(4, '0')}.md`),
          artifactText,
        );
        assert.equal(manifestPage.rendered_image_sha256, renderedSha256(document.id, page));
      } else {
        const parsingBlocks = bindNativeAssets
          ? pageNativeAssets.map((asset, index) => ({
              block_label: asset.blockLabel,
              block_content: '',
              block_bbox: asset.bbox,
              block_id: index,
              block_order: null,
              group_id: index,
              block_polygon_points: [],
            }))
          : [];
        result = `${JSON.stringify({
          input_path: `/tmp/page-${String(page).padStart(4, '0')}.png`,
          page_index: null,
          page_count: null,
          width: 1600,
          height: 2200,
          model_settings: {
            use_doc_preprocessor: false,
            use_layout_detection: true,
          },
          parsing_res_list: parsingBlocks,
          layout_det_res: {
            input_path: null,
            page_index: null,
            boxes: bindNativeAssets
              ? pageNativeAssets.map((asset, index) => ({
                  cls_id: 14,
                  label: asset.blockLabel,
                  score: 0.9,
                  coordinate: asset.bbox,
                  order: null,
                  polygon_points: [],
                  fixture_index: index,
                }))
              : [],
          },
        }, null, 2)}\n`;
        const markdownRoot = path.join(pageRoot, 'markdown');
        await mkdir(markdownRoot, { recursive: true });
        await writeFile(
          path.join(markdownRoot, `page-${String(page).padStart(4, '0')}.md`),
          content,
        );
        if (pageNativeAssets.length) {
          const imagesRoot = path.join(markdownRoot, 'imgs');
          await mkdir(imagesRoot, { recursive: true });
          for (const asset of pageNativeAssets) {
            await writeFile(path.join(imagesRoot, asset.name), asset.contents);
          }
        }
      }
      await writeFile(path.join(pageRoot, 'result.json'), result);
      await writeFile(path.join(pageRoot, 'content.md'), content);
      const statePage = {
        status: 'ocr_complete_pending_audit',
        physical_pdf_page: page,
        rendered_image_sha256: renderedSha256(document.id, page),
        result_json_sha256: sha256(result),
        content_markdown_sha256: sha256(content),
        citation_eligible: false,
      };
      if (provenance) statePage.repair_provenance = provenance;
      pages[String(page)] = statePage;
      pageArtifacts.push({
        page_number: page,
        rendered_image_sha256: statePage.rendered_image_sha256,
        result_json_sha256: statePage.result_json_sha256,
        content_markdown_sha256: statePage.content_markdown_sha256,
        citation_eligible: false,
      });
    }
    const selectedPages = Array.from({ length: document.page_count }, (_, index) => index + 1);
    const stateWritten = await writeJson(path.join(documentRoot, 'state.json'), {
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
    });
    const repairedPageNumbers = [...repairPages]
      .filter((key) => key.startsWith(`${document.id}:`))
      .map((key) => Number(key.split(':')[1]))
      .sort((left, right) => left - right);
    if (repairedPageNumbers.length) {
      repairReceiptDocuments.push({
        document_id: document.id,
        source_sha256: document.source_sha256,
        page_count: document.page_count,
        state_before_sha256: sha256(`before-repair:${document.id}`),
        state_after_sha256: stateWritten.sha256,
        pages: repairedPageNumbers.map((page) => {
          const statePage = pages[String(page)];
          const manifestPage = repair.pageByKey.get(`${document.id}:${page}`);
          return {
            physical_pdf_page: page,
            rendered_image_sha256: statePage.rendered_image_sha256,
            final_text_sha256: manifestPage.final_text_sha256,
            result_json_sha256: statePage.result_json_sha256,
            content_markdown_sha256: statePage.content_markdown_sha256,
            citation_eligible: false,
          };
        }),
      });
    }
    const status = statuses[document.id] || 'complete';
    const statusPath = path.join(shardRoot, 'status', `${document.id}.json`);
    const statusValue = status === 'complete'
      ? {
          schema_version: 1,
          document_id: document.id,
          status: 'complete',
          source_sha256: document.source_sha256,
          page_count: document.page_count,
          runtime_fingerprint_sha256: runtimeFingerprintSha256,
          citation_allowed: false,
          whole_document_atomic: true,
          verified_at: '2026-07-16T00:30:00.000Z',
          artifacts: {
            state_sha256: stateWritten.sha256,
            page_artifacts_sha256: sha256(`${JSON.stringify(pageArtifacts)}\n`),
            page_artifacts: pageArtifacts,
          },
        }
      : {
          schema_version: 1,
          document_id: document.id,
          status: 'quarantined',
          attempt: 5,
          max_attempts: 5,
          page_count: document.page_count,
          runtime_fingerprint_sha256: runtimeFingerprintSha256,
          citation_allowed: false,
          quarantine_reason: 'attempt_budget_exhausted',
          error: 'OCR child exited 1',
        };
    const statusWritten = await writeJson(statusPath, statusValue);
    await writeSidecar(statusPath, statusWritten.sha256);
    runDocuments[document.id] = {
      status,
      attempts: status === 'complete' ? 1 : 5,
      page_count: document.page_count,
      status_json_sha256: statusWritten.sha256,
      ...(status === 'complete' ? { verified_at: statusValue.verified_at } : {}),
    };
    countByStatus[status] += 1;
  }

  const runStatusPath = path.join(shardRoot, 'run-status.json');
  const runStatusWritten = await writeJson(runStatusPath, {
    schema_version: 1,
    manifest_sha256: manifestWritten.sha256,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    document_recovery: recovery,
    citation_allowed: false,
    started_at: '2026-07-16T00:00:00.000Z',
    updated_at: '2026-07-16T01:00:00.000Z',
    settled: true,
    finished: countByStatus.quarantined === 0,
    counts: {
      total: documents.length,
      complete: countByStatus.complete,
      failed: 0,
      interrupted: 0,
      pending: 0,
      running: 0,
      retry_wait: 0,
      quarantined: countByStatus.quarantined,
    },
    documents: runDocuments,
  });
  await writeSidecar(runStatusPath, runStatusWritten.sha256);
  if (repair) {
    const repairReceiptPath = path.join(
      shardRoot,
      'repair-receipts',
      `${repair.manifest.repair_id}.json`,
    );
    const repairReceiptWritten = await writeJson(repairReceiptPath, {
      schema_version: 1,
      receipt_type: 'curriculum_remote_ocr_page_repair_receipt',
      repair_id: repair.manifest.repair_id,
      repair_manifest_sha256: repair.manifestSha256,
      method: repair.manifest.method,
      citation_allowed: false,
      status: 'applied',
      applied_at: '2026-07-16T00:45:00.000Z',
      documents: repairReceiptDocuments,
    });
    await writeSidecar(repairReceiptPath, repairReceiptWritten.sha256);
  }
  return {
    manifestPath,
    shardRoot,
    repairManifestPath: repair?.manifestPath || null,
  };
}

async function convertShardToHashBoundSeed(shard, {
  tamper = null,
  timeoutRecovery = null,
  transition = null,
  successorRunnerScriptSha256 = 'e'.repeat(64),
  successorPaddlexCacheHome = null,
} = {}) {
  const canonicalShardRoot = await realpath(shard.shardRoot);
  const shardRootInfo = await stat(canonicalShardRoot, { bigint: true });
  await materializeLayoutCache(canonicalShardRoot);
  const identityPath = path.join(shard.shardRoot, 'run-identity.json');
  const runStatusPath = path.join(shard.shardRoot, 'run-status.json');
  let identityRaw = await readFile(identityPath);
  const predecessorIdentity = JSON.parse(identityRaw);
  const predecessorRunStatusRaw = await readFile(runStatusPath);
  const predecessorRunStatus = JSON.parse(predecessorRunStatusRaw);
  const predecessorRunStatusSidecar = await readFile(`${runStatusPath}.sha256`);
  const shardManifestRaw = await readFile(shard.manifestPath);
  const shardManifest = JSON.parse(shardManifestRaw);
  const seedAware = transition === seedAwareTransition;
  const p4ToP1 = transition === 'p4_to_p1_v1' || seedAware;
  assert.ok(
    transition === null || p4ToP1,
    'fixture transition must be null or an audited p4-to-p1 transition',
  );
  if (seedAware) {
    predecessorIdentity.ocr_script_sha256 = legacyB1OcrScriptSha256;
    identityRaw = Buffer.from(`${JSON.stringify(predecessorIdentity, null, 2)}\n`);
    await writeFile(identityPath, identityRaw);
  }
  const successorAttestation = p4ToP1 ? p1Attestation : attestation;
  const successorAttestationSha256 = p4ToP1 ? p1AttestationSha256 : attestationSha256;
  const successorRuntimeFingerprint = p4ToP1 ? p1RuntimeFingerprint : runtimeFingerprint;
  const successorRuntimeFingerprintSha256 = p4ToP1
    ? p1RuntimeFingerprintSha256
    : runtimeFingerprintSha256;
  const successorWorker = {
    ...workerConfiguration,
    vl_rec_max_concurrency: 1,
    server_parallel: p4ToP1 ? 1 : 4,
    paddlex_cache_home: successorPaddlexCacheHome || path.join(canonicalShardRoot, 'paddlex-cache'),
  };
  const successorRecovery = {
    ...recovery,
    child_monitoring: {
      ...recovery.child_monitoring,
      idle_timeout_seconds: 1200,
    },
  };
  const predecessorDocuments = [];
  const documentContexts = [];

  for (const document of shardManifest.documents) {
    const timeoutRecoveryDocument = timeoutRecovery?.documents.get(document.id) || null;
    const documentRoot = path.join(shard.shardRoot, 'documents', document.id);
    const statePath = path.join(documentRoot, 'state.json');
    if (tamper === 'raw_state_configuration'
      && document.id === shardManifest.documents[0].id) {
      const reboundState = JSON.parse(await readFile(statePath, 'utf8'));
      reboundState.configuration.device = `${reboundState.configuration.device} coherent-rebind`;
      await writeJson(statePath, reboundState);
    }
    const stateRaw = await readFile(statePath);
    const state = JSON.parse(stateRaw);
    const predecessorConfigurationSha256 = sha256(canonicalJson(state.configuration));
    const statusPath = path.join(shard.shardRoot, 'status', `${document.id}.json`);
    const statusRaw = await readFile(statusPath);
    const statusSidecarRaw = await readFile(`${statusPath}.sha256`);
    const status = JSON.parse(statusRaw);
    const timeoutIncident = timeoutRecoveryDocument
      ? (() => {
          const recordedAt = status.quarantined_at;
          const elapsedSeconds = 300;
          const value = {
            schema_version: 1,
            incident_type: 'curriculum_remote_ocr_child_timeout_incident',
            evidence_origin: 'runner_emitted_v1',
            document_id: document.id,
            attempt: 5,
            timeout_type: 'idle_timeout',
            child_started_at: new Date(Date.parse(recordedAt) - elapsedSeconds * 1_000).toISOString(),
            detected_at: recordedAt,
            recorded_at: recordedAt,
            elapsed_seconds: elapsedSeconds,
            idle_seconds: elapsedSeconds,
            termination_signals: ['SIGTERM'],
            monitoring_policy: {
              ...recovery.child_monitoring,
              wall_timeout_seconds: Math.max(
                recovery.child_monitoring.wall_floor_seconds,
                recovery.child_monitoring.wall_seconds_per_page * document.page_count,
              ),
            },
            runtime_fingerprint_sha256: runtimeFingerprintSha256,
            log: timeoutRecoveryDocument.timeoutLog,
            citation_allowed: false,
          };
          const raw = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
          const relativePath = `timeout-incidents/${document.id}/attempt-0005.json`;
          const sidecarRaw = Buffer.from(`${sha256(raw)}  attempt-0005.json\n`);
          return { value, raw, sidecarRaw, relativePath };
        })()
      : null;
    const predecessorTrees = timeoutRecoveryDocument
      ? await virtualPredecessorTrees(documentRoot, state.completed_pages, stateRaw)
      : null;
    const predecessorDocumentTree = predecessorTrees?.documentTree || await inspectTree(documentRoot);
    const predecessorPagesTree = predecessorTrees?.pagesTree || await inspectTree(path.join(documentRoot, 'pages'));
    const inheritedPageArtifacts = [];
    for (const page of state.completed_pages) {
      const statePage = state.pages[String(page)];
      const pageTree = await inspectTree(path.join(documentRoot, 'pages', String(page).padStart(4, '0')));
      inheritedPageArtifacts.push({
        physical_pdf_page: page,
        rendered_image_sha256: statePage.rendered_image_sha256,
        result_json_sha256: statePage.result_json_sha256,
        content_markdown_sha256: statePage.content_markdown_sha256,
        page_tree_sha256: pageTree.tree_sha256,
        page_tree_files: pageTree.files,
        page_tree_bytes: pageTree.bytes,
        citation_allowed: false,
      });
    }
    predecessorDocuments.push({
      document_id: document.id,
      page_count: document.page_count,
      predecessor_status: predecessorRunStatus.documents[document.id].status,
      predecessor_status_format: timeoutRecoveryDocument
        ? 'timeout_only_quarantine_granted_v1'
        : 'legacy_b1_complete_reverified',
      inherited_attempts: predecessorRunStatus.documents[document.id].attempts,
      completed_pages: state.completed_pages,
      failed_pages: [],
      predecessor_document_tree: predecessorDocumentTree,
      predecessor_pages_tree: predecessorPagesTree,
      predecessor_state_sha256: sha256(stateRaw),
      predecessor_configuration_sha256: predecessorConfigurationSha256,
      predecessor_status_sha256: sha256(statusRaw),
      predecessor_status_sidecar_sha256: sha256(statusSidecarRaw),
      inherited_page_artifacts: inheritedPageArtifacts,
      inherited_page_artifacts_sha256: sha256(canonicalJson(inheritedPageArtifacts)),
      ...(timeoutRecoveryDocument ? { timeout_log: timeoutRecoveryDocument.timeoutLog } : {}),
    });
    documentContexts.push({
      document,
      documentRoot,
      statePath,
      state,
      stateRaw,
      statusPath,
      status,
      statusRaw,
      statusSidecarRaw,
      predecessorConfigurationSha256,
      timeoutRecoveryDocument,
      timeoutIncident,
    });
  }

  if (tamper === 'duplicate_artifact_page') {
    const document = predecessorDocuments.find((item) => item.inherited_page_artifacts.length > 1);
    assert.ok(document, 'tamper fixture requires a multi-page predecessor');
    document.inherited_page_artifacts[1] = structuredClone(document.inherited_page_artifacts[0]);
    document.inherited_page_artifacts_sha256 = sha256(canonicalJson(document.inherited_page_artifacts));
  }

  const manifestSha256 = sha256(shardManifestRaw);
  const runIdentitySha256 = sha256(identityRaw);
  const runStatusSha256 = sha256(predecessorRunStatusRaw);
  const inheritedPages = predecessorDocuments.reduce(
    (sum, document) => sum + document.completed_pages.length,
    0,
  );
  const pageArtifactsSha256 = sha256(canonicalJson(predecessorDocuments.flatMap(
    (document) => document.inherited_page_artifacts.map(
      (page) => ({ document_id: document.document_id, ...page }),
    ),
  )));
  const predecessorEvidenceRoot = path.join(shard.shardRoot, 'seed-predecessor-evidence');
  const evidenceRawFiles = [
    ['run-identity.json', identityRaw],
    ['run-status.json', predecessorRunStatusRaw],
    ['run-status.json.sha256', predecessorRunStatusSidecar],
  ];
  for (const context of documentContexts) {
    evidenceRawFiles.push(
      [`documents/${context.document.id}/state.json`, context.stateRaw],
      [`status/${context.document.id}.json`, context.statusRaw],
      [`status/${context.document.id}.json.sha256`, context.statusSidecarRaw],
    );
    if (context.timeoutRecoveryDocument) {
      evidenceRawFiles.push([
        context.timeoutRecoveryDocument.timeoutLog.path,
        context.timeoutRecoveryDocument.timeoutLogRaw,
      ]);
      evidenceRawFiles.push(
        [context.timeoutIncident.relativePath, context.timeoutIncident.raw],
        [`${context.timeoutIncident.relativePath}.sha256`, context.timeoutIncident.sidecarRaw],
      );
    }
  }
  evidenceRawFiles.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  for (const [relativePath, raw] of evidenceRawFiles) {
    const pathname = path.join(predecessorEvidenceRoot, relativePath);
    await mkdir(path.dirname(pathname), { recursive: true });
    await writeFile(pathname, raw);
  }
  const evidenceRecord = (relativePath, raw) => ({
    path: relativePath,
    bytes: raw.length,
    sha256: sha256(raw),
  });
  const evidenceDocuments = documentContexts.map((context) => ({
    document_id: context.document.id,
    predecessor_status: predecessorRunStatus.documents[context.document.id].status,
    state: {
      present: true,
      ...evidenceRecord(`documents/${context.document.id}/state.json`, context.stateRaw),
    },
    status: {
      present: true,
      ...evidenceRecord(`status/${context.document.id}.json`, context.statusRaw),
      sidecar: evidenceRecord(
        `status/${context.document.id}.json.sha256`,
        context.statusSidecarRaw,
      ),
    },
    ...(context.timeoutRecoveryDocument ? {
      timeout_log: evidenceRecord(
        context.timeoutRecoveryDocument.timeoutLog.path,
        context.timeoutRecoveryDocument.timeoutLogRaw,
      ),
      timeout_incident: {
        document_id: context.document.id,
        attempt: 5,
        timeout_type: 'idle_timeout',
        evidence_origin: context.timeoutIncident.value.evidence_origin,
        raw: evidenceRecord(context.timeoutIncident.relativePath, context.timeoutIncident.raw),
        sidecar: evidenceRecord(
          `${context.timeoutIncident.relativePath}.sha256`,
          context.timeoutIncident.sidecarRaw,
        ),
        log_sha256: context.timeoutRecoveryDocument.timeoutLog.sha256,
        citation_allowed: false,
      },
    } : {}),
  }));
  const evidenceInventoryWritten = await writeJson(
    path.join(predecessorEvidenceRoot, 'inventory.json'),
    {
      schema_version: 1,
      evidence_type: 'curriculum_remote_ocr_seed_predecessor_controls',
      manifest_sha256: manifestSha256,
      runner_script_sha256: predecessorIdentity.runner_script_sha256,
      files: evidenceRawFiles.map(([relativePath, raw]) => evidenceRecord(relativePath, raw)),
      documents: evidenceDocuments,
      citation_allowed: false,
    },
  );
  const evidenceTree = await inspectTree(predecessorEvidenceRoot);
  const controlEvidence = {
    schema_version: 1,
    directory: 'seed-predecessor-evidence',
    inventory_sha256: evidenceInventoryWritten.sha256,
    tree_sha256: evidenceTree.tree_sha256,
    files: evidenceTree.files,
    bytes: evidenceTree.bytes,
  };
  const predecessorContractWithoutSnapshot = {
    manifest_sha256: manifestSha256,
    run_identity_sha256: runIdentitySha256,
    run_status_sha256: runStatusSha256,
    run_status_sidecar_sha256: sha256(predecessorRunStatusSidecar),
    runtime,
    runtime_fingerprint: runtimeFingerprint,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    runner_script_sha256: predecessorIdentity.runner_script_sha256,
    ocr_script_sha256: predecessorIdentity.ocr_script_sha256,
    worker_configuration: predecessorIdentity.worker_configuration,
    worker_configuration_sha256: sha256(canonicalJson(predecessorIdentity.worker_configuration)),
    document_recovery: recovery,
    document_recovery_sha256: sha256(canonicalJson(recovery)),
    completed_pages: inheritedPages,
    failed_pages: 0,
    quarantined_documents: timeoutRecovery?.documents.size || 0,
    page_artifacts_sha256: pageArtifactsSha256,
    control_evidence: controlEvidence,
  };
  if (tamper === 'predecessor_runtime_fingerprint') {
    predecessorContractWithoutSnapshot.runtime_fingerprint = {
      ...predecessorContractWithoutSnapshot.runtime_fingerprint,
      runtime_device: `${runtimeDevice} drift`,
    };
    predecessorContractWithoutSnapshot.runtime_fingerprint_sha256 = sha256(
      `${JSON.stringify(predecessorContractWithoutSnapshot.runtime_fingerprint)}\n`,
    );
  }
  let timeoutRecoveryEvidence = null;
  let timeoutRecoveryConsumptionEvidence = null;
  if (timeoutRecovery) {
    const policy = {
      required_status: 'quarantined',
      required_inherited_attempts: 5,
      granted_attempt: 6,
      additional_attempts_per_document: 1,
      automatic_attempt_7: false,
      scope: 'all_timeout_quarantined_documents',
    };
    const grantDocuments = shardManifest.documents
      .filter((document) => timeoutRecovery.documents.has(document.id))
      .map((document) => {
        const context = documentContexts.find((item) => item.document.id === document.id);
        const predecessorDocument = predecessorDocuments.find((item) => item.document_id === document.id);
        const firstMissingPage = context.timeoutRecoveryDocument.firstMissingPage;
        return {
          document_id: document.id,
          predecessor_status_sha256: sha256(context.statusRaw),
          predecessor_state_sha256: sha256(context.stateRaw),
          inherited_attempts: 5,
          granted_attempt: 6,
          first_missing_page: firstMissingPage,
          completed_pages_sha256: sha256(canonicalJson(predecessorDocument.completed_pages)),
          failed_pages_sha256: sha256(canonicalJson(context.state.failed_pages)),
          quarantine_reason: 'attempt_budget_exhausted',
          error_sha256: sha256(context.status.error),
          classification: 'child_idle_timeout_only',
          timeout_log: context.timeoutRecoveryDocument.timeoutLog,
        };
      });
    const ledgerBasis = {
      schema_version: 1,
      ledger_type: 'curriculum_remote_ocr_timeout_recovery_consumption_ledger',
      ledger_nonce: sha256(`receiver-ledger:${shard.shardRoot}`),
      citation_allowed: false,
    };
    const ledger = {
      schema_version: ledgerBasis.schema_version,
      ledger_type: ledgerBasis.ledger_type,
      ledger_nonce: ledgerBasis.ledger_nonce,
      ledger_id: sha256(canonicalJson(ledgerBasis)),
      citation_allowed: false,
    };
    const grantBasis = {
      schema_version: 1,
      grant_type: 'curriculum_remote_ocr_timeout_recovery_grant',
      mode: 'one_additional_attempt_per_document',
      predecessor: {
        manifest_sha256: manifestSha256,
        run_identity_sha256: runIdentitySha256,
        run_status_sha256: runStatusSha256,
      },
      policy,
      consumption: {
        ledger_id: ledger.ledger_id,
        ledger_root: path.join(shard.shardRoot, 'authoritative-timeout-ledger'),
        ledger_device: '1',
        ledger_inode: '1',
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
    const grantPath = path.join(shard.shardRoot, 'timeout-recovery-grant.json');
    const grantWritten = await writeJson(grantPath, grant);
    await writeSidecar(grantPath, grantWritten.sha256);
    const grantSidecarRaw = await readFile(`${grantPath}.sha256`);
    const summary = {
      grant_id: grant.grant_id,
      raw_sha256: grantWritten.sha256,
      sidecar_sha256: sha256(grantSidecarRaw),
      policy,
      documents: grantDocuments,
    };
    for (const grantDocument of grantDocuments) {
      const predecessorDocument = predecessorDocuments.find(
        (document) => document.document_id === grantDocument.document_id,
      );
      const context = documentContexts.find(
        (document) => document.document.id === grantDocument.document_id,
      );
      const incidentRelativePath = `seed-predecessor-evidence/${context.timeoutIncident.relativePath}`;
      predecessorDocument.timeout_recovery = {
        grant_id: grant.grant_id,
        grant_raw_sha256: grantWritten.sha256,
        granted_attempt: 6,
        first_missing_page: grantDocument.first_missing_page,
        predecessor_log: {
          ...grantDocument.timeout_log,
          path: `seed-predecessor-evidence/${grantDocument.timeout_log.path}`,
        },
        predecessor_incident: {
          document_id: grantDocument.document_id,
          attempt: 5,
          timeout_type: 'idle_timeout',
          evidence_origin: context.timeoutIncident.value.evidence_origin,
          path: incidentRelativePath,
          sidecar_path: `${incidentRelativePath}.sha256`,
          raw_sha256: sha256(context.timeoutIncident.raw),
          sidecar_sha256: sha256(context.timeoutIncident.sidecarRaw),
          log_sha256: grantDocument.timeout_log.sha256,
          citation_allowed: false,
        },
      };
    }
    const issuanceClaimKey = sha256(canonicalJson({
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
      claim_key: issuanceClaimKey,
      ledger_id: ledger.ledger_id,
      predecessor: structuredClone(grant.predecessor),
      grant_id: grant.grant_id,
      grant_raw_sha256: grantWritten.sha256,
      incident_evidence: grantDocuments.map((grantDocument) => {
        const context = documentContexts.find(
          (document) => document.document.id === grantDocument.document_id,
        );
        return {
          document_id: grantDocument.document_id,
          attempt: 5,
          timeout_type: 'idle_timeout',
          raw_sha256: sha256(context.timeoutIncident.raw),
          sidecar_sha256: sha256(context.timeoutIncident.sidecarRaw),
          log_sha256: grantDocument.timeout_log.sha256,
        };
      }),
      citation_allowed: false,
    };
    const issuanceRelativePath = `timeout-recovery-issuance/${issuanceClaimKey}.issuance.json`;
    const issuancePath = path.join(shard.shardRoot, issuanceRelativePath);
    const issuanceWritten = await writeJson(issuancePath, issuance);
    await writeSidecar(issuancePath, issuanceWritten.sha256);
    const issuanceSidecarRaw = await readFile(`${issuancePath}.sha256`);
    const issuanceSummary = {
      schema_version: 1,
      claim_key: issuanceClaimKey,
      ledger_id: ledger.ledger_id,
      path: issuanceRelativePath,
      sidecar_path: `${issuanceRelativePath}.sha256`,
      raw_sha256: issuanceWritten.sha256,
      sidecar_sha256: sha256(issuanceSidecarRaw),
      citation_allowed: false,
    };
    timeoutRecoveryEvidence = {
      grant,
      grantPath,
      grantRawSha256: grantWritten.sha256,
      grantSidecarSha256: sha256(grantSidecarRaw),
      summary,
      ledger,
      issuance,
      issuancePath,
      issuanceRawSha256: issuanceWritten.sha256,
      issuanceSidecarSha256: sha256(issuanceSidecarRaw),
      issuanceSummary,
    };
  }
  const seedBasisPredecessorDocuments = predecessorDocuments.map((document) => {
    const { timeout_recovery: _timeoutRecovery, ...predecessorDocument } = document;
    return predecessorDocument;
  });
  const predecessorSnapshot = {
    manifest_sha256: predecessorContractWithoutSnapshot.manifest_sha256,
    run_identity_sha256: predecessorContractWithoutSnapshot.run_identity_sha256,
    run_status_sha256: predecessorContractWithoutSnapshot.run_status_sha256,
    run_status_sidecar_sha256: predecessorContractWithoutSnapshot.run_status_sidecar_sha256,
    runtime_fingerprint_sha256: predecessorContractWithoutSnapshot.runtime_fingerprint_sha256,
    worker_configuration_sha256: predecessorContractWithoutSnapshot.worker_configuration_sha256,
    document_recovery_sha256: predecessorContractWithoutSnapshot.document_recovery_sha256,
    completed_pages: predecessorContractWithoutSnapshot.completed_pages,
    failed_pages: predecessorContractWithoutSnapshot.failed_pages,
    quarantined_documents: predecessorContractWithoutSnapshot.quarantined_documents,
    page_artifacts_sha256: predecessorContractWithoutSnapshot.page_artifacts_sha256,
    ...(timeoutRecoveryEvidence ? {
      timeout_recovery_grant_id: timeoutRecoveryEvidence.grant.grant_id,
      timeout_recovery_grant_raw_sha256: timeoutRecoveryEvidence.grantRawSha256,
      timeout_recovery_grant_sidecar_sha256: timeoutRecoveryEvidence.grantSidecarSha256,
    } : {}),
    documents: seedBasisPredecessorDocuments,
  };
  const predecessorContract = {
    ...predecessorContractWithoutSnapshot,
    snapshot_sha256: sha256(canonicalJson(predecessorSnapshot)),
  };
  const successorContract = {
    runtime,
    runtime_fingerprint: successorRuntimeFingerprint,
    runtime_fingerprint_sha256: successorRuntimeFingerprintSha256,
    worker_configuration: successorWorker,
    worker_configuration_sha256: sha256(canonicalJson(successorWorker)),
    document_recovery: successorRecovery,
    document_recovery_sha256: sha256(canonicalJson(successorRecovery)),
    runner_script_sha256: successorRunnerScriptSha256,
    ocr_script_sha256: seedAware
      ? seedAwareOcrScriptSha256
      : predecessorIdentity.ocr_script_sha256,
    citation_allowed: false,
  };
  const p4ToP1CommonDelta = {
    vl_rec_max_concurrency: { predecessor: 4, successor: 1 },
    server_parallel: { predecessor: 4, successor: 1 },
    paddlex_cache_home: {
      predecessor: predecessorIdentity.worker_configuration.paddlex_cache_home,
      successor: successorWorker.paddlex_cache_home,
      tree_sha256: layoutCache.tree_sha256,
    },
    child_idle_timeout_seconds: { predecessor: 300, successor: 1200 },
    llama_server_attestation: {
      predecessor_sha256: attestationSha256,
      successor_sha256: successorAttestationSha256,
      proc_cmdline_sha256: {
        predecessor: attestation.proc_cmdline_sha256,
        successor: successorAttestation.proc_cmdline_sha256,
      },
      parallel: { predecessor: 4, successor: 1 },
      production_command_parallel: { predecessor: '4', successor: '1' },
    },
    runtime_fingerprint: {
      predecessor_sha256: runtimeFingerprintSha256,
      successor_sha256: successorRuntimeFingerprintSha256,
    },
  };
  const allowedConfigurationDelta = seedAware ? {
    schema_version: 3,
    transition: seedAwareTransition,
    ocr_script_transition: {
      schema_version: 1,
      transition: 'b1_legacy_to_seed_aware_v1',
      predecessor_sha256: legacyB1OcrScriptSha256,
      successor_sha256: seedAwareOcrScriptSha256,
      audited_common_inference_suffix_sha256: auditedCommonInferenceSuffixSha256,
    },
    ...p4ToP1CommonDelta,
  } : p4ToP1 ? {
    schema_version: 2,
    transition: 'p4_to_p1_v1',
    ...p4ToP1CommonDelta,
  } : {
    schema_version: 1,
    vl_rec_max_concurrency: { predecessor: 4, successor: 1 },
    paddlex_cache_home: {
      predecessor: predecessorIdentity.worker_configuration.paddlex_cache_home,
      successor: successorWorker.paddlex_cache_home,
      tree_sha256: layoutCache.tree_sha256,
    },
    child_idle_timeout_seconds: { predecessor: 300, successor: 1200 },
  };
  const seedBasis = {
    schema_version: 1,
    mode: 'hash_bound_output_seed',
    manifest_sha256: manifestSha256,
    predecessor: predecessorContract,
    successor_contract: successorContract,
    allowed_configuration_delta: allowedConfigurationDelta,
    ...(timeoutRecoveryEvidence ? { timeout_recovery_grant: timeoutRecoveryEvidence.summary } : {}),
    ...(timeoutRecoveryEvidence ? {
      timeout_recovery_issuance: timeoutRecoveryEvidence.issuanceSummary,
    } : {}),
    documents: seedBasisPredecessorDocuments,
    citation_allowed: false,
  };
  const seedId = sha256(canonicalJson(seedBasis));
  if (timeoutRecoveryEvidence) {
    const ledgerPath = path.join(shard.shardRoot, 'timeout-recovery-ledger-identity.json');
    const ledgerWritten = await writeJson(ledgerPath, timeoutRecoveryEvidence.ledger);
    await writeSidecar(ledgerPath, ledgerWritten.sha256);
    const claim = {
      schema_version: 1,
      claim_type: 'curriculum_remote_ocr_timeout_recovery_consumption_claim',
      claim_mode: 'atomic_single_claim',
      ledger_id: timeoutRecoveryEvidence.ledger.ledger_id,
      ledger_root: timeoutRecoveryEvidence.grant.consumption.ledger_root,
      ledger_device: timeoutRecoveryEvidence.grant.consumption.ledger_device,
      ledger_inode: timeoutRecoveryEvidence.grant.consumption.ledger_inode,
      grant_id: timeoutRecoveryEvidence.grant.grant_id,
      grant_raw_sha256: timeoutRecoveryEvidence.grantRawSha256,
      predecessor: structuredClone(timeoutRecoveryEvidence.grant.predecessor),
      granted_documents: timeoutRecoveryEvidence.grant.documents.map((document) => ({
        document_id: document.document_id,
        predecessor_status_sha256: document.predecessor_status_sha256,
        predecessor_state_sha256: document.predecessor_state_sha256,
        inherited_attempts: document.inherited_attempts,
        granted_attempt: document.granted_attempt,
      })),
      successor: {
        seed_id: seedId,
        output_root: canonicalShardRoot,
        output_device: String(shardRootInfo.dev),
        output_inode: String(shardRootInfo.ino),
      },
      citation_allowed: false,
    };
    const claimPath = path.join(shard.shardRoot, 'timeout-recovery-consumption-claim.json');
    const claimWritten = await writeJson(claimPath, claim);
    await writeSidecar(claimPath, claimWritten.sha256);
    const [ledgerSidecarRaw, claimSidecarRaw] = await Promise.all([
      readFile(`${ledgerPath}.sha256`),
      readFile(`${claimPath}.sha256`),
    ]);
    timeoutRecoveryConsumptionEvidence = {
      ledgerPath,
      ledgerSha256: ledgerWritten.sha256,
      ledgerSidecarSha256: sha256(ledgerSidecarRaw),
      claimPath,
      claimSha256: claimWritten.sha256,
      claimSidecarSha256: sha256(claimSidecarRaw),
      summary: {
        ledger_id: timeoutRecoveryEvidence.ledger.ledger_id,
        ledger_identity_sha256: ledgerWritten.sha256,
        ledger_identity_sidecar_sha256: sha256(ledgerSidecarRaw),
        claim_mode: 'atomic_single_claim',
        claim_sha256: claimWritten.sha256,
        claim_sidecar_sha256: sha256(claimSidecarRaw),
      },
    };
  }
  const successorStatuses = new Map();
  const receiptDocuments = [];

  for (const context of documentContexts) {
    const {
      document,
      documentRoot,
      statePath,
      state,
      statusPath,
      status,
      statusRaw,
      predecessorConfigurationSha256,
      timeoutRecoveryDocument,
    } = context;
    state.configuration = {
      ...state.configuration,
      vl_rec_max_concurrency: 1,
      server_parallel: p4ToP1 ? 1 : 4,
    };
    state.configuration_scope = 'active_writer_with_hash_bound_seed_exceptions';
    state.seed_lineage = {
      schema_version: 1,
      mode: 'hash_bound_output_seed',
      seed_id: seedId,
      predecessor_run_identity_sha256: runIdentitySha256,
      predecessor_configuration_sha256: predecessorConfigurationSha256,
      inherited_completed_pages: state.completed_pages,
      citation_allowed: false,
      ...(timeoutRecoveryDocument ? {
        timeout_recovery_grant_id: timeoutRecoveryEvidence.grant.grant_id,
        timeout_recovery_grant_sha256: timeoutRecoveryEvidence.grantRawSha256,
        timeout_recovery_first_missing_page: timeoutRecoveryDocument.firstMissingPage,
      } : {}),
    };
    for (const page of state.completed_pages) {
      state.pages[String(page)].seed_provenance = {
        seed_id: seedId,
        predecessor_run_identity_sha256: runIdentitySha256,
        predecessor_configuration_sha256: predecessorConfigurationSha256,
      };
    }
    const successorStateWritten = await writeJson(statePath, state);
    const pageArtifacts = state.completed_pages.map((page) => ({
      page_number: page,
      rendered_image_sha256: state.pages[String(page)].rendered_image_sha256,
      result_json_sha256: state.pages[String(page)].result_json_sha256,
      content_markdown_sha256: state.pages[String(page)].content_markdown_sha256,
      citation_eligible: false,
    }));
    const statusSeedLineage = {
      schema_version: 1,
      seed_id: seedId,
      predecessor_status_sha256: sha256(statusRaw),
      inherited_attempts: predecessorRunStatus.documents[document.id].attempts,
      citation_allowed: false,
      ...(timeoutRecoveryDocument ? {
        timeout_recovery_grant_id: timeoutRecoveryEvidence.grant.grant_id,
        timeout_recovery_grant_sha256: timeoutRecoveryEvidence.grantRawSha256,
        timeout_recovery_first_missing_page: timeoutRecoveryDocument.firstMissingPage,
        granted_attempt: 6,
      } : {}),
    };
    const successorStatus = timeoutRecoveryDocument
      ? {
          schema_version: 1,
          document_id: document.id,
          status: 'retry_wait',
          attempt: 5,
          max_attempts: 6,
          page_count: document.page_count,
          runtime_fingerprint_sha256: successorRuntimeFingerprintSha256,
          citation_allowed: false,
          error: status.error,
          failed_at: status.quarantined_at,
          retry_delay_seconds: 60,
          next_retry_at: status.quarantined_at,
          seed_lineage: statusSeedLineage,
        }
      : {
          ...status,
          runtime_fingerprint_sha256: successorRuntimeFingerprintSha256,
          seed_lineage: statusSeedLineage,
          artifacts: {
            state_sha256: successorStateWritten.sha256,
            page_artifacts_sha256: sha256(`${JSON.stringify(pageArtifacts)}\n`),
            page_artifacts: pageArtifacts,
          },
        };
    const successorStatusWritten = await writeJson(statusPath, successorStatus);
    await writeSidecar(statusPath, successorStatusWritten.sha256);
    successorStatuses.set(document.id, successorStatusWritten.sha256);
    const predecessorDocument = predecessorDocuments.find(
      (value) => value.document_id === document.id,
    );
    receiptDocuments.push({
      ...predecessorDocument,
      successor_document_tree: await inspectTree(documentRoot),
      successor_state_sha256: successorStateWritten.sha256,
      successor_status_sha256: successorStatusWritten.sha256,
    });
  }

  const successorRunStatus = structuredClone(predecessorRunStatus);
  successorRunStatus.runtime_fingerprint_sha256 = successorRuntimeFingerprintSha256;
  successorRunStatus.document_recovery = successorRecovery;
  successorRunStatus.seed_lineage = {
    schema_version: 1,
    mode: 'hash_bound_output_seed',
    seed_id: seedId,
    predecessor_run_identity_sha256: runIdentitySha256,
    predecessor_run_status_sha256: runStatusSha256,
    citation_allowed: false,
    ...(timeoutRecoveryEvidence ? {
      timeout_recovery_grant_id: timeoutRecoveryEvidence.grant.grant_id,
      timeout_recovery_grant_sha256: timeoutRecoveryEvidence.grantRawSha256,
      timeout_recovery_ledger_id: timeoutRecoveryConsumptionEvidence.summary.ledger_id,
      timeout_recovery_claim_sha256: timeoutRecoveryConsumptionEvidence.summary.claim_sha256,
      timeout_recovery_issuance_claim_key: timeoutRecoveryEvidence.issuance.claim_key,
      timeout_recovery_issuance_sha256: timeoutRecoveryEvidence.issuanceRawSha256,
      timeout_recovery_documents: timeoutRecoveryEvidence.grant.documents.map(
        (document) => document.document_id,
      ),
    } : {}),
  };
  for (const document of shardManifest.documents) {
    const progress = successorRunStatus.documents[document.id];
    const timeoutRecoveryDocument = timeoutRecovery?.documents.get(document.id) || null;
    progress.predecessor_status = progress.status;
    progress.inherited_attempts = progress.attempts;
    progress.seed_id = seedId;
    progress.status_json_sha256 = successorStatuses.get(document.id);
    if (timeoutRecoveryDocument) {
      progress.status = 'retry_wait';
      progress.attempt_ceiling = 6;
      progress.timeout_recovery_grant_id = timeoutRecoveryEvidence.grant.grant_id;
      progress.timeout_recovery_grant_sha256 = timeoutRecoveryEvidence.grantRawSha256;
      progress.timeout_recovery_first_missing_page = timeoutRecoveryDocument.firstMissingPage;
      progress.next_retry_at = progress.quarantined_at;
      delete progress.quarantined_at;
      delete progress.quarantine_reason;
    }
  }
  if (timeoutRecoveryEvidence) {
    successorRunStatus.settled = false;
    successorRunStatus.finished = false;
    successorRunStatus.counts = {
      ...successorRunStatus.counts,
      retry_wait: timeoutRecoveryEvidence.grant.documents.length,
      quarantined: 0,
    };
  }
  const successorRunStatusWritten = await writeJson(runStatusPath, successorRunStatus);
  await writeSidecar(runStatusPath, successorRunStatusWritten.sha256);
  const receipt = {
    schema_version: 1,
    receipt_type: 'curriculum_remote_ocr_hash_bound_output_seed',
    status: 'prepared_commit_marker_required',
    seed_id: seedId,
    seed_basis_sha256: seedId,
    manifest_sha256: manifestSha256,
    predecessor: predecessorContract,
    successor: {
      ...successorContract,
      initial_run_status_sha256: successorRunStatusWritten.sha256,
    },
    allowed_configuration_delta: allowedConfigurationDelta,
    ...(timeoutRecoveryEvidence ? { timeout_recovery_grant: timeoutRecoveryEvidence.summary } : {}),
    ...(timeoutRecoveryEvidence ? {
      timeout_recovery_issuance: timeoutRecoveryEvidence.issuanceSummary,
    } : {}),
    ...(timeoutRecoveryConsumptionEvidence ? {
      timeout_recovery_consumption: timeoutRecoveryConsumptionEvidence.summary,
    } : {}),
    counts: {
      documents: shardManifest.documents.length,
      inherited_documents: receiptDocuments.filter(
        (document) => document.completed_pages.length > 0,
      ).length + (tamper === 'inherited_document_count' ? 1 : 0),
      inherited_pages: inheritedPages,
      failed_pages: 0,
      quarantined_documents: 0,
      ...(timeoutRecoveryEvidence ? {
        predecessor_complete_documents: predecessorRunStatus.counts.complete,
        predecessor_quarantined_documents: timeoutRecoveryEvidence.grant.documents.length,
        recovery_granted_documents: timeoutRecoveryEvidence.grant.documents.length,
      } : {}),
    },
    documents: receiptDocuments,
    citation_allowed: false,
  };
  const receiptPath = path.join(shard.shardRoot, 'seed-receipt.json');
  const receiptWritten = await writeJson(receiptPath, receipt);
  await writeSidecar(receiptPath, receiptWritten.sha256);
  const successorIdentity = {
    ...predecessorIdentity,
    runner_script_sha256: successorRunnerScriptSha256,
    ocr_script_sha256: successorContract.ocr_script_sha256,
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
      predecessor_run_identity_sha256: runIdentitySha256,
      predecessor_run_status_sha256: runStatusSha256,
      predecessor_snapshot_sha256: predecessorContract.snapshot_sha256,
      inherited_pages: inheritedPages,
      citation_allowed: false,
      ...(timeoutRecoveryEvidence ? {
        timeout_recovery_grant_id: timeoutRecoveryEvidence.grant.grant_id,
        timeout_recovery_grant_sha256: timeoutRecoveryEvidence.grantRawSha256,
        timeout_recovery_ledger_id: timeoutRecoveryConsumptionEvidence.summary.ledger_id,
        timeout_recovery_claim_sha256: timeoutRecoveryConsumptionEvidence.summary.claim_sha256,
        timeout_recovery_issuance_claim_key: timeoutRecoveryEvidence.issuance.claim_key,
        timeout_recovery_issuance_sha256: timeoutRecoveryEvidence.issuanceRawSha256,
        timeout_recovery_documents: timeoutRecoveryEvidence.grant.documents.map(
          (document) => document.document_id,
        ),
      } : {}),
    },
  };
  const successorIdentityWritten = await writeJson(identityPath, successorIdentity);
  const installedItemSpecifications = [
    { name: 'documents', type: 'directory' },
    { name: 'status', type: 'directory' },
    { name: 'seed-predecessor-evidence', type: 'directory' },
    { name: 'seed-receipt.json', type: 'file' },
    { name: 'seed-receipt.json.sha256', type: 'file' },
    ...(timeoutRecoveryEvidence ? [
      { name: 'timeout-recovery-grant.json', type: 'file' },
      { name: 'timeout-recovery-grant.json.sha256', type: 'file' },
      { name: 'timeout-recovery-issuance', type: 'directory' },
      { name: 'timeout-recovery-ledger-identity.json', type: 'file' },
      { name: 'timeout-recovery-ledger-identity.json.sha256', type: 'file' },
      { name: 'timeout-recovery-consumption-claim.json', type: 'file' },
      { name: 'timeout-recovery-consumption-claim.json.sha256', type: 'file' },
    ] : []),
    { name: 'run-identity.json', type: 'file' },
    { name: 'run-status.json', type: 'file' },
    { name: 'run-status.json.sha256', type: 'file' },
  ];
  const installedItems = [];
  for (const specification of installedItemSpecifications) {
    const pathname = path.join(shard.shardRoot, specification.name);
    const fingerprint = specification.type === 'directory'
      ? await inspectTree(pathname)
      : await readFile(pathname).then((raw) => ({ sha256: sha256(raw), bytes: raw.length }));
    installedItems.push({ ...specification, fingerprint });
  }
  if (tamper === 'initial_run_status_inventory') {
    installedItems.find((item) => item.name === 'run-status.json').fingerprint.sha256 = '0'.repeat(64);
  }
  const markerPath = path.join(shard.shardRoot, 'seed-commit.json');
  const markerWritten = await writeJson(markerPath, {
    schema_version: 1,
    marker_type: 'curriculum_remote_ocr_hash_bound_seed_commit',
    seed_id: seedId,
    seed_receipt_sha256: receiptWritten.sha256,
    run_identity_sha256: successorIdentityWritten.sha256,
    initial_run_status_sha256: successorRunStatusWritten.sha256,
    installed_items: installedItems,
    installed_items_sha256: sha256(canonicalJson(installedItems)),
    citation_allowed: false,
  });
  await writeSidecar(markerPath, markerWritten.sha256);
  return {
    seedId,
    receiptPath,
    markerPath,
    predecessorEvidenceRoot,
    timeoutRecoveryEvidence,
    timeoutRecoveryConsumptionEvidence,
  };
}

async function convertShardToTimeoutRecoverySeed(shard, {
  firstMissingPageById,
  tamper = null,
  transition = null,
  successorRunnerScriptSha256 = 'e'.repeat(64),
} = {}) {
  const runStatusPath = path.join(shard.shardRoot, 'run-status.json');
  const runStatus = JSON.parse(await readFile(runStatusPath, 'utf8'));
  const manifest = JSON.parse(await readFile(shard.manifestPath, 'utf8'));
  const fullStates = new Map();
  const timeoutDocuments = new Map();
  for (const document of manifest.documents) {
    const firstMissingPage = firstMissingPageById.get(document.id);
    if (!firstMissingPage) continue;
    const statePath = path.join(shard.shardRoot, 'documents', document.id, 'state.json');
    const fullState = JSON.parse(await readFile(statePath, 'utf8'));
    fullStates.set(document.id, fullState);
    const inheritedPages = Array.from({ length: firstMissingPage - 1 }, (_, index) => index + 1);
    const predecessorState = {
      ...fullState,
      completed_pages: inheritedPages,
      failed_pages: {},
      pages: Object.fromEntries(inheritedPages.map((page) => [String(page), fullState.pages[String(page)]])),
      selected_pages_complete: false,
    };
    await writeJson(statePath, predecessorState);
    const quarantinedAt = '2026-07-16T01:00:00.000Z';
    const error = 'OCR child idle_timeout after 300s; terminated with SIGTERM';
    const statusPath = path.join(shard.shardRoot, 'status', `${document.id}.json`);
    const statusWritten = await writeJson(statusPath, {
      schema_version: 1,
      document_id: document.id,
      status: 'quarantined',
      attempt: 5,
      max_attempts: 5,
      page_count: document.page_count,
      runtime_fingerprint_sha256: runtimeFingerprintSha256,
      citation_allowed: false,
      quarantine_reason: 'attempt_budget_exhausted',
      error,
      quarantined_at: quarantinedAt,
    });
    await writeSidecar(statusPath, statusWritten.sha256);
    runStatus.documents[document.id] = {
      status: 'quarantined',
      attempts: 5,
      page_count: document.page_count,
      status_json_sha256: statusWritten.sha256,
      failed_at: '2026-07-16T00:55:00.000Z',
      quarantined_at: quarantinedAt,
      quarantine_reason: 'attempt_budget_exhausted',
      error,
    };
    const timeoutLogRaw = Buffer.from(`SignalInfo: *** SIGTERM attempt 5 for ${document.id}\n`);
    const timeoutLogPath = `logs/${document.id}.log`;
    await mkdir(path.join(shard.shardRoot, 'logs'), { recursive: true });
    await writeFile(path.join(shard.shardRoot, timeoutLogPath), timeoutLogRaw);
    timeoutDocuments.set(document.id, {
      firstMissingPage,
      timeoutLogRaw,
      timeoutLog: {
        path: timeoutLogPath,
        bytes: timeoutLogRaw.length,
        sha256: sha256(timeoutLogRaw),
      },
    });
  }
  const statuses = Object.values(runStatus.documents).map((progress) => progress.status);
  runStatus.finished = false;
  runStatus.settled = true;
  runStatus.counts = {
    total: statuses.length,
    complete: statuses.filter((status) => status === 'complete').length,
    failed: 0,
    interrupted: 0,
    pending: 0,
    running: 0,
    retry_wait: 0,
    quarantined: statuses.filter((status) => status === 'quarantined').length,
  };
  const predecessorRunStatusWritten = await writeJson(runStatusPath, runStatus);
  await writeSidecar(runStatusPath, predecessorRunStatusWritten.sha256);

  const seed = await convertShardToHashBoundSeed(shard, {
    tamper,
    timeoutRecovery: { documents: timeoutDocuments },
    transition,
    successorRunnerScriptSha256,
  });
  const successorRuntimeFingerprintSha256 = transition === 'p4_to_p1_v1'
    || transition === seedAwareTransition
    ? p1RuntimeFingerprintSha256
    : runtimeFingerprintSha256;

  const finalRunStatus = JSON.parse(await readFile(runStatusPath, 'utf8'));
  for (const document of manifest.documents) {
    const timeoutDocument = timeoutDocuments.get(document.id);
    if (!timeoutDocument) continue;
    const statePath = path.join(shard.shardRoot, 'documents', document.id, 'state.json');
    const seededState = JSON.parse(await readFile(statePath, 'utf8'));
    const fullState = fullStates.get(document.id);
    const allPages = Array.from({ length: document.page_count }, (_, index) => index + 1);
    for (const page of allPages.slice(timeoutDocument.firstMissingPage - 1)) {
      seededState.pages[String(page)] = fullState.pages[String(page)];
    }
    seededState.completed_pages = allPages;
    seededState.failed_pages = {};
    seededState.selected_pages = allPages;
    seededState.selected_pages_complete = true;
    const finalStateWritten = await writeJson(statePath, seededState);
    const pageArtifacts = allPages.map((page) => ({
      page_number: page,
      rendered_image_sha256: seededState.pages[String(page)].rendered_image_sha256,
      result_json_sha256: seededState.pages[String(page)].result_json_sha256,
      content_markdown_sha256: seededState.pages[String(page)].content_markdown_sha256,
      citation_eligible: false,
    }));
    const initialStatus = JSON.parse(await readFile(
      path.join(shard.shardRoot, 'status', `${document.id}.json`),
      'utf8',
    ));
    const statusPath = path.join(shard.shardRoot, 'status', `${document.id}.json`);
    const finalStatusWritten = await writeJson(statusPath, {
      schema_version: 1,
      document_id: document.id,
      status: 'complete',
      attempt: 6,
      max_attempts: 6,
      source_sha256: document.source_sha256,
      page_count: document.page_count,
      runtime_fingerprint_sha256: successorRuntimeFingerprintSha256,
      citation_allowed: false,
      whole_document_atomic: true,
      artifacts: {
        state_sha256: finalStateWritten.sha256,
        page_artifacts_sha256: sha256(`${JSON.stringify(pageArtifacts)}\n`),
        page_artifacts: pageArtifacts,
      },
      verified_at: '2026-07-16T03:00:00.000Z',
      seed_lineage: initialStatus.seed_lineage,
    });
    await writeSidecar(statusPath, finalStatusWritten.sha256);
    const progress = finalRunStatus.documents[document.id];
    progress.status = 'complete';
    progress.attempts = 6;
    progress.status_json_sha256 = finalStatusWritten.sha256;
    progress.verified_at = '2026-07-16T03:00:00.000Z';
    delete progress.next_retry_at;
    delete progress.error;
  }
  const finalStatuses = Object.values(finalRunStatus.documents).map((progress) => progress.status);
  finalRunStatus.settled = true;
  finalRunStatus.finished = true;
  finalRunStatus.counts = {
    total: finalStatuses.length,
    complete: finalStatuses.length,
    failed: 0,
    interrupted: 0,
    pending: 0,
    running: 0,
    retry_wait: 0,
    quarantined: 0,
  };
  const finalRunStatusWritten = await writeJson(runStatusPath, finalRunStatus);
  await writeSidecar(runStatusPath, finalRunStatusWritten.sha256);
  await Promise.all([
    'timeout-recovery-grant.json',
    'timeout-recovery-grant.json.sha256',
    'timeout-recovery-ledger-identity.json',
    'timeout-recovery-ledger-identity.json.sha256',
    'timeout-recovery-consumption-claim.json',
    'timeout-recovery-consumption-claim.json.sha256',
    `timeout-recovery-issuance/${seed.timeoutRecoveryEvidence.issuance.claim_key}.issuance.json`,
    `timeout-recovery-issuance/${seed.timeoutRecoveryEvidence.issuance.claim_key}.issuance.json.sha256`,
  ].map((name) => chmod(path.join(shard.shardRoot, name), 0o600)));
  return seed;
}

async function createLocalPartialSnapshot({
  document,
  productionRoot,
  textRoot,
  supervisorRoot,
  completedPages = [1],
  failedPages = {},
  pageRetries = {},
}) {
  const documentRoot = path.join(productionRoot, document.id);
  await mkdir(path.join(documentRoot, 'pages'), { recursive: true });
  const pages = {};
  for (const page of completedPages) {
    const pageRoot = path.join(documentRoot, 'pages', String(page).padStart(4, '0'));
    await mkdir(pageRoot, { recursive: true });
    const result = `${JSON.stringify({ local_partial_page: page })}\n`;
    const content = `original local partial page ${page}\n`;
    await writeFile(path.join(pageRoot, 'result.json'), result);
    await writeFile(path.join(pageRoot, 'content.md'), content);
    pages[String(page)] = {
      status: 'ocr_complete_pending_audit',
      physical_pdf_page: page,
      rendered_image_sha256: sha256(`local-rendered:${document.id}:${page}`),
      result_json_sha256: sha256(result),
      content_markdown_sha256: sha256(content),
      citation_eligible: false,
    };
  }
  await writeJson(path.join(documentRoot, 'state.json'), {
    schema_version: 1,
    document_id: document.id,
    source_sha256: document.source_sha256,
    page_count: document.page_count,
    completed_pages: completedPages,
    failed_pages: failedPages,
    pages,
  });
  await writeFile(path.join(documentRoot, 'audit-local.json'), '{"status":"unresolved_fail_closed"}\n');
  await mkdir(textRoot, { recursive: true });
  await writeFile(path.join(textRoot, `${document.id}.txt`), 'original local partial joined text\n');
  await mkdir(supervisorRoot, { recursive: true });
  const documentRetries = {};
  await writeJson(path.join(supervisorRoot, 'retries.json'), documentRetries);
  await writeJson(path.join(supervisorRoot, 'page-retries.json'), pageRetries);
  return captureLocalReprocessSnapshot({
    document,
    documentRoot,
    textPath: path.join(textRoot, `${document.id}.txt`),
    documentRetries,
    pageRetries,
  });
}

async function fixture(t, {
  repairB = false,
  quarantineB = repairB,
  repairCitationEligible = false,
  repairFinalTextMismatch = false,
  nativeAssetA = false,
  bindNativeAssets = true,
  reprocessA = false,
  reprocessAPageRetry = false,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'remote-ocr-receiver-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  const sourceRoot = path.join(projectRoot, 'sources');
  await mkdir(sourceRoot, { recursive: true });
  const sourceA = 'source-a';
  const sourceB = 'source-b';
  await writeFile(path.join(sourceRoot, 'a.pdf'), sourceA);
  await writeFile(path.join(sourceRoot, 'b.pdf'), sourceB);
  const documentA = documentFor('doc-a', 'sources/a.pdf', sourceA, 2);
  const documentB = documentFor('doc-b', 'sources/b.pdf', sourceB, 1);
  const productionRoot = path.join(projectRoot, 'local-production');
  const textRoot = path.join(projectRoot, 'local-text');
  const supervisorRoot = path.join(projectRoot, 'local-supervisor');
  const receiptRoot = path.join(projectRoot, 'receipts');
  if (reprocessA) {
    documentA.planning_snapshot = await createLocalPartialSnapshot({
      document: documentA,
      productionRoot,
      textRoot,
      supervisorRoot,
      pageRetries: reprocessAPageRetry
        ? {
            'doc-a:2:paddle': {
              attempts: 5,
              quarantined: true,
            },
          }
        : {},
    });
  }
  const asset = nativeAsset('img_in_image_box_245_322_1414_1925.jpg');
  const nativeMarkdown = nativeAssetA
    ? 'alpha page one\n\n<div style="text-align: center;"><img src="imgs/img_in_image_box_245_322_1414_1925.jpg" alt="Image" width="72%" /></div>\n'
    : 'alpha page one\n';
  const pageTexts = new Map([
    ['doc-a', [nativeMarkdown, '']],
    ['doc-b', ['beta page one\n']],
  ]);
  const parentManifestPath = path.join(root, 'parent-manifest.json');
  await writeJson(parentManifestPath, manifestFor([documentA, documentB]));
  const shardA = await createShard({
    manifestPath: path.join(root, 'shard-a-manifest.json'),
    shardRoot: path.join(root, 'shard-a'),
    documents: [documentA],
    pageTexts,
    nativeAssets: nativeAssetA ? new Map([['doc-a:1', [asset]]]) : new Map(),
    bindNativeAssets,
  });
  const repairPages = repairB ? new Set(['doc-b:1']) : new Set();
  const shardB = await createShard({
    manifestPath: path.join(root, 'shard-b-manifest.json'),
    shardRoot: path.join(root, 'shard-b'),
    documents: [documentB],
    pageTexts,
    statuses: quarantineB ? { 'doc-b': 'quarantined' } : {},
    repairPages,
    repairCitationEligible,
    repairFinalTextMismatch,
  });
  await mkdir(textRoot, { recursive: true });
  if (!reprocessA) await writeFile(path.join(textRoot, 'doc-a.txt'), 'existing placeholder\n');
  const documents = new Map([
    ['a.pdf', documentA],
    ['b.pdf', documentB],
  ]);
  const options = {
    manifest: parentManifestPath,
    shards: [
      {
        manifestPath: shardA.manifestPath,
        root: shardA.shardRoot,
        ...(shardA.repairManifestPath ? { repairManifestPath: shardA.repairManifestPath } : {}),
      },
      {
        manifestPath: shardB.manifestPath,
        root: shardB.shardRoot,
        ...(shardB.repairManifestPath ? { repairManifestPath: shardB.repairManifestPath } : {}),
      },
    ],
    projectRoot,
    productionRoot,
    textRoot,
    supervisorRoot,
    receiptRoot,
    python: process.execPath,
  };
  const dependencies = {
    pageCounter: (_python, sourcePath) => documents.get(path.basename(sourcePath)).page_count,
  };
  return {
    root,
    projectRoot,
    parentManifestPath,
    shardA,
    shardB,
    documentA,
    documentB,
    pageTexts,
    productionRoot,
    textRoot,
    supervisorRoot,
    receiptRoot,
    options,
    dependencies,
  };
}

function continuationUnitGeneration(role, revision = 0) {
  const base = 500 + revision * 10;
  return {
    StateChangeTimestampMonotonic: String(base + 1),
    ActiveEnterTimestampMonotonic: String(base + 2),
    ActiveExitTimestampMonotonic: String(base + 3),
    InactiveEnterTimestampMonotonic: String(base + 4),
    ...(role === 'monitor_timer' ? { LastTriggerUSecMonotonic: String(base + 5) } : {}),
  };
}

async function hardenFixtureEvidenceTree(root) {
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const pathname = path.join(root, entry.name);
    if (entry.isDirectory()) await hardenFixtureEvidenceTree(pathname);
    else await chmod(pathname, 0o600);
  }
}

async function a2ReceiverContinuationFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'remote-ocr-a2-receiver-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  const runRoot = path.join(root, 'run');
  const outputRoot = path.join(runRoot, 'output');
  const evidenceBaseRoot = path.join(runRoot, 'a2-evidence');
  const incidentEvidenceRoot = path.join(evidenceBaseRoot, 'operator-incident');
  const rearmRepairId = 'a'.repeat(64);
  const rearmEvidenceRoot = path.join(evidenceBaseRoot, rearmRepairId);
  const lifecycleLock = path.join(runRoot, '.a2-lifecycle.lock');
  const documentId = 'legacy-compendium-english';
  const documentInterruptedAt = '2026-07-22T04:13:35.387Z';
  const incidentInterruptedAt = '2026-07-22T04:13:35.390Z';
  const authorizedAt = '2026-07-22T04:20:00.000Z';
  const continuedAt = '2026-07-22T04:21:00.000Z';
  const workerInvocationId = 'c'.repeat(32);
  const source = 'A2 receiver continuation source';
  const sourcePath = path.join(projectRoot, 'pdfs', 'english.pdf');
  await Promise.all([
    mkdir(path.dirname(sourcePath), { recursive: true, mode: 0o700 }),
    mkdir(runRoot, { recursive: true, mode: 0o700 }),
    mkdir(incidentEvidenceRoot, { recursive: true, mode: 0o700 }),
    mkdir(rearmEvidenceRoot, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    chmod(projectRoot, 0o700),
    chmod(runRoot, 0o700),
    chmod(evidenceBaseRoot, 0o700),
    chmod(incidentEvidenceRoot, 0o700),
    chmod(rearmEvidenceRoot, 0o700),
  ]);
  await writeFile(sourcePath, source, { mode: 0o600 });
  await writeFile(lifecycleLock, '', { mode: 0o600 });
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

  const document = documentFor(documentId, 'pdfs/english.pdf', source, 2);
  const parentManifestPath = path.join(projectRoot, 'parent-manifest.json');
  const shardManifestPath = path.join(runRoot, 'shard-manifest.json');
  await writeJson(parentManifestPath, manifestFor([document]));
  const shard = await createShard({
    manifestPath: shardManifestPath,
    shardRoot: outputRoot,
    documents: [document],
    pageTexts: new Map([[documentId, ['page one\n', 'page two\n']]]),
  });
  await Promise.all([
    chmod(outputRoot, 0o700),
    chmod(parentManifestPath, 0o600),
    chmod(shardManifestPath, 0o600),
  ]);
  const canonicalProjectRoot = await realpath(projectRoot);
  const canonicalRunRoot = await realpath(runRoot);
  const canonicalOutputRoot = await realpath(outputRoot);
  const canonicalEvidenceBaseRoot = await realpath(evidenceBaseRoot);
  const canonicalIncidentEvidenceRoot = await realpath(incidentEvidenceRoot);
  const canonicalRearmEvidenceRoot = await realpath(rearmEvidenceRoot);
  const canonicalLifecycleLock = await realpath(lifecycleLock);
  const identityPath = path.join(outputRoot, 'run-identity.json');
  const predecessorIdentity = JSON.parse(await readFile(identityPath, 'utf8'));
  predecessorIdentity.input_root = canonicalProjectRoot;
  predecessorIdentity.python_invocation_path = process.execPath;
  predecessorIdentity.python_resolved_target = await realpath(process.execPath);
  await writeJson(identityPath, predecessorIdentity);

  const seed = await convertShardToTimeoutRecoverySeed(shard, {
    firstMissingPageById: new Map([[documentId, 2]]),
    transition: 'p4_to_p1_v1',
    successorRunnerScriptSha256: a2BaseRunnerSha256,
  });
  await hardenFixtureEvidenceTree(path.join(outputRoot, 'seed-predecessor-evidence'));
  const documentRoot = path.join(outputRoot, 'documents', documentId);
  const statePath = path.join(documentRoot, 'state.json');
  const statusPath = path.join(outputRoot, 'status', `${documentId}.json`);
  const runStatusPath = path.join(outputRoot, 'run-status.json');
  const logPath = path.join(outputRoot, 'logs', `${documentId}.log`);
  const savedPageTwo = path.join(runRoot, 'saved-page-0002');
  const fullState = JSON.parse(await readFile(statePath, 'utf8'));
  await rename(path.join(documentRoot, 'pages', '0002'), savedPageTwo);
  const partialState = structuredClone(fullState);
  partialState.completed_pages = [1];
  partialState.pages = { 1: partialState.pages['1'] };
  partialState.selected_pages = [1, 2];
  partialState.selected_pages_complete = false;
  const partialStateWritten = await writeJson(statePath, partialState);
  const logRaw = Buffer.from('attempt 6 started\nSignalInfo: *** SIGTERM\n');
  await writeFile(logPath, logRaw, { mode: 0o600 });
  const finalStatus = JSON.parse(await readFile(statusPath, 'utf8'));
  const interruptedStatus = {
    schema_version: 1,
    document_id: documentId,
    status: 'interrupted',
    attempt: 6,
    max_attempts: 6,
    page_count: 2,
    runtime_fingerprint_sha256: p1RuntimeFingerprintSha256,
    citation_allowed: false,
    interrupted_at: documentInterruptedAt,
    seed_lineage: finalStatus.seed_lineage,
  };
  const interruptedStatusWritten = await writeJson(statusPath, interruptedStatus);
  await writeSidecar(statusPath, interruptedStatusWritten.sha256);
  const interruptedRunStatus = JSON.parse(await readFile(runStatusPath, 'utf8'));
  const progress = interruptedRunStatus.documents[documentId];
  for (const key of ['verified_at', 'completed_at', 'quarantined_at', 'error', 'next_retry_at']) {
    delete progress[key];
  }
  Object.assign(progress, {
    status: 'interrupted',
    attempts: 6,
    started_at: '2026-07-22T04:12:00.000Z',
    interrupted_at: documentInterruptedAt,
    signal: 'SIGTERM',
    status_json_sha256: interruptedStatusWritten.sha256,
  });
  interruptedRunStatus.updated_at = documentInterruptedAt;
  interruptedRunStatus.counts = {
    total: 1,
    complete: 0,
    failed: 0,
    interrupted: 1,
    pending: 0,
    running: 0,
    retry_wait: 0,
    quarantined: 0,
  };
  interruptedRunStatus.finished = false;
  interruptedRunStatus.settled = false;
  const interruptedRunStatusWritten = await writeJson(runStatusPath, interruptedRunStatus);
  await writeSidecar(runStatusPath, interruptedRunStatusWritten.sha256);

  const seedJournalPath = path.join(outputRoot, '.seed-journal.json');
  const seedJournalWritten = await writeJson(seedJournalPath, {
    schema_version: 1,
    journal_type: 'curriculum_remote_ocr_hash_bound_seed_install',
    seed_id: seed.seedId,
    citation_allowed: false,
  });
  await writeSidecar(seedJournalPath, seedJournalWritten.sha256);

  const rearmReservation = Buffer.from(`${JSON.stringify({
    schema_version: 1,
    claim_type: 'curriculum_remote_ocr_preinference_rearm_evidence_reservation',
    repair_id: rearmRepairId,
    evidence_path: canonicalRearmEvidenceRoot,
    citation_allowed: false,
  }, null, 2)}\n`);
  const rearmAfterStatus = Buffer.from('{"status":"interrupted"}\n');
  const rearmAfterStatusSidecar = Buffer.from(`${sha256(rearmAfterStatus)}  ${documentId}.json\n`);
  const rearmAfterRunStatus = Buffer.from('{"finished":false}\n');
  const rearmAfterRunStatusSidecar = Buffer.from(`${sha256(rearmAfterRunStatus)}  run-status.json\n`);
  const rearmTransaction = [
    [`status/${documentId}.json`, rearmAfterStatus],
    [`status/${documentId}.json.sha256`, rearmAfterStatusSidecar],
    ['run-status.json', rearmAfterRunStatus],
    ['run-status.json.sha256', rearmAfterRunStatusSidecar],
  ];
  const rearmReceiptPath = path.join(rearmEvidenceRoot, 'repair-receipt.json');
  const rearmReceiptWritten = await writeJson(rearmReceiptPath, {
    schema_version: 1,
    receipt_type: 'curriculum_remote_ocr_preinference_interruption_rearm',
    status: 'prepared_atomic_apply_required',
    repair_id: rearmRepairId,
    transaction: rearmTransaction.map(([outputPath, raw]) => ({
      output_path: outputPath,
      after: { sha256: sha256(raw), bytes: raw.byteLength },
    })),
    after_run_status_sha256: sha256(rearmAfterRunStatus),
    after_document_status_sha256: sha256(rearmAfterStatus),
    publication_claim: { sha256: sha256(rearmReservation), bytes: rearmReservation.byteLength },
    citation_allowed: false,
  });
  await writeSidecar(rearmReceiptPath, rearmReceiptWritten.sha256);
  await writeFile(
    path.join(evidenceBaseRoot, `${rearmRepairId}.claim.json`),
    rearmReservation,
    { mode: 0o600 },
  );

  const issuanceRelativePath = `timeout-recovery-issuance/${seed.timeoutRecoveryEvidence.issuance.claim_key}.issuance.json`;
  const authorityFiles = [
    identityPath,
    path.join(outputRoot, 'seed-receipt.json'),
    path.join(outputRoot, 'seed-receipt.json.sha256'),
    path.join(outputRoot, 'seed-commit.json'),
    path.join(outputRoot, 'seed-commit.json.sha256'),
    seedJournalPath,
    `${seedJournalPath}.sha256`,
    path.join(outputRoot, 'timeout-recovery-grant.json'),
    path.join(outputRoot, 'timeout-recovery-grant.json.sha256'),
    path.join(outputRoot, 'timeout-recovery-ledger-identity.json'),
    path.join(outputRoot, 'timeout-recovery-ledger-identity.json.sha256'),
    path.join(outputRoot, 'timeout-recovery-consumption-claim.json'),
    path.join(outputRoot, 'timeout-recovery-consumption-claim.json.sha256'),
    path.join(outputRoot, issuanceRelativePath),
    path.join(outputRoot, `${issuanceRelativePath}.sha256`),
    statePath,
    statusPath,
    `${statusPath}.sha256`,
    runStatusPath,
    `${runStatusPath}.sha256`,
    logPath,
    rearmReceiptPath,
    `${rearmReceiptPath}.sha256`,
  ];
  await Promise.all(authorityFiles.map((pathname) => chmod(pathname, 0o600)));

  const pair = async (pathname) => {
    const [raw, sidecarRaw] = await Promise.all([readFile(pathname), readFile(`${pathname}.sha256`)]);
    return {
      raw,
      sha256: sha256(raw),
      bytes: raw.byteLength,
      sidecarRaw,
      sidecarSha256: sha256(sidecarRaw),
      sidecarBytes: sidecarRaw.byteLength,
    };
  };
  const [
    seedReceipt,
    seedCommit,
    seedJournal,
    ledger,
    grant,
    consumptionClaim,
    issuance,
  ] = await Promise.all([
    pair(path.join(outputRoot, 'seed-receipt.json')),
    pair(path.join(outputRoot, 'seed-commit.json')),
    pair(seedJournalPath),
    pair(path.join(outputRoot, 'timeout-recovery-ledger-identity.json')),
    pair(path.join(outputRoot, 'timeout-recovery-grant.json')),
    pair(path.join(outputRoot, 'timeout-recovery-consumption-claim.json')),
    pair(path.join(outputRoot, issuanceRelativePath)),
  ]);
  const [
    outputInfo,
    lifecycleInfo,
    evidenceBaseInfo,
    incidentInfo,
    incidentTree,
    documentTree,
    predecessorTree,
    rearmTree,
    rearmReceipt,
  ] = await Promise.all([
    stat(outputRoot, { bigint: true }),
    stat(lifecycleLock, { bigint: true }),
    stat(evidenceBaseRoot, { bigint: true }),
    stat(incidentEvidenceRoot, { bigint: true }),
    inspectTree(incidentEvidenceRoot),
    inspectTree(documentRoot),
    inspectTree(path.join(outputRoot, 'seed-predecessor-evidence')),
    inspectTree(rearmEvidenceRoot),
    pair(rearmReceiptPath),
  ]);
  const identityRaw = await readFile(identityPath);
  const profile = {
    ...EXACT_A2_FORWARD_CONTINUATION_INCIDENT,
    runRoot: canonicalRunRoot,
    outputRoot: canonicalOutputRoot,
    outputDevice: String(outputInfo.dev),
    outputInode: String(outputInfo.ino),
    lifecycleLock: canonicalLifecycleLock,
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
    workerInvocationId,
    documentInterruptedAt,
    incidentInterruptedAt,
    runStatusSha256: interruptedRunStatusWritten.sha256,
    documentStatusSha256: interruptedStatusWritten.sha256,
    logSha256: sha256(logRaw),
    logBytes: logRaw.byteLength,
    stateSha256: partialStateWritten.sha256,
    documentTreeSha256: documentTree.tree_sha256,
    documentTreeFiles: documentTree.files,
    documentTreeBytes: documentTree.bytes,
    baseRunnerSha256: a2BaseRunnerSha256,
    seedId: seed.seedId,
    seedReceiptSha256: seedReceipt.sha256,
    seedReceiptBytes: seedReceipt.bytes,
    seedCommitSha256: seedCommit.sha256,
    seedCommitBytes: seedCommit.bytes,
    seedJournalSha256: seedJournal.sha256,
    seedJournalBytes: seedJournal.bytes,
    runIdentitySha256: sha256(identityRaw),
    runIdentityBytes: identityRaw.byteLength,
    ledgerIdentitySha256: ledger.sha256,
    ledgerIdentityBytes: ledger.bytes,
    timeoutGrantSha256: grant.sha256,
    timeoutGrantBytes: grant.bytes,
    timeoutConsumptionClaimSha256: consumptionClaim.sha256,
    timeoutConsumptionClaimBytes: consumptionClaim.bytes,
    timeoutIssuanceRelativePath: issuanceRelativePath,
    timeoutIssuanceSha256: issuance.sha256,
    timeoutIssuanceBytes: issuance.bytes,
    timeoutIssuanceSidecarSha256: issuance.sidecarSha256,
    timeoutIssuanceSidecarBytes: issuance.sidecarBytes,
    ledgerSidecarSha256: ledger.sidecarSha256,
    ledgerSidecarBytes: ledger.sidecarBytes,
    predecessorEvidenceTreeSha256: predecessorTree.tree_sha256,
    predecessorEvidenceTreeFiles: predecessorTree.files,
    predecessorEvidenceTreeBytes: predecessorTree.bytes,
    rearmRepairId,
    rearmEvidenceRoot: canonicalRearmEvidenceRoot,
    rearmReceiptSha256: rearmReceipt.sha256,
    rearmReceiptBytes: rearmReceipt.bytes,
    rearmReservationClaimSha256: sha256(rearmReservation),
    rearmEvidenceTreeSha256: rearmTree.tree_sha256,
    rearmAfterStatusSha256: sha256(rearmAfterStatus),
    rearmAfterStatusSidecarSha256: sha256(rearmAfterStatusSidecar),
    rearmAfterRunStatusSha256: sha256(rearmAfterRunStatus),
    rearmAfterRunStatusSidecarSha256: sha256(rearmAfterRunStatusSidecar),
    workerUnit: 'fixture-a2-worker.service',
    monitorUnit: 'fixture-a2-monitor.service',
    monitorTimerUnit: 'fixture-a2-monitor.timer',
    alertUnit: 'fixture-a2-alert.service',
    llamaUnit: 'fixture-a2-llama.service',
  };
  validateA2ForwardContinuationProfile(profile);
  const ocrScript = path.join(runRoot, 'ocr.py');
  await writeFile(ocrScript, '# fixture\n', { mode: 0o700 });
  const continuationOptions = {
    manifest: shardManifestPath,
    inputRoot: canonicalProjectRoot,
    outputRoot: canonicalOutputRoot,
    python: process.execPath,
    ocrScript,
    model: '/unused/model',
    mmproj: '/unused/mmproj',
    llamaRepo: '/unused/llama',
    llamaServerBin: '/unused/llama-server',
    llamaSystemdUnit: profile.llamaUnit,
    llamaUrl: 'http://127.0.0.1:8112/v1',
    runtimeDevice,
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
    apply: true,
  };
  const continuationPaths = operatorContinuationPaths(canonicalEvidenceBaseRoot, documentId, 6);
  const receiverOptions = {
    manifest: parentManifestPath,
    shards: [{
      manifestPath: shardManifestPath,
      root: canonicalOutputRoot,
      continuationEvidenceRoot: continuationPaths.root,
    }],
    projectRoot,
    productionRoot: path.join(projectRoot, 'local-production'),
    textRoot: path.join(projectRoot, 'local-text'),
    supervisorRoot: path.join(projectRoot, 'local-supervisor'),
    receiptRoot: path.join(projectRoot, 'receipts'),
    python: process.execPath,
  };
  return {
    root,
    projectRoot,
    outputRoot: canonicalOutputRoot,
    document,
    documentRoot,
    statePath,
    logPath,
    savedPageTwo,
    fullState,
    profile,
    continuationOptions,
    continuationPaths,
    receiverOptions,
  };
}

function a2ContinuationDependencies(value) {
  let llamaActive = false;
  let llamaManagerStartMarker = null;
  let llamaProcessStartMarker = null;
  const inactive = (role, invocationId = '0'.repeat(32), exitStatus = '0') => ({
    LoadState: 'loaded',
    ActiveState: 'inactive',
    SubState: 'dead',
    MainPID: '0',
    InvocationID: invocationId,
    ExecMainStatus: exitStatus,
    Generation: continuationUnitGeneration(role),
  });
  return {
    incidentProfile: value.profile,
    acquireLifecycleLock: async () => {
      let released = false;
      const release = async () => { released = true; };
      release.assertHeld = () => assert.equal(released, false);
      return release;
    },
    inspectUnit: async (_unit, role) => {
      if (role === 'worker') return inactive(role, value.profile.workerInvocationId, '75');
      if (role === 'monitor_timer') {
        return {
          LoadState: 'loaded',
          ActiveState: 'inactive',
          SubState: 'dead',
          InvocationID: '',
          Generation: continuationUnitGeneration(role),
        };
      }
      if (role === 'llama' && llamaActive) {
        return {
          LoadState: 'loaded',
          ActiveState: 'active',
          SubState: 'running',
          MainPID: '42',
          InvocationID: 'b'.repeat(32),
          ExecMainStatus: '0',
          Generation: continuationUnitGeneration(role, 1),
        };
      }
      return inactive(role);
    },
    setLlamaStartMarker: async (_profile, marker) => {
      llamaManagerStartMarker = marker;
    },
    clearLlamaStartMarker: async () => {
      llamaManagerStartMarker = null;
    },
    verifyLlamaStartMarker: async (_activeLlama, marker) => {
      assert.equal(llamaProcessStartMarker, marker);
      return true;
    },
    startLlama: async () => {
      llamaProcessStartMarker = llamaManagerStartMarker;
      llamaActive = true;
    },
    stopLlama: async () => { llamaActive = false; },
    verifyCommittedSeed: async () => ({ verified: true }),
    verifyActiveRuntime: async () => {
      const identity = JSON.parse(await readFile(path.join(value.outputRoot, 'run-identity.json'), 'utf8'));
      return {
        source: {
          sourceSha256: value.document.source_sha256,
          pageCount: value.document.page_count,
          sourcePath: path.join(value.projectRoot, value.document.source_path),
        },
        runtime: identity.runtime,
        workerConfiguration: identity.worker_configuration,
        ocrScriptPath: value.continuationOptions.ocrScript,
      };
    },
    pageCounter: () => 2,
    invokeOcr: async () => {
      await rename(value.savedPageTwo, path.join(value.documentRoot, 'pages', '0002'));
      await writeFile(value.statePath, `${JSON.stringify(value.fullState, null, 2)}\n`, { mode: 0o600 });
      await writeFile(value.logPath, 'continued attempt 6\n', { flag: 'a' });
      return { code: 0, signal: null, monitorIncident: null };
    },
    now: () => '2026-07-22T04:30:00.000Z',
    handleSignals: false,
  };
}

test('argument parser keeps dry-run as the default and pairs shard inputs', () => {
  const parsed = parseReceiverArguments([
    '--manifest', 'parent.json',
    '--shard-manifest', 'a.json',
    '--shard-root', 'a-root',
    '--repair-manifest', '-',
    '--shard-manifest', 'b.json',
    '--shard-root', 'b-root',
    '--repair-manifest', 'b-repair.json',
  ]);
  assert.equal(parsed.apply, false);
  assert.deepEqual(parsed.shards, [
    { manifestPath: 'a.json', root: 'a-root' },
    { manifestPath: 'b.json', root: 'b-root', repairManifestPath: 'b-repair.json' },
  ]);
  assert.throws(
    () => parseReceiverArguments(['--manifest', 'parent.json', '--shard-manifest', 'a.json']),
    /matching pairs/,
  );
  assert.throws(
    () => parseReceiverArguments([
      '--manifest', 'parent.json',
      '--shard-manifest', 'a.json',
      '--shard-root', 'a-root',
      '--shard-manifest', 'b.json',
      '--shard-root', 'b-root',
      '--repair-manifest', 'b-repair.json',
    ]),
    /once per shard/,
  );
  assert.deepEqual(
    parseReceiverArguments(['--rollback-receipt', '/tmp/receipt.json']),
    { shards: [], apply: false, rollbackReceipt: '/tmp/receipt.json' },
  );
  assert.deepEqual(
    parseReceiverArguments(['--apply', '--rollback-receipt', '/tmp/receipt.json']),
    { shards: [], apply: true, rollbackReceipt: '/tmp/receipt.json' },
  );
  assert.throws(
    () => parseReceiverArguments([
      '--rollback-receipt', '/tmp/receipt.json',
      '--manifest', 'parent.json',
    ]),
    /cannot be combined/,
  );
  assert.deepEqual(
    parseReceiverArguments([
      '--manifest', 'parent.json',
      '--shard-manifest', 'a.json',
      '--shard-root', 'a-root',
      '--continuation-evidence-root', 'a-continuation',
      '--shard-manifest', 'b.json',
      '--shard-root', 'b-root',
      '--continuation-evidence-root', '-',
    ]).shards,
    [
      { manifestPath: 'a.json', root: 'a-root', continuationEvidenceRoot: 'a-continuation' },
      { manifestPath: 'b.json', root: 'b-root' },
    ],
  );
  assert.throws(
    () => parseReceiverArguments([
      '--manifest', 'parent.json',
      '--shard-manifest', 'a.json',
      '--shard-root', 'a-root',
      '--shard-manifest', 'b.json',
      '--shard-root', 'b-root',
      '--continuation-evidence-root', 'only-one',
    ]),
    /continuation-evidence-root.*once per shard/u,
  );
});

test('receiver rejects orphan continuation evidence on a non-A2 shard', async (t) => {
  const value = await fixture(t);
  const orphanRoot = path.join(value.root, 'orphan-continuation');
  await mkdir(orphanRoot, { mode: 0o700 });
  const shards = value.options.shards.map((shard, index) => (
    index === 0 ? { ...shard, continuationEvidenceRoot: orphanRoot } : shard
  ));
  await assert.rejects(
    receiveRemoteOcrOffload({ ...value.options, shards }, value.dependencies),
    /continuation evidence.*non-A2 shard/u,
  );
  assert.equal(await pathExists(value.productionRoot), false);
  assert.equal(await pathExists(value.receiptRoot), false);
});

test('operator continuation document evidence is scoped only to its exact target document', () => {
  const continuation = {
    evidence: {
      profile: { documentId: 'target-document' },
      receipt: { continuation_id: '1'.repeat(64) },
      claim: { claim_id: '2'.repeat(64) },
      evidence_fingerprint_sha256: '3'.repeat(64),
      states: [{ sha256: '4'.repeat(64) }],
    },
    output: { output_fingerprint_sha256: '5'.repeat(64) },
  };
  const shard = { operatorContinuation: continuation };
  assert.deepEqual(
    operatorContinuationReceiptDocument({ shard, document: { id: 'target-document' } }),
    {
      continuation_id: '1'.repeat(64),
      claim_id: '2'.repeat(64),
      evidence_fingerprint_sha256: '3'.repeat(64),
      output_fingerprint_sha256: '5'.repeat(64),
      terminal_state_sha256: '4'.repeat(64),
      citation_allowed: false,
    },
  );
  assert.equal(
    operatorContinuationReceiptDocument({ shard, document: { id: 'unrelated-document' } }),
    null,
  );
});

test('non-null A2 profile continues, receiver-applies, archives the complete evidence tree, and re-enters idempotently', async (t) => {
  const value = await a2ReceiverContinuationFixture(t);
  const continued = await continueOperatorInterruptedAttempt(
    value.continuationOptions,
    a2ContinuationDependencies(value),
  );
  assert.equal(continued.status, 'complete');
  const sourceEvidenceTree = await inspectTree(value.continuationPaths.root);
  assert.ok(sourceEvidenceTree.files >= 15, 'continuation archive must include all authority pairs and journal states');

  const receiverDependencies = {
    incidentProfile: value.profile,
    pageCounter: () => value.document.page_count,
  };
  const applied = await receiveRemoteOcrOffload(
    { ...value.receiverOptions, apply: true },
    receiverDependencies,
  );
  assert.equal(applied.status, 'applied');
  const receiptRaw = await readFile(applied.receipt_path);
  const receipt = JSON.parse(receiptRaw);
  const archived = receipt.source_evidence.shards[0].operator_continuation;
  assert.ok(archived, 'receiver receipt must retain operator continuation provenance');
  assert.deepEqual(await inspectTree(archived.path), sourceEvidenceTree);
  const archivedRuntimeManifest = await readFile(path.join(archived.path, 'runtime-manifest.json'));
  const sourceRuntimeManifest = await readFile(path.join(value.continuationPaths.root, 'runtime-manifest.json'));
  assert.ok(archivedRuntimeManifest.equals(sourceRuntimeManifest));
  assert.equal(
    JSON.parse(await readFile(path.join(archived.path, 'receipt.json'), 'utf8'))
      .authorization.runtime_manifest.sha256,
    sha256(archivedRuntimeManifest),
  );
  assert.equal(
    receipt.documents[0].operator_continuation.continuation_id,
    continued.continuation_id,
  );
  assert.equal(
    receipt.documents[0].operator_continuation.terminal_state_sha256,
    archived.terminal_state_sha256,
  );

  const repeated = await receiveRemoteOcrOffload(
    { ...value.receiverOptions, apply: true },
    receiverDependencies,
  );
  assert.equal(repeated.status, 'verified_idempotent');
  assert.equal(repeated.receipt_path, applied.receipt_path);
  assert.deepEqual(await readFile(applied.receipt_path), receiptRaw);
  assert.deepEqual(await inspectTree(archived.path), sourceEvidenceTree);
});

test('dry-run validates the exact shard union without writing destination or receipt files', async (t) => {
  const value = await fixture(t);
  const result = await receiveRemoteOcrOffload(value.options, value.dependencies);
  assert.equal(result.status, 'dry_run_validated');
  assert.equal(result.dry_run, true);
  assert.deepEqual(result.counts, {
    documents: 2,
    pages: 3,
    repair_pages: 0,
    existing_document_trees_to_backup: 0,
    existing_text_files_to_backup: 1,
  });
  assert.equal(await pathExists(value.productionRoot), false);
  assert.equal(await pathExists(value.receiptRoot), false);
  assert.equal(await readFile(path.join(value.textRoot, 'doc-a.txt'), 'utf8'), 'existing placeholder\n');
  const docA = result.documents.find((item) => item.document_id === 'doc-a');
  assert.equal(docA.joined_text_sha256, sha256('alpha page one\n\f'));
  assert.equal(docA.previous_text_sha256, sha256('existing placeholder\n'));
});

test('receiver rejects missing, drifted, or symlinked shard PaddleX caches before any write', async (t) => {
  const cases = [
    {
      name: 'missing cache',
      mutate: (cacheRoot) => rm(cacheRoot, { recursive: true }),
      error: /shard PaddleX cache is missing/,
    },
    {
      name: 'cache tree drift',
      mutate: (cacheRoot) => writeFile(
        path.join(cacheRoot, 'official_models/PP-DocLayoutV3/inference.yml'),
        'fixture: drifted\n',
      ),
      error: /shard PaddleX cache differs from the run identity/,
    },
    {
      name: 'symlinked cache root',
      mutate: async (cacheRoot) => {
        const realCacheRoot = `${cacheRoot}-real`;
        await rename(cacheRoot, realCacheRoot);
        await symlink(realCacheRoot, cacheRoot);
      },
      error: /shard PaddleX cache must be a canonical real directory/,
    },
  ];
  for (const value of cases) {
    await t.test(value.name, async (t) => {
      const fixtureValue = await fixture(t);
      await convertShardToHashBoundSeed(
        fixtureValue.shardA,
        { transition: 'p4_to_p1_v1' },
      );
      await value.mutate(path.join(fixtureValue.shardA.shardRoot, 'paddlex-cache'));
      await assert.rejects(
        receiveRemoteOcrOffload(fixtureValue.options, fixtureValue.dependencies),
        value.error,
      );
      assert.equal(await pathExists(fixtureValue.productionRoot), false);
      assert.equal(await pathExists(fixtureValue.receiptRoot), false);
    });
  }
});

test('receiver independently verifies seeded lineage, attempt floors, and archives exact receipt evidence', async (t) => {
  await t.test('exact p4-to-p1 shards pass only as one p1/p1 union', async (t) => {
    const value = await fixture(t);
    await convertShardToHashBoundSeed(value.shardA, { transition: 'p4_to_p1_v1' });
    await convertShardToHashBoundSeed(value.shardB, { transition: 'p4_to_p1_v1' });
    const result = await receiveRemoteOcrOffload(value.options, value.dependencies);
    assert.equal(result.status, 'dry_run_validated');
    assert.deepEqual(
      [...new Set(result.source_shards.map((shard) => shard.runtime_fingerprint_sha256))],
      [p1RuntimeFingerprintSha256],
    );
  });

  await t.test('exact schema-v3 B1-to-seed-aware shards pass only as one v3/v3 union', async (t) => {
    const value = await fixture(t);
    await convertShardToHashBoundSeed(value.shardA, { transition: seedAwareTransition });
    await convertShardToHashBoundSeed(value.shardB, { transition: seedAwareTransition });
    const result = await receiveRemoteOcrOffload(value.options, value.dependencies);
    assert.equal(result.status, 'dry_run_validated');
    const successorHashes = await Promise.all(
      [value.shardA, value.shardB].map((shard) => readFile(
        path.join(shard.shardRoot, 'run-identity.json'),
        'utf8',
      ).then((raw) => JSON.parse(raw).ocr_script_sha256)),
    );
    assert.deepEqual(successorHashes, [seedAwareOcrScriptSha256, seedAwareOcrScriptSha256]);
  });

  await t.test('a schema-v2/schema-v3 A/B union is rejected before publication', async (t) => {
    const value = await fixture(t);
    await convertShardToHashBoundSeed(value.shardA, { transition: seedAwareTransition });
    await convertShardToHashBoundSeed(value.shardB, { transition: 'p4_to_p1_v1' });
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /mixes different audited OCR script transition contracts/,
    );
    assert.equal(await pathExists(value.productionRoot), false);
    assert.equal(await pathExists(value.receiptRoot), false);
  });

  await t.test('a mixed p4/p1 shard union is rejected', async (t) => {
    const value = await fixture(t);
    await convertShardToHashBoundSeed(value.shardA, { transition: 'p4_to_p1_v1' });
    const shardBIdentityPath = path.join(value.shardB.shardRoot, 'run-identity.json');
    const shardBRunStatusPath = path.join(value.shardB.shardRoot, 'run-status.json');
    const shardBIdentity = JSON.parse(await readFile(shardBIdentityPath, 'utf8'));
    shardBIdentity.llama_server_attestation = structuredClone(p1Attestation);
    shardBIdentity.llama_server_attestation_sha256 = p1AttestationSha256;
    shardBIdentity.runtime_fingerprint = structuredClone(p1RuntimeFingerprint);
    shardBIdentity.runtime_fingerprint_sha256 = p1RuntimeFingerprintSha256;
    shardBIdentity.worker_configuration = {
      ...shardBIdentity.worker_configuration,
      vl_rec_max_concurrency: 1,
      server_parallel: 1,
    };
    shardBIdentity.document_recovery = {
      ...shardBIdentity.document_recovery,
      child_monitoring: {
        ...shardBIdentity.document_recovery.child_monitoring,
        idle_timeout_seconds: 1200,
      },
    };
    await writeJson(shardBIdentityPath, shardBIdentity);
    const shardBRunStatus = JSON.parse(await readFile(shardBRunStatusPath, 'utf8'));
    shardBRunStatus.runtime_fingerprint_sha256 = p1RuntimeFingerprintSha256;
    shardBRunStatus.document_recovery = structuredClone(shardBIdentity.document_recovery);
    const shardBRunStatusWritten = await writeJson(shardBRunStatusPath, shardBRunStatus);
    await writeSidecar(shardBRunStatusPath, shardBRunStatusWritten.sha256);
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /mixes audited p4-to-p1 and legacy execution contracts/,
    );
  });

  await t.test('p1 shard union rejects different successor runner code', async (t) => {
    const value = await fixture(t);
    await convertShardToHashBoundSeed(value.shardA, {
      transition: 'p4_to_p1_v1',
      successorRunnerScriptSha256: 'e'.repeat(64),
    });
    await convertShardToHashBoundSeed(value.shardB, {
      transition: 'p4_to_p1_v1',
      successorRunnerScriptSha256: '9'.repeat(64),
    });
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /p1 shard union runner drift is outside the unique directed A\+B compatibility pair/,
    );
  });

  await t.test('p1 shard union permits shard-local cache paths only with the same cache tree', async (t) => {
    const value = await fixture(t);
    const shardARoot = await realpath(value.shardA.shardRoot);
    const shardBRoot = await realpath(value.shardB.shardRoot);
    const shardACache = path.join(shardARoot, 'runtime-cache', 'paddlex');
    const shardBCache = path.join(shardBRoot, 'runtime-cache', 'paddlex');
    await materializeLayoutCache(path.dirname(shardACache));
    await materializeLayoutCache(path.dirname(shardBCache));
    await rename(path.join(path.dirname(shardACache), 'paddlex-cache'), shardACache);
    await rename(path.join(path.dirname(shardBCache), 'paddlex-cache'), shardBCache);
    await convertShardToHashBoundSeed(value.shardA, {
      transition: 'p4_to_p1_v1',
      successorPaddlexCacheHome: shardACache,
    });
    await convertShardToHashBoundSeed(value.shardB, {
      transition: 'p4_to_p1_v1',
      successorPaddlexCacheHome: shardBCache,
    });
    const result = await receiveRemoteOcrOffload(value.options, value.dependencies);
    assert.equal(result.status, 'dry_run_validated');
  });

  await t.test('receiver p4-to-p1 validator rejects forbidden and declaration deltas', async (t) => {
    const value = await fixture(t);
    const seed = await convertShardToHashBoundSeed(
      value.shardA,
      { transition: 'p4_to_p1_v1' },
    );
    const [receipt, predecessorIdentity, successorIdentity] = await Promise.all([
      readFile(seed.receiptPath, 'utf8').then(JSON.parse),
      readFile(path.join(seed.predecessorEvidenceRoot, 'run-identity.json'), 'utf8').then(JSON.parse),
      readFile(path.join(value.shardA.shardRoot, 'run-identity.json'), 'utf8').then(JSON.parse),
    ]);
    assert.equal(
      validateP4ToP1SeedDelta(receipt, predecessorIdentity, successorIdentity),
      'p4_to_p1_v1',
    );

    const forbidden = structuredClone(successorIdentity);
    forbidden.worker_configuration.micro_batch = 8;
    const forbiddenReceipt = structuredClone(receipt);
    forbiddenReceipt.successor.worker_configuration = forbidden.worker_configuration;
    forbiddenReceipt.successor.worker_configuration_sha256 = sha256(
      canonicalJson(forbidden.worker_configuration),
    );
    assert.throws(
      () => validateP4ToP1SeedDelta(forbiddenReceipt, predecessorIdentity, forbidden),
      /exact concurrency delta/,
    );

    const declaration = structuredClone(receipt);
    declaration.allowed_configuration_delta.server_parallel.successor = 4;
    assert.throws(
      () => validateP4ToP1SeedDelta(declaration, predecessorIdentity, successorIdentity),
      /allowed configuration delta declaration is not exact/,
    );

    const ocrDrift = structuredClone(successorIdentity);
    ocrDrift.ocr_script_sha256 = '0'.repeat(64);
    const ocrDriftReceipt = structuredClone(receipt);
    ocrDriftReceipt.successor.ocr_script_sha256 = ocrDrift.ocr_script_sha256;
    assert.throws(
      () => validateP4ToP1SeedDelta(ocrDriftReceipt, predecessorIdentity, ocrDrift),
      /identical OCR script identity/,
    );
  });

  await t.test('schema-v3 OCR transition rejects pair, suffix, extra keys, schema downgrade, and v1 disguise', async (t) => {
    const value = await fixture(t);
    const seed = await convertShardToHashBoundSeed(
      value.shardA,
      { transition: seedAwareTransition },
    );
    const [receipt, predecessorIdentity, successorIdentity] = await Promise.all([
      readFile(seed.receiptPath, 'utf8').then(JSON.parse),
      readFile(path.join(seed.predecessorEvidenceRoot, 'run-identity.json'), 'utf8').then(JSON.parse),
      readFile(path.join(value.shardA.shardRoot, 'run-identity.json'), 'utf8').then(JSON.parse),
    ]);
    assert.equal(
      validateP4ToP1SeedDelta(receipt, predecessorIdentity, successorIdentity),
      seedAwareTransition,
    );

    const cases = [
      ['pair', (candidate, predecessor) => {
        predecessor.ocr_script_sha256 = '0'.repeat(64);
        candidate.predecessor.ocr_script_sha256 = predecessor.ocr_script_sha256;
      }, /exact audited transition/],
      ['suffix', (candidate) => {
        candidate.allowed_configuration_delta.ocr_script_transition
          .audited_common_inference_suffix_sha256 = '0'.repeat(64);
      }, /declaration is not exact/],
      ['nested extra', (candidate) => {
        candidate.allowed_configuration_delta.ocr_script_transition.extra = true;
      }, /field set differs/],
      ['delta extra', (candidate) => {
        candidate.allowed_configuration_delta.extra = true;
      }, /allowed configuration delta declaration is not exact/],
      ['schema downgrade', (candidate) => {
        candidate.allowed_configuration_delta.schema_version = 2;
      }, /transition declaration/],
      ['v1 disguise', (candidate) => {
        candidate.allowed_configuration_delta = {
          schema_version: 1,
          vl_rec_max_concurrency: { predecessor: 4, successor: 1 },
        };
      }, /transition declaration/],
    ];
    for (const [name, mutate, pattern] of cases) {
      const candidate = structuredClone(receipt);
      const predecessor = structuredClone(predecessorIdentity);
      const successor = structuredClone(successorIdentity);
      mutate(candidate, predecessor, successor);
      assert.throws(
        () => validateP4ToP1SeedDelta(candidate, predecessor, successor),
        pattern,
        name,
      );
    }
  });

  await t.test('valid seeded shard is fingerprinted and archived on apply', async (t) => {
    const value = await fixture(t);
    const seed = await convertShardToHashBoundSeed(value.shardA);
    const dryRun = await receiveRemoteOcrOffload(value.options, value.dependencies);
    const seededShard = dryRun.source_shards.find((shard) => shard.seed_id);
    assert.equal(seededShard.seed_id, seed.seedId);
    assert.match(seededShard.seed_receipt_sha256, /^[a-f0-9]{64}$/);
    assert.match(seededShard.seed_commit_marker_sha256, /^[a-f0-9]{64}$/);
    const applied = await receiveRemoteOcrOffload({ ...value.options, apply: true }, value.dependencies);
    const archived = applied.source_evidence.shards[0].seed_lineage;
    assert.equal(await pathExists(archived.receipt.path), true);
    assert.equal(await pathExists(`${archived.receipt.path}.sha256`), true);
    assert.equal(await pathExists(archived.commit_marker.path), true);
    assert.equal(await pathExists(`${archived.commit_marker.path}.sha256`), true);
    assert.equal(await readFile(archived.receipt.path).then(sha256), archived.receipt.sha256);
    assert.equal(await pathExists(archived.predecessor_controls.path), true);
    const [sourceControls, archivedControls] = await Promise.all([
      inspectTree(seed.predecessorEvidenceRoot),
      inspectTree(archived.predecessor_controls.path),
    ]);
    assert.deepEqual(archivedControls, sourceControls);
    assert.equal(archived.predecessor_controls.tree_sha256, sourceControls.tree_sha256);
    assert.equal(
      await readFile(path.join(archived.predecessor_controls.path, 'inventory.json')).then(sha256),
      archived.predecessor_controls.inventory_sha256,
    );
  });

  for (const [mutation, pattern] of [
    ['missing', /seed predecessor evidence tree differs from the receipt contract/],
    ['extra', /seed predecessor evidence tree differs from the receipt contract/],
    ['symlink', /symbolic link/],
    ['tamper', /seed predecessor evidence tree differs from the receipt contract/],
  ]) {
    await t.test(`raw predecessor evidence ${mutation} is rejected before local writes`, async (t) => {
      const value = await fixture(t);
      const seed = await convertShardToHashBoundSeed(value.shardA);
      const statusSidecar = path.join(seed.predecessorEvidenceRoot, 'run-status.json.sha256');
      if (mutation === 'missing') {
        await rm(statusSidecar);
      } else if (mutation === 'extra') {
        await writeFile(path.join(seed.predecessorEvidenceRoot, 'unexpected.txt'), 'unexpected\n');
      } else if (mutation === 'symlink') {
        await rm(statusSidecar);
        await symlink('run-identity.json', statusSidecar);
      } else {
        const raw = await readFile(statusSidecar);
        await writeFile(statusSidecar, Buffer.concat([raw, Buffer.from('tamper\n')]));
      }
      await assert.rejects(
        receiveRemoteOcrOffload(value.options, value.dependencies),
        pattern,
      );
      assert.equal(await pathExists(value.receiptRoot), false);
    });
  }

  await t.test('attempt reset below inherited floor is rejected even with a valid status sidecar', async (t) => {
    const value = await fixture(t);
    await convertShardToHashBoundSeed(value.shardA);
    const runStatusPath = path.join(value.shardA.shardRoot, 'run-status.json');
    const runStatus = JSON.parse(await readFile(runStatusPath, 'utf8'));
    runStatus.documents['doc-a'].attempts = 0;
    const written = await writeJson(runStatusPath, runStatus);
    await writeSidecar(runStatusPath, written.sha256);
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /attempt floor/,
    );
  });

  await t.test('inherited page tag drift is rejected before local writes', async (t) => {
    const value = await fixture(t);
    await convertShardToHashBoundSeed(value.shardA);
    const statePath = path.join(value.shardA.shardRoot, 'documents/doc-a/state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.pages['1'].seed_provenance.seed_id = '2'.repeat(64);
    await writeJson(statePath, state);
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /seed provenance mismatch|seed artifact identity changed/,
    );
    assert.equal(await pathExists(value.receiptRoot), false);
  });

  for (const [tamper, pattern] of [
    ['predecessor_runtime_fingerprint', /predecessor or successor contract differs/],
    ['duplicate_artifact_page', /artifact sequence differs from completed_pages/],
    ['inherited_document_count', /counts or fail-closed gates are invalid/],
    ['initial_run_status_inventory', /run-status\.json is not cross-bound/],
    ['raw_state_configuration', /raw predecessor state identity or page set is invalid/],
  ]) {
    await t.test(`coherently rebound ${tamper} tamper is independently rejected`, async (t) => {
      const value = await fixture(t);
      await convertShardToHashBoundSeed(value.shardA, { tamper });
      await assert.rejects(
        receiveRemoteOcrOffload(value.options, value.dependencies),
        pattern,
      );
      assert.equal(await pathExists(value.receiptRoot), false);
    });
  }
});

test('receiver rejects schema-v1 timeout recovery before any local write', async (t) => {
  const value = await fixture(t);
  await convertShardToTimeoutRecoverySeed(value.shardA, {
    firstMissingPageById: new Map([['doc-a', 2]]),
  });
  await assert.rejects(
    receiveRemoteOcrOffload(value.options, value.dependencies),
    /timeout recovery is permitted only for an audited p4-to-p1 transition/,
  );
  assert.equal(await pathExists(value.productionRoot), false);
  assert.equal(await pathExists(value.receiptRoot), false);
});

test('receiver resolves destination roots and rejects a symlink escape before validation or writes', async (t) => {
  const value = await fixture(t);
  const outsideProduction = path.join(value.root, 'outside-production');
  await mkdir(outsideProduction);
  await symlink(outsideProduction, value.productionRoot);
  await assert.rejects(
    receiveRemoteOcrOffload(value.options, value.dependencies),
    /productionRoot must remain inside --project-root/,
  );
  assert.deepEqual(await readdir(outsideProduction), []);
  assert.equal(await pathExists(value.receiptRoot), false);
});

test('explicit local reprocess dry-run supports a mixed replace/install manifest and binds retry state', async (t) => {
  const value = await fixture(t, { reprocessA: true, reprocessAPageRetry: true });
  const result = await receiveRemoteOcrOffload(value.options, value.dependencies);
  assert.equal(result.status, 'dry_run_validated');
  assert.deepEqual(result.counts, {
    documents: 2,
    pages: 3,
    repair_pages: 0,
    existing_document_trees_to_backup: 1,
    existing_text_files_to_backup: 1,
  });
  const docA = result.documents.find((item) => item.document_id === 'doc-a');
  const docB = result.documents.find((item) => item.document_id === 'doc-b');
  assert.equal(docA.replacement_mode, 'replace_existing_local_document');
  assert.match(docA.planned_local_snapshot_sha256, /^[a-f0-9]{64}$/);
  assert.match(docA.previous_document_tree_sha256, /^[a-f0-9]{64}$/);
  assert.equal(docB.replacement_mode, 'install_into_absent_destination');
  assert.equal(await readFile(
    path.join(value.productionRoot, 'doc-a/pages/0001/content.md'),
    'utf8',
  ), 'original local partial page 1\n');
  assert.equal(JSON.parse(await readFile(
    path.join(value.supervisorRoot, 'page-retries.json'),
    'utf8',
  ))['doc-a:2:paddle'].quarantined, true);
});

test('explicit local reprocess fails closed on document, retry-ledger, or missing-page drift', async (t) => {
  await t.test('document tree drift', async (t) => {
    const value = await fixture(t, { reprocessA: true });
    await writeFile(path.join(value.productionRoot, 'doc-a/audit-local.json'), '{"status":"changed"}\n');
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /local reprocess snapshot changed after planning/,
    );
  });
  await t.test('retry ledger drift', async (t) => {
    const value = await fixture(t, { reprocessA: true, reprocessAPageRetry: true });
    await writeJson(path.join(value.supervisorRoot, 'page-retries.json'), {
      'doc-a:2:paddle': { attempts: 6, quarantined: true },
    });
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /local reprocess snapshot changed after planning/,
    );
  });
  await t.test('local completed page disappears', async (t) => {
    const value = await fixture(t, { reprocessA: true });
    await rm(path.join(value.productionRoot, 'doc-a/pages/0001'), { recursive: true });
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /physical local page directories do not exactly equal completed_pages/,
    );
  });
  await t.test('remote whole-document result loses a page', async (t) => {
    const value = await fixture(t, { reprocessA: true });
    await rm(path.join(value.shardA.shardRoot, 'documents/doc-a/pages/0002'), { recursive: true });
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /physical page directory set is not exactly 1\.\.2/,
    );
  });
});

test('receiver rejects overlapping shard documents before any local write', async (t) => {
  const value = await fixture(t);
  const duplicate = await createShard({
    manifestPath: path.join(value.root, 'duplicate-a-manifest.json'),
    shardRoot: path.join(value.root, 'duplicate-a'),
    documents: [value.documentA],
    pageTexts: value.pageTexts,
  });
  await assert.rejects(
    receiveRemoteOcrOffload({
      ...value.options,
      shards: [
        value.options.shards[0],
        { manifestPath: duplicate.manifestPath, root: duplicate.shardRoot },
      ],
    }, value.dependencies),
    /document appears in more than one shard: doc-a/,
  );
  assert.equal(await pathExists(value.receiptRoot), false);
});

test('receiver rejects an incomplete shard union', async (t) => {
  const value = await fixture(t);
  const sourceC = 'source-c';
  const documentC = documentFor('doc-c', 'sources/c.pdf', sourceC, 1);
  await writeJson(value.parentManifestPath, manifestFor([
    value.documentA,
    value.documentB,
    documentC,
  ]));
  await assert.rejects(
    receiveRemoteOcrOffload(value.options, value.dependencies),
    /shard union does not exactly equal the parent manifest/,
  );
});

test('receiver rejects tampered runtime/status identity and unexpected document artifacts', async (t) => {
  await t.test('run identity citation gate', async (t) => {
    const value = await fixture(t);
    const pathname = path.join(value.shardA.shardRoot, 'run-identity.json');
    const identity = JSON.parse(await readFile(pathname, 'utf8'));
    identity.citation_allowed = true;
    await writeJson(pathname, identity);
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /run identity citation_allowed must equal false/,
    );
  });
  await t.test('run-status sidecar', async (t) => {
    const value = await fixture(t);
    await writeFile(path.join(value.shardA.shardRoot, 'run-status.json'), '{"broken":true}\n');
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /run status SHA-256 sidecar mismatch/,
    );
  });
  await t.test('unexpected page artifact', async (t) => {
    const value = await fixture(t);
    await writeFile(path.join(value.shardA.shardRoot, 'documents/doc-a/pages/0001/rogue.txt'), 'rogue');
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /page contains unexpected artifacts/,
    );
  });
});

test('native Paddle Markdown asset trees are strictly bound, hashed, and fail closed', async (t) => {
  await t.test('valid bound JPG assets are accepted with a deterministic Markdown tree hash', async (t) => {
    const value = await fixture(t, { nativeAssetA: true });
    const first = await receiveRemoteOcrOffload(value.options, value.dependencies);
    const second = await receiveRemoteOcrOffload(value.options, value.dependencies);
    const document = first.documents.find((item) => item.document_id === 'doc-a');
    const repeated = second.documents.find((item) => item.document_id === 'doc-a');
    assert.equal(document.native_markdown_asset_count, 1);
    assert.equal(document.native_markdown_asset_bytes, Buffer.byteLength('fixture Paddle JPEG bytes'));
    assert.match(document.native_markdown_trees_sha256, /^[a-f0-9]{64}$/);
    assert.equal(document.native_markdown_trees_sha256, repeated.native_markdown_trees_sha256);
  });

  await t.test('an asset absent from Paddle result geometry is rejected', async (t) => {
    const value = await fixture(t, { nativeAssetA: true, bindNativeAssets: false });
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /Paddle Markdown asset is not bound to result geometry/,
    );
  });

  await t.test('the native Markdown mirror must remain byte-identical to content.md', async (t) => {
    const value = await fixture(t);
    await writeFile(
      path.join(value.shardA.shardRoot, 'documents/doc-a/pages/0001/markdown/page-0001.md'),
      'drifted native mirror\n',
    );
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /native Paddle Markdown mirror or state hash mismatch/,
    );
  });

  await t.test('unknown asset filenames are rejected even when they are regular JPG files', async (t) => {
    const value = await fixture(t, { nativeAssetA: true });
    const imagesRoot = path.join(value.shardA.shardRoot, 'documents/doc-a/pages/0001/markdown/imgs');
    await rm(path.join(imagesRoot, 'img_in_image_box_245_322_1414_1925.jpg'));
    await writeFile(path.join(imagesRoot, 'unbound.jpg'), 'fixture Paddle JPEG bytes');
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /asset name is not a pinned Paddle filename/,
    );
  });

  await t.test('a Paddle-looking asset symlink is rejected', async (t) => {
    const value = await fixture(t, { nativeAssetA: true });
    const assetPath = path.join(
      value.shardA.shardRoot,
      'documents/doc-a/pages/0001/markdown/imgs/img_in_image_box_245_322_1414_1925.jpg',
    );
    await rm(assetPath);
    await symlink('../../content.md', assetPath);
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /Markdown asset is not a regular file/,
    );
  });

  await t.test('repair mirrors cannot inherit native Paddle image assets', async (t) => {
    const value = await fixture(t, { repairB: true });
    const imagesRoot = path.join(value.shardB.shardRoot, 'documents/doc-b/pages/0001/markdown/imgs');
    await mkdir(imagesRoot);
    await writeFile(
      path.join(imagesRoot, 'img_in_image_box_245_322_1414_1925.jpg'),
      'fixture Paddle JPEG bytes',
    );
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /repaired page must not contain unbound Paddle Markdown assets/,
    );
  });
});

test('quarantined documents require exact independently hashed repair provenance', async (t) => {
  await t.test('valid repair', async (t) => {
    const value = await fixture(t, { repairB: true });
    const result = await receiveRemoteOcrOffload(value.options, value.dependencies);
    assert.equal(result.counts.repair_pages, 1);
    const repaired = result.documents.find((item) => item.document_id === 'doc-b');
    assert.equal(repaired.source_document_status, 'quarantined');
    assert.equal(repaired.repair_pages, 1);
    assert.equal(result.citation_allowed, false);
  });
  await t.test('quarantine without repair', async (t) => {
    const value = await fixture(t, { quarantineB: true });
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /quarantined document has no independently adjudicated repair pages/,
    );
  });
  await t.test('repaired state requires an explicit per-shard manifest argument', async (t) => {
    const value = await fixture(t, { repairB: true });
    const shards = structuredClone(value.options.shards);
    delete shards[1].repairManifestPath;
    await assert.rejects(
      receiveRemoteOcrOffload({ ...value.options, shards }, value.dependencies),
      /explicit --repair-manifest is missing/,
    );
  });
  await t.test('repair provenance cannot enable citation', async (t) => {
    const value = await fixture(t, { repairB: true, repairCitationEligible: true });
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /repair provenance contract mismatch/,
    );
  });
  await t.test('repair manifest must retain its independent hash', async (t) => {
    const value = await fixture(t, { repairB: true });
    const pathname = value.shardB.repairManifestPath;
    const manifest = JSON.parse(await readFile(pathname, 'utf8'));
    manifest.method = 'changed_after_application';
    const rewritten = await writeJson(pathname, manifest);
    await writeSidecar(pathname, rewritten.sha256);
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /repair provenance contract mismatch|repair receipt identity conflicts/,
    );
  });
  await t.test('repair evidence must still match its independently declared hash', async (t) => {
    const value = await fixture(t, { repairB: true });
    const manifest = JSON.parse(await readFile(value.shardB.repairManifestPath, 'utf8'));
    const evidencePath = path.join(
      path.dirname(value.shardB.repairManifestPath),
      manifest.documents[0].pages[0].evidence[1].path,
    );
    await writeFile(evidencePath, 'tampered online evidence');
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /repair evidence hash mismatch/,
    );
  });
  await t.test('repair receipt must bind the current repaired state', async (t) => {
    const value = await fixture(t, { repairB: true });
    const manifest = JSON.parse(await readFile(value.shardB.repairManifestPath, 'utf8'));
    const receiptPath = path.join(
      value.shardB.shardRoot,
      'repair-receipts',
      `${manifest.repair_id}.json`,
    );
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    receipt.documents[0].state_after_sha256 = '0'.repeat(64);
    const rewritten = await writeJson(receiptPath, receipt);
    await writeSidecar(receiptPath, rewritten.sha256);
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /repair receipt state or document identity mismatch/,
    );
  });
  await t.test('repaired Markdown mirror must equal the adjudicated final text', async (t) => {
    const value = await fixture(t, { repairB: true });
    await writeFile(
      path.join(value.shardB.shardRoot, 'documents/doc-b/pages/0001/markdown/page-0001.md'),
      'drifted mirror\n',
    );
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /repaired artifacts conflict with the repair manifest/,
    );
  });
  await t.test('repair manifest final text must equal the repaired content', async (t) => {
    const value = await fixture(t, { repairB: true, repairFinalTextMismatch: true });
    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      /repaired artifacts conflict with the repair manifest/,
    );
  });
});

test('apply atomically installs whole documents, replaces text, and writes exact rollback evidence', async (t) => {
  const value = await fixture(t, { repairB: true, nativeAssetA: true });
  const result = await receiveRemoteOcrOffload(
    { ...value.options, apply: true },
    value.dependencies,
  );
  assert.equal(result.status, 'applied');
  assert.equal(result.counts.documents, 2);
  assert.equal(result.counts.repair_pages, 1);
  assert.equal(
    await readFile(path.join(value.textRoot, 'doc-a.txt'), 'utf8'),
    `${value.pageTexts.get('doc-a')[0]}\f${value.pageTexts.get('doc-a')[1]}`,
  );
  assert.equal(await readFile(path.join(value.textRoot, 'doc-b.txt'), 'utf8'), 'beta page one\n');
  assert.equal(
    await readFile(path.join(path.dirname(result.receipt_path), 'backups/text/doc-a.txt'), 'utf8'),
    'existing placeholder\n',
  );
  assert.equal(await pathExists(path.join(value.productionRoot, 'doc-a/state.json')), true);
  assert.equal(await pathExists(path.join(value.productionRoot, 'doc-b/state.json')), true);
  assert.equal(
    await pathExists(path.join(
      value.productionRoot,
      'doc-a/pages/0001/markdown/imgs/img_in_image_box_245_322_1414_1925.jpg',
    )),
    true,
  );
  assert.deepEqual((await readdir(value.productionRoot)).sort(), ['doc-a', 'doc-b']);
  assert.deepEqual((await readdir(value.textRoot)).sort(), ['doc-a.txt', 'doc-b.txt']);
  const receipt = JSON.parse(await readFile(result.receipt_path, 'utf8'));
  assert.equal(receipt.status, 'applied');
  assert.equal(receipt.citation_allowed, false);
  assert.equal(receipt.documents[0].rollback.target_document_path.endsWith('doc-a'), true);
  assert.equal(receipt.documents[0].rollback.document_action, 'remove_new_tree');
  assert.equal(receipt.documents[0].rollback.text_action, 'restore_verified_backup');
  assert.equal(receipt.documents[1].rollback.text_action, 'remove_new_file');
  assert.equal(await pathExists(receipt.source_evidence.parent_manifest.path), true);
  const archivedRepair = receipt.source_evidence.shards
    .map((shard) => shard.repair?.manifest?.path)
    .find(Boolean);
  assert.equal(await pathExists(archivedRepair), true);
  const archivedRepairReceipt = receipt.source_evidence.shards
    .map((shard) => shard.repair?.receipt?.path)
    .find(Boolean);
  assert.equal(await pathExists(archivedRepairReceipt), true);
  const archivedRepairEvidence = receipt.source_evidence.shards
    .flatMap((shard) => shard.repair?.evidence || []);
  assert.equal(archivedRepairEvidence.length, 2);
  assert.equal(await pathExists(archivedRepairEvidence[0].path), true);
  const sidecar = await readFile(`${result.receipt_path}.sha256`, 'utf8');
  assert.match(sidecar, /^[a-f0-9]{64}  receipt\.json\n$/);
  const receiptBeforeRepeat = await readFile(result.receipt_path, 'utf8');
  const repeated = await receiveRemoteOcrOffload(
    { ...value.options, apply: true },
    value.dependencies,
  );
  assert.equal(repeated.status, 'verified_idempotent');
  assert.equal(repeated.receipt_path, result.receipt_path);
  assert.equal(await readFile(result.receipt_path, 'utf8'), receiptBeforeRepeat);
  assert.deepEqual((await readdir(value.productionRoot)).sort(), ['doc-a', 'doc-b']);
  assert.deepEqual((await readdir(value.textRoot)).sort(), ['doc-a.txt', 'doc-b.txt']);
});

test('explicit local reprocess apply preserves the original tree, clears owned retries, rolls back, and reapplies safely', async (t) => {
  const value = await fixture(t, { reprocessA: true, reprocessAPageRetry: true });
  const applied = await receiveRemoteOcrOffload(
    { ...value.options, apply: true },
    value.dependencies,
  );
  assert.equal(applied.status, 'applied');
  assert.equal(applied.counts.replaced_local_documents, 1);
  const receipt = JSON.parse(await readFile(applied.receipt_path, 'utf8'));
  const docA = receipt.documents.find((item) => item.document_id === 'doc-a');
  assert.equal(docA.replacement_mode, 'replace_existing_local_document');
  assert.equal(docA.previous_document.existed, true);
  assert.equal(
    await readFile(path.join(docA.previous_document.backup_path, 'pages/0001/content.md'), 'utf8'),
    'original local partial page 1\n',
  );
  assert.equal(
    await readFile(path.join(value.productionRoot, 'doc-a/pages/0001/content.md'), 'utf8'),
    value.pageTexts.get('doc-a')[0],
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(value.supervisorRoot, 'page-retries.json'), 'utf8')),
    {},
  );
  assert.equal(
    JSON.parse(await readFile(
      receipt.supervisor_retry_ledgers.ledgers.find((item) => item.name === 'page_retries').before.backup_path,
      'utf8',
    ))['doc-a:2:paddle'].quarantined,
    true,
  );

  const repeatedApply = await receiveRemoteOcrOffload(
    { ...value.options, apply: true },
    value.dependencies,
  );
  assert.equal(repeatedApply.status, 'verified_idempotent');
  assert.equal(repeatedApply.receipt_path, applied.receipt_path);

  const rollbackDryRun = await receiveRemoteOcrOffload({
    rollbackReceipt: applied.receipt_path,
    apply: false,
  });
  assert.equal(rollbackDryRun.status, 'rollback_dry_run_validated');
  assert.equal(rollbackDryRun.documents[0].document_action, 'restore_verified_backup');

  const rolledBack = await receiveRemoteOcrOffload({
    rollbackReceipt: applied.receipt_path,
    apply: true,
  });
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(
    await readFile(path.join(value.productionRoot, 'doc-a/pages/0001/content.md'), 'utf8'),
    'original local partial page 1\n',
  );
  assert.equal(
    await readFile(path.join(value.textRoot, 'doc-a.txt'), 'utf8'),
    'original local partial joined text\n',
  );
  assert.equal(
    JSON.parse(await readFile(path.join(value.supervisorRoot, 'page-retries.json'), 'utf8'))['doc-a:2:paddle'].quarantined,
    true,
  );
  assert.equal(await pathExists(path.join(value.productionRoot, 'doc-b')), false);
  assert.equal(await pathExists(path.join(value.textRoot, 'doc-b.txt')), false);

  const repeatedRollback = await receiveRemoteOcrOffload({
    rollbackReceipt: applied.receipt_path,
    apply: true,
  });
  assert.equal(repeatedRollback.status, 'verified_idempotent');

  const reapplied = await receiveRemoteOcrOffload(
    { ...value.options, apply: true },
    value.dependencies,
  );
  assert.equal(reapplied.status, 'applied');
  assert.notEqual(reapplied.receipt_path, applied.receipt_path);
});

test('idempotent re-entry fails closed if an applied target drifts', async (t) => {
  const value = await fixture(t);
  await receiveRemoteOcrOffload(
    { ...value.options, apply: true },
    value.dependencies,
  );
  await writeFile(path.join(value.textRoot, 'doc-b.txt'), 'drifted\n');
  await assert.rejects(
    receiveRemoteOcrOffload(
      { ...value.options, apply: true },
      value.dependencies,
    ),
    /idempotent target hashes differ from the applied receipt/,
  );
});

test('apply rechecks local ownership after staging and leaves no receiver artifacts on conflict', async (t) => {
  const value = await fixture(t);
  await assert.rejects(
    receiveRemoteOcrOffload(
      { ...value.options, apply: true },
      {
        ...value.dependencies,
        beforeApplyRecheck: async () => {
          await mkdir(path.join(value.productionRoot, 'doc-b'));
        },
      },
    ),
    /doc-b: local production destination already exists/,
  );
  assert.equal(await pathExists(path.join(value.productionRoot, 'doc-a')), false);
  assert.equal(await readFile(path.join(value.textRoot, 'doc-a.txt'), 'utf8'), 'existing placeholder\n');
  assert.deepEqual(await readdir(value.receiptRoot), []);
  assert.equal(
    (await readdir(value.productionRoot)).some((name) => name.startsWith('.receive-')),
    false,
  );
});

test('receiver refuses to race a running local watchdog', async (t) => {
  const value = await fixture(t);
  await writeJson(path.join(value.supervisorRoot, 'watchdog-control.json'), { mode: 'run' });
  await assert.rejects(
    receiveRemoteOcrOffload(value.options, value.dependencies),
    /local OCR watchdog must be held before remote receipt; current mode=run/,
  );
  assert.equal(await pathExists(value.receiptRoot), false);
});

test('a later commit failure rolls back already installed documents and restores prior text', async (t) => {
  const value = await fixture(t);
  await assert.rejects(
    receiveRemoteOcrOffload(
      { ...value.options, apply: true },
      {
        ...value.dependencies,
        beforeCommitDocument: async (documentId) => {
          if (documentId === 'doc-b') throw new Error('synthetic commit failure');
        },
      },
    ),
    /synthetic commit failure/,
  );
  assert.equal(await pathExists(path.join(value.productionRoot, 'doc-a')), false);
  assert.equal(await pathExists(path.join(value.productionRoot, 'doc-b')), false);
  assert.equal(await readFile(path.join(value.textRoot, 'doc-a.txt'), 'utf8'), 'existing placeholder\n');
  assert.equal(await pathExists(path.join(value.textRoot, 'doc-b.txt')), false);
  const receiptDirectories = (await readdir(value.receiptRoot)).filter((name) => !name.startsWith('.'));
  assert.equal(receiptDirectories.length, 1);
  const receiptPath = path.join(value.receiptRoot, receiptDirectories[0], 'receipt.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(receipt.status, 'rolled_back_after_apply_failure');
  assert.equal(receipt.error, 'synthetic commit failure');
  assert.deepEqual(
    (await readdir(value.productionRoot)).filter((name) => name.startsWith('.receive-')),
    [],
  );
});

test('a mixed reprocess commit failure restores the exact original partial tree and retry ledger', async (t) => {
  const value = await fixture(t, { reprocessA: true, reprocessAPageRetry: true });
  await assert.rejects(
    receiveRemoteOcrOffload(
      { ...value.options, apply: true },
      {
        ...value.dependencies,
        beforeCommitDocument: async (documentId) => {
          if (documentId === 'doc-b') throw new Error('synthetic mixed commit failure');
        },
      },
    ),
    /synthetic mixed commit failure/,
  );
  assert.equal(
    await readFile(path.join(value.productionRoot, 'doc-a/pages/0001/content.md'), 'utf8'),
    'original local partial page 1\n',
  );
  assert.equal(
    await readFile(path.join(value.textRoot, 'doc-a.txt'), 'utf8'),
    'original local partial joined text\n',
  );
  assert.equal(
    JSON.parse(await readFile(path.join(value.supervisorRoot, 'page-retries.json'), 'utf8'))['doc-a:2:paddle'].attempts,
    5,
  );
  assert.equal(await pathExists(path.join(value.productionRoot, 'doc-b')), false);
  const receiptDirectories = (await readdir(value.receiptRoot)).filter((name) => !name.startsWith('.'));
  const receipt = JSON.parse(await readFile(
    path.join(value.receiptRoot, receiptDirectories[0], 'receipt.json'),
    'utf8',
  ));
  assert.equal(receipt.status, 'rolled_back_after_apply_failure');
});

test('receiver rejects malformed later inherited completion lifecycle records', async (t) => {
  const value = await fixture(t);
  await convertShardToHashBoundSeed(value.shardA, { transition: seedAwareTransition });
  await convertShardToHashBoundSeed(value.shardB, { transition: seedAwareTransition });

  const statusPath = path.join(value.shardA.shardRoot, 'status', 'doc-a.json');
  const status = JSON.parse(await readFile(statusPath, 'utf8'));
  status.attempt = 1;
  status.max_attempts = 5;
  status.verified_at = 'not-a-canonical-timestamp';
  status.unexpected_status_field = true;
  delete status.seed_lineage;
  const statusWritten = await writeJson(statusPath, status);
  await writeSidecar(statusPath, statusWritten.sha256);

  const runStatusPath = path.join(value.shardA.shardRoot, 'run-status.json');
  const runStatus = JSON.parse(await readFile(runStatusPath, 'utf8'));
  const progress = runStatus.documents['doc-a'];
  progress.status_json_sha256 = statusWritten.sha256;
  progress.verified_at = status.verified_at;
  progress.unexpected_progress_field = true;
  const runStatusWritten = await writeJson(runStatusPath, runStatus);
  await writeSidecar(runStatusPath, runStatusWritten.sha256);

  await assert.rejects(
    receiveRemoteOcrOffload(value.options, value.dependencies),
    /field set|canonical|timestamp/u,
  );
});

test('receiver preserves receipt state linkage and exact no-grant seed lineage after reverify', async (t) => {
  const assertRejectsStateMutation = async (testContext, writeMutation, expected) => {
    const value = await fixture(testContext);
    await convertShardToHashBoundSeed(value.shardA, { transition: seedAwareTransition });
    await convertShardToHashBoundSeed(value.shardB, { transition: seedAwareTransition });

    const statePath = path.join(value.shardA.shardRoot, 'documents', 'doc-a', 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const stateSha256 = await writeMutation(statePath, state);

    const statusPath = path.join(value.shardA.shardRoot, 'status', 'doc-a.json');
    const status = JSON.parse(await readFile(statusPath, 'utf8'));
    status.attempt = 1;
    status.max_attempts = 5;
    status.verified_at = '2026-07-16T00:31:00.000Z';
    status.artifacts.state_sha256 = stateSha256;
    delete status.seed_lineage;
    const statusWritten = await writeJson(statusPath, status);
    await writeSidecar(statusPath, statusWritten.sha256);

    const runStatusPath = path.join(value.shardA.shardRoot, 'run-status.json');
    const runStatus = JSON.parse(await readFile(runStatusPath, 'utf8'));
    runStatus.documents['doc-a'].verified_at = status.verified_at;
    runStatus.documents['doc-a'].status_json_sha256 = statusWritten.sha256;
    const runStatusWritten = await writeJson(runStatusPath, runStatus);
    await writeSidecar(runStatusPath, runStatusWritten.sha256);

    await assert.rejects(
      receiveRemoteOcrOffload(value.options, value.dependencies),
      expected,
    );
  };

  await t.test('receipt successor state SHA-256 remains binding', async (t) => {
    await assertRejectsStateMutation(t, async (statePath, state) => {
      const raw = `${JSON.stringify(state, null, 2)} \n`;
      await writeFile(statePath, raw);
      return sha256(raw);
    }, /successor_state|state.*receipt/u);
  });

  await t.test('no-grant state lineage retains an exact field set', async (t) => {
    await assertRejectsStateMutation(t, async (statePath, state) => {
      state.seed_lineage.unexpected_lineage_field = true;
      return (await writeJson(statePath, state)).sha256;
    }, /lineage.*field set/u);
  });
});

test('receiver rejects noncanonical legacy predecessor completion timestamps', async (t) => {
  const value = await fixture(t);
  const statusPath = path.join(value.shardA.shardRoot, 'status', 'doc-a.json');
  const status = JSON.parse(await readFile(statusPath, 'utf8'));
  status.verified_at = '2026-07-16T00:30:00Z';
  const statusWritten = await writeJson(statusPath, status);
  await writeSidecar(statusPath, statusWritten.sha256);
  const runStatusPath = path.join(value.shardA.shardRoot, 'run-status.json');
  const runStatus = JSON.parse(await readFile(runStatusPath, 'utf8'));
  runStatus.documents['doc-a'].verified_at = status.verified_at;
  runStatus.documents['doc-a'].status_json_sha256 = statusWritten.sha256;
  const runStatusWritten = await writeJson(runStatusPath, runStatus);
  await writeSidecar(runStatusPath, runStatusWritten.sha256);
  await convertShardToHashBoundSeed(value.shardA, { transition: seedAwareTransition });
  await convertShardToHashBoundSeed(value.shardB, { transition: seedAwareTransition });
  await assert.rejects(
    receiveRemoteOcrOffload(value.options, value.dependencies),
    /canonical|timestamp/u,
  );
});

test('receiver rejects a legacy successor verified before its predecessor', async (t) => {
  const value = await fixture(t);
  await convertShardToHashBoundSeed(value.shardA, { transition: seedAwareTransition });
  await convertShardToHashBoundSeed(value.shardB, { transition: seedAwareTransition });

  const statusPath = path.join(value.shardA.shardRoot, 'status', 'doc-a.json');
  const status = JSON.parse(await readFile(statusPath, 'utf8'));
  status.attempt = 1;
  status.max_attempts = 5;
  status.verified_at = '2026-07-16T00:29:00.000Z';
  delete status.seed_lineage;
  const statusWritten = await writeJson(statusPath, status);
  await writeSidecar(statusPath, statusWritten.sha256);

  const runStatusPath = path.join(value.shardA.shardRoot, 'run-status.json');
  const runStatus = JSON.parse(await readFile(runStatusPath, 'utf8'));
  runStatus.documents['doc-a'].verified_at = status.verified_at;
  runStatus.documents['doc-a'].status_json_sha256 = statusWritten.sha256;
  const runStatusWritten = await writeJson(runStatusPath, runStatus);
  await writeSidecar(runStatusPath, runStatusWritten.sha256);

  await assert.rejects(
    receiveRemoteOcrOffload(value.options, value.dependencies),
    /verified_at.*predecessor|predecessor.*verified_at|timestamp.*predecessor/u,
  );
});

test('receiver rejects completed_at before started_at', async (t) => {
  const value = await fixture(t);
  const completedAt = '2026-07-16T00:20:00.000Z';
  const startedAt = '2026-07-16T00:25:00.000Z';
  for (const [shard, documentId] of [
    [value.shardA, 'doc-a'],
    [value.shardB, 'doc-b'],
  ]) {
    const statusPath = path.join(shard.shardRoot, 'status', `${documentId}.json`);
    const status = JSON.parse(await readFile(statusPath, 'utf8'));
    status.attempt = 1;
    status.max_attempts = 5;
    status.completed_at = completedAt;
    delete status.verified_at;
    const statusWritten = await writeJson(statusPath, status);
    await writeSidecar(statusPath, statusWritten.sha256);
    const runStatusPath = path.join(shard.shardRoot, 'run-status.json');
    const runStatus = JSON.parse(await readFile(runStatusPath, 'utf8'));
    runStatus.documents[documentId].started_at = startedAt;
    runStatus.documents[documentId].completed_at = completedAt;
    delete runStatus.documents[documentId].verified_at;
    runStatus.documents[documentId].status_json_sha256 = statusWritten.sha256;
    const runStatusWritten = await writeJson(runStatusPath, runStatus);
    await writeSidecar(runStatusPath, runStatusWritten.sha256);
  }
  await assert.rejects(
    receiveRemoteOcrOffload(value.options, value.dependencies),
    /timestamp|chronological|before|after/u,
  );
});
