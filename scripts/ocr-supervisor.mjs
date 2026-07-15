#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, appendFile, copyFile, mkdir, open, readFile, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const root = path.resolve(new URL('../', import.meta.url).pathname);
const queue = JSON.parse(await readFile(path.join(root, 'data/ocr-queue.json'), 'utf8'));
const supervisorRoot = path.join(root, '.cache/ocr-supervisor');
const productionRoot = path.join(root, '.cache/ocr-production');
const witnessRoot = path.join(root, '.cache/ocr-witness');
const lockDir = path.join(supervisorRoot, 'lock');
const statusPath = path.join(supervisorRoot, 'status.json');
const currentRunPath = path.join(supervisorRoot, 'current-run.json');
const cursorPath = path.join(supervisorRoot, 'cursor.json');
const retriesPath = path.join(supervisorRoot, 'retries.json');
const historyPath = path.join(supervisorRoot, 'history.jsonl');
const llamaBinary = path.join(root, '.cache/tools/llama.cpp/build/bin/llama-server');
const llamaRepository = path.join(root, '.cache/tools/llama.cpp');
const modelPath = path.join(root, '.cache/ocr-runtime/PaddleOCR-VL-1.6-GGUF.gguf');
const mmprojPath = path.join(root, '.cache/ocr-runtime/PaddleOCR-VL-1.6-GGUF-mmproj.gguf');
const pythonPath = path.join(root, '.cache/venv-paddleocr/bin/python');
const expected = {
  llama_commit: '12127defda4f41b7679cb2477a4b0d65ee6a0c8f',
  model_sha256: 'f3ae46ec885050acf4b3d31944431e1fd90d50664fb09126af4a3c050ba14ee8',
  mmproj_sha256: '204d757d7610d9b3faab10d506d69e5b244e32bf765e2bab2d0167e65e0a058a',
};

const [command = 'status', ...rawArgs] = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = rawArgs.indexOf(name);
  return index >= 0 && rawArgs[index + 1] ? rawArgs[index + 1] : fallback;
};
const batchPages = Math.max(1, Math.min(16, Number(option('--batch-pages', '4')) || 4));
const requestedDocument = option('--document');
const retryFailed = rawArgs.includes('--retry-failed');
const nowIso = () => new Date().toISOString();
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function exists(value) {
  try { await access(value); return true; } catch { return false; }
}

async function readJson(value, fallback = null) {
  try { return JSON.parse(await readFile(value, 'utf8')); } catch { return fallback; }
}

async function validWitnessSidecar(value) {
  const record = await readJson(value, null);
  return Boolean(record && !record.error && Array.isArray(record.lines));
}

async function atomicJson(value, body) {
  await mkdir(path.dirname(value), { recursive: true });
  const temporary = `${value}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`);
  await rename(temporary, value);
}

