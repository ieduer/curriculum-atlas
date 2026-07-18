#!/usr/bin/env node
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readPinnedDirectoryEntries,
  readPinnedRegularFile,
  verifyPinnedDirectoryReceipt,
} from './lib/safe-local-evidence.mjs';

const DOCUMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PAGE_FILE_PATTERN = /^page-(\d+)\.json$/;

function fail(message) {
  throw new Error(`OCR page furniture approvals: ${message}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function requireString(value, label, pattern = null) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string`);
  if (pattern && !pattern.test(value)) fail(`${label} has an invalid format`);
  return value;
}

function requireInteger(value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    fail(`${label} must be an integer >= ${minimum}`);
  }
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
}

function validateStructure(input) {
  const ledger = requireObject(input, 'ledger');
  if (ledger.schema_version !== 1) fail('schema_version must equal 1');
  if (ledger.artifact_profile !== 'ocr-page-furniture-approval-ledger-v1') {
    fail('artifact_profile must equal ocr-page-furniture-approval-ledger-v1');
  }
  if (ledger.activation_status !== 'approved_not_activated') {
    fail('activation_status must remain approved_not_activated until a separate activation review');
  }
  const policy = requireObject(ledger.policy, 'policy');
  if (policy.raw_witness_mutation !== 'forbidden') fail('raw witness mutation must be forbidden');
  if (policy.audit_filter_activation
    !== 'requires_explicit_consumer_and_final_witness_snapshot_match') {
    fail('audit filter activation policy is invalid');
  }
  if (policy.publication_effect !== 'none') fail('publication effect must remain none');

  const documentIds = new Set();
  const ruleIds = new Set();
  const documents = requireArray(ledger.documents, 'documents');
  if (!documents.length) fail('documents must not be empty');
  for (let documentIndex = 0; documentIndex < documents.length; documentIndex += 1) {
    const document = requireObject(documents[documentIndex], `documents[${documentIndex}]`);
    const documentId = requireString(
      document.document_id,
      `documents[${documentIndex}].document_id`,
      DOCUMENT_ID_PATTERN,
    );
    if (documentIds.has(documentId)) fail(`duplicate document_id ${documentId}`);
    documentIds.add(documentId);
    requireString(
      document.source_pdf_sha256,
      `${documentId}.source_pdf_sha256`,
      SHA256_PATTERN,
    );
    requireString(
      document.sidecar_snapshot_sha256,
      `${documentId}.sidecar_snapshot_sha256`,
      SHA256_PATTERN,
    );
    const pageCount = requireInteger(document.page_count, `${documentId}.page_count`, 1);
    if (document.review_status !== 'manually_approved_unactivated') {
      fail(`${documentId}.review_status must remain manually_approved_unactivated`);
    }
    if (requireArray(document.header_rules, `${documentId}.header_rules`).length) {
      fail(`${documentId}.header_rules must remain empty until header-specific review exists`);
    }
    const footerRules = requireArray(document.footer_rules, `${documentId}.footer_rules`);
    if (!footerRules.length) fail(`${documentId}.footer_rules must not be empty`);
    let previousEnd = 0;
    for (let ruleIndex = 0; ruleIndex < footerRules.length; ruleIndex += 1) {
      const label = `${documentId}.footer_rules[${ruleIndex}]`;
      const rule = requireObject(footerRules[ruleIndex], label);
      const ruleId = requireString(rule.rule_id, `${label}.rule_id`);
      if (ruleIds.has(ruleId)) fail(`duplicate rule_id ${ruleId}`);
      ruleIds.add(ruleId);
      if (rule.candidate_type !== 'printed_page_number_footer') {
        fail(`${ruleId}.candidate_type must equal printed_page_number_footer`);
      }
      const startPage = requireInteger(rule.start_page, `${ruleId}.start_page`, 1);
      const endPage = requireInteger(rule.end_page, `${ruleId}.end_page`, startPage);
      if (endPage > pageCount) fail(`${ruleId}.end_page exceeds document page_count`);
      if (startPage <= previousEnd) fail(`${ruleId} overlaps or is not sorted`);
      previousEnd = endPage;
      if (requireInteger(rule.page_count, `${ruleId}.page_count`, 1) !== endPage - startPage + 1) {
        fail(`${ruleId}.page_count does not match its inclusive range`);
      }
      if (!Number.isInteger(rule.physical_to_printed_offset)) {
        fail(`${ruleId}.physical_to_printed_offset must be an integer`);
      }
      const printedStart = requireInteger(rule.printed_page_start, `${ruleId}.printed_page_start`, 1);
      const printedEnd = requireInteger(rule.printed_page_end, `${ruleId}.printed_page_end`, 1);
      if (printedStart !== startPage + rule.physical_to_printed_offset
        || printedEnd !== endPage + rule.physical_to_printed_offset) {
        fail(`${ruleId} printed page bounds do not match the physical-page offset`);
      }
      if (rule.observed_last_line_must_equal_printed_page !== true) {
        fail(`${ruleId} must require an exact numeric last-line match`);
      }
      if (rule.removal_scope !== 'audit_comparison_only') {
        fail(`${ruleId}.removal_scope must remain audit_comparison_only`);
      }
      if (rule.review_method !== 'manual_source_image_stratified') {
        fail(`${ruleId}.review_method must equal manual_source_image_stratified`);
      }
      if (rule.approval_status !== 'approved_not_activated') {
        fail(`${ruleId}.approval_status must remain approved_not_activated`);
      }
      if (requireBoolean(
        rule.eligible_for_audit_filter,
        `${ruleId}.eligible_for_audit_filter`,
      ) !== true) {
        fail(`${ruleId} must be explicitly eligible after image review`);
      }
      if (requireBoolean(rule.activated, `${ruleId}.activated`) !== false) {
        fail(`${ruleId} must remain unactivated`);
      }
      const examples = requireArray(rule.examples, `${ruleId}.examples`);
      const minimumExamples = rule.page_count === 2 ? 2 : 3;
      if (examples.length < minimumExamples) {
        fail(`${ruleId} requires at least ${minimumExamples} stratified image examples`);
      }
      const examplePages = new Set();
      let previousExamplePage = 0;
      for (let exampleIndex = 0; exampleIndex < examples.length; exampleIndex += 1) {
        const exampleLabel = `${ruleId}.examples[${exampleIndex}]`;
        const example = requireObject(examples[exampleIndex], exampleLabel);
        const physicalPage = requireInteger(
          example.physical_page,
          `${exampleLabel}.physical_page`,
          startPage,
        );
        if (physicalPage > endPage) fail(`${exampleLabel}.physical_page exceeds the rule range`);
        if (physicalPage <= previousExamplePage) fail(`${ruleId} example pages must be sorted`);
        previousExamplePage = physicalPage;
        if (examplePages.has(physicalPage)) fail(`${ruleId} has duplicate example pages`);
        examplePages.add(physicalPage);
        if (requireInteger(example.printed_page, `${exampleLabel}.printed_page`, 1)
          !== physicalPage + rule.physical_to_printed_offset) {
          fail(`${exampleLabel}.printed_page does not match the rule offset`);
        }
        requireString(
          example.rendered_image_sha256,
          `${exampleLabel}.rendered_image_sha256`,
          SHA256_PATTERN,
        );
      }
      if (!examplePages.has(startPage) || !examplePages.has(endPage)) {
        fail(`${ruleId} examples must include both range endpoints`);
      }
    }
  }
  return ledger;
}

