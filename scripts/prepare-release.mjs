#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertCleanReleaseSource } from './assert-clean-release-source.mjs';
import { auditProjectAssets } from './audit-project-assets.mjs';
import { buildReleaseManifest } from './build-release-manifest.mjs';
import { validateCorpusManifest } from './import-corpus.mjs';
import { validatePageEvidenceForRelease } from './page-evidence-release-hook.mjs';
import { createCorpusSourceSnapshot } from './lib/corpus-source-snapshot.mjs';
import { desiredReleaseManifestArtifact } from './lib/desired-release-manifest.mjs';
import {
  assertResearchEvidenceReleaseGate,
  validateResearchEvidenceSliceFile,
} from './validate-research-evidence-slice.mjs';
import {
  materializeGitHeadReleaseTree,
  materializeVerifiedBuffer,
  readGitBlob,
} from './lib/git-release-source.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_OUTPUT = '.wrangler/release-manifest.json';

async function walkFiles(root, prefix) {
  const directory = resolve(root, prefix);
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = `${prefix}/${entry.name}`.replaceAll('\\', '/');
    if (entry.isDirectory()) result.push(...await walkFiles(root, relativePath));
    else if (entry.isFile()) result.push(relativePath);
    else throw new Error(`prepared release contains unsupported path type: ${relativePath}`);
  }
  return result.sort();
}

async function buildDist(snapshotRoot, runCommand) {
  const result = runCommand(process.execPath, ['scripts/build-site.mjs'], {
    cwd: snapshotRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`immutable Git release build failed: ${String(result.stderr || '').trim().slice(0, 2000)}`);
  }
  for (const path of await walkFiles(snapshotRoot, 'dist')) {
    await chmod(resolve(snapshotRoot, path), 0o400);
  }
}

