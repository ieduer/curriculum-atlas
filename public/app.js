import { CurriculumCosmos, episodeCanonicalSubject, episodeCourseEntity, episodeEntityLabel, episodeVisibleForSubjectFilter, subjectColor } from './atlas.js?v=20260723v42';
import { CURRICULUM_STAGES, curriculumStageForYear } from './historical-stages.js?v=20260723v42';
import {
  DISPLAY_SUBJECT_FACETS,
  buildSubjectFacetIndex,
  controlledSubjectFacetCounts as countControlledSubjectFacets,
  filterDocumentsBySubjectFacet,
  normalizeSubjectFacet,
  planSubjectFacetQueries,
  publicSubjectFacet,
} from './subject-facets.js?v=20260723v42';

const diagnosticsStartedAt = performance.now();
let diagnosticsReadyAt = null;
const longTasks = [];
if ('PerformanceObserver' in window && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
  const observer = new PerformanceObserver((list) => {
    longTasks.push(...list.getEntries()
      .filter((entry) => entry.startTime >= diagnosticsStartedAt
        && (diagnosticsReadyAt === null || entry.startTime <= diagnosticsReadyAt))
      .map((entry) => ({
        start_ms: Number((entry.startTime - diagnosticsStartedAt).toFixed(3)),
        duration_ms: Number(entry.duration.toFixed(3)),
      })));
  });
  observer.observe({ type: 'longtask', buffered: true });
}

function loadProductionIntegrations() {
  if (location.hostname !== 'curriculum.bdfz.net') return;
  for (const integration of [
    {
      src: 'https://my.bdfz.net/site-auth.js',
      data: { siteKey: 'curriculum', mobileInsetBottom: '16' },
    },
    {
      src: 'https://pulse.bdfz.net/beacon.js',
      data: { site: 'curriculum.bdfz.net' },
    },
  ]) {
    const script = document.createElement('script');
    script.src = integration.src;
    script.async = true;
    Object.assign(script.dataset, integration.data);
    document.head.append(script);
  }
}

loadProductionIntegrations();

const loading = document.querySelector('#cosmos-loading');
const mount = document.querySelector('#cosmos-mount');
const mapControls = document.querySelector('#map-controls');
const mapToolsToggle = document.querySelector('#map-tools-toggle');
const inspector = document.querySelector('#star-inspector');
const tooltip = document.querySelector('#atlas-tooltip');
const subjectOrbit = document.querySelector('#subject-orbit');
const subjectModeLabel = document.querySelector('#subject-mode-label');
const subjectStatus = document.querySelector('#subject-status');
const showAllSubjects = document.querySelector('#show-all-subjects');
const conceptLayers = document.querySelector('#concept-layers');
const eraButtons = document.querySelector('#era-buttons');
const yearOptions = document.querySelector('#year-options');
const yearSelectionStatus = document.querySelector('#year-selection-status');
const yearBoundaryCompare = document.querySelector('#year-boundary-compare');
const clearYearSelection = document.querySelector('#clear-year-selection');
const searchForm = document.querySelector('#cosmos-search');
const searchInput = document.querySelector('#cosmos-query');
const clearQuery = document.querySelector('#clear-query');
const conceptResults = document.querySelector('#concept-results');
const conceptResultList = document.querySelector('#concept-result-list');
const conceptResultCount = document.querySelector('#concept-result-count');
const workbench = document.querySelector('#workbench');
const workbenchKicker = document.querySelector('#workbench-kicker');
const workbenchTitle = document.querySelector('#workbench-title');
const workbenchTabs = document.querySelector('#workbench-tabs');
const workbenchBody = document.querySelector('#workbench-body');
const scrim = document.querySelector('#scrim');
const toastNode = document.querySelector('#toast');
const ocrLayerStatus = document.querySelector('#ocr-layer-status');
const disciplineLifecycleEvents = document.querySelector('#discipline-lifecycle-events');
const disciplineLifecycleStatus = document.querySelector('#discipline-lifecycle-status');
const conceptYearLinks = document.querySelector('#concept-year-links');
const chronologyEraTab = document.querySelector('#chronology-mode-era');
const chronologyCompareTab = document.querySelector('#chronology-mode-compare');
const chronologyEraPanel = document.querySelector('#chronology-era-panel');
const chronologyComparePanel = document.querySelector('#chronology-compare-panel');
const yearSelectionCount = document.querySelector('#year-selection-count');
const themeChoices = document.querySelectorAll('[data-theme-choice]');

const state = {
  meta: null,
  documents: [],
  insights: [],
  conceptGraph: null,
  ocrLayer: null,
  detailLayer: null,
  pre2001Layer: null,
  centuryLayer: null,
  evolutionLayer: null,
  disciplineLifecycle: null,
  ocrCoverageSummary: null,
  deepNodeById: new Map(),
  deepChildrenById: new Map(),
  deepRootByFacet: new Map(),
  deepFocusId: null,
  evolutionFamilyById: new Map(),
  evolutionTierById: new Map(),
  centuryItemById: new Map(),
  centuryConceptsByItem: new Map(),
  archiveItems: [],
  evidenceById: new Map(),
  ontologyNodeById: new Map(),
  ontologyEvidenceById: new Map(),
  ontologyScopeById: new Map(),
  ontologyFocusId: null,
  me: null,
  cosmos: null,
  hiddenSubjects: new Set(),
  hideAllSubjects: false,
  minYear: 1902,
  maxYear: 2022,
  availableYears: [],
  selectedYears: new Set(),
  query: '',
  mode: 'lineage',
  selectedDocument: null,
  selectedEpisode: null,
  selectedScreenPosition: null,
  searchResultEpisodes: [],
  introRevealActive: false,
  introRevealComplete: false,
  chronologyMode: 'era',
  theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
};

const CORE_SUBJECTS = DISPLAY_SUBJECT_FACETS;
const SUBJECT_SHORT_LABELS = new Map([
  ['思想政治与道德法治', '思政·道法'],
  ['科学类', '科学'],
  ['体育与健康', '体育·健康'],
]);
const ERAS = CURRICULUM_STAGES;

let toastTimer = 0;
const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

function toast(message) {
  toastNode.textContent = message;
  toastNode.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastNode.classList.remove('show'), 3200);
}

function yearVisible(year) {
  const value = Number(year);
  return Number.isFinite(value) && value <= state.maxYear && (!state.selectedYears.size || state.selectedYears.has(value));
}

function renderYearCompareControls() {
  if (!state.availableYears.length) return;
  const selected = [...state.selectedYears].sort((left, right) => left - right);
  const loadedCount = state.availableYears.filter((year) => year <= state.maxYear).length;
  yearSelectionStatus.textContent = state.introRevealActive
    ? `载入至 ${state.maxYear} · ${loadedCount}/${state.availableYears.length}`
    : selected.length
      ? selected.length <= 4 ? selected.join(' · ') : `${selected.length} 个年份已选`
      : `全部 ${state.availableYears.length} 个有资料年份`;
  clearYearSelection.disabled = selected.length === 0;
  yearBoundaryCompare.disabled = state.availableYears.length < 2;
  yearSelectionCount.hidden = selected.length === 0;
  yearSelectionCount.textContent = selected.length ? String(selected.length) : '';
  yearOptions.innerHTML = state.availableYears.map((year) => {
    const active = state.selectedYears.has(year);
    const pending = year > state.maxYear;
    return `<button type="button" data-compare-year="${year}" aria-pressed="${active}" ${pending ? 'disabled' : ''} class="${active ? 'active' : ''}">${year}</button>`;
  }).join('');
}

function setChronologyMode(mode, { focus = false } = {}) {
  state.chronologyMode = mode === 'compare' ? 'compare' : 'era';
  const compareActive = state.chronologyMode === 'compare';
  chronologyEraTab.setAttribute('aria-selected', String(!compareActive));
  chronologyCompareTab.setAttribute('aria-selected', String(compareActive));
  chronologyEraTab.tabIndex = compareActive ? -1 : 0;
  chronologyCompareTab.tabIndex = compareActive ? 0 : -1;
  chronologyEraPanel.hidden = compareActive;
  chronologyComparePanel.hidden = !compareActive;
  document.querySelector('.cosmos-year-control')?.setAttribute('data-mode', state.chronologyMode);
  state.cosmos?.refreshViewport();
  if (focus) (compareActive ? chronologyCompareTab : chronologyEraTab).focus();
}

function setTheme(theme, { persist = true } = {}) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.style.colorScheme = state.theme;
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', state.theme === 'light' ? '#edf1ee' : '#050814');
  themeChoices.forEach((button) =>
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === state.theme)));
  if (persist) {
    try {
      localStorage.setItem('curriculum-atlas-theme-v1', state.theme);
    } catch {
      // Theme still applies when storage is blocked.
    }
  }
  state.cosmos?.setTheme(state.theme);
}

function activateYearSelection(years, { fitVisible = true } = {}) {
  state.introRevealActive = false;
  state.introRevealComplete = true;
  state.maxYear = state.availableYears.at(-1);
  const allowed = new Set(state.availableYears);
  state.selectedYears = new Set(years.map(Number).filter((year) => allowed.has(year)));
  syncYearStageState();
  updateMapStatus({ fitVisible });
}

function toggleYearSelection(year, options) {
  const value = Number(year);
  if (!state.availableYears.includes(value)) return;
  const next = new Set(state.selectedYears);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  activateYearSelection([...next], options);
}

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