async function sha256File(value) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(value);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function runCapture(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env: { ...process.env, ...(options.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${executable} exited ${code ?? signal}: ${stderr.slice(-1200)}`)));
  });
}

async function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function serverHealthy() {
  try {
    const response = await fetch('http://127.0.0.1:8112/health', { signal: AbortSignal.timeout(1600) });
    return response.ok;
  } catch { return false; }
}

async function portOpen() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: 8112 });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(1000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function pendingFor(document, state, limit, includeFailed = false) {
  const completed = new Set((state?.completed_pages || []).map(Number));
  const failed = new Set(Object.keys(state?.failed_pages || {}).map(Number));
  const first = Array.from({ length: document.page_count }, (_, index) => index + 1)
    .find((page) => !completed.has(page) && (includeFailed || !failed.has(page)));
  if (!first) return [];
  const selected = [];
  for (let page = first; page <= document.page_count && selected.length < limit; page += 1) {
    if (completed.has(page) || (!includeFailed && failed.has(page))) break;
    selected.push(page);
  }
  return selected;
}

async function nextBatch(limit = batchPages) {
  const cursor = await readJson(cursorPath, {});
  const retries = await readJson(retriesPath, {});
  for (const document of queue.documents) {
    if (requestedDocument && document.id !== requestedDocument) continue;
    const state = await readJson(path.join(productionRoot, document.id, 'state.json'), {});
    const visionDir = path.join(witnessRoot, document.id, 'vision');
    const missingWitness = [];
    for (const page of state.completed_pages || []) {
      const sidecar = path.join(visionDir, `page-${String(page).padStart(3, '0')}.json`);
      if (!(await validWitnessSidecar(sidecar))) missingWitness.push(page);
      if (missingWitness.length >= limit) break;
    }
    if (missingWitness.length) return { document, pages: missingWitness, state, mode: 'witness_backfill' };
  }
  const candidates = [];
  for (const document of queue.documents) {
    if (requestedDocument && document.id !== requestedDocument) continue;
    const retry = retries[document.id];
    if (retry?.quarantined) continue;
    if (retry?.next_retry_at && Date.parse(retry.next_retry_at) > Date.now()) continue;
    const state = await readJson(path.join(productionRoot, document.id, 'state.json'), {});
    const pages = pendingFor(document, state, limit, retryFailed);
    if (pages.length) candidates.push({ document, pages, state, mode: 'new_ocr' });
  }
  if (!candidates.length) return null;
  const minimumPriority = Math.min(...candidates.map((item) => item.document.priority));
  const pool = candidates.filter((item) => item.document.priority === minimumPriority).sort((a, b) => a.document.id.localeCompare(b.document.id));
  const lastIndex = pool.findIndex((item) => item.document.id === cursor.last_document_id);
  return pool[(lastIndex + 1 + pool.length) % pool.length];
}

async function collectAuditMetrics() {
  const pageGates = new Map();
  for (const document of queue.documents) {
    const locations = [path.join(productionRoot, document.id), path.join(witnessRoot, document.id, 'audits')];
    for (const location of locations) {
      if (!(await exists(location))) continue;
      for (const file of await readdir(location)) {
        if (!/^audit-\d+-\d+\.json$/.test(file)) continue;
        const report = await readJson(path.join(location, file), {});
        for (const page of report.pages || []) pageGates.set(`${document.id}:${page.page}`, page.gate);
      }
    }
  }
  const gates = { automatic_witness_pass: 0, manual_image_review_required: 0, blank_page_visual_confirmation_required: 0, unresolved_fail_closed: 0 };
  for (const gate of pageGates.values()) gates[gate] = (gates[gate] || 0) + 1;
  return { audited_pages: pageGates.size, gates };
}

async function collectReviewMetrics() {
  const files = (await readdir(path.join(root, 'data'))).filter((file) => /^ocr-review-.*\.json$/.test(file));
  let reviewed = 0;
  let citationEligible = 0;
  const decisions = {};
  for (const file of files) {
    const report = await readJson(path.join(root, 'data', file), {});
    for (const page of report.pages || []) {
      reviewed += 1;
      citationEligible += page.citation_allowed ? 1 : 0;
      decisions[page.decision] = (decisions[page.decision] || 0) + 1;
    }
  }
  return { reviewed_pages: reviewed, citation_eligible_pages: citationEligible, decisions };
}

async function collectStatus(write = true) {
  await mkdir(supervisorRoot, { recursive: true });
  let completed = 0;
  let failures = 0;
  let witnessPages = 0;
  let witnessErrors = 0;
  const documents = [];
  for (const document of queue.documents) {
    const state = await readJson(path.join(productionRoot, document.id, 'state.json'), {});
    const completedPages = (state.completed_pages || []).filter((page) => Number.isInteger(page));
    const validCompleted = [];
    for (const page of completedPages) {
      const pageRoot = path.join(productionRoot, document.id, 'pages', String(page).padStart(4, '0'));
      if (await exists(path.join(pageRoot, 'content.md')) && await exists(path.join(pageRoot, 'result.json'))) validCompleted.push(page);
    }
    const visionDir = path.join(witnessRoot, document.id, 'vision');
    const visionFiles = await exists(visionDir) ? (await readdir(visionDir)).filter((file) => /^page-\d+\.json$/.test(file)) : [];
    let validWitnesses = 0;
    for (const file of visionFiles) {
      if (await validWitnessSidecar(path.join(visionDir, file))) validWitnesses += 1;
      else witnessErrors += 1;
    }
    completed += validCompleted.length;
    witnessPages += validWitnesses;
    failures += Object.keys(state.failed_pages || {}).length;
    if (validCompleted.length || Object.keys(state.failed_pages || {}).length) {
      documents.push({ id: document.id, priority: document.priority, pages: document.page_count, completed: validCompleted.length, failed: Object.keys(state.failed_pages || {}).length, witness: validWitnesses, witness_errors: visionFiles.length - validWitnesses, updated_at: state.updated_at || null });
    }
  }
  const [audit, review, disk, graph, next, owner, current] = await Promise.all([
    collectAuditMetrics(), collectReviewMetrics(), statfs(root), readJson(path.join(root, 'public/data/concept-evolution.json'), {}), nextBatch(),
    readJson(path.join(lockDir, 'owner.json'), null), readJson(currentRunPath, null),
  ]);
  const freeGiB = Number(disk.bavail * disk.bsize) / 1024 ** 3;
  const heartbeatAge = current?.heartbeat_at ? (Date.now() - Date.parse(current.heartbeat_at)) / 60000 : null;
  const status = {
    schema_version: 1, generated_at: nowIso(),
    policy: { batch_pages: batchPages, disk_warning_gib: 50, disk_hard_stop_gib: 25, stall_minutes: 20, candidates_never_citation_eligible: true, automatic_deploy: false },
    queue: { documents: queue.counts.documents, pages: queue.counts.pages, completed_pages: completed, pending_pages: queue.counts.pages - completed, failed_pages: failures },
    evidence: { witness_pages: witnessPages, witness_error_sidecars: witnessErrors, witness_missing_for_completed: Math.max(0, completed - witnessPages), ...audit, ...review },
    runtime: { lock_active: Boolean(owner && await processAlive(owner.pid)), lock_owner: owner, current_run: current, stalled: Boolean(owner && heartbeatAge !== null && heartbeatAge > 20), server_healthy: await serverHealthy() },
    disk: { free_gib: Number(freeGiB.toFixed(2)), warning: freeGiB < 50, hard_stop: freeGiB < 25 },
    concept_graph: graph.coverage || null,
    next_batch: next ? { mode: next.mode, document_id: next.document.id, title: next.document.title, subject: next.document.subject, priority: next.document.priority, pages: next.pages } : null,
    documents,
  };
  if (write) await atomicJson(statusPath, status);
  return status;
}

async function acquireLock(runId) {
  await mkdir(supervisorRoot, { recursive: true });
  try {
    await mkdir(lockDir);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await readJson(path.join(lockDir, 'owner.json'), {});
    if (await processAlive(owner.pid)) throw Object.assign(new Error(`OCR supervisor is already active under PID ${owner.pid}`), { exitCode: 75 });
    const stale = path.join(supervisorRoot, `lock-stale-${Date.now()}`);
    await rename(lockDir, stale);
    await mkdir(lockDir);
  }
  await atomicJson(path.join(lockDir, 'owner.json'), { pid: process.pid, run_id: runId, started_at: nowIso(), argv: process.argv.slice(2) });
}

async function updateRun(run) {
  run.heartbeat_at = nowIso();
  await atomicJson(currentRunPath, run);
}

async function startLlama(logPath) {
  if (await serverHealthy()) return { child: null, reused: true };
  if (await portOpen()) throw new Error('Port 8112 is occupied by an unknown non-healthy process; refusing to interfere.');
  const log = await open(logPath, 'a');
  const child = spawn(llamaBinary, [
    '-m', modelPath, '--mmproj', mmprojPath, '--host', '127.0.0.1', '--port', '8112', '--temp', '0',
    '--ctx-size', '8192', '--n-gpu-layers', 'all', '--parallel', '1', '--timeout', '3600', '--no-webui', '--metrics',
  ], { cwd: root, stdio: ['ignore', log.fd, log.fd] });
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 120000;
    const poll = async () => {
      if (await serverHealthy()) return resolve();
      if (child.exitCode !== null) return reject(new Error(`llama-server exited before healthy: ${child.exitCode}`));
      if (Date.now() > deadline) return reject(new Error('llama-server did not become healthy within 120 seconds'));
      setTimeout(poll, 1000);
    };
    poll();
  });
  return { child, reused: false, log };
}

async function stopOwnedServer(server) {
  if (!server?.child || server.child.exitCode !== null) { await server?.log?.close().catch(() => {}); return; }
  server.child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.child.once('exit', resolve)),
    sleep(10000).then(() => { if (server.child.exitCode === null) server.child.kill('SIGKILL'); }),
  ]);
  await server.log?.close().catch(() => {});
}

async function runLogged(executable, args, logPath, run, stage, env = {}) {
  run.stage = stage;
  await updateRun(run);
  const log = await open(logPath, 'a');
  const child = spawn(executable, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', log.fd, log.fd] });
  const heartbeat = setInterval(() => updateRun(run).catch(() => {}), 30000);
  const result = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${stage} exited ${code ?? signal}`)));
  }).finally(async () => { clearInterval(heartbeat); await log.close().catch(() => {}); });
  await updateRun(run);
  return result;
}

