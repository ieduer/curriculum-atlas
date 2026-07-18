import { CurriculumCosmos, episodeCanonicalSubject, episodeCourseEntity, episodeEntityLabel, episodeVisibleForSubjectFilter, subjectColor } from './atlas.js?v=20260718v19';
import {
  DISPLAY_SUBJECT_FACETS,
  buildSubjectFacetIndex,
  controlledSubjectFacetCounts as countControlledSubjectFacets,
  filterDocumentsBySubjectFacet,
  normalizeSubjectFacet,
  planSubjectFacetQueries,
} from './subject-facets.js?v=20260718v19';
import { GraphShardStore } from './graph-loader.js?v=20260718v19';
import { loadAllDocumentIdentities } from './document-pagination.js?v=20260718v19';
import { buildCommentThread, commentReplyTarget } from './comment-thread.js?v=20260718v19';
import { evidenceIdentityHref } from './identity-links.js?v=20260718v19';

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
const inspector = document.querySelector('#star-inspector');
const tooltip = document.querySelector('#atlas-tooltip');
const subjectOrbit = document.querySelector('#subject-orbit');
const conceptLayers = document.querySelector('#concept-layers');
const eraButtons = document.querySelector('#era-buttons');
const yearRange = document.querySelector('#year-range');
const yearStart = document.querySelector('#year-start');
const yearValue = document.querySelector('#year-value');
const searchForm = document.querySelector('#cosmos-search');
const searchInput = document.querySelector('#cosmos-query');
const clearQuery = document.querySelector('#clear-query');
const workbench = document.querySelector('#workbench');
const workbenchKicker = document.querySelector('#workbench-kicker');
const workbenchTitle = document.querySelector('#workbench-title');
const workbenchTabs = document.querySelector('#workbench-tabs');
const workbenchBody = document.querySelector('#workbench-body');
const scrim = document.querySelector('#scrim');
const toastNode = document.querySelector('#toast');

const state = {
  meta: null,
  documents: [],
  insights: [],
  conceptGraph: null,
  graphShards: null,
  loadedOntologyFacets: new Set(),
  ontologyLoads: new Map(),
  evidenceById: new Map(),
  ontologyNodeById: new Map(),
  ontologyEvidenceById: new Map(),
  ontologyScopeById: new Map(),
  ontologyFocusId: null,
  me: null,
  cosmos: null,
  hiddenSubjects: new Set(),
  hideAllSubjects: false,
  maxYear: 2022,
  query: '',
  mode: 'lineage',
  selectedDocument: null,
  selectedEpisode: null,
};

const CORE_SUBJECTS = DISPLAY_SUBJECT_FACETS;
const ERAS = [
  { label: '近代学制初建', start: 1902, end: 1949 },
  { label: '国家课程起点', start: 1950, end: 1977 },
  { label: '恢复与重建', start: 1978, end: 2000 },
  { label: '新课程改革', start: 2001, end: 2010 },
  { label: '核心素养转向', start: 2011, end: 2021 },
  { label: '素养导向重构', start: 2022, end: 2022 },
];

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

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

