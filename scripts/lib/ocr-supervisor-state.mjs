import { createHash } from 'node:crypto';

const defaultVisionLanguages = Object.freeze(['zh-Hans', 'en-US']);
const russianVisionLanguages = Object.freeze(['ru-RU', 'zh-Hans', 'en-US']);

function arraysEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function validSha256(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ''));
}

function profilePassesValid(record, profile) {
  if (!Array.isArray(record.witness_passes)
    || record.witness_passes.length !== profile.passes.length) return false;
  const stem = `page-${String(record.physical_pdf_page).padStart(3, '0')}`;
  for (const expectedPass of profile.passes) {
    const pass = record.witness_passes.find((candidate) => candidate?.pass_id === expectedPass.pass_id);
    if (!pass
      || pass.role !== expectedPass.role
      || !arraysEqual(pass.languages, expectedPass.languages)
      || !Array.isArray(pass.lines)
      || !validSha256(pass.raw_sidecar_sha256)
      || !validSha256(pass.raw_text_sha256)
      || pass.raw_sidecar_file !== `vision-passes/${expectedPass.pass_id}/${stem}.json`
      || pass.raw_text_file !== `vision-passes/${expectedPass.pass_id}/${stem}.txt`
      || !Number.isInteger(pass.attempt_count)
      || pass.attempt_count < 1
      || typeof pass.recovered_after_retry !== 'boolean') return false;
  }
  const canonical = record.witness_passes.find((pass) => pass.pass_id === profile.canonical_pass_id);
  return Boolean(canonical && JSON.stringify(record.lines) === JSON.stringify(canonical.lines));
}

function engineProvenanceValid(provenance) {
  const launcher = provenance?.launcher;
  const launcherValid = launcher == null || Boolean(
    launcher.schema_version === 1
    && launcher.path === 'scripts/vision-ocr-launcher.mjs'
    && validSha256(launcher.sha256)
    && typeof launcher.node_binary === 'string'
    && launcher.node_binary.startsWith('/')
    && launcher.child_binary === '/usr/bin/swift'
    && Number(launcher.buffer_limit_bytes) === 8 * 1024 * 1024
  );
  return Boolean(provenance
    && provenance.schema_version === 1
    && provenance.framework === 'Apple Vision'
    && provenance.request_api === 'VNRecognizeTextRequest'
    && provenance.framework_distribution === 'macOS bundled'
    && provenance.execution_binary === '/usr/bin/swift'
    && typeof provenance.swift_version === 'string'
    && provenance.swift_version
    && provenance.script_path === 'scripts/vision-ocr-batch.swift'
    && validSha256(provenance.script_sha256)
    && provenance.renderer?.name === 'MuPDF mutool 1.28.0'
    && provenance.renderer?.binary === '/opt/homebrew/bin/mutool'
    && validSha256(provenance.renderer?.sha256)
    && provenance.os?.product_name === 'macOS'
    && typeof provenance.os?.product_version === 'string'
    && provenance.os.product_version
    && typeof provenance.os?.build_version === 'string'
    && provenance.os.build_version
    && provenance.os?.platform === 'darwin'
    && typeof provenance.os?.architecture === 'string'
    && provenance.os.architecture
    && typeof provenance.os?.kernel_release === 'string'
    && provenance.os.kernel_release
    && launcherValid);
}

function legacyDefaultWitnessRecordValid(record) {
  const configuration = record.engine_configuration;
  return (record.schema_version === 1 || record.schema_version === 2)
    && record.engine === 'Apple Vision VNRecognizeTextRequest accurate zh-Hans+en-US'
    && configuration?.recognition_level === 'accurate'
    && arraysEqual(configuration.languages, defaultVisionLanguages)
    && configuration.language_correction === true
    && Number(configuration.minimum_text_height) === 0.008
    && record.witness_profile == null
    && record.witness_profile_sha256 == null
    && record.witness_passes == null
    && record.line_source_pass_id == null
    && record.engine_provenance == null;
}

