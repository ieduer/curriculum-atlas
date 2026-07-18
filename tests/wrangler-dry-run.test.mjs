import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('Wrangler production CLI bundles the real Worker and assets without remote mutation', async () => {
  const output = await mkdtemp(join(tmpdir(), 'curriculum-wrangler-dry-run-'));
  try {
    const result = spawnSync('npx', [
      '--no-install', 'wrangler', 'deploy', '--dry-run', '--outdir', output,
    ], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const bundle = await readFile(join(output, 'index.js'), 'utf8');
    assert.match(bundle, /release-coordinate/);
    assert.match(bundle, /d1_fenced_r2_binding_v2|versioned_manifest_v2_fenced/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