async function loadBase() {
  if (state.meta) return;
  const [conceptGraph, ocrLayer, detailLayer, pre2001Layer, centuryLayer, evolutionLayer, disciplineLifecycle, ocrCoverageSummary, meta, documents, insights] = await Promise.all([
    api('/data/concept-evolution.json?v=20260723v42'),
    api('/data/ocr-observation-layer.json?v=20260723v42'),
    api('/data/subject-detail-observation-layer.json?v=20260723v42'),
    api('/data/pre2001-subject-detail-observation-layer.json?v=20260723v42'),
    api('/data/century-observation-layer.json?v=20260723v42'),
    api('/data/concept-evolution-families.json?v=20260723v42'),
    api('/data/discipline-lifecycle.json?v=20260723v42'),
    api('/data/ocr-coverage-summary.json?v=20260723v42'),
    api('/api/meta').catch(() => ({ turnstileSiteKey: null, degraded: true })),
    api('/api/documents?limit=200').catch(() => ({ documents: [] })),
    api('/api/insights').catch(() => ({ insights: [] })),
  ]);
  state.meta = meta;
  state.documents = documents.documents || [];
  state.insights = insights.insights || [];
  if (ocrCoverageSummary.schema_version !== 1
    || ocrCoverageSummary.artifact_profile !== 'curriculum-ocr-public-coverage-summary-v1'
    || ocrCoverageSummary.coverage?.candidate_remaining_pages !== 0
    || ocrCoverageSummary.coverage?.candidate_covered_pages !== ocrCoverageSummary.coverage?.nominal_pages
    || ocrCoverageSummary.machine_verification?.policy_id !== 'curriculum-ocr-machine-verification-v1'
    || ocrCoverageSummary.machine_verification?.machine_verified_exact_pages < 1
    || ocrCoverageSummary.machine_verification?.human_required_pages !== 0
    || ocrCoverageSummary.release_gate?.citation_allowed !== false) {
    throw new Error('OCR 覆盖摘要未通过结构校验');
  }
  if (conceptGraph.schema_version !== 1
    || !Array.isArray(conceptGraph.episodes)
    || !Array.isArray(conceptGraph.evidence)
    || !Array.isArray(conceptGraph.subject_facets)
    || !Array.isArray(conceptGraph.subject_taxonomy)
    || conceptGraph.ontology_schema_version !== 1
    || !Array.isArray(conceptGraph.ontology_nodes)
    || !Array.isArray(conceptGraph.ontology_relations)
    || !Array.isArray(conceptGraph.ontology_evidence)) {
    throw new Error('概念星图数据未通过结构校验');
  }
  if (ocrLayer.schema_version !== 1
    || ocrLayer.artifact_profile !== 'curriculum-ocr-observation-layer-v1'
    || !Array.isArray(ocrLayer.pages)
    || !Array.isArray(ocrLayer.episodes)
    || !Array.isArray(ocrLayer.edges)
    || !Array.isArray(ocrLayer.evidence)
    || ocrLayer.source?.citation_allowed !== false) {
    throw new Error('OCR 观察层数据未通过结构校验');
  }
  if (detailLayer.schema_version !== 1
    || detailLayer.artifact_profile !== 'curriculum-subject-detail-observation-layer-v1'
    || detailLayer.publication_status !== 'candidate_fail_closed'
    || detailLayer.node_semantics !== 'subject_detail_concept_observation_episode_not_document'
    || detailLayer.time_semantics !== 'year_is_single_spatial_coordinate_not_a_second_timeline'
    || detailLayer.projection_policy?.grain !== 'one_exact_surface_observation_per_concept_document'
    || detailLayer.counts?.subject_facets !== 12
    || !Array.isArray(detailLayer.sources)
    || !Array.isArray(detailLayer.episodes)
    || !Array.isArray(detailLayer.evidence)
    || !Array.isArray(detailLayer.edges)
    || detailLayer.sources.some((source) => source.citation_allowed !== false
      || source.completed_pages !== source.page_count
      || source.failed_pages !== 0)
    || detailLayer.episodes.some((episode) => episode.claim_policy?.display_level !== 'uniform_star'
      || !episode.evidence_ids?.length)) {
    throw new Error('各学科同粒度 OCR 观察层未通过结构校验');
  }
  if (pre2001Layer.schema_version !== 1
    || pre2001Layer.artifact_profile !== 'curriculum-pre2001-subject-detail-observation-layer-v1'
    || pre2001Layer.publication_status !== 'candidate_fail_closed'
    || pre2001Layer.node_semantics !== 'pre2001_subject_detail_concept_observation_episode_not_document'
    || pre2001Layer.time_semantics !== 'year_is_single_spatial_coordinate_not_a_second_timeline'
    || pre2001Layer.counts?.subject_facets !== 12
    || !Array.isArray(pre2001Layer.items)
    || !Array.isArray(pre2001Layer.episodes)
    || !Array.isArray(pre2001Layer.evidence)
    || !Array.isArray(pre2001Layer.edges)
    || !Array.isArray(pre2001Layer.discipline_relations)
    || pre2001Layer.items.some((item) => item.citation_allowed !== false || item.semantic_claim_allowed !== false)
    || pre2001Layer.episodes.some((episode) => episode.claim_policy?.display_level !== 'uniform_star'
      || !episode.evidence_ids?.length)) {
    throw new Error('2001 年前各科 bounded-item 观察层未通过结构校验');
  }
  if (centuryLayer.schema_version !== 2
    || centuryLayer.artifact_profile !== 'curriculum-century-candidate-observation-layer-v2'
    || centuryLayer.publication_status !== 'candidate_fail_closed'
    || !Array.isArray(centuryLayer.items)
    || centuryLayer.items.length !== 134
    || !Array.isArray(centuryLayer.concept_observations)
    || !Array.isArray(centuryLayer.relations)
    || centuryLayer.star_projection?.node_semantics !== 'concept_observation_episode_not_document'
    || centuryLayer.star_projection?.time_semantics !== 'year_is_single_spatial_coordinate_not_a_second_timeline'
    || !Array.isArray(centuryLayer.star_projection?.episodes)
    || !Array.isArray(centuryLayer.star_projection?.edges)
    || !Array.isArray(centuryLayer.star_projection?.evidence)
    || centuryLayer.star_projection?.projection_policy?.grain
      !== 'one_strongest_bounded_observation_per_concept_year_subject_facet'
    || centuryLayer.star_projection.episodes.length
      !== centuryLayer.counts.projected_concept_year_observations
    || centuryLayer.star_projection.episodes.some((episode) => episode.claim_policy?.display_level !== 'uniform_star'
      || !episode.evidence_ids?.length)
    || centuryLayer.items.some((item) => item.citation_allowed !== false || item.semantic_claim_allowed !== false)) {
    throw new Error('百年文件候选层未通过结构校验');
  }
  if (evolutionLayer.schema_version !== 3
    || evolutionLayer.artifact_profile !== 'curriculum-concept-evolution-families-v3'
    || !Array.isArray(evolutionLayer.concept_tiers)
    || evolutionLayer.concept_tiers.length !== 5
    || evolutionLayer.publication_status !== 'editorial_correspondence_noncausal'
    || !Array.isArray(evolutionLayer.families)
    || !Array.isArray(evolutionLayer.episode_memberships)
    || !Array.isArray(evolutionLayer.edges)
    || evolutionLayer.edges.some((edge) => edge.semantic !== false || edge.influence_claim_allowed !== false)) {
    throw new Error('百年概念演进族谱未通过结构校验');
  }
  if (disciplineLifecycle.schema_version !== 1
    || disciplineLifecycle.artifact_profile !== 'curriculum-discipline-lifecycle-v1'
    || !Array.isArray(disciplineLifecycle.public_subject_facets)
    || !Array.isArray(disciplineLifecycle.sources)
    || !Array.isArray(disciplineLifecycle.events)
    || disciplineLifecycle.events.some((event) => !Number.isInteger(event.year)
      || !event.source_ids?.length
      || !event.public_facets?.length
      || event.public_facets.some((facet) => !DISPLAY_SUBJECT_FACETS.includes(facet)))) {
    throw new Error('学科设置与分合事件层未通过结构校验');
  }
  conceptGraph.episodes = [...conceptGraph.episodes, ...ocrLayer.episodes];
  conceptGraph.edges = [...conceptGraph.edges, ...ocrLayer.edges];
  conceptGraph.evidence = [...conceptGraph.evidence, ...ocrLayer.evidence];
  conceptGraph.episodes = [...conceptGraph.episodes, ...detailLayer.episodes];
  conceptGraph.edges = [...conceptGraph.edges, ...detailLayer.edges];
  conceptGraph.evidence = [...conceptGraph.evidence, ...detailLayer.evidence];
  conceptGraph.episodes = [...conceptGraph.episodes, ...pre2001Layer.episodes];
  conceptGraph.edges = [...conceptGraph.edges, ...pre2001Layer.edges];
  conceptGraph.evidence = [...conceptGraph.evidence, ...pre2001Layer.evidence];
  conceptGraph.episodes = [...conceptGraph.episodes, ...centuryLayer.star_projection.episodes];
  conceptGraph.edges = [...conceptGraph.edges, ...centuryLayer.star_projection.edges];
  conceptGraph.evidence = [...conceptGraph.evidence, ...centuryLayer.star_projection.evidence];
  const membershipByEpisode = new Map(evolutionLayer.episode_memberships.map((item) => [item.episode_id, item]));
  conceptGraph.episodes.forEach((episode) => {
    const membership = membershipByEpisode.get(episode.id);
    if (!membership) return;
    episode.evolution_family_id = membership.family_id;
    episode.evolution_tier_id = membership.concept_tier_id;
  });
  conceptGraph.edges = [...conceptGraph.edges, ...evolutionLayer.edges];
  state.conceptGraph = conceptGraph;
  state.ocrLayer = ocrLayer;
  state.detailLayer = detailLayer;
  state.pre2001Layer = pre2001Layer;
  state.centuryLayer = centuryLayer;
  state.evolutionLayer = evolutionLayer;
  state.disciplineLifecycle = disciplineLifecycle;
  state.ocrCoverageSummary = ocrCoverageSummary;
  state.evolutionFamilyById = new Map(evolutionLayer.families.map((family) => [family.id, family]));
  state.evolutionTierById = new Map(evolutionLayer.concept_tiers.map((tier) => [tier.id, tier]));
  const archiveItemById = new Map(centuryLayer.items.map((item) => [item.id, {
    ...item,
    visibility_facets: item.visibility_facets || (item.subject === '语文' ? ['语文'] : []),
    assertion_boundary: centuryLayer.assertion_boundary,
  }]));
  const archiveIdByPre2001ItemId = new Map();
  for (const item of pre2001Layer.items) {
    const existing = item.source_item_id ? archiveItemById.get(item.source_item_id) : null;
    if (existing) {
      existing.visibility_facets = [...new Set([
        ...(existing.visibility_facets || []),
        ...(item.visibility_facets || []),
      ])];
      archiveIdByPre2001ItemId.set(item.id, existing.id);
      continue;
    }
    const normalized = {
      ...item,
      subject: (item.visibility_facets || []).join(' · ') || '课程资料',
      title_status: 'source_hash_bound_candidate',
      identity_status: 'source_hash_bound_bounded_candidate',
      observation_status: item.ocr_status,
      segments: [{
        stage: item.stage,
        role: 'primary_item',
        printed_page_start: item.printed_page_start,
        printed_page_end: item.printed_page_end,
        physical_page_start: item.physical_page_start,
        physical_page_end: item.physical_page_end,
      }],
      assertion_boundary: pre2001Layer.assertion_boundary,
      public_locator: `/historical/${encodeURIComponent(item.id)}`,
    };
    archiveItemById.set(normalized.id, normalized);
    archiveIdByPre2001ItemId.set(item.id, normalized.id);
  }
  state.archiveItems = [...archiveItemById.values()]
    .sort((left, right) => Number(left.year) - Number(right.year)
      || left.title.localeCompare(right.title, 'zh-CN'));
  state.centuryItemById = archiveItemById;
  state.centuryConceptsByItem = new Map();
  centuryLayer.concept_observations.forEach((observation) => {
    if (!observation.item_id) return;
    const observations = state.centuryConceptsByItem.get(observation.item_id) || [];
    observations.push(observation);
    state.centuryConceptsByItem.set(observation.item_id, observations);
  });
  const pre2001EvidenceById = new Map(pre2001Layer.evidence.map((item) => [item.id, item]));
  const pre2001ObservationByKey = new Map();
  for (const episode of pre2001Layer.episodes) {
    const itemId = archiveIdByPre2001ItemId.get(episode.embedded_item_id);
    if (!itemId) continue;
    const key = `${itemId}|${episode.concept_id}`;
    const evidence = episode.evidence_ids.map((id) => pre2001EvidenceById.get(id)).filter(Boolean);
    const current = pre2001ObservationByKey.get(key) || {
      item_id: itemId,
      concept_id: episode.concept_id,
      label: episode.label,
      category: episode.category,
      mention_count: 0,
      observed_physical_pages: [],
      observed_surfaces: [],
    };
    current.mention_count += Number(episode.observation?.mention_count) || 0;
    current.observed_physical_pages.push(...evidence.map((item) => item.page_number));
    current.observed_surfaces.push(...evidence.map((item) => item.matched_surface));
    current.observed_physical_pages = [...new Set(current.observed_physical_pages)].sort((a, b) => a - b);
    current.observed_surfaces = [...new Set(current.observed_surfaces)];
    pre2001ObservationByKey.set(key, current);
  }
  for (const observation of pre2001ObservationByKey.values()) {
    const observations = state.centuryConceptsByItem.get(observation.item_id) || [];
    const existing = observations.find((item) => item.concept_id === observation.concept_id);
    if (existing) {
      existing.mention_count += observation.mention_count;
      existing.observed_physical_pages = [...new Set([
        ...(existing.observed_physical_pages || []),
        ...observation.observed_physical_pages,
      ])].sort((a, b) => a - b);
      existing.observed_surfaces = [...new Set([
        ...(existing.observed_surfaces || []),
        ...observation.observed_surfaces,
      ])];
    } else {
      observations.push(observation);
    }
    state.centuryConceptsByItem.set(observation.item_id, observations);
  }
  state.evidenceById = new Map(conceptGraph.evidence.map((item) => [item.id, item]));
  state.ontologyNodeById = new Map(conceptGraph.ontology_nodes.map((item) => [item.id, item]));
  state.ontologyEvidenceById = new Map(conceptGraph.ontology_evidence.map((item) => [item.id, item]));
  state.ontologyScopeById = new Map(conceptGraph.ontology_scopes.map((item) => [item.id, item]));
  const years = [
    ...conceptGraph.episodes.map((episode) => Number(episode.time?.year)),
    ...centuryLayer.items.map((item) => Number(item.year)),
    ...disciplineLifecycle.events.map((event) => Number(event.year)),
  ].filter((year) => Number.isFinite(year) && year >= 1800);
  if (!years.length) throw new Error('概念星图没有可显示的年代节点');
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  state.minYear = minYear;
  state.maxYear = maxYear;
  state.availableYears = [...new Set(years)].sort((left, right) => left - right);
  state.selectedYears.clear();
  buildDeepModels();
  ocrLayerStatus.innerHTML = `<b>百年资料与证据</b><span>11/11 检索分面 · ${escapeHtml(state.archiveItems.length)} 个 bounded items · 候选页 ${escapeHtml(ocrCoverageSummary.coverage.candidate_covered_pages)}/${escapeHtml(ocrCoverageSummary.coverage.nominal_pages)}</span><small>${escapeHtml(evolutionLayer.counts.detailed_families)} 条实践／内容／能力演进族 · ${escapeHtml(pre2001Layer.counts.episodes)} 个早期观察 · 机器精确核验 ${escapeHtml(ocrCoverageSummary.machine_verification?.machine_verified_exact_pages || 0)} 页，其余进入自动仲裁</small>`;
  ocrLayerStatus.hidden = false;
}

async function loadMe() {
  if (!state.me) state.me = await api('/api/me').catch(() => ({ authenticated: false, user: null, admin: false }));
  return state.me;
}

function navigate(href, replace = false) {
  const url = new URL(href, location.origin);
  if (url.origin !== location.origin) {
    location.href = href;
    return;
  }
  history[replace ? 'replaceState' : 'pushState']({}, '', `${url.pathname}${url.search}${url.hash}`);
  route();
}

function qualityLabel(doc) {
  if (Number(doc.citation_allowed) === 1) return '图文与来源已过引文门槛';
  const ocrDocument = state.ocrLayer?.documents?.find((item) => item.id === doc.id);
  if (ocrDocument?.status === 'complete') return `OCR ${ocrDocument.page_count} 页完成 · 机器仲裁中不可引用`;
  if (ocrDocument?.status === 'active') return `OCR ${ocrDocument.completed_pages}/${ocrDocument.page_count} 页处理中`;
  if (/ocr/i.test(String(doc.text_quality_status || ''))) return 'OCR 机器复核中 · 禁止 AI 引用';
  return '元数据已确认 · 正文仍待核';
}

function statusLabel(status) {
  const labels = {
    current_with_revision_watch: '现行·修订观察', current_reference: '现行参考',
    historical: '历史资料', historical_reference: '历史参考', superseded: '后续版本已发布',
    missing_primary_files: '原件待补', revision_watch: '修订动态',
  };
  return labels[status] || status || '状态待核';
}

function documentSubjectFacet(document) {
  return document?.taxonomy_entity_kind === 'subject' && typeof document?.canonical_subject === 'string' && document.canonical_subject.trim()
    ? document.canonical_subject.trim()
    : null;
}

function documentCanonicalIdentity(document) {
  return ['subject', 'assessment_subject'].includes(document?.taxonomy_entity_kind)
    && typeof document?.canonical_subject === 'string' && document.canonical_subject.trim()
    ? document.canonical_subject.trim()
    : null;
}

function documentEntityLabel(document) {
  return documentCanonicalIdentity(document) || document?.scope_label || document?.entity_label || document?.source_subject_label || document?.subject || '范围待核';
}

function taxonomyIdentityKindLabel(taxonomyEntityKind) {
  const labels = {
    subject: '学科',
    assessment_subject: '考试评价身份',
    curriculum_course: '课程',
    assessment_domain: '考试评价范围',
    source_collection: '资料汇编',
    cross_cutting_framework: '跨学科框架',
    unclassified: '分类待核',
  };
  return labels[taxonomyEntityKind] || '范围';
}

function documentIdentityKindLabel(document) {
  return taxonomyIdentityKindLabel(document?.taxonomy_entity_kind);
}

function documentSourceVariant(document) {
  const subject = documentCanonicalIdentity(document);
  const sourceLabel = typeof document?.source_subject_label === 'string' ? document.source_subject_label.trim() : '';
  return subject && sourceLabel && sourceLabel !== subject ? sourceLabel : null;
}

function availableCanonicalSubjects() {
  const identities = state.meta?.queryIdentities || state.meta?.subjects || [];
  const names = new Set(identities
    .map((item) => typeof item?.name === 'string' ? item.name.trim() : '')
    .filter(Boolean));
  for (const document of state.documents) {
    const subject = documentSubjectFacet(document);
    if (subject) names.add(subject);
  }
  return [...names];
}

function subjectFacetIndex() {
  return buildSubjectFacetIndex(state.conceptGraph, availableCanonicalSubjects());
}

function subjectFacetNames() {
  return subjectFacetIndex().facets;
}

function displayFacetForSubject(subject) {
  return normalizeSubjectFacet(subject, subjectFacetIndex());
}

function subjectQueryPlan(subjectOrFacet) {
  return planSubjectFacetQueries(subjectOrFacet, subjectFacetIndex());
}

function documentDisplayFacet(document) {
  const persistedFacet = typeof document?.display_facet === 'string' ? document.display_facet.trim() : '';
  const publicFacet = publicSubjectFacet(persistedFacet);
  return subjectFacetNames().includes(publicFacet)
    ? publicFacet
    : displayFacetForSubject(documentSubjectFacet(document));
}

function addDeepNode(node) {
  state.deepNodeById.set(node.id, node);
  if (!node.parent_id) return;
  const children = state.deepChildrenById.get(node.parent_id) || [];
  children.push(node);
  state.deepChildrenById.set(node.parent_id, children);
}

