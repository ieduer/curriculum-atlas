#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureLocalReprocessSnapshot,
  LOCAL_REPROCESS_SNAPSHOT_MODE,
} from './lib/remote-ocr-local-snapshot.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = path.resolve(path.dirname(scriptPath), '..');
const sha256Pattern = /^[a-f0-9]{64}$/;
const documentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const PINNED_REMOTE_OCR_RUNTIME = Object.freeze({
  pipeline: 'PaddleOCR-VL',
  pipeline_version: 'v1.6',
  model_sha256: 'f3ae46ec885050acf4b3d31944431e1fd90d50664fb09126af4a3c050ba14ee8',
  mmproj_sha256: '204d757d7610d9b3faab10d506d69e5b244e32bf765e2bab2d0167e65e0a058a',
  llama_commit: '12127defda4f41b7679cb2477a4b0d65ee6a0c8f',
  render_dpi: 240,
});

function parseArguments(argv) {
  const parsed = {
    limitDocuments: null,
    output: null,
    reprocessDocuments: [],
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      parsed.help = true;
      continue;
    }
    if (!['--limit-documents', '--output', '--reprocess-document'].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    if (argument === '--limit-documents') {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 1) {
        throw new Error('--limit-documents must be a positive integer');
      }
      parsed.limitDocuments = number;
    } else if (argument === '--output') {
      parsed.output = value;
    } else {
      if (!documentIdPattern.test(value) || value === '.' || value === '..') {
        throw new Error(`unsafe --reprocess-document id: ${value}`);
      }
      parsed.reprocessDocuments.push(value);
    }
    index += 1;
  }
  if (parsed.reprocessDocuments.length > 0 && parsed.limitDocuments !== null) {
    throw new Error('--limit-documents cannot be combined with explicit --reprocess-document selection');
  }
  return parsed;
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveWithNearestExistingParent(filePath) {
  let cursor = path.resolve(filePath);
  const missingSegments = [];
  for (;;) {
    try {
      const resolved = await realpath(cursor);
      return path.resolve(resolved, ...missingSegments.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      let unresolvedEntryExists = false;
      try {
        await lstat(cursor);
        unresolvedEntryExists = true;
      } catch (entryError) {
        if (entryError?.code !== 'ENOENT' && entryError?.code !== 'ENOTDIR') throw entryError;
      }
      if (unresolvedEntryExists) {
        throw new Error(`${cursor} exists but cannot be resolved (dangling or invalid symlink)`);
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function resolveProjectPath(projectRoot, filePath, label, { mustExist = false, within = projectRoot } = {}) {
  const resolved = mustExist ? await realpath(filePath) : await resolveWithNearestExistingParent(filePath);
  if (!isWithin(projectRoot, resolved)) throw new Error(`${label} escapes the project root through a symlink`);
  if (!isWithin(within, resolved)) throw new Error(`${label} escapes its expected cache root through a symlink`);
  return resolved;
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function sourcePathWithinProject(projectRoot, sourceRoot, relativePath, documentId) {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`${documentId}: local_cache_path must be project-relative`);
  }
  const absolutePath = path.resolve(projectRoot, relativePath);
  if (!isWithin(projectRoot, absolutePath)) {
    throw new Error(`${documentId}: local_cache_path escapes the project root`);
  }
  if (!isWithin(sourceRoot, absolutePath)) {
    throw new Error(`${documentId}: local_cache_path must be inside .cache/sources`);
  }
  return absolutePath;
}

function validateQueueDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('ocr-queue documents must be JSON objects');
  }
  if (
    typeof document.id !== 'string'
    || document.id.length === 0
    || !documentIdPattern.test(document.id)
    || document.id === '.'
    || document.id === '..'
  ) {
    throw new Error(`unsafe queue document id: ${document.id}`);
  }
  if (!Number.isSafeInteger(document.page_count) || document.page_count < 1) {
    throw new Error(`${document.id}: page_count must be a positive integer`);
  }
  if (!sha256Pattern.test(String(document.source_sha256 || ''))) {
    throw new Error(`${document.id}: source_sha256 must be lowercase SHA-256`);
  }
}

function stateReasons(state, document, statePresent) {
  if (!statePresent) return [];
  const reasons = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) return ['STATE_SCHEMA_INVALID'];
  if (state.schema_version !== 1) reasons.push('STATE_SCHEMA_VERSION_INVALID');
  if (!Array.isArray(state.completed_pages)) reasons.push('STATE_COMPLETED_PAGES_INVALID');
  else if (state.completed_pages.length > 0) reasons.push('LOCAL_COMPLETED_PAGES_NONZERO');
  if (!state.failed_pages || typeof state.failed_pages !== 'object' || Array.isArray(state.failed_pages)) {
    reasons.push('STATE_FAILED_PAGES_INVALID');
  } else if (Object.keys(state.failed_pages).length > 0) {
    reasons.push('LOCAL_FAILED_PAGES_NONZERO');
  }
  if (!state.pages || typeof state.pages !== 'object' || Array.isArray(state.pages)) {
    reasons.push('STATE_PAGES_INVALID');
  } else if (Object.keys(state.pages).length > 0) {
    reasons.push('LOCAL_PAGE_STATE_NONEMPTY');
  }
  if (state.document_id !== document.id) reasons.push('STATE_DOCUMENT_ID_MISMATCH');
  if (state.source_sha256 !== document.source_sha256) reasons.push('STATE_SOURCE_SHA256_MISMATCH');
  if (!Number.isSafeInteger(state.page_count) || state.page_count !== document.page_count) {
    reasons.push('STATE_PAGE_COUNT_MISMATCH');
  }
  return reasons;
}

function retryReasons(documentId, documentRetries, pageRetries) {
  const reasons = [];
  if (Object.hasOwn(documentRetries, documentId)) reasons.push('DOCUMENT_RETRY_CONFLICT');
  if (Object.keys(pageRetries).some((key) => key.startsWith(`${documentId}:`))) {
    reasons.push('PAGE_RETRY_CONFLICT');
  }
  return reasons;
}

function incrementReasonCounts(counts, reasons) {
  for (const reason of reasons) counts[reason] = Number(counts[reason] || 0) + 1;
}

export async function buildRemoteOcrOffloadManifest({
  projectRoot = defaultProjectRoot,
  limitDocuments = null,
  reprocessDocuments = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const lexicalRoot = path.resolve(projectRoot);
  const absoluteRoot = await realpath(lexicalRoot);
  const rootStats = await stat(absoluteRoot);
  if (!rootStats.isDirectory()) throw new Error('projectRoot must be a directory');
  if (limitDocuments !== null && (!Number.isSafeInteger(limitDocuments) || limitDocuments < 1)) {
    throw new Error('limitDocuments must be null or a positive integer');
  }
  if (!Array.isArray(reprocessDocuments)) throw new Error('reprocessDocuments must be an array');
  if (reprocessDocuments.length > 0 && limitDocuments !== null) {
    throw new Error('limitDocuments cannot be combined with explicit reprocessDocuments');
  }
  const reprocessDocumentSet = new Set();
  for (const documentId of reprocessDocuments) {
    if (typeof documentId !== 'string'
      || !documentIdPattern.test(documentId)
      || documentId === '.'
      || documentId === '..') {
      throw new Error(`unsafe reprocess document id: ${documentId}`);
    }
    if (reprocessDocumentSet.has(documentId)) {
      throw new Error(`duplicate reprocess document id: ${documentId}`);
    }
    reprocessDocumentSet.add(documentId);
  }
  const reprocessMode = reprocessDocumentSet.size > 0;

  const queueLexicalPath = path.join(absoluteRoot, 'data/ocr-queue.json');
  const dataRoot = path.join(absoluteRoot, 'data');
  const productionRoot = path.join(absoluteRoot, '.cache/ocr-production');
  const supervisorRoot = path.join(absoluteRoot, '.cache/ocr-supervisor');
  const sourceRoot = path.join(absoluteRoot, '.cache/sources');
  const witnessRoot = path.join(absoluteRoot, '.cache/ocr-witness');
  const textRoot = path.join(absoluteRoot, '.cache/text');
  const [queuePath, resolvedDataRoot, resolvedProductionRoot, resolvedSupervisorRoot, resolvedSourceRoot, resolvedWitnessRoot, resolvedTextRoot] = await Promise.all([
    resolveProjectPath(absoluteRoot, queueLexicalPath, 'data/ocr-queue.json', { mustExist: true }),
    resolveProjectPath(absoluteRoot, dataRoot, 'data', { mustExist: true }),
    resolveProjectPath(absoluteRoot, productionRoot, '.cache/ocr-production'),
    resolveProjectPath(absoluteRoot, supervisorRoot, '.cache/ocr-supervisor'),
    resolveProjectPath(absoluteRoot, sourceRoot, '.cache/sources'),
    resolveProjectPath(absoluteRoot, witnessRoot, '.cache/ocr-witness'),
    resolveProjectPath(absoluteRoot, textRoot, '.cache/text'),
  ]);
  if ([resolvedProductionRoot, resolvedSupervisorRoot, resolvedWitnessRoot, resolvedTextRoot].some((protectedRoot) => (
    isWithin(protectedRoot, resolvedSourceRoot) || isWithin(resolvedSourceRoot, protectedRoot)
  ))) {
    throw new Error('.cache/sources aliases protected OCR state');
  }
  const localStateRoots = [
    ['.cache/ocr-production', resolvedProductionRoot],
    ['.cache/ocr-supervisor', resolvedSupervisorRoot],
    ['.cache/ocr-witness', resolvedWitnessRoot],
    ['.cache/text', resolvedTextRoot],
  ];
  for (let leftIndex = 0; leftIndex < localStateRoots.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < localStateRoots.length; rightIndex += 1) {
      const [leftLabel, leftRoot] = localStateRoots[leftIndex];
      const [rightLabel, rightRoot] = localStateRoots[rightIndex];
      if (isWithin(leftRoot, rightRoot) || isWithin(rightRoot, leftRoot)) {
        throw new Error(`${leftLabel} aliases ${rightLabel}`);
      }
    }
  }
  if (!isWithin(resolvedDataRoot, queuePath)) {
    throw new Error('data/ocr-queue.json escapes its expected data root through a symlink');
  }
  if ([resolvedProductionRoot, resolvedSupervisorRoot, resolvedWitnessRoot].some((root) => isWithin(root, queuePath))) {
    throw new Error('data/ocr-queue.json aliases protected OCR state');
  }
  const queueStats = await stat(queuePath);
  if (!queueStats.isFile()) throw new Error('data/ocr-queue.json must be a regular file');

  async function readSupervisorJson(fileName) {
    const lexicalPath = path.join(supervisorRoot, fileName);
    const resolvedPath = await resolveProjectPath(absoluteRoot, lexicalPath, `.cache/ocr-supervisor/${fileName}`, {
      within: resolvedSupervisorRoot,
    });
    if (!(await pathExists(lexicalPath))) return {};
    return JSON.parse(await readFile(resolvedPath, 'utf8'));
  }

  const [queue, documentRetries, pageRetries] = await Promise.all([
    readFile(queuePath, 'utf8').then(JSON.parse),
    readSupervisorJson('retries.json'),
    readSupervisorJson('page-retries.json'),
  ]);
  requirePlainObject(queue, 'data/ocr-queue.json');
  requirePlainObject(documentRetries, '.cache/ocr-supervisor/retries.json');
  requirePlainObject(pageRetries, '.cache/ocr-supervisor/page-retries.json');
  if (!Array.isArray(queue.documents)) throw new Error('data/ocr-queue.json documents must be an array');
  if (reprocessMode) {
    for (const lockName of ['lock', 'drain-lock']) {
      if (await pathExists(path.join(supervisorRoot, lockName))) {
        throw new Error(`local OCR ${lockName} is active; explicit reprocess snapshots require a held local owner`);
      }
    }
    const watchdogControl = await readSupervisorJson('watchdog-control.json');
    const watchdogMode = Object.keys(watchdogControl).length ? watchdogControl.mode : 'absent';
    if (!['absent', 'hold'].includes(watchdogMode)) {
      throw new Error(`local OCR watchdog must be held before explicit reprocess planning; current mode=${watchdogMode}`);
    }
  }

  const identifiers = new Set();
  const eligible = [];
  const excluded = [];
  const exclusionReasonCounts = {};
  const foundReprocessDocumentIds = new Set();

  for (const document of queue.documents) {
    validateQueueDocument(document);
    if (identifiers.has(document.id)) throw new Error(`duplicate queue document id: ${document.id}`);
    identifiers.add(document.id);
    const explicitlySelectedForReprocess = reprocessDocumentSet.has(document.id);
    if (reprocessMode && !explicitlySelectedForReprocess) {
      const reasons = ['NOT_EXPLICITLY_SELECTED_FOR_REPROCESS'];
      excluded.push({ id: document.id, reasons });
      incrementReasonCounts(exclusionReasonCounts, reasons);
      continue;
    }
    if (explicitlySelectedForReprocess) foundReprocessDocumentIds.add(document.id);

    const documentRoot = path.join(productionRoot, document.id);
    const resolvedDocumentRoot = await resolveProjectPath(absoluteRoot, documentRoot, `${document.id}: OCR production root`, {
      within: resolvedProductionRoot,
    });
    const statePath = path.join(documentRoot, 'state.json');
    const resolvedStatePath = await resolveProjectPath(absoluteRoot, statePath, `${document.id}: state.json`, {
      within: resolvedDocumentRoot,
    });
    const statePresent = await pathExists(statePath);
    let state = null;
    let stateReadReasons = [];
    if (statePresent) {
      try {
        state = JSON.parse(await readFile(resolvedStatePath, 'utf8'));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        stateReadReasons = ['STATE_JSON_INVALID'];
      }
    }
    const localStateReasons = stateReadReasons.length > 0
      ? stateReadReasons
      : stateReasons(state, document, statePresent);
    if (!reprocessMode) {
      const reasons = [
        ...localStateReasons,
        ...retryReasons(document.id, documentRetries, pageRetries),
      ];
      if (await pathExists(documentRoot)) {
        const entries = (await readdir(resolvedDocumentRoot)).filter((entry) => entry !== 'state.json' && entry !== '.DS_Store');
        if (entries.length > 0 && localStateReasons.length === 0) {
          reasons.push('LOCAL_PRODUCTION_ARTIFACT_CONFLICT');
        }
      }
      const uniqueReasons = [...new Set(reasons)];
      if (uniqueReasons.length > 0) {
        excluded.push({ id: document.id, reasons: uniqueReasons });
        incrementReasonCounts(exclusionReasonCounts, uniqueReasons);
        continue;
      }
    } else if (stateReadReasons.length > 0) {
      throw new Error(`${document.id}: explicit reprocess state cannot be snapshotted: ${stateReadReasons.join(',')}`);
    }

    const sourceLexicalPath = sourcePathWithinProject(absoluteRoot, sourceRoot, document.local_cache_path, document.id);
    const sourcePath = await resolveProjectPath(absoluteRoot, sourceLexicalPath, `${document.id}: source PDF`, {
      mustExist: true,
      within: resolvedSourceRoot,
    }).catch((error) => {
      throw new Error(`${document.id}: source PDF unavailable at ${document.local_cache_path}: ${error.message}`);
    });
    if (
      sourcePath === queuePath
      || [resolvedProductionRoot, resolvedSupervisorRoot, resolvedWitnessRoot].some((root) => isWithin(root, sourcePath))
    ) {
      throw new Error(`${document.id}: source PDF aliases protected OCR state or data/ocr-queue.json`);
    }
    const sourceStats = await stat(sourcePath).catch((error) => {
      throw new Error(`${document.id}: source PDF unavailable at ${document.local_cache_path}: ${error.message}`);
    });
    if (!sourceStats.isFile()) throw new Error(`${document.id}: source path is not a regular file`);
    const actualSourceSha256 = await sha256(sourcePath);
    if (actualSourceSha256 !== document.source_sha256) {
      throw new Error(`${document.id}: source SHA-256 differs from data/ocr-queue.json`);
    }

    let planningSnapshot = {
      state_file_present: statePresent,
      local_completed_pages: 0,
      local_failed_pages: 0,
      local_retry_conflicts: 0,
      local_production_artifact_conflicts: 0,
    };
    if (reprocessMode) {
      const textPath = path.join(textRoot, `${document.id}.txt`);
      const resolvedTextPath = await resolveProjectPath(
        absoluteRoot,
        textPath,
        `${document.id}: local joined text`,
        { within: resolvedTextRoot },
      );
      planningSnapshot = await captureLocalReprocessSnapshot({
        document,
        documentRoot: resolvedDocumentRoot,
        textPath: resolvedTextPath,
        documentRetries,
        pageRetries,
      });
    }

    eligible.push({
      id: document.id,
      title: document.title,
      subject: document.subject,
      priority: document.priority,
      source_path: document.local_cache_path,
      source_sha256: actualSourceSha256,
      source_bytes: sourceStats.size,
      page_count: document.page_count,
      required_page_range: { first: 1, last: document.page_count, count: document.page_count },
      planning_snapshot: planningSnapshot,
      citation_allowed: false,
    });
  }

  if (reprocessMode) {
    const missing = [...reprocessDocumentSet].filter((documentId) => !foundReprocessDocumentIds.has(documentId));
    if (missing.length > 0) throw new Error(`reprocess documents are absent from the OCR queue: ${missing.join(', ')}`);
    const [currentDocumentRetries, currentPageRetries] = await Promise.all([
      readSupervisorJson('retries.json'),
      readSupervisorJson('page-retries.json'),
    ]);
    if (JSON.stringify(currentDocumentRetries) !== JSON.stringify(documentRetries)
      || JSON.stringify(currentPageRetries) !== JSON.stringify(pageRetries)) {
      throw new Error('local OCR retry ledger changed while explicit reprocess snapshots were captured');
    }
  }

  const selected = limitDocuments === null ? eligible : eligible.slice(0, limitDocuments);
  const total = (documents, key) => documents.reduce((sum, document) => sum + Number(document[key] || 0), 0);

  return {
    schema_version: 1,
    manifest_type: 'curriculum_remote_whole_document_ocr_offload_plan',
    generated_at: generatedAt,
    planning_mode: reprocessMode
      ? 'explicit_existing_local_document_reprocess_read_only'
      : 'local_read_only_except_explicit_manifest_output',
    quality_policy: {
      stage: 'remote_primary_ocr_staging_only',
      whole_document_atomic: true,
      citation_allowed: false,
      remote_results_require_local_witness_and_exact_audit_before_publication: true,
    },
    runtime: { ...PINNED_REMOTE_OCR_RUNTIME },
    import_hard_gates: {
      decision: 'reject_entire_document_if_any_gate_fails',
      local_revalidation_after_planning: {
        ...(reprocessMode
          ? {
              mode_must_equal: LOCAL_REPROCESS_SNAPSHOT_MODE,
              exact_snapshot_sha256_must_match: true,
              original_document_tree_requires_atomic_backup: true,
              original_document_tree_must_not_be_deleted: true,
            }
          : {
              completed_pages_must_equal: 0,
              failed_pages_must_equal: 0,
              retry_conflicts_must_equal: 0,
              production_artifact_conflicts_must_equal: 0,
            }),
        source_sha256_must_equal_planned_value: true,
        page_count_must_equal_planned_value: true,
      },
      remote_document_revalidation: {
        page_number_set_must_equal: 'every integer from 1 through page_count exactly once',
        citation_allowed_must_equal: false,
        every_page_requires_valid_lowercase_sha256: [
          'result_json_sha256',
          'content_markdown_sha256',
          'rendered_image_sha256',
        ],
      },
    },
    counts: {
      queue_documents: queue.documents.length,
      eligible_documents: eligible.length,
      eligible_pages: total(eligible, 'page_count'),
      eligible_source_bytes: total(eligible, 'source_bytes'),
      selected_documents: selected.length,
      selected_pages: total(selected, 'page_count'),
      selected_source_bytes: total(selected, 'source_bytes'),
      explicitly_reprocessed_documents: reprocessMode ? selected.length : 0,
      explicitly_reprocessed_local_completed_pages: reprocessMode
        ? selected.reduce((sum, document) => sum + document.planning_snapshot.completion.completed_pages.length, 0)
        : 0,
      excluded_documents: excluded.length,
      exclusion_reason_counts: exclusionReasonCounts,
    },
    documents: selected,
    excluded_documents: excluded,
  };
}

function protectedOutputRoots(projectRoot) {
  return [
    path.join(projectRoot, '.cache/ocr-production'),
    path.join(projectRoot, '.cache/ocr-supervisor'),
    path.join(projectRoot, '.cache/ocr-witness'),
  ];
}

export async function writeRemoteOcrOffloadManifest(outputPath, manifest, { projectRoot = defaultProjectRoot } = {}) {
  const lexicalRoot = path.resolve(projectRoot);
  const absoluteRoot = await realpath(lexicalRoot);
  const absoluteOutput = path.resolve(outputPath);
  if (!isWithin(lexicalRoot, absoluteOutput)) {
    throw new Error('Refusing to write a planning manifest outside the project root');
  }
  const lexicalProtectedRoots = protectedOutputRoots(lexicalRoot);
  if (lexicalProtectedRoots.some((root) => isWithin(root, absoluteOutput))) {
    throw new Error('Refusing to write a planning manifest inside OCR production, supervisor, or witness state');
  }
  const queueLexicalPath = path.join(lexicalRoot, 'data/ocr-queue.json');
  if (absoluteOutput === queueLexicalPath) throw new Error('Refusing to overwrite data/ocr-queue.json');
  const [resolvedOutput, queuePath, ...resolvedProtectedRoots] = await Promise.all([
    resolveProjectPath(absoluteRoot, absoluteOutput, 'manifest output'),
    resolveProjectPath(absoluteRoot, queueLexicalPath, 'data/ocr-queue.json', { mustExist: true }),
    ...lexicalProtectedRoots.map((root) => resolveProjectPath(absoluteRoot, root, path.relative(lexicalRoot, root))),
  ]);
  if (resolvedOutput === queuePath) throw new Error('Refusing to overwrite data/ocr-queue.json through an alias');
  if (resolvedProtectedRoots.some((root) => isWithin(root, resolvedOutput))) {
    throw new Error('Refusing to write a planning manifest through an alias into protected OCR state');
  }
  await mkdir(path.dirname(absoluteOutput), { recursive: true });
  const resolvedParent = await resolveProjectPath(absoluteRoot, path.dirname(absoluteOutput), 'manifest output parent', {
    mustExist: true,
  });
  const revalidatedOutput = await resolveProjectPath(absoluteRoot, absoluteOutput, 'manifest output');
  if (revalidatedOutput !== path.join(resolvedParent, path.basename(absoluteOutput))) {
    throw new Error('Refusing to write a planning manifest through an output-file symlink');
  }
  if (revalidatedOutput === queuePath || resolvedProtectedRoots.some((root) => isWithin(root, revalidatedOutput))) {
    throw new Error('Refusing to write a planning manifest through an alias into protected OCR state or data/ocr-queue.json');
  }
  const temporary = `${absoluteOutput}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, absoluteOutput);
  return absoluteOutput;
}

function usage() {
  return [
    'Usage: node scripts/plan-remote-ocr-offload.mjs [options]',
    '',
    'Options:',
    '  --limit-documents <N>  Select only the first N eligible whole documents.',
    '  --reprocess-document <ID>  Explicitly select one existing local OCR document for a full remote rerun.',
    '                             Repeat for each document; cannot be combined with --limit-documents.',
    '  --output <PATH>        Atomically write the manifest instead of stdout.',
    '  --help                 Show this help.',
    '',
    'This command plans only. It never runs OCR, imports results, or mutates OCR state.',
  ].join('\n');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const manifest = await buildRemoteOcrOffloadManifest({
    limitDocuments: options.limitDocuments,
    reprocessDocuments: options.reprocessDocuments,
  });
  if (options.output) {
    const outputPath = await writeRemoteOcrOffloadManifest(options.output, manifest);
    process.stdout.write(`${JSON.stringify({ output: outputPath, counts: manifest.counts })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`plan-remote-ocr-offload: ${error.message}\n`);
    process.exitCode = 2;
  });
}
