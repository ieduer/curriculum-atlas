#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { validatePageEvidenceForRelease } from './page-evidence-release-hook.mjs';
import { validateCorpusManifest } from './import-corpus.mjs';
import { parseDesiredReleaseManifestArtifact } from './lib/desired-release-manifest.mjs';

export const CANONICAL_FACETS = Object.freeze([
  ['facet:chinese-language', '语文', './chinese-language'],
  ['facet:mathematics', '数学', './mathematics'],
  ['facet:foreign-languages', '外语', './foreign-languages'],
  ['facet:politics-morality-law', '思想政治与道德法治', './politics-morality-law'],
  ['facet:history', '历史', './history'],
  ['facet:history-and-society', '历史与社会', './history-and-society'],
  ['facet:geography', '地理', './geography'],
  ['facet:science', '科学类', './science'],
  ['facet:technology', '技术', './technology'],
  ['facet:labor', '劳动', './labor'],
  ['facet:arts', '艺术', './arts'],
  ['facet:physical-education-health', '体育与健康', './physical-education-health'],
].map(([facet_id, label, directory]) => Object.freeze({ facet_id, label, directory })));

export const HIERARCHY_FAMILIES = Object.freeze([
  'goal',
  'content_task',
  'capability',
  'literacy',
  'academic_quality',
]);

const RELATION_TYPES = new Set(['rename', 'split', 'merge', 'broaden', 'narrow', 'replace', 'coexist']);
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const facetById = new Map(CANONICAL_FACETS.map((facet) => [facet.facet_id, facet]));
const facetIdByLabel = new Map(CANONICAL_FACETS.map((facet) => [facet.label, facet.facet_id]));
const trustedPromotionContexts = new WeakMap();