async function renderVision(document, pages, pdfSha, logPath, run) {
  const base = path.join(witnessRoot, document.id);
  const imageDir = path.join(base, 'images');
  const visionDir = path.join(base, 'vision');
  await Promise.all([mkdir(imageDir, { recursive: true }), mkdir(visionDir, { recursive: true })]);
  const images = [];
  run.stage = 'render_and_independent_vision';
  await updateRun(run);
  for (const page of pages) {
    const stem = `page-${String(page).padStart(3, '0')}`;
    const prefix = path.join(imageDir, stem);
    const imagePath = `${prefix}.png`;
    await runCapture('/opt/homebrew/bin/pdftoppm', ['-f', String(page), '-l', String(page), '-r', '300', '-png', '-singlefile', path.join(root, document.local_cache_path), prefix]);
    images.push(imagePath);
  }
  await runLogged('/usr/bin/swift', [path.join(root, 'scripts/vision-ocr-batch.swift'), '--output-dir', visionDir, ...images], logPath, run, 'independent_apple_vision');
  for (let index = 0; index < images.length; index += 1) {
    const page = pages[index];
    const image = images[index];
    const sidecarPath = path.join(visionDir, `page-${String(page).padStart(3, '0')}.json`);
    const record = await readJson(sidecarPath, null);
    if (!record || record.error) throw new Error(`Apple Vision witness failed for ${document.id} page ${page}: ${record?.error || 'missing sidecar'}`);
    await atomicJson(sidecarPath, {
      ...record, schema_version: 1, document_id: document.id, physical_pdf_page: page, source_pdf_sha256: pdfSha,
      rendered_image_sha256: await sha256File(image), engine: 'Apple Vision VNRecognizeTextRequest accurate zh-Hans+en-US',
      engine_configuration: { recognition_level: 'accurate', languages: ['zh-Hans', 'en-US'], language_correction: true, minimum_text_height: 0.008 },
      critical_fields: [], citation_allowed: false,
    });
  }
  return { imageDir, visionDir };
}