async function validateWitnessBinding(ledger, witnessRoot) {
  const resolvedRoot = path.resolve(witnessRoot);
  for (const document of ledger.documents) {
    const visionRoot = path.join(resolvedRoot, document.document_id, 'vision');
    let directory;
    try {
      directory = await readPinnedDirectoryEntries(visionRoot, {
        label: `${document.document_id} Vision directory`,
        rootPath: resolvedRoot,
      });
    } catch (error) {
      fail(error.message);
    }
    const candidates = directory.entries.filter((entry) => PAGE_FILE_PATTERN.test(entry.name));
    for (const entry of candidates) {
      if (!entry.isFile()) fail(`${document.document_id}/vision/${entry.name} cannot be read safely`);
    }
    const entries = candidates.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    if (entries.length !== document.page_count) {
      fail(`${document.document_id} witness page count drifted`);
    }
    const pages = new Map();
    const snapshotEntries = [];
    for (const entry of entries) {
      const page = Number(entry.name.match(PAGE_FILE_PATTERN)[1]);
      const relativePath = `${document.document_id}/vision/${entry.name}`;
      let raw;
      try {
        raw = await readPinnedRegularFile(path.join(visionRoot, entry.name), {
          label: relativePath,
          rootPath: resolvedRoot,
          encoding: 'utf8',
        });
      } catch (error) {
        fail(error.message);
      }
      snapshotEntries.push(`${relativePath}\0${sha256(raw)}`);
      let sidecar;
      try {
        sidecar = JSON.parse(raw);
      } catch (error) {
        fail(`${relativePath} contains invalid JSON: ${error.message}`);
      }
      requireObject(sidecar, relativePath);
      if (sidecar.document_id !== document.document_id) {
        fail(`${relativePath}.document_id drifted`);
      }
      if (sidecar.physical_pdf_page !== page) fail(`${relativePath}.physical_pdf_page drifted`);
      if (sidecar.source_pdf_sha256 !== document.source_pdf_sha256) {
        fail(`${relativePath}.source_pdf_sha256 drifted`);
      }
      requireString(
        sidecar.rendered_image_sha256,
        `${relativePath}.rendered_image_sha256`,
        SHA256_PATTERN,
      );
      const lines = requireArray(sidecar.lines, `${relativePath}.lines`);
      pages.set(page, {
        rendered_image_sha256: sidecar.rendered_image_sha256,
        last_line: lines.length ? String(lines.at(-1).text || '').trim() : '',
      });
    }
    const snapshotSha = sha256(snapshotEntries.join('\n'));
    if (snapshotSha !== document.sidecar_snapshot_sha256) {
      fail(`${document.document_id} sidecar snapshot drifted`);
    }
    for (const rule of document.footer_rules) {
      for (let page = rule.start_page; page <= rule.end_page; page += 1) {
        const witness = pages.get(page);
        if (!witness) fail(`${rule.rule_id} is missing witness page ${page}`);
        const expectedPrintedPage = String(page + rule.physical_to_printed_offset);
        if (witness.last_line !== expectedPrintedPage) {
          fail(`${rule.rule_id} page ${page} no longer has exact footer ${expectedPrintedPage}`);
        }
      }
      for (const example of rule.examples) {
        const witness = pages.get(example.physical_page);
        if (witness.rendered_image_sha256 !== example.rendered_image_sha256) {
          fail(`${rule.rule_id} page ${example.physical_page} rendered image identity drifted`);
        }
        const imagePath = path.join(
          resolvedRoot,
          document.document_id,
          'images',
          `page-${String(example.physical_page).padStart(3, '0')}.png`,
        );
        let image;
        try {
          image = await readPinnedRegularFile(imagePath, {
            label: `${document.document_id} page ${example.physical_page} image`,
            rootPath: resolvedRoot,
          });
        } catch (error) {
          fail(error.message);
        }
        const imageSha = sha256(image);
        if (imageSha !== example.rendered_image_sha256) {
          fail(`${rule.rule_id} page ${example.physical_page} image bytes drifted`);
        }
      }
    }
    try {
      await verifyPinnedDirectoryReceipt(
        directory,
        `${document.document_id} Vision directory`,
      );
    } catch (error) {
      fail(error.message);
    }
  }
}