export async function prepareRelease({
  root = DEFAULT_ROOT,
  output = null,
  pageEvidencePromotion = false,
  rendererPath = null,
  runCommand = spawnSync,
  cleanSourceValidator = assertCleanReleaseSource,
  projectAssetAuditor = auditProjectAssets,
  pageEvidenceValidator = validatePageEvidenceForRelease,
  researchEvidenceResourceMap = process.env.CURRICULUM_RESEARCH_EVIDENCE_RESOURCE_MAP || null,
  researchEvidenceValidator = validateResearchEvidenceSliceFile,
  researchEvidenceGate = assertResearchEvidenceReleaseGate,
  manifestBuilder = buildReleaseManifest,
} = {}) {
  const repositoryRoot = resolve(root);
  const git = cleanSourceValidator({ root: repositoryRoot, requireUpstream: true, runCommand });
  const projectAssetAudit = await projectAssetAuditor({ projectRoot: repositoryRoot });
  if (!projectAssetAudit.ok) throw new Error('project asset audit failed before Git release materialization');

  const gitTree = await materializeGitHeadReleaseTree({ repositoryRoot, head: git.head });
  let corpusSnapshot = null;
  try {
    for (const path of [
      'data/downloads-asset-audit-receipt.json',
      'data/release-environment-evidence.json',
    ]) {
      const buffer = readGitBlob(repositoryRoot, git.head, path);
      await materializeVerifiedBuffer(gitTree.root, path, buffer, {
        sha256: createHash('sha256').update(buffer).digest('hex'),
        bytes: buffer.length,
      });
    }
    const corpusManifest = validateCorpusManifest(JSON.parse(
      await readFile(resolve(gitTree.root, 'data/corpus-chunks/manifest.json'), 'utf8'),
    ));
    for (const entry of corpusManifest.sql_files) {
      const relativePath = `data/corpus-chunks/${entry.name}`;
      const buffer = await readFile(resolve(repositoryRoot, relativePath));
      await materializeVerifiedBuffer(gitTree.root, relativePath, buffer, entry);
    }
    for (const entry of corpusManifest.text_assets) {
      const relativePath = `.cache/text/${entry.document_id}.txt`;
      const buffer = await readFile(resolve(repositoryRoot, relativePath));
      await materializeVerifiedBuffer(gitTree.root, relativePath, buffer, entry);
    }
    corpusSnapshot = await createCorpusSourceSnapshot({ root: gitTree.root, manifest: corpusManifest });
    await corpusSnapshot.verify();
    if (!researchEvidenceResourceMap) {
      throw new Error('strict release requires --research-evidence-resource-map or CURRICULUM_RESEARCH_EVIDENCE_RESOURCE_MAP');
    }
    const researchEvidenceManifest = JSON.parse(await readFile(
      resolve(gitTree.root, 'data/research-evidence/zh-hs-2017-2020.json'),
      'utf8',
    ));
    const researchEvidence = await researchEvidenceValidator({
      root: gitTree.root,
      resourceMap: researchEvidenceResourceMap,
      resourcePathOverrides: {
        [researchEvidenceManifest.corpus.manifest_resource_id]: resolve(
          gitTree.root,
          'data/corpus-chunks/manifest.json',
        ),
      },
    });
    researchEvidenceGate(researchEvidence, { requirePublicationEligible: true });
    const pageEvidence = pageEvidenceValidator({
      root: gitTree.root,
      pageEvidencePromotion,
      rendererPath,
    });
    await buildDist(gitTree.root, runCommand);
    await gitTree.verify();
    await corpusSnapshot.verify();
    const manifest = await manifestBuilder({
      root: gitTree.root,
      repositoryRoot,
      pageEvidencePromotion,
      rendererPath,
      pageEvidenceOverride: pageEvidence,
      projectAssetAuditor: async () => projectAssetAudit,
      runCommand,
      gitOverride: {
        head: git.head,
        branch: git.branch || null,
        upstream_head: git.upstream,
        dirty: false,
        status_entries: 0,
        status_sha256: '0'.repeat(64),
        materialized_from_git_blobs: true,
      },
      sourceTreeOverride: gitTree.source_tree,
    });
    if (manifest.git.head !== git.head || manifest.source_tree.sha256 !== gitTree.source_tree.sha256) {
      throw new Error('prepared release identity diverged from exact Git materialization');
    }
    const artifact = desiredReleaseManifestArtifact(manifest);
    if (output) {
      const destination = resolve(repositoryRoot, output);
      const relation = relative(repositoryRoot, destination);
      if (relation.startsWith('../') || relation === '..') throw new Error('prepared manifest output escapes repository');
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, artifact.buffer, { mode: 0o600 });
    }
    return {
      manifest,
      artifact,
      source: gitTree,
      corpus_snapshot_sha256: corpusSnapshot.sha256,
      async cleanup() {
        await Promise.allSettled([corpusSnapshot?.cleanup(), gitTree.cleanup()]);
      },
    };
  } catch (error) {
    await Promise.allSettled([corpusSnapshot?.cleanup(), gitTree.cleanup()]);
    throw error;
  }
}

function parseArgs(argv) {
  const options = {
    root: DEFAULT_ROOT,
    output: DEFAULT_OUTPUT,
    researchEvidenceResourceMap: process.env.CURRICULUM_RESEARCH_EVIDENCE_RESOURCE_MAP || null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--page-evidence-promotion') {
      options.pageEvidencePromotion = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    if (key === '--root') options.root = value;
    else if (key === '--output') options.output = value;
    else if (key === '--renderer') options.rendererPath = value;
    else if (key === '--research-evidence-resource-map') options.researchEvidenceResourceMap = value;
    else throw new Error(`unexpected argument: ${key}`);
    index += 1;
  }
  return options;
}

async function main() {
  const prepared = await prepareRelease(parseArgs(process.argv.slice(2)));
  try {
    process.stdout.write(`${prepared.manifest.release_id} manifest_sha256=${prepared.artifact.sha256} git=${prepared.manifest.git.head} source_tree=${prepared.manifest.source_tree.sha256} corpus=${prepared.manifest.corpus_release.release_id}\n`);
  } finally {
    await prepared.cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`prepare-release: ${error.message}\n`);
    process.exitCode = 1;
  });
}
