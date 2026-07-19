import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createImmutableFileSnapshot,
  createImmutableTreeSnapshot,
} from '../scripts/lib/immutable-release-snapshot.mjs';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

test('immutable file snapshot pins verified bytes in a private read-only inode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-file-snapshot-fixture-'));
  try {
    const source = Buffer.from('verified SQL bytes\n');
    await writeFile(join(root, 'chunk.sql'), source);
    const snapshot = await createImmutableFileSnapshot({
      root,
      source: 'chunk.sql',
      expected: { sha256: sha256(source), bytes: source.length },
      label: 'fixture SQL',
    });
    try {
      await writeFile(join(root, 'chunk.sql'), 'replacement SQL bytes\n');
      assert.deepEqual(await readFile(snapshot.path), source);
      assert.equal((await lstat(snapshot.path)).mode & 0o222, 0);
      assert.deepEqual(await snapshot.verify(), {
        sha256: sha256(source),
        bytes: source.length,
        dev: snapshot.dev,
        ino: snapshot.ino,
      });
    } finally {
      await snapshot.cleanup();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('immutable file snapshot rejects lexical escapes and source symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-file-snapshot-boundary-'));
  const outside = join(root, '..', `outside-${process.pid}.sql`);
  try {
    const source = Buffer.from('outside\n');
    await writeFile(outside, source);
    await symlink(outside, join(root, 'link.sql'));
    for (const candidate of ['../outside.sql', 'link.sql']) {
      await assert.rejects(
        createImmutableFileSnapshot({
          root,
          source: candidate,
          expected: { sha256: sha256(source), bytes: source.length },
          label: 'unsafe fixture',
        }),
        /inside root|symbolic link/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test('immutable tree snapshot binds the complete declared deployment inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-tree-snapshot-fixture-'));
  try {
    const first = Buffer.from('export default {};\n');
    const second = Buffer.from('{"name":"fixture"}\n');
    await writeFile(join(root, 'worker.mjs'), first);
    await writeFile(join(root, 'wrangler.json'), second);
    const snapshot = await createImmutableTreeSnapshot({
      root,
      files: [
        { path: 'worker.mjs', sha256: sha256(first), bytes: first.length },
        { path: 'wrangler.json', sha256: sha256(second), bytes: second.length },
      ],
      label: 'fixture deployment source',
    });
    try {
      await chmod(join(root, 'worker.mjs'), 0o600);
      await writeFile(join(root, 'worker.mjs'), 'export default { evil: true };\n');
      assert.deepEqual(await readFile(join(snapshot.root, 'worker.mjs')), first);
      assert.deepEqual(await snapshot.verify(), {
        file_count: 2,
        sha256: snapshot.sha256,
        total_bytes: first.length + second.length,
      });
    } finally {
      await snapshot.cleanup();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
