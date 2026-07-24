#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_QUEUE = path.join(ROOT, 'data/ocr-queue.json');
const DEFAULT_RUNTIME = path.join(ROOT, 'data/ocr-runtime-status-snapshot.json');
const DEFAULT_REVIEW = path.join(ROOT, 'data/ocr-review-queue-index.json');
const DEFAULT_DECISIONS = path.join(ROOT, 'data/ocr-review-decisions.json');
const DEFAULT_CANDIDATE_FALLBACK = path.join(ROOT, 'data/ocr-candidate-fallback-ledger.json');
const DEFAULT_LEDGER = path.join(ROOT, 'data/ocr-coverage-ledger.json');
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(`OCR coverage ledger: ${message}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, 'utf8'));
}

function require(condition, message) {
  if (!condition) fail(message);
}

function requireHash(value, label) {
  require(SHA256_PATTERN.test(String(value || '')), `${label} must be a SHA-256`);
  return value;
}

function requireInteger(value, label, minimum = 0) {
  require(Number.isInteger(value) && value >= minimum, `${label} must be an integer >= ${minimum}`);
  return value;
}

function countBy(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = String(selector(item));
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right, 'en')));
}

function sum(items, selector) {
  return items.reduce((total, item) => total + selector(item), 0);
}

function parseArgs(argv) {
  const options = {
    check: false,
    capture: false,
    queue: DEFAULT_QUEUE,
    runtime: DEFAULT_RUNTIME,
    review: DEFAULT_REVIEW,
    decisions: DEFAULT_DECISIONS,
    candidateFallback: DEFAULT_CANDIDATE_FALLBACK,
    ledger: DEFAULT_LEDGER,
    receiverReceipt: null,
    runStatuses: [],
    privateReviewQueue: null,
    observedAt: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') options.check = true;
    else if (argument === '--capture') options.capture = true;
    else if (argument === '--run-status') {
      options.runStatuses.push(path.resolve(argv[index + 1]));
      index += 1;
    } else {
      const fields = {
        '--queue': 'queue',
        '--runtime': 'runtime',
        '--review': 'review',
        '--decisions': 'decisions',
        '--candidate-fallback': 'candidateFallback',
        '--ledger': 'ledger',
        '--receiver-receipt': 'receiverReceipt',
        '--private-review-queue': 'privateReviewQueue',
        '--observed-at': 'observedAt',
      };
      const field = fields[argument];
      require(field, `unknown argument: ${argument}`);
      require(argv[index + 1] && !argv[index + 1].startsWith('--'), `missing value for ${argument}`);
      options[field] = field === 'observedAt' ? argv[index + 1] : path.resolve(argv[index + 1]);
      index += 1;
    }
  }
  require(!(options.check && options.capture), '--check and --capture cannot be combined');
  if (options.capture) {
    require(options.receiverReceipt, '--receiver-receipt is required with --capture');
    require(options.runStatuses.length > 0, 'at least one --run-status is required with --capture');
    require(options.privateReviewQueue, '--private-review-queue is required with --capture');
    require(options.observedAt && !Number.isNaN(Date.parse(options.observedAt)), '--observed-at must be an ISO timestamp');
  }
  return options;
}

function queueDocuments(queue) {
  require(queue.schema_version === 1, 'OCR queue schema_version must equal 1');
  require(Array.isArray(queue.documents), 'OCR queue documents must be an array');
  const ids = new Set();
  for (const document of queue.documents) {
    require(document?.id && !ids.has(document.id), `duplicate or empty OCR queue document id: ${document?.id}`);
    ids.add(document.id);
    requireHash(document.source_sha256, `${document.id}.source_sha256`);
    requireInteger(document.page_count, `${document.id}.page_count`, 1);
  }
  require(queue.counts?.documents === queue.documents.length, 'OCR queue document count drift');
  require(queue.counts?.pages === sum(queue.documents, (document) => document.page_count), 'OCR queue page count drift');
  return queue.documents;
}

export async function captureRuntimeSnapshot({
  queue,
  receiverReceiptPath,
  runStatusPaths,
  observedAt,
}) {
  const documents = queueDocuments(queue);
  const queueById = new Map(documents.map((document) => [document.id, document]));
  const runtimeRows = new Map();
  const inputReceipts = [];

  const receiverRaw = await readFile(receiverReceiptPath);
  const receiver = JSON.parse(receiverRaw);
  require(receiver.schema_version === 1, 'receiver receipt schema_version must equal 1');
  require(receiver.status === 'applied' && receiver.dry_run === false, 'receiver receipt must be an applied non-dry-run receipt');
  require(receiver.citation_allowed === false, 'receiver receipt must remain non-citable');
  require(Array.isArray(receiver.documents), 'receiver receipt documents must be an array');
  const receiverId = `receiver:${receiver.receipt_id}`;
  inputReceipts.push({
    id: receiverId,
    type: receiver.receipt_type,
    sha256: sha256(receiverRaw),
    documents: receiver.documents.length,
    pages: sum(receiver.documents, (document) => document.page_count),
    observed_at: receiver.applied_at || receiver.generated_at,
  });
  for (const document of receiver.documents) {
    const queued = queueById.get(document.document_id);
    require(queued, `receiver document is absent from OCR queue: ${document.document_id}`);
    require(document.page_count === queued.page_count, `${document.document_id} receiver page count drift`);
    require(document.source_pdf_sha256 === queued.source_sha256, `${document.document_id} receiver source hash drift`);
    const repairedQuarantine = document.source_document_status === 'quarantined'
      && Number.isInteger(document.repair_pages)
      && document.repair_pages > 0;
    require(
      document.source_document_status === 'complete' || repairedQuarantine,
      `${document.document_id} receiver status must be complete or an explicitly repaired quarantine`,
    );
    if (repairedQuarantine) {
      require(
        document.source_document_tree_sha256 === document.target_document_tree_sha256,
        `${document.document_id} repaired receiver tree does not match the applied target tree`,
      );
    }
    require(document.citation_allowed === false, `${document.document_id} receiver citation gate must be false`);
    runtimeRows.set(document.document_id, {
      id: document.document_id,
      source_sha256: queued.source_sha256,
      page_count: queued.page_count,
      runtime_status: repairedQuarantine
        ? 'complete_after_bounded_repair_pending_review'
        : 'complete_pending_review',
      complete_document: true,
      completed_pages: queued.page_count,
      remaining_pages: 0,
      first_missing_page: null,
      runtime_receipt_id: receiverId,
      runtime_status_sha256: document.source_document_status_sha256,
      citation_allowed: false,
    });
  }

  for (const runStatusPath of runStatusPaths) {
    const raw = await readFile(runStatusPath);
    const status = JSON.parse(raw);
    require(status.schema_version === 1, `${runStatusPath} schema_version must equal 1`);
    require(status.documents && typeof status.documents === 'object', `${runStatusPath} documents must be an object`);
    const receiptId = `run-status:${path.basename(path.dirname(runStatusPath))}:${sha256(raw).slice(0, 12)}`;
    inputReceipts.push({
      id: receiptId,
      type: 'remote_ocr_run_status',
      sha256: sha256(raw),
      documents: Object.keys(status.documents).length,
      pages: sum(Object.values(status.documents), (document) => document.page_count),
      observed_at: status.updated_at,
    });
    for (const [id, document] of Object.entries(status.documents)) {
      const queued = queueById.get(id);
      require(queued, `run-status document is absent from OCR queue: ${id}`);
      require(!runtimeRows.has(id), `runtime evidence overlaps document ${id}`);
      require(document.page_count === queued.page_count, `${id} run-status page count drift`);
      require(['complete', 'retry_wait'].includes(document.status), `${id} unsupported final runtime status: ${document.status}`);
      const complete = document.status === 'complete';
      const firstMissingPage = complete ? null : requireInteger(
        document.timeout_recovery_first_missing_page,
        `${id}.timeout_recovery_first_missing_page`,
        1,
      );
      const completedPages = complete ? queued.page_count : firstMissingPage - 1;
      runtimeRows.set(id, {
        id,
        source_sha256: queued.source_sha256,
        page_count: queued.page_count,
        runtime_status: complete ? 'complete_pending_review' : 'partial_retry_wait',
        complete_document: complete,
        completed_pages: completedPages,
        remaining_pages: queued.page_count - completedPages,
        first_missing_page: firstMissingPage,
        runtime_receipt_id: receiptId,
        runtime_status_sha256: requireHash(document.status_json_sha256, `${id}.status_json_sha256`),
        failure_class: complete ? null : 'bounded_idle_timeout_retry_exhausted',
        citation_allowed: false,
      });
    }
  }

  const missing = documents.map((document) => document.id).filter((id) => !runtimeRows.has(id));
  const extra = [...runtimeRows.keys()].filter((id) => !queueById.has(id));
  require(missing.length === 0 && extra.length === 0, `runtime coverage mismatch; missing=[${missing}] extra=[${extra}]`);
  const rows = documents.map((document) => runtimeRows.get(document.id));
  const physicalGroups = new Map();
  for (const row of rows) {
    const group = physicalGroups.get(row.source_sha256) || [];
    group.push(row);
    physicalGroups.set(row.source_sha256, group);
  }
  const duplicatePhysicalSources = [...physicalGroups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([sourceSha256, group]) => ({
      source_sha256: sourceSha256,
      canonical_document_id: [...group].sort((left, right) => {
        const leftOfficial = left.id.startsWith('moe-') ? 0 : 1;
        const rightOfficial = right.id.startsWith('moe-') ? 0 : 1;
        return leftOfficial - rightOfficial || left.id.localeCompare(right.id, 'en');
      })[0].id,
      alias_document_ids: group.map((document) => document.id).sort((left, right) => left.localeCompare(right, 'en')),
      page_count: group[0].page_count,
    }))
    .sort((left, right) => left.source_sha256.localeCompare(right.source_sha256, 'en'));
  for (const duplicate of duplicatePhysicalSources) {
    const group = duplicate.alias_document_ids.map((id) => runtimeRows.get(id));
    require(group.every((document) => document.page_count === duplicate.page_count), `${duplicate.source_sha256} duplicate page count drift`);
  }

  const physicalRows = [...physicalGroups.values()].map((group) => ({
    complete_document: group.every((document) => document.complete_document),
    page_count: group[0].page_count,
    completed_pages: Math.max(...group.map((document) => document.completed_pages)),
  }));
  return {
    schema_version: 1,
    contract: 'curriculum_ocr_runtime_status_snapshot_v1',
    observed_at: new Date(observedAt).toISOString(),
    policy: {
      queue_identity_denominator: 'all queue document ids, including source-identical catalog aliases',
      physical_source_denominator: 'unique source_sha256, counting identical PDF bytes once',
      partial_completion: 'only the attested contiguous prefix before timeout_recovery_first_missing_page',
      publication_mutation: 'none',
      citation_allowed: false,
    },
    input_receipts: inputReceipts.sort((left, right) => left.id.localeCompare(right.id, 'en')),
    counts: {
      nominal_documents: rows.length,
      nominal_pages: sum(rows, (document) => document.page_count),
      complete_documents: rows.filter((document) => document.complete_document).length,
      complete_document_pages: sum(rows.filter((document) => document.complete_document), (document) => document.page_count),
      completed_pages_including_partial_prefixes: sum(rows, (document) => document.completed_pages),
      remaining_pages: sum(rows, (document) => document.remaining_pages),
      physical_documents: physicalRows.length,
      physical_pages: sum(physicalRows, (document) => document.page_count),
      physical_complete_documents: physicalRows.filter((document) => document.complete_document).length,
      physical_completed_pages_including_partial_prefixes: sum(physicalRows, (document) => document.completed_pages),
    },
    duplicate_physical_sources: duplicatePhysicalSources,
    documents: rows,
  };
}

export async function captureReviewSnapshot({ privateReviewQueuePath, queue }) {
  const raw = await readFile(privateReviewQueuePath);
  const review = JSON.parse(raw);
  require(review.schema_version === 1 && review.artifact_type === 'ocr_review_queue', 'private review queue contract mismatch');
  require(review.policy?.publication_mutation === 'none', 'private review queue must not mutate publication');
  require(Array.isArray(review.queue), 'private review queue entries must be an array');
  const queueById = new Map(queueDocuments(queue).map((document) => [document.id, document]));
  const seen = new Set();
  const entries = review.queue.map((page) => {
    require(queueById.has(page.document_id), `review page document is absent from OCR queue: ${page.document_id}`);
    requireInteger(page.page, `${page.stable_locator}.page`, 1);
    require(page.page <= queueById.get(page.document_id).page_count, `${page.stable_locator} exceeds document page count`);
    require(page.stable_locator === `${page.document_id}:page:${page.page}`, `${page.stable_locator} is not stable`);
    require(!seen.has(page.stable_locator), `duplicate review locator: ${page.stable_locator}`);
    seen.add(page.stable_locator);
    return {
      stable_locator: page.stable_locator,
      document_id: page.document_id,
      page: page.page,
      gate: page.gate,
      priority: page.priority,
      reasons: page.reasons,
      primary_sha256: requireHash(page.primary?.sha256, `${page.stable_locator}.primary_sha256`),
      witness_sha256: requireHash(page.witness?.sha256, `${page.stable_locator}.witness_sha256`),
      citation_allowed: false,
    };
  });
  require(entries.length === review.summary.queued_pages, 'private review queue summary drift');
  return {
    schema_version: 1,
    contract: 'curriculum_ocr_review_queue_index_v1',
    policy: {
      source_mode: 'sanitized_projection_of_private_dual_witness_audits',
      private_paths_and_transcriptions_included: false,
      automatic_witness_pass_in_queue: false,
      review_decision_required: true,
      publication_mutation: 'none',
      citation_allowed: false,
    },
    source_snapshot: {
      audit_file_count: review.source_snapshot.audit_file_count,
      audit_tree_sha256: requireHash(review.source_snapshot.sha256, 'review source snapshot sha256'),
      private_queue_sha256: sha256(raw),
    },
    summary: review.summary,
    queued_by_document: Object.entries(countBy(entries, (page) => page.document_id))
      .map(([documentId, pages]) => ({ document_id: documentId, pages }))
      .sort((left, right) => left.document_id.localeCompare(right.document_id, 'en')),
    queue: entries,
  };
}

export async function buildCoverageLedger({
  queue,
  runtime,
  review,
  decisions,
  candidateFallback,
  decisionsPath = DEFAULT_DECISIONS,
  candidateFallbackPath = DEFAULT_CANDIDATE_FALLBACK,
}) {
  const documents = queueDocuments(queue);
  require(runtime.contract === 'curriculum_ocr_runtime_status_snapshot_v1', 'runtime snapshot contract mismatch');
  require(review.contract === 'curriculum_ocr_review_queue_index_v1', 'review snapshot contract mismatch');
  require(decisions.contract === 'curriculum_ocr_review_decisions_v1', 'review decisions contract mismatch');
  require(Array.isArray(decisions.decisions), 'review decisions must be an array');

  const runtimeById = new Map(runtime.documents.map((document) => [document.id, document]));
  const reviewByDocument = new Map();
  const reviewByLocator = new Map();
  for (const page of review.queue) {
    require(!reviewByLocator.has(page.stable_locator), `duplicate review locator in index: ${page.stable_locator}`);
    reviewByLocator.set(page.stable_locator, page);
    const pages = reviewByDocument.get(page.document_id) || [];
    pages.push(page);
    reviewByDocument.set(page.document_id, pages);
  }
  require(candidateFallback?.schema_version === 1
    && candidateFallback?.artifact_profile === 'curriculum-candidate-ocr-fallback-ledger-v1',
  'candidate fallback ledger contract mismatch');
  require(candidateFallback.policy?.citation_allowed === false
    && candidateFallback.policy?.semantic_claim_allowed === false
    && candidateFallback.policy?.negative_claim_allowed === false,
  'candidate fallback ledger must remain fail closed');
  const fallbackByDocument = new Map();
  for (const document of candidateFallback.documents || []) {
    const queued = documents.find((item) => item.id === document.document_id);
    require(queued, `candidate fallback document is absent from OCR queue: ${document.document_id}`);
    require(document.source_pdf_sha256 === queued.source_sha256,
      `${document.document_id} candidate fallback source hash drift`);
    const pages = new Set();
    for (const page of document.pages || []) {
      requireInteger(page.page, `${document.document_id}.candidate_page`, 1);
      require(page.page <= queued.page_count, `${document.document_id} candidate page exceeds PDF`);
      requireHash(page.sidecar_sha256, `${document.document_id}:${page.page}.sidecar_sha256`);
      require(!pages.has(page.page), `${document.document_id} duplicate candidate fallback page ${page.page}`);
      pages.add(page.page);
    }
    require(pages.size === document.counts?.pages,
      `${document.document_id} candidate fallback page count drift`);
    fallbackByDocument.set(document.document_id, pages);
  }

  const decisionIds = new Set();
  for (const decision of decisions.decisions) {
    require(decision.id && !decisionIds.has(decision.id), `duplicate or empty review decision id: ${decision.id}`);
    decisionIds.add(decision.id);
    require(reviewByLocator.has(decision.stable_locator), `decision locator is absent from review queue: ${decision.stable_locator}`);
    require(decision.citation_allowed === false, `${decision.id} may not promote citation without the full publication gate`);
    require(decision.semantic_promotion_allowed === false, `${decision.id} may not promote semantic claims`);
    const evidencePath = path.resolve(ROOT, decision.evidence_file);
    requireHash(decision.evidence_file_sha256, `${decision.id}.evidence_file_sha256`);
    require(sha256(await readFile(evidencePath)) === decision.evidence_file_sha256, `${decision.id} evidence file hash drift`);
  }

  const rows = documents.map((document) => {
    const state = runtimeById.get(document.id);
    require(state, `runtime snapshot is missing ${document.id}`);
    require(state.source_sha256 === document.source_sha256, `${document.id} runtime source hash drift`);
    require(state.page_count === document.page_count, `${document.id} runtime page count drift`);
    const reviewPages = reviewByDocument.get(document.id) || [];
    const decidedPages = decisions.decisions.filter((decision) => decision.stable_locator.startsWith(`${document.id}:page:`));
    const reviewedPageNumbers = new Set(reviewPages.map((page) => page.page));
    const fallbackPageNumbers = fallbackByDocument.get(document.id) || new Set();
    let candidateCoveredPages = state.completed_pages;
    while (reviewedPageNumbers.has(candidateCoveredPages + 1)) candidateCoveredPages += 1;
    while (fallbackPageNumbers.has(candidateCoveredPages + 1)) candidateCoveredPages += 1;
    return {
      document_id: document.id,
      title: document.title,
      subject: document.subject,
      source_sha256: document.source_sha256,
      page_count: document.page_count,
      physical_source_canonical_id: runtime.duplicate_physical_sources
        .find((group) => group.alias_document_ids.includes(document.id))?.canonical_document_id || document.id,
      runtime_status: state.runtime_status,
      complete_document: state.complete_document,
      runtime_completed_pages: state.completed_pages,
      runtime_remaining_pages: state.remaining_pages,
      candidate_covered_pages: candidateCoveredPages,
      candidate_remaining_pages: document.page_count - candidateCoveredPages,
      missing_page_range: candidateCoveredPages < document.page_count
        ? [candidateCoveredPages + 1, document.page_count]
        : null,
      dual_witness_audited_pages: reviewPages.length,
      dual_witness_pages_outside_runtime_prefix: reviewPages
        .filter((page) => page.page > state.completed_pages).length,
      single_witness_candidate_fallback_pages: fallbackPageNumbers.size,
      pending_review_pages: reviewPages.length - decidedPages.length,
      decided_non_citation_pages: decidedPages.length,
      citation_allowed: false,
      negative_claim_eligible: false,
    };
  });
  require(runtime.counts.nominal_documents === rows.length, 'runtime nominal document count drift');
  require(runtime.counts.nominal_pages === sum(rows, (document) => document.page_count), 'runtime nominal page count drift');
  require(review.summary.queued_pages === sum(rows, (document) => document.dual_witness_audited_pages), 'review page denominator drift');

  const physicalCanonicalIds = new Set(rows.map((document) => document.physical_source_canonical_id));
  require(physicalCanonicalIds.size === runtime.counts.physical_documents, 'physical source denominator drift');
  const gaps = rows
    .filter((document) => document.candidate_remaining_pages > 0)
    .map((document) => ({
      document_id: document.document_id,
      page_range: document.missing_page_range,
      remaining_pages: document.candidate_remaining_pages,
      blocker: 'runtime_retry_wait_after_bounded_idle_timeout',
      publication_effect: 'candidate coverage remains explicitly incomplete; citation and negative historical claims stay closed',
    }));
  return {
    schema_version: 1,
    contract: 'curriculum_ocr_coverage_ledger_v1',
    generated_from: {
      queue_sha256: sha256(await readFile(DEFAULT_QUEUE)),
      runtime_snapshot_sha256: sha256(await readFile(DEFAULT_RUNTIME)),
      review_queue_index_sha256: sha256(await readFile(DEFAULT_REVIEW)),
      review_decisions_sha256: sha256(await readFile(decisionsPath)),
      candidate_fallback_sha256: sha256(await readFile(candidateFallbackPath)),
    },
    assertion_boundary: 'OCR completion, dual-witness audit, human review, publication and semantic claims are separate gates. No count in this ledger opens quotation, citation, first-appearance, disappearance, replacement, influence or causality claims.',
    release_gate: {
      zero_silent_missing_documents: rows.length === runtime.counts.nominal_documents,
      zero_silent_missing_pages: sum(
        rows,
        (document) => document.candidate_covered_pages + document.candidate_remaining_pages,
      )
        === runtime.counts.nominal_pages,
      explicit_candidate_gaps: gaps.length,
      runtime_remaining_pages: sum(rows, (document) => document.runtime_remaining_pages),
      citation_allowed: false,
      semantic_promotion_allowed: false,
      negative_claim_eligible: false,
    },
    counts: {
      nominal_documents: rows.length,
      nominal_pages: sum(rows, (document) => document.page_count),
      physical_documents: runtime.counts.physical_documents,
      physical_pages: runtime.counts.physical_pages,
      complete_documents: rows.filter((document) => document.complete_document).length,
      complete_document_pages: sum(rows.filter((document) => document.complete_document), (document) => document.page_count),
      runtime_completed_pages_including_partial_prefixes: sum(rows, (document) => document.runtime_completed_pages),
      runtime_remaining_pages: sum(rows, (document) => document.runtime_remaining_pages),
      candidate_covered_pages_including_review_evidence: sum(rows, (document) => document.candidate_covered_pages),
      candidate_remaining_pages: sum(rows, (document) => document.candidate_remaining_pages),
      single_witness_candidate_fallback_pages: candidateFallback.counts.pages,
      dual_witness_audited_pages: review.queue.length,
      human_decided_non_citation_pages: decisions.decisions.length,
      citation_ready_pages: 0,
      explicit_gap_documents: gaps.length,
    },
    review_queue: {
      queued_pages: review.summary.queued_pages,
      queued_by_priority: review.summary.queued_by_priority,
      queued_by_gate: review.summary.queued_by_gate,
      pending_pages: review.summary.queued_pages - decisions.decisions.length,
      decisions: decisions.decisions.length,
    },
    duplicate_physical_sources: runtime.duplicate_physical_sources,
    gaps,
    documents: rows,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const queue = await readJson(options.queue);
  if (options.capture) {
    const runtime = await captureRuntimeSnapshot({
      queue,
      receiverReceiptPath: options.receiverReceipt,
      runStatusPaths: options.runStatuses,
      observedAt: options.observedAt,
    });
    const review = await captureReviewSnapshot({
      privateReviewQueuePath: options.privateReviewQueue,
      queue,
    });
    await writeFile(options.runtime, stableJson(runtime));
    await writeFile(options.review, stableJson(review));
  }
  const [runtime, review, decisions, candidateFallback] = await Promise.all([
    readJson(options.runtime),
    readJson(options.review),
    readJson(options.decisions),
    readJson(options.candidateFallback),
  ]);
  const ledger = await buildCoverageLedger({
    queue,
    runtime,
    review,
    decisions,
    candidateFallback,
    decisionsPath: options.decisions,
    candidateFallbackPath: options.candidateFallback,
  });
  const expected = stableJson(ledger);
  if (options.check) {
    const actual = await readFile(options.ledger, 'utf8');
    require(actual === expected, 'checked-in OCR coverage ledger is stale');
  } else {
    await writeFile(options.ledger, expected);
  }
  process.stdout.write(`${JSON.stringify({
    documents: ledger.counts.nominal_documents,
    physical_documents: ledger.counts.physical_documents,
    candidate_covered_pages: ledger.counts.candidate_covered_pages_including_review_evidence,
    candidate_remaining_pages: ledger.counts.candidate_remaining_pages,
    review_queue_pages: ledger.counts.dual_witness_audited_pages,
    gaps: ledger.gaps.map((gap) => gap.document_id),
  })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
