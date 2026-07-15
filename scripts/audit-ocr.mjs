import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [documentId, primaryArg, secondaryArg, visionAuditArg, outputArg] = process.argv.slice(2);
if (!documentId || !primaryArg || !secondaryArg || !visionAuditArg || !outputArg) {
  console.error('usage: node scripts/audit-ocr.mjs <document-id> <vision.txt> <tesseract.txt> <vision-audit.json> <output.json>');
  process.exit(64);
}

const [primary, secondary, visionAudit] = await Promise.all([
  readFile(resolve(primaryArg), 'utf8'),
  readFile(resolve(secondaryArg), 'utf8'),
  readFile(resolve(visionAuditArg), 'utf8').then(JSON.parse),
]);
const primaryPages = primary.split('\f');
const secondaryPages = secondary.split('\f');
const metrics = new Map(visionAudit.metrics.map((metric) => [metric.page, metric]));
const pageCount = Math.max(primaryPages.length, secondaryPages.length, visionAudit.pages || 0);

function normalized(value) {
  return String(value || '').normalize('NFKC').replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '');
}

function grams(value) {
  const result = new Map();
  if (value.length < 3) return result;
  for (let index = 0; index <= value.length - 3; index += 1) {
    const gram = value.slice(index, index + 3);
    result.set(gram, (result.get(gram) || 0) + 1);
  }
  return result;
}

function dice(left, right) {
  if (!left && !right) return 1;
  const leftGrams = grams(left);
  const rightGrams = grams(right);
  let overlap = 0;
  for (const [gram, count] of leftGrams) overlap += Math.min(count, rightGrams.get(gram) || 0);
  const denominator = [...leftGrams.values()].reduce((sum, value) => sum + value, 0)
    + [...rightGrams.values()].reduce((sum, value) => sum + value, 0);
  return denominator ? (2 * overlap) / denominator : Number(left === right);
}

function years(value) {
  return [...new Set(String(value || '').match(/(?:18|19|20)\d{2}/g) || [])].sort();
}

const pages = [];
for (let index = 0; index < pageCount; index += 1) {
  const page = index + 1;
  const primaryText = normalized(primaryPages[index]);
  const secondaryText = normalized(secondaryPages[index]);
  const similarity = dice(primaryText, secondaryText);
  const primaryYears = years(primaryPages[index]);
  const secondaryYears = years(secondaryPages[index]);
  const yearMismatch = primaryYears.join(',') !== secondaryYears.join(',');
  const metric = metrics.get(page) || {};
  const lowRatio = metric.lines ? metric.low_confidence_lines / metric.lines : 0;
  const blank = Math.max(primaryText.length, secondaryText.length) < 10;
  const status = blank ? 'blank_or_image_only'
    : similarity >= 0.92 && !yearMismatch && (metric.mean_confidence || 0) >= 0.85 && lowRatio <= 0.15
      ? 'machine_pass'
      : 'manual_review_required';
  pages.push({
    page,
    status,
    citation_eligible: status === 'machine_pass',
    primary_characters: primaryText.length,
    secondary_characters: secondaryText.length,
    cross_engine_dice: Number(similarity.toFixed(4)),
    vision_mean_confidence: metric.mean_confidence ?? null,
    vision_low_confidence_ratio: Number(lowRatio.toFixed(4)),
    primary_years: primaryYears,
    secondary_years: secondaryYears,
    year_mismatch: yearMismatch,
  });
}

const counts = pages.reduce((result, page) => {
  result[page.status] = (result[page.status] || 0) + 1;
  return result;
}, {});
await writeFile(resolve(outputArg), `${JSON.stringify({
  document_id: documentId,
  policy: 'machine_pass requires cross-engine trigram Dice >= 0.92, exact year agreement, Vision mean confidence >= 0.85, and <= 15% low-confidence lines; manual sampling remains mandatory before citation.',
  generated_at: new Date().toISOString(),
  page_count: pageCount,
  counts,
  pages,
}, null, 2)}\n`);
console.log(`${documentId}: ${JSON.stringify(counts)}`);
