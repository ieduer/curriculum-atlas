import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
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

async function crashProvisionAfterLink(inputRoot, targetBasename) {
  const moduleUrl = new URL('../scripts/provision-timeout-recovery-authority.mjs', import.meta.url).href;
  const program = `
    import path from 'node:path';
    import { provisionTimeoutRecoveryAuthority } from ${JSON.stringify(moduleUrl)};
    await provisionTimeoutRecoveryAuthority(
      { inputRoot: ${JSON.stringify(inputRoot)}, apply: true },
      {
        publicationHooks: {
          afterLink({ pathname }) {
            if (path.basename(pathname) === ${JSON.stringify(targetBasename)}) process.exit(91);
          },
        },
      },
    );
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', program], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: 91, signal: null }, stderr);
  return child.pid;
}

async function matchingProvisionTemps(authorityRoot, targetBasename) {
  const prefix = `.${targetBasename}.provision-`;
  return (await readdir(authorityRoot)).filter(
    (entry) => entry.startsWith(prefix) && entry.endsWith('.tmp'),
  );
}

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

test('apply safely recovers an inactive crash hard link for both identity files', async (t) => {
  for (const targetBasename of ['ledger-identity.json', 'ledger-identity.json.sha256']) {
    await t.test(targetBasename, async (subtest) => {
      const value = await fixture(subtest);
      const crashedPid = await crashProvisionAfterLink(value.inputRoot, targetBasename);
      const targetPath = path.join(value.authorityRoot, targetBasename);
      const temps = await matchingProvisionTemps(value.authorityRoot, targetBasename);
      assert.equal(temps.length, 1);
      assert.match(temps[0], new RegExp(`\\.provision-${crashedPid}-`, 'u'));
      const tempPath = path.join(value.authorityRoot, temps[0]);
      const [targetBefore, tempBefore] = await Promise.all([stat(targetPath), stat(tempPath)]);
      assert.equal(targetBefore.nlink, 2);
      assert.equal(tempBefore.nlink, 2);
      assert.equal(targetBefore.dev, tempBefore.dev);
      assert.equal(targetBefore.ino, tempBefore.ino);

      const recovered = await provisionTimeoutRecoveryAuthority({
        inputRoot: value.inputRoot,
        apply: true,
      });
      assert.equal(
        recovered.status,
        targetBasename === 'ledger-identity.json' ? 'applied' : 'verified_idempotent',
      );
      assert.equal((await stat(targetPath)).nlink, 1);
      assert.deepEqual(await matchingProvisionTemps(value.authorityRoot, targetBasename), []);
      const identityPath = path.join(value.authorityRoot, 'ledger-identity.json');
      assert.equal(
        await readFile(`${identityPath}.sha256`, 'utf8'),
        `${sha256(await readFile(identityPath))}  ledger-identity.json\n`,
      );
    });
  }
});

test('apply refuses active and ambiguous provision hard links without unlinking evidence', async (t) => {
  await t.test('active publisher PID', async (subtest) => {
    const value = await fixture(subtest);
    await provisionTimeoutRecoveryAuthority({ inputRoot: value.inputRoot, apply: true });
    const identityPath = path.join(value.authorityRoot, 'ledger-identity.json');
    const tempPath = path.join(
      value.authorityRoot,
      `.ledger-identity.json.provision-${process.pid}-${randomUUID()}.tmp`,
    );
    await link(identityPath, tempPath);
    await assert.rejects(
      provisionTimeoutRecoveryAuthority({ inputRoot: value.inputRoot, apply: true }),
      /provision temp belongs to an active or invalid PID/u,
    );
    assert.equal((await stat(identityPath)).nlink, 2);
    assert.equal((await stat(tempPath)).nlink, 2);
  });

  await t.test('multiple matching links', async (subtest) => {
    const value = await fixture(subtest);
    await provisionTimeoutRecoveryAuthority({ inputRoot: value.inputRoot, apply: true });
    const identityPath = path.join(value.authorityRoot, 'ledger-identity.json');
    const tempPaths = [randomUUID(), randomUUID()].map((uuid) => path.join(
      value.authorityRoot,
      `.ledger-identity.json.provision-999999-${uuid}.tmp`,
    ));
    await Promise.all(tempPaths.map((tempPath) => link(identityPath, tempPath)));
    await assert.rejects(
      provisionTimeoutRecoveryAuthority({ inputRoot: value.inputRoot, apply: true }),
      /ambiguous provision hard links/u,
    );
    assert.equal((await stat(identityPath)).nlink, 3);
    for (const tempPath of tempPaths) assert.equal((await stat(tempPath)).nlink, 3);
  });
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
