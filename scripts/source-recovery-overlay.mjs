import { readFile } from 'node:fs/promises';

const proofs = JSON.parse(await readFile(
  new URL('../data/source-recovery-proofs.json', import.meta.url),
  'utf8',
));

const recoveryByDocument = new Map(
  proofs.corrupt_payload_recoveries.map((entry) => [entry.document_id, entry]),
);
const nativeByDocument = new Map(
  proofs.native_attachments.map((entry) => [entry.document_id, entry]),
);
const scanByDocument = new Map(
  proofs.official_same_work_scan_variants.map((entry) => [entry[0], entry]),
);
const canonicalScanIds = new Set(
  proofs.same_work_scan_variant_context.canonical_document_ids,
);

function officialScanSource(tuple) {
  const [documentId, title, filename, checksumSha256, bytes, pageCount] = tuple;
  const context = proofs.same_work_scan_variant_context;
  return {
    document_id: documentId,
    title,
    source_tier: 'primary_official',
    source_page_url: context.source_page_url,
    source_url: `${context.source_url_prefix}${filename}`,
    local_cache_path: `${context.path_prefix}${filename}`,
    checksum_sha256: checksumSha256,
    size_bytes: bytes,
    page_count: pageCount,
    relationship: 'same_work_different_scan',
    queue_eligible: false,
    publication_eligible: false,
    note: '教育部当前附件与课程教材研究所扫描对应同一作品/版本，但字节不同；仅作独立版本见证，不替换已在途 OCR。',
  };
}

function nativeFileFormat(path) {
  return path.endsWith('.docx') ? 'docx_local' : 'doc_local';
}

function recoveredPdfRecord(record, recovery) {
  const artifact = recovery.recovered_artifact;
  return {
    ...record,
    source_tier: 'primary_official',
    access_status: 'verified_online',
    source_page_url: artifact.source_page_url,
    source_url: artifact.source_url,
    file_format: 'pdf_local',
    checksum_sha256: artifact.sha256,
    page_count: artifact.page_count,
    local_cache_path: artifact.path,
    text_quality_status: 'official_native_text',
    citation_allowed: true,
    recovery_proof_id: `${proofs.policy}:${record.id}`,
    note: '教育部 2017 原始发布 RAR 成员恢复；课程教材研究所损坏下载保留在 quarantine。官方 PDF 为原生文本，只有精确页段仍可引用。',
  };
}

function canonicalScanRecord(record, tuple) {
  const scan = officialScanSource(tuple);
  const legacyRecovery = recoveryByDocument.get(record.id)?.recovered_artifact;
  return {
    ...record,
    source_tier: 'primary_official',
    access_status: 'verified_online',
    source_page_url: scan.source_page_url,
    source_url: scan.source_url,
    file_format: 'pdf_local',
    checksum_sha256: scan.checksum_sha256,
    page_count: scan.page_count,
    local_cache_path: scan.local_cache_path,
    text_quality_status: 'ocr_required',
    citation_allowed: false,
    scan_variants: legacyRecovery ? [{
      source_tier: 'primary_official',
      source_page_url: legacyRecovery.source_page_url,
      source_url: legacyRecovery.source_url,
      local_cache_path: legacyRecovery.path,
      checksum_sha256: legacyRecovery.sha256,
      size_bytes: legacyRecovery.bytes,
      page_count: legacyRecovery.page_count,
      relationship: 'same_work_older_official_attachment',
      queue_eligible: false,
      publication_eligible: false,
      note: '旧教育部附件与损坏 ICTR 端点的 8192 字节后尾部完全一致；保留作端点身份见证，不作为质量优先 OCR 输入。',
    }] : [],
    recovery_proof_id: `${proofs.policy}:${record.id}`,
    note: '教育部当前同作品扫描质量优于旧附件，作为 OCR 主输入；损坏 ICTR 载荷和旧官方附件均保留以证明来源身份。',
  };
}

function nativeAttachmentRecord(record, attachment) {
  const canonical = attachment.canonical;
  const isSpecialPlan = [
    'ictr-cfb2a39a2016',
    'ictr-8f02447b66ca',
    'ictr-f74769862cc6',
    'ictr-07a04c6c51fd',
  ].includes(record.id);
  return {
    ...record,
    document_type: isSpecialPlan ? '课程方案' : record.document_type,
    version_label: record.id === 'ictr-07a04c6c51fd'
      ? '2001年实验方案'
      : isSpecialPlan ? '2007年实验方案' : record.version_label,
    source_tier: canonical.provider === '中华人民共和国教育部'
      ? 'primary_official'
      : 'primary_official_institute',
    access_status: 'verified_online',
    source_page_url: canonical.source_page_url,
    source_url: canonical.source_url,
    file_format: nativeFileFormat(canonical.path),
    checksum_sha256: canonical.sha256,
    page_count: null,
    local_cache_path: canonical.path,
    native_text_cache_path: canonical.text_path,
    native_text_sha256: canonical.text_sha256,
    text_quality_status: attachment.text_status,
    citation_allowed: false,
    attachment_variants: attachment.variants,
    unresolved_source_conflicts: attachment.conflicts,
    recovery_proof_id: `${proofs.policy}:${record.id}`,
    note: attachment.text_status === 'native_text_version_conflict'
      ? '原始 DOC 已恢复；教育部当前附件与课程教材研究所附件有一字修订冲突。Office 页码不稳定，精确版本/段落锚点完成前不开放正文引文。'
      : '原始 Office 附件及文本已恢复；表格结构和稳定段落锚点仍在审校，当前可检索元数据但不开放正文引文。',
  };
}

export function applySourceRecoveryOverlay(documents) {
  return documents.map((record) => {
    const recovery = recoveryByDocument.get(record.id);
    if (recovery?.canonical_use === 'official_native_text') {
      return recoveredPdfRecord(record, recovery);
    }
    const scanTuple = scanByDocument.get(record.id);
    if (scanTuple && canonicalScanIds.has(record.id)) {
      return canonicalScanRecord(record, scanTuple);
    }
    const attachment = nativeByDocument.get(record.id);
    if (attachment) return nativeAttachmentRecord(record, attachment);
    if (scanTuple) {
      return {
        ...record,
        scan_variants: [
          ...(record.scan_variants || []),
          officialScanSource(scanTuple),
        ],
      };
    }
    return record;
  });
}
