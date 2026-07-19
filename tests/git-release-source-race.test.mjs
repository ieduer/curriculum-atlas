import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { materializeGitHeadReleaseTree } from '../scripts/lib/git-release-source.mjs';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('exact Git blob snapshot and build stay on HEAD when the worktree changes after the clean gate', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'curriculum-git-race-'));
  let snapshot = null;
  try {
    await Promise.all([
      mkdir(join(repository, 'data'), { recursive: true }),
      mkdir(join(repository, 'public'), { recursive: true }),
      mkdir(join(repository, 'scripts'), { recursive: true }),
      mkdir(join(repository, 'src'), { recursive: true }),
    ]);
    const policy = {
      source_tree: {
        roots: ['data', 'public', 'scripts', 'src'],
        files: [],
        excluded_paths: [],
      },
    };
    await writeFile(join(repository, 'data/release-assets-policy.json'), `${JSON.stringify(policy)}\n`);
    await writeFile(join(repository, 'public/index.txt'), 'HEAD-public\n');
    await writeFile(join(repository, 'src/index.ts'), 'export const identity = "HEAD-source";\n');
    await writeFile(join(repository, 'scripts/build-site.mjs'), `
      import { mkdir, readFile, writeFile } from 'node:fs/promises';
      await mkdir('dist', { recursive: true });
      await writeFile('dist/index.txt', await readFile('public/index.txt'));
    `);
    git(repository, ['init']);
    git(repository, ['add', '.']);
    git(repository, ['-c', 'user.name=Codex Test', '-c', 'user.email=codex@example.test', 'commit', '-m', 'fixture']);
    const head = git(repository, ['rev-parse', 'HEAD']);

    snapshot = await materializeGitHeadReleaseTree({ repositoryRoot: repository, head });
    await writeFile(join(repository, 'public/index.txt'), 'MUTATED-worktree\n');
    await writeFile(join(repository, 'src/index.ts'), 'export const identity = "MUTATED";\n');
    const build = spawnSync(process.execPath, ['scripts/build-site.mjs'], {
      cwd: snapshot.root,
      encoding: 'utf8',
    });
    assert.equal(build.status, 0, build.stderr);
    assert.equal(await readFile(join(snapshot.root, 'dist/index.txt'), 'utf8'), 'HEAD-public\n');
    assert.equal(await readFile(join(snapshot.root, 'src/index.ts'), 'utf8'), 'export const identity = "HEAD-source";\n');
    await snapshot.verify();
    assert.equal(snapshot.git_head, head);
    assert.equal(snapshot.source_tree.materialized_from_git_blobs, true);
    assert.ok(snapshot.source_tree.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
  } finally {
    await snapshot?.cleanup();
    await chmod(repository, 0o700).catch(() => {});
    await rm(repository, { recursive: true, force: true });
  }
});