async function preflight(document) {
  const disk = await statfs(root);
  const freeGiB = Number(disk.bavail * disk.bsize) / 1024 ** 3;
  if (freeGiB < 25) throw Object.assign(new Error(`Disk hard stop: ${freeGiB.toFixed(2)} GiB free`), { permanent: false });
  const required = [llamaBinary, modelPath, mmprojPath, pythonPath, path.join(root, document.local_cache_path)];
  for (const value of required) if (!(await exists(value))) throw Object.assign(new Error(`Missing runtime/source file: ${value}`), { permanent: true });
  const [modelSha, mmprojSha, pdfSha, commit] = await Promise.all([
    sha256File(modelPath), sha256File(mmprojPath), sha256File(path.join(root, document.local_cache_path)),
    runCapture('git', ['-C', llamaRepository, 'rev-parse', 'HEAD']).then((result) => result.stdout.trim()),
  ]);
  if (modelSha !== expected.model_sha256) throw Object.assign(new Error('PaddleOCR-VL model checksum mismatch'), { permanent: true });
  if (mmprojSha !== expected.mmproj_sha256) throw Object.assign(new Error('PaddleOCR-VL mmproj checksum mismatch'), { permanent: true });
  if (commit !== expected.llama_commit) throw Object.assign(new Error(`llama.cpp revision mismatch: ${commit}`), { permanent: true });
  if (pdfSha !== document.source_sha256) throw Object.assign(new Error(`Source PDF checksum mismatch for ${document.id}`), { permanent: true });
  return { free_gib: freeGiB, model_sha256: modelSha, mmproj_sha256: mmprojSha, source_pdf_sha256: pdfSha, llama_commit: commit };
}

async function recordFailure(documentId, error) {
  const retries = await readJson(retriesPath, {});
  const previous = retries[documentId] || { attempts: 0 };
  const attempts = previous.attempts + 1;
  const delays = [1, 6, 24];
  retries[documentId] = {
    attempts, last_error: `${error.name}: ${error.message}`.slice(0, 600), last_failed_at: nowIso(),
    quarantined: Boolean(error.permanent || attempts >= 3),
    next_retry_at: error.permanent || attempts >= 3 ? null : new Date(Date.now() + delays[attempts - 1] * 3600000).toISOString(),
  };
  await atomicJson(retriesPath, retries);
}

async function clearFailure(documentId) {
  const retries = await readJson(retriesPath, {});
  if (retries[documentId]) { delete retries[documentId]; await atomicJson(retriesPath, retries); }
}

