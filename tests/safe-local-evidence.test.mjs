import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readPinnedRegularFile } from '../scripts/lib/safe-local-evidence.mjs';

async function evidenceFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safe-evidence-'));
  const parent = path.join(root, 'evidence');
  const file = path.join(parent, 'snapshot.txt');
  await mkdir(parent);
  await writeFile(file, 'trusted bytes');
  return { root, parent, file };
}

test('pinned evidence reader rejects a symbolic-link leaf', async () => {
  const value = await evidenceFixture();
  const target = path.join(value.root, 'target.txt');
  await writeFile(target, 'trusted bytes');
  await unlink(value.file);
  await symlink(target, value.file);
  await assert.rejects(readPinnedRegularFile(value.file, {
    label: 'snapshot',
    rootPath: value.root,
  }), /symbolic link|cannot be read safely/i);
});

test('pinned evidence reader detects a parent-directory replacement after pinning', async () => {
  const value = await evidenceFixture();
  const original = path.join(value.root, 'evidence-original');
  await assert.rejects(readPinnedRegularFile(value.file, {
    label: 'snapshot',
    rootPath: value.root,
    onPinnedForTest: async () => {
      await rename(value.parent, original);
      await mkdir(value.parent);
      await writeFile(value.file, 'replacement bytes');
    },
  }), /parent directory identity changed/);
});

test('pinned evidence reader detects in-place content replacement during a read', async () => {
  const value = await evidenceFixture();
  await assert.rejects(readPinnedRegularFile(value.file, {
    label: 'snapshot',
    rootPath: value.root,
    onPinnedForTest: async () => {
      await writeFile(value.file, 'changed bytes with another length');
    },
  }), /file identity or metadata changed/);
});
