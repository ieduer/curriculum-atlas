#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DISPLAY_SUBJECT_FACETS,
  STORAGE_SUBJECT_FACETS,
  publicSubjectFacet,
} from '../public/subject-facets.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const checkOnly = process.argv.includes('--check');
const paths = {
  lifecycle: path.join(ROOT, 'public/data/discipline-lifecycle.json'),
  families: path.join(ROOT, 'public/data/concept-evolution-families.json'),
  core: path.join(ROOT, 'public/data/concept-evolution.json'),
  ocr: path.join(ROOT, 'public/data/ocr-observation-layer.json'),
  detail: path.join(ROOT, 'public/data/subject-detail-observation-layer.json'),
  pre2001: path.join(ROOT, 'public/data/pre2001-subject-detail-observation-layer.json'),
  century: path.join(ROOT, 'public/data/century-observation-layer.json'),
  triage: path.join(ROOT, 'data/ocr-review-triage.json'),
  fallback: path.join(ROOT, 'data/ocr-candidate-fallback-ledger.json'),
  publicOcrSummary: path.join(ROOT, 'public/data/ocr-coverage-summary.json'),
  app: path.join(ROOT, 'public/app.js'),
  atlas: path.join(ROOT, 'public/atlas.js'),
  html: path.join(ROOT, 'public/index.html'),
  styles: path.join(ROOT, 'public/styles.css'),
  mark: path.join(ROOT, 'public/assets/century-curriculum-mark.jpg'),
  receipt: path.join(ROOT, 'data/century-model-validation.json'),
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const source = {};
for (const [key, filename] of Object.entries(paths)) {
  if (key === 'receipt') continue;
  source[key] = await readFile(filename);
}
const json = (key) => JSON.parse(source[key].toString('utf8'));
const lifecycle = json('lifecycle');
const families = json('families');
const triage = json('triage');
const fallback = json('fallback');
const publicOcrSummary = json('publicOcrSummary');
const layers = [
  json('core'),
  json('ocr'),
  json('detail'),
  json('pre2001'),
  json('century').star_projection,
];
const episodes = layers.flatMap((layer) => layer.episodes || []);
const evidenceIds = new Set(layers.flatMap((layer) => (layer.evidence || []).map((item) => item.id)));
const episodeById = new Map(episodes.map((episode) => [episode.id, episode]));
const checks = [];
function record(id, passed, observed, expected) {
  checks.push({ id, passed: Boolean(passed), observed, expected });
}

record('facets.public_merged_exact',
  DISPLAY_SUBJECT_FACETS.length === 11
    && DISPLAY_SUBJECT_FACETS.includes('历史')
    && !DISPLAY_SUBJECT_FACETS.includes('历史与社会'),
  DISPLAY_SUBJECT_FACETS,
  ['语文', '数学', '外语', '思想政治与道德法治', '历史', '地理', '科学类', '技术', '劳动', '艺术', '体育与健康']);
record('facets.storage_identity_preserved',
  STORAGE_SUBJECT_FACETS.length === 12
    && STORAGE_SUBJECT_FACETS.includes('历史')
    && STORAGE_SUBJECT_FACETS.includes('历史与社会')
    && publicSubjectFacet('历史与社会') === '历史',
  STORAGE_SUBJECT_FACETS,
  '12 canonical storage facets projected to 11 public facets');
record('lifecycle.public_facets_exact',
  JSON.stringify(lifecycle.public_subject_facets) === JSON.stringify(DISPLAY_SUBJECT_FACETS),
  lifecycle.public_subject_facets,
  DISPLAY_SUBJECT_FACETS);
const sourceIds = new Set(lifecycle.sources.map((item) => item.id));
const invalidEvents = lifecycle.events.filter((event) =>
  !Number.isInteger(event.year)
  || !event.source_ids?.length
  || event.source_ids.some((id) => !sourceIds.has(id))
  || !event.public_facets?.length
  || event.public_facets.some((facet) => !DISPLAY_SUBJECT_FACETS.includes(facet))
  || !event.claim_boundary);
record('lifecycle.events_source_bound', invalidEvents.length === 0,
  invalidEvents.map((item) => item.id), []);
const historyEventTypes = new Set(lifecycle.events
  .filter((event) => event.public_facets.includes('历史'))
  .map((event) => event.event_type));
record('lifecycle.history_deep_model',
  ['integrated_grouping', 'alternative_integrated_or_separate', 'parallel_standard_paths', 'national_standard_set_adjusted']
    .every((type) => historyEventTypes.has(type)),
  [...historyEventTypes].sort(),
  ['integrated_grouping', 'alternative_integrated_or_separate', 'parallel_standard_paths', 'national_standard_set_adjusted']);

const requiredTiers = [
  'subject-course-identity',
  'subject-practice-domain',
  'subject-content-domain',
  'subject-ability-domain',
];
const missingDeepModels = [];
for (const facet of DISPLAY_SUBJECT_FACETS) {
  for (const tier of requiredTiers) {
    const matches = families.families.filter((family) =>
      family.concept_tier_id === tier
      && family.visibility_facets.some((candidate) => publicSubjectFacet(candidate) === facet)
      && family.episode_count > 0
      && family.observed_concepts.length > 0);
    if (!matches.length) missingDeepModels.push(`${facet}:${tier}`);
  }
}
record('deep_model.all_public_facets_four_tiers',
  missingDeepModels.length === 0,
  { missing: missingDeepModels, ready_facets: DISPLAY_SUBJECT_FACETS.length },
  { missing: [], ready_facets: 11 });
const unresolvedMemberships = families.episode_memberships.filter((membership) => !episodeById.has(membership.episode_id));
record('deep_model.memberships_resolve_episodes',
  unresolvedMemberships.length === 0,
  unresolvedMemberships.slice(0, 20),
  []);
const evidenceFailures = episodes.filter((episode) =>
  !episode.evidence_ids?.length || episode.evidence_ids.some((id) => !evidenceIds.has(id)));
record('deep_model.every_episode_resolves_evidence',
  evidenceFailures.length === 0,
  evidenceFailures.slice(0, 20).map((item) => item.id),
  []);
const historyCourseFamilies = families.families.filter((family) =>
  family.concept_tier_id === 'subject-course-identity'
  && family.visibility_facets.some((facet) => ['历史', '历史与社会'].includes(facet)));
record('deep_model.history_forms_preserved',
  historyCourseFamilies.length === 2
    && historyCourseFamilies.some((family) => family.visibility_facets.includes('历史'))
    && historyCourseFamilies.some((family) => family.visibility_facets.includes('历史与社会')),
  historyCourseFamilies.map((family) => ({ id: family.id, facets: family.visibility_facets })),
  'two storage families in one public history model');

record('ocr.triage_exhaustive',
  triage.counts.audited_dual_witness_pages === 6947
    && triage.counts.unclassified_pages === 0
    && triage.root_cause.affected_pages === 6947,
  triage.counts,
  { audited_dual_witness_pages: 6947, unclassified_pages: 0, root_cause_pages: 6947 });
record('ocr.fallback_candidate_coverage_complete',
  fallback.counts.pages === 1077
    && fallback.counts.candidate_gap_pages_remaining === 0
    && fallback.policy.citation_allowed === false
    && fallback.policy.semantic_claim_allowed === false,
  fallback.counts,
  { pages: 1077, candidate_gap_pages_remaining: 0 });
record('ocr.public_summary_fail_closed',
  publicOcrSummary.coverage.candidate_covered_pages === 11847
    && publicOcrSummary.coverage.candidate_remaining_pages === 0
    && publicOcrSummary.coverage.dual_witness_audited_pages === 6947
    && publicOcrSummary.release_gate.citation_allowed === false
    && publicOcrSummary.release_gate.semantic_promotion_allowed === false,
  {
    covered: publicOcrSummary.coverage.candidate_covered_pages,
    remaining: publicOcrSummary.coverage.candidate_remaining_pages,
    triaged: publicOcrSummary.coverage.dual_witness_audited_pages,
    release_gate: publicOcrSummary.release_gate,
  },
  { covered: 11847, remaining: 0, triaged: 6947, citation_allowed: false });

const app = source.app.toString('utf8');
const atlas = source.atlas.toString('utf8');
const html = source.html.toString('utf8');
const styles = source.styles.toString('utf8');
record('ui.brand_and_title',
  html.includes('assets/century-curriculum-mark.jpg')
    && html.includes('<b>百年课标</b>')
    && !html.includes('课程标准演变</b>')
    && !html.includes('20世纪—今天'),
  'brand HTML',
  'JPG mark and 百年课标 only');
record('ui.inspector_avoids_selection',
  app.includes('function positionInspector(')
    && atlas.includes('getEpisodeScreenPosition(')
    && styles.includes('.star-inspector.dock-left')
    && styles.includes('.star-inspector.dock-right')
    && styles.includes('.star-inspector.overlap-softened'),
  'edge-aware inspector hooks',
  'opposite-edge docking plus translucent fallback');
record('ui.dynamic_year_reveal',
  app.includes('function startCenturyReveal(')
    && app.includes('firstYear')
    && app.includes('requestAnimationFrame(reveal)')
    && app.includes("prefers-reduced-motion: reduce"),
  'entry animation hooks',
  '1902 to latest monotonic reveal with reduced-motion path');
record('ui.deep_year_link',
  app.includes('function linkConceptYears(')
    && html.includes('id="concept-year-links"')
    && app.includes('data-concept-year'),
  'concept-year linking hooks',
  'single bottom time axis linked to deep model');
record('ui.discipline_lifecycle_below_modes',
  html.indexOf('id="discipline-lifecycle"') > html.indexOf('class="mode-switch"')
    && html.indexOf('id="discipline-lifecycle"') < html.indexOf('class="research-dock"'),
  'discipline lifecycle DOM order',
  'directly below three map modes');
record('ui.no_dashed_primitives',
  ![app, atlas, styles, source.lifecycle.toString('utf8')].join('\n')
    .match(/stroke-dasharray|setLineDash|candidate_dashed|warning_dashed/),
  'visual source scan',
  'no dashed lines');
record('asset.brand_jpeg_bounded',
  source.mark[0] === 0xff && source.mark[1] === 0xd8 && source.mark.length <= 90 * 1024,
  { bytes: source.mark.length, sha256: sha256(source.mark) },
  { format: 'jpeg', max_bytes: 92160 });

const passed = checks.every((check) => check.passed);
const receipt = {
  schema_version: 1,
  standard_id: 'curriculum-atlas-century-model-v15',
  passed,
  counts: {
    checks: checks.length,
    passed: checks.filter((check) => check.passed).length,
    failed: checks.filter((check) => !check.passed).length,
    public_subject_facets: DISPLAY_SUBJECT_FACETS.length,
    storage_subject_facets: STORAGE_SUBJECT_FACETS.length,
    deep_model_ready_facets: DISPLAY_SUBJECT_FACETS.length - new Set(missingDeepModels.map((item) => item.split(':')[0])).size,
    lifecycle_events: lifecycle.events.length,
    candidate_fallback_pages: fallback.counts.pages,
    dual_witness_triaged_pages: triage.counts.audited_dual_witness_pages,
  },
  fingerprints: Object.fromEntries(Object.entries(source).map(([key, value]) => [key, sha256(value)])),
  checks,
};
const serialized = stable(receipt);
if (checkOnly) {
  const actual = await readFile(paths.receipt, 'utf8');
  if (actual !== serialized) throw new Error('checked-in century-model validation receipt is stale');
} else {
  await writeFile(paths.receipt, serialized);
}
if (!passed) {
  const failed = checks.filter((check) => !check.passed).map((check) => check.id);
  throw new Error(`century model validation failed: ${failed.join(', ')}`);
}
process.stdout.write(`Century model validation passed: ${receipt.counts.passed}/${receipt.counts.checks}; ${receipt.counts.deep_model_ready_facets}/11 deep models ready.\n`);
