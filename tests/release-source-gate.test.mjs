import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertCleanReleaseSource } from '../scripts/assert-clean-release-source.mjs';
import { assertManifestSourceGates, deployWorker, wranglerDeployArgs } from '../scripts/deploy-worker.mjs';

const FIXTURE_RELEASE_ID = `release-${'f'.repeat(32)}`;

function fakeGit(outputs) {
  return (_command, arguments_) => {
    const key = arguments_.join(' ');
    const value = outputs[key];
    if (value instanceof Error) return { status: 1, stdout: '', stderr: value.message };
    return { status: 0, stdout: `${value ?? ''}\n`, stderr: '' };
  };
}

test('clean release source requires exact HEAD, empty status, and optional exact upstream', () => {
  const head = 'a'.repeat(40);
  const clean = assertCleanReleaseSource({
    root: '.',
    requireUpstream: true,
    runCommand: fakeGit({
      'rev-parse HEAD': head,
      'status --porcelain=v1 --untracked-files=all': '',
      'rev-parse @{upstream}': head,
    }),
  });
  assert.deepEqual(clean, { head, upstream: head, clean: true });
  assert.throws(() => assertCleanReleaseSource({
    root: '.',
    runCommand: fakeGit({
      'rev-parse HEAD': head,
      'status --porcelain=v1 --untracked-files=all': ' M src/index.ts',
    }),
  }), /release source is dirty/);
  assert.throws(() => assertCleanReleaseSource({
    root: '.',
    requireUpstream: true,
    runCommand: fakeGit({
      'rev-parse HEAD': head,
      'status --porcelain=v1 --untracked-files=all': '',
      'rev-parse @{upstream}': 'b'.repeat(40),
    }),
  }), /not exactly pushed/);
});

test('Worker deploy wrapper injects Git provenance and refuses source blockers', () => {
  const head = 'a'.repeat(40);
  const proof = {
    git_head: head,
    snapshot_root: '/private/tmp/fixture-worker-snapshot',
    release_id: FIXTURE_RELEASE_ID,
    release_manifest_sha256: 'b'.repeat(64),
    source_tree_sha256: 'c'.repeat(64),
    corpus_release_id: `corpus-${'d'.repeat(24)}`,
    corpus_manifest_sha256: 'e'.repeat(64),
  };
  const expectedVars = [
    '--var', `RELEASE_GIT_COMMIT:${head}`,
    '--var', `RELEASE_ID:${FIXTURE_RELEASE_ID}`,
    '--var', `RELEASE_MANIFEST_SHA256:${'b'.repeat(64)}`,
    '--var', `RELEASE_SOURCE_TREE_SHA256:${'c'.repeat(64)}`,
    '--var', `CORPUS_RELEASE_ID:corpus-${'d'.repeat(24)}`,
    '--var', `CORPUS_MANIFEST_SHA256:${'e'.repeat(64)}`,
  ];
  assert.deepEqual(wranglerDeployArgs('preview', proof), [
    '--no-install', 'wrangler', 'deploy', '--cwd', proof.snapshot_root,
    '--env', 'preview', '--keep-vars', ...expectedVars,
  ]);
  assert.deepEqual(wranglerDeployArgs('production', proof), [
    '--no-install', 'wrangler', 'deploy', '--cwd', proof.snapshot_root,
    '--keep-vars', ...expectedVars,
  ]);
  assert.throws(() => assertManifestSourceGates({
    release_blockers: [{ environment: 'source', code: 'downloads_audit_stale' }],
  }), /downloads_audit_stale/);
  assert.equal(assertManifestSourceGates({ release_blockers: [] }), true);
});

test('Worker deployment executes from the complete private source and dist snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worker-deploy-snapshot-fixture-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'dist'), { recursive: true });
    const files = new Map([
      ['src/index.ts', Buffer.from('export default { fetch() { return new Response("ok"); } };\n')],
      ['src/z.ts', Buffer.from('export const z = true;\n')],
      ['src/é.ts', Buffer.from('export const accented = true;\n')],
      ['wrangler.jsonc', Buffer.from('{"name":"fixture","main":"src/index.ts","assets":{"directory":"./dist"}}\n')],
      ['dist/index.html', Buffer.from('<!doctype html><title>fixture</title>\n')],
    ]);
    for (const [path, buffer] of files) await writeFile(join(root, path), buffer);
    const sourceFiles = [...files.entries()].filter(([path]) => !path.startsWith('dist/')).map(([path, buffer]) => ({
      path,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      bytes: buffer.length,
    })).sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const sourceTreeSha256 = createHash('sha256').update(
      sourceFiles.map((file) => `${file.path}\0${file.sha256}\0${file.bytes}\n`).join(''),
    ).digest('hex');
    const distBuffer = files.get('dist/index.html');
    const head = 'a'.repeat(40);
    const manifest = {
      schema_version: 1,
      policy: 'fixture',
      release_id: FIXTURE_RELEASE_ID,
      release_blockers: [],
      git: { head },
      source_tree: { sha256: sourceTreeSha256, files: sourceFiles },
      corpus_release: {
        release_id: `corpus-${'b'.repeat(24)}`,
        manifest_sha256: 'c'.repeat(64),
      },
      page_evidence: { valid: true, publishable: false },
      data_assets: [],
      graph_assets: [],
      static_assets: {
        files: [{
          deploy_path: 'dist/index.html',
          sha256: createHash('sha256').update(distBuffer).digest('hex'),
          bytes: distBuffer.length,
        }],
      },
      r2: { release_prefix: 'releases', release_manifest_key: `releases/${FIXTURE_RELEASE_ID}/manifest.json`, objects: [] },
    };
    let snapshotRoot = null;
    const runCommand = (_command, args) => {
      snapshotRoot = args[args.indexOf('--cwd') + 1];
      writeFileSync(join(root, 'src/index.ts'), 'export default { compromised: true };\n');
      assert.deepEqual(readFileSync(join(snapshotRoot, 'src/index.ts')), files.get('src/index.ts'));
      assert.deepEqual(readFileSync(join(snapshotRoot, 'dist/index.html')), distBuffer);
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = await deployWorker({
      environment: 'preview',
      root,
      runCommand,
      pageEvidenceValidator: () => ({ valid: true, publishable: false }),
      cleanSourceValidator: () => ({ head, upstream: head, clean: true }),
      manifestBuilder: async () => manifest,
    });
    assert.equal(result.git_head, head);
    assert.equal(result.source_tree_sha256, sourceTreeSha256);
    assert.ok(snapshotRoot);
    assert.equal(existsSync(snapshotRoot), false, 'deployment snapshot must be removed after Wrangler returns');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