function fail(message) {
  throw new Error(message);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function jsonDigest(value) {
  return digest(Buffer.from(stableJson(value), 'utf8'));
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function asObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function asArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function asString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function asInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} must be an integer >= ${minimum}`);
  return value;
}

function asSha(value, label) {
  if (!SHA256.test(String(value || ''))) fail(`${label} must be a lowercase SHA-256`);
  return value;
}

function exactKeys(value, expected, label, optional = []) {
  asObject(value, label);
  const allowed = new Set([...expected, ...optional]);
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length || extra.length) {
    fail(`${label} field set mismatch missing=[${missing.join(',')}] extra=[${extra.join(',')}]`);
  }
}

function unique(values, label) {
  if (new Set(values).size !== values.length) fail(`${label} must be unique`);
  return values;
}

function exactSet(actual, expected, label) {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  if (stableJson(left) !== stableJson(right)) {
    fail(`${label} differs expected=${JSON.stringify(right)} actual=${JSON.stringify(left)}`);
  }
}

function acceptedReview(review, label) {
  exactKeys(review, ['reviewer_id', 'reviewed_at', 'policy_revision_sha256', 'decision'], label);
  asString(review.reviewer_id, `${label}.reviewer_id`);
  if (!TIMESTAMP.test(String(review.reviewed_at || '')) || Number.isNaN(Date.parse(review.reviewed_at))) {
    fail(`${label}.reviewed_at must be canonical UTC seconds`);
  }
  asSha(review.policy_revision_sha256, `${label}.policy_revision_sha256`);
  if (review.decision !== 'accepted') fail(`${label}.decision must be accepted`);
  return review;
}

function safeRead(rootDir, relativePath, label) {
  const locator = asString(relativePath, `${label}.path`).replaceAll('\\', '/');
  if (path.isAbsolute(locator) || locator === '..' || locator.startsWith('../') || locator.includes('/../')) {
    fail(`${label}.path must remain project-relative`);
  }
  const root = realpathSync(rootDir);
  const candidate = path.resolve(root, locator);
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`${label}.path escapes the project root`);
  }
  if (lstatSync(candidate).isSymbolicLink()) fail(`${label}.path may not be a symlink`);
  const resolved = realpathSync(candidate);
  if (!statSync(resolved).isFile()) fail(`${label}.path must be a regular file`);
  const resolvedRelative = path.relative(root, resolved);
  if (resolvedRelative === '..' || resolvedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(resolvedRelative)) {
    fail(`${label}.path resolves outside the project root`);
  }
  const buffer = readFileSync(resolved);
  return { path: locator, buffer, sha256: digest(buffer), bytes: buffer.byteLength };
}

function readBoundJson(rootDir, binding, label) {
  exactKeys(binding, ['path', 'sha256'], label, ['release_id', 'release_fingerprint_sha256', 'manifest_sha256']);
  const artifact = safeRead(rootDir, binding.path, label);
  if (artifact.sha256 !== binding.sha256) fail(`${label}.sha256 differs from actual bytes`);
  let json;
  try {
    json = JSON.parse(artifact.buffer.toString('utf8'));
  } catch (error) {
    fail(`${label}.path is not JSON: ${error.message}`);
  }
  return { ...artifact, json };
}

function readArtifactRef(rootDir, ref, label) {
  exactKeys(ref, ['locator', 'sha256', 'bytes'], label);
  const artifact = safeRead(rootDir, ref.locator, label);
  if (artifact.sha256 !== ref.sha256 || artifact.bytes !== ref.bytes) fail(`${label} artifact identity differs from actual bytes`);
  return artifact;
}

function gitOutput(rootDir, args, label) {
  const result = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' });
  if (result.status !== 0) fail(`${label}: ${(result.stderr || '').trim()}`);
  return result.stdout.trim();
}

function normalizedProjectPath(value, label) {
  const relative = asString(value, label).replaceAll('\\', '/').replace(/^\.\//u, '');
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('../') || relative.includes('/../')) {
    fail(`${label} must remain project-relative`);
  }
  return relative.replace(/\/$/u, '');
}

function verifyPreparedSourceTree(rootDir, desired) {
  const actualHead = gitOutput(rootDir, ['rev-parse', 'HEAD'], 'cannot resolve prepared Git HEAD');
  const upstreamHead = gitOutput(rootDir, ['rev-parse', '@{upstream}'], 'prepared Git branch has no exact upstream');
  const status = gitOutput(rootDir, ['status', '--porcelain=v1', '--untracked-files=all'], 'cannot inspect prepared Git status');
  if (desired.git?.head !== actualHead || upstreamHead !== actualHead || status) {
    fail('prepared ontology promotion requires clean Git HEAD exactly present at its configured upstream');
  }
  const files = asArray(desired.source_tree?.files, 'desired source_tree.files');
  const identities = files.map((entry, index) => {
    exactKeys(entry, ['path', 'sha256', 'bytes'], `desired source_tree.files[${index}]`);
    const actual = safeRead(rootDir, entry.path, `desired source_tree.files[${index}]`);
    if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes) fail(`${entry.path} differs from the prepared Git tree`);
    return entry;
  });
  unique(identities.map((entry) => entry.path), 'desired source_tree file paths');
  const material = identities.map((entry) => `${entry.path}\0${entry.sha256}\0${entry.bytes}\n`).join('');
  const trackedFiles = gitOutput(rootDir, ['ls-files', '-z'], 'cannot enumerate prepared tracked files')
    .split('\0').filter(Boolean).map((entry) => normalizedProjectPath(entry, 'prepared tracked file'));
  const policyArtifact = safeRead(rootDir, 'data/release-assets-policy.json', 'prepared release-assets policy');
  const policy = JSON.parse(policyArtifact.buffer.toString('utf8'));
  const roots = asArray(policy.source_tree?.roots, 'release policy source_tree.roots')
    .map((entry) => normalizedProjectPath(entry, 'release policy source root'));
  const configuredFiles = asArray(policy.source_tree?.files, 'release policy source_tree.files')
    .map((entry) => normalizedProjectPath(entry, 'release policy source file'));
  const excluded = new Set(asArray(policy.source_tree?.excluded_paths, 'release policy source_tree.excluded_paths')
    .map((entry) => normalizedProjectPath(entry, 'release policy excluded path')));
  const expectedFiles = trackedFiles.filter((entry) => (configuredFiles.includes(entry)
      || roots.some((root) => entry.startsWith(`${root}/`))) && !excluded.has(entry)).sort();
  exactSet(identities.map((entry) => entry.path), expectedFiles, 'desired source_tree governed files');
  if (digest(Buffer.from(material)) !== desired.source_tree.sha256
      || desired.source_tree.file_count !== identities.length
      || desired.source_tree.total_bytes !== identities.reduce((total, entry) => total + entry.bytes, 0)
      || desired.source_tree.git_index_file_count !== trackedFiles.length
      || desired.source_tree.tracked_only !== true) fail('desired source_tree identity is not reproducible from current bytes');
}

function loadPreparedCorpus(rootDir, desired) {
  const manifestArtifact = safeRead(rootDir, 'data/corpus-chunks/manifest.json', 'prepared corpus manifest');
  const manifest = validateCorpusManifest(JSON.parse(manifestArtifact.buffer.toString('utf8')));
  const expected = desired.corpus_release;
  if (expected?.source !== 'data/corpus-chunks/manifest.json'
      || expected.sha256 !== manifestArtifact.sha256
      || expected.bytes !== manifestArtifact.bytes
      || expected.release_id !== manifest.release_id
      || expected.release_fingerprint_sha256 !== manifest.release_fingerprint_sha256
      || expected.manifest_sha256 !== manifest.manifest_sha256) fail('prepared desired release corpus identity differs from actual manifest');
  const database = new DatabaseSync(':memory:');
  try {
    const migrationPaths = gitOutput(rootDir, ['ls-files', 'migrations/*.sql'], 'cannot enumerate prepared migrations')
      .split('\n').filter(Boolean).sort();
    for (const migrationPath of migrationPaths) database.exec(safeRead(rootDir, migrationPath, `migration ${migrationPath}`).buffer.toString('utf8'));
    for (const entry of manifest.sql_files) {
      const artifact = safeRead(rootDir, `data/corpus-chunks/${entry.name}`, `corpus chunk ${entry.name}`);
      if (artifact.sha256 !== entry.sha256 || artifact.bytes !== entry.bytes) fail(`corpus chunk ${entry.name} differs from manifest`);
      database.exec(artifact.buffer.toString('utf8'));
    }
    return database.prepare(`
      SELECT p.document_id,p.ordinal AS paragraph_ordinal,p.page_number AS physical_page,
             p.body,p.body_sha256,p.citation_allowed,p.display_allowed,p.corpus_release_id,
             d.version_label
      FROM paragraphs p JOIN documents d ON d.id=p.document_id
      WHERE p.corpus_release_id=?
      ORDER BY p.document_id,p.ordinal
    `).all(manifest.release_id).map((row) => ({
      ...row,
      edition_id: `edition:${row.document_id}:${digest(Buffer.from(row.version_label || '', 'utf8')).slice(0, 12)}`,
      citation_allowed: row.citation_allowed === 1,
      display_allowed: row.display_allowed === 1,
    }));
  } finally {
    database.close();
  }
}

function sameVersionAnchor(left, right) {
  return String(left || '').normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('zh-CN')
    === String(right || '').normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
}

function loadCanonicalPageEvidenceRows(rootDir, pageEvidence) {
  const releaseArtifact = safeRead(rootDir, 'scripts/page-evidence/fail-closed-manifest.json', 'canonical page-evidence release');
  if (releaseArtifact.sha256 !== pageEvidence.manifest.sha256) fail('validated page-evidence result changed before ontology extraction');
  const release = JSON.parse(releaseArtifact.buffer.toString('utf8'));
  const publicationArtifact = readArtifactRef(rootDir, release.bindings.page_publication_manifest, 'page-publication binding');
  const publication = JSON.parse(publicationArtifact.buffer.toString('utf8'));
  const publicationByKey = new Map(publication.documents.flatMap((document) => document.pages.map((page) => [
    `${document.document_id}\u0000${page.page_number}`,
    page,
  ])));
  const sourceRegistryArtifact = readArtifactRef(rootDir, release.source_identity_registry, 'online source registry');
  const sourceById = new Map(JSON.parse(sourceRegistryArtifact.buffer.toString('utf8')).sources.map((source) => [source.source_id, source]));
  return release.bundles.map((entry) => {
    const bundleArtifact = readArtifactRef(rootDir, entry.bundle, `page bundle ${entry.document_id}:${entry.page_number}`);
    const bundle = JSON.parse(bundleArtifact.buffer.toString('utf8'));
    const decisionArtifact = readArtifactRef(rootDir, bundle.artifacts.reviewer_decision, `review decision ${entry.document_id}:${entry.page_number}`);
    const decision = JSON.parse(decisionArtifact.buffer.toString('utf8'));
    const claimsArtifact = readArtifactRef(rootDir, bundle.artifacts.online_claims, `online claims ${entry.document_id}:${entry.page_number}`);
    const claims = JSON.parse(claimsArtifact.buffer.toString('utf8'));
    const page = publicationByKey.get(`${entry.document_id}\u0000${entry.page_number}`);
    if (!page) fail(`${entry.document_id}:${entry.page_number} absent from canonical page-publication manifest`);
    return {
      document_id: entry.document_id,
      physical_page: entry.page_number,
      bundle_sha256: bundleArtifact.sha256,
      signed_reviewer_payload_sha256: decision.signed_payload_sha256,
      reviewer_id: decision.reviewer_id,
      reviewed_at: decision.decided_at,
      citation_allowed: page.citation_allowed === true,
      display_allowed: page.display_allowed === true,
      review_status: page.review_status,
      online_claims: claims.claims.map((claim) => {
        const source = sourceById.get(claim.source_id);
        if (!source) fail(`${claim.claim_id} source is absent from the canonical external registry`);
        const captureBody = readArtifactRef(rootDir, claim.capture.body, `online capture ${claim.claim_id}`);
        const anchors = Object.fromEntries(claim.version_anchors.map((anchor) => {
          if (anchor.locator !== claim.capture.body.locator
              || anchor.start_byte < 0 || anchor.end_byte <= anchor.start_byte
              || anchor.end_byte > captureBody.bytes) fail(`${claim.claim_id} version anchor is outside canonical capture bytes`);
          const bytes = captureBody.buffer.subarray(anchor.start_byte, anchor.end_byte);
          if (digest(bytes) !== anchor.slice_sha256) fail(`${claim.claim_id} version anchor hash differs from capture bytes`);
          return [anchor.field, new TextDecoder('utf-8', { fatal: true }).decode(bytes)];
        }));
        const exact = Object.keys(claims.target_version).every((field) => sameVersionAnchor(anchors[field], claims.target_version[field]));
        return {
          claim_id: claim.claim_id,
          version_match: exact ? 'exact_document_exact_edition' : 'not_matched',
          version_anchors: anchors,
          canonical_origin: source.canonical_origin,
          canonical_publisher: source.canonical_publisher,
          independence_group: source.independence_group,
          capture_body_sha256: claim.capture.body.sha256,
          supporting_slice_sha256: claim.supporting_slice.slice_sha256,
        };
      }),
    };
  });
}

export function createImmutablePreparedReleaseContext({
  rootDir = process.cwd(),
  desiredReleasePath = '.wrangler/release-manifest.json',
  pageEvidenceValidator = validatePageEvidenceForRelease,
} = {}) {
  const desiredArtifact = safeRead(rootDir, desiredReleasePath, 'prepared desired release');
  const desired = parseDesiredReleaseManifestArtifact(desiredArtifact.buffer).value;
  verifyPreparedSourceTree(rootDir, desired);
  const paragraphs = loadPreparedCorpus(rootDir, desired);
  const pageEvidence = pageEvidenceValidator({ root: rootDir, pageEvidencePromotion: true });
  if (pageEvidence.valid !== true || pageEvidence.publishable !== true) fail('ontology promotion requires canonical publishable page evidence');
  const { renderer_identity: _rendererIdentity, ...sourceBoundPageEvidence } = pageEvidence;
  if (stableJson(desired.page_evidence) !== stableJson(sourceBoundPageEvidence)) fail('desired release page-evidence identity differs from canonical promotion result');
  const catalogArtifact = safeRead(rootDir, 'data/catalog.json', 'coverage catalog');
  const taxonomyArtifact = safeRead(rootDir, 'data/concept-model-v2.json', 'coverage taxonomy');
  const provenanceArtifact = safeRead(rootDir, 'data/document-sources.json', 'coverage provenance');
  const reviewerRegistryArtifact = safeRead(rootDir, 'scripts/page-evidence/reviewer-authorities.json', 'reviewer registry');
  const onlineRegistryArtifact = safeRead(rootDir, 'scripts/page-evidence/online-source-identities.json', 'online source registry');
  const onlineStandardArtifact = safeRead(rootDir, 'data/online-verification-standard.json', 'online verification standard');
  const catalog = JSON.parse(catalogArtifact.buffer.toString('utf8'));
  const taxonomy = JSON.parse(taxonomyArtifact.buffer.toString('utf8'));
  const provenance = JSON.parse(provenanceArtifact.buffer.toString('utf8'));
  const context = {
    context_kind: 'immutable_prepared_release_v1',
    prepared_release: {
      git_head: desired.git.head,
      source_tree_sha256: desired.source_tree.sha256,
      corpus_release_id: desired.corpus_release.release_id,
      corpus_manifest_sha256: desired.corpus_release.manifest_sha256,
      corpus_release_fingerprint_sha256: desired.corpus_release.release_fingerprint_sha256,
    },
    source_bindings: {
      taxonomy_sha256: taxonomyArtifact.sha256,
      catalog_sha256: catalogArtifact.sha256,
      provenance_sha256: provenanceArtifact.sha256,
      corpus_manifest_file_sha256: desired.corpus_release.sha256,
      reviewer_registry_sha256: reviewerRegistryArtifact.sha256,
      online_source_registry_sha256: onlineRegistryArtifact.sha256,
      online_verification_standard_sha256: onlineStandardArtifact.sha256,
    },
    page_evidence: {
      manifest_sha256: pageEvidence.manifest.sha256,
      policy_revision_sha256: pageEvidence.bindings.semantic_publication_policy.sha256,
      pages: loadCanonicalPageEvidenceRows(rootDir, pageEvidence),
    },
    paragraphs,
    coverage_catalog: buildIndependentCoverageCatalog({ catalog, taxonomy, provenance }),
  };
  const frozen = deepFreeze(context);
  trustedPromotionContexts.set(frozen, frozen);
  return frozen;
}

function subjectIdentity(document, taxonomy) {
  const override = taxonomy.document_entity_overrides?.[document.id];
  const source = override || taxonomy.subject_taxonomy?.[document.subject];
  if (!source || source.facet_eligible !== true) return null;
  if (source.entity_kind === 'assessment_subject' && !/考试|评价/u.test(document.document_type || '')) return null;
  if (!['subject', 'assessment_subject'].includes(source.entity_kind)) return null;
  const sourceLabel = document.subject;
  const group = Object.entries(taxonomy.subject_facet_groups || {})
    .filter(([, labels]) => labels.includes(sourceLabel) || labels.includes(source.canonical));
  if (group.length !== 1) return null;
  const facetId = facetIdByLabel.get(group[0][0]);
  if (!facetId) return null;
  return {
    source_label: sourceLabel,
    canonical_label: source.canonical,
    subject_id: source.stable_subject_id || `subject:${digest(Buffer.from(source.canonical, 'utf8')).slice(0, 16)}`,
    facet_id: facetId,
  };
}

function documentFunction(document) {
  if (/课程标准/u.test(document.document_type || document.title || '')) return 'curriculum_standard';
  if (/教学大纲/u.test(document.document_type || document.title || '')) return 'teaching_syllabus';
  if (/考试|评价/u.test(document.document_type || document.title || '')) return 'assessment_specification';
  return 'other';
}

function documentPopulation(document) {
  return /盲校|聋校|培智|特殊教育/u.test(`${document.title || ''} ${document.stage || ''}`)
    ? 'special_education'
    : 'ordinary_general_education';
}

function documentYear(document) {
  const source = document.issued_date || document.published_date || document.version_label || document.title || '';
  const match = String(source).match(/(?:19|20)\d{2}/u);
  return match ? Number(match[0]) : null;
}

export function buildIndependentCoverageCatalog({ catalog, taxonomy, provenance }) {
  const sources = asArray(provenance.sources, 'provenance.sources');
  const sourcesByDocument = new Map();
  for (const source of sources) {
    const list = sourcesByDocument.get(source.document_id) || [];
    list.push(source);
    sourcesByDocument.set(source.document_id, list);
  }
  return asArray(catalog.documents, 'catalog.documents').map((document) => {
    const subject = subjectIdentity(document, taxonomy);
    const year = documentYear(document);
    const entity = taxonomy.document_entity_overrides?.[document.id]
      || taxonomy.subject_taxonomy?.[document.subject]
      || null;
    const sourceRows = (sourcesByDocument.get(document.id) || [])
      .map((row) => ({
        document_id: row.document_id,
        provider: row.provider,
        source_page_url: row.source_page_url,
        source_url: row.source_url,
        checksum_sha256: row.checksum_sha256,
        access_status: row.access_status,
        is_primary: row.is_primary,
      }))
      .sort((left, right) => stableJson(left).localeCompare(stableJson(right), 'en'));
    const scopePlanEvidence = entity?.entity_kind === 'cross_cutting_framework'
      || /课程设置(?:实验)?方案/u.test(document.title || '');
    return {
      document_id: document.id,
      edition_id: `edition:${document.id}:${digest(Buffer.from(document.version_label || '', 'utf8')).slice(0, 12)}`,
      version_label: document.version_label ?? null,
      issued_date: document.issued_date ?? null,
      source_artifact_sha256: document.checksum_sha256 ?? null,
      coverage_role: subject ? 'subject_edition_candidate' : scopePlanEvidence ? 'scope_plan_evidence' : 'non_subject_catalog_record',
      entity_kind: entity?.entity_kind ?? 'unclassified',
      classification: entity?.classification ?? 'unclassified',
      facet_eligible: subject !== null,
      facet_id: subject?.facet_id ?? null,
      source_label: document.subject ?? null,
      subject_id: subject?.subject_id ?? null,
      subject_label: subject?.canonical_label ?? null,
      stage: document.stage ?? null,
      year,
      population: documentPopulation(document),
      document_function: documentFunction(document),
      provenance_count: sourceRows.length,
      provenance_sha256: jsonDigest(sourceRows),
      exact_duplicate_alias: document.local_verification_status === 'exact_duplicate_alias',
    };
  }).sort((left, right) => left.document_id.localeCompare(right.document_id, 'en'));
}

function validateBindings(rootDir, index) {
  exactKeys(index.bindings, [
    'taxonomy',
    'catalog',
    'provenance',
    'corpus_manifest',
    'page_evidence_manifest',
    'reviewer_registry',
    'online_source_registry',
    'online_verification_standard',
    'validation_report_path',
  ], 'index.bindings');
  if (index.bindings.validation_report_path !== 'data/subject-ontology-v2-validation.json') {
    fail('index.bindings.validation_report_path is not canonical');
  }
  const artifacts = {};
  for (const name of [
    'taxonomy', 'catalog', 'provenance', 'corpus_manifest', 'page_evidence_manifest',
    'reviewer_registry', 'online_source_registry', 'online_verification_standard',
  ]) artifacts[name] = readBoundJson(rootDir, index.bindings[name], `index.bindings.${name}`);

  const corpus = artifacts.corpus_manifest.json;
  for (const key of ['release_id', 'release_fingerprint_sha256', 'manifest_sha256']) {
    if (index.bindings.corpus_manifest[key] !== corpus[key]) fail(`index.bindings.corpus_manifest.${key} is stale`);
  }
  if (artifacts.taxonomy.json.model_name !== 'curriculum-concept-observation-model'
      || artifacts.taxonomy.json.schema_version !== 2) fail('taxonomy identity is unsupported');
  if (artifacts.page_evidence_manifest.json.policy !== 'immutable_page_evidence_release_v1') {
    fail('page-evidence manifest is not the canonical release contract');
  }
  if (artifacts.reviewer_registry.json.policy !== 'pinned_ed25519_page_reviewers_v1') {
    fail('reviewer registry is not externally pinned');
  }
  if (artifacts.online_source_registry.json.policy !== 'externally_pinned_online_source_identities_v1') {
    fail('online source registry is not externally pinned');
  }
  return artifacts;
}

function falseGate(gate, label) {
  exactKeys(gate, [
    'mode', 'builder_input_allowed', 'public_data_update_allowed',
    'semantic_claims_allowed', 'negative_historical_assertions_allowed', 'reason_codes',
  ], label);
  if (gate.mode !== 'ordinary_nonpublishable'
      || gate.builder_input_allowed !== false
      || gate.public_data_update_allowed !== false
      || gate.semantic_claims_allowed !== false
      || gate.negative_historical_assertions_allowed !== false
      || asArray(gate.reason_codes, `${label}.reason_codes`).length === 0) {
    fail(`${label} must remain ordinary and fully fail closed`);
  }
}

function openGate(gate, label, { negative = false } = {}) {
  exactKeys(gate, [
    'mode', 'builder_input_allowed', 'public_data_update_allowed',
    'semantic_claims_allowed', 'negative_historical_assertions_allowed', 'reason_codes',
  ], label);
  if (gate.mode !== 'explicit_promotion'
      || gate.builder_input_allowed !== true
      || gate.public_data_update_allowed !== true
      || gate.semantic_claims_allowed !== true
      || gate.negative_historical_assertions_allowed !== negative
      || asArray(gate.reason_codes, `${label}.reason_codes`).length === 0) {
    fail(`${label} is inconsistent with explicit promotion state`);
  }
}

function validateFacetIdentity(index) {
  const facets = asArray(index.canonical_facets, 'index.canonical_facets');
  if (facets.length !== CANONICAL_FACETS.length) fail('index must contain exactly 12 canonical facets');
  for (let position = 0; position < CANONICAL_FACETS.length; position += 1) {
    const facet = facets[position];
    const expected = CANONICAL_FACETS[position];
    exactKeys(facet, ['facet_id', 'label', 'directory', 'status', 'scope_files', 'coverage'], `facet[${position}]`);
    if (facet.facet_id !== expected.facet_id || facet.label !== expected.label || facet.directory !== expected.directory) {
      fail(`facet[${position}] differs from canonical identity`);
    }
    unique(asArray(facet.scope_files, `${facet.facet_id}.scope_files`), `${facet.facet_id}.scope_files`);
    exactKeys(facet.coverage, [
      'scope_count', 'concept_count', 'semantic_relation_count',
      'current_ordinary_scope_complete', 'historical_coverage_complete',
      'unknown_or_unresolved', 'reason_codes',
    ], `${facet.facet_id}.coverage`);
    if (asArray(facet.coverage.reason_codes, `${facet.facet_id}.coverage.reason_codes`).length === 0) {
      fail(`${facet.facet_id}.coverage.reason_codes must not be empty`);
    }
  }
  return facets;
}

function validateOrdinaryIndex(index, facets) {
  if (index.status !== 'candidate_fail_closed') fail('ordinary index status must be candidate_fail_closed');
  if (asArray(index.coverage_universes, 'index.coverage_universes').length !== 0) {
    fail('ordinary mode may not carry a self-authored coverage universe');
  }
  for (const facet of facets) {
    const coverage = facet.coverage;
    if (facet.status !== 'not_started' || facet.scope_files.length !== 0
        || coverage.scope_count !== 0 || coverage.concept_count !== 0
        || coverage.semantic_relation_count !== 0
        || coverage.current_ordinary_scope_complete !== false
        || coverage.historical_coverage_complete !== false
        || coverage.unknown_or_unresolved !== true
        || asArray(coverage.reason_codes, `${facet.facet_id}.coverage.reason_codes`).length === 0) {
      fail(`${facet.facet_id} ordinary zero-data state is not fail closed`);
    }
  }
  falseGate(index.release_gate, 'index.release_gate');
}

function normalizeContext(context, allowTestFixture) {
  asObject(context, 'promotion context');
  if (context.context_kind === 'test_fixture_v1') {
    if (!allowTestFixture) fail('test_fixture_v1 promotion context is forbidden in production validation');
  } else if (context.context_kind !== 'immutable_prepared_release_v1') {
    fail('promotion context must come from the immutable release builder');
  } else {
    const frozen = trustedPromotionContexts.get(context);
    if (!frozen) fail('serialized or caller-constructed immutable promotion contexts are forbidden');
    context = frozen;
  }
  exactKeys(context, [
    'context_kind', 'prepared_release', 'source_bindings', 'page_evidence', 'paragraphs', 'coverage_catalog',
  ] , 'promotion context');
  const prepared = context.prepared_release;
  exactKeys(prepared, [
    'git_head', 'source_tree_sha256', 'corpus_release_id', 'corpus_manifest_sha256',
    'corpus_release_fingerprint_sha256',
  ], 'promotion context.prepared_release');
  if (!GIT_SHA.test(String(prepared.git_head || ''))) fail('promotion context.git_head is invalid');
  for (const key of ['source_tree_sha256', 'corpus_manifest_sha256', 'corpus_release_fingerprint_sha256']) {
    asSha(prepared[key], `promotion context.${key}`);
  }
  if (!/^corpus-[a-f0-9]{24}$/u.test(prepared.corpus_release_id || '')) fail('promotion context corpus release id is invalid');
  exactKeys(context.source_bindings, [
    'taxonomy_sha256', 'catalog_sha256', 'provenance_sha256', 'corpus_manifest_file_sha256',
    'reviewer_registry_sha256', 'online_source_registry_sha256', 'online_verification_standard_sha256',
  ], 'promotion context.source_bindings');
  for (const [key, value] of Object.entries(context.source_bindings)) asSha(value, `promotion context.source_bindings.${key}`);
  const pageEvidence = context.page_evidence;
  exactKeys(pageEvidence, ['manifest_sha256', 'policy_revision_sha256', 'pages'], 'promotion context.page_evidence');
  asSha(pageEvidence.manifest_sha256, 'promotion context.page_evidence.manifest_sha256');
  asSha(pageEvidence.policy_revision_sha256, 'promotion context.page_evidence.policy_revision_sha256');
  const paragraphRows = asArray(context.paragraphs, 'promotion context.paragraphs');
  const paragraphKeys = paragraphRows.map((row) => `${row.document_id}\u0000${row.paragraph_ordinal}`);
  unique(paragraphKeys, 'promotion context paragraph identities');
  const pageRows = asArray(pageEvidence.pages, 'promotion context.page_evidence.pages');
  const pageKeys = pageRows.map((row) => `${row.document_id}\u0000${row.physical_page}`);
  unique(pageKeys, 'promotion context page identities');
  const coverageRows = asArray(context.coverage_catalog, 'promotion context.coverage_catalog');
  unique(coverageRows.map((row) => row.document_id), 'promotion context coverage document identities');
  return {
    ...context,
    paragraphs: new Map(paragraphRows.map((row, index) => [paragraphKeys[index], row])),
    pages: new Map(pageRows.map((row, index) => [pageKeys[index], row])),
  };
}

function validateEvidence(scope, evidence, context) {
  exactKeys(evidence, [
    'evidence_id', 'scope_id', 'edition_id', 'document_id', 'physical_page',
    'paragraph_ordinal', 'body_sha256', 'start_utf16', 'end_utf16', 'matched_text',
    'matched_text_sha256', 'canonical_page_evidence', 'prepared_release',
  ], `${scope.scope_id}.${evidence.evidence_id || 'evidence'}`);
  const label = `${scope.scope_id}.${evidence.evidence_id}`;
  asString(evidence.evidence_id, `${label}.evidence_id`);
  if (evidence.scope_id !== scope.scope_id || evidence.edition_id !== scope.edition.edition_id
      || evidence.document_id !== scope.edition.document_id) fail(`${label} scope/edition/document binding mismatch`);
  asSha(evidence.body_sha256, `${label}.body_sha256`);
  asSha(evidence.matched_text_sha256, `${label}.matched_text_sha256`);
  asInteger(evidence.physical_page, `${label}.physical_page`, 1);
  asInteger(evidence.paragraph_ordinal, `${label}.paragraph_ordinal`, 1);
  asInteger(evidence.start_utf16, `${label}.start_utf16`, 0);
  asInteger(evidence.end_utf16, `${label}.end_utf16`, 1);
  if (evidence.end_utf16 <= evidence.start_utf16) fail(`${label} UTF-16 range is empty`);
  const paragraph = context.paragraphs.get(`${evidence.document_id}\u0000${evidence.paragraph_ordinal}`);
  if (!paragraph) fail(`${label} is absent from the immutable prepared corpus`);
  const expectedParagraph = {
    corpus_release_id: context.prepared_release.corpus_release_id,
    document_id: evidence.document_id,
    edition_id: evidence.edition_id,
    paragraph_ordinal: evidence.paragraph_ordinal,
    physical_page: evidence.physical_page,
    body_sha256: evidence.body_sha256,
    citation_allowed: true,
    display_allowed: true,
  };
  for (const [key, expected] of Object.entries(expectedParagraph)) {
    if (paragraph[key] !== expected) fail(`${label} prepared corpus ${key} mismatch`);
  }
  const body = asString(paragraph.body, `${label}.prepared body`);
  if (digest(Buffer.from(body, 'utf8')) !== evidence.body_sha256) fail(`${label} body bytes do not match body_sha256`);
  const matched = body.slice(evidence.start_utf16, evidence.end_utf16);
  if (matched !== evidence.matched_text || digest(Buffer.from(matched, 'utf8')) !== evidence.matched_text_sha256) {
    fail(`${label} exact UTF-16 span does not match immutable corpus bytes`);
  }
  exactKeys(evidence.prepared_release, [
    'git_head', 'source_tree_sha256', 'corpus_release_id', 'corpus_manifest_sha256',
    'corpus_release_fingerprint_sha256',
  ], `${label}.prepared_release`);
  if (stableJson(evidence.prepared_release) !== stableJson(context.prepared_release)) {
    fail(`${label} prepared release identity is not the validator-owned immutable context`);
  }
  const page = context.pages.get(`${evidence.document_id}\u0000${evidence.physical_page}`);
  if (!page || page.citation_allowed !== true || page.display_allowed !== true || page.review_status !== 'accepted') {
    fail(`${label} lacks an accepted canonical page-evidence release result`);
  }
  const ref = evidence.canonical_page_evidence;
  exactKeys(ref, [
    'release_manifest_sha256', 'bundle_sha256', 'signed_reviewer_payload_sha256',
    'reviewer_id', 'reviewed_at', 'online_claim_ids',
  ], `${label}.canonical_page_evidence`);
  for (const key of ['release_manifest_sha256', 'bundle_sha256', 'signed_reviewer_payload_sha256']) {
    asSha(ref[key], `${label}.canonical_page_evidence.${key}`);
  }
  if (ref.release_manifest_sha256 !== context.page_evidence.manifest_sha256
      || ref.bundle_sha256 !== page.bundle_sha256
      || ref.signed_reviewer_payload_sha256 !== page.signed_reviewer_payload_sha256
      || ref.reviewer_id !== page.reviewer_id
      || ref.reviewed_at !== page.reviewed_at) {
    fail(`${label} canonical page/reviewer payload reference differs from the validated release result`);
  }
  const claimIds = unique(asArray(ref.online_claim_ids, `${label}.online_claim_ids`), `${label}.online_claim_ids`);
  if (claimIds.length < 2) fail(`${label} requires at least two independent online claims`);
  const claimById = new Map(asArray(page.online_claims, `${label}.page.online_claims`).map((claim) => [claim.claim_id, claim]));
  const selected = claimIds.map((claimId) => {
    const claim = claimById.get(claimId);
    if (!claim || claim.version_match !== 'exact_document_exact_edition') {
      fail(`${label} online claim ${claimId} is not an exact-edition claim from the canonical bundle`);
    }
    exactSet(Object.keys(claim.version_anchors || {}), [
      'title', 'issuing_body_or_author', 'year_or_publication_context', 'version_label', 'section_or_item_locator',
    ], `${label}.${claimId}.five exact version anchors`);
    for (const key of ['canonical_origin', 'canonical_publisher', 'independence_group']) asString(claim[key], `${label}.${claimId}.${key}`);
    for (const key of ['capture_body_sha256', 'supporting_slice_sha256']) asSha(claim[key], `${label}.${claimId}.${key}`);
    for (const [field, value] of Object.entries(claim.version_anchors)) asString(value, `${label}.${claimId}.version_anchors.${field}`);
    if (!sameVersionAnchor(claim.version_anchors.version_label, scope.edition.version_label)
        || !claim.version_anchors.year_or_publication_context.includes(String(scope.edition.valid_from_year))) {
      fail(`${label} online claim ${claimId} anchors a different scope edition`);
    }
    return claim;
  });
  for (const [key, description] of [
    ['canonical_origin', 'origin'],
    ['canonical_publisher', 'publisher'],
    ['independence_group', 'independence group'],
  ]) {
    if (new Set(selected.map((claim) => claim[key])).size !== selected.length) {
      fail(`${label} online witnesses reuse the same ${description}`);
    }
  }
  return {
    evidence_id: evidence.evidence_id,
    scope_id: scope.scope_id,
    edition_id: scope.edition.edition_id,
    document_id: evidence.document_id,
    physical_page: evidence.physical_page,
    paragraph_ordinal: evidence.paragraph_ordinal,
    body_sha256: evidence.body_sha256,
    start_utf16: evidence.start_utf16,
    end_utf16: evidence.end_utf16,
    matched_text_sha256: evidence.matched_text_sha256,
    page_release_manifest_sha256: context.page_evidence.manifest_sha256,
    page_bundle_sha256: page.bundle_sha256,
    signed_reviewer_payload_sha256: page.signed_reviewer_payload_sha256,
    reviewer_id: page.reviewer_id,
    reviewed_at: page.reviewed_at,
    reviewer_policy_revision_sha256: context.page_evidence.policy_revision_sha256,
    online_claims: selected.map((claim) => ({
      claim_id: claim.claim_id,
      canonical_origin: claim.canonical_origin,
      canonical_publisher: claim.canonical_publisher,
      independence_group: claim.independence_group,
      capture_body_sha256: claim.capture_body_sha256,
      supporting_slice_sha256: claim.supporting_slice_sha256,
      version_anchors: claim.version_anchors,
    })),
    prepared_release: context.prepared_release,
  };
}

export function resolveSubjectOntologyEvidenceForTest(scope, evidence, context) {
  if (context?.context_kind !== 'test_fixture_v1') fail('test evidence resolver accepts test_fixture_v1 only');
  return validateEvidence(scope, evidence, normalizeContext(context, true));
}

export function computeRelationDiffSha256(relation, resolvedEvidenceById) {
  const endpointMaterial = (endpoint) => ({
    scope_id: endpoint.scope_id,
    edition_id: endpoint.edition_id,
    sense_id: endpoint.sense_id,
    evidence: endpoint.evidence_ids.map((evidenceId) => {
      const resolved = resolvedEvidenceById.get(evidenceId);
      if (!resolved) fail(`relation endpoint references unresolved evidence ${evidenceId}`);
      return resolved;
    }),
  });
  return jsonDigest({
    contract: 'subject-ontology-v2-relation-diff-v2',
    relation_id: relation.relation_id,
    relation_type: relation.relation_type,
    assertion_text: relation.assertion_text,
    source_endpoints: relation.source_endpoints.map(endpointMaterial),
    target_endpoints: relation.target_endpoints.map(endpointMaterial),
    review: relation.review,
    cross_subject_exception: relation.cross_subject_exception || null,
  });
}

function validateEndpoint(endpoint, label, scopes, evidenceByScope) {
  exactKeys(endpoint, ['scope_id', 'edition_id', 'sense_id', 'evidence_ids'], label);
  const scope = scopes.get(endpoint.scope_id);
  if (!scope || scope.status !== 'reviewed_release') fail(`${label} scope is not reviewed_release`);
  if (endpoint.edition_id !== scope.edition.edition_id) fail(`${label} edition differs from endpoint scope`);
  const evidenceIds = unique(asArray(endpoint.evidence_ids, `${label}.evidence_ids`), `${label}.evidence_ids`);
  if (evidenceIds.length === 0) fail(`${label} needs bilateral exact-span evidence`);
  const available = evidenceByScope.get(endpoint.scope_id) || new Map();
  for (const evidenceId of evidenceIds) if (!available.has(evidenceId)) fail(`${label} evidence ${evidenceId} belongs to another scope`);
  const concepts = scope.concepts.filter((concept) => concept.sense_id === endpoint.sense_id && concept.status === 'reviewed');
  if (concepts.length !== 1) {
    fail(`${label} sense is not a reviewed endpoint sense`);
  }
  for (const evidenceId of evidenceIds) {
    if (!concepts[0].evidence_ids.includes(evidenceId)) fail(`${label} evidence does not support the named endpoint sense`);
  }
  return scope;
}

function validateRelation(owner, relation, scopes, evidenceByScope, resolvedEvidenceById) {
  exactKeys(relation, [
    'relation_id', 'relation_type', 'assertion_text', 'source_endpoints', 'target_endpoints',
    'relation_diff_sha256', 'review',
  ], `${owner.scope_id}.${relation.relation_id || 'relation'}`, ['cross_subject_exception']);
  if (!RELATION_TYPES.has(relation.relation_type)) fail(`${relation.relation_id} relation_type is invalid`);
  acceptedReview(relation.review, `${relation.relation_id}.review`);
  const sources = asArray(relation.source_endpoints, `${relation.relation_id}.source_endpoints`);
  const targets = asArray(relation.target_endpoints, `${relation.relation_id}.target_endpoints`);
  if (sources.length === 0 || targets.length === 0) fail(`${relation.relation_id} endpoints are empty`);
  if (relation.relation_type === 'split' && (sources.length !== 1 || targets.length < 2)) fail('split requires 1:N endpoints');
  if (relation.relation_type === 'merge' && (sources.length < 2 || targets.length !== 1)) fail('merge requires N:1 endpoints');
  if (!['split', 'merge'].includes(relation.relation_type) && (sources.length !== 1 || targets.length !== 1)) {
    fail(`${relation.relation_type} requires 1:1 endpoints`);
  }
  const endpointScopes = [
    ...sources.map((endpoint, index) => validateEndpoint(endpoint, `${relation.relation_id}.source[${index}]`, scopes, evidenceByScope)),
    ...targets.map((endpoint, index) => validateEndpoint(endpoint, `${relation.relation_id}.target[${index}]`, scopes, evidenceByScope)),
  ];
  const endpointEvidence = [...sources, ...targets].flatMap((endpoint) => endpoint.evidence_ids)
    .map((evidenceId) => resolvedEvidenceById.get(evidenceId));
  const latestEvidenceReview = Math.max(...endpointEvidence.map((evidence) => Date.parse(evidence.reviewed_at)));
  if (Date.parse(relation.review.reviewed_at) < latestEvidenceReview) {
    fail(`${relation.relation_id} review predates its canonical endpoint evidence`);
  }
  const exactEditionScopes = new Set([...sources, ...targets].map((endpoint) => `${endpoint.scope_id}\u0000${endpoint.edition_id}`));
  if (exactEditionScopes.size < 2) fail(`${relation.relation_id} must compare distinct exact-edition scopes`);
  const sourceYears = sources.map((endpoint) => scopes.get(endpoint.scope_id).edition.valid_from_year);
  const targetYears = targets.map((endpoint) => scopes.get(endpoint.scope_id).edition.valid_from_year);
  if (relation.relation_type !== 'coexist' && Math.max(...sourceYears) >= Math.min(...targetYears)) {
    fail(`${relation.relation_id} temporal direction is not source-before-target`);
  }
  if (relation.relation_type === 'coexist') {
    const sourceScope = scopes.get(sources[0].scope_id);
    const targetScope = scopes.get(targets[0].scope_id);
    if (sourceScope.edition.valid_to_year < targetScope.edition.valid_from_year
        || targetScope.edition.valid_to_year < sourceScope.edition.valid_from_year) {
      fail(`${relation.relation_id} coexist editions do not overlap`);
    }
  }
  const dimensions = new Set();
  for (const scope of endpointScopes) {
    if (scope.facet_id !== owner.facet_id) dimensions.add('facet');
    if (scope.subject.subject_id !== owner.subject.subject_id) dimensions.add('subject');
    if (scope.work.work_id !== owner.work.work_id) dimensions.add('work');
  }
  if (dimensions.size > 0) {
    const exception = relation.cross_subject_exception;
    exactKeys(exception, ['dimensions', 'rationale', 'review'], `${relation.relation_id}.cross_subject_exception`);
    exactSet(exception.dimensions, [...dimensions], `${relation.relation_id}.cross_subject_exception.dimensions`);
    asString(exception.rationale, `${relation.relation_id}.cross_subject_exception.rationale`);
    acceptedReview(exception.review, `${relation.relation_id}.cross_subject_exception.review`);
    if (exception.review.reviewer_id === relation.review.reviewer_id) {
      fail(`${relation.relation_id} cross-subject exception needs a distinct second reviewer`);
    }
    if (Date.parse(exception.review.reviewed_at) < Date.parse(relation.review.reviewed_at)) {
      fail(`${relation.relation_id} cross-subject exception review predates the relation review`);
    }
  } else if (relation.cross_subject_exception) {
    fail(`${relation.relation_id} has an unnecessary cross-subject exception`);
  }
  const computed = computeRelationDiffSha256(relation, resolvedEvidenceById);
  if (relation.relation_diff_sha256 !== computed) {
    fail(`${relation.relation_id} diff hash does not bind current endpoints, evidence, online snapshots, reviewer, and policy`);
  }
}

function validateHierarchy(scope) {
  const hierarchies = asArray(scope.hierarchies, `${scope.scope_id}.hierarchies`);
  unique(hierarchies.map((item) => item.family), `${scope.scope_id} hierarchy family records`);
  exactSet(hierarchies.map((item) => item.family), HIERARCHY_FAMILIES, `${scope.scope_id} hierarchy families`);
  const concepts = asArray(scope.concepts, `${scope.scope_id}.concepts`);
  unique(concepts.map((item) => item.concept_id), `${scope.scope_id} concept ids`);
  unique(concepts.map((item) => item.sense_id), `${scope.scope_id} sense ids`);
  for (const hierarchy of hierarchies) {
    exactKeys(hierarchy, ['family', 'status', 'reviewed_complete', 'root_concept_ids', 'reason'], `${scope.scope_id}.${hierarchy.family}`);
    if (!HIERARCHY_FAMILIES.includes(hierarchy.family)) fail(`${scope.scope_id} unknown hierarchy family`);
    if (!['applicable', 'not_applicable', 'unknown'].includes(hierarchy.status)) fail(`${scope.scope_id}.${hierarchy.family} status invalid`);
    const members = concepts.filter((concept) => concept.family === hierarchy.family);
    if (hierarchy.status === 'applicable') {
      if (hierarchy.reviewed_complete !== true || members.length === 0) fail(`${scope.scope_id}.${hierarchy.family} is not deeply reviewed`);
      const roots = unique(asArray(hierarchy.root_concept_ids, 'root_concept_ids'), `${scope.scope_id}.${hierarchy.family} roots`);
      if (roots.length === 0) fail(`${scope.scope_id}.${hierarchy.family} lacks roots`);
      exactSet(roots, members.filter((concept) => concept.parent_concept_id === null).map((concept) => concept.concept_id), `${scope.scope_id}.${hierarchy.family} declared roots`);
    } else if (members.length !== 0 || hierarchy.reviewed_complete !== false || !hierarchy.reason) {
      fail(`${scope.scope_id}.${hierarchy.family} non-applicable/unknown state is inconsistent`);
    }
  }
  for (const concept of concepts) {
    exactKeys(concept, [
      'concept_id', 'family', 'parent_concept_id', 'label', 'sense_id', 'status', 'evidence_ids',
    ], `${scope.scope_id}.${concept.concept_id || 'concept'}`);
    asString(concept.concept_id, `${scope.scope_id}.concept_id`);
    asString(concept.label, `${concept.concept_id}.label`);
    if (!HIERARCHY_FAMILIES.includes(concept.family) || concept.status !== 'reviewed') fail(`${concept.concept_id} is not reviewed`);
    asString(concept.sense_id, `${concept.concept_id}.sense_id`);
    if (concept.parent_concept_id !== null && !concepts.some((item) => item.concept_id === concept.parent_concept_id && item.family === concept.family)) {
      fail(`${concept.concept_id} parent is missing or crosses hierarchy families`);
    }
    const evidenceIds = unique(asArray(concept.evidence_ids, `${concept.concept_id}.evidence_ids`), `${concept.concept_id}.evidence_ids`);
    if (evidenceIds.length === 0) fail(`${concept.concept_id} lacks exact evidence`);
  }
  const conceptById = new Map(concepts.map((concept) => [concept.concept_id, concept]));
  for (const concept of concepts) {
    const lineage = new Set();
    let cursor = concept;
    while (cursor) {
      if (lineage.has(cursor.concept_id)) fail(`${scope.scope_id} hierarchy contains a concept cycle at ${cursor.concept_id}`);
      lineage.add(cursor.concept_id);
      cursor = cursor.parent_concept_id === null ? null : conceptById.get(cursor.parent_concept_id);
    }
  }
}

function validateLineage(scope, scopes, universes, evidenceByScope) {
  const assertion = scope.lineage_assertion;
  exactKeys(assertion, [
    'kind', 'assertion_type', 'assertion_text', 'assertion_sha256', 'predecessor_scope_id',
    'predecessor_edition_id', 'evidence_roles', 'review',
  ], `${scope.scope_id}.lineage_assertion`, ['coverage_universe_id']);
  acceptedReview(assertion.review, `${scope.scope_id}.lineage_assertion.review`);
  if (assertion.assertion_sha256 !== digest(Buffer.from(asString(assertion.assertion_text, 'lineage assertion text'), 'utf8'))) {
    fail(`${scope.scope_id} lineage assertion content hash is stale`);
  }
  const roles = asArray(assertion.evidence_roles, `${scope.scope_id}.lineage.evidence_roles`);
  const checkRole = (role, expectedScope, expectedEdition) => {
    exactKeys(role, ['role', 'scope_id', 'edition_id', 'evidence_ids'], `${scope.scope_id}.lineage role`);
    if (role.scope_id !== expectedScope || role.edition_id !== expectedEdition) fail(`${scope.scope_id} lineage role edition mismatch`);
    const available = evidenceByScope.get(expectedScope) || new Map();
    const evidenceIds = unique(asArray(role.evidence_ids, 'lineage evidence ids'), `${scope.scope_id}.${role.role}.evidence_ids`);
    if (evidenceIds.length === 0) fail(`${scope.scope_id} lineage role ${role.role} lacks exact-edition evidence`);
    for (const evidenceId of evidenceIds) {
      if (!available.has(evidenceId)) fail(`${scope.scope_id} lineage evidence belongs to another exact edition`);
    }
  };
  if (assertion.kind === 'first_edition') {
    if (assertion.assertion_type !== 'first_edition_in_bounded_catalog_universe'
        || assertion.predecessor_scope_id !== null || assertion.predecessor_edition_id !== null
        || roles.length !== 1 || roles[0].role !== 'first_edition_identity') {
      fail(`${scope.scope_id} first-edition assertion lacks dedicated bounded content`);
    }
    const universe = universes.get(assertion.coverage_universe_id);
    if (!universe || universe.purpose !== 'historical_negative_claim'
        || universe.facet_id !== scope.facet_id || !universe.included_scope_ids.includes(scope.scope_id)) {
      fail(`${scope.scope_id} first-edition assertion lacks its independently validated bounded universe`);
    }
    const sameLineage = universe.included_scope_ids.map((scopeId) => scopes.get(scopeId))
      .filter((candidate) => candidate.subject.subject_id === scope.subject.subject_id
        && candidate.work.work_id === scope.work.work_id);
    const earliestYear = Math.min(...sameLineage.map((candidate) => candidate.edition.valid_from_year));
    const earliest = sameLineage.filter((candidate) => candidate.edition.valid_from_year === earliestYear);
    if (scope.edition.valid_from_year < universe.start_year || earliest.length !== 1 || earliest[0].scope_id !== scope.scope_id) {
      fail(`${scope.scope_id} is not the unique earliest exact edition in its bounded lineage universe`);
    }
    checkRole(roles[0], scope.scope_id, scope.edition.edition_id);
  } else if (assertion.kind === 'revision') {
    if (assertion.assertion_type !== 'exact_edition_revision' || roles.length !== 2) fail(`${scope.scope_id} revision assertion is incomplete`);
    const predecessor = scopes.get(assertion.predecessor_scope_id);
    if (!predecessor || predecessor.edition.edition_id !== assertion.predecessor_edition_id
        || predecessor.scope_id === scope.scope_id || predecessor.edition.edition_id === scope.edition.edition_id
        || predecessor.facet_id !== scope.facet_id || predecessor.subject.subject_id !== scope.subject.subject_id
        || predecessor.work.work_id !== scope.work.work_id
        || predecessor.edition.valid_from_year >= scope.edition.valid_from_year
        || predecessor.edition.valid_to_year !== scope.edition.valid_from_year - 1) {
      fail(`${scope.scope_id} revision predecessor is not the distinct exact earlier edition of the same lineage`);
    }
    const byRole = new Map(roles.map((role) => [role.role, role]));
    exactSet([...byRole.keys()], ['predecessor_version', 'current_version'], `${scope.scope_id} lineage roles`);
    checkRole(byRole.get('predecessor_version'), predecessor.scope_id, predecessor.edition.edition_id);
    checkRole(byRole.get('current_version'), scope.scope_id, scope.edition.edition_id);
  } else {
    fail(`${scope.scope_id} unresolved lineage cannot be promoted`);
  }
}

function validateCoverageUniverse(universe, scopes, coverageCatalog) {
  exactKeys(universe, [
    'universe_id', 'facet_id', 'purpose', 'subject_ids', 'start_year', 'end_year',
    'population', 'document_functions', 'included_scope_ids', 'catalog_decisions', 'review',
  ], universe.universe_id || 'coverage universe');
  if (!facetById.has(universe.facet_id)) fail(`${universe.universe_id} facet is invalid`);
  if (!['current_ordinary', 'historical_negative_claim'].includes(universe.purpose)) fail(`${universe.universe_id} purpose invalid`);
  if (universe.population !== 'ordinary_general_education') fail(`${universe.universe_id} population is not ordinary education`);
  asInteger(universe.start_year, `${universe.universe_id}.start_year`, 1900);
  asInteger(universe.end_year, `${universe.universe_id}.end_year`, universe.start_year);
  acceptedReview(universe.review, `${universe.universe_id}.review`);
  const subjectIds = unique(asArray(universe.subject_ids, `${universe.universe_id}.subject_ids`), `${universe.universe_id}.subject_ids`);
  const functions = unique(asArray(universe.document_functions, `${universe.universe_id}.document_functions`), `${universe.universe_id}.document_functions`);
  if (subjectIds.length === 0 || functions.length === 0) fail(`${universe.universe_id} subject/function boundary is empty`);
  for (const subjectId of subjectIds) asString(subjectId, `${universe.universe_id}.subject_id`);
  for (const documentFunction of functions) {
    if (!['curriculum_standard', 'teaching_syllabus', 'assessment_specification'].includes(documentFunction)) {
      fail(`${universe.universe_id} document function ${documentFunction} is outside the ontology evidence boundary`);
    }
  }
  const undated = coverageCatalog.filter((record) => record.coverage_role === 'subject_edition_candidate'
    && record.facet_id === universe.facet_id && subjectIds.includes(record.subject_id) && record.year === null);
  if (undated.length > 0) fail(`${universe.universe_id} cannot freeze chronology while subject catalog records are undated`);
  const relevant = coverageCatalog.filter((record) => record.facet_id === universe.facet_id
    && record.coverage_role === 'subject_edition_candidate'
    && subjectIds.includes(record.subject_id)
    && record.year >= universe.start_year && record.year <= universe.end_year);
  const decisions = asArray(universe.catalog_decisions, `${universe.universe_id}.catalog_decisions`);
  unique(decisions.map((decision) => decision.document_id), `${universe.universe_id}.catalog_decisions`);
  exactSet(decisions.map((decision) => decision.document_id), relevant.map((record) => record.document_id), `${universe.universe_id} independent catalog coverage`);
  const recordById = new Map(relevant.map((record) => [record.document_id, record]));
  const includedDocumentIds = [];
  for (const decision of decisions) {
    exactKeys(decision, ['document_id', 'disposition', 'reason_code'], `${universe.universe_id}.${decision.document_id}`);
    const record = recordById.get(decision.document_id);
    if (decision.disposition === 'included') {
      if (decision.reason_code !== 'included_exact_scope' || record.population !== universe.population
          || !functions.includes(record.document_function) || record.provenance_count < 1) {
        fail(`${universe.universe_id}.${decision.document_id} is not independently eligible for inclusion`);
      }
      includedDocumentIds.push(decision.document_id);
    } else if (decision.disposition === 'excluded') {
      const justified = (decision.reason_code === 'different_population' && record.population !== universe.population)
        || (decision.reason_code === 'different_document_function' && !functions.includes(record.document_function))
        || (decision.reason_code === 'insufficient_provenance' && record.provenance_count < 1)
        || (decision.reason_code === 'exact_duplicate_alias' && record.exact_duplicate_alias === true);
      if (!justified) fail(`${universe.universe_id}.${decision.document_id} exclusion reason is not derived from the frozen catalog/provenance`);
    } else {
      fail(`${universe.universe_id}.${decision.document_id} disposition is invalid`);
    }
  }
  const includedScopes = unique(asArray(universe.included_scope_ids, `${universe.universe_id}.included_scope_ids`), `${universe.universe_id}.included_scope_ids`)
    .map((scopeId) => scopes.get(scopeId));
  if (includedScopes.some((scope) => !scope)) fail(`${universe.universe_id} references an absent scope`);
  if (includedScopes.some((scope) => scope.facet_id !== universe.facet_id || !subjectIds.includes(scope.subject.subject_id))) {
    fail(`${universe.universe_id} includes a scope from another facet or subject`);
  }
  exactSet(includedScopes.map((scope) => scope.edition.document_id), includedDocumentIds, `${universe.universe_id} included scope/catalog identity`);
  for (const subjectId of subjectIds) {
    const intervals = includedScopes.filter((scope) => scope.subject.subject_id === subjectId)
      .map((scope) => [scope.edition.valid_from_year, scope.edition.valid_to_year])
      .sort((left, right) => left[0] - right[0]);
    if (intervals.length === 0 || intervals[0][0] > universe.start_year) {
      fail(`${universe.universe_id} has no start coverage for subject ${subjectId}`);
    }
    let coveredThrough = universe.start_year - 1;
    for (const [start, end] of intervals) {
      if (start > coveredThrough + 1) fail(`${universe.universe_id} has a per-subject gap for ${subjectId}`);
      coveredThrough = Math.max(coveredThrough, end);
    }
    if (coveredThrough < universe.end_year) fail(`${universe.universe_id} has no end coverage for subject ${subjectId}`);
  }
  return universe;
}

function validateScopeShape(scope, facet) {
  exactKeys(scope, [
    'schema_version', 'artifact_kind', 'contract_id', 'scope_id', 'facet_id', 'subject', 'work',
    'edition', 'scope_dimensions', 'status', 'lineage_assertion', 'hierarchies', 'concepts',
    'evidence', 'relations', 'coverage', 'unresolved_items', 'release_gate', 'review',
  ], scope.scope_id || 'scope', ['$schema']);
  if (scope.schema_version !== 2 || scope.artifact_kind !== 'subject_ontology_scope'
      || scope.contract_id !== 'subject-ontology-v2' || scope.facet_id !== facet.facet_id) fail('scope identity is invalid');
  asString(scope.scope_id, 'scope.scope_id');
  exactKeys(scope.subject, ['source_label', 'canonical_label', 'subject_id'], `${scope.scope_id}.subject`);
  for (const key of ['source_label', 'canonical_label', 'subject_id']) asString(scope.subject[key], `${scope.scope_id}.subject.${key}`);
  exactKeys(scope.work, ['work_id', 'title'], `${scope.scope_id}.work`);
  asString(scope.work.work_id, `${scope.scope_id}.work.work_id`);
  asString(scope.work.title, `${scope.scope_id}.work.title`);
  exactKeys(scope.edition, [
    'edition_id', 'document_id', 'version_label', 'issued_date', 'source_artifact_sha256',
    'valid_from_year', 'valid_to_year',
  ], `${scope.scope_id}.edition`);
  for (const key of ['edition_id', 'document_id', 'version_label']) asString(scope.edition[key], `${scope.scope_id}.edition.${key}`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(scope.edition.issued_date || ''))
      || Number.isNaN(Date.parse(`${scope.edition.issued_date}T00:00:00Z`))) fail(`${scope.scope_id}.edition.issued_date is invalid`);
  asSha(scope.edition.source_artifact_sha256, `${scope.scope_id}.edition.source_artifact_sha256`);
  asInteger(scope.edition.valid_from_year, `${scope.scope_id}.edition.valid_from_year`, 1900);
  asInteger(scope.edition.valid_to_year, `${scope.scope_id}.edition.valid_to_year`, scope.edition.valid_from_year);
  if (scope.edition.valid_to_year < scope.edition.valid_from_year) fail(`${scope.scope_id} edition validity interval is reversed`);
  exactKeys(scope.scope_dimensions, ['population', 'document_function', 'stage'], `${scope.scope_id}.scope_dimensions`);
  for (const key of ['population', 'document_function', 'stage']) asString(scope.scope_dimensions[key], `${scope.scope_id}.scope_dimensions.${key}`);
  if (scope.status !== 'reviewed_release') fail(`${scope.scope_id} is not reviewed_release`);
  acceptedReview(scope.review, `${scope.scope_id}.review`);
  if (asArray(scope.unresolved_items, `${scope.scope_id}.unresolved_items`).length !== 0) fail(`${scope.scope_id} has unresolved items`);
  validateHierarchy(scope);
}

function validateScopeTaxonomy(scope, coverageCatalog) {
  const record = coverageCatalog.find((candidate) => candidate.document_id === scope.edition.document_id);
  if (!record || record.coverage_role !== 'subject_edition_candidate' || record.facet_eligible !== true) {
    fail(`${scope.scope_id} edition document is not a facet-eligible subject edition in the frozen catalog`);
  }
  if (record.facet_id !== scope.facet_id
      || record.source_label !== scope.subject.source_label
      || record.subject_label !== scope.subject.canonical_label
      || record.subject_id !== scope.subject.subject_id) fail(`${scope.scope_id} subject/facet does not resolve from pinned taxonomy`);
  if (record.edition_id !== scope.edition.edition_id
      || record.version_label !== scope.edition.version_label
      || record.issued_date !== scope.edition.issued_date
      || record.source_artifact_sha256 !== scope.edition.source_artifact_sha256
      || record.year !== scope.edition.valid_from_year) fail(`${scope.scope_id} exact edition differs from frozen catalog identity`);
  if (record.population !== scope.scope_dimensions.population
      || record.document_function !== scope.scope_dimensions.document_function
      || record.stage !== scope.scope_dimensions.stage) fail(`${scope.scope_id} scope dimensions differ from frozen catalog classification`);
}

function validateCoverageClaim(scope, universes) {
  exactKeys(scope.coverage, [
    'current_ordinary_status', 'current_ordinary_universe_id', 'historical_status',
    'historical_universe_id', 'negative_claim_eligible',
  ], `${scope.scope_id}.coverage`);
  if (!['human_reviewed_complete', 'incomplete_unknown'].includes(scope.coverage.current_ordinary_status)
      || !['human_reviewed_complete', 'incomplete_unknown'].includes(scope.coverage.historical_status)) {
    fail(`${scope.scope_id} coverage status is invalid`);
  }
  const current = universes.get(scope.coverage.current_ordinary_universe_id);
  const historical = universes.get(scope.coverage.historical_universe_id);
  if (scope.coverage.current_ordinary_status === 'human_reviewed_complete') {
    if (!current || current.purpose !== 'current_ordinary' || current.facet_id !== scope.facet_id
        || !current.included_scope_ids.includes(scope.scope_id)) fail(`${scope.scope_id} current coverage is not independently proved`);
  } else if (scope.coverage.current_ordinary_universe_id !== null) fail(`${scope.scope_id} incomplete current coverage may not cite a universe`);
  if (scope.coverage.historical_status === 'human_reviewed_complete') {
    if (!historical || historical.purpose !== 'historical_negative_claim' || historical.facet_id !== scope.facet_id
        || !historical.included_scope_ids.includes(scope.scope_id)) fail(`${scope.scope_id} historical coverage is not independently proved`);
  } else if (scope.coverage.historical_universe_id !== null) fail(`${scope.scope_id} incomplete historical coverage may not cite a universe`);
  const eligible = scope.coverage.historical_status === 'human_reviewed_complete' && Boolean(historical);
  if (scope.coverage.negative_claim_eligible !== eligible) fail(`${scope.scope_id} negative-claim eligibility is self-reported incorrectly`);
}

export function validateSubjectOntologyState({
  index,
  scopes = [],
  mode = 'ordinary',
  context = null,
  artifacts,
  allowTestFixture = false,
} = {}) {
  exactKeys(index, [
    'schema_version', 'artifact_kind', 'contract_id', 'status', 'bindings',
    'canonical_facets', 'coverage_universes', 'release_gate',
  ], 'index', ['$schema']);
  if (index.schema_version !== 2 || index.artifact_kind !== 'subject_ontology_index'
      || index.contract_id !== 'subject-ontology-v2') fail('index contract identity is invalid');
  const facets = validateFacetIdentity(index);
  if (mode === 'ordinary') {
    if (scopes.length !== 0) fail('ordinary validation cannot receive scope artifacts');
    validateOrdinaryIndex(index, facets);
    return { valid: true, publishable: false, facets: 12, scopes: 0, coverage_universes: 0, concepts: 0, relations: 0 };
  }
  if (mode !== 'promotion') fail('mode must be ordinary or promotion');
  const normalizedContext = normalizeContext(context, allowTestFixture);
  if (index.status !== 'promotion_candidate') fail('promotion index status must be promotion_candidate');
  if (index.bindings.taxonomy.sha256 !== normalizedContext.source_bindings.taxonomy_sha256
      || index.bindings.catalog.sha256 !== normalizedContext.source_bindings.catalog_sha256
      || index.bindings.provenance.sha256 !== normalizedContext.source_bindings.provenance_sha256
      || index.bindings.corpus_manifest.sha256 !== normalizedContext.source_bindings.corpus_manifest_file_sha256
      || index.bindings.reviewer_registry.sha256 !== normalizedContext.source_bindings.reviewer_registry_sha256
      || index.bindings.online_source_registry.sha256 !== normalizedContext.source_bindings.online_source_registry_sha256
      || index.bindings.online_verification_standard.sha256 !== normalizedContext.source_bindings.online_verification_standard_sha256
      || index.bindings.corpus_manifest.release_id !== normalizedContext.prepared_release.corpus_release_id
      || index.bindings.corpus_manifest.manifest_sha256 !== normalizedContext.prepared_release.corpus_manifest_sha256
      || index.bindings.corpus_manifest.release_fingerprint_sha256 !== normalizedContext.prepared_release.corpus_release_fingerprint_sha256
      || index.bindings.page_evidence_manifest.sha256 !== normalizedContext.page_evidence.manifest_sha256) {
    fail('promotion context differs from index-bound corpus/page release identities');
  }
  const scopeMap = new Map();
  for (const scope of scopes) {
    if (scopeMap.has(scope.scope_id)) fail(`duplicate scope ${scope.scope_id}`);
    scopeMap.set(scope.scope_id, scope);
  }
  const expectedPaths = facets.flatMap((facet) => facet.scope_files);
  unique(expectedPaths, 'global registry scope files');
  if (expectedPaths.length !== scopes.length) fail('loaded scope count differs from index registry');
  unique(scopes.map((scope) => scope.__registry_path), 'loaded registry scope paths');
  const scopeByPath = new Map(scopes.map((scope) => [scope.__registry_path, scope]));
  exactSet([...scopeByPath.keys()], expectedPaths, 'registry scope files');
  for (const facet of facets) {
    for (const scopePath of facet.scope_files) {
      const scope = scopeByPath.get(scopePath);
      validateScopeShape(scope, facet);
      validateScopeTaxonomy(scope, normalizedContext.coverage_catalog);
    }
  }
  const universes = new Map();
  for (const universe of asArray(index.coverage_universes, 'index.coverage_universes')) {
    if (universes.has(universe.universe_id)) fail(`duplicate coverage universe ${universe.universe_id}`);
    universes.set(universe.universe_id, validateCoverageUniverse(universe, scopeMap, normalizedContext.coverage_catalog));
  }
  const resolvedEvidenceById = new Map();
  const evidenceByScope = new Map();
  for (const scope of scopes) {
    const scopeEvidence = new Map();
    for (const evidence of asArray(scope.evidence, `${scope.scope_id}.evidence`)) {
      if (resolvedEvidenceById.has(evidence.evidence_id)) fail(`duplicate global evidence id ${evidence.evidence_id}`);
      const resolved = validateEvidence(scope, evidence, normalizedContext);
      resolvedEvidenceById.set(evidence.evidence_id, resolved);
      scopeEvidence.set(evidence.evidence_id, resolved);
    }
    evidenceByScope.set(scope.scope_id, scopeEvidence);
  }
  for (const scope of scopes) {
    for (const concept of scope.concepts) {
      for (const evidenceId of concept.evidence_ids) {
        if (!evidenceByScope.get(scope.scope_id).has(evidenceId)) fail(`${concept.concept_id} evidence crosses exact-edition scope`);
      }
    }
    const scopeEvidence = [...evidenceByScope.get(scope.scope_id).values()];
    const latestEvidenceReview = Math.max(...scopeEvidence.map((evidence) => Date.parse(evidence.reviewed_at)));
    if (scopeEvidence.length === 0 || Date.parse(scope.review.reviewed_at) < latestEvidenceReview) {
      fail(`${scope.scope_id} review predates or lacks canonical scope evidence`);
    }
    validateCoverageClaim(scope, universes);
  }
  for (const scope of scopes) validateLineage(scope, scopeMap, universes, evidenceByScope);
  for (const scope of scopes) {
    for (const relation of scope.relations) validateRelation(scope, relation, scopeMap, evidenceByScope, resolvedEvidenceById);
    openGate(scope.release_gate, `${scope.scope_id}.release_gate`, { negative: scope.coverage.negative_claim_eligible });
  }
  for (const facet of facets) {
    const owned = scopes.filter((scope) => scope.facet_id === facet.facet_id);
    const concepts = owned.reduce((total, scope) => total + scope.concepts.length, 0);
    const relations = owned.reduce((total, scope) => total + scope.relations.length, 0);
    if (facet.coverage.scope_count !== owned.length || facet.coverage.concept_count !== concepts
        || facet.coverage.semantic_relation_count !== relations) fail(`${facet.facet_id} declared counts are stale`);
    const currentComplete = owned.length > 0 && owned.every((scope) => scope.coverage.current_ordinary_status === 'human_reviewed_complete');
    const historicalComplete = owned.length > 0 && owned.every((scope) => scope.coverage.historical_status === 'human_reviewed_complete');
    if (facet.coverage.current_ordinary_scope_complete !== currentComplete
        || facet.coverage.historical_coverage_complete !== historicalComplete
        || facet.coverage.unknown_or_unresolved !== !historicalComplete
        || facet.status !== (owned.length ? 'reviewed_release' : 'not_started')) {
      fail(`${facet.facet_id} coverage status is self-reported incorrectly`);
    }
  }
  if (scopes.length === 0) fail('explicit promotion requires at least one reviewed scope');
  openGate(index.release_gate, 'index.release_gate', {
    negative: scopes.every((scope) => scope.coverage.negative_claim_eligible),
  });
  return {
    valid: true,
    publishable: true,
    facets: 12,
    scopes: scopes.length,
    coverage_universes: universes.size,
    concepts: scopes.reduce((total, scope) => total + scope.concepts.length, 0),
    relations: scopes.reduce((total, scope) => total + scope.relations.length, 0),
  };
}

function loadRegisteredScopes(rootDir, facets) {
  const scopes = [];
  for (const facet of facets) {
    for (const registryPath of facet.scope_files) {
      const expectedPrefix = `${facet.directory}/`;
      if (!registryPath.startsWith(expectedPrefix)) fail(`${facet.facet_id} scope path crosses facet directory`);
      const fullPath = `data/ontologies/${registryPath.replace(/^\.\//u, '')}`;
      const artifact = safeRead(rootDir, fullPath, `${facet.facet_id} scope`);
      const scope = JSON.parse(artifact.buffer.toString('utf8'));
      Object.defineProperty(scope, '__registry_path', { value: registryPath, enumerable: false });
      scopes.push(scope);
    }
  }
  return scopes;
}

