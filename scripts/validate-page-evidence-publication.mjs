#!/usr/bin/env node
import path from 'node:path';

import { validatePageEvidenceRelease } from './page-evidence-publication.mjs';

function usage() {
  console.error([
    'usage: node scripts/validate-page-evidence-publication.mjs [options]',
    '',
    '  --root <project-root>',
    '  --manifest <project-relative-release-manifest>',
    '  --renderer <mutool-path>',
    '  --authority-registry-sha256 <externally-pinned-sha256>',
    '  --source-identities-sha256 <externally-pinned-sha256>',
    '  --renderer-sha256 <externally-pinned-sha256>',
    '  --renderer-version <exact-mutool-version-output>',
    '  --require-publishable',
  ].join('\n'));
}

const options = {
  root: process.cwd(),
  evidenceManifestPath: 'scripts/page-evidence/fail-closed-manifest.json',
  rendererPath: null,
  authorityRegistrySha256: process.env.PAGE_EVIDENCE_AUTHORITY_SHA256 || null,
  sourceIdentityRegistrySha256: process.env.PAGE_EVIDENCE_SOURCE_IDENTITIES_SHA256 || null,
  rendererSha256: process.env.PAGE_EVIDENCE_RENDERER_SHA256 || null,
  rendererVersion: process.env.PAGE_EVIDENCE_RENDERER_VERSION || null,
  requirePublishable: false,
};

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === '--require-publishable') {
    options.requirePublishable = true;
    continue;
  }
  if ([
    '--root',
    '--manifest',
    '--renderer',
    '--authority-registry-sha256',
    '--source-identities-sha256',
    '--renderer-sha256',
    '--renderer-version',
  ].includes(argument)) {
    const value = args[index + 1];
    if (!value) {
      usage();
      process.exit(64);
    }
    index += 1;
    if (argument === '--root') options.root = path.resolve(value);
    if (argument === '--manifest') options.evidenceManifestPath = value;
    if (argument === '--renderer') options.rendererPath = value;
    if (argument === '--authority-registry-sha256') options.authorityRegistrySha256 = value;
    if (argument === '--source-identities-sha256') options.sourceIdentityRegistrySha256 = value;
    if (argument === '--renderer-sha256') options.rendererSha256 = value;
    if (argument === '--renderer-version') options.rendererVersion = value;
    continue;
  }
  usage();
  process.exit(64);
}

try {
  const result = validatePageEvidenceRelease(options);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
