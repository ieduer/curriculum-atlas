import { createHash } from 'node:crypto';

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

export function witnessRecordValid(record, expected = {}) {
  if (!record || record.error || !Array.isArray(record.lines)) return false;
  if (!/^[a-f0-9]{64}$/i.test(String(record.source_pdf_sha256 || ''))) return false;
  if (!/^[a-f0-9]{64}$/i.test(String(record.rendered_image_sha256 || ''))) return false;
  if (!record.engine || record.citation_allowed !== false) return false;
  if (expected.file && record.file !== expected.file) return false;
  if (expected.documentId && record.document_id !== expected.documentId) return false;
  if (expected.page && Number(record.physical_pdf_page) !== Number(expected.page)) return false;
  if (expected.pdfSha && record.source_pdf_sha256 !== expected.pdfSha) return false;
  if (expected.imageSha && record.rendered_image_sha256 !== expected.imageSha) return false;
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

  if (healthCode !== 0) {
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
  const hardRunCodes = new Set(['MODEL_CHECKSUM_MISMATCH', 'MMPROJ_CHECKSUM_MISMATCH', 'LLAMA_REVISION_MISMATCH', 'RUNTIME_SHARED_MISSING']);
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
