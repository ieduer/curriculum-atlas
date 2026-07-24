#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const QUEUE_PATH = path.join(ROOT, '.cache/ocr-review-queue-20260723.json');
const OCR_QUEUE_PATH = path.join(ROOT, 'data/ocr-queue.json');
const POLICY_PATH = path.join(ROOT, 'data/ocr-machine-verification-policy.json');
const OUTPUT_PATH = path.join(ROOT, 'data/ocr-machine-verification.json');
const PUBLIC_SUMMARY_PATH = path.join(ROOT, 'public/data/ocr-coverage-summary.json');
const CONCURRENCY = 24;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function normalizeExactText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/^#+\s*/gmu, '')
    .replace(/[\s\u00a0]+/gu, '')
    .replace(/[～~〜]/gu, '~')
    .replace(/[“”]/gu, '"')
    .replace(/[‘’]/gu, "'");
}

export function baseLane(page, policy) {
  if (page.gate === 'blank_page_visual_confirmation_required') return 'dual_zero_text_blank';
  if (page.table?.detected === true) return 'table_conflict_fail_closed';
  const gate = policy.exact_page_gate;
  if (page.agreement >= gate.minimum_normalized_character_agreement
    && page.title?.exact === true
    && page.numeric?.exact === true
    && page.confidence?.average_vision >= gate.minimum_average_independent_witness_confidence) {
    return 'exact_page_candidate';
  }
  return 'text_conflict_fail_closed';
}

function assert(condition, message) {
  if (!condition) throw new Error(`OCR machine verification: ${message}`);
}

async function readJson(target) {
  return JSON.parse(await readFile(target, 'utf8'));
}

function witnessText(witness) {
  assert(Array.isArray(witness.lines), 'independent witness lines are missing');
  return witness.lines.map((line) => String(line.text || '')).join('');
}

function protectedFieldDigest(page) {
  return sha256(JSON.stringify({
    heading: normalizeExactText(page.title?.primary_heading),
    numeric_sequence: (page.numeric?.primary_sequence || [])
      .map((value) => normalizeExactText(value)),
  }));
}

async function mapConcurrent(values, mapper, concurrency = CONCURRENCY) {
  const output = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    () => worker(),
  ));
  return output;
}

async function verifyPageBinding(page, document, actualSourceSha256) {
  assert(document, `${page.stable_locator} has no OCR queue document`);
  assert(actualSourceSha256 === document.source_sha256,
    `${page.stable_locator} current source PDF hash drift`);
  const [primaryRaw, witnessRaw] = await Promise.all([
    readFile(page.primary.paths[0]),
    readFile(page.witness.paths[0]),
  ]);
  assert(sha256(primaryRaw) === page.primary.sha256, `${page.stable_locator} primary hash drift`);
  const witness = JSON.parse(witnessRaw);
  const canonicalWitness = witness.lines.map((line) => String(line.text || '')).join('\n');
  assert(sha256(canonicalWitness) === page.witness.sha256,
    `${page.stable_locator} canonical witness hash drift`);
  assert(witness.document_id === page.document_id, `${page.stable_locator} witness document mismatch`);
  assert(witness.physical_pdf_page === page.page, `${page.stable_locator} witness page mismatch`);
  assert(witness.source_pdf_sha256 === document.source_sha256, `${page.stable_locator} source PDF mismatch`);
  assert(/Apple Vision/u.test(String(witness.engine)), `${page.stable_locator} independent engine mismatch`);
  assert(/PaddleOCR/u.test(String(document.policy)), `${page.stable_locator} primary engine policy missing`);
  assert(/^[a-f0-9]{64}$/u.test(String(witness.rendered_image_sha256)),
    `${page.stable_locator} rendered image binding missing`);
  return {
    primaryRaw,
    witnessRaw,
    witness,
    primaryNormalized: normalizeExactText(primaryRaw.toString('utf8')),
    witnessNormalized: normalizeExactText(witnessText(witness)),
  };
}

