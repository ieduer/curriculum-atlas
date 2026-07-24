#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CURRICULUM_STAGES } from '../public/historical-stages.js';
import {
  DISPLAY_SUBJECT_FACETS,
  STORAGE_SUBJECT_FACETS,
  publicSubjectFacet,
} from '../public/subject-facets.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const checkOnly = process.argv.includes('--check');
const paths = {
  standard: resolve(root, 'data/data-quality-standard.json'),
  candidateSchema: resolve(root, 'data/candidate-observation-layer.schema.json'),
  coverage: resolve(root, 'data/ocr-coverage-ledger.json'),
  candidateFallback: resolve(root, 'data/ocr-candidate-fallback-ledger.json'),
  reviewTriage: resolve(root, 'data/ocr-review-triage.json'),
  machinePolicy: resolve(root, 'data/ocr-machine-verification-policy.json'),
  machineVerification: resolve(root, 'data/ocr-machine-verification.json'),
  lifecycle: resolve(root, 'public/data/discipline-lifecycle.json'),
  releaseDiff: resolve(root, 'data/release-episode-diff.json'),
  performanceBudget: resolve(root, 'data/star-map-performance-budget.json'),
  performanceValidation: resolve(root, 'data/star-map-performance-validation.json'),
  familiesConfig: resolve(root, 'data/concept-evolution-families.json'),
  families: resolve(root, 'public/data/concept-evolution-families.json'),
  core: resolve(root, 'public/data/concept-evolution.json'),
  ocr: resolve(root, 'public/data/ocr-observation-layer.json'),
  detail: resolve(root, 'public/data/subject-detail-observation-layer.json'),
  pre2001: resolve(root, 'public/data/pre2001-subject-detail-observation-layer.json'),
  century: resolve(root, 'public/data/century-observation-layer.json'),
  app: resolve(root, 'public/app.js'),
  atlas: resolve(root, 'public/atlas.js'),
  styles: resolve(root, 'public/styles.css'),
  index: resolve(root, 'public/index.html'),
  themeInit: resolve(root, 'public/theme-init.js'),
  receipt: resolve(root, 'data/data-quality-validation.json'),
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function equal(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function relativeLuminance(hex) {
  const channels = hex.match(/[a-f0-9]{2}/giu).map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(left, right) {
  const values = [relativeLuminance(left), relativeLuminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

const sourceText = {};
for (const [key, path] of Object.entries(paths)) {
  if (key === 'receipt') continue;
  sourceText[key] = await readFile(path, 'utf8');
}

const standard = JSON.parse(sourceText.standard);
const candidateSchema = JSON.parse(sourceText.candidateSchema);
const coverage = JSON.parse(sourceText.coverage);
const candidateFallback = JSON.parse(sourceText.candidateFallback);
const reviewTriage = JSON.parse(sourceText.reviewTriage);
const machinePolicy = JSON.parse(sourceText.machinePolicy);
const machineVerification = JSON.parse(sourceText.machineVerification);
const lifecycle = JSON.parse(sourceText.lifecycle);
const releaseDiff = JSON.parse(sourceText.releaseDiff);
const performanceBudget = JSON.parse(sourceText.performanceBudget);
const performanceValidation = JSON.parse(sourceText.performanceValidation);
const familiesConfig = JSON.parse(sourceText.familiesConfig);
const families = JSON.parse(sourceText.families);
const core = JSON.parse(sourceText.core);
const ocr = JSON.parse(sourceText.ocr);
const detail = JSON.parse(sourceText.detail);
const pre2001 = JSON.parse(sourceText.pre2001);
const century = JSON.parse(sourceText.century);

const checks = [];
function record(id, passed, observed, expected, detailText) {
  checks.push({
    id,
    passed: Boolean(passed),
    observed,
    expected,
    ...(detailText ? { detail: detailText } : {}),
  });
}

const expectedFacets = standard.subject_facets;
record(
  'facets.core_exact',
  equal(core.subject_facets, expectedFacets),
  core.subject_facets,
  expectedFacets,
);
record(
  'facets.family_exact',
  equal(families.families.filter((item) => item.concept_tier_id === 'subject-course-identity')
    .flatMap((item) => item.visibility_facets), expectedFacets),
  families.families.filter((item) => item.concept_tier_id === 'subject-course-identity')
    .flatMap((item) => item.visibility_facets),
  expectedFacets,
);
record('facets.public_projection_exact',
  equal(DISPLAY_SUBJECT_FACETS, standard.public_subject_facets)
    && equal(STORAGE_SUBJECT_FACETS, standard.subject_facets)
    && publicSubjectFacet('历史与社会') === '历史',
  { public: DISPLAY_SUBJECT_FACETS, storage: STORAGE_SUBJECT_FACETS },
  { public: standard.public_subject_facets, storage: standard.subject_facets });

const tierOrder = families.concept_tiers.map((item) => item.id);
record('granularity.tier_order', equal(tierOrder, standard.concept_granularity.tier_order),
  tierOrder, standard.concept_granularity.tier_order);
const familyCountByTier = Object.fromEntries(standard.concept_granularity.tier_order.map((tier) => [
  tier,
  families.families.filter((item) => item.concept_tier_id === tier).length,
]));
record('granularity.family_count_by_tier',
  equal(familyCountByTier, standard.concept_granularity.family_count_by_tier),
  familyCountByTier, standard.concept_granularity.family_count_by_tier);

const crossingFailures = [];
for (const tier of standard.concept_granularity.required_century_crossing_tiers) {
  const tierFamilies = families.families.filter((item) => item.concept_tier_id === tier);
  for (const facet of expectedFacets) {
    const family = tierFamilies.find((item) => equal(item.visibility_facets, [facet]));
    if (!family || family.first_observed_year >= 2001 || family.last_observed_year < 2001) {
      crossingFailures.push(`${tier}:${facet}`);
    }
  }
}
record('granularity.every_subject_crosses_2001', crossingFailures.length === 0,
  { failures: crossingFailures, checked_pairs: expectedFacets.length * standard.concept_granularity.required_century_crossing_tiers.length },
  { failures: [], checked_pairs: 48 });

const configuredConceptById = new Map([
  ...familiesConfig.historical_concepts,
  ...familiesConfig.course_identity_concepts,
  ...familiesConfig.detailed_concepts,
].map((item) => [item.id, item]));
const familyGrainFailures = [];
for (const family of familiesConfig.families) {
  if (!family.concept_tier_id.startsWith('subject-')) continue;
  const categories = new Set(family.concept_ids.map((id) => configuredConceptById.get(id)?.category));
  if (categories.has(undefined) || categories.size !== 1) familyGrainFailures.push(family.id);
}
record('granularity.family_concepts_one_category', familyGrainFailures.length === 0,
  familyGrainFailures, []);

const yearRange = {
  first_year: Math.min(...families.episode_memberships.map((item) => item.year)),
  last_year: Math.max(...families.episode_memberships.map((item) => item.year)),
};
record('time.family_membership_range', equal(yearRange, {
  first_year: standard.temporal_scope.first_year,
  last_year: standard.temporal_scope.last_year,
}), yearRange, {
  first_year: standard.temporal_scope.first_year,
  last_year: standard.temporal_scope.last_year,
});

const stageTriples = CURRICULUM_STAGES.map(({ start, end, label }) => [start, end, label]);
const stagesContiguous = CURRICULUM_STAGES[0].start === standard.temporal_scope.first_year
  && CURRICULUM_STAGES.at(-1).end === standard.temporal_scope.last_year
  && CURRICULUM_STAGES.every((stage, index) => index === 0 || stage.start === CURRICULUM_STAGES[index - 1].end + 1);
record('time.stages_contiguous', stagesContiguous, stageTriples,
  `${standard.temporal_scope.first_year}-${standard.temporal_scope.last_year} contiguous`);
record('time.pre1950_stages_exact',
  equal(stageTriples.filter(([, end]) => end < 1950), standard.temporal_scope.required_pre_1950_stages),
  stageTriples.filter(([, end]) => end < 1950), standard.temporal_scope.required_pre_1950_stages);
record('time.1950_stage_exact',
  equal(stageTriples.find(([start]) => start === 1950), standard.temporal_scope.required_1950_stage),
  stageTriples.find(([start]) => start === 1950), standard.temporal_scope.required_1950_stage);

const coverageFieldMap = {
  complete_whole_documents: 'complete_documents',
  runtime_completed_pages: 'runtime_completed_pages_including_partial_prefixes',
  candidate_covered_pages: 'candidate_covered_pages_including_review_evidence',
};
const coverageObserved = Object.fromEntries(Object.keys(standard.ocr_denominator)
  .filter((key) => !['required_gap_documents', 'required_candidate_gap_ranges'].includes(key))
  .map((key) => [key, coverage.counts[coverageFieldMap[key] || key]]));
const coverageExpected = Object.fromEntries(Object.entries(standard.ocr_denominator)
  .filter(([key]) => !['required_gap_documents', 'required_candidate_gap_ranges'].includes(key)));
record('ocr.denominator_exact', equal(coverageObserved, coverageExpected), coverageObserved, coverageExpected);
const gapDocuments = coverage.gaps.map((item) => item.document_id);
record('ocr.gap_documents_exact', equal(gapDocuments, standard.ocr_denominator.required_gap_documents),
  gapDocuments, standard.ocr_denominator.required_gap_documents);
const gapRanges = Object.fromEntries(coverage.gaps.map((item) => [
  item.document_id,
  [item.page_range],
]));
record('ocr.gap_ranges_exact', equal(gapRanges, standard.ocr_denominator.required_candidate_gap_ranges),
  gapRanges, standard.ocr_denominator.required_candidate_gap_ranges);
record('ocr.fail_closed',
  coverage.release_gate.citation_allowed === false
    && coverage.release_gate.semantic_promotion_allowed === false
    && coverage.release_gate.negative_claim_eligible === false,
  coverage.release_gate,
  { citation_allowed: false, semantic_promotion_allowed: false, negative_claim_allowed: false });
record('ocr.candidate_fallback_exact',
  candidateFallback.counts.pages === standard.ocr_denominator.single_witness_candidate_fallback_pages
    && candidateFallback.counts.candidate_gap_pages_remaining === 0
    && coverage.generated_from.candidate_fallback_sha256 === sha256(sourceText.candidateFallback),
  {
    pages: candidateFallback.counts.pages,
    candidate_gap_pages_remaining: candidateFallback.counts.candidate_gap_pages_remaining,
    fingerprint_bound: coverage.generated_from.candidate_fallback_sha256 === sha256(sourceText.candidateFallback),
  },
  {
    pages: standard.ocr_denominator.single_witness_candidate_fallback_pages,
    candidate_gap_pages_remaining: 0,
    fingerprint_bound: true,
  });
const observedReviewTriage = {
  root_cause_code: reviewTriage.root_cause.code,
  ...reviewTriage.counts,
};
record('ocr.review_queue_triaged_exact',
  equal(observedReviewTriage, standard.ocr_review_triage),
  observedReviewTriage,
  standard.ocr_review_triage);
const observedMachineVerification = {
  policy_id: machineVerification.policy_id,
  ...machineVerification.counts,
};
record('ocr.machine_verification_exact_and_fail_closed',
  equal(observedMachineVerification, standard.ocr_machine_verification)
    && machineVerification.source_bindings.policy_sha256 === sha256(sourceText.machinePolicy)
    && machinePolicy.release_policy.manual_override_allowed === false
    && machinePolicy.release_policy.human_review_required === false
    && machineVerification.release_gate.production_publication_mutation === 'none'
    && machineVerification.verified_pages.length === machineVerification.counts.machine_verified_exact_pages
    && machineVerification.verified_pages.every((page) =>
      page.publication_manifest_eligible === true
      && page.production_citation_ready === false
      && page.semantic_claim_allowed === false),
  observedMachineVerification,
  standard.ocr_machine_verification);

const interfacePolicy = standard.interface_policy;
const primaryContrast = contrastRatio(interfacePolicy.light_primary_text, interfacePolicy.light_surface);
const mutedContrast = contrastRatio(interfacePolicy.light_muted_text, interfacePolicy.light_surface);
const mobileDockMatch = sourceText.styles.match(/--mobile-dock-clearance:\s*(\d+)px/u);
const mobileDockClearance = Number(mobileDockMatch?.[1]);
record('interface.theme_and_chronology_contract',
  sourceText.index.includes('data-theme-choice="dark" aria-pressed="true"')
    && sourceText.index.includes('data-theme-choice="light" aria-pressed="false"')
    && sourceText.index.indexOf('/theme-init.js?v=20260723v42')
      < sourceText.index.indexOf('/styles.css?v=20260723v42')
    && sourceText.themeInit.includes(interfacePolicy.theme_storage_key)
    && sourceText.app.includes('chronologyComparePanel.hidden = !compareActive')
    && sourceText.app.includes('chronologyEraPanel.hidden = compareActive')
    && sourceText.index.includes('id="chronology-compare-panel" role="tabpanel" aria-labelledby="chronology-mode-compare" hidden')
    && sourceText.styles.includes('.chronology-panel[hidden] { display: none; }')
    && primaryContrast >= interfacePolicy.minimum_text_contrast_ratio
    && mutedContrast >= interfacePolicy.minimum_text_contrast_ratio
    && mobileDockClearance <= interfacePolicy.maximum_mobile_dock_clearance_px,
  {
    default_theme: 'dark',
    primary_contrast_ratio: Number(primaryContrast.toFixed(3)),
    muted_contrast_ratio: Number(mutedContrast.toFixed(3)),
    chronology_modes: interfacePolicy.chronology_modes,
    mobile_dock_clearance_px: mobileDockClearance,
  },
  {
    default_theme: interfacePolicy.default_theme,
    minimum_text_contrast_ratio: interfacePolicy.minimum_text_contrast_ratio,
    chronology_modes: interfacePolicy.chronology_modes,
    maximum_mobile_dock_clearance_px: interfacePolicy.maximum_mobile_dock_clearance_px,
  });

const lifecycleSourceIds = new Set(lifecycle.sources.map((item) => item.id));
const historyEvents = lifecycle.events.filter((event) => event.public_facets.includes('历史'));
const historyForms = [...new Set(historyEvents.flatMap((event) => event.discipline_forms)
  .filter((form) => ['历史', '历史与社会'].includes(form)))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
record('discipline.lifecycle_history_model',
  equal(lifecycle.public_subject_facets, standard.public_subject_facets)
    && standard.discipline_lifecycle_policy.required_history_event_types.every((type) =>
      historyEvents.some((event) => event.event_type === type))
    && equal(historyForms, [...standard.discipline_lifecycle_policy.preserved_history_forms].sort((a, b) => a.localeCompare(b, 'zh-CN')))
    && lifecycle.events.every((event) => event.source_ids.length
      && event.source_ids.every((id) => lifecycleSourceIds.has(id))
      && event.claim_boundary),
  {
    public_subject_facets: lifecycle.public_subject_facets,
    history_event_types: [...new Set(historyEvents.map((event) => event.event_type))].sort(),
    history_forms: historyForms,
  },
  standard.discipline_lifecycle_policy);

record('schema.candidate_fail_closed_contract',
  candidateSchema.properties.observation.properties.semantic.const === false
    && candidateSchema.properties.coverage.properties.negative_claim_eligible.const === false
    && candidateSchema.properties.claim_policy.properties.display_level.const === 'uniform_star'
    && ['quotation_allowed', 'semantic_relation_allowed', 'historical_superlative_allowed',
      'first_appearance_allowed', 'disappearance_allowed']
      .every((field) => candidateSchema.properties.claim_policy.properties[field].const === false),
  {
    semantic: candidateSchema.properties.observation.properties.semantic.const,
    negative_claim_eligible: candidateSchema.properties.coverage.properties.negative_claim_eligible.const,
    display_level: candidateSchema.properties.claim_policy.properties.display_level.const,
  },
  { semantic: false, negative_claim_eligible: false, display_level: 'uniform_star' });

const layers = [
  ['core', core.episodes, core.evidence],
  ['ocr', ocr.episodes, ocr.evidence],
  ['subject_detail', detail.episodes, detail.evidence],
  ['pre2001_subject_detail', pre2001.episodes, pre2001.evidence],
  ['century', century.star_projection.episodes, century.star_projection.evidence],
];
const allEpisodeIds = layers.flatMap(([, episodes]) => episodes.map((item) => item.id));
record('identity.episode_ids_globally_unique',
  new Set(allEpisodeIds).size === allEpisodeIds.length,
  { total: allEpisodeIds.length, unique: new Set(allEpisodeIds).size },
  { duplicate_count: 0 });

const evidenceFailures = [];
const candidateFailures = [];
for (const [layerId, episodes, evidence] of layers) {
  const evidenceIds = new Set(evidence.map((item) => item.id));
  for (const episode of episodes) {
    if (!Array.isArray(episode.evidence_ids)
      || episode.evidence_ids.length < standard.evidence_policy.minimum_evidence_anchors_per_episode
      || episode.evidence_ids.some((id) => !evidenceIds.has(id))) {
      evidenceFailures.push(`${layerId}:${episode.id}`);
    }
    if (standard.evidence_policy.candidate_layers.includes(layerId)
      && (episode.observation?.semantic !== false
        || episode.claim_policy?.display_level !== standard.visual_policy.candidate_display_level
        || episode.claim_policy?.quotation_allowed !== false
        || episode.claim_policy?.semantic_relation_allowed !== false
        || episode.claim_policy?.first_appearance_allowed !== false
        || episode.claim_policy?.disappearance_allowed !== false)) {
      candidateFailures.push(`${layerId}:${episode.id}`);
    }
  }
}
record('evidence.every_episode_resolves_anchor', evidenceFailures.length === 0,
  { failures: evidenceFailures, checked_episodes: allEpisodeIds.length },
  { failures: [], checked_episodes: allEpisodeIds.length });
record('evidence.candidate_layers_fail_closed', candidateFailures.length === 0,
  { failures: candidateFailures, candidate_layers: standard.evidence_policy.candidate_layers },
  { failures: [], candidate_layers: standard.evidence_policy.candidate_layers });

const membershipIds = new Set(families.episode_memberships.map((item) => item.episode_id));
const allowedFamilyTypes = new Set(standard.relation_policy.allowed_family_edge_types);
const invalidFamilyEdges = families.edges.filter((edge) =>
  !membershipIds.has(edge.source)
  || !membershipIds.has(edge.target)
  || !allowedFamilyTypes.has(edge.type)
  || edge.source_year > edge.target_year
  || edge.semantic !== false
  || edge.citation_allowed !== false
  || edge.influence_claim_allowed !== false);
record('relations.family_edges_valid', invalidFamilyEdges.length === 0,
  { invalid_edge_ids: invalidFamilyEdges.map((item) => item.id), checked_edges: families.edges.length },
  { invalid_edge_ids: [], checked_edges: families.edges.length });

const familyByEpisode = new Map(families.episode_memberships.map((item) => [item.episode_id, item.family_id]));
const historyCrossEditorial = families.edges.filter((edge) => {
  if (edge.type === 'integrated_curriculum_contains_disciplines') return false;
  const pair = new Set([familyByEpisode.get(edge.source), familyByEpisode.get(edge.target)]);
  return pair.has(standard.relation_policy.history_family_id)
    && pair.has(standard.relation_policy.history_society_family_id);
});
record('relations.history_and_history_society_separate', historyCrossEditorial.length === 0,
  historyCrossEditorial.map((item) => item.id), []);

const disciplineRelation = pre2001.discipline_relations.find((item) =>
  item.id === standard.relation_policy.only_released_discipline_relation_id);
const disciplineEdges = families.edges.filter((item) => item.mode === 'discipline');
const disciplineValid = pre2001.discipline_relations.length === 1
  && disciplineRelation?.year === standard.relation_policy.discipline_relation_year
  && equal(disciplineRelation?.evidence_pages, standard.relation_policy.discipline_relation_evidence_pages)
  && disciplineEdges.length === standard.relation_policy.discipline_relation_edge_count
  && disciplineEdges.every((item) =>
    item.relation_id === standard.relation_policy.only_released_discipline_relation_id
    && item.type === 'integrated_curriculum_contains_disciplines'
    && item.semantic === false
    && item.citation_allowed === false
    && item.influence_claim_allowed === false);
record('relations.only_sourced_1923_discipline_grouping', disciplineValid, {
  relation_ids: pre2001.discipline_relations.map((item) => item.id),
  year: disciplineRelation?.year,
  evidence_pages: disciplineRelation?.evidence_pages,
  edge_count: disciplineEdges.length,
}, {
  relation_ids: [standard.relation_policy.only_released_discipline_relation_id],
  year: standard.relation_policy.discipline_relation_year,
  evidence_pages: standard.relation_policy.discipline_relation_evidence_pages,
  edge_count: standard.relation_policy.discipline_relation_edge_count,
});

const visualCorpus = [
  sourceText.ocr,
  sourceText.detail,
  sourceText.pre2001,
  sourceText.century,
  sourceText.families,
  sourceText.atlas,
  sourceText.styles,
].join('\n');
const forbiddenHits = standard.visual_policy.forbidden_tokens.filter((token) => visualCorpus.includes(token));
record('visual.no_dashed_semantics_or_primitives', forbiddenHits.length === 0,
  forbiddenHits, []);

const releaseDiffCurrentFingerprints = {
  'public/data/concept-evolution.json': sha256(sourceText.core),
  'public/data/ocr-observation-layer.json': sha256(sourceText.ocr),
  'public/data/subject-detail-observation-layer.json': sha256(sourceText.detail),
  'public/data/pre2001-subject-detail-observation-layer.json': sha256(sourceText.pre2001),
  'public/data/century-observation-layer.json': sha256(sourceText.century),
};
record('release.episode_diff_stable_and_current',
  releaseDiff.baseline.tag === standard.release_diff_policy.baseline_tag
    && releaseDiff.counts.removed <= standard.release_diff_policy.removed_episode_count_allowed
    && releaseDiff.counts.cross_layer_moves <= standard.release_diff_policy.cross_layer_move_count_allowed
    && releaseDiff.release_gate.deployment_allowed === true
    && Object.entries(releaseDiffCurrentFingerprints).every(([path, fingerprint]) =>
      releaseDiff.input_fingerprints[path]?.current_sha256 === fingerprint),
  {
    baseline_tag: releaseDiff.baseline.tag,
    removed: releaseDiff.counts.removed,
    cross_layer_moves: releaseDiff.counts.cross_layer_moves,
    deployment_allowed: releaseDiff.release_gate.deployment_allowed,
  },
  {
    baseline_tag: standard.release_diff_policy.baseline_tag,
    removed: standard.release_diff_policy.removed_episode_count_allowed,
    cross_layer_moves: standard.release_diff_policy.cross_layer_move_count_allowed,
    deployment_allowed: true,
  });

record('performance.static_budget_current_and_passed',
  performanceValidation.budget_id === performanceBudget.budget_id
    && performanceValidation.deployment_allowed === true
    && performanceValidation.checks.every((item) => item.passed === true)
    && performanceValidation.source_fingerprints['data/star-map-performance-budget.json'] === sha256(sourceText.performanceBudget)
    && performanceValidation.source_fingerprints['public/index.html'] === sha256(sourceText.index)
    && performanceValidation.source_fingerprints['public/app.js'] === sha256(sourceText.app)
    && performanceValidation.source_fingerprints['public/atlas.js'] === sha256(sourceText.atlas)
    && performanceValidation.source_fingerprints['public/styles.css'] === sha256(sourceText.styles),
  {
    budget_id: performanceValidation.budget_id,
    checks: performanceValidation.checks.length,
    failed: performanceValidation.checks.filter((item) => !item.passed).length,
  },
  { budget_id: performanceBudget.budget_id, checks: performanceValidation.checks.length, failed: 0 });

const failedChecks = checks.filter((item) => !item.passed);
const receipt = {
  schema_version: 1,
  artifact_profile: 'curriculum-data-quality-validation-v1',
  standard_id: standard.standard_id,
  release_decision: failedChecks.length === 0 ? 'pass' : 'block',
  deployment_allowed: failedChecks.length === 0,
  manual_override_allowed: standard.release_policy.manual_override_allowed,
  source_fingerprints: Object.fromEntries(Object.entries(sourceText)
    .map(([key, value]) => [key, sha256(value)])),
  counts: {
    checks: checks.length,
    passed: checks.length - failedChecks.length,
    failed: failedChecks.length,
    subject_facets: core.subject_facets.length,
    concept_tiers: families.concept_tiers.length,
    concept_families: families.families.length,
    episodes: allEpisodeIds.length,
    family_edges: families.edges.length,
    ocr_nominal_pages: coverage.counts.nominal_pages,
    ocr_candidate_covered_pages: coverage.counts.candidate_covered_pages_including_review_evidence,
    ocr_candidate_remaining_pages: coverage.counts.candidate_remaining_pages,
    ocr_citation_ready_pages: coverage.counts.citation_ready_pages,
    ocr_machine_verified_exact_pages: machineVerification.counts.machine_verified_exact_pages,
    ocr_machine_adjudication_pending_pages: machineVerification.counts.audited_pages
      - machineVerification.counts.machine_verified_exact_pages,
    ocr_human_required_pages: machineVerification.counts.human_required_pages,
  },
  checks,
};
const output = `${JSON.stringify(receipt, null, 2)}\n`;

if (checkOnly) {
  const current = await readFile(paths.receipt, 'utf8');
  if (current !== output) throw new Error('data/data-quality-validation.json is stale; run npm run data:quality:validate');
} else {
  await writeFile(paths.receipt, output);
}

if (failedChecks.length) {
  for (const item of failedChecks) console.error(`FAIL ${item.id}: ${JSON.stringify(item.observed)}`);
  process.exitCode = 1;
} else {
  console.log(`PASS ${checks.length}/${checks.length} data-quality checks; deployment gate open`);
}
