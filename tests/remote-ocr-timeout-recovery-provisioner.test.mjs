import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { provisionTimeoutRecoveryAuthority } from '../scripts/provision-timeout-recovery-authority.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'timeout-authority-provision-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputRoot = path.join(root, 'input');
  const authorityRoot = path.join(root, 'timeout-recovery-authority-v1');
  await mkdir(inputRoot, { mode: 0o700 });
  return { root, inputRoot, authorityRoot };
}

test('preview is mutation-free and apply provisions an exact durable canonical identity pair', async (t) => {
  const value = await fixture(t);
  const preview = await provisionTimeoutRecoveryAuthority({ inputRoot: value.inputRoot });
  assert.equal(preview.status, 'ready_to_allocate_authority_inode');
  await assert.rejects(lstat(value.authorityRoot), { code: 'ENOENT' });

  const applied = await provisionTimeoutRecoveryAuthority({ inputRoot: value.inputRoot, apply: true });
  assert.equal(applied.status, 'applied');
  assert.equal((await stat(value.authorityRoot)).mode & 0o777, 0o700);
  const identityPath = path.join(value.authorityRoot, 'ledger-identity.json');
  const identityRaw = await readFile(identityPath);
  const sidecarRaw = await readFile(`${identityPath}.sha256`, 'utf8');
  assert.equal((await stat(identityPath)).mode & 0o777, 0o600);
  assert.equal((await stat(`${identityPath}.sha256`)).mode & 0o777, 0o600);
  assert.equal(sidecarRaw, `${sha256(identityRaw)}  ledger-identity.json\n`);
  assert.equal(JSON.parse(identityRaw).ledger_id, applied.ledger_id);

  const idempotent = await provisionTimeoutRecoveryAuthority({ inputRoot: value.inputRoot, apply: true });
  assert.equal(idempotent.status, 'verified_idempotent');
  assert.deepEqual(idempotent.applied_writes, []);
});

test('two concurrent apply calls converge on the single allocated authority inode', async (t) => {
  const value = await fixture(t);
  const [left, right] = await Promise.all([
    provisionTimeoutRecoveryAuthority({ inputRoot: value.inputRoot, apply: true }),
    provisionTimeoutRecoveryAuthority({ inputRoot: value.inputRoot, apply: true }),
  ]);
  assert.equal(left.ledger_id, right.ledger_id);
  const identityPath = path.join(value.authorityRoot, 'ledger-identity.json');
  assert.equal(
    await readFile(`${identityPath}.sha256`, 'utf8'),
    `${sha256(await readFile(identityPath))}  ledger-identity.json\n`,
  );
});

test('provisioning rejects symlinks, orphan sidecars, and arbitrary pre-existing identity bytes', async (t) => {
  await t.test('symlink authority', async (subtest) => {
    const value = await fixture(subtest);
    const target = path.join(value.root, 'target');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, value.authorityRoot);
    await assert.rejects(
      provisionTimeoutRecoveryAuthority({ inputRoot: value.inputRoot, apply: true }),
      /must not be a symlink/u,
    );
  });
  await t.test('orphan sidecar', async (subtest) => {
    const value = await fixture(subtest);
    await mkdir(value.authorityRoot, { mode: 0o700 });
    await writeFile(
      path.join(value.authorityRoot, 'ledger-identity.json.sha256'),
      `${'0'.repeat(64)}  ledger-identity.json\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      provisionTimeoutRecoveryAuthority({ inputRoot: value.inputRoot, apply: true }),
      /orphan identity sidecar/u,
    );
  });
  await t.test('arbitrary identity', async (subtest) => {
    const value = await fixture(subtest);
    await mkdir(value.authorityRoot, { mode: 0o700 });
    await writeFile(
      path.join(value.authorityRoot, 'ledger-identity.json'),
      '{"arbitrary":true}\n',
      { mode: 0o600 },
    );
    await assert.rejects(
      provisionTimeoutRecoveryAuthority({ inputRoot: value.inputRoot, apply: true }),
      /already exists with different bytes/u,
    );
  });
});