async function loadBase() {
  if (state.meta) return;
  const conceptGraph = await api('/data/concept-evolution.json?v=20260718v19');
  const [meta, documents, insights] = await Promise.all([
    api('/api/meta').catch(() => ({ turnstileSiteKey: null, degraded: true })),
    loadAllDocumentIdentities(({ limit, cursor }) => api(
      `/api/documents?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    )),
    api('/api/insights').catch(() => ({ insights: [] })),
  ]);
  state.meta = meta;
  state.documents = documents;
  state.insights = insights.insights || [];
  if (conceptGraph.schema_version !== 1
    || !Array.isArray(conceptGraph.episodes)
    || !Array.isArray(conceptGraph.evidence)
    || !Array.isArray(conceptGraph.subject_facets)
    || !Array.isArray(conceptGraph.subject_taxonomy)
    || conceptGraph.ontology_schema_version !== 1
    || !Array.isArray(conceptGraph.edges)) {
    throw new Error('概念星图数据未通过结构校验');
  }
  state.conceptGraph = conceptGraph;
  state.graphShards = new GraphShardStore(conceptGraph);
  state.evidenceById = new Map(conceptGraph.evidence.map((item) => [item.id, item]));
  state.ontologyNodeById = new Map(conceptGraph.ontology_nodes.map((item) => [item.id, item]));
  state.ontologyEvidenceById = new Map(conceptGraph.ontology_evidence.map((item) => [item.id, item]));
  state.ontologyScopeById = new Map(conceptGraph.ontology_scopes.map((item) => [item.id, item]));
  const years = conceptGraph.episodes.map((episode) => Number(episode.time?.year)).filter((year) => Number.isFinite(year) && year >= 1800);
  if (!years.length) throw new Error('概念星图没有可显示的年代节点');
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  state.maxYear = maxYear;
  yearRange.min = String(minYear);
  yearRange.max = String(maxYear);
  yearRange.value = String(maxYear);
  yearStart.textContent = String(minYear);
  yearValue.textContent = String(maxYear);
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
  if (/ocr/i.test(String(doc.text_quality_status || ''))) return 'OCR 复核中 · 禁止 AI 引用';
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
  return subjectFacetNames().includes(persistedFacet)
    ? persistedFacet
    : displayFacetForSubject(documentSubjectFacet(document));
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
    ocr_candidate: '双引擎 OCR 候选 · 待人工核对',
    conflict: '识别冲突 · 保留疑点',
  };
  return labels[status] || '质量状态待核';
}

function observationLabel(episode) {
  const incoming = state.conceptGraph.edges.find((edge) => edge.type === 'next_observed' && edge.target === episode.id);
  const labels = {
    observed_more_frequently: '当前可比语料中规范化提及增多',
    observed_less_frequently: '当前可比语料中规范化提及减少',
    frequency_not_materially_changed: '当前可比语料中提及强度接近',
  };
  return incoming?.metric?.interpretation ? labels[incoming.metric.interpretation] : '当前语料中的概念观察点';
}

function clearConceptInspector(resetRoute = true) {
  state.selectedEpisode = null;
  inspector.hidden = true;
  state.cosmos?.setSelected(null);
  if (resetRoute && location.pathname.replace(/\/+$/, '') === '/terms') history.replaceState({}, '', '/');
}

async function selectConceptEpisode(stub, updateRoute = true) {
  const subject = episodeCanonicalSubject(stub);
  const facet = displayFacetForSubject(subject) || stub.visibility_facets?.[0] || null;
  inspector.hidden = false;
  inspector.innerHTML = '<p class="inspector-kicker">正在核验概念证据分片…</p>';
  try {
    const detail = await state.graphShards.loadEpisode(stub, facet);
    for (const evidence of detail.evidence) state.evidenceById.set(evidence.id, evidence);
    showConceptInspector(detail.episode);
    if (updateRoute) history.replaceState({}, '', `/terms?term=${encodeURIComponent(detail.episode.concept_id)}`);
  } catch (error) {
    clearConceptInspector(false);
    toast(error.message);
  }
}

async function ensureOntologyFacet(facet) {
  if (!facet || state.loadedOntologyFacets.has(facet)) return true;
  if (state.ontologyLoads.has(facet)) return state.ontologyLoads.get(facet);
  const task = state.graphShards.loadOntologyFacet(facet).then((data) => {
    const replaceById = (collection, additions) => {
      const byId = new Map(collection.map((item) => [item.id, item]));
      for (const item of additions || []) byId.set(item.id, item);
      return [...byId.values()];
    };
    state.conceptGraph.ontology_scopes = replaceById(state.conceptGraph.ontology_scopes, data.ontology_scopes);
    state.conceptGraph.ontology_nodes = replaceById(state.conceptGraph.ontology_nodes, data.ontology_nodes);
    state.conceptGraph.ontology_relations = replaceById(state.conceptGraph.ontology_relations, data.ontology_relations);
    state.conceptGraph.ontology_evidence = replaceById(state.conceptGraph.ontology_evidence, data.ontology_evidence);
    state.ontologyScopeById = new Map(state.conceptGraph.ontology_scopes.map((item) => [item.id, item]));
    state.ontologyNodeById = new Map(state.conceptGraph.ontology_nodes.map((item) => [item.id, item]));
    state.ontologyEvidenceById = new Map(state.conceptGraph.ontology_evidence.map((item) => [item.id, item]));
    state.loadedOntologyFacets.add(facet);
    return true;
  }).catch((error) => {
    state.loadedOntologyFacets.delete(facet);
    throw error;
  }).finally(() => state.ontologyLoads.delete(facet));
  state.ontologyLoads.set(facet, task);
  return task;
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
  const evidenceHtml = records.map((item) => `<article class="concept-evidence ${item.citation_allowed ? '' : 'candidate'}">
    ${item.citation_allowed ? `<a href="${evidenceIdentityHref(item)}" data-link>${escapeHtml(item.document_title)}</a>` : `<b>${escapeHtml(item.document_title)}</b>`}
    <small>${escapeHtml(item.source_locator)} · ${escapeHtml(item.matched_surface)}${item.citation_allowed ? '' : ' · 不进入引文 AI'}</small>
    <p>${escapeHtml(item.snippet)}</p>
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
    <div class="inspector-insights">
      <h3>原文证据</h3>
      ${evidenceHtml || '<small>证据定位缺失；该节点不应显示，请报告数据问题。</small>'}
    </div>
    <div class="inspector-actions">
      ${episode.ontology_node_id ? `<button class="action-button primary" type="button" data-open-ontology="${escapeHtml(episode.ontology_node_id)}">展开概念层级</button>` : ''}
      <a class="action-button primary" href="/sources?q=${encodeURIComponent(episode.label)}" data-link>检索全部原文</a>
      ${subjectFacet ? `<a class="action-button" href="/compare?subject=${encodeURIComponent(subjectFacet)}" data-link>比较版本</a>` : ''}
    </div>`;
  inspector.querySelector('.inspector-close').addEventListener('click', () => clearConceptInspector());
  inspector.querySelector('[data-open-ontology]')?.addEventListener('click', async (event) => {
    state.ontologyFocusId = event.currentTarget.dataset.openOntology;
    try {
      await ensureOntologyFacet(subjectFacet);
      setMapMode('structure');
      showOntologyInspector(state.ontologyNodeById.get(state.ontologyFocusId));
    } catch (error) {
      state.ontologyFocusId = null;
      toast(error.message);
    }
  });
  inspector.hidden = false;
}

const ONTOLOGY_TYPE_LABELS = {
  subject_model: '学科模型', curriculum_construct: '课程对象', language_activity: '语言活动',
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
    <a href="${evidenceIdentityHref(item)}" data-link>${escapeHtml(item.document_title)}</a>
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
  inspector.hidden = false;
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

function activeOntologyContext() {
  const subjects = controlledSubjectFacetCounts(state.conceptGraph).subjects;
  const visibleSubjects = state.hideAllSubjects ? [] : subjects.filter((subject) => !state.hiddenSubjects.has(subject));
  const activeSubject = visibleSubjects.length === 1 ? visibleSubjects[0] : null;
  const root = activeSubject
    ? state.conceptGraph.ontology_nodes.find((node) => !node.parent_id && ontologyNodeSubject(node) === activeSubject) || null
    : null;
  return { activeSubject, root };
}

function reconcileOntologyInspectorSubject(visibleSubjects) {
  if (!state.ontologyFocusId) return;
  const focus = state.ontologyNodeById.get(state.ontologyFocusId);
  const activeSubject = visibleSubjects.length === 1 ? visibleSubjects[0] : null;
  if (focus && ontologyNodeSubject(focus) === activeSubject) return;
  state.ontologyFocusId = null;
  inspector.hidden = true;
  state.cosmos?.setSelected(null);
}

function renderConceptLayers() {
  const subjects = controlledSubjectFacetCounts(state.conceptGraph).subjects;
  const visibleSubjects = state.hideAllSubjects ? [] : subjects.filter((subject) => !state.hiddenSubjects.has(subject));
  const searchableSubjects = new Set(visibleSubjects);
  const singleSubject = visibleSubjects.length === 1 ? visibleSubjects[0] : null;
  if ((state.mode === 'structure' || state.query) && singleSubject && !state.loadedOntologyFacets.has(singleSubject)) {
    conceptLayers.hidden = false;
    mount.classList.add('structure-muted');
    conceptLayers.innerHTML = '<div class="ontology-empty"><b>正在核验深层概念分片</b><span>仅载入当前学科；哈希或版本不一致时不会混用数据。</span></div>';
    ensureOntologyFacet(singleSubject).then(() => renderConceptLayers()).catch((error) => {
      conceptLayers.innerHTML = `<div class="ontology-empty"><b>当前学科深层模型暂不可用</b><span>${escapeHtml(error.message)}</span></div>`;
    });
    return;
  }
  const queryMatches = state.query ? state.conceptGraph.ontology_nodes
    .filter((node) => searchableSubjects.has(ontologyNodeSubject(node)) && ontologySearchText(node).includes(state.query))
    .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'))
    .slice(0, 24) : [];
  if (state.mode !== 'structure' && !queryMatches.length) {
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
        <i aria-hidden="true"></i><b>${escapeHtml(node.label)}</b><small>${escapeHtml(ontologyNodeSubject(node) || '')} · ${escapeHtml(ONTOLOGY_TYPE_LABELS[node.node_type] || node.node_type)}</small>
      </button>`;
    }).join('');
    conceptLayers.innerHTML = `<nav class="ontology-breadcrumb" aria-label="概念检索路径"><span>星图检索</span><span>›</span><button type="button" aria-current="page">${escapeHtml(state.query)}</button></nav>
      <div class="ontology-stage ${queryMatches.length > 10 ? 'dense' : ''}">
        <svg class="ontology-edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>
        <div class="ontology-center ontology-search-center"><i aria-hidden="true"></i><b>${escapeHtml(state.query)}</b><small>官方概念、术语与能力描述</small></div>
        ${stars}
      </div>`;
    conceptLayers.querySelectorAll('[data-ontology-search-result]').forEach((button) => button.addEventListener('click', () => {
      const next = state.ontologyNodeById.get(button.dataset.ontologySearchResult);
      if (!next) return;
      state.ontologyFocusId = next.id;
      showOntologyInspector(next);
    }));
    return;
  }
  const { activeSubject, root } = activeOntologyContext();
  if (!root) {
    conceptLayers.innerHTML = `<div class="ontology-empty"><b>${escapeHtml(activeSubject || '当前组合')}的深层模型尚未达到发布门槛</b><span>只有版本身份、原文段落和概念关系同时核验后才会进入星图。</span></div>`;
    return;
  }
  let focus = state.ontologyNodeById.get(state.ontologyFocusId);
  if (!focus || ontologyNodeSubject(focus) !== activeSubject || !ontologyPath(focus).some((node) => node.id === root.id)) focus = root;
  state.ontologyFocusId = focus.id;
  const children = ontologyChildren(focus.id);
  const positions = ontologyPositions(children.length);
  const breadcrumb = ontologyPath(focus).map((node, index, path) => `<button type="button" data-ontology-node="${escapeHtml(node.id)}" ${index === path.length - 1 ? 'aria-current="page"' : ''}>${escapeHtml(node.label)}</button>`).join('<span>›</span>');
  const lines = positions.map((position) => `<line x1="50" y1="50" x2="${position.x.toFixed(2)}" y2="${position.y.toFixed(2)}"></line>`).join('');
  const stars = children.map((child, index) => {
    const position = positions[index];
    const descendants = ontologyChildren(child.id).length;
    const inferred = child.review_status === 'reviewed_inference';
    return `<button class="ontology-star ${position.outer ? 'outer' : ''} ${inferred ? 'inferred' : ''}" type="button" data-ontology-node="${escapeHtml(child.id)}" style="--star-x:${position.x.toFixed(2)}%;--star-y:${position.y.toFixed(2)}%;--star-delay:${index * 24}ms">
      <i aria-hidden="true"></i><b>${escapeHtml(child.label)}</b><small>${escapeHtml(ONTOLOGY_TYPE_LABELS[child.node_type] || child.node_type)}${descendants ? ` · ${descendants}` : ''}</small>
    </button>`;
  }).join('');
  conceptLayers.innerHTML = `<nav class="ontology-breadcrumb" aria-label="概念层级路径">${breadcrumb}</nav>
    <div class="ontology-stage ${children.length > 10 ? 'dense' : ''}">
      <svg class="ontology-edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>
      <button class="ontology-center" type="button" data-inspect-ontology="${escapeHtml(focus.id)}"><i aria-hidden="true"></i><b>${escapeHtml(focus.label)}</b><small>${escapeHtml(ONTOLOGY_TYPE_LABELS[focus.node_type] || focus.node_type)} · ${children.length} 个下位概念</small></button>
      ${stars || '<p class="ontology-leaf">已到当前核验层级；可从右侧证据继续查看原文。</p>'}
    </div>`;
  conceptLayers.querySelectorAll('[data-ontology-node]').forEach((button) => button.addEventListener('click', () => {
    const next = state.ontologyNodeById.get(button.dataset.ontologyNode);
    if (!next) return;
    state.ontologyFocusId = next.id;
    renderConceptLayers();
    showOntologyInspector(next);
  }));
  conceptLayers.querySelector('[data-inspect-ontology]')?.addEventListener('click', () => showOntologyInspector(focus));
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

function updateMapStatus({ fitVisible = false } = {}) {
  const controlledSubjects = controlledSubjectFacetCounts(state.conceptGraph).subjects;
  const visibleEpisodes = state.conceptGraph.episodes.filter((episode) => Number(episode.time.year) <= state.maxYear
    && episodeVisibleForSubjectFilter(episode, state.hiddenSubjects, state.hideAllSubjects, controlledSubjects)
    && (!state.query || `${episode.label}${(episode.aliases || []).join('')}${episodeEntityLabel(episode)}${episode.time.year}${episode.category}`.toLocaleLowerCase('zh-CN').includes(state.query)));
  const visibleIds = new Set(visibleEpisodes.map((episode) => episode.id));
  if (state.selectedEpisode && !visibleIds.has(state.selectedEpisode.id)) clearConceptInspector();
  const visibleSubjects = state.hideAllSubjects
    ? []
    : controlledSubjects.filter((subject) => !state.hiddenSubjects.has(subject));
  const visibleSubjectCount = visibleSubjects.length;
  reconcileOntologyInspectorSubject(visibleSubjects);
  state.cosmos?.setFilters(
    { hiddenSubjects: state.hiddenSubjects, hideAll: state.hideAllSubjects, maxYear: state.maxYear, query: state.query },
    { fitVisible, maxZoom: visibleSubjectCount === 1 ? 1.32 : 1 },
  );
  renderConceptLayers();
}

function subjectButton(subject, count, panel = false) {
  const visible = !state.hideAllSubjects && !state.hiddenSubjects.has(subject);
  const controlledSubjects = controlledSubjectFacetCounts(state.conceptGraph).subjects;
  const onlyVisible = visible && controlledSubjects.filter((name) => !state.hiddenSubjects.has(name)).length === 1;
  const action = onlyVisible ? '恢复全部分面' : `只看${subject}；Shift 点击可多选`;
  return `<button class="subject-button ${visible ? 'active' : ''}" type="button" data-subject="${escapeHtml(subject)}" aria-pressed="${visible}" style="--subject-color:${subjectColor(subject)}" title="${escapeHtml(action)}">${escapeHtml(subject)}${panel ? ` · ${count}` : ''}</button>`;
}

function controlledSubjectFacetCounts(conceptGraph) {
  return countControlledSubjectFacets(conceptGraph);
}

function renderSubjectControls() {
  const { subjects, counts } = controlledSubjectFacetCounts(state.conceptGraph);
  const core = CORE_SUBJECTS.filter((subject) => counts.has(subject));
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

function renderEraControls() {
  eraButtons.innerHTML = ERAS.map((era) => `<button type="button" data-era-end="${era.end}" title="显示到 ${era.end} 年">${era.start} · ${era.label}</button>`).join('');
  document.querySelectorAll('[data-era-end]').forEach((button) => button.addEventListener('click', () => {
    state.maxYear = Math.min(Number(yearRange.max), Number(button.dataset.eraEnd));
    yearRange.value = String(state.maxYear);
    yearValue.textContent = String(state.maxYear);
    document.querySelectorAll('[data-era-end]').forEach((item) => item.classList.toggle('active', item === button));
    updateMapStatus();
  }));
}

function setMapMode(mode) {
  state.mode = ['lineage', 'cross', 'structure'].includes(mode) ? mode : 'lineage';
  if (!state.conceptGraph) return;
  if (state.mode === 'structure') {
    const { root } = activeOntologyContext();
    state.ontologyFocusId = root?.id || null;
  }
  state.cosmos?.setMode(state.mode === 'cross' ? 'cross' : 'lineage');
  document.querySelectorAll('[data-map-mode]').forEach((button) => button.classList.toggle('active', button.dataset.mapMode === state.mode));
  updateMapStatus();
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
    const entries = data.documents.map((doc) => `<article class="version-entry"><time>${escapeHtml(doc.sort_year || '年代待核')}</time><h3>${escapeHtml(doc.title)}</h3><p>${escapeHtml(doc.canonical_subject)} · ${escapeHtml(doc.stage)} · ${escapeHtml(statusLabel(doc.current_status))}</p><a href="/document/${encodeURIComponent(doc.id)}" data-link>查看证据 →</a></article>`).join('');
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
  workbenchBody.innerHTML = `<div class="workspace-grid"><aside class="workspace-aside"><h2>资料与全文</h2><p>元数据用于定位版本；只有通过图像、OCR 与在线同版核查门槛的正文才进入全文结果和 AI 引文。</p><form class="work-form" id="source-form"><label for="source-query">篇名、机构或正文关键词</label><input id="source-query" name="q" value="${escapeHtml(query)}" placeholder="例如：学业质量"><label for="source-subject">学科分面</label><select id="source-subject" name="subject"><option value="">不限分面</option>${subjects.map((name) => `<option ${name === subject ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select><button class="work-button" type="submit">检索资料</button></form></aside><main class="workspace-main" id="source-results"><h2>${query ? `“${escapeHtml(query)}”的结果` : '已编目资料'}</h2>${documentRows(docs.slice(0, 80))}</main></div>`;
  document.querySelector('#source-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const values = new URLSearchParams(new FormData(event.currentTarget));
    navigate(`/sources?${values.toString()}`);
  });
  if (query.length >= 2) {
    try {
      const data = await searchSubjectFacet(query, subject);
      if (data.passages.length) {
        document.querySelector('#source-results').innerHTML = `<h2>可引文正文</h2><div class="result-list">${data.passages.map((passage) => `<article class="result-row"><a href="/document/${encodeURIComponent(passage.document_id)}#p-${passage.id}" data-link>${escapeHtml(passage.title)}</a><small>${escapeHtml(passage.entity_label || passage.subject)} · ${escapeHtml(passage.version_label)} · ${escapeHtml(passage.source_locator)}</small><p>${escapeHtml(passage.body)}</p></article>`).join('')}</div><h2>元数据匹配</h2>${documentRows(docs.slice(0, 40))}`;
      }
    } catch (error) {
      toast(error.message);
    }
  }
}

async function renderDocument(id) {
  try {
    const listedIdentity = state.documents.find((entry) => entry.id === id);
    const embeddedItem = listedIdentity?.identity_kind === 'embedded_item' || id.startsWith('embedded:');
    const data = await api(`${embeddedItem ? '/api/items/' : '/api/documents/'}${encodeURIComponent(id)}?limit=200`);
    const doc = data.document || data.item;
    state.selectedDocument = doc;
    const source = doc.source_url ? `<a href="${escapeHtml(doc.source_url)}" target="_blank" rel="noopener">发布页 / 原件 ↗</a>` : '原件链接待补';
    const paragraphs = data.paragraphs.length ? data.paragraphs.map((paragraph) => `<section class="paragraph ${paragraph.uncertainty_note ? 'uncertain' : ''}" id="p-${paragraph.id}"><span class="paragraph-number">P:${paragraph.id}<br>${escapeHtml(paragraph.source_locator)}</span>${escapeHtml(paragraph.body)}${paragraph.uncertainty_note ? `<small class="uncertainty-note">可能有问题：${escapeHtml(paragraph.uncertainty_note)}</small>` : ''}</section>`).join('') : '<div class="empty-state">该记录目前只有已核元数据，正文尚未达到上线门槛。</div>';
    const verification = (data.verifications || []).length ? data.verifications.map((item) => `<article class="verification-row"><b>${escapeHtml(item.entity_label)} · ${escapeHtml(verificationLabel(item.verification_status))}</b><p>${escapeHtml(item.resolution)}</p>${item.uncertainty_note ? `<small class="uncertainty-note">可能有问题：${escapeHtml(item.uncertainty_note)}</small>` : ''}${(item.evidence || []).map((evidence) => `<p><a href="${escapeHtml(evidence.sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(evidence.publisher)}</a> · ${escapeHtml(verificationLabel(evidence.versionMatch))} · ${escapeHtml(evidence.factSummary)}</p>`).join('')}</article>`).join('') : '<div class="empty-state">尚无在线同版核查记录。</div>';
    const documentIdentityKind = embeddedItem ? '汇编篇目' : documentIdentityKindLabel(doc);
    const documentFacet = documentDisplayFacet(doc);
    const relatedFacet = doc.taxonomy_entity_kind === 'assessment_subject' ? documentFacet : null;
    const sourceVariant = documentSourceVariant(doc);
    const carrierIdentity = embeddedItem ? `<br>汇编载体：${escapeHtml(doc.parent_title)}<br>物理页：${escapeHtml(doc.physical_page_start)}–${escapeHtml(doc.physical_page_end)}` : '';
    const discussionDocumentId = data.discussionDocumentId || doc.id;
    const discussionEmbeddedItemId = data.discussionEmbeddedItemId || null;
    const discussionHref = discussionEmbeddedItemId
      ? `/discussions?documentId=${encodeURIComponent(discussionDocumentId)}&embeddedItemId=${encodeURIComponent(discussionEmbeddedItemId)}`
      : `/discussions?documentId=${encodeURIComponent(discussionDocumentId)}`;
    workbenchBody.innerHTML = `<div class="reader-grid"><article class="reader-document"><h2>${escapeHtml(doc.title)}</h2><p>${doc.issued_by ? escapeHtml(doc.issued_by) : '发布机构待核'}${doc.issued_date ? ` · ${escapeHtml(doc.issued_date)}` : ''} · ${escapeHtml(qualityLabel(doc))}</p>${paragraphs}<h2>在线三证核查</h2><p>只有同文同版来源可校正文句；同篇异版仅旁证稳定事实。</p>${verification}</article><aside class="reader-facts"><h3>资料身份</h3><p>编号：${escapeHtml(doc.id)}<br>${escapeHtml(documentIdentityKind)}：${escapeHtml(documentEntityLabel(doc))}${relatedFacet ? `<br>关联学科分面：${escapeHtml(relatedFacet)}` : ''}${sourceVariant ? `<br>来源标注：${escapeHtml(sourceVariant)}` : ''}${carrierIdentity}<br>学段：${escapeHtml(doc.stage)}<br>版本：${escapeHtml(doc.version_label)}<br>状态：${escapeHtml(statusLabel(doc.current_status))}<br>文本质量：${escapeHtml(doc.text_quality_status || '待评估')}<br>页数：${doc.page_count || '待核'}</p><p>${source}</p><div class="inspector-actions">${documentFacet ? `<a class="action-button" href="/compare?subject=${encodeURIComponent(documentFacet)}" data-link>版本比较</a>` : ''}<a class="action-button" href="${discussionHref}" data-link>教师讨论</a></div></aside></div>`;
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

async function loadComments(documentId, embeddedItemId = null) {
  const root = document.querySelector('#comment-list');
  if (!root) return;
  try {
    const embeddedScope = embeddedItemId ? `&embeddedItemId=${encodeURIComponent(embeddedItemId)}` : '';
    const data = await api(`/api/comments?documentId=${encodeURIComponent(documentId)}${embeddedScope}`);
    const byId = new Map(data.comments.map((item) => [item.id, item]));
    const renderNodes = (nodes, depth = 0) => nodes.map((item) => `<article class="comment-row" data-depth="${Math.min(depth, 6)}">
      <h3>${escapeHtml(item.author_name)}</h3>
      <header>${new Date(`${item.created_at}Z`).toLocaleString('zh-CN')}</header>
      <p>${escapeHtml(item.body)}</p>
      <button class="comment-reply" type="button" data-reply-comment="${escapeHtml(item.id)}">回复</button>
      ${item.children.length ? `<div class="comment-children">${renderNodes(item.children, depth + 1)}</div>` : ''}
    </article>`).join('');
    root.innerHTML = data.comments.length
      ? renderNodes(buildCommentThread(data.comments))
      : '<div class="empty-state">尚无公开讨论。第一条判断也应说明所据版本或条文。</div>';
    root.querySelectorAll('[data-reply-comment]').forEach((button) => button.addEventListener('click', () => {
      const comment = byId.get(button.dataset.replyComment);
      const form = document.querySelector('#comment-form');
      const panel = document.querySelector('#reply-target');
      if (!comment || !form || !panel) return;
      const target = commentReplyTarget(comment);
      form.elements.parentId.value = target.parentId;
      panel.querySelector('span').textContent = `回复：${target.label.slice(0, 48)}`;
      panel.hidden = false;
      form.elements.body.focus();
    }));
  } catch (error) {
    root.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

async function renderDiscussions(url) {
  const me = await loadMe();
  const docs = state.documents;
  const requestedDocumentId = url.searchParams.get('documentId') || '';
  const requestedEmbeddedItemId = url.searchParams.get('embeddedItemId') || '';
  const fallbackIdentityId = state.selectedDocument?.id || docs[0]?.id || '';
  const requestedIdentity = docs.find((doc) => doc.id === (requestedEmbeddedItemId || requestedDocumentId || fallbackIdentityId));
  const embeddedItemId = requestedEmbeddedItemId
    || (requestedIdentity?.identity_kind === 'embedded_item' ? requestedIdentity.id : null);
  const documentId = requestedIdentity?.parent_document_id || requestedDocumentId || requestedIdentity?.id || '';
  const itemDiscussionDocs = docs.map((doc) => ({
    id: doc.id,
    documentId: doc.parent_document_id || doc.id,
    embeddedItemId: doc.identity_kind === 'embedded_item' ? doc.id : null,
    sort_year: doc.sort_year,
    title: doc.parent_document_id ? `汇编篇目《${doc.title}》` : doc.title,
  }));
  const carrierDiscussionDocs = [...new Map(docs
    .filter((doc) => doc.identity_kind === 'embedded_item' && doc.parent_document_id)
    .map((doc) => [doc.parent_document_id, {
      id: `carrier:${doc.parent_document_id}`,
      documentId: doc.parent_document_id,
      embeddedItemId: null,
      sort_year: doc.sort_year,
      title: `汇编载体《${doc.parent_title || doc.parent_document_id}》（既有父级讨论）`,
    }])).values()];
  const discussionDocs = [...itemDiscussionDocs, ...carrierDiscussionDocs]
    .sort((left, right) => Number(right.sort_year || 0) - Number(left.sort_year || 0));
  const selectedScopeId = embeddedItemId
    || (requestedIdentity?.identity_kind !== 'embedded_item' ? requestedIdentity?.id : '')
    || (documentId ? `carrier:${documentId}` : '');
  workbenchBody.innerHTML = `<div class="workspace-grid"><aside class="workspace-aside"><h2>围绕同一证据讨论</h2><p>统一登录内容直接公开；匿名内容经 Turnstile 后进入审核。不要写入学生个人信息。</p><form class="work-form" id="discussion-picker"><label for="discussion-document">资料</label><select id="discussion-document" name="identityId">${discussionDocs.map((doc) => `<option value="${escapeHtml(doc.id)}" ${doc.id === selectedScopeId ? 'selected' : ''}>${escapeHtml(doc.sort_year)} · ${escapeHtml(doc.title)}</option>`).join('')}</select><button class="work-button secondary" type="submit">切换讨论</button></form><form class="work-form" id="comment-form"><h2>提交讨论</h2>${me.authenticated ? `<p>以 ${escapeHtml(me.user.display_name || me.user.slug)} 发布。</p>` : '<label for="author-name">署名</label><input id="author-name" name="authorName" maxlength="40" value="匿名教师">'}<input type="hidden" name="parentId" value=""><p class="reply-target" id="reply-target" hidden><span></span><button type="button" data-cancel-reply>取消回复</button></p><label for="comment-body">内容</label><textarea id="comment-body" name="body" rows="6" minlength="8" maxlength="2000" required></textarea><div class="turnstile-slot" id="turnstile-box"></div><button class="work-button" type="submit">${me.authenticated ? '发布讨论' : '提交审核'}</button></form></aside><main class="workspace-main"><h2>教师讨论</h2><div class="comment-list" id="comment-list"><div class="empty-state">正在加载…</div></div></main></div>`;
  document.querySelector('#discussion-picker').addEventListener('submit', (event) => {
    event.preventDefault();
    const identity = discussionDocs.find((doc) => doc.id === new FormData(event.currentTarget).get('identityId'));
    if (!identity) return;
    const itemScope = identity.embeddedItemId ? `&embeddedItemId=${encodeURIComponent(identity.embeddedItemId)}` : '';
    navigate(`/discussions?documentId=${encodeURIComponent(identity.documentId)}${itemScope}`);
  });
  let turnstileToken = '';
  if (!me.authenticated) setupTurnstile(document.querySelector('#turnstile-box'), (token) => { turnstileToken = token; });
  else document.querySelector('#turnstile-box').remove();
  document.querySelector('[data-cancel-reply]').addEventListener('click', () => {
    const form = document.querySelector('#comment-form');
    form.elements.parentId.value = '';
    document.querySelector('#reply-target').hidden = true;
  });
  document.querySelector('#comment-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(form));
      body.documentId = documentId;
      if (embeddedItemId) body.embeddedItemId = embeddedItemId;
      body.turnstileToken = turnstileToken;
      const result = await api('/api/comments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      toast(result.message);
      if (result.status === 'approved') await loadComments(documentId, embeddedItemId);
      else window.turnstile?.reset();
      form.querySelector('textarea').value = '';
      form.elements.parentId.value = '';
      document.querySelector('#reply-target').hidden = true;
    } catch (error) {
      toast(error.message);
      window.turnstile?.reset();
    } finally {
      button.disabled = false;
    }
  });
  loadComments(documentId, embeddedItemId);
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
      const episode = state.conceptGraph.episodes.filter((item) => item.concept_id === conceptId && item.time.year <= state.maxYear)
        .sort((left, right) => right.time.year - left.time.year)[0];
      if (episode) await selectConceptEpisode(episode, false);
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
    if (path === '/timeline') {
      closeWorkbench(false);
      history.replaceState({}, '', '/');
      return;
    }
    if (path === '/') {
      closeWorkbench(false);
      return;
    }
    if (path === '/compare') {
      openWorkbench({ kicker: '版本 · 资料', title: '版本与资料', tabs: [{ id: 'compare', label: '版本比较', href: url.pathname + url.search }, { id: 'sources', label: '资料检索', href: '/sources' }], active: 'compare' });
      await renderCompare(url);
      return;
    }
    if (path === '/sources' || path === '/search') {
      openWorkbench({ kicker: '版本 · 资料', title: '版本与资料', tabs: [{ id: 'compare', label: '版本比较', href: '/compare' }, { id: 'sources', label: '资料检索', href: url.pathname + url.search }], active: 'sources' });
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

function initializeCosmos() {
  state.cosmos = new CurriculumCosmos(mount, {
    onSelect: (episode) => { selectConceptEpisode(episode); },
    onHover: showTooltip,
  });
  state.cosmos.setData(state.conceptGraph);
  renderSubjectControls();
  renderEraControls();
  updateMapStatus();
  loading.classList.add('ready');
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
yearRange.addEventListener('input', () => {
  state.maxYear = Number(yearRange.value);
  yearValue.textContent = String(state.maxYear);
  document.querySelectorAll('[data-era-end]').forEach((button) => button.classList.toggle('active', Number(button.dataset.eraEnd) === state.maxYear));
  updateMapStatus();
});
searchForm.addEventListener('submit', (event) => event.preventDefault());
searchInput.addEventListener('input', () => {
  state.query = searchInput.value.trim().toLocaleLowerCase('zh-CN');
  clearQuery.hidden = !state.query;
  updateMapStatus();
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
window.addEventListener('resize', () => { if (state.mode === 'structure') renderConceptLayers(); });
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!workbench.hidden) closeWorkbench();
    else if (!inspector.hidden) clearConceptInspector();
  }
});

route();