function buildDeepModels() {
  state.deepNodeById.clear();
  state.deepChildrenById.clear();
  state.deepRootByFacet.clear();
  const episodeById = new Map(state.conceptGraph.episodes.map((episode) => [episode.id, episode]));
  const membershipsByFamily = new Map();
  for (const membership of state.evolutionLayer.episode_memberships) {
    const rows = membershipsByFamily.get(membership.family_id) || [];
    rows.push(membership);
    membershipsByFamily.set(membership.family_id, rows);
  }
  for (const facet of DISPLAY_SUBJECT_FACETS) {
    const families = state.evolutionLayer.families.filter((family) =>
      family.visibility_facets.some((candidate) => publicSubjectFacet(candidate) === facet));
    const root = {
      id: `deep-root:${facet}`,
      parent_id: null,
      facet,
      label: `${facet}概念模型`,
      node_type: 'evidence_bound_subject_model',
      review_status: 'evidence_bound_candidate_model',
      definition: facet === '历史'
        ? '合并检索历史与历史与社会的同层概念观察；两种课程形态及其并行、合科和调整事件仍分别保留。'
        : '按课程名称、实践、内容、能力等同粒度概念组织的来源绑定比较模型。',
      episode_ids: [...new Set(families.flatMap((family) =>
        (membershipsByFamily.get(family.id) || []).map((membership) => membership.episode_id)))],
    };
    addDeepNode(root);
    state.deepRootByFacet.set(facet, root);
    for (const tier of state.evolutionLayer.concept_tiers) {
      const tierFamilies = families.filter((family) => family.concept_tier_id === tier.id);
      if (!tierFamilies.length) continue;
      const tierNode = {
        id: `deep-tier:${facet}:${tier.id}`,
        parent_id: root.id,
        facet,
        label: tier.label,
        node_type: 'same_grain_concept_tier',
        review_status: 'evidence_bound_candidate_model',
        definition: tier.definition,
        episode_ids: [...new Set(tierFamilies.flatMap((family) =>
          (membershipsByFamily.get(family.id) || []).map((membership) => membership.episode_id)))],
      };
      addDeepNode(tierNode);
      for (const family of tierFamilies) {
        const memberships = membershipsByFamily.get(family.id) || [];
        const familyNode = {
          id: `deep-family:${family.id}`,
          parent_id: tierNode.id,
          facet,
          label: family.label,
          node_type: 'same_grain_evolution_family',
          review_status: 'editorial_correspondence_noncausal',
          definition: family.definition,
          assertion_boundary: state.evolutionLayer.assertion_boundary,
          family_id: family.id,
          episode_ids: memberships.map((membership) => membership.episode_id),
        };
        addDeepNode(familyNode);
        for (const concept of family.observed_concepts) {
          const conceptMemberships = memberships.filter((membership) => membership.concept_id === concept.id);
          const conceptNode = {
            id: `deep-concept:${family.id}:${concept.id}`,
            parent_id: familyNode.id,
            facet,
            label: concept.label,
            node_type: 'source_surface_concept',
            review_status: 'source_bound_observation',
            definition: `${concept.first_observed_year}—${concept.last_observed_year} 的当前资料词面观察；不是首次出现或连续存在结论。`,
            family_id: family.id,
            concept_id: concept.id,
            episode_ids: conceptMemberships.map((membership) => membership.episode_id),
          };
          addDeepNode(conceptNode);
          const years = [...new Set(conceptMemberships.map((membership) => membership.year))].sort((a, b) => a - b);
          for (const year of years) {
            const yearEpisodeIds = conceptMemberships
              .filter((membership) => membership.year === year && episodeById.has(membership.episode_id))
              .map((membership) => membership.episode_id);
            addDeepNode({
              id: `deep-year:${family.id}:${concept.id}:${year}`,
              parent_id: conceptNode.id,
              facet,
              label: String(year),
              node_type: 'source_bound_year_observation',
              review_status: 'source_bound_observation',
              definition: `${year} 年来源绑定观察；点击后使用底部同一年代轴定位。`,
              family_id: family.id,
              concept_id: concept.id,
              episode_ids: yearEpisodeIds,
            });
          }
        }
      }
    }
  }
}

function deepChildren(nodeId) {
  return state.deepChildrenById.get(nodeId) || [];
}

function deepPath(node) {
  const path = [];
  const seen = new Set();
  let cursor = node;
  while (cursor && !seen.has(cursor.id)) {
    path.unshift(cursor);
    seen.add(cursor.id);
    cursor = cursor.parent_id ? state.deepNodeById.get(cursor.parent_id) : null;
  }
  return path;
}

function deepNodeEpisodes(node) {
  const byId = new Map(state.conceptGraph.episodes.map((episode) => [episode.id, episode]));
  return (node?.episode_ids || []).map((id) => byId.get(id)).filter(Boolean);
}

