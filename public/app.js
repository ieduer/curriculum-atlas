import { CurriculumCosmos, subjectColor } from './atlas.js?v=20260715v3';

const loading = document.querySelector('#cosmos-loading');
const mount = document.querySelector('#cosmos-mount');
const inspector = document.querySelector('#star-inspector');
const tooltip = document.querySelector('#atlas-tooltip');
const subjectOrbit = document.querySelector('#subject-orbit');
const subjectPanel = document.querySelector('#subject-panel');
const eraButtons = document.querySelector('#era-buttons');
const yearRange = document.querySelector('#year-range');
const yearStart = document.querySelector('#year-start');
const yearValue = document.querySelector('#year-value');
const searchForm = document.querySelector('#cosmos-search');
const searchInput = document.querySelector('#cosmos-query');
const clearQuery = document.querySelector('#clear-query');
const dockStatus = document.querySelector('#dock-status');
const workbench = document.querySelector('#workbench');
const workbenchKicker = document.querySelector('#workbench-kicker');
const workbenchTitle = document.querySelector('#workbench-title');
const workbenchTabs = document.querySelector('#workbench-tabs');
const workbenchBody = document.querySelector('#workbench-body');
const scrim = document.querySelector('#scrim');
const motionToggle = document.querySelector('#motion-toggle');
const resetView = document.querySelector('#reset-view');
const toastNode = document.querySelector('#toast');

const state = {
  meta: null,
  documents: [],
  insights: [],
  terms: [],
  termRelations: [],
  me: null,
  cosmos: null,
  hiddenSubjects: new Set(),
  maxYear: 2022,
  query: '',
  mode: 'lineage',
  selectedDocument: null,
  selectedTerm: null,
};

const CORE_SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物学', '历史', '地理', '道德与法治', '思想政治', '科学', '信息科技', '艺术', '体育与健康', '劳动'];
const ERAS = [
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
  const [meta, documents, insights, terminology] = await Promise.all([
    api('/api/meta'),
    api('/api/documents?limit=200'),
    api('/api/insights'),
    api('/api/terms').catch(() => ({ terms: [], relations: [] })),
  ]);
  state.meta = meta;
  state.documents = documents.documents || [];
  state.insights = insights.insights || [];
  state.terms = terminology.terms || [];
  state.termRelations = terminology.relations || [];
  const years = state.documents.map((doc) => Number(doc.sort_year)).filter((year) => Number.isFinite(year) && year >= 1902);
  const minYear = Math.min(...years, 1950);
  const maxYear = Math.max(...years, 2022);
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

function insightsFor(doc) {
  return state.insights.filter((item) => {
    if (item.subject === doc.subject) return true;
    try { return JSON.parse(item.evidence_document_ids || '[]').includes(doc.id); }
    catch { return String(item.evidence_document_ids || '').includes(doc.id); }
  }).slice(0, 3);
}

function showDocumentInspector(doc) {
  state.selectedDocument = doc;
  state.selectedTerm = null;
  state.cosmos?.setSelected(doc.id);
  const findings = insightsFor(doc);
  inspector.innerHTML = `
    <p class="inspector-kicker">${escapeHtml(doc.sort_year)} · ${escapeHtml(doc.subject)}</p>
    <h2>${escapeHtml(doc.title)}</h2>
    <p>${escapeHtml(doc.issued_by || '发布机构待核')}${doc.issued_date ? ` · ${escapeHtml(doc.issued_date)}` : ''}</p>
    <div class="inspector-meta">
      <span>${escapeHtml(doc.stage)}</span><span>${escapeHtml(doc.document_type)}</span><span>${escapeHtml(statusLabel(doc.current_status))}</span>
      <span>${escapeHtml(qualityLabel(doc))}</span>
    </div>
    <div class="inspector-insights">
      <h3>这一节点改变了什么</h3>
      ${findings.length ? findings.map((item) => `<article><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.summary)}</small></article>`).join('') : '<small>尚无经编辑核验的变化摘要；星图当前只呈现可确认的年代、学科与版本序列。</small>'}
    </div>
    <div class="inspector-actions">
      <a class="action-button primary" href="/document/${encodeURIComponent(doc.id)}" data-link>查看证据</a>
      <a class="action-button" href="/compare?subject=${encodeURIComponent(doc.subject)}" data-link>比较版本</a>
    </div>`;
  inspector.hidden = false;
}

