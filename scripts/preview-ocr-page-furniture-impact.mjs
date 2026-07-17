#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateOcrPageFurnitureApprovals } from './validate-ocr-page-furniture-approvals.mjs';

function fail(message) {
  throw new Error(`OCR page furniture impact preview: ${message}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function textual(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^[#>*+\-]+/gm, '')
    .normalize('NFKC');
}

function normalized(value) {
  return textual(value).replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '').toLocaleLowerCase('zh-CN');
}

function numbers(value) {
  return textual(value).match(/\d+(?:[.,]\d+)*/g) || [];
}

function heading(value) {
  const lines = textual(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /[\p{Script=Han}A-Za-z]/u.test(line)) || '';
}

function editDistance(left, right) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  if (left.length > right.length) [left, right] = [right, left];
  let previous = new Uint32Array(left.length + 1);
  let current = new Uint32Array(left.length + 1);
  for (let index = 0; index <= left.length; index += 1) previous[index] = index;
  for (let row = 1; row <= right.length; row += 1) {
    current[0] = row;
    const rightChar = right.charCodeAt(row - 1);
    for (let column = 1; column <= left.length; column += 1) {
      const substitution = previous[column - 1]
        + (left.charCodeAt(column - 1) === rightChar ? 0 : 1);
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        substitution,
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[left.length];
}

function sameHeading(left, right) {
  const a = normalized(left);
  const b = normalized(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function metrics(primary, witness) {
  const primaryText = normalized(primary);
  const witnessText = normalized(witness);
  const distance = editDistance(primaryText, witnessText);
  const denominator = Math.max(1, primaryText.length, witnessText.length);
  const primaryNumbers = numbers(primary);
  const witnessNumbers = numbers(witness);
  return {
    normalized_character_agreement: Number((1 - distance / denominator).toFixed(6)),
    edit_distance: distance,
    primary_character_count: primaryText.length,
    witness_character_count: witnessText.length,
    numeric_sequence_exact: JSON.stringify(primaryNumbers) === JSON.stringify(witnessNumbers),
    primary_numbers: primaryNumbers,
    witness_numbers: witnessNumbers,
    title_exact: sameHeading(heading(primary), heading(witness)),
    primary_heading: heading(primary),
    witness_heading: heading(witness),
  };
}

export function stripExactTrailingPrintedPage(value, printedPage) {
  const lines = String(value || '').split(/\r?\n/);
  let lastTextualIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (textual(lines[index]).trim()) {
      lastTextualIndex = index;
      break;
    }
  }
  if (lastTextualIndex < 0 || textual(lines[lastTextualIndex]).trim() !== String(printedPage)) {
    return { value: String(value || ''), removed: false };
  }
  lines.splice(lastTextualIndex, 1);
  return { value: lines.join('\n'), removed: true };
}

function parseArgs(argv) {
  const allowed = new Set([
    '--ledger',
    '--document',
    '--primary-root',
    '--witness-root',
    '--output',
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key)) fail(`unknown argument ${key}`);
    if (!value) fail(`${key} requires a value`);
    const property = key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (options[property]) fail(`duplicate argument ${key}`);
    options[property] = value;
  }
  for (const required of ['ledger', 'document', 'primaryRoot', 'witnessRoot', 'output']) {
    if (!options[required]) fail(`--${required.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  return options;
}

function pathContains(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

export async function buildOcrPageFurnitureImpactPreview(options) {
  const ledger = JSON.parse(await readFile(options.ledgerPath, 'utf8'));
  await validateOcrPageFurnitureApprovals(ledger, { witnessRoot: options.witnessRoot });
  const document = ledger.documents.find((item) => item.document_id === options.documentId);
  if (!document) fail(`approval ledger does not contain document ${options.documentId}`);
  const pages = [];
  for (const rule of document.footer_rules) {
    for (let page = rule.start_page; page <= rule.end_page; page += 1) {
      const key = String(page).padStart(4, '0');
      const witnessKey = String(page).padStart(3, '0');
      const primaryPath = path.join(options.primaryRoot, key, 'content.md');
      const witnessPath = path.join(
        options.witnessRoot,
        document.document_id,
        'vision',
        `page-${witnessKey}.json`,
      );
      const [primary, witnessRecord] = await Promise.all([
        readFile(primaryPath, 'utf8'),
        readFile(witnessPath, 'utf8').then(JSON.parse),
      ]);
      const witness = witnessRecord.lines.map((line) => line.text).join('\n');
      const printedPage = page + rule.physical_to_printed_offset;
      const filteredPrimary = stripExactTrailingPrintedPage(primary, printedPage);
      const filteredWitness = stripExactTrailingPrintedPage(witness, printedPage);
      if (!filteredWitness.removed) {
        fail(`${rule.rule_id} page ${page} lost its approved exact witness footer`);
      }
      const before = metrics(primary, witness);
      const after = metrics(filteredPrimary.value, filteredWitness.value);
      pages.push({
        page,
        printed_page: printedPage,
        rule_id: rule.rule_id,
        raw_primary_sha256: sha256(primary),
        raw_witness_text_sha256: sha256(witness),
        comparison_primary_sha256: sha256(filteredPrimary.value),
        comparison_witness_text_sha256: sha256(filteredWitness.value),
        footer_removed: {
          primary: filteredPrimary.removed,
          witness: filteredWitness.removed,
        },
        before,
        after,
      });
    }
  }
  const mean = (values) => Number(
    (values.reduce((total, value) => total + value, 0) / Math.max(1, values.length)).toFixed(6),
  );
  return {
    schema_version: 1,
    artifact_profile: 'ocr-page-furniture-impact-preview-v1',
    document_id: document.document_id,
    source_pdf_sha256: document.source_pdf_sha256,
    sidecar_snapshot_sha256: document.sidecar_snapshot_sha256,
    approval_activation_status: ledger.activation_status,
    policy: {
      mode: 'read_only_preview',
      raw_witness_mutation: 'none',
      audit_mutation: 'none',
      gate_mutation: 'none',
      publication_mutation: 'none',
      comparison_rule: 'remove only an approved exact standalone trailing printed-page number',
    },
    summary: {
      approved_pages: pages.length,
      primary_footers_removed: pages.filter((page) => page.footer_removed.primary).length,
      witness_footers_removed: pages.filter((page) => page.footer_removed.witness).length,
      numeric_exact_before: pages.filter((page) => page.before.numeric_sequence_exact).length,
      numeric_exact_after: pages.filter((page) => page.after.numeric_sequence_exact).length,
      title_exact_before: pages.filter((page) => page.before.title_exact).length,
      title_exact_after: pages.filter((page) => page.after.title_exact).length,
      mean_character_agreement_before: mean(
        pages.map((page) => page.before.normalized_character_agreement),
      ),
      mean_character_agreement_after: mean(
        pages.map((page) => page.after.normalized_character_agreement),
      ),
      character_agreement_improved_pages: pages.filter(
        (page) => page.after.normalized_character_agreement
          > page.before.normalized_character_agreement,
      ).length,
    },
    pages,
  };
}

export async function writeOcrPageFurnitureImpactPreview(options) {
  if (pathContains(options.witnessRoot, options.outputPath)
    || pathContains(options.primaryRoot, options.outputPath)) {
    fail('output must be outside the primary and witness roots');
  }
  const report = await buildOcrPageFurnitureImpactPreview(options);
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await writeOcrPageFurnitureImpactPreview({
    ledgerPath: path.resolve(args.ledger),
    documentId: args.document,
    primaryRoot: path.resolve(args.primaryRoot),
    witnessRoot: path.resolve(args.witnessRoot),
    outputPath: path.resolve(args.output),
  });
  process.stdout.write(`${JSON.stringify(report.summary)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
