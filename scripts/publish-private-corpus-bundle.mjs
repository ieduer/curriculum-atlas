#!/usr/bin/env node

import { createHash, createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLASSIFICATION,
  MAX_PRIVATE_ARTIFACT_BYTES,
  PRIVATE_BUCKET,
  PRIVATE_PREFIX,
  PUBLISH_RECEIPT_CONTRACT,
  assertParsedBundleMatchesBuildReceipt,
  canonicalJsonBuffer,
  parsePrivateCorpusTar,
  readJsonFile,
  readPrivateFile,
  sha256,
  validateBuildReceipt,
  validateCorpusArtifactDescriptor,
  validateSingleRecipientAgeEnvelope,
  writePrivateFile,
} from './lib/private-corpus-bundle.mjs';
import {
  assertAgeIdentityMatchesRecipient,
  decryptAndDecompressAge,
  disposeAgeIdentityAuthority,
} from './hydrate-corpus.mjs';

const MAX_REMOTE_BYTES = 1024 * 1024 * 1024;

function hmac(key, value, encoding = undefined) {
  return createHmac('sha256', key).update(value).digest(encoding);
}

function encodePath(value) {
  return String(value).split('/').map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

function endpointUrl(endpoint, bucket, key) {
  const base = new URL(endpoint);
  if (base.username || base.password || base.search || base.hash) throw new Error('R2 endpoint must not contain credentials, query, or fragment');
  const prefix = base.pathname.replace(/\/+$/, '');
  base.pathname = `${prefix}/${encodePath(bucket)}/${encodePath(key)}`;
  return base;
}

function amzTimestamp(value) {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new Error('R2 signing time is invalid');
  return value.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function canonicalHeaders(headers) {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase().trim(), String(value).trim().replace(/\s+/g, ' ')])
    .sort(([left], [right]) => left.localeCompare(right, 'en'));
  return {
    value: `${entries.map(([name, value]) => `${name}:${value}\n`).join('')}`,
    names: entries.map(([name]) => name).join(';'),
  };
}

export function signR2Request({
  method,
  url,
  body = Buffer.alloc(0),
  accessKeyId,
  secretAccessKey,
  now = new Date(),
  headers = {},
} = {}) {
  if (!['GET', 'PUT'].includes(method)) throw new Error('R2 signer supports GET and PUT only');
  if (!Buffer.isBuffer(body)) throw new Error('R2 request body must be a Buffer');
  if (!accessKeyId || !secretAccessKey) throw new Error('R2 S3 credentials are required');
  const target = url instanceof URL ? new URL(url) : new URL(String(url));
  if (target.protocol !== 'https:') throw new Error('R2 endpoint must use HTTPS');
  const timestamp = amzTimestamp(now);
  const date = timestamp.slice(0, 8);
  const payloadSha256 = createHash('sha256').update(body).digest('hex');
  const unsigned = {
    host: target.host,
    ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])),
    'x-amz-content-sha256': payloadSha256,
    'x-amz-date': timestamp,
  };
  const canonical = canonicalHeaders(unsigned);
  const canonicalRequest = [
    method,
    target.pathname,
    target.searchParams.toString(),
    canonical.value,
    canonical.names,
    payloadSha256,
  ].join('\n');
  const scope = `${date}/auto/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const dateKey = hmac(Buffer.from(`AWS4${secretAccessKey}`), date);
  const regionKey = hmac(dateKey, 'auto');
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = hmac(signingKey, stringToSign, 'hex');
  return {
    ...unsigned,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${canonical.names}, Signature=${signature}`,
  };
}

async function responseBuffer(response, operation, { maxBytes = MAX_REMOTE_BYTES, expectedBytes = null } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_REMOTE_BYTES) {
    throw new Error(`${operation} byte limit is invalid`);
  }
  if (expectedBytes !== null && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maxBytes)) {
    throw new Error(`${operation} expected byte count is invalid`);
  }
  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader) {
    const declared = Number(lengthHeader);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes
        || (expectedBytes !== null && declared !== expectedBytes)) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`${operation} content length differs from its safety boundary`);
    }
  }
  const chunks = [];
  let bytes = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        bytes += chunk.length;
        if (bytes > maxBytes || (expectedBytes !== null && bytes > expectedBytes)) {
          await reader.cancel().catch(() => {});
          throw new Error(`${operation} exceeds private artifact safety limit`);
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const body = Buffer.concat(chunks, bytes);
  if (expectedBytes !== null && body.length !== expectedBytes) {
    throw new Error(`${operation} byte count differs from its exact receipt`);
  }
  return body;
}