function showTermInspector(term) {
  state.selectedTerm = term;
  state.selectedDocument = null;
  state.cosmos?.setSelected(`term:${term.id}`);
  inspector.innerHTML = `
    <p class="inspector-kicker">概念关系 · ${escapeHtml(term.first_seen_year || '年代待核')}</p>
    <h2>${escapeHtml(term.label)}</h2>
    <p>${escapeHtml(term.definition || term.description || '该概念节点只显示已入库的可核关系；尚未核验的关系不绘制。')}</p>
    <div class="inspector-meta"><span>概念星体</span><span>跨学科模式</span></div>
    <div class="inspector-actions"><a class="action-button primary" href="/sources?q=${encodeURIComponent(term.label)}" data-link>检索原文</a></div>`;
  inspector.hidden = false;
}

function showTooltip(node, event) {
  if (!node) {
    tooltip.hidden = true;
    return;
  }
  const title = node.kind === 'term' ? node.term.label : node.doc.title;
  const meta = node.kind === 'term'
    ? `${node.term.first_seen_year || '年代待核'} · 概念关系 · 点击查看`
    : `${node.year} · ${node.subject} · ${qualityLabel(node.doc)}`;
  tooltip.innerHTML = `<b>${escapeHtml(title)}</b><span>${escapeHtml(meta)}</span>`;
  tooltip.style.left = `${Math.min(innerWidth - 326, Math.max(14, event.clientX + 14))}px`;
  tooltip.style.top = `${Math.min(innerHeight - 94, Math.max(14, event.clientY + 14))}px`;
  tooltip.hidden = false;
}

function updateMapStatus() {
  const visible = state.documents.filter((doc) => Number(doc.sort_year) <= state.maxYear
    && !state.hiddenSubjects.has(doc.subject)
    && (!state.query || `${doc.title}${doc.subject}${doc.stage}${doc.version_label}`.toLocaleLowerCase('zh-CN').includes(state.query))).length;
  const hidden = state.hiddenSubjects.size;
  dockStatus.textContent = `${visible} 颗资料星 · ${state.terms.length} 个核验概念${hidden ? ` · 隐藏 ${hidden} 学科` : ''}`;
  state.cosmos?.setFilters({ hiddenSubjects: state.hiddenSubjects, maxYear: state.maxYear, query: state.query });
}

function subjectButton(subject, count, panel = false) {
  const visible = !state.hiddenSubjects.has(subject);
  return `<button class="subject-button ${visible ? 'active' : ''}" type="button" data-subject="${escapeHtml(subject)}" aria-pressed="${visible}" style="--subject-color:${subjectColor(subject)}" title="${visible ? '隐藏' : '显示'}${escapeHtml(subject)}">${escapeHtml(subject)}${panel ? ` · ${count}` : ''}</button>`;
}

