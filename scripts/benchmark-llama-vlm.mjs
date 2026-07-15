import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

const samples = process.argv.slice(2);
if (samples.length === 0) throw new Error('Pass one or more local PNG/JPEG sample paths.');

const outputDir = new URL('../.cache/ocr-benchmark/llama-vlm-raw/', import.meta.url);
await mkdir(outputDir, { recursive: true });

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const results = [];
for (const sample of samples) {
  const bytes = await readFile(sample);
  const extension = extname(sample).slice(1).toLowerCase();
  const mime = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : 'image/png';
  const started = performance.now();
  const response = await fetch('http://127.0.0.1:8112/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } },
          { type: 'text', text: 'OCR:' },
        ],
      }],
      temperature: 0,
      max_tokens: 8192,
      stream: false,
    }),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`llama.cpp HTTP ${response.status}: ${JSON.stringify(payload)}`);
  const content = payload.choices?.[0]?.message?.content || '';
  const stem = basename(sample, extname(sample));
  const textPath = join(outputDir.pathname, `${stem}.txt`);
  const jsonPath = join(outputDir.pathname, `${stem}.response.json`);
  await writeFile(textPath, `${content}\n`);
  await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  results.push({
    image_path: sample,
    image_sha256: sha256(bytes),
    text_path: textPath,
    text_sha256: sha256(content),
    elapsed_seconds: Number(((performance.now() - started) / 1000).toFixed(3)),
    characters: content.length,
    usage: payload.usage || null,
  });
  console.log(`${stem}: ${content.length} characters`);
}

await writeFile(join(outputDir.pathname, 'manifest.json'), `${JSON.stringify({
  generated_at: new Date().toISOString(),
  engine: 'PaddlePaddle/PaddleOCR-VL-1.6-GGUF via llama.cpp',
  model_revision: '511b09642bb324401f15f97cc23bc67e8f0a291d',
  model_sha256: 'f3ae46ec885050acf4b3d31944431e1fd90d50664fb09126af4a3c050ba14ee8',
  mmproj_sha256: '204d757d7610d9b3faab10d506d69e5b244e32bf765e2bab2d0167e65e0a058a',
  llama_cpp_revision: '12127defda4f41b7679cb2477a4b0d65ee6a0c8f',
  prompt: 'OCR:',
  results,
}, null, 2)}\n`);