export function computeSubjectOntologyV2Report({ rootDir = process.cwd(), pageEvidenceValidator = validatePageEvidenceForRelease } = {}) {
  const indexArtifact = safeRead(rootDir, 'data/ontologies/index.json', 'subject ontology index');
  const schemaArtifact = safeRead(rootDir, 'data/schemas/subject-ontology-v2.schema.json', 'subject ontology schema');
  const index = JSON.parse(indexArtifact.buffer.toString('utf8'));
  const artifacts = validateBindings(rootDir, index);
  const pageEvidence = pageEvidenceValidator({ root: rootDir, pageEvidencePromotion: false });
  if (pageEvidence.valid !== true || pageEvidence.publishable !== false
      || pageEvidence.manifest.sha256 !== artifacts.page_evidence_manifest.sha256) {
    fail('ordinary ontology contract is not bound to the canonical nonpublishable page-evidence result');
  }
  const facets = validateFacetIdentity(index);
  const scopes = loadRegisteredScopes(rootDir, facets);
  const summary = validateSubjectOntologyState({ index, scopes, mode: 'ordinary', artifacts });
  const coverageCatalog = buildIndependentCoverageCatalog({
    catalog: artifacts.catalog.json,
    taxonomy: artifacts.taxonomy.json,
    provenance: artifacts.provenance.json,
  });
  return {
    schema_version: 1,
    artifact_kind: 'subject_ontology_v2_validation_report',
    contract_id: 'subject-ontology-v2',
    mode: 'ordinary_nonpublishable',
    valid: true,
    publishable: false,
    index: { path: indexArtifact.path, sha256: indexArtifact.sha256, bytes: indexArtifact.bytes },
    schema: { path: schemaArtifact.path, sha256: schemaArtifact.sha256, bytes: schemaArtifact.bytes },
    dependencies: {
      taxonomy_sha256: artifacts.taxonomy.sha256,
      catalog_sha256: artifacts.catalog.sha256,
      provenance_sha256: artifacts.provenance.sha256,
      corpus_manifest_sha256: artifacts.corpus_manifest.sha256,
      corpus_release_id: artifacts.corpus_manifest.json.release_id,
      corpus_release_fingerprint_sha256: artifacts.corpus_manifest.json.release_fingerprint_sha256,
      page_evidence_manifest_sha256: pageEvidence.manifest.sha256,
      page_evidence_status: pageEvidence.status,
      signed_reviewer_registry_sha256: artifacts.reviewer_registry.sha256,
      external_online_source_registry_sha256: artifacts.online_source_registry.sha256,
      online_verification_standard_sha256: artifacts.online_verification_standard.sha256,
      independent_coverage_catalog_sha256: jsonDigest(coverageCatalog),
      independent_coverage_catalog_records: coverageCatalog.length,
    },
    counts: summary,
    release_boundary: {
      candidate_fail_closed: true,
      frontend_consumer_allowed: false,
      r2_consumer_allowed: false,
      explicit_promotion_required: true,
      same_commit_scope_evidence_self_attestation_allowed: false,
    },
  };
}