export function visionWitnessPlan(document = {}) {
  const russian = String(document.subject || '').trim() === '俄语';
  return russian
    ? {
        schema_version: 1,
        profile_id: 'apple-vision-russian-dual-v1',
        document_language: 'ru',
        canonical_pass_id: 'zh-primary',
        passes: [
          { pass_id: 'zh-primary', role: 'canonical', languages: [...defaultVisionLanguages] },
          { pass_id: 'ru-supplement', role: 'supplemental', languages: [...russianVisionLanguages] },
        ],
      }
    : {
        schema_version: 1,
        profile_id: 'apple-vision-default-v1',
        document_language: 'default',
        canonical_pass_id: 'zh-primary',
        passes: [
          { pass_id: 'zh-primary', role: 'canonical', languages: [...defaultVisionLanguages] },
        ],
      };
}

export function visionWitnessProfileSha(profile) {
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex');
}

export function pageRetryKey(documentId, page, stage) {
  return `${documentId}:${Number(page)}:${stage}`;
}

export function retriesForPage(records, documentId, page) {
  const prefix = `${documentId}:${Number(page)}:`;
  return Object.entries(records || {}).filter(([key]) => key.startsWith(prefix)).map(([, value]) => value);
}

export function retryBlocksPage(records, documentId, page, now = Date.now(), override = false) {
  if (override) return false;
  return retriesForPage(records, documentId, page).some((record) => record.quarantined
    || (record.next_retry_at && Date.parse(record.next_retry_at) > now));
}

export function selectPendingPages({
  pageCount,
  completedPages = [],
  failedPages = {},
  pageRetries = {},
  documentId,
  limit,
  includeFailed = false,
  now = Date.now(),
}) {
  const completed = new Set(completedPages.map(Number));
  const selected = [];
  for (let page = 1; page <= pageCount && selected.length < limit; page += 1) {
    if (completed.has(page)) continue;
    if (retryBlocksPage(pageRetries, documentId, page, now, includeFailed)) continue;
    selected.push(page);
  }
  return selected;
}

export function nextPageRetry(previous, error, { now = Date.now(), maxAttempts = 5 } = {}) {
  const attempts = Number(previous?.attempts || 0) + 1;
  const delaysMinutes = [10, 30, 120, 360];
  const quarantined = attempts >= maxAttempts;
  return {
    attempts,
    stage: error.stage,
    error_code: error.code || 'PAGE_PROCESSING_ERROR',
    last_error: `${error.name || 'Error'}: ${error.message || error}`.slice(0, 600),
    first_failed_at: previous?.first_failed_at || new Date(now).toISOString(),
    last_failed_at: new Date(now).toISOString(),
    quarantined,
    next_retry_at: quarantined ? null : new Date(now + delaysMinutes[Math.min(attempts - 1, delaysMinutes.length - 1)] * 60000).toISOString(),
  };
}

export function paddleRuntimeFailure(error, { now = Date.now(), retryDelayMs = 5 * 60_000 } = {}) {
  const causeCode = error?.code ?? error?.signal ?? 'PADDLE_PROCESS_EXIT';
  return {
    code: 'PADDLE_RUNTIME_UNAVAILABLE',
    scope: 'runtime',
    cause_code: String(causeCode),
    retry_at: new Date(now + retryDelayMs).toISOString(),
    message: String(error?.message || 'Paddle OCR process did not complete').slice(0, 600),
  };
}

