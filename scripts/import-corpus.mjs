import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
  if (key === '--remote' || key === '--core-only') {
    args.set(key.slice(2), true);
    continue;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`);
  args.set(key.slice(2), value);
  index += 1;
}

const database = String(args.get('database') || '');
if (!database) throw new Error('--database is required');
if (!args.get('remote')) throw new Error('refusing remote mutation without explicit --remote');
const environment = String(args.get('env') || '');
const from = Math.max(0, Number(args.get('from') || 0));
const to = Math.max(from, Number(args.get('to') || Number.MAX_SAFE_INTEGER));
const root = new URL('../', import.meta.url);
const directory = new URL('data/corpus-chunks/', root);
let files = (await readdir(directory))
  .filter((name) => /^\d{3}-(?:core|paragraphs)\.sql$/.test(name))
  .sort();
if (args.get('core-only')) files = files.filter((name) => name.startsWith('000-'));
files = files.filter((name) => {
  const index = Number(name.slice(0, 3));
  return index >= from && index <= to;
});
if (!files.length) throw new Error('no corpus SQL files selected');

for (const [position, file] of files.entries()) {
  const command = ['wrangler', 'd1', 'execute', database];
  if (environment) command.push('--env', environment);
  command.push('--remote', '--file', new URL(file, directory).pathname);
  process.stdout.write(`[${position + 1}/${files.length}] ${file}\n`);
  const result = spawnSync('npx', command, { cwd: root.pathname, stdio: 'inherit' });
  if (result.status !== 0) {
    process.stderr.write(`import stopped at ${file}; rerun with --from ${file.slice(0, 3)}\n`);
    process.exit(result.status || 1);
  }
}