export function validateSubjectOntologyV2({
  rootDir = process.cwd(),
  reportPolicy = 'require_exact',
  pageEvidenceValidator = validatePageEvidenceForRelease,
} = {}) {
  const report = computeSubjectOntologyV2Report({ rootDir, pageEvidenceValidator });
  if (reportPolicy === 'require_exact') {
    const actual = safeRead(rootDir, 'data/subject-ontology-v2-validation.json', 'subject ontology validation report');
    const expected = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
    if (!actual.buffer.equals(expected)) fail('subject ontology validation report is stale; regenerate and review it');
    return { ...report, report: { path: actual.path, sha256: actual.sha256, bytes: actual.bytes } };
  }
  if (reportPolicy !== 'compute_only') fail('reportPolicy must be require_exact or compute_only');
  return report;
}

function parseArgs(argv) {
  const args = { rootDir: process.cwd(), printReport: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--print-report') {
      args.printReport = true;
      continue;
    }
    if (argument !== '--root') fail(`unexpected argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`missing value for ${argument}`);
    args.rootDir = value;
    index += 1;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = args.printReport
    ? computeSubjectOntologyV2Report({ rootDir: args.rootDir })
    : validateSubjectOntologyV2({ rootDir: args.rootDir });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`subject-ontology-v2: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