function dispositionFor(page, initialLane, binding, policy) {
  let lane = initialLane;
  let publicationDisposition = 'omitted_conflict_fail_closed';
  let status = 'machine_adjudicated_fail_closed';
  let reason = null;

  if (initialLane === 'exact_page_candidate') {
    const exact = binding.primaryNormalized === binding.witnessNormalized;
    const replacementFree = !binding.primaryNormalized.includes('\ufffd')
      && !binding.witnessNormalized.includes('\ufffd');
    if (exact && (policy.exact_page_gate.allow_replacement_character !== false || replacementFree)) {
      lane = 'dual_witness_exact';
      status = 'machine_verified_exact';
      publicationDisposition = 'accepted_exact_page';
    } else {
      lane = 'text_conflict_fail_closed';
      reason = exact ? 'replacement_character_detected' : 'normalized_full_text_not_exact';
    }
  } else if (initialLane === 'dual_zero_text_blank') {
    assert(binding.primaryNormalized === '' && binding.witnessNormalized === '',
      `${page.stable_locator} blank lane contains recognized text`);
    status = 'machine_verified_blank';
    publicationDisposition = 'non_text_blank';
  } else if (initialLane === 'table_conflict_fail_closed') {
    reason = 'table_requires_full_exact_page_consensus';
  } else {
    reason = 'dual_witness_text_conflict';
  }

  return { lane, status, publicationDisposition, reason };
}

function pageReceipt(page, document, binding, disposition) {
  const payload = {
    stable_locator: page.stable_locator,
    document_id: page.document_id,
    source_pdf_sha256: document.source_sha256,
    physical_pdf_page: page.page,
    primary_text_sha256: page.primary.sha256,
    independent_witness_sha256: page.witness.sha256,
    independent_witness_envelope_sha256: sha256(binding.witnessRaw),
    rendered_image_sha256: binding.witness.rendered_image_sha256,
    normalized_primary_text_sha256: sha256(binding.primaryNormalized),
    normalized_independent_text_sha256: sha256(binding.witnessNormalized),
    protected_fields_sha256: protectedFieldDigest(page),
    primary_engine: 'PaddleOCR-VL structured primary',
    independent_witness_engine: binding.witness.engine,
    agreement: page.agreement,
    heading_exact: page.title?.exact === true,
    numeric_sequence_exact: page.numeric?.exact === true,
    table_detected: page.table?.detected === true,
    lane: disposition.lane,
    status: disposition.status,
    publication_disposition: disposition.publicationDisposition,
    reason: disposition.reason,
  };
  return {
    ...payload,
    publication_manifest_eligible: disposition.status === 'machine_verified_exact',
    production_citation_ready: false,
    semantic_claim_allowed: false,
    receipt_sha256: sha256(JSON.stringify(payload)),
  };
}

