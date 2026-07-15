import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, copyFile, open, readFile, rename, stat, writeFile } from 'node:fs/promises';

const [url, destination, expectedSizeValue, expectedSha256Value] = process.argv.slice(2);
if (!url || !destination || !expectedSizeValue || !expectedSha256Value) {
  throw new Error('Usage: node scripts/download-range-file.mjs <url> <destination> <bytes> <sha256|->');
}

const expectedSize = Number(expectedSizeValue);
const expectedSha256 = expectedSha256Value === '-' ? null : expectedSha256Value;
const chunkSize = 16 * 1024 * 1024;
const chunkCount = Math.ceil(expectedSize / chunkSize);
const partPath = `${destination}.range-part`;
const statePath = `${destination}.range-state.json`;
const stateTempPath = `${statePath}.tmp`;

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

let state;
if (await exists(partPath) && await exists(statePath)) {
  state = JSON.parse(await readFile(statePath, 'utf8'));
  if (state.expected_size !== expectedSize || state.expected_sha256 !== expectedSha256) {
    throw new Error(`Range state does not match requested artifact: ${statePath}`);
  }
} else {
  let seedBytes = 0;
  if (await exists(destination)) {
    const existing = await stat(destination);
    if (existing.size === expectedSize) {
      const existingSha256 = await sha256(destination);
      if (!expectedSha256 || existingSha256 === expectedSha256) {
        console.log(`already verified ${destination} ${existingSha256}`);
        process.exit(0);
      }
    }
    if (existing.size < expectedSize) {
      seedBytes = Math.floor(existing.size / chunkSize) * chunkSize;
      await copyFile(destination, partPath);
    }
  }
  const handle = await open(partPath, seedBytes ? 'r+' : 'w+');
  await handle.truncate(expectedSize);
  await handle.close();
  state = {
    url,
    expected_size: expectedSize,
    expected_sha256: expectedSha256,
    chunk_size: chunkSize,
    completed: Array.from({ length: Math.floor(seedBytes / chunkSize) }, (_, index) => index),
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

const completed = new Set(state.completed);
const pending = Array.from({ length: chunkCount }, (_, index) => index).filter((index) => !completed.has(index));
const file = await open(partPath, 'r+');
let saveChain = Promise.resolve();

function saveState() {
  saveChain = saveChain.then(async () => {
    state.completed = [...completed].sort((a, b) => a - b);
    await writeFile(stateTempPath, `${JSON.stringify(state, null, 2)}\n`);
    await rename(stateTempPath, statePath);
  });
  return saveChain;
}

let cursor = 0;
async function worker() {
  while (cursor < pending.length) {
    const index = pending[cursor++];
    const start = index * chunkSize;
    const end = Math.min(expectedSize - 1, start + chunkSize - 1);
    const expectedLength = end - start + 1;
    let lastError;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: {
            range: `bytes=${start}-${end}`,
            'user-agent': 'BDFZ-Curriculum-Atlas/1.0 reproducible-model-fetch',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(90_000),
        });
        if (response.status !== 206) throw new Error(`expected HTTP 206, got ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length !== expectedLength) throw new Error(`expected ${expectedLength} bytes, got ${bytes.length}`);
        await file.write(bytes, 0, bytes.length, start);
        completed.add(index);
        await saveState();
        console.log(`${destination}: ${completed.size}/${chunkCount} chunks`);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await sleep(Math.min(30_000, attempt * 2_000));
      }
    }
    if (lastError) throw new Error(`chunk ${index} failed: ${lastError.message}`);
  }
}

try {
  await Promise.all(Array.from({ length: 3 }, () => worker()));
  await saveChain;
} finally {
  await file.close();
}

const actualSha256 = await sha256(partPath);
if (expectedSha256 && actualSha256 !== expectedSha256) {
  throw new Error(`SHA-256 mismatch for ${destination}: expected ${expectedSha256}, got ${actualSha256}`);
}
await rename(partPath, destination);
console.log(`verified ${destination} ${actualSha256}`);