async function once() {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  await acquireLock(runId);
  const selected = await nextBatch();
  if (!selected) {
    await collectStatus();
    await rm(lockDir, { recursive: true, force: true });
    console.log(JSON.stringify({ status: 'queue_complete_or_backoff_active' }));
    return;
  }
  const { document, pages, mode } = selected;
  const logDir = path.join(supervisorRoot, 'logs', runId);
  await mkdir(logDir, { recursive: true });
  const run = { schema_version: 1, run_id: runId, pid: process.pid, mode, document_id: document.id, pages, started_at: nowIso(), heartbeat_at: nowIso(), stage: 'preflight', status: 'running', owned_llama_pid: null };
  let server = null;
  let interrupted = false;
  const stop = () => { interrupted = true; if (server?.child && server.child.exitCode === null) server.child.kill('SIGTERM'); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await updateRun(run);
    const checks = await preflight(document);
    run.preflight = checks;
    const witness = await renderVision(document, pages, checks.source_pdf_sha256, path.join(logDir, 'vision.log'), run);
    if (mode === 'new_ocr') {
      run.stage = 'start_llama';
      await updateRun(run);
      server = await startLlama(path.join(logDir, 'llama.log'));
      run.owned_llama_pid = server.child?.pid || null;
      run.reused_llama_server = server.reused;
      await updateRun(run);
      await runLogged(pythonPath, [
        path.join(root, 'scripts/ocr-pdf-paddle.py'), document.id, path.join(root, document.local_cache_path), productionRoot,
        '--pages', `${pages[0]}-${pages.at(-1)}`, '--save-visuals',
      ], path.join(logDir, 'paddle.log'), run, 'paddle_ocr', {
        PADDLE_PDX_CACHE_HOME: path.join(root, '.cache/paddlex'), PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True',
      });
    }
    const auditDir = path.join(witnessRoot, document.id, 'audits');
    await mkdir(auditDir, { recursive: true });
    const ranges = [];
    for (const page of [...pages].sort((a, b) => a - b)) {
      const last = ranges.at(-1);
      if (last && last[1] + 1 === page) last[1] = page;
      else ranges.push([page, page]);
    }
    for (const [start, end] of ranges) {
      const auditName = `audit-${String(start).padStart(4, '0')}-${String(end).padStart(4, '0')}.json`;
      const auditPath = path.join(auditDir, auditName);
      await runLogged('node', [path.join(root, 'scripts/audit-ocr-witnesses.mjs'), path.join(productionRoot, document.id, 'pages'), witness.visionDir, auditPath, String(start), String(end)], path.join(logDir, 'audit.log'), run, 'witness_audit');
      await copyFile(auditPath, path.join(productionRoot, document.id, auditName));
    }
    await runLogged('node', [path.join(root, 'scripts/build-concept-evolution.mjs')], path.join(logDir, 'concept-build.log'), run, 'concept_graph_build');
    await runLogged('node', [path.join(root, 'scripts/validate-concept-evolution.mjs')], path.join(logDir, 'concept-validate.log'), run, 'concept_graph_validate');
    if (mode === 'new_ocr') await atomicJson(cursorPath, { last_document_id: document.id, completed_at: nowIso(), pages });
    await clearFailure(document.id);
    run.status = 'completed';
    run.completed_at = nowIso();
    run.stage = 'complete';
    await updateRun(run);
    await appendFile(historyPath, `${JSON.stringify({ ...run, preflight: { ...run.preflight, source_pdf_sha256: run.preflight.source_pdf_sha256 } })}\n`);
  } catch (error) {
    run.status = interrupted ? 'interrupted' : 'failed';
    run.failed_at = nowIso();
    run.error = `${error.name}: ${error.message}`.slice(0, 1000);
    await updateRun(run).catch(() => {});
    await recordFailure(document.id, error).catch(() => {});
    await appendFile(historyPath, `${JSON.stringify(run)}\n`).catch(() => {});
    throw error;
  } finally {
    await stopOwnedServer(server);
    await rm(lockDir, { recursive: true, force: true });
    await collectStatus().catch(() => {});
  }
  console.log(JSON.stringify({ status: 'completed', run_id: runId, mode, document_id: document.id, pages }));
}

await mkdir(supervisorRoot, { recursive: true });
if (command === 'status') {
  console.log(JSON.stringify(await collectStatus(), null, 2));
} else if (command === 'once') {
  await once();
} else {
  console.error('usage: node scripts/ocr-supervisor.mjs <status|once> [--batch-pages 4] [--document ID] [--retry-failed]');
  process.exit(64);
}
