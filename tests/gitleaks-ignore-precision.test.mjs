import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const historicalCommit = '5b056d8a516cfc6bd4714b243ce90981ec7f3904';
const historicalPath = 'tests/corpus-import-safety.test.mjs';
const expectedFingerprints = [235, 243, 517, 561, 613].map(
  (line) => `${historicalCommit}:${historicalPath}:generic-api-key:${line}`,
);

test('gitleaks ignores only the five obsolete synthetic owner-token fixture findings', async () => {
  const ignore = await readFile(new URL('../.gitleaksignore', import.meta.url), 'utf8');
  assert.equal(ignore, `${expectedFingerprints.join('\n')}\n`);
  const fingerprints = ignore.split('\n').filter(Boolean);
  assert.deepEqual(fingerprints, expectedFingerprints);
  assert.equal(new Set(fingerprints).size, 5);

  const historical = spawnSync('git', ['show', `${historicalCommit}:${historicalPath}`], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(historical.status, 0, historical.stderr);
  const historicalLines = historical.stdout.split('\n');
  const syntheticFixture = ['fixture', 'corpus', 'owner', '20260718'].join('-');
  for (const fingerprint of fingerprints) {
    const line = Number(fingerprint.slice(fingerprint.lastIndexOf(':') + 1));
    assert.match(historicalLines[line - 1], new RegExp(syntheticFixture));
  }

  const current = await readFile(new URL('corpus-import-safety.test.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(current, new RegExp(syntheticFixture));
});
