import { readFile, writeFile } from 'node:fs/promises';

const projectRoot = new URL('../', import.meta.url);
const [standard, sampleFile] = await Promise.all([
  readFile(new URL('data/online-verification-standard.json', projectRoot), 'utf8').then(JSON.parse),
  readFile(new URL('data/online-verification-samples.json', projectRoot), 'utf8').then(JSON.parse),
]);

const results = [];
for (const sample of sampleFile.samples) {
  const errors = [];
  for (const field of ['id', 'document_id', 'physical_pdf_page', 'entity_type', 'entity_label', 'edition_match_status', 'verification_status', 'resolution', 'reviewed_by']) {
    if (sample[field] === null || sample[field] === undefined || sample[field] === '') errors.push(`missing_${field}`);
  }
  if (!standard.edition_match_statuses.includes(sample.edition_match_status)) errors.push('invalid_edition_match_status');
  if (!standard.verification_statuses.includes(sample.verification_status)) errors.push('invalid_verification_status');
  if (!/^[a-f0-9]{64}$/.test(sample.source_image_sha256 || '')) errors.push('invalid_source_image_sha256');
  if (!/^[a-f0-9]{64}$/.test(sample.primary_ocr_sha256 || '')) errors.push('invalid_primary_ocr_sha256');
  const supports = sample.ocr_witnesses?.filter((item) => item.assessment.startsWith('supports')).length || 0;
  if (supports < 2) errors.push('fewer_than_two_supporting_ocr_witnesses');
  if (!Array.isArray(sample.online_evidence) || sample.online_evidence.length < 2) errors.push('insufficient_online_evidence');
  for (const evidence of sample.online_evidence || []) {
    try {
      const url = new URL(evidence.url);
      if (url.protocol !== 'https:') errors.push('non_https_evidence');
    } catch {
      errors.push('invalid_evidence_url');
    }
    if (!standard.edition_match_statuses.includes(evidence.version_match)) errors.push('invalid_evidence_version_match');
    for (const field of ['role', 'publisher', 'source_type', 'fact']) {
      if (!evidence[field]) errors.push(`evidence_missing_${field}`);
    }
  }
  if (sample.citation_allowed) {
    if (!['verified_exact', 'verified_stable_fact_only'].includes(sample.verification_status)) errors.push('citation_status_not_verified');
    if (!(sample.online_evidence || []).some((item) => item.version_match === 'exact_document_exact_edition')) errors.push('citation_missing_exact_document_identity');
    if (sample.uncertainty_note) errors.push('citation_has_uncertainty_note');
  } else if (sample.verification_status === 'human_judgment_with_warning' && !sample.uncertainty_note) {
    errors.push('warning_status_missing_note');
  }
  results.push({ id: sample.id, valid: errors.length === 0, errors: [...new Set(errors)] });
}

const report = {
  generated_at: new Date().toISOString(),
  policy: standard.name,
  valid: results.every((item) => item.valid),
  results,
};
await writeFile(new URL('data/online-verification-validation.json', projectRoot), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (!report.valid) process.exitCode = 1;
