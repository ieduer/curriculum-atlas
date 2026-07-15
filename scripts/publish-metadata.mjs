import { access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
  if (key === '--remote') {
    args.set('remote', true);
    continue;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`);
  args.set(key.slice(2), value);
  index += 1;
}

const bucket = String(args.get('bucket') || '');
if (!bucket) throw new Error('--bucket is required');
if (!args.get('remote')) throw new Error('refusing remote mutation without explicit --remote');
const root = new URL('../', import.meta.url);
const objects = [
  ['data/catalog.json', 'catalog/catalog.json'],
  ['data/ingest-manifest.json', 'catalog/ingest-manifest.json'],
  ['data/ocr-queue.json', 'quality/ocr-queue.json'],
  ['data/online-verification-standard.json', 'quality/online-verification-standard.json'],
  ['data/online-verification-validation.json', 'quality/online-verification-validation.json'],
  ['data/online-verification-samples.json', 'quality/online-verification-samples.json'],
];

for (const [position, [file, key]] of objects.entries()) {
  const source = new URL(file, root);
  await access(source);
  process.stdout.write(`[${position + 1}/${objects.length}] ${key}\n`);
  const result = spawnSync('npx', [
    'wrangler', 'r2', 'object', 'put', `${bucket}/${key}`,
    '--file', source.pathname, '--content-type', 'application/json', '--remote',
  ], { cwd: root.pathname, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