function renderSubjectControls() {
  const counts = new Map(state.documents.map((doc) => doc.subject).map((subject) => [subject, 0]));
  for (const doc of state.documents) counts.set(doc.subject, (counts.get(doc.subject) || 0) + 1);
  const subjects = [...counts.keys()].sort((a, b) => (counts.get(b) - counts.get(a)) || a.localeCompare(b, 'zh-CN'));
  const core = CORE_SUBJECTS.filter((subject) => counts.has(subject)).slice(0, 12);
  subjectOrbit.innerHTML = `${core.map((subject) => subjectButton(subject, counts.get(subject))).join('')}<button class="subject-more" type="button" id="subject-more">全部学科 · ${subjects.length}</button>`;
  subjectPanel.innerHTML = `<header><div><small>点击星色控制显隐</small><h2>全部学科</h2></div><button type="button" id="subject-panel-close" aria-label="关闭">×</button></header><div class="inspector-actions"><button class="action-button" type="button" id="show-all-subjects">全部显示</button><button class="action-button" type="button" id="hide-all-subjects">全部隐藏</button></div><div class="subject-grid">${subjects.map((subject) => subjectButton(subject, counts.get(subject), true)).join('')}</div>`;
  document.querySelector('#subject-more').addEventListener('click', () => { subjectPanel.hidden = false; });
  document.querySelector('#subject-panel-close').addEventListener('click', () => { subjectPanel.hidden = true; });
  document.querySelector('#show-all-subjects').addEventListener('click', () => { state.hiddenSubjects.clear(); renderSubjectControls(); updateMapStatus(); subjectPanel.hidden = false; });
  document.querySelector('#hide-all-subjects').addEventListener('click', () => { subjects.forEach((subject) => state.hiddenSubjects.add(subject)); renderSubjectControls(); updateMapStatus(); subjectPanel.hidden = false; });
  document.querySelectorAll('[data-subject]').forEach((button) => button.addEventListener('click', () => {
    const subject = button.dataset.subject;
    if (state.hiddenSubjects.has(subject)) state.hiddenSubjects.delete(subject);
    else state.hiddenSubjects.add(subject);
    const panelWasOpen = !subjectPanel.hidden;
    renderSubjectControls();
    subjectPanel.hidden = !panelWasOpen;
    updateMapStatus();
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
  state.mode = mode === 'cross' ? 'cross' : 'lineage';
  state.cosmos?.setMode(state.mode);
  document.querySelectorAll('[data-map-mode]').forEach((button) => button.classList.toggle('active', button.dataset.mapMode === state.mode));
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
  return `<div class="result-list">${documents.map((doc) => `<article class="result-row"><a href="/document/${encodeURIComponent(doc.id)}" data-link>${escapeHtml(doc.title)}</a><small>${escapeHtml(doc.sort_year)} · ${escapeHtml(doc.subject)} · ${escapeHtml(doc.stage)} · ${escapeHtml(qualityLabel(doc))}</small><p>${escapeHtml(doc.issued_by || '')}${doc.version_label ? ` · ${escapeHtml(doc.version_label)}` : ''}</p></article>`).join('')}</div>`;
}

async function renderCompare(url) {
  const subjects = [...new Set(state.documents.map((doc) => doc.subject))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const fallback = state.selectedDocument?.subject || subjects.find((subject) => subject === '语文') || subjects[0] || '';
  const subject = url.searchParams.get('subject') || fallback;
  workbenchBody.innerHTML = `<div class="workspace-grid"><aside class="workspace-aside"><h2>沿版本看变化</h2><p>连线表示同学科、同学段的年代相邻序列，不自动宣称法律上的替代关系。编辑结论必须回到证据文献。</p><form class="work-form" id="compare-form"><label for="compare-subject">学科</label><select id="compare-subject" name="subject">${subjects.map((name) => `<option ${name === subject ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select><button class="work-button" type="submit">更新版本河流</button></form></aside><main class="workspace-main" id="compare-results"><div class="empty-state">正在整理 ${escapeHtml(subject)} 的版本序列…</div></main></div>`;
  document.querySelector('#compare-form').addEventListener('submit', (event) => {
    event.preventDefault();
    navigate(`/compare?subject=${encodeURIComponent(new FormData(event.currentTarget).get('subject'))}`);
  });
  try {
    const data = await api(`/api/compare?subject=${encodeURIComponent(subject)}`);
    const entries = data.documents.map((doc) => `<article class="version-entry"><time>${escapeHtml(doc.sort_year || '年代待核')}</time><h3>${escapeHtml(doc.title)}</h3><p>${escapeHtml(doc.stage)} · ${escapeHtml(statusLabel(doc.current_status))}</p><a href="/document/${encodeURIComponent(doc.id)}" data-link>查看证据 →</a></article>`).join('');
    const findings = data.insights.length ? data.insights.map((item) => `<article class="insight-line"><time>${escapeHtml(item.era)} · ${escapeHtml(item.dimension)}</time><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.summary)}</p></article>`).join('') : '<div class="empty-state">尚无经编辑核验的变化摘要；版本文献仍可逐份查看。</div>';
    document.querySelector('#compare-results').innerHTML = `<h2>${escapeHtml(subject)}版本河流</h2><div class="version-river">${entries}</div><h2>经核验的变化判断</h2>${findings}`;
  } catch (error) {
    document.querySelector('#compare-results').innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

async function renderSources(url) {
  const query = (url.searchParams.get('q') || '').trim();
  const subject = url.searchParams.get('subject') || '';
  const subjects = [...new Set(state.documents.map((doc) => doc.subject))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  let docs = state.documents.filter((doc) => (!subject || doc.subject === subject)
    && (!query || `${doc.title}${doc.subject}${doc.issued_by}${doc.version_label}`.includes(query)));
  workbenchBody.innerHTML = `<div class="workspace-grid"><aside class="workspace-aside"><h2>资料与全文</h2><p>元数据用于定位版本；只有通过图像、OCR 与在线同版核查门槛的正文才进入全文结果和 AI 引文。</p><form class="work-form" id="source-form"><label for="source-query">篇名、机构或正文关键词</label><input id="source-query" name="q" value="${escapeHtml(query)}" placeholder="例如：学业质量"><label for="source-subject">学科</label><select id="source-subject" name="subject"><option value="">全部学科</option>${subjects.map((name) => `<option ${name === subject ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select><button class="work-button" type="submit">检索资料</button></form></aside><main class="workspace-main" id="source-results"><h2>${query ? `“${escapeHtml(query)}”的结果` : '已编目资料'}</h2>${documentRows(docs.slice(0, 80))}</main></div>`;
  document.querySelector('#source-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const values = new URLSearchParams(new FormData(event.currentTarget));
    navigate(`/sources?${values.toString()}`);
  });
  if (query.length >= 2) {
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(query)}&subject=${encodeURIComponent(subject)}`);
      if (data.passages.length) {
        document.querySelector('#source-results').innerHTML = `<h2>可引文正文</h2><div class="result-list">${data.passages.map((passage) => `<article class="result-row"><a href="/document/${encodeURIComponent(passage.document_id)}#p-${passage.id}" data-link>${escapeHtml(passage.title)}</a><small>${escapeHtml(passage.subject)} · ${escapeHtml(passage.version_label)} · ${escapeHtml(passage.source_locator)}</small><p>${escapeHtml(passage.body)}</p></article>`).join('')}</div><h2>元数据匹配</h2>${documentRows(docs.slice(0, 40))}`;
      }
    } catch (error) {
      toast(error.message);
    }
  }
}

async function renderDocument(id) {
  try {
    const data = await api(`/api/documents/${encodeURIComponent(id)}?limit=200`);
    const doc = data.document;
    showDocumentInspector(doc);
    const source = doc.source_url ? `<a href="${escapeHtml(doc.source_url)}" target="_blank" rel="noopener">发布页 / 原件 ↗</a>` : '原件链接待补';
    const paragraphs = data.paragraphs.length ? data.paragraphs.map((paragraph) => `<section class="paragraph ${paragraph.uncertainty_note ? 'uncertain' : ''}" id="p-${paragraph.id}"><span class="paragraph-number">P:${paragraph.id}<br>${escapeHtml(paragraph.source_locator)}</span>${escapeHtml(paragraph.body)}${paragraph.uncertainty_note ? `<small class="uncertainty-note">可能有问题：${escapeHtml(paragraph.uncertainty_note)}</small>` : ''}</section>`).join('') : '<div class="empty-state">该记录目前只有已核元数据，正文尚未达到上线门槛。</div>';
    const verification = data.verifications.length ? data.verifications.map((item) => `<article class="verification-row"><b>${escapeHtml(item.entity_label)} · ${escapeHtml(verificationLabel(item.verification_status))}</b><p>${escapeHtml(item.resolution)}</p>${item.uncertainty_note ? `<small class="uncertainty-note">可能有问题：${escapeHtml(item.uncertainty_note)}</small>` : ''}${(item.evidence || []).map((evidence) => `<p><a href="${escapeHtml(evidence.sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(evidence.publisher)}</a> · ${escapeHtml(verificationLabel(evidence.versionMatch))} · ${escapeHtml(evidence.factSummary)}</p>`).join('')}</article>`).join('') : '<div class="empty-state">尚无在线同版核查记录。</div>';
    workbenchBody.innerHTML = `<div class="reader-grid"><article class="reader-document"><h2>${escapeHtml(doc.title)}</h2><p>${escapeHtml(doc.issued_by)}${doc.issued_date ? ` · ${escapeHtml(doc.issued_date)}` : ''} · ${escapeHtml(qualityLabel(doc))}</p>${paragraphs}<h2>在线三证核查</h2><p>只有同文同版来源可校正文句；同篇异版仅旁证稳定事实。</p>${verification}</article><aside class="reader-facts"><h3>资料身份</h3><p>编号：${escapeHtml(doc.id)}<br>学科：${escapeHtml(doc.subject)}<br>学段：${escapeHtml(doc.stage)}<br>版本：${escapeHtml(doc.version_label)}<br>状态：${escapeHtml(statusLabel(doc.current_status))}<br>文本质量：${escapeHtml(doc.text_quality_status || '待评估')}<br>页数：${doc.page_count || '待核'}</p><p>${source}</p><div class="inspector-actions"><a class="action-button" href="/compare?subject=${encodeURIComponent(doc.subject)}" data-link>版本比较</a><a class="action-button" href="/discussions?documentId=${encodeURIComponent(doc.id)}" data-link>教师讨论</a></div></aside></div>`;
    if (location.hash) requestAnimationFrame(() => document.querySelector(location.hash)?.scrollIntoView({ block: 'center' }));
  } catch (error) {
    workbenchBody.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

async function renderAi() {
  const me = await loadMe();
  const subjects = [...new Set(state.documents.map((doc) => doc.subject))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  if (!me.authenticated) {
    workbenchBody.innerHTML = `<div class="login-note"><h2>登录后建立可追踪的证据研究会话</h2><p>AI 只能引用本站本轮检索返回且已通过核查门槛的段落；检索失败时不会用模型常识补齐。</p><a class="work-button" href="https://my.bdfz.net/?returnTo=${encodeURIComponent(location.href)}">前往统一用户中心登录</a></div>`;
    return;
  }
  workbenchBody.innerHTML = `<div class="ai-grid"><form class="work-form" id="ai-form"><h2>证据限定研究</h2><label for="ai-query">教师研究问题</label><textarea id="ai-query" name="query" rows="7" minlength="8" required placeholder="例如：义务教育语文从2011版到2022版，课程内容组织方式发生了哪些可核验变化？"></textarea><label for="ai-subject">学科边界</label><select id="ai-subject" name="subject"><option value="">跨学科</option>${subjects.map((name) => `<option>${escapeHtml(name)}</option>`).join('')}</select><button class="work-button" type="submit">检索并回答</button></form><div><h2>回答与引文</h2><div class="ai-answer" id="ai-answer">尚未提问。每个事实必须回到 [P:编号]。</div><div class="citation-list" id="ai-citations"></div></div></div>`;
  document.querySelector('#ai-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    const answer = document.querySelector('#ai-answer');
    button.disabled = true;
    answer.textContent = '正在检索已核正文并校验引文编号…';
    try {
      const payload = Object.fromEntries(new FormData(form));
      const data = await api('/api/ai/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      answer.textContent = data.answer;
      document.querySelector('#ai-citations').innerHTML = data.citations.map((citation) => `<article class="citation-row"><a href="/document/${encodeURIComponent(citation.documentId)}#p-${citation.paragraphId}" data-link>[P:${citation.paragraphId}] ${escapeHtml(citation.title)}</a><small>${escapeHtml(citation.subject)} · ${escapeHtml(citation.locator)}</small><p>${escapeHtml(citation.excerpt)}</p></article>`).join('');
      window.BdfzIdentity?.recordEvent?.({ siteKey: 'curriculum', recordKey: `ai-research:${Date.now()}`, title: '课程标准证据研究', summary: '完成一次带引文的课程标准研究', itemGroup: 'teacher-research', itemType: 'rag-query', contentFormat: 'curriculum-atlas-rag-v1', sourceUrl: location.href, payload: { eventName: 'ai_evidence_research', subject: payload.subject || 'cross-subject', retrievalCount: data.retrievalCount } }).catch(() => {});
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
      const term = state.terms.find((item) => String(item.id) === url.searchParams.get('term'));
      if (term) showTermInspector(term);
      return;
    }
    if (path === '/subjects') {
      closeWorkbench(false);
      const subject = url.searchParams.get('subject');
      if (subject) {
        new Set(state.documents.map((doc) => doc.subject)).forEach((name) => { if (name !== subject) state.hiddenSubjects.add(name); });
        state.hiddenSubjects.delete(subject);
        renderSubjectControls();
        updateMapStatus();
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
      openWorkbench({ kicker: '资料原文', title: '证据明细', tabs: [{ id: 'reader', label: '正文与核查', href: `${path}${url.hash}` }, { id: 'compare', label: '同学科版本', href: `/compare?subject=${encodeURIComponent(state.documents.find((doc) => doc.id === id)?.subject || '')}` }], active: 'reader' });
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
  const stable = localStorage.getItem('curriculum:stable') === '1' || matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.body.classList.toggle('stable', stable);
  motionToggle.setAttribute('aria-pressed', String(stable));
  state.cosmos = new CurriculumCosmos(mount, {
    onSelect: (doc) => showDocumentInspector(doc),
    onTerm: (term) => {
      showTermInspector(term);
      history.replaceState({}, '', `/terms?term=${encodeURIComponent(term.id)}`);
    },
    onHover: showTooltip,
  });
  state.cosmos.setStable(stable);
  state.cosmos.setData(state.documents, state.terms, state.termRelations);
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
motionToggle.addEventListener('click', () => {
  const stable = !document.body.classList.contains('stable');
  document.body.classList.toggle('stable', stable);
  motionToggle.setAttribute('aria-pressed', String(stable));
  localStorage.setItem('curriculum:stable', stable ? '1' : '0');
  state.cosmos?.setStable(stable);
});
resetView.addEventListener('click', () => state.cosmos?.reset());
document.querySelector('#workbench-close').addEventListener('click', () => closeWorkbench());
scrim.addEventListener('click', () => closeWorkbench());
window.addEventListener('popstate', route);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!subjectPanel.hidden) subjectPanel.hidden = true;
    else if (!workbench.hidden) closeWorkbench();
    else if (!inspector.hidden) { inspector.hidden = true; state.cosmos?.setSelected(null); }
  }
});

route();