export function paddleLogIndicatesRuntimeFailure(value) {
  const text = String(value || '');
  return [
    /library load denied by system policy/i,
    /ImportError:\s*dlopen\(/i,
    /NameError:\s*name ['"]libpaddle['"] is not defined/i,
    /Too many open files/i,
    /UNIX error 24/i,
    /\b(?:EMFILE|ENFILE)\b/,
  ].some((pattern) => pattern.test(text));
}

export function witnessRecordValid(record, expected = {}) {
  if (!record || record.error || !Array.isArray(record.lines)) return false;
  if (!validSha256(record.source_pdf_sha256)) return false;
  if (!validSha256(record.rendered_image_sha256)) return false;
  if (!record.engine || record.citation_allowed !== false) return false;
  if (expected.file && record.file !== expected.file) return false;
  if (expected.documentId && record.document_id !== expected.documentId) return false;
  if (expected.page && Number(record.physical_pdf_page) !== Number(expected.page)) return false;
  if (expected.pdfSha && record.source_pdf_sha256 !== expected.pdfSha) return false;
  if (expected.imageSha && record.rendered_image_sha256 !== expected.imageSha) return false;
  if (expected.witnessProfile) {
    const profile = expected.witnessProfile;
    const profileSha = expected.witnessProfileSha || visionWitnessProfileSha(profile);
    const containsSignedProfileFields = record.witness_profile != null
      || record.witness_profile_sha256 != null
      || record.witness_passes != null
      || record.line_source_pass_id != null
      || record.engine_provenance != null;
    if (!containsSignedProfileFields) {
      return expected.allowLegacyDefault === true
        && profile.profile_id === 'apple-vision-default-v1'
        && legacyDefaultWitnessRecordValid(record);
    }
    const canonicalPass = profile.passes.find((pass) => pass.pass_id === profile.canonical_pass_id);
    if (record.schema_version !== 3
      || !canonicalPass
      || record.witness_profile == null
      || record.engine !== 'Apple Vision VNRecognizeTextRequest accurate language-profile-v1'
      || record.witness_profile_sha256 !== profileSha
      || visionWitnessProfileSha(record.witness_profile) !== profileSha
      || record.line_source_pass_id !== profile.canonical_pass_id
      || record.engine_configuration?.recognition_level !== 'accurate'
      || !arraysEqual(record.engine_configuration?.languages, canonicalPass.languages)
      || record.engine_configuration?.language_correction !== true
      || Number(record.engine_configuration?.minimum_text_height) !== 0.008
      || Number(record.engine_configuration?.render_dpi) !== 240
      || record.engine_configuration?.renderer !== 'MuPDF mutool 1.28.0'
      || JSON.stringify(record.engine_configuration?.language_passes) !== JSON.stringify(profile.passes)
      || !profilePassesValid(record, profile)
      || !engineProvenanceValid(record.engine_provenance)) return false;
  }
  return true;
}

export function missingCompletedWitnessPages(completedPages, validWitnessPages) {
  const valid = new Set(validWitnessPages.map(Number));
  return completedPages.map(Number).filter((page) => !valid.has(page));
}

export function ocrExecutionPolicy(mode) {
  const auditBackfillOnly = mode === 'audit_backfill';
  return {
    renderVision: !auditBackfillOnly,
    runPrimaryOcr: !auditBackfillOnly,
  };
}

export function continuousDrainDecision(status) {
  const queue = status?.queue || {};
  const evidence = status?.evidence || {};
  const healthCode = Number(status?.health?.exit_code);
  const pendingPages = Number(queue.pending_pages);
  const completedPages = Number(queue.completed_pages);
  const witnessPages = Number(evidence.witness_pages);
  const auditedPages = Number(evidence.audited_pages);
  const healthReasons = Array.isArray(status?.health?.reasons) ? status.health.reasons : [];
  const resumablePageQuarantine = healthCode === 2
    && pendingPages > 0
    && status?.scheduler_state === 'ready'
    && healthReasons.length > 0
    && healthReasons.every((reason) => reason === 'PAGE_QUARANTINED');

  if (healthCode !== 0 && !resumablePageQuarantine) {
    return {
      action: 'stop',
      code: 'DRAIN_HEALTH_STOP',
      exitCode: Number.isInteger(healthCode) && healthCode > 0 ? healthCode : 2,
      reason: `health=${status?.health?.exit_code}`,
    };
  }

  if (pendingPages === 0) {
    const complete = status?.scheduler_state === 'queue_complete'
      && Number(queue.failed_pages) === 0
      && Number(evidence.witness_error_sidecars) === 0
      && Number(evidence.witness_missing_for_completed) === 0
      && Number(evidence.stale_audit_pages) === 0
      && witnessPages === completedPages
      && auditedPages === completedPages;
    return complete
      ? { action: 'complete' }
      : {
          action: 'stop',
          code: 'DRAIN_INCOMPLETE_EVIDENCE',
          exitCode: 10,
          reason: `queue_complete_without_evidence_parity completed=${completedPages} witness=${witnessPages} audited=${auditedPages}`,
        };
  }

  if (status?.disk?.warning) {
    return {
      action: 'stop',
      code: 'DRAIN_DISK_WARNING',
      exitCode: 2,
      reason: `disk_free_gib=${status?.disk?.free_gib}`,
    };
  }

  if (status?.scheduler_state !== 'ready') {
    return {
      action: 'stop',
      code: 'DRAIN_SCHEDULER_STOP',
      exitCode: 2,
      reason: `scheduler=${status?.scheduler_state}`,
    };
  }

  return { action: 'continue' };
}

export function incidentId({ scope, documentId = '', pages = [], stage = '', code = '' }) {
  return createHash('sha256').update(JSON.stringify([scope, documentId, [...pages].map(Number).sort((a, b) => a - b), stage, code])).digest('hex').slice(0, 20);
}

export function classifyHealth({ lockActive, stalled, diskHardStop, witnessErrors, currentRun, documentRetries = {}, pageRetries = {}, hasEligibleWork = false }) {
  const quarantinedDocuments = Object.entries(documentRetries).filter(([, value]) => value?.quarantined).map(([key]) => key);
  const quarantinedPages = Object.entries(pageRetries).filter(([, value]) => value?.quarantined).map(([key]) => key);
  const retryTimes = [...Object.values(documentRetries), ...Object.values(pageRetries)]
    .map((record) => record?.next_retry_at).filter(Boolean).sort();
  const reasons = [];
  const hardRunCodes = new Set(['MODEL_CHECKSUM_MISMATCH', 'MMPROJ_CHECKSUM_MISMATCH', 'RENDERER_CHECKSUM_MISMATCH', 'LLAMA_REVISION_MISMATCH', 'RUNTIME_SHARED_MISSING']);
  const hardRunFailure = currentRun?.status === 'failed' && hardRunCodes.has(currentRun?.error_code);
  if (diskHardStop) reasons.push('DISK_HARD_STOP');
  if (hardRunFailure) reasons.push(currentRun.error_code);
  if (stalled) reasons.push('LOCK_STALLED');
  if (quarantinedDocuments.length) reasons.push('DOCUMENT_QUARANTINED');
  if (quarantinedPages.length) reasons.push('PAGE_QUARANTINED');
  if (witnessErrors > 0) reasons.push('VISION_SIDECAR_ERROR');
  if (currentRun?.status === 'failed' || currentRun?.status === 'partial_failed') reasons.push('LATEST_RUN_FAILED');
  let overall = 'healthy';
  let exitCode = 0;
  const localQuarantine = quarantinedDocuments.length || quarantinedPages.length;
  if (diskHardStop || hardRunFailure) { overall = 'blocked'; exitCode = 12; }
  else if (stalled) { overall = 'stalled'; exitCode = 11; }
  else if (lockActive) { overall = 'active'; exitCode = 75; }
  else if (localQuarantine && !hasEligibleWork) { overall = 'blocked'; exitCode = 12; }
  else if (witnessErrors > 0 || currentRun?.status === 'failed' || currentRun?.status === 'partial_failed') { overall = 'failed'; exitCode = 10; }
  else if (retryTimes.length || localQuarantine) { overall = 'degraded'; exitCode = 2; }
  return {
    overall,
    exit_code: exitCode,
    reasons: [...new Set(reasons)],
    quarantined_documents: quarantinedDocuments,
    quarantined_pages: quarantinedPages,
    earliest_retry_at: retryTimes[0] || null,
  };
}