function linkConceptYears(node) {
  const years = [...new Set(deepNodeEpisodes(node).map((episode) => Number(episode.time?.year)).filter(Number.isFinite))]
    .sort((a, b) => a - b);
  if (!years.length) {
    conceptYearLinks.hidden = true;
    conceptYearLinks.replaceChildren();
    return;
  }
  conceptYearLinks.innerHTML = `<b>${escapeHtml(node.label)} · 关联年代</b>${years.map((year) =>
    `<button type="button" data-concept-year="${year}" aria-pressed="${state.selectedYears.has(year)}" class="${state.selectedYears.has(year) ? 'active' : ''}">${year}</button>`).join('')}`;
  conceptYearLinks.hidden = false;
  setChronologyMode('compare');
  conceptYearLinks.querySelectorAll('[data-concept-year]').forEach((button) => button.addEventListener('click', () => {
    toggleYearSelection(button.dataset.conceptYear, { fitVisible: true });
    conceptYearLinks.querySelectorAll('button').forEach((item) => {
      const active = state.selectedYears.has(Number(item.dataset.conceptYear));
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
  }));
}

function uniqueRows(rows, keyOf) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = keyOf(row);
    if (key === null || key === undefined || key === '' || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function verificationLabel(status) {
  const labels = {
    verified_exact: '同版精确核验', verified_stable_fact_only: '稳定事实已核验',
    version_variant_reference_only: '异版仅供参考', conflict_requires_review: '冲突待复核',
    human_judgment_with_warning: '人工判断·有疑点', unresolved_fail_closed: '未确认·禁止引文',
    exact_document_exact_edition: '同文同版', exact_document_revision_uncertain: '同文·版次存疑',
    same_work_different_edition: '同篇异版', stable_fact_only: '仅核稳定事实', not_matched: '未匹配',
  };
  return labels[status] || status || '待核';
}

function conceptStatusLabel(status) {
  const labels = {
    citation_ready: '段落与来源已过引文门槛',
    verified_non_citation: '图文人工复核 · 禁止逐字引用',
    source_text_candidate: '来源文本候选 · 段落门槛未过',
    ocr_candidate: '双引擎 OCR 候选 · 待机器仲裁',
    ocr_complete_pending_audit: 'OCR 全页完成 · 待机器仲裁',
    ocr_complete_pending_item_audit: 'OCR 篇目完成 · 待自动逐项核查',
    catalog_title_candidate: '教育部编目标题候选 · 不可引用',
    conflict: '识别冲突 · 保留疑点',
  };
  return labels[status] || '质量状态待核';
}

function observationLabel(episode) {
  if (episode.observation?.status === 'ocr_complete_pending_audit') return '来源绑定且全页完成的 OCR 词面观察';
  if (episode.observation?.status === 'ocr_complete_pending_item_audit') return '目录与物理页已绑定的百年 OCR 词面观察';
  if (episode.observation?.status === 'catalog_title_candidate') return '教育部编目标题中的当代课程名称观察';
  const incoming = state.conceptGraph.edges.find((edge) => edge.type === 'next_observed' && edge.target === episode.id);
  const labels = {
    observed_more_frequently: '当前可比语料中规范化提及增多',
    observed_less_frequently: '当前可比语料中规范化提及减少',
    frequency_not_materially_changed: '当前可比语料中提及强度接近',
  };
  return incoming?.metric?.interpretation ? labels[incoming.metric.interpretation] : '当前语料中的概念观察点';
}

function positionInspector(episodeId = null) {
  inspector.classList.remove('dock-left', 'dock-right', 'overlap-softened');
  if (innerWidth <= 640) return;
  const point = episodeId
    ? state.cosmos?.getEpisodeScreenPosition(episodeId)
    : state.selectedScreenPosition;
  const dockLeft = point ? point.x > innerWidth * .52 : false;
  inspector.classList.add(dockLeft ? 'dock-left' : 'dock-right');
  const estimatedWidth = Math.min(370, innerWidth - 300);
  const selectedNearOppositePanel = point && (
    (dockLeft && point.x < estimatedWidth + 96)
    || (!dockLeft && point.x > innerWidth - estimatedWidth - 96)
  );
  if (innerWidth < 980 || selectedNearOppositePanel) inspector.classList.add('overlap-softened');
}

function clearInspectorAvoidance({ refit = false } = {}) {
  state.cosmos?.setViewportObstruction(null);
  for (const side of ['left', 'right', 'bottom']) conceptLayers.style.removeProperty(`--inspector-clear-${side}`);
  if (refit) state.cosmos?.fitToVisibleGraph({ maxZoom: state.cosmos.visibleSubjectCount() === 1 ? 1.32 : 1, preserveOrientation: true });
}

function applyInspectorAvoidance({ fitSelection = true } = {}) {
  if (inspector.hidden || !state.cosmos) {
    clearInspectorAvoidance();
    return;
  }
  const rect = inspector.getBoundingClientRect();
  const side = innerWidth <= 640
    ? 'bottom'
    : inspector.classList.contains('dock-left') ? 'left' : 'right';
  state.cosmos.setViewportObstruction(rect, side);
  for (const name of ['left', 'right', 'bottom']) conceptLayers.style.removeProperty(`--inspector-clear-${name}`);
  if (side === 'left') conceptLayers.style.setProperty('--inspector-clear-left', `${Math.ceil(rect.right + 14)}px`);
  if (side === 'right') conceptLayers.style.setProperty('--inspector-clear-right', `${Math.ceil(innerWidth - rect.left + 14)}px`);
  if (side === 'bottom') conceptLayers.style.setProperty('--inspector-clear-bottom', `${Math.ceil(innerHeight - rect.top + 12)}px`);
  if (fitSelection && state.cosmos.focusSelection()) return;
  state.cosmos.fitToVisibleGraph({
    maxZoom: state.cosmos.visibleSubjectCount() === 1 ? 1.32 : 1,
    preserveOrientation: true,
  });
}

function finalizeInspectorLayout(episodeId = null) {
  inspector.classList.toggle('is-expanded', innerWidth > 640);
  const toggle = document.createElement('button');
  toggle.className = 'inspector-expand';
  toggle.type = 'button';
  toggle.textContent = '展开说明';
  toggle.setAttribute('aria-expanded', 'false');
  inspector.querySelector('.inspector-close')?.after(toggle);
  toggle.addEventListener('click', () => {
    const expanded = inspector.classList.toggle('is-expanded');
    toggle.textContent = expanded ? '收起说明' : '展开说明';
    toggle.setAttribute('aria-expanded', String(expanded));
    requestAnimationFrame(() => applyInspectorAvoidance());
  });
  inspector.hidden = false;
  positionInspector(episodeId);
  requestAnimationFrame(() => applyInspectorAvoidance());
}

function clearConceptInspector(resetRoute = true) {
  state.selectedEpisode = null;
  state.selectedScreenPosition = null;
  inspector.hidden = true;
  inspector.classList.remove('is-expanded');
  conceptYearLinks.hidden = true;
  conceptYearLinks.replaceChildren();
  state.cosmos?.setSelected(null);
  clearInspectorAvoidance({ refit: true });
  if (resetRoute && location.pathname.replace(/\/+$/, '') === '/terms') history.replaceState({}, '', '/');
}

function selectConceptEpisode(episode, screenPosition = null) {
  if (!episode) return;
  state.selectedScreenPosition = screenPosition;
  showConceptInspector(episode);
  history.replaceState({}, '', `/terms?term=${encodeURIComponent(episode.concept_id)}&episode=${encodeURIComponent(episode.id)}`);
  renderConceptResults();
}

function showConceptInspector(episode) {
  state.selectedEpisode = episode;
  state.cosmos?.setSelected(episode.id);
  const records = episode.evidence_ids.map((id) => state.evidenceById.get(id)).filter(Boolean).slice(0, 4);
  const status = episode.observation.status;
  const subject = episodeCanonicalSubject(episode);
  const subjectFacet = displayFacetForSubject(subject);
  const entityLabel = episodeEntityLabel(episode);
  const entityKind = episodeCourseEntity(episode) ? '课程节点' : '学科概念';
  const evolutionFamily = state.evolutionFamilyById.get(episode.evolution_family_id);
  const evolutionTier = evolutionFamily
    ? state.evolutionTierById.get(evolutionFamily.concept_tier_id)
    : null;
  const evolutionChainLabel = evolutionFamily?.coverage_contract === 'century_crossing'
    ? '百年演进链'
    : evolutionFamily?.coverage_contract === 'single_version_2022'
      ? '单版本同层观察'
      : '跨版本同层演进链';
  const evolutionEpisodeIds = new Set(evolutionFamily
    ? state.evolutionLayer.episode_memberships
      .filter((item) => item.family_id === evolutionFamily.id)
      .map((item) => item.episode_id)
    : [episode.id]);
  linkConceptYears({
    label: evolutionFamily?.label || episode.label,
    episode_ids: [...evolutionEpisodeIds],
  });
  const episodeById = new Map(state.conceptGraph.episodes.map((item) => [item.id, item]));
  const disciplineRelations = state.conceptGraph.edges
    .filter((edge) => edge.mode === 'discipline'
      && (evolutionEpisodeIds.has(edge.source) || evolutionEpisodeIds.has(edge.target)))
    .map((edge) => ({
      edge,
      source: episodeById.get(edge.source),
      target: episodeById.get(edge.target),
    }))
    .filter((item) => item.source && item.target);
  const evolutionHtml = evolutionFamily ? `
    <section class="evolution-chain-summary">
      <p class="evolution-chain-kicker">${escapeHtml(evolutionChainLabel)} · ${escapeHtml(evolutionTier?.label || evolutionFamily.concept_tier_id)}</p>
      <h3>${escapeHtml(evolutionFamily.label)}</h3>
      <p>${escapeHtml(evolutionFamily.first_observed_year)}—${escapeHtml(evolutionFamily.last_observed_year)} · ${escapeHtml(evolutionFamily.observed_concepts.length)} 个同层概念 · ${escapeHtml(evolutionFamily.episode_count)} 个观察点</p>
      <div class="evolution-concept-list">${evolutionFamily.observed_concepts.map((concept) =>
    `<span class="${concept.id === episode.concept_id ? 'current' : ''}">${escapeHtml(concept.label)}<small>${escapeHtml(concept.first_observed_year)}—${escapeHtml(concept.last_observed_year)}</small></span>`).join('')}</div>
      <small>${escapeHtml(state.evolutionLayer.assertion_boundary)}</small>
    </section>` : '';
  const disciplineHtml = disciplineRelations.length ? `
    <section class="discipline-relation-summary">
      <p class="discipline-relation-kicker">横向 · 学科分合</p>
      <h3>${escapeHtml(disciplineRelations[0].edge.label)}</h3>
      ${disciplineRelations.map(({ edge, source, target }) => `<div>
        <b>${escapeHtml(source.label)}</b><span>合科编组</span><b>${escapeHtml(target.label)}</b>
        <small>${escapeHtml(edge.source_year)} · ${escapeHtml(edge.claim_boundary)}</small>
      </div>`).join('')}
    </section>` : '';
  const evidenceHtml = records.map((item) => `<article class="concept-evidence ${item.citation_allowed ? '' : 'candidate'}">
    ${item.citation_allowed ? `<a href="/document/${encodeURIComponent(item.document_id)}" data-link>${escapeHtml(item.document_title)}</a>` : `<b>${escapeHtml(item.document_title)}</b>`}
    <small>${escapeHtml(item.source_locator)} · ${escapeHtml(item.matched_surface)}${item.citation_allowed ? '' : ' · 不进入引文 AI'}</small>
    <p>${escapeHtml(item.snippet)}</p>
    ${item.public_locator ? `<a href="${escapeHtml(item.public_locator)}" data-link>${item.observation_class === 'catalog_title_candidate_nonsemantic' ? '查看编目文件' : '查看目录绑定页段'}</a>` : ''}
  </article>`).join('');
  inspector.innerHTML = `
    <button class="inspector-close" type="button" aria-label="关闭">×</button>
    <p class="inspector-kicker">${escapeHtml(episode.time.year)} · ${escapeHtml(entityKind)} · ${escapeHtml(entityLabel)} · ${escapeHtml(episode.curriculum_line.stage)}</p>
    <h2>${escapeHtml(episode.label)}</h2>
    <p>${escapeHtml(observationLabel(episode))}。自动词频只用于发现候选，不单独证明课程理念发生实质变化。</p>
    <div class="inspector-meta">
      <span>${escapeHtml(episode.category)}</span><span>${escapeHtml(episode.curriculum_line.school_type)}</span>
      <span>命中 ${escapeHtml(episode.observation.mention_count)} 次</span><span>${escapeHtml(conceptStatusLabel(status))}</span>
    </div>
    ${evolutionHtml}
    ${disciplineHtml}
    <div class="inspector-insights">
      <h3>原文证据</h3>
      ${evidenceHtml || '<small>证据定位缺失；该节点不应显示，请报告数据问题。</small>'}
    </div>
    <div class="inspector-actions">
      <button class="action-button primary" type="button" data-focus-selection>放大关联星系</button>
      ${episode.ontology_node_id ? `<button class="action-button primary" type="button" data-open-ontology="${escapeHtml(episode.ontology_node_id)}">展开概念层级</button>` : ''}
      ${episode.public_locator ? `<a class="action-button primary" href="${escapeHtml(episode.public_locator)}" data-link>${episode.observation_class === 'catalog_title_candidate_nonsemantic' ? '查看编目文件' : '查看候选文件页段'}</a>` : ''}
      <a class="action-button primary" href="/sources?q=${encodeURIComponent(episode.label)}" data-link>检索全部原文</a>
      ${subjectFacet ? `<a class="action-button" href="/compare?subject=${encodeURIComponent(subjectFacet)}" data-link>比较版本</a>` : ''}
    </div>`;
  inspector.querySelector('.inspector-close').addEventListener('click', () => clearConceptInspector());
  inspector.querySelector('[data-focus-selection]')?.addEventListener('click', () => {
    state.cosmos?.focusSelection();
  });
  inspector.querySelector('[data-open-ontology]')?.addEventListener('click', (event) => {
    state.ontologyFocusId = event.currentTarget.dataset.openOntology;
    setMapMode('structure');
    showOntologyInspector(state.ontologyNodeById.get(state.ontologyFocusId));
  });
  finalizeInspectorLayout(episode.id);
}

const ONTOLOGY_TYPE_LABELS = {
  subject_model: '学科模型', curriculum_construct: '课程对象', language_activity: '语言活动',
  evidence_bound_subject_model: '学科证据模型', same_grain_concept_tier: '同粒度层级',
  same_grain_evolution_family: '概念演进族', source_surface_concept: '来源词面',
  source_bound_year_observation: '年度观察',
  historical_goal_framework: '历史目标框架', historical_goal_dimension: '三维目标',
  competency_framework: '核心素养框架', core_competency: '核心素养', course_goal: '课程目标',
  practice_framework: '实践框架', practice_domain: '实践领域', student_ability: '学生能力',
  official_term: '官方术语', ability_descriptor: '能力描述', task_requirement: '任务要求',
  content_organizer: '内容组织', task_group: '学习任务群', quality_framework: '质量框架',
  quality_level: '质量水平', quality_dimension: '质量维度',
};

const ONTOLOGY_RELATION_LABELS = {
  component_of: '组成', foundational_for: '奠基', reframed_by: '转化为', develops: '发展',
  realized_through: '通过实践实现', operationalizes: '落实为目标', assesses: '评价',
};

function ontologyNodeSubject(node) {
  return state.ontologyScopeById.get(node?.scope_id)?.subject_facet || null;
}

function ontologyChildren(parentId) {
  return state.conceptGraph.ontology_nodes.filter((node) => node.parent_id === parentId);
}

function ontologyPath(node) {
  const path = [];
  const visited = new Set();
  let cursor = node;
  while (cursor && !visited.has(cursor.id)) {
    path.unshift(cursor);
    visited.add(cursor.id);
    cursor = cursor.parent_id ? state.ontologyNodeById.get(cursor.parent_id) : null;
  }
  return path;
}

function showOntologyInspector(node) {
  if (!node) return;
  state.ontologyFocusId = node.id;
  state.selectedEpisode = null;
  state.cosmos?.setSelected(null);
  const scope = state.ontologyScopeById.get(node.scope_id);
  const records = (node.evidence_anchor_ids || []).map((id) => state.ontologyEvidenceById.get(id)).filter(Boolean);
  const relations = state.conceptGraph.ontology_relations
    .filter((relation) => relation.source === node.id || relation.target === node.id)
    .map((relation) => {
      const outward = relation.source === node.id;
      const peer = state.ontologyNodeById.get(outward ? relation.target : relation.source);
      return peer ? `<button type="button" data-ontology-node="${escapeHtml(peer.id)}"><span>${escapeHtml(ONTOLOGY_RELATION_LABELS[relation.type] || relation.type)}</span>${escapeHtml(peer.label)}</button>` : '';
    }).filter(Boolean).join('');
  const evidenceHtml = records.map((item) => `<article class="concept-evidence">
    <a href="/document/${encodeURIComponent(item.document_id)}" data-link>${escapeHtml(item.document_title)}</a>
    <small>${escapeHtml(item.source_locator)} · ${escapeHtml((item.section_path || []).join(' › '))}</small>
    <p>段落锚点：${escapeHtml((item.required_terms || []).join(' · '))}</p>
  </article>`).join('');
  const reviewLabel = node.review_status === 'reviewed_inference' ? '编辑推断 · 非官方表头' : '官方原文锚定';
  inspector.innerHTML = `
    <button class="inspector-close" type="button" aria-label="关闭">×</button>
    <p class="inspector-kicker">${escapeHtml(ontologyNodeSubject(node) || '学科')} · ${escapeHtml(ONTOLOGY_TYPE_LABELS[node.node_type] || node.node_type)}</p>
    <h2>${escapeHtml(node.label)}</h2>
    <p>${escapeHtml(node.definition)}</p>
    <div class="inspector-meta">
      <span>${escapeHtml(scope?.stage || '跨学段')}</span><span>${escapeHtml(reviewLabel)}</span>
      <span>下位概念 ${ontologyChildren(node.id).length}</span>
    </div>
    ${scope ? `<small class="ontology-scope-note">版本边界：${escapeHtml(scope.version_scope)}</small>` : ''}
    ${relations ? `<div class="ontology-relations"><h3>经核关系</h3>${relations}</div>` : ''}
    <div class="inspector-insights">
      <h3>官方证据</h3>
      ${evidenceHtml || '<small>该导航节点没有独立段落锚点，不得据此形成版本结论。</small>'}
    </div>
    <div class="inspector-actions">
      ${node.lexical_concept_id ? `<a class="action-button" href="/terms?term=${encodeURIComponent(node.lexical_concept_id)}" data-link>查看历代观察</a>` : ''}
      <a class="action-button primary" href="/sources?q=${encodeURIComponent(node.label)}" data-link>检索全部原文</a>
    </div>`;
  inspector.querySelector('.inspector-close').addEventListener('click', () => clearConceptInspector(false));
  inspector.querySelectorAll('[data-ontology-node]').forEach((button) => button.addEventListener('click', () => {
    const next = state.ontologyNodeById.get(button.dataset.ontologyNode);
    if (!next) return;
    state.ontologyFocusId = next.id;
    renderConceptLayers();
    showOntologyInspector(next);
  }));
  const lexicalEpisodes = node.lexical_concept_id
    ? state.conceptGraph.episodes.filter((episode) => episode.concept_id === node.lexical_concept_id)
    : [];
  if (lexicalEpisodes.length) {
    linkConceptYears({
      label: node.label,
      episode_ids: lexicalEpisodes.map((episode) => episode.id),
    });
  }
  finalizeInspectorLayout(lexicalEpisodes.at(-1)?.id || null);
}

function showDeepInspector(node) {
  if (!node) return;
  state.deepFocusId = node.id;
  const episodes = deepNodeEpisodes(node)
    .sort((left, right) => Number(left.time.year) - Number(right.time.year) || left.id.localeCompare(right.id, 'en'));
  const years = [...new Set(episodes.map((episode) => Number(episode.time?.year)).filter(Number.isFinite))];
  const evidence = uniqueRows(episodes.flatMap((episode) =>
    episode.evidence_ids.map((id) => state.evidenceById.get(id)).filter(Boolean)), (item) => item.id).slice(0, 6);
  const selectedEpisode = episodes.length <= 24 ? episodes.at(-1) : null;
  state.selectedEpisode = selectedEpisode;
  state.cosmos?.setSelected(selectedEpisode?.id || null);
  linkConceptYears(node);
  const typeLabels = {
    evidence_bound_subject_model: '学科证据模型',
    same_grain_concept_tier: '同粒度层级',
    same_grain_evolution_family: '演进概念族',
    source_surface_concept: '来源词面概念',
    source_bound_year_observation: '年度观察',
  };
  const evidenceHtml = evidence.map((item) => `<article class="concept-evidence ${item.citation_allowed ? '' : 'candidate'}">
    ${item.citation_allowed ? `<a href="/document/${encodeURIComponent(item.document_id)}" data-link>${escapeHtml(item.document_title)}</a>` : `<b>${escapeHtml(item.document_title)}</b>`}
    <small>${escapeHtml(item.source_locator)}${item.citation_allowed ? '' : ' · 候选层不可引文'}</small>
    <p>${escapeHtml(item.snippet)}</p>
  </article>`).join('');
  inspector.innerHTML = `
    <button class="inspector-close" type="button" aria-label="关闭">×</button>
    <p class="inspector-kicker">${escapeHtml(node.facet)} · ${escapeHtml(typeLabels[node.node_type] || node.node_type)}</p>
    <h2>${escapeHtml(node.label)}</h2>
    <p>${escapeHtml(node.definition)}</p>
    <div class="inspector-meta">
      <span>来源观察 ${episodes.length}</span>
      <span>年代 ${years.length}</span>
      <span>${node.review_status === 'editorial_correspondence_noncausal' ? '编辑对应·非因果' : '证据绑定候选模型'}</span>
    </div>
    ${node.assertion_boundary ? `<small class="ontology-scope-note">${escapeHtml(node.assertion_boundary)}</small>` : ''}
    <div class="inspector-insights">
      <h3>对应页段</h3>
      ${evidenceHtml || '<small>当前为组织导航节点；下钻到概念或年度可查看对应页段。</small>'}
    </div>
    <div class="inspector-actions">
      ${selectedEpisode ? '<button class="action-button primary" type="button" data-focus-selection>放大关联星系</button>' : ''}
      <a class="action-button primary" href="/sources?q=${encodeURIComponent(node.label)}" data-link>检索全部原文</a>
    </div>`;
  inspector.querySelector('.inspector-close').addEventListener('click', () => clearConceptInspector(false));
  inspector.querySelector('[data-focus-selection]')?.addEventListener('click', () => state.cosmos?.focusSelection());
  finalizeInspectorLayout(selectedEpisode?.id || null);
}

function ontologyPositions(count) {
  if (!count) return [];
  const innerCount = count > 10 ? Math.min(8, Math.ceil(count * .45)) : count;
  const compact = innerWidth <= 640;
  return Array.from({ length: count }, (_, index) => {
    const outer = index >= innerCount;
    const ringIndex = outer ? index - innerCount : index;
    const ringCount = outer ? count - innerCount : innerCount;
    const angle = -Math.PI / 2 + (ringIndex / ringCount) * Math.PI * 2 + (outer ? Math.PI / ringCount : 0);
    const radiusX = outer ? (compact ? 35 : 43) : count > 10 ? (compact ? 23 : 27) : count > 6 ? (compact ? 34 : 39) : (compact ? 30 : 34);
    const radiusY = outer ? 40 : count > 10 ? 25 : count > 6 ? 35 : 31;
    return { x: 50 + Math.cos(angle) * radiusX, y: 50 + Math.sin(angle) * radiusY, outer };
  });
}

function ontologySearchText(node) {
  const scope = state.ontologyScopeById.get(node.scope_id);
  return `${node.label} ${node.definition} ${(node.source_terms || []).join(' ')} ${ONTOLOGY_TYPE_LABELS[node.node_type] || node.node_type} ${scope?.version_scope || ''}`
    .toLocaleLowerCase('zh-CN');
}

function deepNodeSearchText(node) {
  return `${node.label} ${node.definition} ${node.facet} ${node.node_type}`.toLocaleLowerCase('zh-CN');
}

function episodeSearchText(episode) {
  return `${episode.label} ${(episode.aliases || []).join(' ')} ${episodeEntityLabel(episode)} ${episode.time.year} ${episode.category}`
    .toLocaleLowerCase('zh-CN');
}

function activeDeepContext() {
  const subjects = controlledSubjectFacetCounts(state.conceptGraph).subjects;
  const visibleSubjects = state.hideAllSubjects ? [] : subjects.filter((subject) => !state.hiddenSubjects.has(subject));
  const activeSubject = visibleSubjects.length === 1 ? visibleSubjects[0] : null;
  const root = activeSubject ? state.deepRootByFacet.get(activeSubject) || null : null;
  return { activeSubject, root };
}

function reconcileOntologyInspectorSubject(visibleSubjects) {
  if (!state.deepFocusId && !state.ontologyFocusId) return;
  const focus = state.deepNodeById.get(state.deepFocusId) || state.ontologyNodeById.get(state.ontologyFocusId);
  const activeSubject = visibleSubjects.length === 1 ? visibleSubjects[0] : null;
  if (focus && (focus.facet || ontologyNodeSubject(focus)) === activeSubject) return;
  state.deepFocusId = null;
  state.ontologyFocusId = null;
  inspector.hidden = true;
  state.cosmos?.setSelected(null);
  clearInspectorAvoidance({ refit: true });
}

function renderConceptLayers() {
  const subjects = controlledSubjectFacetCounts(state.conceptGraph).subjects;
  const visibleSubjects = state.hideAllSubjects ? [] : subjects.filter((subject) => !state.hiddenSubjects.has(subject));
  const searchableSubjects = new Set(visibleSubjects);
  const queryMatches = state.query ? [...state.deepNodeById.values()]
    .filter((node) => searchableSubjects.has(node.facet) && deepNodeSearchText(node).includes(state.query))
    .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'))
    .slice(0, 24) : [];
  const queryHasEpisodeMatch = state.query && state.conceptGraph.episodes.some((episode) =>
    yearVisible(episode.time.year)
    && episodeVisibleForSubjectFilter(episode, state.hiddenSubjects, state.hideAllSubjects, subjects)
    && episodeSearchText(episode).includes(state.query));
  if (state.mode !== 'structure' && (!queryMatches.length || queryHasEpisodeMatch)) {
    conceptLayers.hidden = true;
    mount.classList.remove('structure-muted');
    return;
  }
  conceptLayers.hidden = false;
  mount.classList.add('structure-muted');
  if (queryMatches.length) {
    const positions = ontologyPositions(queryMatches.length);
    const lines = positions.map((position) => `<line x1="50" y1="50" x2="${position.x.toFixed(2)}" y2="${position.y.toFixed(2)}"></line>`).join('');
    const stars = queryMatches.map((node, index) => {
      const position = positions[index];
      return `<button class="ontology-star ${position.outer ? 'outer' : ''}" type="button" data-ontology-search-result="${escapeHtml(node.id)}" style="--star-x:${position.x.toFixed(2)}%;--star-y:${position.y.toFixed(2)}%;--star-delay:${index * 24}ms">
        <i aria-hidden="true"></i><b>${escapeHtml(node.label)}</b><small>${escapeHtml(node.facet || '')} · ${escapeHtml(ONTOLOGY_TYPE_LABELS[node.node_type] || node.node_type)}</small>
      </button>`;
    }).join('');
    conceptLayers.innerHTML = `<nav class="ontology-breadcrumb" aria-label="概念检索路径"><span>星图检索</span><span>›</span><button type="button" aria-current="page">${escapeHtml(state.query)}</button></nav>
      <div class="ontology-stage ${queryMatches.length > 10 ? 'dense' : ''}">
        <svg class="ontology-edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>
        <div class="ontology-center ontology-search-center"><i aria-hidden="true"></i><b>${escapeHtml(state.query)}</b><small>官方概念、术语与能力描述</small></div>
        ${stars}
      </div>`;
    conceptLayers.querySelectorAll('[data-ontology-search-result]').forEach((button) => button.addEventListener('click', () => {
      const next = state.deepNodeById.get(button.dataset.ontologySearchResult);
      if (!next) return;
      state.deepFocusId = next.id;
      showDeepInspector(next);
    }));
    return;
  }
  const { activeSubject, root } = activeDeepContext();
  if (!root) {
    conceptLayers.innerHTML = `<div class="ontology-empty"><b>请选择一个学科进入概念深挖</b><span>11 个公开检索分面均已建立来源绑定的同粒度模型；历史入口同时保留历史与历史与社会两种课程形态。</span></div>`;
    return;
  }
  let focus = state.deepNodeById.get(state.deepFocusId);
  if (!focus || focus.facet !== activeSubject || !deepPath(focus).some((node) => node.id === root.id)) focus = root;
  state.deepFocusId = focus.id;
  const children = deepChildren(focus.id);
  const positions = ontologyPositions(children.length);
  const breadcrumb = deepPath(focus).map((node, index, path) => `<button type="button" data-deep-node="${escapeHtml(node.id)}" ${index === path.length - 1 ? 'aria-current="page"' : ''}>${escapeHtml(node.label)}</button>`).join('<span>›</span>');
  const lines = positions.map((position) => `<line x1="50" y1="50" x2="${position.x.toFixed(2)}" y2="${position.y.toFixed(2)}"></line>`).join('');
  const stars = children.map((child, index) => {
    const position = positions[index];
    const descendants = deepChildren(child.id).length;
    const inferred = child.review_status !== 'official_text';
    return `<button class="ontology-star ${position.outer ? 'outer' : ''} ${inferred ? 'inferred' : ''}" type="button" data-deep-node="${escapeHtml(child.id)}" style="--star-x:${position.x.toFixed(2)}%;--star-y:${position.y.toFixed(2)}%;--star-delay:${index * 24}ms">
      <i aria-hidden="true"></i><b>${escapeHtml(child.label)}</b><small>${escapeHtml(ONTOLOGY_TYPE_LABELS[child.node_type] || child.node_type)}${descendants ? ` · ${descendants}` : ''}</small>
    </button>`;
  }).join('');
  conceptLayers.innerHTML = `<nav class="ontology-breadcrumb" aria-label="概念层级路径">${breadcrumb}</nav>
    <div class="ontology-stage ${children.length > 10 ? 'dense' : ''}">
      <svg class="ontology-edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>
      <button class="ontology-center" type="button" data-inspect-deep="${escapeHtml(focus.id)}"><i aria-hidden="true"></i><b>${escapeHtml(focus.label)}</b><small>${escapeHtml(ONTOLOGY_TYPE_LABELS[focus.node_type] || focus.node_type)} · ${children.length} 个下位概念</small></button>
      ${stars || '<p class="ontology-leaf">已到当前核验层级；可从右侧证据继续查看原文。</p>'}
    </div>`;
  conceptLayers.querySelectorAll('[data-deep-node]').forEach((button) => button.addEventListener('click', () => {
    const next = state.deepNodeById.get(button.dataset.deepNode);
    if (!next) return;
    state.deepFocusId = next.id;
    renderConceptLayers();
    showDeepInspector(next);
  }));
  conceptLayers.querySelector('[data-inspect-deep]')?.addEventListener('click', () => showDeepInspector(focus));
}

function showTooltip(node, event) {
  if (!node) {
    tooltip.hidden = true;
    return;
  }
  const title = node.episode.label;
  const entityKind = episodeCourseEntity(node.episode) ? '课程节点' : '学科概念';
  const meta = `${node.year} · ${entityKind} · ${node.entityLabel} · ${conceptStatusLabel(node.episode.observation.status)}`;
  tooltip.innerHTML = `<b>${escapeHtml(title)}</b><span>${escapeHtml(meta)}</span>`;
  tooltip.style.left = `${Math.min(innerWidth - 326, Math.max(14, event.clientX + 14))}px`;
  tooltip.style.top = `${Math.min(innerHeight - 94, Math.max(14, event.clientY + 14))}px`;
  tooltip.hidden = false;
}

function renderConceptResults() {
  searchInput.removeAttribute('aria-activedescendant');
  if (!state.query) {
    state.searchResultEpisodes = [];
    conceptResultList.replaceChildren();
    conceptResults.hidden = true;
    searchInput.setAttribute('aria-expanded', 'false');
    return;
  }
  const controlledSubjects = controlledSubjectFacetCounts(state.conceptGraph).subjects;
  const matches = state.conceptGraph.episodes
    .filter((episode) => yearVisible(episode.time.year)
      && episodeVisibleForSubjectFilter(episode, state.hiddenSubjects, state.hideAllSubjects, controlledSubjects)
      && episodeSearchText(episode).includes(state.query))
    .sort((left, right) => {
      const leftExact = left.label.toLocaleLowerCase('zh-CN') === state.query ? 0 : 1;
      const rightExact = right.label.toLocaleLowerCase('zh-CN') === state.query ? 0 : 1;
      return leftExact - rightExact
        || left.label.localeCompare(right.label, 'zh-CN')
        || Number(left.time.year) - Number(right.time.year)
        || left.id.localeCompare(right.id);
    });
  state.searchResultEpisodes = matches.slice(0, 60);
  conceptResults.hidden = false;
  searchInput.setAttribute('aria-expanded', 'true');
  conceptResultCount.textContent = matches.length > state.searchResultEpisodes.length
    ? `${state.searchResultEpisodes.length}/${matches.length} 个`
    : `${matches.length} 个`;
  conceptResultList.innerHTML = state.searchResultEpisodes.length
    ? state.searchResultEpisodes.map((episode, index) => {
      const family = state.evolutionFamilyById.get(episode.evolution_family_id);
      const subject = displayFacetForSubject(episodeCanonicalSubject(episode)) || episodeEntityLabel(episode);
      const selected = state.selectedEpisode?.id === episode.id;
      return `<button id="concept-result-${index}" type="button" role="option" tabindex="-1" data-episode-id="${escapeHtml(episode.id)}" aria-selected="${selected}">
        <span><b>${escapeHtml(episode.label)}</b><small>${escapeHtml(episode.time.year)} · ${escapeHtml(subject)}</small></span>
        <em>${escapeHtml(family?.label || episode.category)}</em>
      </button>`;
    }).join('')
    : '<p class="concept-result-empty">当前学科与年份范围内没有匹配星点</p>';
}

function focusConceptResult(index) {
  const options = [...conceptResultList.querySelectorAll('[role="option"]')];
  if (!options.length) return;
  options[Math.max(0, Math.min(index, options.length - 1))].focus();
}

function updateMapStatus({ fitVisible = false } = {}) {
  const controlledSubjects = controlledSubjectFacetCounts(state.conceptGraph).subjects;
  const visibleEpisodes = state.conceptGraph.episodes.filter((episode) => yearVisible(episode.time.year)
    && episodeVisibleForSubjectFilter(episode, state.hiddenSubjects, state.hideAllSubjects, controlledSubjects)
    && (!state.query || episodeSearchText(episode).includes(state.query)));
  const visibleIds = new Set(visibleEpisodes.map((episode) => episode.id));
  if (state.selectedEpisode && !visibleIds.has(state.selectedEpisode.id)) clearConceptInspector();
  const visibleSubjects = state.hideAllSubjects
    ? []
    : controlledSubjects.filter((subject) => !state.hiddenSubjects.has(subject));
  const visibleSubjectCount = visibleSubjects.length;
  reconcileOntologyInspectorSubject(visibleSubjects);
  state.cosmos?.setFilters(
    {
      hiddenSubjects: state.hiddenSubjects,
      hideAll: state.hideAllSubjects,
      maxYear: state.maxYear,
      selectedYears: state.selectedYears,
      query: state.query,
    },
    { fitVisible, maxZoom: visibleSubjectCount === 1 ? 1.32 : 1 },
  );
  renderConceptResults();
  renderConceptLayers();
  renderDisciplineLifecycle();
}

function subjectButton(subject, count, panel = false) {
  const visible = !state.hideAllSubjects && !state.hiddenSubjects.has(subject);
  const controlledSubjects = controlledSubjectFacetCounts(state.conceptGraph).subjects;
  const onlyVisible = visible && controlledSubjects.filter((name) => !state.hiddenSubjects.has(name)).length === 1;
  const action = onlyVisible ? '恢复全部分面' : `只看${subject}；Shift 点击可多选`;
  const label = SUBJECT_SHORT_LABELS.get(subject) || subject;
  return `<button class="subject-button ${visible ? 'active' : ''}" type="button" data-subject="${escapeHtml(subject)}" aria-label="${escapeHtml(subject)}" aria-pressed="${visible}" style="--subject-color:${subjectColor(subject)}" title="${escapeHtml(action)}"><span>${escapeHtml(label)}${panel ? ` · ${count}` : ''}</span></button>`;
}

function controlledSubjectFacetCounts(conceptGraph) {
  return countControlledSubjectFacets(conceptGraph);
}

function renderSubjectControls() {
  const { subjects, counts } = controlledSubjectFacetCounts(state.conceptGraph);
  const core = CORE_SUBJECTS.filter((subject) => counts.has(subject));
  const visible = state.hideAllSubjects ? [] : core.filter((subject) => !state.hiddenSubjects.has(subject));
  subjectModeLabel.textContent = visible.length === core.length ? '全学科星图' : visible.length === 1 ? visible[0] : '多学科筛选';
  subjectStatus.textContent = `${visible.length}/${core.length} · ${visible.length === core.length ? '全部显示' : '已筛选'}`;
  showAllSubjects.disabled = visible.length === core.length;
  subjectOrbit.innerHTML = core.map((subject) => subjectButton(subject, counts.get(subject))).join('');
  subjectOrbit.querySelectorAll('[data-subject]').forEach((button) => button.addEventListener('click', (event) => {
    const subject = button.dataset.subject;
    const visibleSubjects = state.hideAllSubjects ? [] : subjects.filter((name) => !state.hiddenSubjects.has(name));
    if (event.shiftKey) {
      if (state.hiddenSubjects.has(subject)) {
        state.hiddenSubjects.delete(subject);
        state.hideAllSubjects = false;
      } else {
        state.hiddenSubjects.add(subject);
        state.hideAllSubjects = subjects.every((name) => state.hiddenSubjects.has(name));
      }
    } else if (visibleSubjects.length === 1 && visibleSubjects[0] === subject) {
      state.hideAllSubjects = false;
      state.hiddenSubjects.clear();
    } else {
      state.hideAllSubjects = false;
      state.hiddenSubjects.clear();
      subjects.forEach((name) => { if (name !== subject) state.hiddenSubjects.add(name); });
    }
    renderSubjectControls();
    updateMapStatus({ fitVisible: !event.shiftKey });
  }));
}

function showDisciplineEventInspector(event) {
  const sources = event.source_ids
    .map((id) => state.disciplineLifecycle.sources.find((source) => source.id === id))
    .filter(Boolean);
  state.selectedEpisode = null;
  state.selectedScreenPosition = null;
  state.cosmos?.setSelected(null);
  conceptYearLinks.innerHTML = `<b>${escapeHtml(event.label)} · 关联年代</b><button type="button" data-concept-year="${event.year}" aria-pressed="${state.selectedYears.has(event.year)}" class="${state.selectedYears.has(event.year) ? 'active' : ''}">${event.year}</button>`;
  conceptYearLinks.hidden = false;
  setChronologyMode('compare');
  inspector.innerHTML = `
    <button class="inspector-close" type="button" aria-label="关闭">×</button>
    <p class="inspector-kicker">${event.year} · 学科设置与分合 · ${escapeHtml(event.display_tag)}</p>
    <h2>${escapeHtml(event.label)}</h2>
    <p>${escapeHtml(event.detail)}</p>
    <div class="inspector-meta">${event.discipline_forms.map((form) => `<span>${escapeHtml(form)}</span>`).join('')}</div>
    <small class="ontology-scope-note">${escapeHtml(event.claim_boundary)}</small>
    <div class="inspector-insights">
      <h3>来源</h3>
      ${sources.map((source) => `<article class="concept-evidence ${source.citation_allowed ? '' : 'candidate'}">
        <a href="${escapeHtml(source.locator)}" ${source.locator.startsWith('/') ? 'data-link' : 'target="_blank" rel="noopener"'}>${escapeHtml(source.title)}</a>
        <small>${escapeHtml(source.authority)}${source.pages ? ` · PDF ${source.pages.join('—')} 页` : ''}</small>
      </article>`).join('')}
    </div>`;
  inspector.querySelector('.inspector-close').addEventListener('click', () => clearConceptInspector(false));
  conceptYearLinks.querySelector('[data-concept-year]')?.addEventListener('click', (clickEvent) => {
    toggleYearSelection(event.year, { fitVisible: true });
    const active = state.selectedYears.has(event.year);
    clickEvent.currentTarget.classList.toggle('active', active);
    clickEvent.currentTarget.setAttribute('aria-pressed', String(active));
  });
  finalizeInspectorLayout(null);
}

function renderDisciplineLifecycle() {
  if (!state.disciplineLifecycle) return;
  const subjects = controlledSubjectFacetCounts(state.conceptGraph).subjects;
  const visibleSubjects = state.hideAllSubjects ? [] : subjects.filter((subject) => !state.hiddenSubjects.has(subject));
  const visibleSet = new Set(visibleSubjects);
  const events = state.disciplineLifecycle.events
    .filter((event) => yearVisible(event.year)
      && (visibleSubjects.length === subjects.length || event.public_facets.some((facet) => visibleSet.has(facet))))
    .sort((left, right) => left.year - right.year || left.id.localeCompare(right.id, 'en'));
  disciplineLifecycleStatus.textContent = `${events.length} 个来源明示事件`;
  disciplineLifecycleEvents.innerHTML = events.length
    ? events.map((event) => `<button class="discipline-event" type="button" data-discipline-event="${escapeHtml(event.id)}">
      <time>${event.year}</time><span>${escapeHtml(event.label)}</span><i>${escapeHtml(event.display_tag)}</i>
    </button>`).join('')
    : '<small>当前学科和年代范围内没有已发布的设置事件。</small>';
  disciplineLifecycleEvents.querySelectorAll('[data-discipline-event]').forEach((button) =>
    button.addEventListener('click', () => {
      const event = state.disciplineLifecycle.events.find((item) => item.id === button.dataset.disciplineEvent);
      if (!event) return;
      activateYearSelection([event.year], { fitVisible: true });
      showDisciplineEventInspector(event);
    }));
}

function restoreAllSubjects() {
  state.hideAllSubjects = false;
  state.hiddenSubjects.clear();
  renderSubjectControls();
  updateMapStatus({ fitVisible: true });
}

function renderEraControls() {
  eraButtons.innerHTML = ERAS.map((era) => `<button type="button" data-era-start="${era.start}" data-era-end="${era.end}" aria-label="${era.start} 至 ${era.end} 年，${escapeHtml(era.label)}；选择本阶段全部有资料年份" title="${escapeHtml(era.evidenceBasis)}">${era.start} · ${escapeHtml(era.shortLabel)}</button>`).join('');
  document.querySelectorAll('[data-era-end]').forEach((button) => button.addEventListener('click', () => {
    const start = Number(button.dataset.eraStart);
    const end = Number(button.dataset.eraEnd);
    activateYearSelection(state.availableYears.filter((year) => year >= start && year <= end));
    setChronologyMode('era');
  }));
  syncYearStageState();
}

function syncYearStageState() {
  renderYearCompareControls();
  const selected = [...state.selectedYears];
  const active = selected.length
    ? CURRICULUM_STAGES.find((era) => selected.every((year) => year >= era.start && year <= era.end))
    : state.introRevealActive ? curriculumStageForYear(state.maxYear) : null;
  document.querySelectorAll('[data-era-end]').forEach((button) => {
    const selected = active && Number(button.dataset.eraStart) === active.start;
    button.classList.toggle('active', Boolean(selected));
    if (selected) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  });
}

function centurySearchText(item) {
  const concepts = state.centuryConceptsByItem.get(item.id) || [];
  return `${item.year} ${item.title} ${item.parent_title} ${(item.visibility_facets || []).join(' ')} ${item.subject} ${item.stage} ${item.document_type} ${concepts.map((concept) => `${concept.label} ${concept.observed_surfaces.join(' ')}`).join(' ')}`
    .toLocaleLowerCase('zh-CN');
}

function setMapMode(mode) {
  state.mode = ['lineage', 'cross', 'structure'].includes(mode) ? mode : 'lineage';
  if (!state.conceptGraph) return;
  if (state.mode === 'structure') {
    const { root } = activeDeepContext();
    state.deepFocusId = root?.id || null;
  }
  state.cosmos?.setMode(state.mode === 'cross' ? 'cross' : 'lineage');
  document.querySelectorAll('[data-map-mode]').forEach((button) => button.classList.toggle('active', button.dataset.mapMode === state.mode));
  updateMapStatus();
}

function setMapControlsExpanded(expanded) {
  mapToolsToggle.setAttribute('aria-expanded', String(expanded));
  mapControls.setAttribute('aria-hidden', String(!expanded));
  mapControls.classList.toggle('is-collapsed', !expanded);
}

function openWorkbench({ kicker, title, tabs, active }) {
  workbenchKicker.textContent = kicker;
  workbenchTitle.textContent = title;
  workbenchTabs.innerHTML = tabs.map((tab) => `<button type="button" class="${tab.id === active ? 'active' : ''}" data-tab-href="${tab.href}">${escapeHtml(tab.label)}</button>`).join('');
  workbenchBody.innerHTML = '<div class="empty-state">正在读取证据明细…</div>';
  workbench.hidden = false;
  scrim.hidden = false;
  document.querySelectorAll('[data-tab-href]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.tabHref)));
}

function closeWorkbench(updateHistory = true) {
  workbench.hidden = true;
  scrim.hidden = true;
  workbenchBody.replaceChildren();
  if (updateHistory && !['/', '/terms'].includes(location.pathname)) {
    history.pushState({}, '', '/');
  }
}

function documentRows(documents) {
  if (!documents.length) return '<div class="empty-state">这一条件下没有已编目资料。</div>';
  return `<div class="result-list">${documents.map((doc) => `<article class="result-row"><a href="/document/${encodeURIComponent(doc.id)}" data-link>${escapeHtml(doc.title)}</a><small>${escapeHtml(doc.sort_year)} · ${escapeHtml(documentEntityLabel(doc))} · ${escapeHtml(doc.stage)} · ${escapeHtml(qualityLabel(doc))}</small><p>${escapeHtml(doc.issued_by || '')}${doc.version_label ? ` · ${escapeHtml(doc.version_label)}` : ''}</p></article>`).join('')}</div>`;
}

function centurySegmentLabel(item, segment) {
  const printed = segment.printed_page_start === segment.printed_page_end
    ? `印刷页 ${segment.printed_page_start}`
    : `印刷页 ${segment.printed_page_start}–${segment.printed_page_end}`;
  const physical = segment.physical_page_start === segment.physical_page_end
    ? `扫描物理页 ${segment.physical_page_start}`
    : `扫描物理页 ${segment.physical_page_start}–${segment.physical_page_end}`;
  const role = segment.role === 'editorial_context_excerpt' ? '随附编订说明' : segment.stage;
  return `${item.parent_title} · ${role} · ${printed} · ${physical}`;
}

function centuryItemRows(items) {
  if (!items.length) return '<div class="empty-state">这一条件下没有百年文件条目。</div>';
  return `<div class="century-result-list">${items.map((item) => {
    const concepts = state.centuryConceptsByItem.get(item.id) || [];
    const facets = (item.visibility_facets || []).join(' · ') || item.subject;
    return `<article class="century-result-row"><time>${escapeHtml(item.year)}</time><div><a href="/historical/${encodeURIComponent(item.id)}" data-link>${escapeHtml(item.title)}</a><small>${escapeHtml(facets)} · ${escapeHtml(item.stage)} · ${escapeHtml(item.document_type)} · ${item.segments.length} 个页段</small>${concepts.length ? `<p>${concepts.slice(0, 6).map((concept) => `<span>${escapeHtml(concept.label)}</span>`).join('')}</p>` : '<p class="candidate-boundary">尚无词面候选；条目身份仍可按目录与页段定位。</p>'}</div></article>`;
  }).join('')}</div>`;
}

function renderCenturyArchive(url) {
  const query = (url.searchParams.get('q') || '').trim();
  const archiveSubjects = ['课程方案', ...controlledSubjectFacetCounts(state.conceptGraph).subjects];
  const requestedSubject = url.searchParams.get('subject');
  const subject = archiveSubjects.includes(requestedSubject) ? requestedSubject : '';
  const items = state.archiveItems.filter((item) =>
    (!subject || publicSubjectFacet(item.subject) === subject
      || item.visibility_facets?.some((facet) => publicSubjectFacet(facet) === subject))
    && (!query || centurySearchText(item).includes(query.toLocaleLowerCase('zh-CN'))));
  const eraGroups = ERAS.filter((era) => era.start <= 2000).map((era) => {
    const groupItems = items.filter((item) => item.year >= era.start && item.year <= era.end);
    if (!groupItems.length) return '';
    return `<section class="century-era-list"><header><p>${era.start}–${era.end}</p><h2>${escapeHtml(era.label)}</h2><span>${groupItems.length} 条</span></header>${centuryItemRows(groupItems)}</section>`;
  }).join('');
  workbenchBody.innerHTML = `<div class="workspace-grid century-workspace"><aside class="workspace-aside"><h2>1902–2000 百年资料目录</h2><p>${escapeHtml(state.archiveItems.length)} 条去重 bounded items 覆盖 11 个公开检索分面及课程计划卷；历史入口合并检索历史与历史与社会，底层课程形态仍分别保存。它们是星点背后的文件与物理页证据，不构成第二条时间轴；只有受控词面观察进入主星图。</p><form class="work-form" id="century-form"><label for="century-query">篇名或候选词面</label><input id="century-query" name="q" value="${escapeHtml(query)}" placeholder="例如：社会科、本国史、调查搜集"><label for="century-subject">学科分面或课程卷</label><select id="century-subject" name="subject"><option value="">全部资料</option>${archiveSubjects.map((name) => `<option value="${escapeHtml(name)}" ${subject === name ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select><button class="work-button" type="submit">筛选百年资料</button></form><p class="candidate-boundary">${escapeHtml(state.pre2001Layer.assertion_boundary)}</p></aside><main class="workspace-main">${eraGroups || '<div class="empty-state">没有匹配条目。</div>'}</main></div>`;
  document.querySelector('#century-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const params = new URLSearchParams();
    if (form.get('q')) params.set('q', form.get('q'));
    if (form.get('subject')) params.set('subject', form.get('subject'));
    navigate(`/archive${params.size ? `?${params}` : ''}`);
  });
}

function renderHistoricalItem(id) {
  const item = state.centuryItemById.get(id);
  if (!item) {
    workbenchBody.innerHTML = '<div class="empty-state">未找到这条百年文件记录。</div>';
    return;
  }
  const concepts = (state.centuryConceptsByItem.get(item.id) || [])
    .sort((left, right) => right.mention_count - left.mention_count || left.label.localeCompare(right.label, 'zh-CN'));
  const conceptIds = new Set(concepts.map((concept) => concept.concept_id));
  const related = state.archiveItems
    .filter((candidate) => candidate.id !== item.id)
    .map((candidate) => {
      const shared = (state.centuryConceptsByItem.get(candidate.id) || [])
        .filter((concept) => conceptIds.has(concept.concept_id));
      return { candidate, shared };
    })
    .filter((entry) => entry.shared.length)
    .sort((left, right) => right.shared.length - left.shared.length
      || Math.abs(left.candidate.year - item.year) - Math.abs(right.candidate.year - item.year))
    .slice(0, 6);
  const conceptRelations = state.centuryLayer.relations
    .filter((relation) => relation.type === 'surface_co_observed_in_item'
      && conceptIds.has(relation.source) && conceptIds.has(relation.target))
    .slice(0, 8);
  const conceptLabel = new Map([...state.centuryConceptsByItem.values()]
    .flat()
    .map((observation) => [observation.concept_id, observation.label]));
  const segments = item.segments.map((segment) => `<li id="page-${segment.physical_page_start}"><a href="/historical/${encodeURIComponent(item.id)}#page-${segment.physical_page_start}" data-link>${escapeHtml(centurySegmentLabel(item, segment))}</a></li>`).join('');
  const observations = concepts.length
    ? concepts.map((concept) => `<article class="century-concept-candidate"><h3>${escapeHtml(concept.label)}</h3><p>${escapeHtml(concept.category)} · ${concept.mention_count} 次词面命中 · 扫描物理页 ${escapeHtml(concept.observed_physical_pages.join('、'))}</p><small>${escapeHtml(concept.observed_surfaces.join(' / '))}</small></article>`).join('')
    : '<div class="empty-state">当前词表没有命中；不代表该文件没有重要概念。</div>';
  const relationRows = conceptRelations.length
    ? conceptRelations.map((relation) => `<li><b>${escapeHtml(conceptLabel.get(relation.source) || relation.source)}</b><span>同条目共现 ${relation.metric.shared_item_count} 次</span><b>${escapeHtml(conceptLabel.get(relation.target) || relation.target)}</b></li>`).join('')
    : '<li class="empty-state">没有达到两条文件共同出现门槛的词面对。</li>';
  const relatedRows = related.length
    ? related.map(({ candidate, shared }) => `<article class="result-row"><a href="/historical/${encodeURIComponent(candidate.id)}" data-link>${escapeHtml(candidate.year)} · ${escapeHtml(candidate.title)}</a><small>${escapeHtml(candidate.subject)} · 共同词面 ${escapeHtml(shared.map((concept) => concept.label).join('、'))}</small></article>`).join('')
    : '<div class="empty-state">当前没有按共同词面连接的其他条目。</div>';
  const itemFacets = (item.visibility_facets || []).join(' · ') || item.subject;
  workbenchBody.innerHTML = `<div class="reader-grid century-reader"><article class="reader-document"><p class="century-document-kicker">${escapeHtml(item.year)} · ${escapeHtml(itemFacets)} · 候选文件身份</p><h2>${escapeHtml(item.title)}</h2><div class="reader-candidate-boundary"><b>候选层边界</b><p>${escapeHtml(item.assertion_boundary || state.centuryLayer.assertion_boundary)}</p></div><h2>目录绑定页段</h2><ol class="century-segments">${segments}</ol><h2>OCR 词面观察</h2><div class="century-concepts">${observations}</div></article><aside class="reader-facts"><h3>文件身份</h3><p>年份：${escapeHtml(item.year)}<br>学科分面：${escapeHtml(itemFacets)}<br>学段：${escapeHtml(item.stage)}<br>类型：${escapeHtml(item.document_type)}<br>题名状态：${escapeHtml(item.title_status)}<br>身份：目录／标题绑定候选<br>引文权限：关闭<br>语义断言：关闭</p><p>父级资料：${escapeHtml(item.parent_title)}</p><a class="action-button primary" href="/archive?subject=${encodeURIComponent(item.visibility_facets?.[0] || item.subject)}" data-link>返回百年资料目录</a><h3>候选词面关系</h3><ul class="century-relation-list">${relationRows}</ul><h3>共同词面文件</h3>${relatedRows}</aside></div>`;
  if (location.hash) requestAnimationFrame(() => document.querySelector(location.hash)?.scrollIntoView({ block: 'center' }));
}

async function compareSubjectFacet(facet) {
  const plan = subjectQueryPlan(facet);
  if (!plan.length) throw new Error('该分面当前没有可核验的学科版本');
  const payloads = await Promise.all(plan.map(async ({ canonicalSubject }) => ({
    canonicalSubject,
    data: await api(`/api/compare?subject=${encodeURIComponent(canonicalSubject)}`),
  })));
  const documents = uniqueRows(payloads.flatMap(({ canonicalSubject, data }) =>
    (data.documents || []).map((document) => ({
      ...document,
      canonical_subject: document.canonical_subject || canonicalSubject,
    }))), (document) => document.id)
    .sort((left, right) => Number(left.sort_year || 0) - Number(right.sort_year || 0)
      || String(left.canonical_subject).localeCompare(String(right.canonical_subject), 'zh-CN')
      || String(left.title).localeCompare(String(right.title), 'zh-CN'));
  const insights = uniqueRows(payloads.flatMap(({ canonicalSubject, data }) =>
    (data.insights || []).map((insight) => ({
      ...insight,
      canonical_subject: insight.subject || canonicalSubject,
    }))), (insight) => insight.id || `${insight.subject}|${insight.era}|${insight.dimension}|${insight.title}`);
  return { plan, documents, insights };
}

async function searchSubjectFacet(query, facet) {
  if (!facet) return api(`/api/search?q=${encodeURIComponent(query)}&subject=`);
  const plan = subjectQueryPlan(facet);
  if (!plan.length) throw new Error('该分面当前没有可检索的学科正文');
  const payloads = await Promise.all(plan.map(async ({ canonicalSubject }) => ({
    canonicalSubject,
    data: await api(`/api/search?q=${encodeURIComponent(query)}&subject=${encodeURIComponent(canonicalSubject)}`),
  })));
  const passages = uniqueRows(payloads.flatMap(({ canonicalSubject, data }) =>
    (data.passages || []).map((passage) => ({
      ...passage,
      subject: passage.subject || canonicalSubject,
      entity_label: passage.entity_label || passage.subject || canonicalSubject,
    }))), (passage) => passage.id)
    .sort((left, right) => Number(left.score || 0) - Number(right.score || 0)
      || String(left.subject).localeCompare(String(right.subject), 'zh-CN'))
    .slice(0, 30);
  return { query, passages };
}

function searchOcrCandidatePages(query, facet) {
  if (!state.ocrLayer || (facet && facet !== '语文')) return [];
  const needle = query.trim().toLocaleLowerCase('zh-CN');
  if (needle.length < 2) return [];
  return state.ocrLayer.pages.flatMap((page) => {
    const searchable = page.content.replace(/\s+/g, ' ');
    const offset = searchable.toLocaleLowerCase('zh-CN').indexOf(needle);
    if (offset === -1) return [];
    const start = Math.max(0, offset - 80);
    const end = Math.min(searchable.length, offset + needle.length + 140);
    return [{ page: page.page, snippet: searchable.slice(start, end).trim() }];
  }).slice(0, 20);
}

function ocrPipelineSummaryHtml() {
  const layer = state.ocrLayer;
  const summary = state.ocrCoverageSummary;
  if (!layer || !summary) return '';
  const active = layer.documents.find((document) => document.status === 'active');
  return `<section class="ocr-data-summary"><p><b>OCR 候选覆盖已闭合</b><span>${escapeHtml(summary.coverage.candidate_covered_pages)}/${escapeHtml(summary.coverage.nominal_pages)} 页 · 缺口 ${escapeHtml(summary.coverage.candidate_remaining_pages)}</span></p><p>双引擎逐字精确一致并完成来源绑定 ${escapeHtml(summary.machine_verification?.machine_verified_exact_pages || 0)} 页；其余 ${escapeHtml(summary.machine_verification?.machine_adjudication_pending_pages || 0)} 页进入第三引擎、表格结构或空白栅格自动仲裁，人工必审 ${escapeHtml(summary.machine_verification?.human_required_pages || 0)} 页。正式引文仍为 ${escapeHtml(summary.coverage.citation_ready_pages)}。${active ? ` 当前任务：${escapeHtml(active.completed_pages)}/${escapeHtml(active.page_count)} 页。` : ''}</p></section>`;
}

async function renderCompare(url) {
  const subjects = subjectFacetNames();
  const fallback = documentDisplayFacet(state.selectedDocument) || subjects.find((subject) => subject === '语文') || subjects[0] || '';
  const requestedSubject = url.searchParams.get('subject') || '';
  const subject = displayFacetForSubject(requestedSubject) || fallback;
  workbenchBody.innerHTML = `<div class="workspace-grid"><aside class="workspace-aside"><h2>沿版本看变化</h2><p>连线表示同学科、同学段的年代相邻序列，不自动宣称法律上的替代关系。编辑结论必须回到证据文献。</p><form class="work-form" id="compare-form"><label for="compare-subject">学科</label><select id="compare-subject" name="subject">${subjects.map((name) => `<option ${name === subject ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select><button class="work-button" type="submit">更新版本河流</button></form></aside><main class="workspace-main" id="compare-results"><div class="empty-state">正在整理 ${escapeHtml(subject)} 的版本序列…</div></main></div>`;
  document.querySelector('#compare-form').addEventListener('submit', (event) => {
    event.preventDefault();
    navigate(`/compare?subject=${encodeURIComponent(new FormData(event.currentTarget).get('subject'))}`);
  });
  try {
    const data = await compareSubjectFacet(subject);
    const entries = data.documents.map((doc) => `<article class="version-entry"><time>${escapeHtml(doc.sort_year || '年代待核')}</time><h3>${escapeHtml(doc.title)}</h3><p>${escapeHtml(doc.canonical_subject)} · ${escapeHtml(doc.stage)} · ${escapeHtml(statusLabel(doc.current_status))}<br>${escapeHtml(qualityLabel(doc))}</p><a href="/document/${encodeURIComponent(doc.id)}" data-link>查看资料 →</a></article>`).join('');
    const findings = data.insights.length ? data.insights.map((item) => `<article class="insight-line"><time>${escapeHtml(item.canonical_subject)} · ${escapeHtml(item.era)} · ${escapeHtml(item.dimension)}</time><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.summary)}</p></article>`).join('') : '<div class="empty-state">尚无经编辑核验的变化摘要；版本文献仍可逐份查看。</div>';
    const members = data.plan.map((item) => item.canonicalSubject).join('、');
    document.querySelector('#compare-results').innerHTML = `<h2>${escapeHtml(subject)}版本河流</h2><p>按 ${escapeHtml(members)} 的学科身份分别查询；版本标签不合并。</p><div class="version-river">${entries}</div><h2>经核验的变化判断</h2>${findings}`;
  } catch (error) {
    document.querySelector('#compare-results').innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

async function renderSources(url) {
  const query = (url.searchParams.get('q') || '').trim();
  const subjects = subjectFacetNames();
  const requestedSubject = url.searchParams.get('subject') || '';
  const subject = displayFacetForSubject(requestedSubject) || '';
  const facetIndex = subjectFacetIndex();
  let docs = (subject ? filterDocumentsBySubjectFacet(state.documents, subject, facetIndex) : state.documents)
    .filter((doc) => !query || `${doc.title}${documentEntityLabel(doc)}${doc.issued_by}${doc.version_label}`.includes(query));
  workbenchBody.innerHTML = `<div class="workspace-grid"><aside class="workspace-aside"><h2>资料与全文</h2><p>元数据用于定位版本；OCR 待核层可浏览和发现概念，只有通过图像、OCR 与在线同版核查门槛的正文才进入引文与证据 AI。</p><form class="work-form" id="source-form"><label for="source-query">篇名、机构或正文关键词</label><input id="source-query" name="q" value="${escapeHtml(query)}" placeholder="例如：学业质量"><label for="source-subject">学科分面</label><select id="source-subject" name="subject"><option value="">不限分面</option>${subjects.map((name) => `<option ${name === subject ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select><button class="work-button" type="submit">检索资料</button></form></aside><main class="workspace-main" id="source-results">${ocrPipelineSummaryHtml()}<h2>${query ? `“${escapeHtml(query)}”的结果` : '已编目资料'}</h2>${documentRows(docs.slice(0, 80))}</main></div>`;
  document.querySelector('#source-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const values = new URLSearchParams(new FormData(event.currentTarget));
    navigate(`/sources?${values.toString()}`);
  });
  if (query.length >= 2) {
    const ocrMatches = searchOcrCandidatePages(query, subject);
    let passages = [];
    try {
      const data = await searchSubjectFacet(query, subject);
      passages = data.passages || [];
    } catch (error) {
      toast(error.message);
    }
    const citationHtml = passages.length ? `<h2>可引文正文</h2><div class="result-list">${passages.map((passage) => `<article class="result-row"><a href="/document/${encodeURIComponent(passage.document_id)}#p-${passage.id}" data-link>${escapeHtml(passage.title)}</a><small>${escapeHtml(passage.entity_label || passage.subject)} · ${escapeHtml(passage.version_label)} · ${escapeHtml(passage.source_locator)}</small><p>${escapeHtml(passage.body)}</p></article>`).join('')}</div>` : '';
    const ocrHtml = ocrMatches.length ? `<h2>OCR 待核命中</h2><p class="candidate-boundary">以下来自 2022 版语文课标全页 OCR，只用于浏览与概念发现，不可引用，也不进入证据 AI。</p><div class="result-list">${ocrMatches.map((match) => `<article class="result-row ocr-candidate-row"><a href="/document/moe-2022-03#ocr-p-${match.page}" data-link>义务教育语文课程标准（2022年版）</a><small>语文 · 2022年版 · PDF p.${escapeHtml(match.page)} · OCR待核</small><p>${escapeHtml(match.snippet)}</p></article>`).join('')}</div>` : '';
    document.querySelector('#source-results').innerHTML = `${ocrPipelineSummaryHtml()}${citationHtml}${ocrHtml}<h2>元数据匹配</h2>${documentRows(docs.slice(0, 40))}`;
  }
}

async function renderDocument(id) {
  try {
    const data = await api(`/api/documents/${encodeURIComponent(id)}?limit=200`);
    const doc = data.document;
    state.selectedDocument = doc;
    const source = doc.source_url ? `<a href="${escapeHtml(doc.source_url)}" target="_blank" rel="noopener">发布页 / 原件 ↗</a>` : '原件链接待补';
    const ocrCandidate = state.ocrLayer?.source?.document_id === id ? state.ocrLayer : null;
    const citationParagraphs = data.paragraphs.map((paragraph) => `<section class="paragraph ${paragraph.uncertainty_note ? 'uncertain' : ''}" id="p-${paragraph.id}"><span class="paragraph-number">P:${paragraph.id}<br>${escapeHtml(paragraph.source_locator)}</span>${escapeHtml(paragraph.body)}${paragraph.uncertainty_note ? `<small class="uncertainty-note">可能有问题：${escapeHtml(paragraph.uncertainty_note)}</small>` : ''}</section>`).join('');
    const ocrParagraphs = ocrCandidate?.pages.map((page) => `<section class="paragraph ocr-candidate" id="ocr-p-${page.page}"><span class="paragraph-number">OCR<br>PDF p.${escapeHtml(page.page)}</span><div>${escapeHtml(page.content)}</div></section>`).join('') || '';
    const paragraphs = citationParagraphs || ocrParagraphs || '<div class="empty-state">该记录目前只有已核元数据，正文尚未达到上线门槛。</div>';
    const textLayerIntro = ocrCandidate && !citationParagraphs ? `<section class="candidate-boundary reader-candidate-boundary"><b>OCR 待核全文 · 109/109 页完成</b><p>已绑定原 PDF SHA 并逐页校验 OCR 文件哈希，可用于浏览、检索和概念发现；尚未通过版面与引文复核，不可逐字引用，也不进入证据 AI。</p></section>` : '';
    const verification = data.verifications.length ? data.verifications.map((item) => `<article class="verification-row"><b>${escapeHtml(item.entity_label)} · ${escapeHtml(verificationLabel(item.verification_status))}</b><p>${escapeHtml(item.resolution)}</p>${item.uncertainty_note ? `<small class="uncertainty-note">可能有问题：${escapeHtml(item.uncertainty_note)}</small>` : ''}${(item.evidence || []).map((evidence) => `<p><a href="${escapeHtml(evidence.sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(evidence.publisher)}</a> · ${escapeHtml(verificationLabel(evidence.versionMatch))} · ${escapeHtml(evidence.factSummary)}</p>`).join('')}</article>`).join('') : '<div class="empty-state">尚无在线同版核查记录。</div>';
    const documentIdentityKind = documentIdentityKindLabel(doc);
    const documentFacet = documentDisplayFacet(doc);
    const relatedFacet = doc.taxonomy_entity_kind === 'assessment_subject' ? documentFacet : null;
    const sourceVariant = documentSourceVariant(doc);
    workbenchBody.innerHTML = `<div class="reader-grid"><article class="reader-document"><h2>${escapeHtml(doc.title)}</h2><p>${escapeHtml(doc.issued_by)}${doc.issued_date ? ` · ${escapeHtml(doc.issued_date)}` : ''} · ${escapeHtml(qualityLabel(doc))}</p>${textLayerIntro}${paragraphs}<h2>在线三证核查</h2><p>只有同文同版来源可校正文句；同篇异版仅旁证稳定事实。</p>${verification}</article><aside class="reader-facts"><h3>资料身份</h3><p>编号：${escapeHtml(doc.id)}<br>${escapeHtml(documentIdentityKind)}：${escapeHtml(documentEntityLabel(doc))}${relatedFacet ? `<br>关联学科分面：${escapeHtml(relatedFacet)}` : ''}${sourceVariant ? `<br>来源标注：${escapeHtml(sourceVariant)}` : ''}<br>学段：${escapeHtml(doc.stage)}<br>版本：${escapeHtml(doc.version_label)}<br>状态：${escapeHtml(statusLabel(doc.current_status))}<br>文本质量：${escapeHtml(doc.text_quality_status || '待评估')}<br>页数：${doc.page_count || '待核'}</p><p>${source}</p><div class="inspector-actions">${documentFacet ? `<a class="action-button" href="/compare?subject=${encodeURIComponent(documentFacet)}" data-link>版本比较</a>` : ''}<a class="action-button" href="/discussions?documentId=${encodeURIComponent(doc.id)}" data-link>教师讨论</a></div></aside></div>`;
    if (location.hash) requestAnimationFrame(() => document.querySelector(location.hash)?.scrollIntoView({ block: 'center' }));
  } catch (error) {
    workbenchBody.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

async function researchSubjectFacet(query, facet) {
  if (!facet) {
    const data = await api('/api/ai/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, subject: '' }),
    });
    return { ...data, canonicalSubjects: [], omittedSubjects: [] };
  }

  const plan = subjectQueryPlan(facet);
  if (!plan.length) throw new Error('该分面当前没有可研究的学科正文');
  const evidenceChecks = await Promise.all(plan.map(async ({ canonicalSubject }) => ({
    canonicalSubject,
    data: await api(`/api/search?q=${encodeURIComponent(query)}&subject=${encodeURIComponent(canonicalSubject)}`),
  })));
  const evidenced = evidenceChecks.filter(({ data }) => (data.passages || []).length > 0);
  const omittedSubjects = evidenceChecks.filter(({ data }) => !(data.passages || []).length)
    .map(({ canonicalSubject }) => canonicalSubject);
  if (!evidenced.length) throw new Error('该分面的各学科身份均未找到可引证据，请调整关键词');

  const answers = await Promise.all(evidenced.map(async ({ canonicalSubject }) => ({
    canonicalSubject,
    data: await api('/api/ai/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, subject: canonicalSubject }),
    }),
  })));
  const canonicalSubjects = answers.map(({ canonicalSubject }) => canonicalSubject);
  const answer = answers.map(({ canonicalSubject, data }) => `【${canonicalSubject}】\n${data.answer}`).join('\n\n');
  const boundary = omittedSubjects.length
    ? `\n\n分面证据边界：已分别查询 ${canonicalSubjects.join('、')}；${omittedSubjects.join('、')} 当前无可引正文，未生成结论。`
    : `\n\n分面证据边界：已按 ${canonicalSubjects.join('、')} 的学科身份分别检索与回答，未合并版本身份。`;
  return {
    answer: `${answer}${boundary}`,
    citations: uniqueRows(answers.flatMap(({ data }) => data.citations || []), (citation) => citation.paragraphId),
    retrievalCount: answers.reduce((total, { data }) => total + Number(data.retrievalCount || 0), 0),
    canonicalSubjects,
    omittedSubjects,
  };
}

async function renderAi() {
  const me = await loadMe();
  const subjects = subjectFacetNames();
  if (!me.authenticated) {
    workbenchBody.innerHTML = `<div class="login-note"><h2>登录后建立可追踪的证据研究会话</h2><p>AI 只能引用本站本轮检索返回且已通过核查门槛的段落；检索失败时不会用模型常识补齐。</p><a class="work-button" href="https://my.bdfz.net/?returnTo=${encodeURIComponent(location.href)}">前往统一用户中心登录</a></div>`;
    return;
  }
  workbenchBody.innerHTML = `<div class="ai-grid"><form class="work-form" id="ai-form"><h2>证据限定研究</h2><label for="ai-query">教师研究问题</label><textarea id="ai-query" name="query" rows="7" minlength="8" required placeholder="例如：义务教育语文从2011版到2022版，课程内容组织方式发生了哪些可核验变化？"></textarea><label for="ai-subject">学科分面</label><select id="ai-subject" name="subject"><option value="">跨学科</option>${subjects.map((name) => `<option>${escapeHtml(name)}</option>`).join('')}</select><button class="work-button" type="submit">检索并回答</button></form><div><h2>回答与引文</h2><div class="ai-answer" id="ai-answer">尚未提问。每个事实必须回到 [P:编号]。</div><div class="citation-list" id="ai-citations"></div></div></div>`;
  document.querySelector('#ai-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    const answer = document.querySelector('#ai-answer');
    button.disabled = true;
    answer.textContent = '正在检索已核正文并校验引文编号…';
    try {
      const payload = Object.fromEntries(new FormData(form));
      const facet = displayFacetForSubject(payload.subject) || '';
      const data = await researchSubjectFacet(payload.query, facet);
      answer.textContent = data.answer;
      document.querySelector('#ai-citations').innerHTML = data.citations.map((citation) => `<article class="citation-row"><a href="/document/${encodeURIComponent(citation.documentId)}#p-${citation.paragraphId}" data-link>[P:${citation.paragraphId}] ${escapeHtml(citation.title)}</a><small>${escapeHtml(taxonomyIdentityKindLabel(citation.taxonomyEntityKind))} · ${escapeHtml(citation.entityLabel || citation.subject)}${citation.displayFacet ? ` · ${escapeHtml(citation.displayFacet)}分面` : ''} · ${escapeHtml(citation.locator)}</small><p>${escapeHtml(citation.excerpt)}</p></article>`).join('');
      window.BdfzIdentity?.recordEvent?.({ siteKey: 'curriculum', recordKey: `ai-research:${Date.now()}`, title: '课程标准证据研究', summary: '完成一次带引文的课程标准研究', itemGroup: 'teacher-research', itemType: 'rag-query', contentFormat: 'curriculum-atlas-rag-v1', sourceUrl: location.href, payload: { eventName: 'ai_evidence_research', subject: facet || 'cross-subject', canonicalSubjectCount: data.canonicalSubjects.length, retrievalCount: data.retrievalCount } }).catch(() => {});
    } catch (error) {
      answer.textContent = error.message;
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  });
}

function setupTurnstile(container, callback) {
  if (!state.meta.turnstileSiteKey) {
    container.innerHTML = '<p>匿名讨论暂不可提交；请先统一登录。</p>';
    return;
  }
  const render = () => window.turnstile.render(container, { sitekey: state.meta.turnstileSiteKey, callback, 'expired-callback': () => callback('') });
  if (window.turnstile) { render(); return; }
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.async = true;
  script.onload = render;
  document.head.append(script);
}

async function loadComments(documentId) {
  const root = document.querySelector('#comment-list');
  if (!root) return;
  try {
    const data = await api(`/api/comments?documentId=${encodeURIComponent(documentId)}`);
    root.innerHTML = data.comments.length ? data.comments.map((item) => `<article class="comment-row"><h3>${escapeHtml(item.author_name)}</h3><header>${new Date(`${item.created_at}Z`).toLocaleString('zh-CN')}</header><p>${escapeHtml(item.body)}</p></article>`).join('') : '<div class="empty-state">尚无公开讨论。第一条判断也应说明所据版本或条文。</div>';
  } catch (error) {
    root.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

async function renderDiscussions(url) {
  const me = await loadMe();
  const documentId = url.searchParams.get('documentId') || state.selectedDocument?.id || state.documents[0]?.id || '';
  const docs = state.documents;
  workbenchBody.innerHTML = `<div class="workspace-grid"><aside class="workspace-aside"><h2>围绕同一证据讨论</h2><p>统一登录内容直接公开；匿名内容经 Turnstile 后进入审核。不要写入学生个人信息。</p><form class="work-form" id="discussion-picker"><label for="discussion-document">资料</label><select id="discussion-document" name="documentId">${docs.map((doc) => `<option value="${escapeHtml(doc.id)}" ${doc.id === documentId ? 'selected' : ''}>${escapeHtml(doc.sort_year)} · ${escapeHtml(doc.title)}</option>`).join('')}</select><button class="work-button secondary" type="submit">切换讨论</button></form><form class="work-form" id="comment-form"><h2>提交讨论</h2>${me.authenticated ? `<p>以 ${escapeHtml(me.user.display_name || me.user.slug)} 发布。</p>` : '<label for="author-name">署名</label><input id="author-name" name="authorName" maxlength="40" value="匿名教师">'}<label for="comment-body">内容</label><textarea id="comment-body" name="body" rows="6" minlength="8" maxlength="2000" required></textarea><div class="turnstile-slot" id="turnstile-box"></div><button class="work-button" type="submit">${me.authenticated ? '发布讨论' : '提交审核'}</button></form></aside><main class="workspace-main"><h2>教师讨论</h2><div class="comment-list" id="comment-list"><div class="empty-state">正在加载…</div></div></main></div>`;
  document.querySelector('#discussion-picker').addEventListener('submit', (event) => {
    event.preventDefault();
    navigate(`/discussions?documentId=${encodeURIComponent(new FormData(event.currentTarget).get('documentId'))}`);
  });
  let turnstileToken = '';
  if (!me.authenticated) setupTurnstile(document.querySelector('#turnstile-box'), (token) => { turnstileToken = token; });
  else document.querySelector('#turnstile-box').remove();
  document.querySelector('#comment-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(form));
      body.documentId = documentId;
      body.turnstileToken = turnstileToken;
      const result = await api('/api/comments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      toast(result.message);
      if (result.status === 'approved') await loadComments(documentId);
      else window.turnstile?.reset();
      form.querySelector('textarea').value = '';
    } catch (error) {
      toast(error.message);
      window.turnstile?.reset();
    } finally {
      button.disabled = false;
    }
  });
  loadComments(documentId);
}

async function renderAdmin() {
  const me = await loadMe();
  if (!me.admin) {
    workbenchBody.innerHTML = '<div class="empty-state">当前统一登录账号不在服务端管理员白名单中。</div>';
    return;
  }
  try {
    const [summary, comments] = await Promise.all([api('/api/admin/summary'), api('/api/comments?moderation=1')]);
    workbenchBody.innerHTML = `<div class="workspace-grid"><aside class="workspace-aside"><h2>审核概况</h2><p>待审核 ${summary.pending.count || 0} · 开放举报 ${summary.reports.count || 0} · 7 日 AI 引文失败 ${summary.aiFailures.count || 0}</p></aside><main class="workspace-main"><h2>待审核讨论</h2><div class="comment-list">${comments.comments.filter((item) => item.status === 'pending').map((item) => `<article class="comment-row"><h3>${escapeHtml(item.author_name)}</h3><p>${escapeHtml(item.body)}</p><div class="inspector-actions"><button class="work-button" data-moderate="approved" data-id="${item.id}">通过</button><button class="work-button secondary" data-moderate="rejected" data-id="${item.id}">拒绝</button></div></article>`).join('') || '<div class="empty-state">当前没有待审核讨论。</div>'}</div></main></div>`;
    document.querySelectorAll('[data-moderate]').forEach((button) => button.addEventListener('click', async () => {
      try {
        await api(`/api/admin/comments/${button.dataset.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: button.dataset.moderate }) });
        toast('审核状态已更新');
        renderAdmin();
      } catch (error) { toast(error.message); }
    }));
  } catch (error) {
    workbenchBody.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

async function route() {
  const url = new URL(location.href);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  try {
    await loadBase();
    if (!state.cosmos) initializeCosmos();
    if (path === '/terms') {
      closeWorkbench(false);
      setMapMode('cross');
      const conceptId = url.searchParams.get('term');
      const episodeId = url.searchParams.get('episode');
      const episode = state.conceptGraph.episodes.find((item) => item.id === episodeId && yearVisible(item.time.year))
        || state.conceptGraph.episodes.filter((item) => item.concept_id === conceptId && yearVisible(item.time.year))
          .sort((left, right) => right.time.year - left.time.year)[0];
      if (episode) showConceptInspector(episode);
      return;
    }
    if (path === '/subjects') {
      closeWorkbench(false);
      const subject = displayFacetForSubject(url.searchParams.get('subject'));
      const subjects = controlledSubjectFacetCounts(state.conceptGraph).subjects;
      if (subject && subjects.includes(subject)) {
        state.hideAllSubjects = false;
        state.hiddenSubjects.clear();
        subjects.forEach((name) => { if (name !== subject) state.hiddenSubjects.add(name); });
        state.hiddenSubjects.delete(subject);
        renderSubjectControls();
        updateMapStatus({ fitVisible: true });
      }
      history.replaceState({}, '', '/');
      return;
    }
    if (path === '/timeline' || path === '/archive') {
      if (path === '/timeline') history.replaceState({}, '', `/archive${url.search}`);
      openWorkbench({
        kicker: '版本 · 资料',
        title: '百年资料与证据',
        tabs: [
          { id: 'archive', label: '百年资料', href: `/archive${url.search}` },
          { id: 'compare', label: '版本比较', href: '/compare' },
          { id: 'sources', label: '正式资料库', href: '/sources' },
        ],
        active: 'archive',
      });
      renderCenturyArchive(url);
      return;
    }
    if (path === '/') {
      closeWorkbench(false);
      return;
    }
    if (path === '/compare') {
      openWorkbench({ kicker: '版本 · 资料', title: '版本与资料', tabs: [{ id: 'archive', label: '百年资料', href: '/archive' }, { id: 'compare', label: '版本比较', href: url.pathname + url.search }, { id: 'sources', label: '资料检索', href: '/sources' }], active: 'compare' });
      await renderCompare(url);
      return;
    }
    if (path === '/sources' || path === '/search') {
      openWorkbench({ kicker: '版本 · 资料', title: '版本与资料', tabs: [{ id: 'archive', label: '百年资料', href: '/archive' }, { id: 'compare', label: '版本比较', href: '/compare' }, { id: 'sources', label: '资料检索', href: url.pathname + url.search }], active: 'sources' });
      await renderSources(url);
      return;
    }
    if (path.startsWith('/document/')) {
      const id = decodeURIComponent(path.slice('/document/'.length));
      const documentFacet = documentDisplayFacet(state.documents.find((doc) => doc.id === id));
      const tabs = [{ id: 'reader', label: '正文与核查', href: `${path}${url.hash}` }];
      if (documentFacet) tabs.push({ id: 'compare', label: '同分面版本', href: `/compare?subject=${encodeURIComponent(documentFacet)}` });
      openWorkbench({ kicker: '资料原文', title: '证据明细', tabs, active: 'reader' });
      await renderDocument(id);
      return;
    }
    if (path.startsWith('/historical/')) {
      const id = decodeURIComponent(path.slice('/historical/'.length));
      const item = state.centuryItemById.get(id);
      const tabs = [{ id: 'historical', label: '候选页段与词面', href: `${path}${url.hash}` }, { id: 'archive', label: '百年资料', href: `/archive${item ? `?subject=${encodeURIComponent(item.subject)}` : ''}` }];
      openWorkbench({ kicker: '百年文件候选层', title: '文件定位与关系', tabs, active: 'historical' });
      renderHistoricalItem(id);
      return;
    }
    if (path === '/ai') {
      openWorkbench({ kicker: '研究 · 讨论', title: '教师研究', tabs: [{ id: 'ai', label: 'AI 研究', href: '/ai' }, { id: 'discussion', label: '教师讨论', href: '/discussions' }], active: 'ai' });
      await renderAi();
      return;
    }
    if (path === '/discussions') {
      openWorkbench({ kicker: '研究 · 讨论', title: '教师研究', tabs: [{ id: 'ai', label: 'AI 研究', href: '/ai' }, { id: 'discussion', label: '教师讨论', href: url.pathname + url.search }], active: 'discussion' });
      await renderDiscussions(url);
      return;
    }
    if (path === '/admin') {
      openWorkbench({ kicker: '运营', title: '内容审核', tabs: [{ id: 'admin', label: '审核队列', href: '/admin' }, { id: 'discussion', label: '教师讨论', href: '/discussions' }], active: 'admin' });
      await renderAdmin();
      return;
    }
    toast('没有这条路径，已返回星图');
    history.replaceState({}, '', '/');
    closeWorkbench(false);
  } catch (error) {
    loading.querySelector('p').textContent = `资料暂时无法载入：${error.message}`;
    toast(error.message);
  }
}

function startCenturyReveal() {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const onHome = location.pathname.replace(/\/+$/, '') === '';
  const firstYear = state.minYear;
  const lastYear = state.availableYears.at(-1);
  state.selectedYears.clear();
  if (reducedMotion || !onHome || !Number.isFinite(firstYear) || !Number.isFinite(lastYear)) {
    state.maxYear = lastYear;
    syncYearStageState();
    updateMapStatus();
    state.introRevealComplete = true;
    loading.classList.add('ready');
    return;
  }
  state.introRevealActive = true;
  state.maxYear = firstYear;
  syncYearStageState();
  updateMapStatus();
  loading.classList.add('ready');
  const startedAt = performance.now();
  const duration = 3600;
  let lastRenderedYear = firstYear - 1;
  const reveal = (time) => {
    if (!state.introRevealActive) return;
    const progress = Math.min(1, (time - startedAt) / duration);
    const eased = 1 - (1 - progress) ** 2.2;
    const year = Math.min(lastYear, Math.floor(firstYear + (lastYear - firstYear) * eased));
    if (year !== lastRenderedYear) {
      lastRenderedYear = year;
      state.maxYear = year;
      syncYearStageState();
      state.cosmos?.setFilters({
        hiddenSubjects: state.hiddenSubjects,
        hideAll: state.hideAllSubjects,
        maxYear: year,
        selectedYears: state.selectedYears,
        query: state.query,
      });
      if (state.disciplineLifecycle.events.some((event) => event.year === year)) renderDisciplineLifecycle();
    }
    if (progress < 1) {
      requestAnimationFrame(reveal);
      return;
    }
    state.introRevealActive = false;
    state.introRevealComplete = true;
    syncYearStageState();
    updateMapStatus({ fitVisible: true });
  };
  requestAnimationFrame(reveal);
}

function initializeCosmos() {
  state.cosmos = new CurriculumCosmos(mount, {
    onSelect: selectConceptEpisode,
    onHover: showTooltip,
  });
  state.cosmos.setData(state.conceptGraph);
  setTheme(state.theme, { persist: false });
  renderSubjectControls();
  renderEraControls();
  setChronologyMode(state.chronologyMode);
  startCenturyReveal();
  diagnosticsReadyAt = performance.now();
  window.__CURRICULUM_ATLAS_DIAGNOSTICS__ = () => ({
    ready: true,
    ready_ms: Number((diagnosticsReadyAt - diagnosticsStartedAt).toFixed(3)),
    graph: state.cosmos.performanceSnapshot(),
    interface: { theme: state.theme, chronology_mode: state.chronologyMode },
    data: {
      episodes: state.conceptGraph.episodes.length,
      edges: state.conceptGraph.edges.length,
      evidence: state.conceptGraph.evidence.length,
      subject_facets: state.conceptGraph.subject_facets.length,
    },
    long_tasks: [...longTasks],
  });
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-link]');
  if (!link || event.defaultPrevented || event.metaKey || event.ctrlKey || link.target === '_blank') return;
  const target = new URL(link.href, location.origin);
  if (target.origin !== location.origin) return;
  event.preventDefault();
  navigate(`${target.pathname}${target.search}${target.hash}`);
});

document.querySelectorAll('[data-map-mode]').forEach((button) => button.addEventListener('click', () => setMapMode(button.dataset.mapMode)));
mapToolsToggle.addEventListener('click', () => {
  setMapControlsExpanded(mapToolsToggle.getAttribute('aria-expanded') !== 'true');
});
showAllSubjects.addEventListener('click', restoreAllSubjects);
yearOptions.addEventListener('click', (event) => {
  const button = event.target.closest('[data-compare-year]');
  if (!button) return;
  toggleYearSelection(button.dataset.compareYear, { fitVisible: true });
});
clearYearSelection.addEventListener('click', () => activateYearSelection([], { fitVisible: true }));
yearBoundaryCompare.addEventListener('click', () =>
  activateYearSelection([state.availableYears[0], state.availableYears.at(-1)], { fitVisible: true }));
chronologyEraTab.addEventListener('click', () => setChronologyMode('era'));
chronologyCompareTab.addEventListener('click', () => setChronologyMode('compare'));
document.querySelector('.chronology-tabs').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  setChronologyMode(state.chronologyMode === 'era' ? 'compare' : 'era', { focus: true });
});
themeChoices.forEach((button) =>
  button.addEventListener('click', () => setTheme(button.dataset.themeChoice)));
searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  selectConceptEpisode(state.searchResultEpisodes[0]);
});
searchInput.addEventListener('input', () => {
  state.query = searchInput.value.trim().toLocaleLowerCase('zh-CN');
  clearQuery.hidden = !state.query;
  updateMapStatus();
});
searchInput.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const options = conceptResultList.querySelectorAll('[role="option"]');
  if (!options.length) return;
  event.preventDefault();
  focusConceptResult(event.key === 'ArrowDown' ? 0 : options.length - 1);
});
conceptResultList.addEventListener('click', (event) => {
  const option = event.target.closest('[data-episode-id]');
  if (!option) return;
  selectConceptEpisode(state.searchResultEpisodes.find((episode) => episode.id === option.dataset.episodeId));
});
conceptResultList.addEventListener('keydown', (event) => {
  const option = event.target.closest('[role="option"]');
  if (!option) return;
  const options = [...conceptResultList.querySelectorAll('[role="option"]')];
  const index = options.indexOf(option);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    if (event.key === 'Home') focusConceptResult(0);
    else if (event.key === 'End') focusConceptResult(options.length - 1);
    else focusConceptResult(index + (event.key === 'ArrowDown' ? 1 : -1));
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    selectConceptEpisode(state.searchResultEpisodes.find((episode) => episode.id === option.dataset.episodeId));
  } else if (event.key === 'Escape') {
    event.preventDefault();
    searchInput.focus();
  }
});
clearQuery.addEventListener('click', () => {
  searchInput.value = '';
  state.query = '';
  clearQuery.hidden = true;
  updateMapStatus();
});
document.querySelector('#workbench-close').addEventListener('click', () => closeWorkbench());
scrim.addEventListener('click', () => closeWorkbench());
window.addEventListener('popstate', route);
window.addEventListener('resize', () => {
  if (state.mode === 'structure') renderConceptLayers();
  if (!inspector.hidden) {
    positionInspector(state.selectedEpisode?.id || null);
    requestAnimationFrame(() => applyInspectorAvoidance());
  }
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!workbench.hidden) closeWorkbench();
    else if (!inspector.hidden) clearConceptInspector();
    else if (mapToolsToggle.getAttribute('aria-expanded') === 'true') setMapControlsExpanded(false);
  }
});

route();