async function discardResponse(response) {
  try {
    await responseBuffer(response, 'R2 error response', { maxBytes: 64 * 1024 });
  } catch {
    await response.body?.cancel().catch(() => {});
  }
}

async function signedFetch({
  endpoint,
  bucket,
  key,
  method,
  body = Buffer.alloc(0),
  accessKeyId,
  secretAccessKey,
  now = new Date(),
  headers = {},
  fetchImpl = fetch,
}) {
  const url = endpointUrl(endpoint, bucket, key);
  const signed = signR2Request({ method, url, body, accessKeyId, secretAccessKey, now, headers });
  return fetchImpl(url, {
    method,
    headers: signed,
    body: method === 'PUT' ? body : undefined,
    redirect: 'error',
  });
}

export async function getObject({ expectedBytes = null, maxBytes = MAX_REMOTE_BYTES, ...options }) {
  const response = await signedFetch({ ...options, method: 'GET', body: Buffer.alloc(0) });
  if (response.status !== 200) {
    await discardResponse(response);
    throw new Error(`R2 GET failed with HTTP ${response.status}`);
  }
  return {
    body: await responseBuffer(response, 'R2 GET', { maxBytes, expectedBytes }),
    etag: response.headers.get('etag') || '',
  };
}

export async function putObjectIfAbsent(options) {
  if (!Buffer.isBuffer(options?.body) || options.body.length === 0) throw new Error('R2 conditional upload requires non-empty bytes');
  const response = await signedFetch({
    ...options,
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'if-none-match': '*' },
  });
  if (response.status >= 200 && response.status < 300) {
    await discardResponse(response);
    return { status: 'created', etag: response.headers.get('etag') || '' };
  }
  await discardResponse(response);
  if (response.status !== 409 && response.status !== 412) {
    throw new Error(`R2 conditional PUT failed with HTTP ${response.status}`);
  }
  const existing = await getObject({ ...options, expectedBytes: options.body.length, maxBytes: options.body.length });
  if (!existing.body.equals(options.body)) throw new Error('R2 immutable object already exists with different bytes');
  return { status: 'already_exists_exact', etag: existing.etag };
}

