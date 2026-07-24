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
  if (page.gate === 'blank_page_visual_confirmation_required') return 'blank_raster_consensus';
  if (page.table?.detected === true) return 'table_structure_consensus';
  const gate = policy.exact_page_gate;
  if (page.agreement >= gate.minimum_normalized_character_agreement
    && page.title?.exact === true
    && page.numeric?.exact === true
    && page.confidence?.average_vision >= gate.minimum_average_independent_witness_confidence) {
    return 'exact_page_candidate';
  }
  return 'third_engine_text_consensus';
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
    heading: normalizeExactText(page.title.primary_heading),
    numeric_sequence: page.numeric.primary_sequence.map((value) => normalizeExactText(value)),
  }));
}

async function verifyExactCandidate(page, document, policy, actualSourceSha256) {
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

  const primaryText = normalizeExactText(primaryRaw.toString('utf8'));
  const independentText = normalizeExactText(witnessText(witness));
  const gate = policy.exact_page_gate;
  const exact = primaryText === independentText;
  const replacementFree = !primaryText.includes('\ufffd') && !independentText.includes('\ufffd');
  if (!exact || (gate.allow_replacement_character === false && !replacementFree)) {
    return {
      status: 'third_engine_text_consensus',
      reason: exact ? 'replacement_character_detected' : 'normalized_full_text_not_exact',
    };
  }

  const normalizedTextSha256 = sha256(primaryText);
  const receiptPayload = {
    stable_locator: page.stable_locator,
    source_pdf_sha256: document.source_sha256,
    physical_pdf_page: page.page,
    primary_text_sha256: page.primary.sha256,
    independent_witness_sha256: page.witness.sha256,
    independent_witness_envelope_sha256: sha256(witnessRaw),
    rendered_image_sha256: witness.rendered_image_sha256,
    normalized_text_sha256: normalizedTextSha256,
    protected_fields_sha256: protectedFieldDigest(page),
  };
  return {
    status: 'machine_verified_exact',
    page: {
      ...receiptPayload,
      document_id: page.document_id,
      agreement: page.agreement,
      independent_witness_average_confidence: page.confidence.average_vision,
      primary_engine: 'PaddleOCR-VL structured primary',
      independent_witness_engine: witness.engine,
      publication_manifest_eligible: true,
      production_citation_ready: false,
      semantic_claim_allowed: false,
      receipt_sha256: sha256(JSON.stringify(receiptPayload)),
    },
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
  assert(policy.policy_id === 'curriculum-ocr-machine-verification-v1',
    'policy contract mismatch');
  const documents = new Map(ocrQueue.documents.map((document) => [document.id, document]));
  const counts = {
    audited_pages: queue.queue.length,
    machine_verified_exact_pages: 0,
    third_engine_text_consensus_pages: 0,
    table_structure_consensus_pages: 0,
    blank_raster_consensus_pages: 0,
    publication_manifest_eligible_pages: 0,
    production_citation_ready_pages: 0,
    human_required_pages: 0,
  };
  const verifiedPages = [];
  const byDocument = new Map();
  const sourceHashCache = new Map();
  const currentSourceHash = (document) => {
    if (!sourceHashCache.has(document.id)) {
      sourceHashCache.set(document.id, readFile(path.resolve(ROOT, document.local_cache_path)).then(sha256));
    }
    return sourceHashCache.get(document.id);
  };

  for (const page of queue.queue) {
    let lane = baseLane(page, policy);
    let verification = null;
    if (lane === 'exact_page_candidate') {
      const document = documents.get(page.document_id);
      assert(document, `${page.stable_locator} has no OCR queue document`);
      verification = await verifyExactCandidate(
        page,
        document,
        policy,
        await currentSourceHash(document),
      );
      lane = verification.status;
    }
    if (lane === 'machine_verified_exact') {
      counts.machine_verified_exact_pages += 1;
      counts.publication_manifest_eligible_pages += 1;
      verifiedPages.push(verification.page);
    } else if (lane === 'table_structure_consensus') {
      counts.table_structure_consensus_pages += 1;
    } else if (lane === 'blank_raster_consensus') {
      counts.blank_raster_consensus_pages += 1;
    } else {
      counts.third_engine_text_consensus_pages += 1;
    }
    const documentCounts = byDocument.get(page.document_id) || {
      machine_verified_exact: 0,
      third_engine_text_consensus: 0,
      table_structure_consensus: 0,
      blank_raster_consensus: 0,
    };
    documentCounts[lane] += 1;
    byDocument.set(page.document_id, documentCounts);
  }
  assert(counts.machine_verified_exact_pages
    + counts.third_engine_text_consensus_pages
    + counts.table_structure_consensus_pages
    + counts.blank_raster_consensus_pages === counts.audited_pages,
  'machine lanes are not exhaustive');

  return {
    schema_version: 1,
    artifact_profile: 'curriculum-ocr-machine-verification-v1',
    policy_id: policy.policy_id,
    source_bindings: {
      review_queue_sha256: sha256(queueRaw),
      ocr_queue_sha256: sha256(ocrQueueRaw),
      policy_sha256: sha256(policyRaw),
    },
    assertion_boundary: 'Exact dual-engine machine receipts may feed the page publication manifest. They are not yet production citations and do not prove semantic continuity, first appearance, disappearance, replacement, influence, or causality.',
    counts,
    release_gate: {
      manual_override_allowed: false,
      human_review_required: false,
      automatic_manifest_generation_allowed_for_exact_pages: true,
      production_publication_mutation: 'none',
      semantic_claim_allowed: false,
    },
    verified_pages: verifiedPages.sort((left, right) =>
      left.stable_locator.localeCompare(right.stable_locator, 'en')),
    documents: [...byDocument.entries()]
      .map(([document_id, lanes]) => ({ document_id, total: Object.values(lanes).reduce((sum, value) => sum + value, 0), lanes }))
      .sort((left, right) => left.document_id.localeCompare(right.document_id, 'en')),
  };
}

async function writeOutputs(output) {
  const summary = await readJson(PUBLIC_SUMMARY_PATH);
  summary.machine_verification = {
    policy_id: output.policy_id,
    machine_verified_exact_pages: output.counts.machine_verified_exact_pages,
    publication_manifest_eligible_pages: output.counts.publication_manifest_eligible_pages,
    machine_adjudication_pending_pages: output.counts.audited_pages
      - output.counts.machine_verified_exact_pages,
    human_required_pages: output.counts.human_required_pages,
    production_citation_ready_pages: output.counts.production_citation_ready_pages,
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
