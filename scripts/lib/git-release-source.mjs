import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function git(root, args, { encoding = null } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) {
    const stderr = Buffer.from(result.stderr || '').toString('utf8').trim();
    throw new Error(`git ${args.join(' ')} failed: ${stderr.slice(0, 2000)}`);
  }
  return result.stdout;
}

export function readGitBlob(root, head, path) {
  const normalized = normalizePath(path);
  return Buffer.from(git(resolve(root), ['cat-file', 'blob', `${head}:${normalized}`]));
}

function normalizePath(value, label = 'Git path') {
  const path = String(value || '').replaceAll('\\', '/');
  if (!path || path.startsWith('/') || path === '..' || path.startsWith('../') || path.includes('/../')) {
    throw new Error(`${label} escapes the repository`);
  }
  return path;
}

export function exactGitHead(root, requested = null) {
  const head = requested || String(git(root, ['rev-parse', 'HEAD'], { encoding: 'utf8' })).trim();
  if (!GIT_COMMIT_PATTERN.test(head)) throw new Error('release Git HEAD must be an exact commit');
  const type = String(git(root, ['cat-file', '-t', head], { encoding: 'utf8' })).trim();
  if (type !== 'commit') throw new Error('release Git HEAD is not a commit object');
  return head;
}

export function listGitTree(root, head) {
  const output = Buffer.from(git(root, [
    'ls-tree', '-rz', '--full-tree', '--format=%(objectmode)%x00%(objecttype)%x00%(objectname)%x00%(path)', head,
  ])).toString('utf8');
  const fields = output.split('\0');
  const entries = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const [mode, type, object, rawPath] = fields.slice(index, index + 4);
    if (!rawPath) continue;
    const path = normalizePath(rawPath);
    if (type !== 'blob' || mode === '120000') {
      throw new Error(`governed Git source must be a regular blob: ${path}`);
    }
    entries.push({ mode, type, object, path });
  }
  return entries;
}

export function governedGitEntries(entries, policy) {
  const roots = (policy.source_tree?.roots || []).map((value) => normalizePath(value, 'source tree root'));
  const files = new Set((policy.source_tree?.files || []).map((value) => normalizePath(value, 'source tree file')));
  const excluded = new Set((policy.source_tree?.excluded_paths || []).map((value) => normalizePath(value, 'source tree exclusion')));
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const path of files) {
    if (!byPath.has(path)) throw new Error(`configured source tree file is absent from Git HEAD: ${path}`);
  }
  return entries.filter((entry) =>
    (files.has(entry.path) || roots.some((root) => entry.path.startsWith(`${root}/`)))
    && !excluded.has(entry.path));
}

function sourceTreeFromFiles(files, gitIndexFileCount) {
  const ordered = [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const digest = Buffer.from(ordered.map((entry) => `${entry.path}\0${entry.sha256}\0${entry.bytes}\n`).join(''));
  return {
    tracked_only: true,
    materialized_from_git_blobs: true,
    git_index_file_count: gitIndexFileCount,
    sha256: sha256(digest),
    file_count: ordered.length,
    total_bytes: ordered.reduce((sum, entry) => sum + entry.bytes, 0),
    files: ordered,
  };
}

async function writeBlob(destinationRoot, path, buffer) {
  const target = join(destinationRoot, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, buffer, { flag: 'wx', mode: 0o400 });
  await chmod(target, 0o400);
}

export async function materializeGitHeadReleaseTree({ repositoryRoot, head = null } = {}) {
  const repo = resolve(repositoryRoot);
  const gitHead = exactGitHead(repo, head);
  const entries = listGitTree(repo, gitHead);
  const policyEntry = entries.find((entry) => entry.path === 'data/release-assets-policy.json');
  if (!policyEntry) throw new Error('release policy is absent from exact Git HEAD');
  const policyBuffer = Buffer.from(git(repo, ['cat-file', 'blob', `${gitHead}:data/release-assets-policy.json`]));
  const policy = JSON.parse(policyBuffer.toString('utf8'));
  const governed = governedGitEntries(entries, policy);
  const directory = await mkdtemp(join(tmpdir(), 'curriculum-git-release-'));
  await chmod(directory, 0o700);
  const files = [];
  try {
    for (const entry of governed) {
      const buffer = Buffer.from(git(repo, ['cat-file', 'blob', `${gitHead}:${entry.path}`]));
      await writeBlob(directory, entry.path, buffer);
      files.push({ path: entry.path, sha256: sha256(buffer), bytes: buffer.length });
    }
    const sourceTree = sourceTreeFromFiles(files, entries.length);
    const verify = async () => {
      for (const expected of files) {
        const target = join(directory, expected.path);
        const state = await lstat(target);
        if (!state.isFile() || state.isSymbolicLink() || (state.mode & 0o222) !== 0) {
          throw new Error(`materialized Git blob changed type or mode: ${expected.path}`);
        }
        const handle = await open(target, 'r');
        try {
          const buffer = await handle.readFile();
          if (buffer.length !== expected.bytes || sha256(buffer) !== expected.sha256) {
            throw new Error(`materialized Git blob changed bytes: ${expected.path}`);
          }
        } finally {
          await handle.close();
        }
      }
      return sourceTree;
    };
    await verify();
    return {
      root: directory,
      repository_root: repo,
      git_head: gitHead,
      policy,
      source_tree: sourceTree,
      verify,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function materializeVerifiedBuffer(root, relativePath, buffer, expected) {
  const path = normalizePath(relativePath, 'materialized release input');
  if (!Buffer.isBuffer(buffer) || sha256(buffer) !== expected.sha256 || buffer.length !== expected.bytes) {
    throw new Error(`materialized release input parity failure: ${path}`);
  }
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, buffer, { flag: 'wx', mode: 0o400 });
  await chmod(target, 0o400);
  return target;
}