export async function validateOcrPageFurnitureApprovals(input, options = {}) {
  const ledger = validateStructure(input);
  if (options.witnessRoot) await validateWitnessBinding(ledger, options.witnessRoot);
  const footerRules = ledger.documents.reduce(
    (total, document) => total + document.footer_rules.length,
    0,
  );
  const approvedPages = ledger.documents.reduce(
    (total, document) => total
      + document.footer_rules.reduce((subtotal, rule) => subtotal + rule.page_count, 0),
    0,
  );
  return {
    schema_version: ledger.schema_version,
    activation_status: ledger.activation_status,
    documents: ledger.documents.length,
    footer_rules: footerRules,
    approved_footer_pages: approvedPages,
    header_rules: 0,
    witness_bound: Boolean(options.witnessRoot),
  };
}

export function parseOcrPageFurnitureApprovalArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--ledger') {
      if (options.ledgerPath) fail('duplicate argument --ledger');
      if (!value) fail('--ledger requires a value');
      options.ledgerPath = value;
      index += 1;
    } else if (argument === '--witness-root') {
      if (options.witnessRoot) fail('duplicate argument --witness-root');
      if (!value) fail('--witness-root requires a value');
      options.witnessRoot = value;
      index += 1;
    } else {
      fail(`unknown argument ${argument}`);
    }
  }
  if (!options.ledgerPath) fail('--ledger is required');
  return options;
}

async function main() {
  const options = parseOcrPageFurnitureApprovalArgs(process.argv.slice(2));
  const ledger = JSON.parse(await readPinnedRegularFile(options.ledgerPath, {
    label: 'approval ledger',
    encoding: 'utf8',
  }));
  const summary = await validateOcrPageFurnitureApprovals(ledger, {
    witnessRoot: options.witnessRoot,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
