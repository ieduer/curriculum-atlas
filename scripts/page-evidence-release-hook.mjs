#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { validatePageEvidenceRelease } from './page-evidence-publication.mjs';

const DEFAULT_MANIFEST = 'scripts/page-evidence/fail-closed-manifest.json';

function normalizeRoot(root) {
  if (root instanceof URL) return fileURLToPath(root);
  return resolve(String(root));
}

export function assertPageEvidenceReleaseMode(result, { pageEvidencePromotion = false } = {}) {
  if (typeof pageEvidencePromotion !== 'boolean') {
    throw new Error('pageEvidencePromotion must be an explicit boolean');
  }
  if (!result || result.valid !== true) {
    throw new Error('page-evidence release validation did not return valid=true');
  }
  if (pageEvidencePromotion && result.publishable !== true) {
    throw new Error('page-evidence promotion requires publishable page evidence');
  }
  if (!pageEvidencePromotion && result.publishable === true) {
    throw new Error('publishable page evidence requires the dedicated page-evidence promotion path');
  }
  return result;
}

export function validatePageEvidenceForRelease({
  root = process.cwd(),
  pageEvidencePromotion = false,
  evidenceManifestPath = DEFAULT_MANIFEST,
  authorityRegistrySha256 = process.env.PAGE_EVIDENCE_AUTHORITY_SHA256 || null,
  sourceIdentityRegistrySha256 = process.env.PAGE_EVIDENCE_SOURCE_IDENTITIES_SHA256 || null,
  rendererSha256 = process.env.PAGE_EVIDENCE_RENDERER_SHA256 || null,
  rendererVersion = process.env.PAGE_EVIDENCE_RENDERER_VERSION || null,
  rendererPath = null,
  validator = validatePageEvidenceRelease,
} = {}) {
  if (typeof pageEvidencePromotion !== 'boolean') {
    throw new Error('pageEvidencePromotion must be an explicit boolean');
  }
  const result = validator({
    root: normalizeRoot(root),
    evidenceManifestPath,
    requirePublishable: pageEvidencePromotion,
    authorityRegistrySha256,
    sourceIdentityRegistrySha256,
    rendererSha256,
    rendererVersion,
    rendererPath,
  });
  return assertPageEvidenceReleaseMode(result, { pageEvidencePromotion });
}

function parseArgs(argv) {
  const parsed = { root: process.cwd(), evidenceManifestPath: DEFAULT_MANIFEST, rendererPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--mode', '--root', '--manifest', '--renderer'].includes(argument)) {
      throw new Error(`unexpected argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${argument}`);
    index += 1;
    if (argument === '--mode') parsed.mode = value;
    if (argument === '--root') parsed.root = value;
    if (argument === '--manifest') parsed.evidenceManifestPath = value;
    if (argument === '--renderer') parsed.rendererPath = value;
  }
  if (!['ordinary', 'promotion'].includes(parsed.mode)) {
    throw new Error('usage: node scripts/page-evidence-release-hook.mjs --mode <ordinary|promotion>');
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = validatePageEvidenceForRelease({
    root: args.root,
    evidenceManifestPath: args.evidenceManifestPath,
    rendererPath: args.rendererPath,
    pageEvidencePromotion: args.mode === 'promotion',
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`page-evidence-release-hook: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