function parseArgs(argv) {
  const values = new Map();
  const booleans = new Set(['--allow-private-upload']);
  const supported = new Set([
    '--artifact', '--build-receipt', '--identity-file', '--publish-receipt', '--descriptor', '--endpoint',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (booleans.has(key)) {
      values.set(key.slice(2), true);
      continue;
    }
    if (!supported.has(key)) throw new Error(`unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    values.set(key.slice(2), value);
    index += 1;
  }
  return values;
}

function requiredEnvironment(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required in the process environment`);
  return value;
}

export async function publishPrivateCorpusBundle({
  artifactPath,
  buildReceiptPath,
  identityFile,
  publishReceiptPath,
  descriptorPath,
  endpoint,
  accessKeyId,
  secretAccessKey,
  allowPrivateUpload = false,
  fetchImpl = fetch,
} = {}) {
  if (!allowPrivateUpload) throw new Error('private corpus upload requires explicit --allow-private-upload');
  const buildReceipt = validateBuildReceipt(await readJsonFile(resolve(buildReceiptPath), 'private corpus build receipt'));
  const identityAuthority = await assertAgeIdentityMatchesRecipient({
    identityFile,
    expectedRecipient: buildReceipt.bundle.age_recipient,
  });
  try {
  const artifact = await readPrivateFile(resolve(artifactPath), {
    expectedBytes: buildReceipt.bundle.ciphertext_bytes,
    maxBytes: MAX_PRIVATE_ARTIFACT_BYTES,
    label: 'encrypted private corpus artifact',
  });
  if (artifact.length !== buildReceipt.bundle.ciphertext_bytes || sha256(artifact) !== buildReceipt.bundle.ciphertext_sha256) {
    throw new Error('encrypted artifact differs from build receipt');
  }
  validateSingleRecipientAgeEnvelope(artifact);
  const plaintext = await decryptAndDecompressAge({
    ciphertext: artifact,
    identityAuthority,
    expectedRecipient: buildReceipt.bundle.age_recipient,
    expectedPlaintextBytes: buildReceipt.bundle.plaintext_tar_bytes,
  });
  const parsed = parsePrivateCorpusTar(plaintext);
  assertParsedBundleMatchesBuildReceipt(parsed, buildReceipt);
  const common = { endpoint, bucket: PRIVATE_BUCKET, accessKeyId, secretAccessKey, fetchImpl };
  const uploaded = await putObjectIfAbsent({
    ...common,
    key: buildReceipt.storage.object_key,
    body: artifact,
  });
  const readback = await getObject({
    ...common,
    key: buildReceipt.storage.object_key,
    expectedBytes: buildReceipt.bundle.ciphertext_bytes,
    maxBytes: buildReceipt.bundle.ciphertext_bytes,
  });
  if (!readback.body.equals(artifact)) throw new Error('R2 encrypted artifact readback differs');
  if (!readback.etag || readback.etag.length > 512 || /[\u0000-\u001f\u007f]/.test(readback.etag)) {
    throw new Error('R2 encrypted artifact readback is missing a valid ETag');
  }
  const replay = parsePrivateCorpusTar(await decryptAndDecompressAge({
    ciphertext: readback.body,
    identityAuthority,
    expectedRecipient: buildReceipt.bundle.age_recipient,
    expectedPlaintextBytes: buildReceipt.bundle.plaintext_tar_bytes,
  }));
  assertParsedBundleMatchesBuildReceipt(replay, buildReceipt);
  const receipt = {
    schema_version: 1,
    contract: PUBLISH_RECEIPT_CONTRACT,
    classification: CLASSIFICATION,
    public_runtime: false,
    corpus: buildReceipt.corpus,
    bundle: buildReceipt.bundle,
    storage: {
      provider: 'cloudflare_r2_s3',
      bucket: PRIVATE_BUCKET,
      object_key: buildReceipt.storage.object_key,
      etag: readback.etag || uploaded.etag || '',
    },
    verification: {
      conditional_create: true,
      ciphertext_readback: true,
      decrypt_replay: true,
      bundle_manifest_replay: true,
    },
  };
  const receiptBuffer = canonicalJsonBuffer(receipt);
  const receiptSha256 = sha256(receiptBuffer);
  const receiptKey = `${PRIVATE_PREFIX}/receipts/sha256/${receiptSha256}.json`;
  await putObjectIfAbsent({ ...common, key: receiptKey, body: receiptBuffer });
  const receiptReadback = await getObject({
    ...common,
    key: receiptKey,
    expectedBytes: receiptBuffer.length,
    maxBytes: receiptBuffer.length,
  });
  if (!receiptReadback.body.equals(receiptBuffer)) throw new Error('R2 publish receipt readback differs');
  if (publishReceiptPath) await writePrivateFile(resolve(publishReceiptPath), receiptBuffer);
  const descriptor = validateCorpusArtifactDescriptor({
    schema_version: 1,
    contract: 'curriculum_private_corpus_artifact_v1',
    classification: CLASSIFICATION,
    public_runtime: false,
    corpus: buildReceipt.corpus,
    bundle: buildReceipt.bundle,
    storage: {
      provider: 'cloudflare_r2_s3',
      bucket: PRIVATE_BUCKET,
      object_key: buildReceipt.storage.object_key,
      receipt_key: receiptKey,
    },
    receipt: { sha256: receiptSha256, bytes: receiptBuffer.length },
  });
  const descriptorBuffer = canonicalJsonBuffer(descriptor);
  if (descriptorPath) await writePrivateFile(resolve(descriptorPath), descriptorBuffer);
  return {
    receipt,
    receipt_sha256: receiptSha256,
    receipt_bytes: receiptBuffer.length,
    receipt_key: receiptKey,
    descriptor,
    descriptor_sha256: sha256(descriptorBuffer),
    descriptor_bytes: descriptorBuffer.length,
  };
  } finally {
    disposeAgeIdentityAuthority(identityAuthority);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await publishPrivateCorpusBundle({
    artifactPath: args.get('artifact'),
    buildReceiptPath: args.get('build-receipt'),
    identityFile: args.get('identity-file') || process.env.CURRICULUM_CORPUS_AGE_IDENTITY_FILE,
    publishReceiptPath: args.get('publish-receipt'),
    descriptorPath: args.get('descriptor'),
    endpoint: args.get('endpoint') || requiredEnvironment('R2_S3_ENDPOINT'),
    accessKeyId: requiredEnvironment('R2_ACCESS_KEY_ID'),
    secretAccessKey: requiredEnvironment('R2_SECRET_ACCESS_KEY'),
    allowPrivateUpload: args.get('allow-private-upload') === true,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    classification: CLASSIFICATION,
    receipt_sha256: result.receipt_sha256,
    receipt_bytes: result.receipt_bytes,
    receipt_key: result.receipt_key,
    descriptor_sha256: result.descriptor_sha256,
    descriptor_bytes: result.descriptor_bytes,
  })}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) await main();
