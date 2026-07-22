#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLASSIFICATION,
  HYDRATION_RECEIPT_CONTRACT,
  canonicalJsonBuffer,
  readJsonFile,
  readPrivateFile,
  validateCorpusArtifactDescriptor,
  verifyHydratedCorpus,
} from './lib/private-corpus-bundle.mjs';

const DEFAULT_DESCRIPTOR = 'data/corpus-artifact.json';

function parseArgs(argv) {
  const args = new Map();
  const supported = new Set(['--root', '--descriptor']);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!supported.has(key)) throw new Error(`unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    args.set(key.slice(2), value);
    index += 1;
  }
  return args;
}

function validateHydrationReceipt(receipt, descriptor) {
  const expectedKeys = [
    'bundle_id',
    'bundle_manifest_sha256',
    'classification',
    'contract',
    'corpus_manifest_sha256',
    'corpus_release_id',
    'hydrated_file_count',
    'payload_sha256',
    'plaintext_tar_sha256',
    'public_runtime',
    'schema_version',
    'tracked_manifest_preserved',
  ].sort();
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(expectedKeys)
      || receipt.schema_version !== 1
      || receipt.contract !== HYDRATION_RECEIPT_CONTRACT
      || receipt.classification !== CLASSIFICATION
      || receipt.public_runtime !== false
      || receipt.tracked_manifest_preserved !== true
      || receipt.bundle_id !== descriptor.bundle.bundle_id
      || receipt.bundle_manifest_sha256 !== descriptor.bundle.bundle_manifest_sha256
      || receipt.payload_sha256 !== descriptor.bundle.payload_sha256
      || receipt.plaintext_tar_sha256 !== descriptor.bundle.plaintext_tar_sha256
      || receipt.corpus_release_id !== descriptor.corpus.release_id
      || receipt.corpus_manifest_sha256 !== descriptor.corpus.manifest_sha256
      || !Number.isSafeInteger(receipt.hydrated_file_count)
      || receipt.hydrated_file_count !== descriptor.bundle.archive_file_count - 2) {
    throw new Error('hydration receipt does not match the exact private corpus artifact');
  }
  return receipt;
}

export async function verifyHydratedCorpusArtifact({
  root = process.cwd(),
  descriptorPath = DEFAULT_DESCRIPTOR,
} = {}) {
  const descriptor = validateCorpusArtifactDescriptor(
    await readJsonFile(resolve(root, descriptorPath), 'private corpus artifact descriptor'),
  );
  const result = await verifyHydratedCorpus({ root, descriptor });
  const receiptPath = resolve(root, `.cache/corpus-hydration/receipts/${descriptor.bundle.bundle_id}.json`);
  const receiptBuffer = await readPrivateFile(receiptPath, {
    maxBytes: 1024 * 1024,
    label: 'private corpus hydration receipt',
  });
  let receipt;
  try {
    receipt = JSON.parse(receiptBuffer.toString('utf8'));
  } catch (error) {
    throw new Error(`hydration receipt is not JSON: ${error.message}`);
  }
  if (!canonicalJsonBuffer(receipt).equals(receiptBuffer)) throw new Error('hydration receipt JSON is not canonical');
  validateHydrationReceipt(receipt, descriptor);
  return {
    ...result,
    bundle_id: descriptor.bundle.bundle_id,
    bundle_manifest_sha256: descriptor.bundle.bundle_manifest_sha256,
    payload_sha256: descriptor.bundle.payload_sha256,
    hydration_receipt: `.cache/corpus-hydration/receipts/${descriptor.bundle.bundle_id}.json`,
    rebuild_performed: false,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await verifyHydratedCorpusArtifact({
    root: resolve(args.get('root') || process.cwd()),
    descriptorPath: args.get('descriptor') || DEFAULT_DESCRIPTOR,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) await main();
