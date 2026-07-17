#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

function git(root, arguments_, runCommand) {
  const result = runCommand('git', arguments_, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${arguments_.join(' ')} failed: ${String(result.stderr || '').trim()}`);
  }
  return String(result.stdout || '').trim();
}

export function assertCleanReleaseSource({
  root = DEFAULT_ROOT,
  requireUpstream = false,
  runCommand = spawnSync,
} = {}) {
  const projectRoot = resolve(root);
  const head = git(projectRoot, ['rev-parse', 'HEAD'], runCommand).toLowerCase();
  if (!COMMIT_PATTERN.test(head)) throw new Error(`release source has no exact Git HEAD: ${head || '<unset>'}`);
  const status = git(projectRoot, ['status', '--porcelain=v1', '--untracked-files=all'], runCommand);
  if (status) throw new Error(`release source is dirty (${status.split(/\r?\n/u).length} entries)`);
  let upstream = null;
  if (requireUpstream) {
    upstream = git(projectRoot, ['rev-parse', '@{upstream}'], runCommand).toLowerCase();
    if (!COMMIT_PATTERN.test(upstream) || upstream !== head) {
      throw new Error(`release source HEAD ${head} is not exactly pushed to its upstream ${upstream || '<unset>'}`);
    }
  }
  return { head, upstream, clean: true };
}

function parseArgs(argv) {
  const allowed = new Set(['--require-upstream']);
  for (const argument of argv) if (!allowed.has(argument)) throw new Error(`unexpected argument: ${argument}`);
  return { requireUpstream: argv.includes('--require-upstream') };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = assertCleanReleaseSource(options);
  process.stdout.write(`clean release source ${result.head}${result.upstream ? ' upstream-exact' : ''}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`assert-clean-release-source: ${error.message}\n`);
    process.exitCode = 1;
  });
}
