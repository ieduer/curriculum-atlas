#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditProjectAssets } from './audit-project-assets.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_DOWNLOADS = '/Users/ylsuen/Downloads';
const DEFAULT_OUTPUT = 'data/downloads-asset-audit-receipt.json';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function validateDownloadsAuditReceipt(value) {
  if (value?.schema_version !== 1 || value?.contract !== 'curriculum_downloads_asset_audit_v1') {
    throw new Error('unsupported Downloads asset audit receipt');
  }
  if (value.ok !== true || value.downloads_ingested !== true || value.errors !== 0) {
    throw new Error('Downloads asset audit receipt is not fully passing');
  }
  if (!Number.isSafeInteger(value.pdf_files) || !Number.isSafeInteger(value.relevant_files)
    || !Number.isSafeInteger(value.unique_relevant_artifacts)) {
    throw new Error('Downloads asset audit receipt counts are invalid');
  }
  if (!Array.isArray(value.relevant_artifacts)
    || value.relevant_artifacts.some((artifact) => !SHA256_PATTERN.test(artifact.sha256)
      || !Number.isSafeInteger(artifact.size_bytes)
      || artifact.ingested !== true
      || typeof artifact.disposition !== 'string')) {
    throw new Error('Downloads asset audit receipt artifact identities are invalid');
  }
  const { receipt_sha256: declared, ...projection } = value;
  if (!SHA256_PATTERN.test(String(declared || '')) || sha256(stableStringify(projection)) !== declared) {
    throw new Error('Downloads asset audit receipt hash mismatch');
  }
  return value;
}

export async function buildDownloadsAuditReceipt({
  projectRoot = DEFAULT_ROOT,
  downloadsRoot = DEFAULT_DOWNLOADS,
  auditedAt = new Date().toISOString(),
} = {}) {
  const root = resolve(projectRoot);
  const audit = await auditProjectAssets({ projectRoot: root, downloadsRoot });
  if (!audit.ok || audit.checks.downloads_ingested !== true) {
    const failures = audit.errors.map((entry) => `${entry.area}:${entry.code}`).join(', ');
    throw new Error(`Downloads asset audit failed closed: ${failures || 'unknown failure'}`);
  }
  const relevantArtifacts = audit.downloads.relevant_artifacts.map((artifact) => ({
    sha256: artifact.sha256,
    size_bytes: artifact.size_bytes,
    pdf_magic: artifact.pdf_magic,
    disposition: artifact.disposition,
    ingested: artifact.ingested,
  })).sort((left, right) => left.sha256.localeCompare(right.sha256));
  const receipt = {
    schema_version: 1,
    contract: 'curriculum_downloads_asset_audit_v1',
    generated_by: 'scripts/build-downloads-asset-audit-receipt.mjs',
    audited_at: auditedAt,
    downloads_root_label: 'operator_downloads',
    ok: true,
    downloads_ingested: true,
    pdf_files: audit.downloads.pdf_files,
    relevant_files: audit.downloads.relevant_files,
    unique_relevant_artifacts: audit.downloads.unique_relevant_artifacts,
    relevant_artifacts: relevantArtifacts,
    project_source_pdf_files: audit.source_inventory.pdf_files,
    project_unique_source_artifacts: audit.source_inventory.unique_artifacts,
    project_unique_queue_pages: audit.queue.unique_pages,
    registry_sha256: sha256(await readFile(resolve(root, 'data/artifact-registry.json'))),
    errors: 0,
    warnings: audit.warnings.length,
  };
  return validateDownloadsAuditReceipt({
    ...receipt,
    receipt_sha256: sha256(stableStringify(receipt)),
  });
}

function parseArgs(argv) {
  const values = { projectRoot: DEFAULT_ROOT, downloadsRoot: DEFAULT_DOWNLOADS, output: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    if (key === '--project-root') values.projectRoot = value;
    else if (key === '--downloads') values.downloadsRoot = value;
    else if (key === '--output') values.output = value;
    else throw new Error(`unexpected argument: ${key}`);
    index += 1;
  }
  return values;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const receipt = await buildDownloadsAuditReceipt(options);
  const output = resolve(options.projectRoot, options.output);
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  process.stdout.write(`${output}\n${receipt.relevant_files} relevant Downloads PDFs, receipt ${receipt.receipt_sha256}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`build-downloads-asset-audit-receipt: ${error.message}\n`);
    process.exitCode = 1;
  });
}