export async function buildMachineVerification({
  queuePath = QUEUE_PATH,
  ocrQueuePath = OCR_QUEUE_PATH,
  policyPath = POLICY_PATH,
} = {}) {
  const [queueRaw, ocrQueueRaw, policyRaw] = await Promise.all([
    readFile(queuePath),
    readFile(ocrQueuePath),
    readFile(policyPath),
  ]);
  const queue = JSON.parse(queueRaw);
  const ocrQueue = JSON.parse(ocrQueueRaw);
  const policy = JSON.parse(policyRaw);
  assert(queue.schema_version === 1 && queue.artifact_type === 'ocr_review_queue',
    'private queue contract mismatch');
  assert(policy.policy_id === 'curriculum-ocr-machine-verification-v2',
    'policy contract mismatch');
  assert(policy.release_policy.machine_adjudication_must_cover_every_audited_page === true,
    'exhaustive adjudication policy is not enabled');
  const documents = new Map(ocrQueue.documents.map((document) => [document.id, document]));
  const sourceHashCache = new Map();
  const currentSourceHash = (document) => {
    if (!sourceHashCache.has(document.id)) {
      sourceHashCache.set(
        document.id,
        readFile(path.resolve(ROOT, document.local_cache_path)).then(sha256),
      );
    }
    return sourceHashCache.get(document.id);
  };

  const adjudicatedPages = await mapConcurrent(queue.queue, async (page) => {
    const document = documents.get(page.document_id);
    assert(document, `${page.stable_locator} has no OCR queue document`);
    const binding = await verifyPageBinding(page, document, await currentSourceHash(document));
    const disposition = dispositionFor(page, baseLane(page, policy), binding, policy);
    return pageReceipt(page, document, binding, disposition);
  });

  const counts = {
    audited_pages: queue.queue.length,
    machine_adjudicated_pages: adjudicatedPages.length,
    machine_adjudication_pending_pages: 0,
    machine_verified_exact_pages: adjudicatedPages
      .filter((page) => page.status === 'machine_verified_exact').length,
    machine_verified_blank_pages: adjudicatedPages
      .filter((page) => page.status === 'machine_verified_blank').length,
    text_conflict_fail_closed_pages: adjudicatedPages
      .filter((page) => page.lane === 'text_conflict_fail_closed').length,
    table_conflict_fail_closed_pages: adjudicatedPages
      .filter((page) => page.lane === 'table_conflict_fail_closed').length,
    publication_manifest_eligible_pages: adjudicatedPages
      .filter((page) => page.publication_manifest_eligible).length,
    production_citation_ready_pages: 0,
    human_required_pages: 0,
  };
  assert(counts.machine_adjudicated_pages === counts.audited_pages,
    'machine adjudication is not exhaustive');
  assert(counts.machine_verified_exact_pages
    + counts.machine_verified_blank_pages
    + counts.text_conflict_fail_closed_pages
    + counts.table_conflict_fail_closed_pages === counts.audited_pages,
  'machine dispositions are not exhaustive');

  const byDocument = new Map();
  for (const page of adjudicatedPages) {
    const documentCounts = byDocument.get(page.document_id) || {
      dual_witness_exact: 0,
      text_conflict_fail_closed: 0,
      table_conflict_fail_closed: 0,
      dual_zero_text_blank: 0,
    };
    documentCounts[page.lane] += 1;
    byDocument.set(page.document_id, documentCounts);
  }
  const sortedPages = adjudicatedPages.sort((left, right) =>
    left.stable_locator.localeCompare(right.stable_locator, 'en'));

  return {
    schema_version: 2,
    artifact_profile: 'curriculum-ocr-machine-verification-v2',
    policy_id: policy.policy_id,
    decided_at: policy.decided_at,
    machine_reviewer: policy.machine_reviewer,
    source_bindings: {
      review_queue_sha256: sha256(queueRaw),
      ocr_queue_sha256: sha256(ocrQueueRaw),
      policy_sha256: sha256(policyRaw),
    },
    assertion_boundary: 'Every audited page now has a terminal machine disposition. Exact pages may feed the publication manifest; conflict pages are conclusively omitted. Neither outcome proves semantic continuity, first appearance, disappearance, replacement, influence, or causality.',
    counts,
    release_gate: {
      manual_override_allowed: false,
      human_review_required: false,
      machine_adjudication_complete: true,
      automatic_manifest_generation_allowed_for_exact_pages: true,
      production_publication_mutation: 'separate_hash_bound_manifest_builder_required',
      semantic_claim_allowed: false,
    },
    verified_pages: sortedPages.filter((page) => page.status === 'machine_verified_exact'),
    adjudicated_pages: sortedPages,
    documents: [...byDocument.entries()]
      .map(([document_id, lanes]) => ({
        document_id,
        total: Object.values(lanes).reduce((sum, value) => sum + value, 0),
        lanes,
      }))
      .sort((left, right) => left.document_id.localeCompare(right.document_id, 'en')),
  };
}

async function writeOutputs(output) {
  const summary = await readJson(PUBLIC_SUMMARY_PATH);
  summary.machine_verification = {
    policy_id: output.policy_id,
    machine_adjudicated_pages: output.counts.machine_adjudicated_pages,
    machine_verified_exact_pages: output.counts.machine_verified_exact_pages,
    publication_manifest_eligible_pages: output.counts.publication_manifest_eligible_pages,
    machine_adjudication_pending_pages: output.counts.machine_adjudication_pending_pages,
    human_required_pages: output.counts.human_required_pages,
    production_citation_ready_pages: 0,
  };
  await Promise.all([
    writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`),
    writeFile(PUBLIC_SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const checkOnly = process.argv.includes('--check');
  const output = await buildMachineVerification();
  if (checkOnly) {
    const existing = await readJson(OUTPUT_PATH);
    assert(JSON.stringify(existing) === JSON.stringify(output), 'checked-in receipt is stale');
  } else {
    await writeOutputs(output);
  }
  process.stdout.write(`${JSON.stringify(output.counts)}\n`);
}
