#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [primaryRoot, witnessRoot, outputPath, startRaw, endRaw] = process.argv.slice(2);
if (!primaryRoot || !witnessRoot || !outputPath || !startRaw || !endRaw) {
  console.error('usage: node scripts/audit-ocr-witnesses.mjs <primary-pages-dir> <vision-dir> <output.json> <start> <end>');
  process.exit(64);
}

const start = Number(startRaw);
const end = Number(endRaw);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const pageKey = (page) => String(page).padStart(4, '0');

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
      const substitution = previous[column - 1] + (left.charCodeAt(column - 1) === rightChar ? 0 : 1);
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, substitution);
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

const pages = [];
for (let page = start; page <= end; page += 1) {
  const key = pageKey(page);
  const primaryPath = path.join(primaryRoot, key, 'content.md');
  const witnessJsonPath = path.join(witnessRoot, `page-${String(page).padStart(3, '0')}.json`);
  const primary = await readFile(primaryPath, 'utf8');
  const witnessRecord = JSON.parse(await readFile(witnessJsonPath, 'utf8'));
  const witness = witnessRecord.lines.map((line) => line.text).join('\n');
  const primaryText = normalized(primary);
  const witnessText = normalized(witness);
  const distance = editDistance(primaryText, witnessText);
  const agreement = 1 - distance / Math.max(1, primaryText.length, witnessText.length);
  const primaryNumbers = numbers(primary);
  const witnessNumbers = numbers(witness);
  const numericExact = JSON.stringify(primaryNumbers) === JSON.stringify(witnessNumbers);
  const titleExact = sameHeading(heading(primary), heading(witness));
  const criticalFields = Array.isArray(witnessRecord.critical_fields) ? witnessRecord.critical_fields : [];
  const criticalFieldsExact = criticalFields.length > 0 && criticalFields.every((field) => {
    const primaryValue = normalized(field.primary);
    const witnessValue = normalized(field.witness);
    return primaryValue.length > 0 && primaryValue === witnessValue;
  });
  const tableDetected = /<table\b|<tr\b|<td\b/i.test(primary);
  const confidences = witnessRecord.lines.map((line) => Number(line.confidence)).filter(Number.isFinite);
  const averageVisionConfidence = confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : 0;
  let gate = 'unresolved_fail_closed';
  if (!primaryText && !witnessText) gate = 'blank_page_visual_confirmation_required';
  else if (agreement >= .995 && numericExact && titleExact && criticalFieldsExact && !tableDetected && averageVisionConfidence >= .8) gate = 'automatic_witness_pass';
  else if (agreement >= .985 && titleExact) gate = 'manual_image_review_required';
  pages.push({
    page,
    primary_path: primaryPath,
    witness_path: witnessJsonPath,
    primary_sha256: sha256(primary),
    witness_sha256: sha256(witness),
    normalized_character_agreement: Number(agreement.toFixed(6)),
    edit_distance: distance,
    primary_character_count: primaryText.length,
    witness_character_count: witnessText.length,
    title_exact: titleExact,
    primary_heading: heading(primary),
    witness_heading: heading(witness),
    numeric_sequence_exact: numericExact,
    primary_numbers: primaryNumbers,
    witness_numbers: witnessNumbers,
    critical_fields_declared: criticalFields.length,
    critical_fields_exact: criticalFieldsExact,
    table_detected: tableDetected,
    average_vision_confidence: Number(averageVisionConfidence.toFixed(6)),
    low_confidence_line_count: confidences.filter((value) => value < .8).length,
    gate,
  });
}

const report = {
  schema_version: 1,
  primary_engine: 'PaddleOCR-VL / PP-Structure',
  independent_witness: 'Apple Vision VNRecognizeTextRequest accurate zh-Hans',
  policy: {
    automatic_witness_pass: 'character agreement >= 0.995, Vision mean confidence >= 0.80, title and numeric sequence exact, reviewer-declared critical fields exact, and no table',
    critical_fields: 'automatic release requires an independent sidecar declaration for every name, title, date, version and other high-risk token; absence is fail-closed',
    tables: 'table pages always require cell-by-cell image adjudication and cannot pass automatically',
    manual_image_review_required: 'character agreement >= 0.985 and title exact, with every conflict checked against the scan',
    unresolved_fail_closed: 'not eligible for quotation or AI retrieval',
    online_text: 'exact-document exact-edition text may adjudicate wording; a different edition may only confirm stable facts',
  },
  page_range: [start, end],
  summary: {
    pages: pages.length,
    automatic_witness_pass: pages.filter((item) => item.gate === 'automatic_witness_pass').length,
    manual_image_review_required: pages.filter((item) => item.gate === 'manual_image_review_required').length,
    blank_page_visual_confirmation_required: pages.filter((item) => item.gate === 'blank_page_visual_confirmation_required').length,
    unresolved_fail_closed: pages.filter((item) => item.gate === 'unresolved_fail_closed').length,
  },
  pages,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summary));
